import { randomUUID } from 'node:crypto'
import { endpointUrl, isInsecureEndpoint, isLoopbackEndpoint, parseOrigin } from '@shared/ollama'
import type { AiHealth, AiTestCode, AiTestResult, OllamaModel, OllamaModelsError, OllamaModelsResult } from '@shared/types'
import { ContextTooSmallError, fitContext } from './context'
import type { ChatMessage, LlmProvider, OnCheckSend, Part, ProviderCapabilities, StopReason, ToolSpec, TurnRequest, TurnResult } from './types'

/**
 * Local models through Ollama's native API (`/api/chat` with `tools`, NDJSON streaming), for
 * air-gapped networks. Same provider interface as Anthropic: the agent's guard, audit, timeouts,
 * caps and redaction are identical (they live in the agent and in llm/safe.ts, not here).
 */

const PROVIDER = 'ollama'
/**
 * Ollama's default context (2–4k) is too small for device output, so `num_ctx` is always set:
 * the model's own context length (from /api/show) capped at OLLAMA_MAX_NUM_CTX (the KV cache of a
 * 128k window does not fit a laptop's memory), or OLLAMA_NUM_CTX when the server does not say.
 */
export const OLLAMA_NUM_CTX = 16_384
export const OLLAMA_MAX_NUM_CTX = 32_768
/**
 * The floor (review M2): the system prompt and the tool definitions alone are about 2.3k tokens,
 * so a 2k window lost the safety rules before any device output was added.
 */
export const OLLAMA_MIN_NUM_CTX = 8_192

/** The window a request is fitted to: num_ctx, or the model's own context length when smaller. */
export const fitWindow = (numCtx: number, contextLength: number | null | undefined): number =>
  contextLength && Number.isFinite(contextLength) && contextLength > 0 ? Math.min(numCtx, Math.floor(contextLength)) : numCtx

export const numCtxFor = (contextLength: number | null | undefined): number =>
  contextLength && Number.isFinite(contextLength) && contextLength > 0 ? Math.max(OLLAMA_MIN_NUM_CTX, Math.min(Math.floor(contextLength), OLLAMA_MAX_NUM_CTX)) : OLLAMA_NUM_CTX
const DISCOVERY_TIMEOUT_MS = 8_000
/** The first request loads the model into memory, which can take a while on a laptop. */
const TEST_TIMEOUT_MS = 120_000
const MAX_MODELS = 100

export class OllamaError extends Error {
  constructor(
    readonly code: AiTestCode,
    message: string,
    /** Discovery category (L4): what the renderer learns, with a fixed message. */
    readonly category: OllamaModelsError = 'http_error'
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

/** http(s) without credentials, or an OllamaError (main enforces this, not only the IPC schema). */
export function checkEndpoint(endpoint: string): void {
  if (!parseOrigin(endpoint)) throw new OllamaError('bad_endpoint', 'The Ollama server must be an http:// or https:// address (scheme, host and port only) without credentials.', 'invalid_url')
}

/** Loopback only: device output stays on this machine. */
export const isLocalEndpoint = isLoopbackEndpoint

async function request(endpoint: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  checkEndpoint(endpoint)
  let res: Response
  try {
    res = await fetch(endpointUrl(endpoint, path)!, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // Never followed (a redirect could point anywhere), but reported as one, not as "Cannot reach".
      redirect: 'manual'
    })
  } catch (e) {
    if (signal.aborted) {
      const r = signal.reason as { name?: string } | undefined
      if (r?.name === 'TimeoutError') throw new OllamaError('network', 'The Ollama server did not answer in time.', 'timeout')
      throw new OllamaError('other', 'Cancelled.', 'unreachable')
    }
    throw new OllamaError('network', 'Cannot reach the Ollama server. Is it running ("ollama serve") and is the address right?', 'unreachable')
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    void res.body?.cancel().catch(() => {})
    throw new OllamaError('other', `The Ollama server answered with a redirect (${res.status ? `HTTP ${res.status}` : 'HTTP 3xx'}), which Hopline does not follow. Enter the server's own address.`, 'http_error')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      /* not JSON */
    }
    // Ollama has no structured error codes: these two are its documented behaviours. The server's
    // text is only matched here, never passed on (L4): every message is fixed.
    if (res.status === 404) throw new OllamaError('model_not_found', 'Model not found on the Ollama server. Pull it first ("ollama pull …").', 'not_ollama')
    if (res.status === 400 && /does not support tools/i.test(msg)) throw new OllamaError('no_tools', 'This model does not support tool calling, which the assistant needs to run commands. Pick one marked "tools".')
    throw new OllamaError('other', `The Ollama server answered with an error (HTTP ${res.status}).`, 'http_error')
  }
  return res
}

