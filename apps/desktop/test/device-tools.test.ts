import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEventBody, Settings } from '@shared/types'
import { DeviceTools, MAX_TOOL_CHARS } from '../src/main/agent/device-tools'
import type { ChangeContext, ChangeProposer } from '../src/main/agent/proposals'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { TabControl } from '../src/main/host/client'
import { fakeTab, localControl } from './helpers'

/**
 * DeviceTools on its own: no Agent, no model. The seam a fleet worker uses (one instance per
 * background session), driven directly against the simulator.
 */

let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
afterAll(() => sim.close())

/** A proposer that records what DeviceTools hands it and changes nothing. */
function recordingProposer() {
  const calls: { what: 'config' | 'disruptive'; ctx: ChangeContext; args: unknown[] }[] = []
  const p: ChangeProposer = {
    proposeConfig: async (ctx, input) => (calls.push({ what: 'config', ctx, args: [input] }), { text: 'PROPOSED (stub)' }),
    proposeDisruptive: async (ctx, command, why, input) => (calls.push({ what: 'disruptive', ctx, args: [command, why, input] }), { text: 'DISRUPTIVE (stub)' })
  }
  return { p, calls }
}

async function tools(prefs: Partial<Settings> = {}, wrap?: (c: TabControl) => TabControl, session?: Parameters<typeof fakeTab>[2]) {
  const { tab, client } = await fakeTab(sim.port, 24, session)
  const audit = new AuditLog(openDb(':memory:'))
  const events: AgentEventBody[] = []
  const sent: string[] = []
  const base = localControl(tab)
  const counted: TabControl = { ...base, exec: (t, c, k, o) => (sent.push(c), base.exec(t, c, k, o)) }
  const term = wrap ? wrap(counted) : counted
  const settings = { get: () => ({ aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, ...prefs }) as Settings }
  const { p, calls } = recordingProposer()
  const dt = new DeviceTools(tab, { term, settings, audit, emit: (e) => events.push(e) }, p)
  const ctx = { runId: 'run-1', signal: new AbortController().signal }
  const show = (command: string, extra: Record<string, unknown> = {}) => dt.call('run_show_command', { command, reason: 'test', ...extra }, ctx)
  return { dt, show, ctx, audit, events, sent, calls, client, rows: () => audit.list().reverse() }
}

