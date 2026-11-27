import { describe, expect, it } from 'vitest'
import { foldedSteps, waitingForDecision } from '../src/renderer/src/features/ai/fold'
import type { Entry } from '../src/renderer/src/features/ai/store'

const card = (over: Partial<Extract<Entry, { kind: 'proposal' }>> = {}): Entry => ({
  kind: 'proposal',
  id: 'p1',
  commands: ['interface Gi1/0/2', ' description AUDIT-1'],
  rationale: '',
  wrapper: { before: ['configure terminal'], after: ['end'] },
  verify: [{ command: 'show running-config interface Gi1/0/2', expect: 'description AUDIT-1' }],
  state: 'approved',
  ...over
})
const step = (id: string, command: string, status: Extract<Entry, { kind: 'step' }>['status'] = 'ok'): Entry => ({ kind: 'step', id, command, status, cmdKind: 'config' })

describe('the assistant transcript around a proposal card (review P2)', () => {
  it("an approved card's applied, wrapper and verify lines are not repeated as step rows", () => {
    const entries: Entry[] = [
      { kind: 'user', id: 'u', text: 'set it' },
      card(),
      step('s1', 'configure terminal'),
      step('s2', 'interface Gi1/0/2'),
      step('s3', 'description AUDIT-1'),
      step('s4', 'end'),
      step('s5', 'show running-config interface Gi1/0/2'),
      step('s6', 'show clock')
    ]
    expect([...foldedSteps(entries)]).toEqual(['s1', 's2', 's3', 's4', 's5'])
  })

  it('a failed or blocked line, a pending card and a later question keep their rows', () => {
    expect(foldedSteps([card(), step('s1', 'interface Gi1/0/2', 'error')]).size).toBe(0)
    expect(foldedSteps([card({ state: 'pending' }), step('s1', 'interface Gi1/0/2')]).size).toBe(0)
    expect(foldedSteps([card(), { kind: 'user', id: 'u2', text: 'again' }, step('s1', 'interface Gi1/0/2')]).size).toBe(0)
  })

  it('a card waiting for the user is not "thinking"', () => {
    expect(waitingForDecision([card({ state: 'pending' })])).toBe(true)
    expect(waitingForDecision([card({ change: { phase: 'awaiting', actions: ['confirm', 'rollback'] } as never }), step('s1', 'end')])).toBe(true)
    expect(waitingForDecision([card({ change: { phase: 'confirmed' } as never })])).toBe(false)
    expect(waitingForDecision([card({ state: 'pending' }), { kind: 'assistant', id: 'a', text: 'x', thinking: '' }])).toBe(false)
  })
})
