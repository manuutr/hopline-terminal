import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'
import { normalizeEndpoint } from '@shared/ollama'
import { AiPrefix } from '../src/renderer/src/lib/aiprefix'
import { reconcileLine } from '../src/renderer/src/lib/autocomplete'
import { parseArgs, readChunk } from '../src/main/llm/ollama'
import { ExternalUrl, linkHandlers } from '../src/main/ipc/links'

/** Second review, renderer side: R2-H2 (stale proposal cards), R2-M1 (agentBusy), R2-M2, Low 3/4. */

const decide = vi.fn(async (_id: string, _approve: boolean, _ack?: string) => {})
const openLink = vi.fn(async (_url: string) => {})
vi.stubGlobal('window', {
  hopline: { agent: { run: async () => ({ runId: 'r1' }), onEvent: () => () => {}, reset: async () => {}, cancel: async () => {}, decide }, links: { open: openLink } },
  addEventListener: () => {},
  removeEventListener: () => {}
})

const { useUi } = await import('../src/renderer/src/store')
const { useAi, NO_LONGER_OPEN } = await import('../src/renderer/src/features/ai/store')
const { openTerminalLink, isLinkClick } = await import('../src/renderer/src/lib/links')

const tabId = 't1'
const ev = (e: { type: AgentEvent['type']; runId: string; [k: string]: unknown }) => useAi.getState().apply({ ...e, tabId } as AgentEvent)
const proposal = (id: string) => ev({ type: 'proposal', runId: 'r1', proposalId: id, commands: ['hostname x'], rationale: '' } as never)
const card = (id: string) => useAi.getState().byTab[tabId]!.entries.find((e) => e.kind === 'proposal' && e.id === id) as Extract<ReturnType<typeof useAi.getState>['byTab'][string]['entries'][number], { kind: 'proposal' }>
const busy = () => useUi.getState().tabs.find((t) => t.tabId === tabId)?.agentBusy

describe('R2-H2: a proposal main closed is no longer offered for a decision', () => {
  beforeEach(() => {
    decide.mockReset()
    useAi.setState({ byTab: {} })
    useUi.setState({ tabs: [{ tabId, sessionId: 's1', title: 'r1', state: 'connected' }] })
  })

  it('proposal-closed (timeout/cancelled) marks the card expired with the reason; decided leaves it to the click', () => {
    proposal('p1')
    proposal('p2')
    proposal('p3')
    ev({ type: 'proposal-closed', runId: 'r1', proposalId: 'p1', reason: 'timeout' })
    ev({ type: 'proposal-closed', runId: 'r1', proposalId: 'p2', reason: 'cancelled' })
    ev({ type: 'proposal-closed', runId: 'r1', proposalId: 'p3', reason: 'decided' })
    expect(card('p1')).toMatchObject({ state: 'expired', closed: expect.stringMatching(/timed out/) })
    expect(card('p2')).toMatchObject({ state: 'expired', closed: expect.stringMatching(/cancelled/) })
    expect(card('p3').state).toBe('pending')
  })

  it('done expires every still-pending card of the run, so the glyph and close warning stop counting it', () => {
    proposal('p1')
    ev({ type: 'done', runId: 'r1' })
    expect(card('p1').state).toBe('expired')
    expect(useAi.getState().byTab[tabId]!.entries.some((e) => e.kind === 'proposal' && e.state === 'pending')).toBe(false)
  })

  it('Approve on a proposal main no longer has: shown as no longer open, never as approved', async () => {
    proposal('p1')
    decide.mockRejectedValueOnce(new Error(`Error invoking remote method 'agent:decide': Error: ${NO_LONGER_OPEN}`))
    await useAi.getState().decide(tabId, 'p1', true)
    expect(card('p1')).toMatchObject({ state: 'expired', closed: expect.stringContaining(NO_LONGER_OPEN) })
  })

  it('other refusals (a wrong hostname) still surface and keep the card pending', async () => {
    proposal('p1')
    decide.mockRejectedValueOnce(new Error('Type the device hostname "r1" to approve this disruptive change'))
    await expect(useAi.getState().decide(tabId, 'p1', true, 'r2')).rejects.toThrow(/hostname/)
    expect(card('p1').state).toBe('pending')
  })

  it('a decision never overwrites an expired card', async () => {
    proposal('p1')
    ev({ type: 'proposal-closed', runId: 'r1', proposalId: 'p1', reason: 'timeout' })
    await useAi.getState().decide(tabId, 'p1', true)
    expect(card('p1').state).toBe('expired')
  })
})

