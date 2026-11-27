import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { POLICY_INVALID_RULE } from '@shared/policy-deny'
import { policyRefusal } from '../src/session-host/guard-check'
import { agentHandlers } from '../src/main/ipc/agent'

vi.mock('electron', () => ({ MessageChannelMain: class {}, utilityProcess: {}, app: {}, BrowserWindow: {}, dialog: {}, ipcMain: {} }))

/** Phase 5 safety review L8 (auto-detect probe and the policy) and L9 (agent IPC ownership). */

describe('the auto-detect probe honours the team policy (L8)', () => {
  const tab = { tabId: 't1', session: { id: 's1', name: 'x', host: 'h', platform: 'auto' } } as never

  it('main refuses a probe a platform rule or an "all" rule blocks, before signing', async () => {
    const { SessionHostClient } = await import('../src/main/host/client')
    const c = new SessionHostClient({} as never, { get: () => ({}) } as never, {} as never)
    c.policyRules = { iosxe: ['show version'] }
    const r = await c.probe(tab, 'show version', ['ios', 'iosxe'], { timeoutMs: 1000, capBytes: 1000 })
    expect(r).toMatchObject({ status: 'error', error: expect.stringMatching(/blocked by team policy \("show version"\)/) })
    c.policyRules = { all: [POLICY_INVALID_RULE] }
    expect(await c.probe(tab, 'show version', ['junos'], { timeoutMs: 1000, capBytes: 1000 })).toMatchObject({ status: 'error', error: expect.stringMatching(/policy file is invalid/) })
  })

  it('the session host checks the probe against every platform it was signed for', () => {
    expect(policyRefusal({ nxos: ['show version'] }, 'auto', 'show version', ['ios', 'nxos'])).toMatch(/refused by session host: blocked by team policy/)
    expect(policyRefusal({ nxos: ['show version'] }, 'auto', 'show version', ['ios'])).toBeNull()
    expect(policyRefusal({}, 'auto', 'show version', ['ios'])).toBeNull()
  })
})

describe('agent IPC handlers check the window owns the tab (L9)', () => {
  const mine = { id: 'w1' }
  const other = { id: 'w2' }
  const ev = (sender: object) => ({ sender }) as unknown as IpcMainInvokeEvent
  const calls: string[] = []
  const agent = {
    start: () => (calls.push('start'), { runId: 'r1' }),
    cancel: () => void calls.push('cancel'),
    decide: () => void calls.push('decide'),
    reset: () => void calls.push('reset'),
    changeAction: async () => void calls.push('change'),
    runSuggestion: () => (calls.push('suggestion'), { runId: 'r2' }),
    tabOf: (kind: string, id: string) => ({ run: { r1: 'tab-1' }, proposal: { p1: 'tab-1' }, suggestion: { s1: 'tab-1' } })[kind as 'run']?.[id as 'r1']
  }
  const handlers = agentHandlers(agent as never, (tabId, sender) => tabId === 'tab-1' && sender === mine)
  const call = (ch: string, arg: unknown, sender: object) => (handlers[ch]!.fn as (a: unknown, e: IpcMainInvokeEvent) => unknown)(handlers[ch]!.schema.parse(arg), ev(sender))

  const requests: [string, unknown][] = [
    ['agent:run', { tabId: 'tab-1', prompt: 'hi' }],
    ['agent:cancel', 'r1'],
    ['agent:decide', { proposalId: 'p1', approve: true }],
    ['agent:change', { proposalId: 'p1', action: 'confirm' }],
    ['agent:runSuggestion', 's1']
  ]
  for (const [ch, arg] of requests)
    it(`${ch} from another window is refused; from the owner it runs`, async () => {
      calls.length = 0
      expect(() => call(ch, arg, other)).toThrow(/not open in this window/)
      expect(calls).toEqual([])
      await call(ch, arg, mine)
      expect(calls).toHaveLength(1)
    })

  it('agent:reset from another window does nothing', () => {
    calls.length = 0
    call('agent:reset', 'tab-1', other)
    expect(calls).toEqual([])
    call('agent:reset', 'tab-1', mine)
    expect(calls).toEqual(['reset'])
  })
})