interface WireToolCall {
  function?: { name?: string; arguments?: unknown }
}
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: WireToolCall[]
  tool_name?: string
  thinking?: string
}

function toWire(system: string, messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }]
  const names = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
      const calls = m.parts.flatMap((p) => (p.type === 'tool_call' ? [p] : []))
      for (const c of calls) names.set(c.id, c.name)
      // A malformed call is replayed with `{}`: its oversized or invalid arguments are not sent again.
      out.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.invalid ? {} : c.input } })) } : {}) })
      continue
    }
    for (const p of m.parts) {
      if (p.type === 'text') out.push({ role: 'user', content: p.text })
      else if (p.type === 'tool_result') out.push({ role: 'tool', content: p.isError ? `ERROR: ${p.content}` : p.content, tool_name: names.get(p.id) ?? '' })
    }
  }
  return out
}

const toWireTools = (tools: ToolSpec[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/**
 * Arguments are an object per the docs; some models send a JSON string. Anything else (an array,
 * null, a number, a string that is not an object) is a malformed call: `{}` is kept as its input
 * (so the history replays as an object) and `invalid` says what was wrong; the loop answers it
 * with an error and runs nothing. The fields themselves are validated with zod by the tool set.
 */
export function parseArgs(a: unknown): { input: Record<string, unknown>; invalid?: string } {
  if (isPlainObject(a)) return { input: a }
  if (a === undefined || a === null) return { input: {} }
  if (typeof a === 'string') {
    try {
      const v = JSON.parse(a) as unknown
      return isPlainObject(v) ? { input: v } : { input: {}, invalid: 'the arguments are not a JSON object' }
    } catch {
      return { input: {}, invalid: 'the arguments are not valid JSON' }
    }
  }
  return { input: {}, invalid: 'the arguments are not a JSON object' }
}

const MALFORMED = 'Ollama sent a malformed response.'

/** The name a malformed call is replayed under (the real one is not a usable tool name). */
export const INVALID_TOOL_NAME = 'invalid_tool_call'

/**
 * One streamed chunk, type-checked: the fields Hopline reads, or an OllamaError with fixed text.
 * A tool call that is not usable (no name, a name that is not a tool name, arguments that are not
 * an object) is kept as an `invalid` call: the model gets an error back for it and nothing runs.
 */
export function readChunk(chunk: unknown): { thinking: string; content: string; calls: { name: string; input: Record<string, unknown>; invalid?: string }[]; done: boolean; doneReason: string; promptTokens: number; evalTokens: number } {
  if (!isPlainObject(chunk)) throw new OllamaError('other', MALFORMED)
  if (chunk['error'] !== undefined) throw new OllamaError('other', 'The Ollama server reported an error while answering.')
  const msg = chunk['message']
  if (msg !== undefined && !isPlainObject(msg)) throw new OllamaError('other', MALFORMED)
  const thinking = msg?.['thinking']
  const content = msg?.['content']
  const toolCalls = msg?.['tool_calls']
  if ((thinking !== undefined && thinking !== null && typeof thinking !== 'string') || (content !== undefined && content !== null && typeof content !== 'string')) throw new OllamaError('other', MALFORMED)
  if (toolCalls !== undefined && toolCalls !== null && !Array.isArray(toolCalls)) throw new OllamaError('other', MALFORMED)
  const calls: { name: string; input: Record<string, unknown>; invalid?: string }[] = []
  for (const c of ((toolCalls as unknown[] | null | undefined) ?? []).slice(0, 32)) {
    const fn = isPlainObject(c) ? c['function'] : undefined
    const name = isPlainObject(fn) ? fn['name'] : undefined
    if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) {
      calls.push({ name: INVALID_TOOL_NAME, input: {}, invalid: typeof name === 'string' ? 'the tool name is not one of your tools' : 'the call has no tool name' })
      continue
    }
    const raw = (fn as Record<string, unknown>)['arguments']
    if ((typeof raw === 'string' ? raw.length : (JSON.stringify(raw ?? null) ?? '').length) > OLLAMA_MAX_ARGS) {
      calls.push({ name, input: {}, invalid: `the arguments are larger than ${OLLAMA_MAX_ARGS / 1024} KB` })
      continue
    }
    const a = parseArgs(raw)
    calls.push({ name, input: a.input, ...(a.invalid ? { invalid: a.invalid } : {}) })
  }
  const done = chunk['done'] === true
  const reason = chunk['done_reason']
  const count = (k: string) => (done && typeof chunk[k] === 'number' && Number.isFinite(chunk[k]) ? Math.max(0, Math.floor(chunk[k] as number)) : 0)
  return { thinking: (thinking as string | undefined) ?? '', content: (content as string | undefined) ?? '', calls, done, doneReason: done && typeof reason === 'string' ? reason : '', promptTokens: count('prompt_eval_count'), evalTokens: count('eval_count') }
}

/**
 * Stream limits (review L3): a server that never sends a newline, or answers without end, cannot
 * grow memory or the conversation without bound.
 */
export const OLLAMA_MAX_LINE = 1024 * 1024
export const OLLAMA_MAX_TEXT = 200_000
export const OLLAMA_MAX_THINKING = 200_000
export const OLLAMA_MAX_CALLS = 32
/** A tool call's arguments larger than this (as JSON) are not kept: the call is invalid, replayed as `{}`. Well above the largest valid input (a fleet report or a long proposal with its rollback and verify plans). */
export const OLLAMA_MAX_ARGS = 256 * 1024

const LINE_TOO_LONG = 'Ollama sent a response line over 1 MB; it was not read.'

/** Split an NDJSON body into objects, across chunk boundaries. A line over OLLAMA_MAX_LINE is refused. */
async function* ndjson(res: Response): AsyncGenerator<unknown> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buf += dec.decode(value, { stream: !done })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        if (nl > OLLAMA_MAX_LINE) throw new OllamaError('other', LINE_TOO_LONG)
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) yield JSON.parse(line) as unknown
      }
      if (buf.length > OLLAMA_MAX_LINE) throw new OllamaError('other', LINE_TOO_LONG)
      if (done) break
    }
    if (buf.trim()) yield JSON.parse(buf) as unknown
  } finally {
    // Stopped early (a limit, an error, a cancelled run): release the connection.
    void reader.cancel().catch(() => {})
  }
}

