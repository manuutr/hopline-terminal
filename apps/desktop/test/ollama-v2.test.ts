import { userInfo } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEvent, Settings } from '@shared/types'
import { Agent } from '../src/main/agent/agent'
import { classifySuggestions, extractCommandBlocks, SuggestionStore, SUGGESTION_TTL_MS } from '../src/main/agent/suggest'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { fitContext } from '../src/main/llm/context'
import { numCtxFor, OLLAMA_MAX_NUM_CTX, OLLAMA_NUM_CTX, ollamaHealth, OllamaProvider, readShow } from '../src/main/llm/ollama'
import { AiService } from '../src/main/llm/service'
import type { ChatMessage, TurnRequest } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'
import { fakeOllama, type OllamaChatBody } from './fake-llm'
import { fakeTab, localControl } from './helpers'

const noop = () => {}
const turnReq = (over: Partial<TurnRequest> = {}): TurnRequest => ({ system: 'sys', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], signal: new AbortController().signal, onText: noop, onThinking: noop, ...over })

describe('model info: tool support and context length', () => {
  it('reads /api/show the way Ollama answers it', () => {
    expect(readShow({ capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } })).toEqual({ tools: true, contextLength: 40960 })
    expect(readShow({ capabilities: ['completion'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 } })).toEqual({ tools: false, contextLength: 4096 })
    expect(readShow({ model_info: { 'general.architecture': 'x', 'gemma3.context_length': 8192 } })).toEqual({ tools: null, contextLength: 8192 })
    expect(readShow({})).toEqual({ tools: null, contextLength: null })
    expect(readShow('nope')).toEqual({ tools: null, contextLength: null })
    expect(readShow({ model_info: { 'general.architecture': 'q', 'q.context_length': 'big' } }).contextLength).toBeNull()
  })

  it('num_ctx: the model\'s own length, capped (a 128k KV cache does not fit a laptop), the old default when unknown', () => {
    expect(numCtxFor(131_072)).toBe(OLLAMA_MAX_NUM_CTX)
    expect(numCtxFor(8_192)).toBe(8_192)
    expect(numCtxFor(512)).toBe(8_192) // the floor: the instructions alone are ~2.3k tokens (review M2)
    expect(numCtxFor(4_096)).toBe(8_192)
    expect(numCtxFor(null)).toBe(OLLAMA_NUM_CTX)
  })

  it('the provider is built from the model info: num_ctx and tools per model', async () => {
    const o = await fakeOllama({ script: [{ text: 'a' }, { text: 'b' }] })
    const svc = (model: string) => ({ get: () => ({ aiProvider: 'ollama', ollamaEndpoint: o.url, ollamaModel: model, egressLog: false, aiConfigured: true }) as Settings }) as unknown as SettingsService
    const tooled = await new AiService(svc('qwen3:8b')).provider()
    expect(tooled.capabilities).toEqual({ tools: true, maxContext: 32_768 })
    const plain = await new AiService(svc('llama2:7b')).provider()
    // num_ctx is at least 8k, and the request is fitted to the model's own 4k window.
    expect(plain.capabilities).toEqual({ tools: false, maxContext: 4_096 })
    const tools = [{ name: 'run_show_command', description: 'd', inputSchema: { type: 'object' } }]
    await tooled.turn(turnReq({ tools }))
    await plain.turn(turnReq({ tools }))
    const [a, b] = o.requests.filter((q) => q.path === '/api/chat').map((q) => q.body as OllamaChatBody & { options: { num_ctx: number } })
    expect(a!.options.num_ctx).toBe(32_768)
    expect(a!.tools).toHaveLength(1)
    expect(b!.options.num_ctx).toBe(8_192)
    // A model without tool calling never gets tool definitions (Ollama would refuse the request).
    expect(b).not.toHaveProperty('tools')
    await o.close()
  })

  it('health: version, tool support and context; a missing model and no server are specific', async () => {
    const o = await fakeOllama({ version: '0.12.9' })
    expect(await ollamaHealth(o.url, 'qwen3:8b')).toMatchObject({ ok: true, provider: 'ollama', local: true, version: '0.12.9', tools: true, contextLength: 40_960, numCtx: 32_768, message: 'qwen3:8b is ready · tool calling · context 32,768 tokens' })
    expect(await ollamaHealth(o.url, 'llama2:7b')).toMatchObject({ ok: true, tools: false, message: expect.stringMatching(/suggest mode/) })
    expect(await ollamaHealth(o.url, 'mistral:7b')).toMatchObject({ ok: false, message: expect.stringMatching(/not on the server/) })
    await o.close()
    expect(await ollamaHealth('http://127.0.0.1:9', 'qwen3:8b')).toMatchObject({ ok: false, message: expect.stringMatching(/Cannot reach/) })
  })
})