describe('R2-M1: agentBusy follows the agent, and a fresh prompt resets the typed line', () => {
  beforeEach(() => {
    useAi.setState({ byTab: {} })
    useUi.setState({ tabs: [{ tabId, sessionId: 's1', title: 'r1', state: 'connected' }] })
  })

  it('step and proposal set agentBusy; done clears it', () => {
    expect(busy()).toBeFalsy()
    ev({ type: 'step', runId: 'r1', stepId: 's', command: 'show clock', status: 'running', kind: 'read' } as never)
    expect(busy()).toBe(true)
    ev({ type: 'done', runId: 'r1' })
    expect(busy()).toBe(false)
    proposal('p1')
    expect(busy()).toBe(true)
    ev({ type: 'done', runId: 'r1' })
    expect(busy()).toBe(false)
  })

  it('reconcileLine: a bare prompt resets a line adopted from the agent\'s echo; echo in flight is kept', () => {
    expect(reconcileLine('show version', '', false)).toBe('')
    expect(reconcileLine(null, '', false)).toBe('')
    expect(reconcileLine('sh', 's', false)).toBeUndefined()
    expect(reconcileLine('show', 'show ver', false)).toBe('show ver')
    expect(reconcileLine('show version', '', true)).toBeUndefined()
    expect(reconcileLine('', '', false)).toBeUndefined()
    expect(reconcileLine(null, 'show version', false)).toBe('show version')
    expect(reconcileLine('', 'sh', false)).toBe('sh')
  })

  it('"@ai" typed after a run (stale line reset by the prompt) goes to the assistant, not the device', () => {
    const p = new AiPrefix((s) => s)
    // During the run the screen showed the agent's command after the prompt and the line adopted it.
    p.line = 'show clock'
    const next = reconcileLine(p.line, '', !!busy())
    if (next !== undefined) p.line = next
    let send = ''
    const ask: string[] = []
    for (const k of '@ai why\r') {
      const o = p.input(k, true)
      send += o.send
      ask.push(...o.ask)
    }
    expect(send).toBe('')
    expect(ask).toEqual(['why'])
  })
})