describe('DeviceTools against the simulator', () => {
  it('lists the device tools', async () => {
    const { dt, client } = await tools()
    expect(dt.specs.map((s) => s.name)).toEqual(['run_show_command', 'propose_config_change', 'report_verification'])
    client.end()
  })

  it('runs a read, redacts it before the model and the renderer see it, and audits it', async () => {
    const t = await tools()
    const bgp = await t.show('show ip bgp summary')
    expect(bgp.isError).toBeUndefined()
    expect(bgp.text).toMatch(/10\.0\.0\.2\s+4\s+65002/)

    const run = await t.show('show running-config')
    expect(run.text).toMatch(/snmp-server community <redacted> RO/)
    expect(run.text).not.toMatch(/n3tw0rkRO|pr1vRW|\$9\$/)
    const step = t.events.find((e) => e.type === 'step' && e.command === 'show running-config' && e.status === 'ok')
    expect(step).toBeDefined()
    expect(step!.type === 'step' && step!.preview).not.toMatch(/n3tw0rkRO|pr1vRW/)

    expect(t.rows().map((r) => [r.command, r.kind, r.decision, r.source])).toEqual([
      ['show ip bgp summary', 'read', 'executed', 'agent'],
      ['show running-config', 'read', 'executed', 'agent']
    ])
    expect(t.rows()[1]!.redactions).toBeGreaterThan(0)
    expect(t.events.every((e) => e.runId === 'run-1')).toBe(true)
    t.client.end()
  })

  it('blocks and refuses in main: nothing reaches the device, every attempt is audited', async () => {
    const t = await tools()
    expect((await t.show('reload')).text).toMatch(/^BLOCKED: "reload" is on the deny-list/)
    expect((await t.show('conf t')).text).toMatch(/^REFUSED: .*propose_config_change/)
    expect((await t.show('show version', { filter: { tail: -3 } })).text).toMatch(/^REFUSED: invalid filter/)
    expect(t.sent).toEqual([])
    expect(t.rows().map((r) => [r.command, r.decision])).toEqual([
      ['reload', 'blocked'],
      ['conf t', 'refused'],
      ['show version', 'refused']
    ])
    t.client.end()
  })

  it('default-denies a session whose platform is unknown', async () => {
    const t = await tools({}, undefined, { platform: 'unknown' as never })
    expect((await t.show('show version')).text).toMatch(/^BLOCKED: the device platform is unknown/)
    expect(t.sent).toEqual([])
    t.client.end()
  })

  it('filters the redacted output locally and sends the plain command', async () => {
    const t = await tools()
    const r = await t.show('show running-config', { filter: { grep: 'snmp-server community' } })
    expect(t.sent).toEqual(['show running-config'])
    expect(r.text).toMatch(/^\[Hopline filter /)
    expect(r.text).toMatch(/<redacted>/)
    expect(r.text).not.toMatch(/n3tw0rkRO/)
    expect(t.rows()[0]!.reason).toMatch(/local filter: grep/)
    t.client.end()
  })

  it('applies the command timeout and the output cap from settings', async () => {
    const slow = await tools({ commandTimeoutMs: 200 })
    const r = await slow.show('ping 192.0.2.1')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^TIMEOUT/)
    expect(slow.rows()[0]!.decision).toBe('timeout')
    slow.client.end()

    const small = await tools({ outputCapBytes: 256 })
    const c = await small.show('show running-config')
    expect(c.text).toMatch(/^CAPPED/)
    expect(small.rows()[0]!.decision).toBe('capped')
    small.client.end()
  })

  it('caps what goes to the model at MAX_TOOL_CHARS', async () => {
    const huge = 'x'.repeat(MAX_TOOL_CHARS + 500)
    const t = await tools({}, (c) => ({ ...c, exec: async () => ({ status: 'ok', output: huge, durationMs: 1, bytes: huge.length }) }))
    const r = await t.show('show version')
    expect(r.text.length).toBeLessThan(MAX_TOOL_CHARS + 260)
    expect(r.text).toMatch(/<\/device_output id="[0-9a-f]{12}">\n\[Hopline: output truncated: 500 more characters/)
    t.client.end()
  })

  it('adds TextFSM rows to a complete read', async () => {
    const t = await tools()
    const r = await t.show('show ip interface brief')
    expect(r.text).toMatch(/\[Hopline parsed this output with TextFSM template/)
    t.client.end()
  })

  it('audits an executor failure and answers ERROR instead of throwing', async () => {
    const t = await tools({}, (c) => ({ ...c, exec: async () => Promise.reject(new Error('host gone')) }))
    const r = await t.show('show version')
    expect(r).toEqual({ text: 'ERROR: host gone', isError: true })
    expect(t.rows().map((x) => [x.command, x.kind, x.decision, x.reason])).toEqual([['show version', 'unknown', 'error', 'host gone']])
    expect(t.events.at(-1)).toMatchObject({ type: 'step', status: 'error', command: 'show version' })
    t.client.end()
  })

  it('hands changes to the proposer: config proposals and disruptive exec commands', async () => {
    const t = await tools()
    expect((await t.dt.call('propose_config_change', { commands: ['interface Gi1/0/2', 'no shutdown'], rationale: 'x', rollback: ['interface Gi1/0/2', 'shutdown'], verify: [{ command: 'show interfaces status', expect: 'connected' }] }, t.ctx)).text).toBe('PROPOSED (stub)')
    // Proposals v2: rollback and verify are required, checked before the proposer sees the call.
    expect((await t.dt.call('propose_config_change', { commands: ['interface Gi1/0/2', 'no shutdown'], rationale: 'x' }, t.ctx)).text).toMatch(/^REJECTED: invalid arguments: rollback/)
    expect((await t.show('clear ip bgp *')).text).toBe('DISRUPTIVE (stub)')
    expect(t.calls.map((c) => c.what)).toEqual(['config', 'disruptive'])
    expect(t.calls[1]!.args.slice(0, 1)).toEqual(['clear ip bgp *'])
    expect(t.calls[0]!.ctx.tab.tabId).toBe('tab-1')
    expect(t.sent).toEqual([])
    t.client.end()
  })

  it('answers an unknown tool with an error', async () => {
    const t = await tools()
    expect(await t.dt.call('get_secrets', {}, t.ctx)).toEqual({ text: 'REFUSED: unknown tool get_secrets. Your tools are run_show_command, propose_config_change, report_verification.', isError: true })
    t.client.end()
  })
})
