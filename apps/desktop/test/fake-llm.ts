import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-ins for the Anthropic API and an Ollama server. Tests (unit and e2e) point the app
 * at these; no test ever talks to api.anthropic.com or a real model.
 */

export interface FakeServer {
  url: string
  /** Every request body received, parsed (null for GET). */
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: unknown }[]
  close: () => Promise<void>
}

async function listen(handler: (req: IncomingMessage, body: unknown, res: ServerResponse) => void, requests: FakeServer['requests']): Promise<FakeServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      handler(req, body, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake' })
  res.end(JSON.stringify(body))
}

const LABELS: Record<string, string> = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5' }

/**
 * Fake Anthropic API. The API key picks the scenario:
 * contains "bad" → 401, "nocredit" → billing_error on messages, "ratelimit" → 429, else OK.
 * Streaming messages answer with `answer` as one text block.
 */
export async function fakeAnthropic(opts: { answer?: string; /** The first n message requests answer 529 overloaded (the SDK retries them). */ failFirst?: number } = {}): Promise<FakeServer> {
  const requests: FakeServer['requests'] = []
  let failures = opts.failFirst ?? 0
  return listen((req, body, res) => {
    // SDK 1.13 sends the key as a bearer token; older ones as x-api-key.
    const key = String(req.headers['x-api-key'] ?? req.headers['authorization'] ?? '')
    const err = (status: number, type: string, message: string) => json(res, status, { type: 'error', error: { type, message } })
    if (key.includes('bad')) return err(401, 'authentication_error', 'invalid x-api-key')
    if (key.includes('ratelimit')) return err(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit')
    const models = /^\/v1\/models\/([^/?]+)/.exec(req.url ?? '')
    if (req.method === 'GET' && models) {
      const id = decodeURIComponent(models[1]!)
      if (!LABELS[id]) return err(404, 'not_found_error', `model: ${id}`)
      return json(res, 200, { type: 'model', id, display_name: LABELS[id], created_at: '2026-10-01T00:00:00Z', deprecated_at: null, capabilities: null })
    }
    if (req.method === 'POST' && (req.url ?? '').startsWith('/v1/messages')) {
      if (key.includes('nocredit')) return err(400, 'billing_error', 'Your credit balance is too low to access the Anthropic API.')
      if (failures > 0) {
        failures--
        res.writeHead(529, { 'content-type': 'application/json', 'retry-after-ms': '1', 'x-should-retry': 'true' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
      }
      const b = body as { model: string; stream?: boolean }
      const usage = { input_tokens: 5, output_tokens: 2 }
      if (!b.stream)
        return json(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fake' })
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage } })
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: opts.answer ?? 'Done.' } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
      ev('message_stop', {})
      return res.end()
    }
    err(404, 'not_found_error', 'no route')
  }, requests)
}

/** `delayMs`: answer that much later (a slow model; a lane that stays busy until it is stopped). */
export type OllamaTurn = ({ text: string } | { tools: { name: string; arguments: unknown }[] }) & { delayMs?: number }

/** An /api/chat request body as the Ollama adapter sends it. */
export interface OllamaChatBody {
  model?: string
  messages?: { role: string; content: string; tool_calls?: unknown[] }[]
  tools?: unknown[]
}

/**
 * Fake Ollama. `models` are listed by /api/tags; those in `noTools` lack the "tools" capability
 * and reject requests with tools (as Ollama does). /api/chat streams `script` turns in order,
 * splitting each NDJSON line across two writes to exercise chunk reassembly. With `route`, a turn
 * is chosen from the request instead (concurrent fleet lanes: by the system prompt); a route that
 * returns undefined falls back to the script.
 */
export async function fakeOllama(opts: { models?: string[]; noTools?: string[]; script?: OllamaTurn[]; route?: (body: OllamaChatBody) => OllamaTurn | undefined; contextLength?: Record<string, number | null>; version?: string } = {}): Promise<FakeServer & { script: OllamaTurn[]; route: { fn?: (body: OllamaChatBody) => OllamaTurn | undefined } }> {
  const requests: FakeServer['requests'] = []
  const models = opts.models ?? ['qwen3:8b', 'llama2:7b']
  const noTools = new Set(opts.noTools ?? ['llama2:7b'])
  const script = [...(opts.script ?? [])]
  const route: { fn?: (body: OllamaChatBody) => OllamaTurn | undefined } = { fn: opts.route }
  const srv = await listen((req, body, res) => {
    const b = (body ?? {}) as { model?: string; tools?: unknown[]; stream?: boolean }
    if (req.url === '/api/tags')
      return json(res, 200, { models: models.map((name, i) => ({ name, model: name, size: 4_000_000_000 + i, details: { family: name.split(':')[0], parameter_size: '8B' } })) })
    if (req.url === '/api/version') return json(res, 200, { version: opts.version ?? '0.12.3' })
    if (req.url === '/api/show') {
      if (!models.includes(b.model ?? '')) return json(res, 404, { error: `model '${b.model}' not found` })
      // As Ollama answers: model_info keyed by the architecture ("qwen3.context_length").
      const arch = (b.model ?? '').split(':')[0]!.replace(/[^a-z0-9]/gi, '') || 'llama'
      const ctx = opts.contextLength && b.model! in opts.contextLength ? opts.contextLength[b.model!] : b.model!.startsWith('qwen3') ? 40_960 : 4_096
      return json(res, 200, {
        capabilities: noTools.has(b.model!) ? ['completion'] : ['completion', 'tools'],
        model_info: { 'general.architecture': arch, ...(ctx === null ? {} : { [`${arch}.context_length`]: ctx }) }
      })
    }
    if (req.url === '/api/chat') {
      if (!models.includes(b.model ?? '')) return json(res, 404, { error: `model "${b.model}" not found, try pulling it first` })
      if (noTools.has(b.model!) && b.tools?.length) return json(res, 400, { error: `registry.ollama.ai/library/${b.model} does not support tools` })
      if (b.stream === false) return json(res, 200, { model: b.model, message: { role: 'assistant', content: 'OK' }, done: true, done_reason: 'stop' })
      const turn: OllamaTurn = route.fn?.(b as OllamaChatBody) ?? script.shift() ?? { text: 'Done.' }
      if (turn.delayMs) {
        const t = setTimeout(() => !res.destroyed && stream(res, b.model, turn, Math.ceil(JSON.stringify(b).length / 4)), turn.delayMs)
        res.on('close', () => clearTimeout(t))
        return
      }
      return stream(res, b.model, turn, Math.ceil(JSON.stringify(b).length / 4))
    }
    json(res, 404, { error: 'not found' })
  }, requests)
  return { ...srv, script, route }
}

/** One NDJSON chat answer, each line split across two writes (chunk reassembly). */
function stream(res: import('node:http').ServerResponse, model: string | undefined, turn: OllamaTurn, promptTokens = 0): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  const lines: object[] =
    'text' in turn
      ? [...turn.text.split(/(?<= )/).map((t) => ({ model, message: { role: 'assistant', content: t }, done: false }))]
      : [{ model, message: { role: 'assistant', content: '', tool_calls: turn.tools.map((t) => ({ function: { name: t.name, arguments: t.arguments } })) }, done: false }]
  // Like Ollama: the final line carries the token counts (the run budget and the egress log read them).
  const evalCount = Math.ceil(JSON.stringify(lines).length / 8)
  lines.push({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: promptTokens, eval_count: evalCount })
  for (const l of lines) {
    const s = JSON.stringify(l) + '\n'
    res.write(s.slice(0, 7))
    res.write(s.slice(7))
  }
  res.end()
}
