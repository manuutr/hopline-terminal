import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { endpointUrl, parseEndpoint, parseOrigin } from '@shared/ollama'
import type { Settings } from '@shared/types'
import { clampRunBudget, firstTurnTooLargeMessage, MIN_RUN_TOKEN_BUDGET } from '../src/main/agent/run-budget'
import { openDb } from '../src/main/db'
import { EgressLog } from '../src/main/egress/store'
import { meteredProvider, TokenMeter } from '../src/main/fleet/budget'
import { trustHandlers } from '../src/main/ipc/trust'
import { Endpoint } from '../src/main/ipc/schemas'
import { ContextTooSmallError, fitContext } from '../src/main/llm/context'
import { listOllamaModels, OLLAMA_MAX_TEXT, OllamaProvider, testOllama } from '../src/main/llm/ollama'
import { safeProvider } from '../src/main/llm/safe'
import { AiService } from '../src/main/llm/service'
import type { ChatMessage, LlmProvider, TurnRequest } from '../src/main/llm/types'
import { PolicyService } from '../src/main/policy/policy'
import type { SettingsService } from '../src/main/settings'
import { DataKey } from '../src/main/vault/datakey'
import { fakeAnthropic, fakeOllama } from './fake-llm'

/** Regression tests for the Phase 5 trust/Ollama review, Part A (M1–M3, L1–L6; L6 is in eval-scrub.test.ts). */

const noop = () => {}
const req = (messages: ChatMessage[], over: Partial<TurnRequest> = {}): TurnRequest => ({ system: 'sys', messages, tools: [], signal: new AbortController().signal, onText: noop, onThinking: noop, ...over })
const q = (text: string): ChatMessage => ({ role: 'user', parts: [{ type: 'text', text }] })
const unlocked = () => {
  const k = new DataKey()
  k.setKey(randomBytes(32))
  return k
}
const settings = (p: Partial<Settings>, key = 'sk-ant-api03-REVIEW-KEY-123456'): SettingsService =>
  ({ get: () => ({ aiProvider: 'ollama', aiModel: 'claude-opus-5-5', ollamaEndpoint: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', egressLog: true, aiConfigured: true, ...p }) as Settings, apiKey: async () => key }) as unknown as SettingsService

/** A raw HTTP server for answers the fake Ollama does not give (redirects, oversized streams). */
async function raw(handler: (path: string, res: import('node:http').ServerResponse) => void): Promise<{ url: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = []
  const server: Server = createServer((rq, res) => {
    paths.push(rq.url ?? '')
    rq.resume()
    rq.on('end', () => handler(rq.url ?? '', res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r())))
  }
}

describe('M1: the egress export is private and audited', () => {
  it.skipIf(process.platform === 'win32')('replaces a world-readable file with a 0600 one, and writes an export audit row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-m1-'))
    const file = join(dir, 'egress.jsonl')
    writeFileSync(file, 'old')
    chmodSync(file, 0o644)
    const log = new EgressLog(openDb(':memory:'), unlocked())
    await log.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: { a: 1 } })
    await log.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: { a: 2 } })
    const audit = { append: vi.fn() }
    const h = trustHandlers({ egress: log, policy: PolicyService.none(), audit, saveFile: async () => file })
    expect(await h['egress:export']!.fn([] as never, {} as never)).toEqual({ file, rows: 2 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(audit.append).toHaveBeenCalledOnce()
    expect(audit.append.mock.calls[0]![0]).toMatchObject({ kind: 'export', decision: 'executed', source: 'user', reason: expect.stringContaining(`2 egress rows`) })
    expect(audit.append.mock.calls[0]![0].reason).toContain(file)
  })

  it('a cancelled save dialog writes and audits nothing', async () => {
    const audit = { append: vi.fn() }
    const h = trustHandlers({ egress: new EgressLog(openDb(':memory:'), unlocked()), policy: PolicyService.none(), audit, saveFile: async () => null })
    expect(await h['egress:export']!.fn([] as never, {} as never)).toEqual({ file: null, rows: 0 })
    expect(audit.append).not.toHaveBeenCalled()
  })
})

