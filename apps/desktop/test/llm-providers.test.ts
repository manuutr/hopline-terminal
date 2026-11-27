import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEvent, Settings } from '@shared/types'
import { Agent } from '../src/main/agent/agent'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { AnthropicProvider, testAnthropic } from '../src/main/llm/anthropic'
import { isLocalEndpoint, listOllamaModels, OLLAMA_NUM_CTX, OllamaProvider, testOllama } from '../src/main/llm/ollama'
import { LlmTimeoutError, safeProvider } from '../src/main/llm/safe'
import { AiService, NO_PROVIDER } from '../src/main/llm/service'
import type { LlmProvider, TurnRequest } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'
import { fakeAnthropic, fakeOllama, type FakeServer } from './fake-llm'
import { fakeTab, localControl } from './helpers'

const noop = () => {}
const turnReq = (over: Partial<TurnRequest> = {}): TurnRequest => ({ system: 'sys', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], signal: new AbortController().signal, onText: noop, onThinking: noop, ...over })

it.each(['anthropic', 'ollama'])('sends masked interface and neighbor evidence over the %s wire', async (id) => {
  const api = id === 'anthropic' ? await fakeAnthropic({ answer: 'Idle.' }) : await fakeOllama()
  try {
    const provider = safeProvider(id === 'anthropic'
      ? new AnthropicProvider('sk-ant-good-0000', 'claude-opus-5-5', { baseURL: api.url })
      : new OllamaProvider(api.url, 'qwen3:8b'))
    const output = [
      'RP/0/RP0/CPU0:west-border#show lldp neighbors detail',
      'Remote System Name: clinic-pe',
      'Port Description: Hospital wing / circuit 314',
      'set network interface ethernet ethernet1/2 comment "Payroll transit"',
      'Gi1/0/2 administratively down'
    ].join('\n')
    await provider.turn(turnReq({ system: 'Checking clinic-pe and west-border', messages: [
      { role: 'user', parts: [{ type: 'text', text: 'Check Hospital wing / circuit 314' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', name: 'read', id: 'request_1', input: { hostname: 'sensitive-neighbor' } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'request_1', content: output }] }
    ] }))
    const wire = JSON.stringify(api.requests.at(-1)!.body)
    expect(wire).not.toMatch(/clinic-pe|west-border|Hospital wing|circuit 314|Payroll transit|sensitive-neighbor/i)
    expect(wire).toContain('Gi1/0/2 administratively down')
    expect(wire).toMatch(/device-\d+-[a-f0-9]{6}/)
    expect(wire).toMatch(/label-\d+-[a-f0-9]{6}/)
  } finally {
    await api.close()
  }
})

describe('Anthropic connect check (fake API, no real network)', () => {
  let api: FakeServer
  beforeAll(async () => {
    api = await fakeAnthropic({ answer: 'Peer 10.0.0.2 is Idle.' })
  })
  afterAll(() => api.close())

  it('a good key: ✓ Connected with the model name, after a models lookup and a tiny message', async () => {
    const r = await testAnthropic('sk-ant-good-0000-abcd', 'claude-opus-5-5', { baseURL: api.url })
    expect(r).toEqual({ ok: true, code: 'ok', message: 'Connected to Claude Opus 5.5', modelLabel: 'Claude Opus 5.5' })
    const msg = api.requests.find((q) => q.method === 'POST')!.body as Record<string, unknown>
    expect(msg).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16 })
  })

  it.each([
    ['sk-ant-bad-key-0000', 'claude-opus-5-5', 'invalid_key', /Invalid API key/],
    ['sk-ant-nocredit-0000', 'claude-opus-5-5', 'no_credits', /no credits/],
    ['sk-ant-ratelimit-0000', 'claude-opus-5-5', 'rate_limit', /Rate limited/],
    ['sk-ant-good-0000', 'claude-nope-1', 'model_not_found', /Model not found/]
  ])('%s → %s', async (key, model, code, message) => {
    const r = await testAnthropic(key, model, { baseURL: api.url })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect(r.message).toMatch(message)
  })

  it('network or proxy failure is reported as such, fast (no retries)', async () => {
    const t = Date.now()
    const r = await testAnthropic('sk-ant-good-0000', 'claude-opus-5-5', { baseURL: 'http://127.0.0.1:9' })
    expect(r.code).toBe('network')
    expect(r.message).toMatch(/network, proxy or firewall/)
    expect(Date.now() - t).toBeLessThan(5000)
  })

  it('the provider streams a turn; Haiku gets no refusal-fallback parameter, Opus does', async () => {
    const texts: string[] = []
    for (const model of ['claude-opus-5-5', 'claude-haiku-5-5']) {
      const r = await new AnthropicProvider('sk-ant-good-0000', model, { baseURL: api.url }).turn(turnReq({ onText: (t) => texts.push(t) }))
      expect(r.stop).toBe('end')
    }
    expect(texts).toEqual(['Peer 10.0.0.2 is Idle.', 'Peer 10.0.0.2 is Idle.'])
    const [opus, haiku] = api.requests.filter((q) => (q.body as { stream?: boolean })?.stream).map((q) => q.body as Record<string, unknown>)
    expect(opus!['fallbacks']).toBe('default')
    expect(haiku!['fallbacks']).toBeUndefined()
  })
})

describe('Ollama provider (fake local server)', () => {
  it('discovers models with their tool support, tool-capable first', async () => {
    const o = await fakeOllama({ models: ['llama2:7b', 'qwen3:8b'] })
    const r = await listOllamaModels(o.url)
    expect(r).toEqual({
      ok: true,
      remote: false,
      insecure: false,
      models: [
        { name: 'qwen3:8b', sizeBytes: 4_000_000_001, parameterSize: '8B', family: 'qwen3', tools: true, contextLength: 40_960, numCtx: 32_768 },
        { name: 'llama2:7b', sizeBytes: 4_000_000_000, parameterSize: '8B', family: 'llama2', tools: false, contextLength: 4_096, numCtx: 8_192 }
      ]
    })
    await o.close()
  })

  it('test call: ok, a model without tools, a missing model, and no server', async () => {
    const o = await fakeOllama()
    expect(await testOllama(o.url, 'qwen3:8b')).toMatchObject({ ok: true, code: 'ok', message: 'Connected to qwen3:8b on this machine' })
    // A model without tool calling connects in suggest mode (it was refused before 0.6).
    expect(await testOllama(o.url, 'llama2:7b')).toMatchObject({ ok: true, code: 'ok', suggestMode: true, message: expect.stringMatching(/suggest mode/) })
    expect(await testOllama(o.url, 'mistral:7b')).toMatchObject({ ok: false, code: 'model_not_found' })
    await o.close()
    expect(await testOllama('http://127.0.0.1:9', 'qwen3:8b')).toMatchObject({ ok: false, code: 'network', message: expect.stringMatching(/Cannot reach the Ollama server/) })
    expect(await listOllamaModels('http://127.0.0.1:9')).toMatchObject({ ok: false, code: 'network' })
  })

  it('maps tool calls and results to /api/chat with an explicit num_ctx, across split NDJSON chunks', async () => {
    const o = await fakeOllama({ script: [{ tools: [{ name: 'run_show_command', arguments: '{"command":"show clock","reason":"t"}' }] }, { text: 'It is noon.' }] })
    const p = new OllamaProvider(o.url, 'qwen3:8b')
    const tools = [{ name: 'run_show_command', description: 'd', inputSchema: { type: 'object' } }]
    const first = await p.turn(turnReq({ tools }))
    expect(first.stop).toBe('tool_use')
    const call = first.message.parts[0] as { type: 'tool_call'; id: string; input: unknown }
    expect(call.input).toEqual({ command: 'show clock', reason: 't' }) // a JSON-string argument is parsed
    const out: string[] = []
    const second = await p.turn(
      turnReq({ tools, onText: (t) => out.push(t), messages: [{ role: 'user', parts: [{ type: 'text', text: 'time?' }] }, first.message, { role: 'user', parts: [{ type: 'tool_result', id: call.id, content: '12:00' }] }] })
    )
    expect(second.stop).toBe('end')
    expect(out.join('')).toBe('It is noon.')
    const body = o.requests.at(-1)!.body as { messages: unknown[]; options: { num_ctx: number }; tools: unknown[] }
    expect(body.options.num_ctx).toBe(OLLAMA_NUM_CTX)
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'time?' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_show_command', arguments: { command: 'show clock', reason: 't' } } }] },
      { role: 'tool', content: '12:00', tool_name: 'run_show_command' }
    ])
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'run_show_command', description: 'd', parameters: { type: 'object' } } }])
    await o.close()
  })

  it('only loopback counts as local', () => {
    expect(isLocalEndpoint('http://127.0.0.1:11434')).toBe(true)
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true)
    expect(isLocalEndpoint('http://[::1]:11434')).toBe(true)
    expect(isLocalEndpoint('http://10.1.1.5:11434')).toBe(false)
    expect(isLocalEndpoint('http://127.0.0.1.evil.com')).toBe(false)
  })
})