export class OllamaProvider implements LlmProvider {
  readonly id = PROVIDER
  readonly logsWire = true
  readonly capabilities: ProviderCapabilities
  /** `num_ctx` as sent (at least OLLAMA_MIN_NUM_CTX). */
  private readonly numCtx: number

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    /** From /api/show (`modelInfo`); without it: tools on, the fallback context. */
    info: { tools?: boolean | null; numCtx?: number; contextLength?: number | null } = {}
  ) {
    checkEndpoint(endpoint)
    this.numCtx = info.numCtx ?? OLLAMA_NUM_CTX
    // The request is fitted to the model's own window when that is smaller than num_ctx (a 4k
    // model still gets num_ctx 8k, but a server that clamps to 4k must not cut the system prompt).
    this.capabilities = { tools: info.tools !== false, maxContext: fitWindow(this.numCtx, info.contextLength) }
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const numCtx = this.numCtx
    // A model without tool calling gets no tool definitions (suggest mode, agent/suggest.ts).
    const tools = this.capabilities.tools ? req.tools : []
    let fitted: ReturnType<typeof fitContext>
    try {
      fitted = fitContext(req.system, req.messages, tools, this.capabilities.maxContext)
    } catch (e) {
      // Refused before anything is sent (and before the egress log records anything).
      if (e instanceof ContextTooSmallError) throw new OllamaError('other', e.message)
      throw e
    }
    const body = {
      model: this.model,
      messages: toWire(req.system, fitted.messages),
      ...(tools.length ? { tools: toWireTools(tools) } : {}),
      stream: true,
      options: { num_ctx: numCtx }
    }
    // The egress log records exactly this body; if it can't (and must), nothing is sent.
    await req.beforeSend?.(body)
    req.onAttempt?.()
    const res = await request(this.endpoint, '/api/chat', body, req.signal)
    let text = ''
    let thinking = 0
    let doneReason = ''
    const usage = { inputTokens: 0, outputTokens: 0 }
    const calls: Extract<Part, { type: 'tool_call' }>[] = []
    try {
      for await (const chunk of ndjson(res)) {
        const c = readChunk(chunk)
        if (c.thinking && thinking < OLLAMA_MAX_THINKING) {
          const t = c.thinking.slice(0, OLLAMA_MAX_THINKING - thinking)
          thinking += t.length
          req.onThinking(t)
        }
        if (c.content) {
          const t = c.content.slice(0, OLLAMA_MAX_TEXT - text.length)
          text += t
          if (t) req.onText(t)
          // The answer is cut here, like a model that reached its output limit.
          if (text.length >= OLLAMA_MAX_TEXT) {
            doneReason = 'length'
            break
          }
        }
        for (const call of c.calls.slice(0, Math.max(0, OLLAMA_MAX_CALLS - calls.length))) calls.push({ type: 'tool_call', id: `ollama_${randomUUID()}`, name: call.name, input: call.input, ...(call.invalid ? { invalid: call.invalid } : {}) })
        if (c.done) {
          doneReason = c.doneReason
          usage.inputTokens += c.promptTokens
          usage.outputTokens += c.evalTokens
        }
      }
    } catch (e) {
      if (req.signal.aborted) throw new OllamaError('other', 'Cancelled.')
      if (e instanceof SyntaxError) throw new OllamaError('other', MALFORMED)
      throw e
    }
    const parts: Part[] = [...(text ? [{ type: 'text' as const, text }] : []), ...calls]
    const stop: StopReason = calls.length ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end'
    return { message: { role: 'assistant', parts }, stop, ...(usage.inputTokens || usage.outputTokens ? { usage } : {}) }
  }
}