describe('M2: a request never exceeds num_ctx', () => {
  const suggestion = (n: number) => `[Hopline: the user ran your suggested command. Result (untrusted device data):]\n<terminal_output>\n${'x'.repeat(n)}\n</terminal_output>`

  it('three 40k-character suggest-mode results fit a 16k window, shortened head and tail with their frames kept', () => {
    const ms: ChatMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'why?' }, { type: 'text', text: suggestion(40_000) }, { type: 'text', text: suggestion(40_000) }, { type: 'text', text: suggestion(40_000) }] }]
    const f = fitContext('s'.repeat(7_000), ms, [], 16_384)
    expect(f.tokens).toBeLessThanOrEqual(16_384)
    expect(f.shortened).toBeGreaterThan(0)
    for (const p of f.messages[0]!.parts.slice(1)) {
      const t = (p as { text: string }).text
      expect(t.startsWith('[Hopline: the user ran')).toBe(true)
      expect(t.endsWith('</terminal_output>')).toBe(true)
    }
  })

  it('a full 20k selection with the system prompt fits 8k', () => {
    const f = fitContext('s'.repeat(7_000), [q(`explain\n\nSelected terminal output (untrusted device data):\n<terminal_output>\n${'y'.repeat(20_000)}\n</terminal_output>`)], [], 8_192)
    expect(f.tokens).toBeLessThanOrEqual(8_192)
  })

  it('instructions that leave no room are refused, not truncated by Ollama', () => {
    expect(() => fitContext('s'.repeat(7_000), [q('hi')], [], 2_048)).toThrow(ContextTooSmallError)
    expect(() => fitContext('s'.repeat(7_000), [q('hi')], [], 2_048)).toThrow(/Context too small.*Nothing was sent/)
  })

  it('the provider refuses before sending (no /api/chat, no egress row)', async () => {
    const o = await fakeOllama()
    const log = new EgressLog(openDb(':memory:'), unlocked())
    const ai = new AiService(settings({ ollamaEndpoint: o.url }), { egress: log, modelInfo: async () => ({ tools: true, contextLength: 8_192 }) })
    const p = safeProvider(await ai.provider())
    await expect(p.turn(req([q('hi')], { system: 's'.repeat(30_000) }))).rejects.toThrow(/Context too small/)
    expect(o.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0)
    expect(log.list()).toHaveLength(0)
    await o.close()
  })
})

describe('M3: searching while the vault is locked', () => {
  it('searches the metadata only, and says the payloads were not searched', async () => {
    const key = unlocked()
    const log = new EgressLog(openDb(':memory:'), key)
    await log.record({ provider: 'ollama', model: 'qwen3:8b', destination: 'd', source: 'agent', sessionName: 'core-sw1', body: { m: 'PAYLOAD-ONLY-MARKER' } })
    expect(await log.search({ search: 'payload-only-marker' })).toMatchObject({ rows: [expect.anything()], payloadsSearched: true })
    key.lock()
    expect(await log.search({ search: 'payload-only-marker' })).toEqual({ rows: [], payloadsSearched: false })
    expect((await log.search({ search: 'core-sw1' })).rows).toHaveLength(1)
    // `egress:list` used to throw here.
    await expect(log.query({ search: 'core-sw1' })).resolves.toHaveLength(1)
  })
})

describe('L1: a small run budget does not close the run before its first turn', () => {
  it('the minimum is 20k', () => {
    expect(MIN_RUN_TOKEN_BUDGET).toBe(20_000)
    expect(clampRunBudget(5_000)).toBe(20_000)
    // A team policy cap below it still wins.
    expect(clampRunBudget(5_000, 10_000)).toBe(10_000)
  })

  it('the message points at the setting, or at the team policy when only a policy cap can explain it', () => {
    expect(firstTurnTooLargeMessage(30_000, 20_000)).toMatch(/conversation is too long.*Start a new conversation, or raise the budget in Settings/)
    expect(firstTurnTooLargeMessage(6_000, 5_000)).toMatch(/team policy caps a run at 5k.*raise maxRunTokenBudget to at least 20k/)
    expect(firstTurnTooLargeMessage(6_000, 5_000)).not.toMatch(/Settings/)
  })

  it('a minimum budget runs its first turn normally', async () => {
    const inner: LlmProvider = { id: 'x', async turn() { return { message: { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }, stop: 'end', usage: { inputTokens: 100, outputTokens: 10 } } } }
    const onClosing = vi.fn()
    const p = meteredProvider(inner, new TokenMeter(MIN_RUN_TOKEN_BUDGET, null, undefined, 1), 'coordinator', { label: 'this run', closingNote: 'stop', onClosing })
    const seen: string[] = []
    await p.turn(req([q('hi')], { system: 'sys', onText: (t) => seen.push(t) }))
    expect(onClosing).not.toHaveBeenCalled()
  })

  it('a history too long for the budget says so instead of starting in the closing phase', async () => {
    const inner = { id: 'x', turn: vi.fn() } as unknown as LlmProvider
    const onClosing = vi.fn()
    const p = meteredProvider(inner, new TokenMeter(MIN_RUN_TOKEN_BUDGET, null, undefined, 1), 'coordinator', {
      label: 'this run',
      closingNote: 'stop',
      onClosing,
      firstTurnTooLarge: () => new Error('This conversation is too long for the run budget')
    })
    await expect(p.turn(req([q('z'.repeat(80_000))]))).rejects.toThrow(/too long/)
    expect(onClosing).not.toHaveBeenCalled()
    expect(inner.turn).not.toHaveBeenCalled()
  })
})