describe('context fitting', () => {
  const q = (t: string): ChatMessage => ({ role: 'user', parts: [{ type: 'text', text: t }] })
  const call = (id: string): ChatMessage => ({ role: 'assistant', parts: [{ type: 'tool_call', id, name: 'run_show_command', input: { command: 'show log' } }] })
  const res = (id: string, n: number): ChatMessage => ({ role: 'user', parts: [{ type: 'tool_result', id, content: 'x'.repeat(n) }] })
  const a = (t: string): ChatMessage => ({ role: 'assistant', parts: [{ type: 'text', text: t }] })

  it('leaves a conversation that fits alone', () => {
    const ms = [q('hi'), a('hello')]
    expect(fitContext('sys', ms, [], 8192)).toMatchObject({ messages: ms, dropped: 0, shortened: 0 })
  })

  it('drops whole exchanges oldest first, never a call without its result, and says so; the original is untouched', () => {
    const ms = [q('first'), call('c1'), res('c1', 20_000), a('one'), q('second'), call('c2'), res('c2', 3_000), a('two'), q('third')]
    const before = JSON.stringify(ms)
    const f = fitContext('sys', ms, [], 4096)
    expect(f.dropped).toBe(4)
    expect(f.messages[0]!.parts[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/4 earlier messages were left out/) })
    expect(f.messages.map((m) => m.parts.map((p) => p.type).join('+'))).toEqual(['text+text', 'tool_call', 'tool_result', 'text', 'text'])
    expect(JSON.stringify(ms)).toBe(before)
    expect(f.tokens).toBeLessThanOrEqual(4096)
  })

  it('shortens the newest exchange\'s tool results to head and tail when it alone does not fit', () => {
    const ms = [q('only'), call('c1'), res('c1', 60_000)]
    const f = fitContext('sys', ms, [], 8192)
    const r = f.messages[2]!.parts[0] as { content: string }
    expect(f.shortened).toBe(1)
    expect(r.content).toMatch(/characters left out to fit the model's context window/)
    expect(f.tokens).toBeLessThanOrEqual(8192)
    expect((ms[2]!.parts[0] as { content: string }).content).toHaveLength(60_000)
  })

  it('a cut-off run\'s question that shares its message with older results keeps only the question', () => {
    const ms = [q('first'), call('c1'), res('c1', 30_000), { role: 'user' as const, parts: [{ type: 'tool_result' as const, id: 'c0', content: 'late' }, { type: 'text' as const, text: 'next question' }] }]
    const f = fitContext('sys', ms, [], 4096)
    expect(f.messages[0]!.parts.map((p) => p.type)).toEqual(['text', 'text'])
  })

  it('the Ollama request carries the fitted history', async () => {
    const o = await fakeOllama({ script: [{ text: 'ok' }] })
    const p = new OllamaProvider(o.url, 'qwen3:8b', { tools: true, numCtx: 4096 })
    await p.turn(turnReq({ messages: [q('old'), call('c1'), res('c1', 40_000), a('…'), q('now?')] }))
    const body = o.requests.find((r) => r.path === '/api/chat')!.body as { messages: { role: string; content: string }[]; options: { num_ctx: number } }
    expect(body.options.num_ctx).toBe(4096)
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect(body.messages[1]!.content).toMatch(/left out to fit/)
    await o.close()
  })
})