/** What /api/show says about a model: tool calling, and its context length. */
export interface ModelInfo {
  tools: boolean | null
  contextLength: number | null
}

/** Read `capabilities` and `model_info["<general.architecture>.context_length"]` from an /api/show answer. */
export function readShow(show: unknown): ModelInfo {
  if (!isPlainObject(show)) return { tools: null, contextLength: null }
  const caps = show['capabilities']
  const tools = Array.isArray(caps) ? caps.includes('tools') : null
  let contextLength: number | null = null
  const mi = show['model_info']
  if (isPlainObject(mi)) {
    const arch = typeof mi['general.architecture'] === 'string' ? (mi['general.architecture'] as string) : ''
    const direct = arch ? mi[`${arch}.context_length`] : undefined
    const any = direct ?? Object.entries(mi).find(([k]) => k.endsWith('.context_length'))?.[1]
    if (typeof any === 'number' && Number.isFinite(any) && any > 0) contextLength = Math.floor(any)
  }
  return { tools, contextLength }
}

export async function modelInfo(endpoint: string, model: string, signal: AbortSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)): Promise<ModelInfo> {
  const res = await request(endpoint, '/api/show', { model }, signal)
  try {
    return readShow(await res.json())
  } catch {
    throw new OllamaError('other', MALFORMED, 'not_ollama')
  }
}