describe('L2: the Ollama endpoint is an origin only', () => {
  it('a path, query or fragment is refused everywhere', () => {
    for (const bad of ['http://h:11434/admin/delete?x=', 'http://h:11434/api', 'http://h:11434/?a=1', 'http://h:11434/#x', 'http://h:11434?']) {
      expect(parseOrigin(bad), bad).toBeNull()
      // The lenient parser (the team policy's allow-list) is unchanged.
      expect(parseEndpoint(bad), bad).not.toBeNull()
      expect(Endpoint.safeParse(bad).success, bad).toBe(false)
    }
    for (const ok of ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/', 'https://gpu-box.lan']) {
      expect(parseOrigin(ok), ok).not.toBeNull()
      expect(Endpoint.safeParse(ok).success, ok).toBe(true)
    }
    expect(endpointUrl('http://h:11434/', '/api/tags')).toBe('http://h:11434/api/tags')
  })

  it('discovery and the connect check send nothing to such an address', async () => {
    const s = await raw((_p, res) => res.end('{}'))
    expect(await listOllamaModels(`${s.url}/admin/delete?x=`)).toMatchObject({ ok: false, error: 'invalid_url' })
    expect(await testOllama(`${s.url}/admin/delete?x=`, 'qwen3:8b')).toMatchObject({ ok: false, code: 'bad_endpoint' })
    expect(s.paths).toEqual([])
    await s.close()
  })

  it('a redirect is reported as a redirect, never followed', async () => {
    const s = await raw((_p, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' })
      res.end()
    })
    const r = await testOllama(s.url, 'qwen3:8b')
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/redirect \(HTTP 302\)/)
    expect(r.message).not.toMatch(/Cannot reach/)
    expect(s.paths).toEqual(['/api/chat'])
    await s.close()
  })
})

describe('L3: the Ollama stream is bounded', () => {
  it('a line over 1 MB is refused', async () => {
    const s = await raw((_p, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end('{"message":{"content":"' + 'a'.repeat(1_200_000) + '"}}')
    })
    await expect(new OllamaProvider(s.url, 'm', { tools: true }).turn(req([q('hi')]))).rejects.toThrow(/over 1 MB/)
    await s.close()
  })

  it('the answer text is capped and the turn ends as if at the output limit', async () => {
    const line = JSON.stringify({ message: { content: 'b'.repeat(50_000) }, done: false }) + '\n'
    const s = await raw((_p, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (let i = 0; i < 6; i++) res.write(line)
      res.end(JSON.stringify({ done: true, done_reason: 'stop' }) + '\n')
    })
    const r = await new OllamaProvider(s.url, 'm', { tools: true }).turn(req([q('hi')]))
    expect((r.message.parts[0] as { text: string }).text).toHaveLength(OLLAMA_MAX_TEXT)
    expect(r.stop).toBe('max_tokens')
    await s.close()
  })

  it('oversized arguments make the call invalid, and it is replayed with {}', async () => {
    const o = await fakeOllama({ script: [{ tools: [{ name: 'run_show_command', arguments: { command: 'show run', reason: 'r'.repeat(300_000) } }] }, { text: 'done' }] })
    const p = new OllamaProvider(o.url, 'qwen3:8b', { tools: true })
    const tools = [{ name: 'run_show_command', description: 'd', inputSchema: { type: 'object' } }]
    const r = await p.turn(req([q('hi')], { tools }))
    const call = r.message.parts.find((x) => x.type === 'tool_call') as { id: string; input: unknown; invalid?: string }
    expect(call).toMatchObject({ input: {}, invalid: expect.stringMatching(/larger than 256 KB/) })
    await p.turn(req([q('hi'), r.message, { role: 'user', parts: [{ type: 'tool_result', id: call.id, content: 'ERROR', isError: true }] }], { tools }))
    const second = o.requests.filter((x) => x.path === '/api/chat')[1]!.body as { messages: { tool_calls?: { function: { arguments: unknown } }[] }[] }
    expect(second.messages.find((m) => m.tool_calls)!.tool_calls![0]!.function.arguments).toEqual({})
    expect(JSON.stringify(second)).not.toContain('r'.repeat(1000))
    await o.close()
  })
})