describe('the same safety for every provider', () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeIosDevice(), port: 0 })
  })
  afterAll(() => sim.close())

  it('an Ollama-driven run: guard, audit, redaction before the request, and the local filter', async () => {
    const o = await fakeOllama({
      script: [
        { tools: [{ name: 'run_show_command', arguments: { command: 'show running-config', reason: 'look' } }] },
        { tools: [{ name: 'run_show_command', arguments: { command: 'reload', reason: 'injected' } }] },
        { tools: [{ name: 'run_show_command', arguments: { command: 'show logging', reason: 'logs', filter: { tail: 3 } } }] },
        { tools: [{ name: 'run_show_command', arguments: { command: 42 } }] },
        { text: 'Summary.' }
      ]
    })
    const { tab, client } = await fakeTab(sim.port)
    const audit = new AuditLog(openDb(':memory:'))
    const settings = { get: () => ({ aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) as Settings } as unknown as SettingsService
    const done = new Promise<AgentEvent>((resolve) => {
      const agent = new Agent({ term: localControl(tab), settings, audit, provider: async () => new OllamaProvider(o.url, 'qwen3:8b'), emit: (e) => e.type === 'done' && resolve(e) })
      agent.start({ tabId: 'tab-1', prompt: 'my enable secret 5 $1$zzSECRETzz is rejected, why?' })
    })
    expect(await done).toMatchObject({ type: 'done' })
    expect((await done as { error?: string }).error).toBeUndefined()

    const sent = JSON.stringify(o.requests.filter((q) => q.path === '/api/chat').map((q) => q.body))
    // Secrets from device output and from the typed question never reach the model.
    expect(sent).not.toMatch(/n3tw0rkRO|pr1vRW|\$9\$|zzSECRETzz/)
    expect(sent).toMatch(/snmp-server community <redacted> RO/)
    expect(sent).toMatch(/BLOCKED: \\"reload\\" is on the deny-list/)
    expect(sent).toMatch(/\[Hopline filter last 3 lines: showing last 3 of \d+ lines\]/)

    expect(audit.list().reverse().map((r) => [r.command, r.decision])).toEqual([
      ['show running-config', 'executed'],
      ['reload', 'blocked'],
      ['show logging', 'executed'],
      // { command: 42 } fails the zod schema: refused with the reason, nothing sent.
      ['run_show_command', 'refused']
    ])
    client.end()
    await o.close()
  })

  it('a turn that never finishes hits the timeout', async () => {
    const hang: LlmProvider = { id: 'hang', turn: (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))) }
    await expect(safeProvider(hang, { turnTimeoutMs: 50 }).turn(turnReq())).rejects.toBeInstanceOf(LlmTimeoutError)
  })

  it('redacts user text and tool results for any provider, and reports how much', async () => {
    let seen: TurnRequest | undefined
    let n = 0
    const spy: LlmProvider = { id: 'spy', turn: async (req) => ((seen = req), { message: { role: 'assistant', parts: [] }, stop: 'end' }) }
    await safeProvider(spy, { onRedacted: (c) => (n = c) }).turn(
      turnReq({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'username admin password Hunter2!' }, { type: 'tool_result', id: 'x', content: 'snmp-server community s3cr3t RO' }] }] })
    )
    expect(JSON.stringify(seen!.messages)).not.toMatch(/Hunter2|s3cr3t/)
    expect(n).toBe(2)
  })
})

