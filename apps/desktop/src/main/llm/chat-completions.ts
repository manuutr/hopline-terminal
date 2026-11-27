import { z } from 'zod'
import { CLOUD } from '@shared/providers'
import type { AiTestCode, AiTestResult } from '@shared/types'
import type { ChatMessage, LlmProvider, OnCheckSend, Part, TurnRequest, TurnResult } from './types'
import { fitContext } from './context'
import { parseArgs } from './ollama'

type Vendor = 'openai' | 'gemini'
const paths = { openai: '/v1', gemini: '/v1beta/openai' }
const callSchema = z.object({
  type: z.literal('function'),
  id: z.string().min(1).max(256 * 1024),
  function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), arguments: z.string().max(256 * 1024) }),
  extra_content: z.object({ google: z.object({ thought_signature: z.string().optional() }).optional() }).optional()
})
const replySchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({
      content: z.string().nullish(),
      refusal: z.string().nullish(),
      tool_calls: z.array(callSchema).max(32).nullish()
    })
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional()
})

function history(messages: ChatMessage[], vendor: Vendor) {
  const result: Record<string, unknown>[] = []
  for (const { role, parts } of messages) {
    const content = parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
    if (role === 'assistant') {
      const calls = parts.filter(p => p.type === 'tool_call').map(p => ({
        id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) },
        ...(vendor === 'gemini' && p.geminiThoughtSignature ? { extra_content: { google: { thought_signature: p.geminiThoughtSignature } } } : {})
      }))
      result.push({ role, content: content || null, ...(calls.length ? { tool_calls: calls } : {}) })
    } else {
      for (const p of parts) if (p.type === 'tool_result') result.push({ role: 'tool', tool_call_id: p.id, content: p.isError ? `ERROR: ${p.content}` : p.content })
      if (content) result.push({ role, content })
    }
  }
  return result
}

class CloudError extends Error {
  constructor(readonly code: AiTestCode, message: string) { super(message) }
}

function failure(error: unknown): AiTestResult {
  if (error instanceof CloudError) return { ok: false, code: error.code, message: error.message }
  return { ok: false, code: 'network', message: 'Could not reach the model API. Check the connection and try again.' }
}

// Bound the decoded body even when the server omits Content-Length or uses compression.
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) {
        await reader.cancel()
        throw new CloudError('other', 'The model response exceeded 2 MiB.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  // A JSON parser error can quote the input. Never forward it to the UI or diagnostics.
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { return null }
}

export class ChatCompletionsProvider implements LlmProvider {
  readonly logsWire = true
  readonly capabilities = { tools: true, maxContext: 64_000 }
  constructor(readonly id: Vendor, private readonly key: string, private readonly model: string, private readonly send: typeof fetch = fetch) {}

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const host = CLOUD[this.id].host
    const r = await this.send(`https://${host}${paths[this.id]}${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      redirect: 'error', signal, ...(body ? { body: JSON.stringify(body) } : {})
    })
    const data = await readJson(r)
    if (r.ok) return data
    // Error messages can echo credentials, request bodies or device output. Only expose fixed messages.
    const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(data).data?.error.code
    if (r.status === 401) throw new CloudError('invalid_key', 'The provider rejected this API key.')
    if (r.status === 403) throw new CloudError('no_access', 'This key does not have permission to use the model.')
    if (r.status === 404) throw new CloudError('model_not_found', 'The provider could not find this model for your account.')
    if (r.status === 402 || code === 'insufficient_quota' || code === 'credit_balance_exhausted') throw new CloudError('no_credits', 'Check your API project’s quota and billing.')
    if (r.status === 429) throw new CloudError('rate_limit', 'The provider rate-limited this request. Check your quota and try again.')
    throw new CloudError(r.status >= 500 ? 'overloaded' : 'other', `${host} returned HTTP ${r.status}. Check that the model supports chat and function calling.`)
  }

  async health(): Promise<AiTestResult> {
    try {
      // The model occupies exactly one path segment.
      if (!this.model || this.model === '.' || this.model === '..') throw new CloudError('model_not_found', 'Enter a model ID.')
      const info = await this.request('/models/' + encodeURIComponent(this.model), AbortSignal.timeout(15_000))
      if (!z.object({ id: z.string().min(1) }).safeParse(info).success) throw new CloudError('other', 'The provider returned invalid model metadata.')
      return { ok: true, code: 'ok', message: `${this.model} is reachable` }
    } catch (e) { return failure(e) }
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    return this.complete(req, 8192)
  }

  private async complete(req: TurnRequest, outputLimit: number): Promise<TurnResult> {
    const fitted = fitContext(req.system, req.messages, req.tools, this.capabilities.maxContext)
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: req.system }, ...history(fitted.messages, this.id)],
      ...(this.id === 'openai' ? { store: false, max_completion_tokens: outputLimit } : { max_tokens: outputLimit }),
      ...(req.tools.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {})
    }
    await req.beforeSend?.(body)
    req.signal.throwIfAborted()
    req.onAttempt?.()
    const parsed = replySchema.safeParse(await this.request('/chat/completions', req.signal, body))
    if (!parsed.success) throw new CloudError('other', 'The provider returned an unreadable response.')
    const { choices, usage } = parsed.data
    const { message, finish_reason: finish } = choices[0]!
    const parts: Part[] = []
    if (message.content) {
      parts.push({ type: 'text', text: message.content })
      req.onText(message.content)
    }
    const refused = !!message.refusal || finish === 'content_filter'
    if (!refused && finish === 'tool_calls') {
      const ids = new Set<string>()
      for (const call of message.tool_calls ?? []) {
        if (ids.has(call.id)) throw new CloudError('other', 'The provider repeated a tool call ID.')
        ids.add(call.id)
        parts.push({
          type: 'tool_call', id: call.id, name: call.function.name, ...parseArgs(call.function.arguments),
          ...(this.id === 'gemini' ? { geminiThoughtSignature: call.extra_content?.google?.thought_signature } : {})
        })
      }
      if (!ids.size) throw new CloudError('other', 'The model finished a tool turn without a tool call.')
    }
    return {
      message: { role: 'assistant', parts },
      stop: refused ? 'refusal' : finish === 'length' ? 'max_tokens' : finish === 'tool_calls' ? 'tool_use' : finish === 'stop' ? 'end' : 'other',
      ...(refused ? { detail: 'The provider declined this request.' } : {}),
      ...(usage ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } } : {})
    }
  }

  async check(onSend: OnCheckSend): Promise<AiTestResult> {
    try {
      const result = await this.complete({
        system: 'Call connection_check once with an empty object.',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Test the connection.' }] }],
        tools: [{ name: 'connection_check', description: 'Acknowledge the connection test.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
        signal: AbortSignal.timeout(30_000), onText: () => {}, onThinking: () => {},
        beforeSend: body => onSend({ method: 'POST', path: paths[this.id] + '/chat/completions', body })
      }, 512)
      if (!result.message.parts.some(p => p.type === 'tool_call' && !p.invalid && p.name === 'connection_check')) {
        return { ok: false, code: 'no_tools', message: 'This model did not complete the function-calling check. Choose a model that supports tools.' }
      }
      return { ok: true, code: 'ok', modelLabel: this.model, message: `Connected to ${this.model}` }
    } catch (e) { return failure(e) }
  }
}