describe('R2-M2: malformed Ollama tool calls and chunks', () => {
  it('parseArgs keeps plain objects only', () => {
    expect(parseArgs({ command: 'show clock' })).toEqual({ input: { command: 'show clock' } })
    expect(parseArgs('{"command":"show clock"}')).toEqual({ input: { command: 'show clock' } })
    expect(parseArgs(null)).toEqual({ input: {} })
    // Ollama v2: a malformed call is kept, flagged, with {} as its input (it replays as an object).
    for (const bad of [['show clock'], 42, 'x', '[1,2]', '"str"', true]) expect(parseArgs(bad)).toEqual({ input: {}, invalid: expect.stringMatching(/not (valid JSON|a JSON object)/) })
  })

  it('keeps unusable tool calls as invalid ones (answered with an error, never run)', () => {
    const c = readChunk({
      message: {
        content: '',
        tool_calls: [
          { function: { name: 42, arguments: {} } },
          { function: { name: '', arguments: {} } },
          { function: { arguments: {} } },
          null,
          'x',
          { function: { name: 'run_show_command', arguments: ['show clock'] } }
        ]
      }
    })
    expect(c.calls).toEqual([
      { name: 'invalid_tool_call', input: {}, invalid: 'the call has no tool name' },
      { name: 'invalid_tool_call', input: {}, invalid: 'the tool name is not one of your tools' },
      { name: 'invalid_tool_call', input: {}, invalid: 'the call has no tool name' },
      { name: 'invalid_tool_call', input: {}, invalid: 'the call has no tool name' },
      { name: 'invalid_tool_call', input: {}, invalid: 'the call has no tool name' },
      { name: 'run_show_command', input: {}, invalid: 'the arguments are not a JSON object' }
    ])
  })

  it('every malformed chunk is an OllamaError with fixed text', () => {
    for (const bad of [null, 3, 'line', [], { message: 'hi' }, { message: { tool_calls: { function: { name: 'x' } } } }, { message: { content: { a: 1 } } }, { message: { thinking: 5 } }, { error: { secret: 'body' } }]) {
      let err: unknown
      try {
        readChunk(bad)
      } catch (e) {
        err = e
      }
      expect((err as Error)?.name, JSON.stringify(bad)).toBe('OllamaError')
      expect((err as Error).message).not.toMatch(/secret|body/)
    }
    expect(readChunk({ message: { content: 'ok', thinking: 'hm' }, done: true, done_reason: 'stop' })).toMatchObject({ content: 'ok', thinking: 'hm', done: true, doneReason: 'stop' })
  })
})

describe('Low 3: an endpoint typed without a scheme', () => {
  it('gets http:// added; full URLs are kept', () => {
    expect(normalizeEndpoint(' localhost:11434 ')).toBe('http://localhost:11434')
    expect(normalizeEndpoint('gpu-box:11434')).toBe('http://gpu-box:11434')
    expect(normalizeEndpoint('https://ai.example:443')).toBe('https://ai.example:443')
    expect(normalizeEndpoint('')).toBe('')
  })
})

describe('Low 4: links from terminal output', () => {
  beforeEach(() => openLink.mockReset())

  it('ask in-app first, then open; declined or non-http links never open', async () => {
    const yes = vi.fn(async () => true)
    expect(await openTerminalLink('https://example.com/a', yes)).toBe(true)
    expect(yes).toHaveBeenCalledWith('Open this link?', expect.any(String), 'Open link', expect.objectContaining({ preview: 'https://example.com/a' }))
    expect(openLink).toHaveBeenCalledWith('https://example.com/a')
    openLink.mockReset()
    expect(await openTerminalLink('https://example.com/b', async () => false)).toBe(false)
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ssh://x', 'http://user:pw@x/', 'not a url']) expect(await openTerminalLink(bad, yes)).toBe(false)
    expect(openLink).not.toHaveBeenCalled()
  })

  it('plain URLs need Ctrl/Cmd+click', () => {
    expect(isLinkClick({ ctrlKey: false, metaKey: false })).toBe(false)
    expect(isLinkClick({ ctrlKey: true, metaKey: false })).toBe(true)
    expect(isLinkClick({ ctrlKey: false, metaKey: true })).toBe(true)
  })

  it('main opens only http(s) without credentials', async () => {
    const opened: string[] = []
    const asked: string[] = []
    let yes = true
    const h = linkHandlers(async (_m, url) => (asked.push(url), yes), async (u) => void opened.push(u))['links:open']!
    const call = (u: unknown) => (h.fn as (a: unknown) => unknown)(h.schema.parse(u))
    await call('https://example.com/x')
    expect(opened).toEqual(['https://example.com/x'])
    // P8 M4: main asks natively first, showing the normalized URL; Cancel opens nothing.
    yes = false
    expect(await call('https:\\\\evil.com')).toBe(false)
    expect(asked).toEqual(['https://example.com/x', 'https://evil.com/'])
    expect(opened).toEqual(['https://example.com/x'])
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'http://u:p@x/', 'smb://x/y', 42]) expect(() => ExternalUrl.parse(bad)).toThrow()
  })
})