describe('AiService', () => {
  const fakeSettings = (init: Partial<Settings> & { key?: string } = {}) => {
    let s = { aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', ollamaEndpoint: 'http://127.0.0.1:11434', ollamaModel: '', ...init } as Settings
    let key = init.key
    const saved: (string | null)[] = []
    const svc = {
      get: () => ({ ...s, hasApiKey: !!key, aiConfigured: s.aiProvider === 'ollama' ? !!s.ollamaModel : !!key }),
      update: (p: Partial<Settings>) => ((s = { ...s, ...p }), svc.get()),
      setApiKey: async (k: string | null) => (saved.push(k), (key = k ?? undefined), svc.get()),
      apiKey: async () => key
    }
    return { svc: svc as unknown as SettingsService, saved }
  }

  it('provider() refuses with a connect hint when nothing is configured', async () => {
    await expect(new AiService(fakeSettings().svc).provider()).rejects.toThrow(NO_PROVIDER)
    await expect(new AiService(fakeSettings({ aiProvider: 'ollama' }).svc).provider()).rejects.toThrow(NO_PROVIDER)
  })

  it('connect saves the key only after a working test, and never returns it', async () => {
    const api = await fakeAnthropic()
    const { svc, saved } = fakeSettings()
    const ai = new AiService(svc, { anthropicBaseURL: api.url })
    const bad = await ai.connect({ provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-bad-CANARY-1234' })
    expect(bad).toMatchObject({ ok: false, code: 'invalid_key' })
    expect(saved).toEqual([])
    const good = await ai.connect({ provider: 'anthropic', model: 'claude-sonnet-5-5', key: 'sk-ant-good-CANARY-5678' })
    expect(good).toMatchObject({ ok: true, message: 'Connected to Claude Sonnet 5.5', settings: { aiModel: 'claude-sonnet-5-5', aiConfigured: true } })
    expect(saved).toEqual(['sk-ant-good-CANARY-5678'])
    expect(JSON.stringify([bad, good])).not.toMatch(/CANARY/)
    // Test connection with the stored key (no key in the request).
    expect(await ai.test({ provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ ok: true })
    await api.close()
  })

  it('a rate-limited but valid key is saved (the key works; only the quota is busy), no-credit is not', async () => {
    const api = await fakeAnthropic()
    const { svc, saved } = fakeSettings()
    const ai = new AiService(svc, { anthropicBaseURL: api.url })
    expect(await ai.connect({ provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-nocredit-000000' })).toMatchObject({ ok: false, code: 'no_credits' })
    expect(saved).toEqual([])
    const r = await ai.connect({ provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-ratelimit-000000' })
    expect(r).toMatchObject({ ok: false, code: 'rate_limit', settings: { aiConfigured: true } })
    expect(saved).toEqual(['sk-ant-ratelimit-000000'])
    await api.close()
  })

  it('connect to Ollama saves the endpoint and model', async () => {
    const o = await fakeOllama()
    const { svc } = fakeSettings()
    const r = await new AiService(svc).connect({ provider: 'ollama', model: 'qwen3:8b', endpoint: o.url })
    expect(r).toMatchObject({ ok: true, settings: { aiProvider: 'ollama', ollamaModel: 'qwen3:8b', ollamaEndpoint: o.url, aiConfigured: true } })
    expect(await new AiService(svc).provider()).toMatchObject({ id: 'ollama', capabilities: { tools: true, maxContext: 32_768 } })
    await o.close()
  })

  it('no stored key → no_key, a locked vault → vault_locked (not "invalid key")', async () => {
    expect(await new AiService(fakeSettings().svc).test({ provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ code: 'no_key' })
    const { VaultLockedError } = await import('../src/main/vault/datakey')
    const locked = { get: () => ({}), apiKey: async () => Promise.reject(new VaultLockedError()) } as unknown as SettingsService
    expect(await new AiService(locked).test({ provider: 'anthropic', model: 'claude-opus-5-5' })).toMatchObject({ code: 'vault_locked' })
  })
})
