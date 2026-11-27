import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'

/** F2: a question asked before any provider is connected is kept and sent once one is. */

const run = vi.fn(async () => ({ runId: 'run-1' }))
vi.stubGlobal('window', {
  hopline: { agent: { run, onEvent: () => () => {}, reset: async () => {}, cancel: async () => {}, decide: async () => {} } },
  addEventListener: () => {},
  removeEventListener: () => {}
})

const { useUi } = await import('../src/renderer/src/store')
const { useAi, wireAgentEvents } = await import('../src/renderer/src/features/ai/store')

const settings = (aiConfigured: boolean) => ({ aiConfigured, hasApiKey: aiConfigured }) as Settings

describe('AI question queue', () => {
  beforeEach(() => {
    run.mockClear()
    useUi.setState({ settings: settings(false), aiOpen: false })
    useAi.setState({ byTab: {} })
  })

  it('keeps the question, opens the panel, and sends it when a provider connects', async () => {
    wireAgentEvents()
    await useAi.getState().ask('t1', 'why is bgp down?')
    expect(run).not.toHaveBeenCalled()
    expect(useUi.getState().aiOpen).toBe(true)
    expect(useAi.getState().byTab['t1']!.waiting?.prompt).toBe('why is bgp down?')
    expect(useAi.getState().byTab['t1']!.entries).toMatchObject([{ kind: 'user', text: 'why is bgp down?' }])

    // Asking again before connecting: the last question wins, shown once.
    await useAi.getState().ask('t1', 'and ospf?')
    expect(useAi.getState().byTab['t1']!.entries).toMatchObject([{ kind: 'user', text: 'and ospf?' }])

    useUi.getState().setSettings(settings(true))
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ tabId: 't1', prompt: 'and ospf?', selection: undefined }))
    expect(run).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(useAi.getState().byTab['t1']!.runId).toBe('run-1'))
    expect(useAi.getState().byTab['t1']!.waiting).toBeUndefined()
    // The user entry is not duplicated when it is finally sent.
    expect(useAi.getState().byTab['t1']!.entries.filter((e) => e.kind === 'user')).toHaveLength(1)
  })

  it('with a provider, asks right away', async () => {
    useUi.setState({ settings: settings(true) })
    await useAi.getState().ask('t2', 'show me errors', 'sel')
    expect(run).toHaveBeenCalledWith({ tabId: 't2', prompt: 'show me errors', selection: 'sel' })
  })
})
