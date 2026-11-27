import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CLOUD, modelFor } from '@shared/providers'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { EgressLog } from '../src/main/egress/store'
import { ChatCompletionsProvider } from '../src/main/llm/chat-completions'
import { safeProvider } from '../src/main/llm/safe'
import { AiService } from '../src/main/llm/service'
import type { TurnRequest } from '../src/main/llm/types'
import { parsePolicy, PolicyService } from '../src/main/policy/policy'
import { SettingsService } from '../src/main/settings'
import { DataKey } from '../src/main/vault/datakey'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const turn: TurnRequest = {
  system: 'Investigate the interface.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Check edge-dc1' }] }],
  tools: [{ name: 'read_status', description: 'Read interface state', inputSchema: { type: 'object', properties: {} } }],
  meta: { sessionName: 'edge-dc1' }, signal: new AbortController().signal, onText: () => {}, onThinking: () => {}
}
const call = (name: string, args = '{}') => ({
  id: 'call_1', type: 'function', function: { name, arguments: args }, extra_content: { google: { thought_signature: 'c2lnbmF0dXJl' } }
})
const reply = (message: object, finish_reason = 'tool_calls') =>
  Response.json({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 13, completion_tokens: 7 } })
function fixture() {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  const key = new DataKey()
  key.setKey(randomBytes(32))
  const settings = new SettingsService(repo, key)
  const egress = new EgressLog(db, key)
  return { db, repo, settings, egress }
}
afterEach(() => vi.unstubAllEnvs())

it.each(['openai', 'gemini'] as const)('%s connects, masks and logs the exact two-turn tool exchange', async vendor => {
  const { db, settings, egress } = fixture()
  try {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ tool_calls: [call('connection_check')] }))
      .mockResolvedValueOnce(Response.json({ id: 'my-model' }))
      .mockResolvedValueOnce(reply({ tool_calls: [call('read_status')] }))
      .mockResolvedValueOnce(reply({ content: 'Interface is down.' }, 'stop'))
    const ai = new AiService(settings, { cloudFetch: send, egress })
    const key = 'private-vendor-key-7581'
    const connected = await ai.connect({ provider: vendor, model: 'my-model', key })
    expect(connected).toMatchObject({ ok: true, settings: { aiConfigured: true, aiProvider: vendor } })
    expect(modelFor(vendor, settings.get())).toBe('my-model')
    expect(await ai.health()).toMatchObject({ ok: true, destination: CLOUD[vendor].host, local: false })
    const adapter = safeProvider(await ai.provider())
    const first = await adapter.turn(turn)
    expect(first.stop).toBe('tool_use')
    const answer = await adapter.turn({ ...turn, messages: [...turn.messages, first.message, { role: 'user', parts: [
      { type: 'tool_result', id: 'call_1', content: 'Port Description: Private customer handoff\nGi1/1 is down' }
    ] }] })
    expect(answer).toMatchObject({ stop: 'end', usage: { inputTokens: 13, outputTokens: 7 } })
    for (const [url, init] of send.mock.calls) {
      expect(new URL(String(url)).host).toBe(CLOUD[vendor].host)
      expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer ' + key } })
    }
    const body = JSON.parse(String(send.mock.calls[3]![1]!.body))
    expect(JSON.stringify(body)).not.toMatch(/edge-dc1|Private customer handoff|private-vendor-key/)
    expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: expect.stringContaining('Gi1/1 is down') })
    expect(body.messages.at(-2).tool_calls[0].extra_content?.google.thought_signature).toBe(vendor === 'gemini' ? 'c2lnbmF0dXJl' : undefined)
    const logs = egress.list()
    expect(logs).toHaveLength(3)
    const last = await egress.get(logs[0]!.id)
    expect(JSON.parse(last!.payload!)).toEqual(body)
    expect(logs[0]).toMatchObject({ provider: vendor, destination: CLOUD[vendor].host, attempts: 1 })
  } finally { db.close() }
})

it('isolates vault ciphertext and key hints, including removal and session-only cleanup', async () => {
  const { db, settings, repo } = fixture()
  try {
    for (const id of ['anthropic','openai','gemini'] as const) {
      vi.stubEnv(id.toUpperCase() + '_API_KEY', '')
      await settings.setApiKey('key-for-testing-' + id, id)
    }
    const s = settings.get()
    expect(JSON.stringify(s)).not.toContain('key-for-testing')
    expect(s.cloudKeys?.gemini).toEqual({ saved: true, last4: 'mini' })
    await settings.setApiKey(null, 'openai')
    expect(await settings.apiKey('openai')).toBeFalsy()
    expect(await settings.apiKey()).toBe('key-for-testing-anthropic')
    repo.setSetting('openai_api_key_dek', repo.getSetting('gemini_api_key_dek')!)
    await expect(settings.apiKey('openai')).rejects.toThrow()
    settings.dropEphemeralApiKey()
    expect(Object.values(settings.get().cloudKeys!).every(k => !k.saved)).toBe(true)
  } finally { db.close() }
})

it('checks policy before any network call and never saves a rejected or rate-limited credential', async () => {
  const { db, settings } = fixture()
  try {
    const send = vi.fn<typeof fetch>()
    const policy = new PolicyService(parsePolicy(JSON.stringify({version: 1, allowedProviders: ['gemini']}), '/policy.json'))
    settings.update({ aiProvider: 'openai' })
    const ai = new AiService(settings, { cloudFetch: send, policy })
    const req = { provider: 'openai' as const, model: 'm', key: 'test-credential' }
    expect(await ai.connect(req)).toMatchObject({ code: 'policy' })
    expect(await ai.health()).toMatchObject({ ok: false, provider: 'openai' })
    await expect(ai.provider()).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    send.mockResolvedValueOnce(Response.json({ error: { message: 'test-credential' } }, { status: 429 }))
    const limited = await ai.connect({ ...req, provider: 'gemini' })
    expect(limited).toMatchObject({ ok: false, code: 'rate_limit' })
    expect(JSON.stringify(limited)).not.toContain(req.key)
    expect(settings.get().aiProvider).toBe('openai')
  } finally { db.close() }
})

it('withholds truncated, refused and malformed tool calls from execution', async () => {
  const message = { tool_calls: [call('read_status','[]')] }
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(reply(message, 'length'))
    .mockResolvedValueOnce(reply({ ...message, refusal: 'declined' }))
    .mockResolvedValueOnce(reply(message))
  const provider = new ChatCompletionsProvider('gemini','fake-key','m',send)
  for (const stop of ['max_tokens','refusal']) {
    expect(await provider.turn(turn)).toMatchObject({ stop, message: { parts: [] } })
  }
  expect((await provider.turn(turn)).message.parts[0]).toMatchObject({ type: 'tool_call', invalid: expect.any(String) })
  await expect(provider.turn({ ...turn, beforeSend: async () => { throw new Error('audit unavailable') } })).rejects.toThrow('audit unavailable')
  expect(send).toHaveBeenCalledTimes(3)
})

it('rejects oversized or non-JSON replies without echoing their contents', async () => {
  const send = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('sensitive content from a proxy'))
    .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
  const provider = new ChatCompletionsProvider('openai', 'demo-key', 'm', send)
  await expect(provider.turn(turn)).rejects.toThrow('The provider returned an unreadable response.')
  await expect(provider.turn(turn)).rejects.toThrow('The model response exceeded 2 MiB.')
})
