import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/types'
import { openDb } from '../src/main/db'
import { EgressLog } from '../src/main/egress/store'
import { NOT_LOGGED } from '../src/main/llm/egress'
import { safeProvider } from '../src/main/llm/safe'
import { AiService } from '../src/main/llm/service'
import type { TurnRequest } from '../src/main/llm/types'
import { parsePolicy, PolicyService } from '../src/main/policy/policy'
import type { SettingsService } from '../src/main/settings'
import { DataKey } from '../src/main/vault/datakey'
import { trustHandlers } from '../src/main/ipc/trust'
import { fakeAnthropic, fakeOllama } from './fake-llm'

const KEY = 'sk-ant-api03-EGRESS-CANARY-KEY-7c1d'
const noop = () => {}
const req = (text: string, over: Partial<TurnRequest> = {}): TurnRequest => ({
  system: 'You are Hopline Terminal.',
  messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
  tools: [{ name: 'run_show_command', description: 'd', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }],
  signal: new AbortController().signal,
  onText: noop,
  onThinking: noop,
  meta: { runId: 'run-42', source: 'agent', sessionName: 'core-sw1' },
  ...over
})

const unlocked = () => {
  const k = new DataKey()
  k.setKey(randomBytes(32))
  return k
}

function fakeSettings(p: Partial<Settings>): SettingsService {
  const s = { aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', ollamaEndpoint: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', egressLog: true, ...p } as Settings
  return { get: () => ({ ...s, aiConfigured: true }), apiKey: async () => KEY } as unknown as SettingsService
}

describe('EgressLog store', () => {
  it('records, lists, opens, searches and exports; the payload is encrypted at rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-egress-'))
    const db = openDb(join(dir, 'h.db'))
    const log = new EgressLog(db, unlocked())
    const { id } = await log.record({ provider: 'ollama', model: 'qwen3:8b', destination: '127.0.0.1:11434', source: 'agent', sessionName: 'r1', runId: 'run-1', body: { messages: [{ role: 'user', content: 'BGP-PEER-MARKER-10.0.0.2' }] } })
    log.finish(id, { status: 'ok', inputTokens: 120, outputTokens: 30, durationMs: 15 })
    expect(log.list()).toEqual([expect.objectContaining({ id, provider: 'ollama', model: 'qwen3:8b', destination: '127.0.0.1:11434', sessionName: 'r1', runId: 'run-1', inputTokens: 120, outputTokens: 30, status: 'ok', hasPayload: true })])
    expect((await log.get(id))!.payload).toContain('BGP-PEER-MARKER-10.0.0.2')
    expect(await log.query({ search: 'peer-marker' })).toHaveLength(1)
    expect(await log.query({ search: 'qwen3' })).toHaveLength(1) // metadata
    expect(await log.query({ search: 'nothing-like-this' })).toHaveLength(0)
    const lines = (await log.exportLines()).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ id, payload: { messages: [{ role: 'user', content: 'BGP-PEER-MARKER-10.0.0.2' }] } })
    db.close()
    // Not in the clear anywhere in the database files.
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(Buffer.from('BGP-PEER-MARKER'))).toBe(false)
  })

  it('rotates: the oldest rows go first when the row or byte cap is reached', async () => {
    const log = new EgressLog(openDb(':memory:'), unlocked(), { maxRows: 3 })
    for (let i = 0; i < 5; i++) await log.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: { n: i } })
    expect(log.list().map((r) => r.id)).toEqual([5, 4, 3])
    const small = new EgressLog(openDb(':memory:'), unlocked(), { maxBytes: 2_000 })
    for (let i = 0; i < 20; i++) await small.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: { n: i, pad: randomBytes(300).toString('hex') } })
    expect(small.stats().bytes).toBeLessThanOrEqual(2_000)
    expect(small.list()[0]!.id).toBe(20)
  })

  it('a locked vault: the row is kept without its payload, and the error is returned', async () => {
    const log = new EgressLog(openDb(':memory:'), new DataKey())
    const r = await log.record({ provider: 'ollama', model: 'm', destination: 'd', source: 'agent', body: { x: 1 } })
    expect(r.error?.name).toBe('VaultLockedError')
    expect(log.list()[0]).toMatchObject({ id: r.id, hasPayload: false })
    expect(await log.get(r.id)).toMatchObject({ payload: null })
  })
})