const DISCOVERY_MESSAGES: Readonly<Record<OllamaModelsError, string>> = {
  invalid_url: 'Enter a full http:// or https:// address, like http://127.0.0.1:11434.',
  unreachable: 'Cannot reach the Ollama server. Is it running ("ollama serve") and is the address right?',
  timeout: 'The Ollama server did not answer in time.',
  http_error: 'The server answered with an error. Check the address and that it is an Ollama server.',
  not_ollama: 'The server did not answer like an Ollama server.',
  policy: 'The team policy does not allow this Ollama server.'
}
const DISCOVERY_CODES: Readonly<Record<OllamaModelsError, AiTestCode>> = {
  invalid_url: 'bad_endpoint',
  unreachable: 'network',
  timeout: 'network',
  http_error: 'other',
  not_ollama: 'other',
  policy: 'policy'
}

/**
 * Models on the server, each with its tool-calling capability (from /api/show). A failure is one
 * fixed category with a fixed message: nothing from the response body reaches the renderer (L4).
 */
export async function listOllamaModels(endpoint: string): Promise<OllamaModelsResult> {
  try {
    checkEndpoint(endpoint)
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    let tags: { models?: { name?: unknown; size?: unknown; details?: { family?: unknown; parameter_size?: unknown } }[] }
    try {
      tags = (await (await request(endpoint, '/api/tags', undefined, signal)).json()) as typeof tags
    } catch (e) {
      if (e instanceof OllamaError) throw e
      throw new OllamaError('other', DISCOVERY_MESSAGES.not_ollama, 'not_ollama')
    }
    if (!tags || typeof tags !== 'object' || (tags.models !== undefined && !Array.isArray(tags.models))) throw new OllamaError('other', DISCOVERY_MESSAGES.not_ollama, 'not_ollama')
    const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined)
    const list = (tags.models ?? [])
      .filter((m) => m && typeof m.name === 'string' && /^[\w.:/@-]{1,200}$/.test(m.name))
      .map((m) => ({ name: m.name as string, size: typeof m.size === 'number' ? m.size : 0, details: { family: str(m.details?.family, 60), parameter_size: str(m.details?.parameter_size, 20) } }))
      .slice(0, MAX_MODELS)
    const models = await Promise.all(
      list.map(async (m): Promise<OllamaModel> => {
        let info: ModelInfo = { tools: null, contextLength: null }
        try {
          info = readShow(await (await request(endpoint, '/api/show', { model: m.name }, signal)).json())
        } catch {
          /* old server: capability unknown */
        }
        return { name: m.name, sizeBytes: m.size, parameterSize: m.details.parameter_size, family: m.details.family, tools: info.tools, contextLength: info.contextLength, numCtx: numCtxFor(info.contextLength) }
      })
    )
    // Tool-capable models first: they are the ones the assistant can use.
    models.sort((a, b) => Number(b.tools === true) - Number(a.tools === true) || a.name.localeCompare(b.name))
    return { ok: true, models, remote: !isLocalEndpoint(endpoint), insecure: isInsecureEndpoint(endpoint) }
  } catch (e) {
    const error: OllamaModelsError = e instanceof OllamaError ? e.category : 'not_ollama'
    return { ok: false, code: DISCOVERY_CODES[error], error, message: DISCOVERY_MESSAGES[error] }
  }
}