describe('suggest mode: parsing and classification', () => {
  it('takes every line of every fenced block, strips a device prompt, and RUN: lines', () => {
    const text = 'Check these:\n```\ncore-sw1#show ip interface brief\nshow ip bgp summary\n! a comment\n```\nThen:\nRUN: `show clock`\n```cisco\ninterface Gi0/1\n no shutdown\n```'
    expect(extractCommandBlocks(text)).toEqual([['show ip interface brief', 'show ip bgp summary'], ['interface Gi0/1', 'no shutdown'], ['show clock']])
  })

  it('reads are one suggestion each; configuration lines of a block are one proposal; blocked lines cannot run', () => {
    const s = classifySuggestions([['sh ip int br', 'show ip bgp summary'], ['interface Gi0/1', 'no shutdown'], ['show run ; reload'], ['show clock', 'show clock']], 'iosxe')
    expect(s.map((x) => [x.kind, x.commands])).toEqual([
      ['read', ['sh ip int br']],
      ['read', ['show ip bgp summary']],
      ['config', ['interface Gi0/1', 'no shutdown']],
      ['blocked', ['show run ; reload']],
      ['read', ['show clock']]
    ])
    expect(classifySuggestions([['show running-config']], 'iosxe', { iosxe: ['show running-config'] })[0]).toMatchObject({ kind: 'blocked', reason: 'blocked by team policy ("show running-config")' })
    expect(classifySuggestions([['show version']], 'auto')[0]).toMatchObject({ kind: 'blocked' })
    // A group with a disruptive line is still one proposal, labelled disruptive (review P2).
    const shut = classifySuggestions([['interface Gi1/0/2', ' shutdown']], 'iosxe')[0]!
    expect(shut).toMatchObject({ kind: 'config', disruptive: true, reason: expect.stringMatching(/disruptive/) })
    expect(classifySuggestions([['interface Gi1/0/2', ' description x']], 'iosxe')[0]).not.toHaveProperty('disruptive')
  })

  it('a suggestion is taken once, expires, and a new answer replaces the tab\'s old ones', () => {
    let now = 0
    const st = new SuggestionStore(() => now)
    st.put('t1', [{ id: 'a', commands: ['show clock'], kind: 'read', reason: '' }])
    expect(st.take('a')).toMatchObject({ tabId: 't1' })
    expect(st.take('a')).toBeNull()
    st.put('t1', [{ id: 'b', commands: ['show clock'], kind: 'read', reason: '' }])
    st.put('t1', [{ id: 'c', commands: ['show clock'], kind: 'read', reason: '' }])
    expect(st.take('b')).toBeNull()
    now = SUGGESTION_TTL_MS + 1
    expect(st.take('c')).toBeNull()
  })
})