describe('L4: every request to a model is logged', () => {
  it('Anthropic retries: one row that counts every attempt', async () => {
    const api = await fakeAnthropic({ failFirst: 1 })
    const log = new EgressLog(openDb(':memory:'), unlocked())
    const ai = new AiService(settings({ aiProvider: 'anthropic' }), { anthropicBaseURL: api.url, egress: log })
    await safeProvider(await ai.provider()).turn(req([q('hi')]))
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(2)
    expect(log.list()).toEqual([expect.objectContaining({ status: 'ok', attempts: 2 })])
    await api.close()
  })

  it('Ollama: one attempt', async () => {
    const o = await fakeOllama({ script: [{ text: 'fine' }] })
    const log = new EgressLog(openDb(':memory:'), unlocked())
    await safeProvider(await new AiService(settings({ ollamaEndpoint: o.url }), { egress: log }).provider()).turn(req([q('hi')]))
    // The fake server reports token counts like Ollama does.
    expect(log.list()).toEqual([expect.objectContaining({ status: 'ok', attempts: 1, inputTokens: expect.any(Number) })])
    expect(log.list()[0]!.inputTokens).toBeGreaterThan(0)
    await o.close()
  })

  it('connect checks are logged with source "check", one row per request sent, never with the key; health checks are not', async () => {
    const api = await fakeAnthropic()
    const o = await fakeOllama()
    const log = new EgressLog(openDb(':memory:'), unlocked())
    const a = new AiService(settings({ aiProvider: 'anthropic' }), { anthropicBaseURL: api.url, egress: log })
    expect(await a.test({ provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ ok: true })
    expect(await a.health()).toMatchObject({ ok: true })
    const ol = new AiService(settings({ ollamaEndpoint: o.url }), { egress: log })
    expect(await ol.test({ provider: 'ollama', model: 'qwen3:8b', endpoint: o.url })).toMatchObject({ ok: true })
    // A model without tools: the tool request is refused, then the plain one is sent. Both are rows.
    expect(await ol.test({ provider: 'ollama', model: 'llama2:7b', endpoint: o.url })).toMatchObject({ ok: true, suggestMode: true })
    expect(await ol.health()).toMatchObject({ ok: true })
    const rows = [...log.list()].reverse()
    const bodies = await Promise.all(rows.map(async (r) => JSON.parse((await log.get(r.id))!.payload!) as { method: string; path: string; body?: { tools?: unknown[] } }))
    expect(rows.map((r, i) => [r.source, r.provider, r.status, r.attempts, bodies[i]!.method, bodies[i]!.path])).toEqual([
      ['check', 'anthropic', 'ok', 1, 'GET', '/v1/models/claude-opus-5-5'],
      ['check', 'anthropic', 'ok', 1, 'POST', '/v1/messages'],
      ['check', 'ollama', 'ok', 1, 'POST', '/api/chat'],
      ['check', 'ollama', 'error', 1, 'POST', '/api/chat'],
      ['check', 'ollama', 'ok', 1, 'POST', '/api/chat']
    ])
    expect(bodies[3]!.body!.tools).toHaveLength(1)
    expect(bodies[4]!.body).not.toHaveProperty('tools')
    expect(JSON.stringify(bodies[1])).toContain('Reply with the word OK.')
    // What was logged is what was sent.
    expect(o.requests.filter((r) => r.path === '/api/chat').map((r) => r.body)).toEqual(bodies.slice(2).map((b) => b.body))
    for (const r of rows) expect((await log.get(r.id))!.payload).not.toContain('REVIEW-KEY')
    await api.close()
    await o.close()
  })

  it('with the log off, checks are not recorded', async () => {
    const o = await fakeOllama()
    const log = new EgressLog(openDb(':memory:'), unlocked())
    await new AiService(settings({ ollamaEndpoint: o.url, egressLog: false }), { egress: log }).test({ provider: 'ollama', model: 'qwen3:8b', endpoint: o.url })
    expect(log.list()).toEqual([])
    await o.close()
  })
})

describe('L5: a row left "sending" by a crash', () => {
  it('is marked unknown when the log opens again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-l5-'))
    const db = openDb(join(dir, 'h.db'))
    const key = unlocked()
    const log = new EgressLog(db, key)
    const { id } = await log.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: {} })
    const done = await log.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: {} })
    log.finish(done.id, { status: 'ok' })
    expect(log.list().find((r) => r.id === id)!.status).toBe('sending')
    const reopened = new EgressLog(db, key)
    expect(reopened.list().map((r) => [r.id, r.status])).toEqual([
      [done.id, 'ok'],
      [id, 'unknown']
    ])
    db.close()
  })
})
