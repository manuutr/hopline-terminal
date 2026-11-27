import { describe, expect, it } from 'vitest'
import type { AgentEventBody } from '@shared/types'
import { AgentLoop, MAX_ITERATIONS, MAX_TOOL_CALLS_PER_TURN, type Conversation, type ToolSet } from '../src/main/agent/loop'
import type { ChatMessage, LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'

/**
 * AgentLoop on its own: a scripted provider and a stub tool set, no device, no guard. What the loop
 * guarantees for any tool set (a fleet worker's or the chat's).
 */

type Call = { name: string; input: unknown }
type Step = Call[] | 'throw' | 'refusal' | 'max_tokens_with_tool' | 'forever'

class Scripted implements LlmProvider {
  readonly id = 'scripted'
  seen: { system: string; messages: ChatMessage[] }[] = []
  constructor(private script: Step[]) {}
  async turn(req: TurnRequest): Promise<TurnResult> {
    this.seen.push({ system: req.system, messages: structuredClone(req.messages) })
    const step = this.script[0] === 'forever' ? 'forever' : this.script.shift()
    if (step === 'throw') throw new Error('network down')
    if (step === 'refusal') return { message: { role: 'assistant', parts: [] }, stop: 'refusal', detail: 'policy' }
    if (step === 'max_tokens_with_tool') return { message: { role: 'assistant', parts: [{ type: 'tool_call', id: 'cut', name: 'echo', input: {} }] }, stop: 'max_tokens' }
    if (step === 'forever') return { message: { role: 'assistant', parts: [{ type: 'tool_call', id: `f${this.seen.length}`, name: 'echo', input: { say: 'again' } }] }, stop: 'tool_use' }
    if (!step) {
      req.onText('Done.')
      req.onThinking('hmm')
      return { message: { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }, stop: 'end' }
    }
    return { message: { role: 'assistant', parts: step.map((c, i) => ({ type: 'tool_call' as const, id: `c${this.seen.length}_${i}`, name: c.name, input: c.input })) }, stop: 'tool_use' }
  }
  /** Tool results the loop sent with request n (0-based). */
  results(n: number): string[] {
    const last = this.seen[n]!.messages.at(-1)!
    return last.parts.flatMap((p) => (p.type === 'tool_result' ? [p.content] : []))
  }
}

/** A tool set that echoes `say` back, counts calls and can be told to throw. */
function echoTools(onCall?: () => void): ToolSet & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    specs: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }],
    async call(_name, input) {
      calls.push(input)
      onCall?.()
      if ((input as { boom?: boolean }).boom) throw new Error('kaboom')
      return { text: String((input as { say?: string }).say ?? '') }
    }
  }
}

function loop(script: Step[], opts: { tools?: ToolSet; conv?: Conversation; maxIterations?: number; maxToolCallsPerTurn?: number; system?: () => string } = {}) {
  const provider = new Scripted(script)
  const events: AgentEventBody[] = []
  const tools = opts.tools ?? echoTools()
  const conv = opts.conv ?? { messages: [] }
  const l = new AgentLoop(conv, { provider: async () => provider, system: opts.system ?? (() => 'sys'), tools, emit: (e) => events.push(e), maxIterations: opts.maxIterations, maxToolCallsPerTurn: opts.maxToolCallsPerTurn })
  return { l, provider, events, conv, tools }
}

const ctx = (signal = new AbortController().signal) => ({ runId: 'r1', signal })
const echo = (say: string, extra: Record<string, unknown> = {}): Call => ({ name: 'echo', input: { say, ...extra } })
const dones = (events: AgentEventBody[]) => events.filter((e) => e.type === 'done')