describe('Ollama v2 against the simulator', () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeIosDevice(), port: 0 })
  })
  afterAll(() => sim.close())

  const setup = async (o: { url: string }, model: string, extra: Partial<Settings> = {}) => {
    const { tab, client } = await fakeTab(sim.port)
    const audit = new AuditLog(openDb(':memory:'))
    const ctl = localControl(tab)
    const sent: string[] = []
    const term = { ...ctl, exec: (...a: Parameters<typeof ctl.exec>) => (sent.push(a[1]), ctl.exec(...a)) }
    const st = { aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, aiProvider: 'ollama', ollamaEndpoint: o.url, ollamaModel: model, egressLog: false, aiConfigured: true, aiRunTokenBudget: 200_000, ...extra } as Settings
    const settings = { get: () => st } as unknown as SettingsService
    const events: AgentEvent[] = []
    let waiter: ((e: AgentEvent) => void) | null = null
    const ai = new AiService(settings)
    const agent = new Agent({ term, settings, audit, provider: () => ai.provider(), emit: (e) => (events.push(e), e.type === 'done' && waiter?.(e)) })
    const run = (f: () => { runId: string }) =>
      new Promise<AgentEvent>((resolve) => {
        waiter = resolve
        f()
      })
    return { agent, audit, events, sent, run, client, st }
  }

  it('malformed tool calls are rejected back to the model with the reason, audited, and never run', async () => {
    const o = await fakeOllama({
      script: [
        { tools: [{ name: 'run_show_command', arguments: 'not json {' }] },
        { tools: [{ name: 'run_show_command', arguments: { command: 42, reason: 'x' } }] },
        { tools: [{ name: 'run_show_command', arguments: { command: 'show clock', reason: 'x', shell: 'bash' } }] },
        { tools: [{ name: 'rm -rf', arguments: {} }] },
        { text: 'Giving up.' }
      ]
    })
    const t = await setup(o, 'qwen3:8b')
    const done = await t.run(() => t.agent.start({ tabId: 'tab-1', prompt: 'what time is it?' }))
    expect(done).toMatchObject({ type: 'done' })
    expect((done as { error?: string }).error).toBeUndefined()
    expect(t.sent).toEqual([])
    const chats = o.requests.filter((q) => q.path === '/api/chat').map((q) => q.body as OllamaChatBody)
    const toolMsgs = chats.at(-1)!.messages!.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(toolMsgs).toEqual([
      expect.stringMatching(/^ERROR: REJECTED: malformed call to run_show_command: the arguments are not valid JSON\. Nothing was run/),
      expect.stringMatching(/^ERROR: REJECTED: invalid arguments: command.*expected string.*Nothing was run/),
      expect.stringMatching(/^ERROR: REJECTED: invalid arguments: .*shell.*Nothing was run/i),
      expect.stringMatching(/^ERROR: REJECTED: malformed call to invalid_tool_call: the tool name is not one of your tools/)
    ])
    expect(t.audit.list().map((r) => r.decision)).toEqual(['refused', 'refused', 'refused', 'refused'])
    t.client.end()
    await o.close()
  })

  it('suggest mode: no tools are sent, the answer becomes suggestions, a click runs one through the guard with the user as approver', async () => {
    const o = await fakeOllama({
      noTools: ['llama2:7b'],
      route: (b) => {
        const last = b.messages!.at(-1)!.content
        if (/BGP/.test(last)) return { text: 'Run these:\n```\nshow ip interface brief\nshow ip bgp summary\nwrite erase\n```\nand maybe\n```\ninterface Gi0/1\n no shutdown\n```' }
        return { text: 'Gi0/1 is up.' }
      }
    })
    const t = await setup(o, 'llama2:7b')
    await t.run(() => t.agent.start({ tabId: 'tab-1', prompt: 'Why is BGP down?' }))
    const first = o.requests.find((q) => q.path === '/api/chat')!.body as OllamaChatBody & { messages: { content: string }[] }
    expect(first).not.toHaveProperty('tools')
    expect(first.messages[0]!.content).toMatch(/you are in suggest mode/)
    expect(t.events.find((e) => e.type === 'mode')).toMatchObject({ suggest: true })
    const sug = t.events.find((e) => e.type === 'suggestions') as Extract<AgentEvent, { type: 'suggestions' }>
    expect(sug.items.map((i) => [i.kind, i.commands.join(' / ')])).toEqual([
      ['read', 'show ip interface brief'],
      ['read', 'show ip bgp summary'],
      ['blocked', 'write erase'],
      ['config', 'interface Gi0/1 / no shutdown']
    ])
    // Nothing ran on its own.
    expect(t.sent).toEqual([])

    // A forged id runs nothing; a blocked one runs nothing (audited as blocked).
    expect(() => t.agent.runSuggestion('forged')).toThrow(/no longer available/)
    await t.run(() => t.agent.runSuggestion(sug.items[2]!.id))
    expect(t.sent).toEqual([])
    expect(t.audit.list()[0]).toMatchObject({ command: 'write erase', decision: 'blocked' })

    await t.run(() => t.agent.runSuggestion(sug.items[0]!.id))
    expect(t.sent).toEqual(['show ip interface brief'])
    expect(t.audit.list()[0]).toMatchObject({ command: 'show ip interface brief', decision: 'executed', approver: userInfo().username, reason: 'approved by user' })
    expect(t.events.filter((e) => e.type === 'step' && e.status === 'ok')).toHaveLength(1)
    // Used once.
    expect(() => t.agent.runSuggestion(sug.items[0]!.id)).toThrow(/no longer available/)

    // Configuration lines: read-only mode refuses the proposal (nothing is sent).
    await t.run(() => t.agent.runSuggestion(sug.items[3]!.id))
    expect(t.sent).toEqual(['show ip interface brief'])
    expect(t.audit.list()[0]).toMatchObject({ decision: 'refused', reason: expect.stringMatching(/read-only/) })

    // The output is in the conversation for the next question.
    await t.run(() => t.agent.start({ tabId: 'tab-1', prompt: 'and now?' }))
    const next = JSON.stringify(o.requests.filter((q) => q.path === '/api/chat').at(-1)!.body)
    expect(next).toMatch(/the user ran your suggested `show ip interface brief`/)
    expect(next).toMatch(/GigabitEthernet/)
    // A new question drops the old suggestions.
    expect(() => t.agent.runSuggestion(sug.items[1]!.id)).toThrow(/no longer available/)
    t.client.end()
    await o.close()
  })

  it('configuration lines suggested with proposals on open a proposal card', async () => {
    const o = await fakeOllama({ noTools: ['llama2:7b'], script: [{ text: '```\ninterface Loopback9\n description hopline\n```' }] })
    const t = await setup(o, 'llama2:7b', { aiReadOnly: false })
    await t.run(() => t.agent.start({ tabId: 'tab-1', prompt: 'add a loopback' }))
    const sug = t.events.find((e) => e.type === 'suggestions') as Extract<AgentEvent, { type: 'suggestions' }>
    const p = new Promise<Extract<AgentEvent, { type: 'proposal' }>>((resolve) => {
      const i = setInterval(() => {
        const e = t.events.find((x) => x.type === 'proposal')
        if (e) (clearInterval(i), resolve(e as never))
      }, 10)
    })
    const finished = t.run(() => t.agent.runSuggestion(sug.items[0]!.id))
    const card = await p
    expect(card.commands).toEqual(['interface Loopback9', 'description hopline'])
    // The Proposals v2 card: the device safety net, no rollback plan or verify commands from the model.
    expect(card).toMatchObject({ net: { kind: 'archive' }, rollback: [], verify: [] })
    t.agent.decide(card.proposalId, false)
    await finished
    expect(t.sent).toEqual([])
    t.client.end()
    await o.close()
  })

  it('a suggested change approved runs under the device safety net and the user can roll it back', async () => {
    const o = await fakeOllama({ noTools: ['llama2:7b'], script: [{ text: '```\ninterface Loopback9\n description hopline-suggest\n```' }] })
    const t = await setup(o, 'llama2:7b', { aiReadOnly: false })
    await t.run(() => t.agent.start({ tabId: 'tab-1', prompt: 'add a loopback' }))
    const sug = t.events.find((e) => e.type === 'suggestions') as Extract<AgentEvent, { type: 'suggestions' }>
    const stop = setInterval(() => {
      const e = t.events.find((x) => x.type === 'proposal')
      if (e) (clearInterval(stop), t.agent.decide((e as Extract<AgentEvent, { type: 'proposal' }>).proposalId, true))
    }, 10)
    await t.run(() => t.agent.runSuggestion(sug.items[0]!.id))
    const change = t.events.filter((e) => e.type === 'change').at(-1) as Extract<AgentEvent, { type: 'change' }>
    expect(change).toMatchObject({ phase: 'awaiting', actions: ['confirm', 'rollback'], message: expect.stringMatching(/Suggest mode/) })
    expect(t.sent.slice(0, 3)).toEqual(['show archive', 'archive config', 'show archive'])
    await t.agent.changeAction(change.proposalId, 'rollback')
    expect(t.events.filter((e) => e.type === 'change').at(-1)).toMatchObject({ phase: 'rolled-back' })
    expect(t.sent.some((c) => /^configure replace \S+ force$/.test(c))).toBe(true)
    t.client.end()
    await o.close()
  })

  it('per-run budget: usage is reported, and a run that spends it stops with a clear error', async () => {
    const big = { tools: [{ name: 'run_show_command', arguments: { command: 'show running-config', reason: 'x' } }] }
    const o = await fakeOllama({ script: Array.from({ length: 40 }, () => big) })
    const t = await setup(o, 'qwen3:8b', { aiRunTokenBudget: 20_000 })
    const done = await t.run(() => t.agent.start({ tabId: 'tab-1', prompt: 'check config' }))
    const usage = t.events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[]
    expect(usage[0]).toMatchObject({ used: 0, budget: 20_000 })
    expect(usage.at(-1)!.used).toBeGreaterThan(0)
    expect((done as { error?: string }).error).toMatch(/token budget for this run is used up.*Settings › Assistant/)
    t.client.end()
    await o.close()
  })
})