/**
 * Connect check: one tiny chat request with one tool. A model without tool calling is not refused
 * any more: it is checked again without the tool and connects in suggest mode (agent/suggest.ts).
 */
/** The connect check's /api/chat body (also what the egress log records for it, source `check`). */
export const ollamaTestBody = (model: string, withTool: boolean) => ({
  model,
  stream: false,
  messages: [{ role: 'user', content: 'Reply with the word OK.' }],
  ...(withTool ? { tools: toWireTools([{ name: 'noop', description: 'Does nothing. Do not call it.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]) } : {}),
  options: { num_ctx: 2048, num_predict: 8 }
})

export async function testOllama(endpoint: string, model: string, onSend?: OnCheckSend): Promise<AiTestResult> {
  const where = () => (isLocalEndpoint(endpoint) ? 'this machine' : new URL(endpoint).host)
  const chat = async (withTool: boolean) => {
    checkEndpoint(endpoint)
    const body = ollamaTestBody(model, withTool)
    // The plain request is only sent after the one with the tool was refused.
    await onSend?.({ method: 'POST', path: '/api/chat', body }, withTool)
    const res = await request(endpoint, '/api/chat', body, AbortSignal.timeout(TEST_TIMEOUT_MS))
    try {
      await res.json()
    } catch {
      throw new OllamaError('other', DISCOVERY_MESSAGES.not_ollama, 'not_ollama')
    }
  }
  try {
    try {
      await chat(true)
    } catch (e) {
      if (!(e instanceof OllamaError) || e.code !== 'no_tools') throw e
      await chat(false)
      return { ok: true, code: 'ok', suggestMode: true, message: `Connected to ${model} on ${where()} in suggest mode: this model has no tool calling, so it proposes commands and you run each one.`, modelLabel: model }
    }
    return { ok: true, code: 'ok', message: `Connected to ${model} on ${where()}`, modelLabel: model }
  } catch (e) {
    const err = e instanceof OllamaError ? e : new OllamaError('other', 'The Ollama check failed.')
    return { ok: false, code: err.code, message: err.message }
  }
}

/** Health check: the server answers (/api/version), the model is there, and how it will be run. */
export async function ollamaHealth(endpoint: string, model: string): Promise<AiHealth> {
  const destination = parseEndpointHost(endpoint)
  const base = { provider: 'ollama' as const, destination, local: isLocalEndpoint(endpoint), model }
  const t0 = Date.now()
  try {
    checkEndpoint(endpoint)
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    let version: string | undefined
    try {
      const v = (await (await request(endpoint, '/api/version', undefined, signal)).json()) as { version?: unknown }
      version = typeof v?.version === 'string' ? v.version.slice(0, 40) : undefined
    } catch (e) {
      if (e instanceof OllamaError && e.category !== 'not_ollama' && e.code !== 'model_not_found') throw e
    }
    if (!model) return { ...base, ok: false, version, latencyMs: Date.now() - t0, message: 'The server answers, but no model is picked.' }
    const info = await modelInfo(endpoint, model, signal)
    const numCtx = numCtxFor(info.contextLength)
    const window = fitWindow(numCtx, info.contextLength)
    const mode = info.tools === false ? 'suggest mode (no tool calling)' : 'tool calling'
    return { ...base, ok: true, version, tools: info.tools, contextLength: info.contextLength, numCtx, latencyMs: Date.now() - t0, message: `${model} is ready · ${mode} · context ${window.toLocaleString('en-US')} tokens` }
  } catch (e) {
    const err = e instanceof OllamaError ? e : new OllamaError('other', 'The Ollama check failed.')
    return { ...base, ok: false, latencyMs: Date.now() - t0, message: err.code === 'model_not_found' ? `Model ${model} is not on the server. Pull it first ("ollama pull ${model}").` : err.message }
  }
}

function parseEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint.slice(0, 100)
  }
}