describe('AgentLoop (scripted provider, stub tools)', () => {
  it('runs tool calls, feeds results back, streams text and thinking, and ends with one done', async () => {
    const { l, provider, events, conv } = loop([[echo('one'), echo('two')]])
    const end = await l.run('question', ctx())
    expect(end).toEqual({ type: 'done', runId: 'r1' })
    expect(provider.results(1)).toEqual(['one', 'two'])
    expect(events.map((e) => e.type)).toEqual(['text', 'thinking', 'done'])
    expect(dones(events)).toHaveLength(1)
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(provider.seen[0]!.messages[0]!.parts).toEqual([{ type: 'text', text: 'question' }])
  })

  it('redacts what a tool returns before it reaches the provider', async () => {
    const { l, provider } = loop([[echo('snmp-server community s3cretRO RO')]])
    await l.run('q', ctx())
    expect(provider.results(1)).toEqual(['snmp-server community <redacted> RO'])
    // The model's own tool call (its output) is replayed as is; what came back from the tool is not.
    expect(JSON.stringify(provider.seen[1]!.messages.at(-1))).not.toContain('s3cretRO')
  })

  it('redacts the prompt and the system prompt too', async () => {
    const { l, provider } = loop([], { system: () => 'device: enable secret 5 $1$abcd$efghijklmnop' })
    await l.run('my config has enable secret 5 $1$abcd$efghijklmnop', ctx())
    expect(JSON.stringify(provider.seen)).not.toContain('$1$abcd$efghijklmnop')
  })

  it('rebuilds the system prompt every turn', async () => {
    let n = 0
    const { l, provider } = loop([[echo('a')], [echo('b')]], { system: () => `sys ${++n}` })
    await l.run('q', ctx())
    expect(provider.seen.map((s) => s.system)).toEqual(['sys 1', 'sys 2', 'sys 3'])
  })

  it(`stops after ${MAX_ITERATIONS} model turns by default, and at a custom budget`, async () => {
    const a = loop(['forever'])
    expect((await a.l.run('q', ctx())).error).toBe(`Stopped after ${MAX_ITERATIONS} steps.`)
    expect(a.provider.seen).toHaveLength(MAX_ITERATIONS)

    const b = loop(['forever'], { maxIterations: 3 })
    expect((await b.l.run('q', ctx())).error).toBe('Stopped after 3 steps.')
    expect(b.provider.seen).toHaveLength(3)
  })

  it(`answers at most ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn`, async () => {
    const tools = echoTools()
    const { l, provider } = loop([Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 2 }, (_, i) => echo(`n${i}`))], { tools })
    await l.run('q', ctx())
    expect(tools.calls).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
    const res = provider.results(1)
    expect(res).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 2)
    expect(res.slice(-2).every((t) => t.startsWith(`REFUSED: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls`))).toBe(true)

    const small = loop([[echo('a'), echo('b')]], { maxToolCallsPerTurn: 1 })
    await small.l.run('q', ctx())
    expect(small.provider.results(1)[1]).toMatch(/^REFUSED: at most 1 tool calls/)
  })

  it('cancel: the remaining tools of the turn are not run and the run ends with an error', async () => {
    const ac = new AbortController()
    const tools = echoTools(() => ac.abort())
    const { l, events, conv } = loop([[echo('a'), echo('b')], [echo('c')]], { tools })
    const end = await l.run('q', ctx(ac.signal))
    expect(tools.calls).toEqual([{ say: 'a' }])
    expect(end.error).toMatch(/Cancelled/)
    expect(dones(events)).toHaveLength(1)
    // The answered tool turn stays; the history still alternates and ends with the results.
    expect(conv.messages.at(-1)!.parts.map((p) => (p.type === 'tool_result' ? p.content : p.type))).toEqual(['a', 'Cancelled by the user before this tool ran.'])
  })

  it('a tool set that throws ends the run (no further tools or turns) and keeps the history valid', async () => {
    const tools = echoTools()
    const { l, provider, events, conv } = loop([[echo('x', { boom: true }), echo('y')], [echo('z')]], { tools })
    const end = await l.run('q', ctx())
    expect(end.error).toBe('kaboom')
    expect(tools.calls).toEqual([{ say: 'x', boom: true }])
    expect(provider.seen).toHaveLength(1)
    expect(dones(events)).toHaveLength(1)
    expect(conv.messages).toEqual([])
  })

  it('a refusal ends the run with the reason; the history still alternates', async () => {
    const { l, conv } = loop(['refusal'])
    expect((await l.run('q', ctx())).error).toBe('The model declined: policy')
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('a cut-off turn with a dangling tool call is repaired, so the next run is valid', async () => {
    const conv: Conversation = { messages: [] }
    const first = loop(['max_tokens_with_tool'], { conv })
    expect((await first.l.run('first', ctx())).error).toMatch(/cut off/)
    expect(conv.messages).toEqual([])

    const second = loop([], { conv })
    await second.l.run('second', ctx())
    expect(second.provider.seen[0]!.messages).toEqual([{ role: 'user', parts: [{ type: 'text', text: 'second' }] }])
  })

  it('a provider error (or a provider that cannot be built) ends with done and keeps the history valid', async () => {
    const conv: Conversation = { messages: [] }
    const a = loop(['throw'], { conv })
    expect((await a.l.run('q', ctx())).error).toBe('network down')
    expect(conv.messages).toEqual([])

    const events: AgentEventBody[] = []
    const b = new AgentLoop(conv, { provider: () => Promise.reject(new Error('Add your Anthropic API key in Settings to use the assistant.')), system: () => 's', tools: echoTools(), emit: (e) => events.push(e) })
    expect((await b.run('q', ctx())).error).toMatch(/API key/)
    expect(dones(events)).toHaveLength(1)
    expect(conv.messages).toEqual([])
  })

  it('keeps the conversation across runs when the same object is passed', async () => {
    const conv: Conversation = { messages: [] }
    await loop([], { conv }).l.run('one', ctx())
    const second = loop([], { conv })
    await second.l.run('two', ctx())
    expect(second.provider.seen[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })
})