describe('what left this machine is exactly what was sent', () => {
  it('Anthropic: the logged payload deep-equals the body the API received; the key is in neither the log nor the export', async () => {
    const api = await fakeAnthropic({ answer: 'ok' })
    const dir = mkdtempSync(join(tmpdir(), 'hopline-egress-a-'))
    const db = openDb(join(dir, 'h.db'))
    const log = new EgressLog(db, unlocked())
    const ai = new AiService(fakeSettings({}), { anthropicBaseURL: api.url, egress: log })
    // AgentLoop's door: redaction first, then the logged adapter.
    const p = safeProvider(await ai.provider())
    await p.turn(req('why is bgp down? enable secret 5 $1$zzSECRETzz\ncore-sw1# show run\n description Carrier Violet'))
    const sent = api.requests.find((q) => q.method === 'POST' && q.path.startsWith('/v1/messages'))!
    const [row] = log.list()
    expect(row).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', destination: new URL(api.url).host, source: 'agent', sessionName: 'core-sw1', runId: 'run-42', status: 'ok', inputTokens: 5 })
    const detail = await log.get(row!.id)
    expect(JSON.parse(detail!.payload!)).toEqual(sent.body)
    // Redacted before it left; the header carried the key, the log never did.
    expect(detail!.payload).not.toMatch(/zzSECRETzz|core-sw1|Carrier Violet/)
    expect(JSON.stringify(sent.headers)).toContain(KEY)
    const exported = join(dir, 'out.jsonl')
    const h = trustHandlers({ egress: log, policy: PolicyService.none(), saveFile: async () => exported })
    expect(await h['egress:export']!.fn([] as never, {} as never)).toEqual({ file: exported, rows: 1 })
    for (const text of [detail!.payload!, readFileSync(exported, 'utf8'), JSON.stringify(log.list())]) {
      expect(text).not.toContain(KEY)
      expect(text).not.toMatch(/x-api-key|authorization/i)
    }
    db.close()
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(Buffer.from(KEY))).toBe(false)
    await api.close()
  })

  it('Ollama: the logged payload deep-equals the /api/chat body', async () => {
    const o = await fakeOllama({ script: [{ text: 'fine' }] })
    const log = new EgressLog(openDb(':memory:'), unlocked())
    const ai = new AiService(fakeSettings({ aiProvider: 'ollama', ollamaEndpoint: o.url }), { egress: log })
    await safeProvider(await ai.provider()).turn(req('core-sw1# show run\n description Violet circuit'))
    const chat = o.requests.find((q) => q.path === '/api/chat')!
    const [row] = log.list()
    expect(row).toMatchObject({ provider: 'ollama', destination: new URL(o.url).host, status: 'ok' })
    expect(JSON.parse((await log.get(row!.id))!.payload!)).toEqual(chat.body)
    expect(JSON.stringify(chat.body)).not.toMatch(/core-sw1|Violet circuit/)
    await o.close()
  })

  it('the setting off: nothing is recorded; a policy that requires it records anyway', async () => {
    const o = await fakeOllama({ script: [{ text: 'a' }, { text: 'b' }] })
    const log = new EgressLog(openDb(':memory:'), unlocked())
    const s = fakeSettings({ aiProvider: 'ollama', ollamaEndpoint: o.url, egressLog: false })
    await safeProvider(await new AiService(s, { egress: log }).provider()).turn(req('x'))
    expect(log.list()).toEqual([])
    const policy = new PolicyService(parsePolicy(JSON.stringify({ version: 1, requireEgressLog: true }), '/p.json'))
    await safeProvider(await new AiService(s, { egress: log, policy }).provider()).turn(req('y'))
    expect(log.list()).toHaveLength(1)
    await o.close()
  })

  it('required but cannot be written (vault locked): the request is not sent', async () => {
    const o = await fakeOllama({ script: [{ text: 'never' }] })
    const log = new EgressLog(openDb(':memory:'), new DataKey())
    const policy = new PolicyService(parsePolicy(JSON.stringify({ version: 1, requireEgressLog: true }), '/p.json'))
    const ai = new AiService(fakeSettings({ aiProvider: 'ollama', ollamaEndpoint: o.url }), { egress: log, policy })
    await expect(safeProvider(await ai.provider()).turn(req('x'))).rejects.toThrow(NOT_LOGGED)
    expect(o.requests.filter((q) => q.path === '/api/chat')).toEqual([])
    expect(log.list()[0]).toMatchObject({ status: 'cancelled', hasPayload: false })
    await o.close()
  })

  it('optional and the vault locked: sent, with a metadata-only row', async () => {
    const o = await fakeOllama({ script: [{ text: 'sent' }] })
    const log = new EgressLog(openDb(':memory:'), new DataKey())
    const ai = new AiService(fakeSettings({ aiProvider: 'ollama', ollamaEndpoint: o.url }), { egress: log })
    await safeProvider(await ai.provider()).turn(req('x'))
    expect(o.requests.filter((q) => q.path === '/api/chat')).toHaveLength(1)
    expect(log.list()[0]).toMatchObject({ status: 'ok', hasPayload: false })
    await o.close()
  })

  it('a failed request keeps its row as an error (it may still have left)', async () => {
    const o = await fakeOllama({ models: ['qwen3:8b'] })
    const log = new EgressLog(openDb(':memory:'), unlocked())
    const ai = new AiService(fakeSettings({ aiProvider: 'ollama', ollamaEndpoint: o.url, ollamaModel: 'qwen3:8b' }), { egress: log })
    const p = safeProvider(await ai.provider())
    await o.close()
    await expect(p.turn(req('x'))).rejects.toThrow()
    expect(log.list()[0]).toMatchObject({ status: 'error', hasPayload: true })
  })
})
