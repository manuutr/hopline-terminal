import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDevice, makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { PlatformId } from '@hopline/cli-model'
import type { AuditRow } from '@shared/types'
import { commandError } from '@shared/cli'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { analyze, GuardedRunner } from '../src/main/productivity/runner'
import { rerunBlock } from '../src/main/blocks/rerun'
import { detectPrompt, execute } from '../src/session-host/executor'
import { fakeTab, localControl } from './helpers'

/**
 * Phase 4 safety review: M1 (mode changes as one exec line), M2 (configuration lines at the exec
 * prompt, device errors reported as ok) and M3a (reads bound to the previewed hostname).
 */

const settings = { get: () => ({ commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) } as never

describe('M1: a single line that changes the mode is never an exec command', () => {
  const cases: [PlatformId, string][] = [
    ['ios', 'configure terminal'],
    ['ios', 'conf t'],
    ['ios', 'enable'],
    ['ios', 'en'],
    ['ios', 'disable'],
    ['ios', 'disa'],
    ['ios', 'exit'],
    ['ios', 'logout'],
    ['iosxe', 'configure terminal'],
    ['nxos', 'configure terminal'],
    ['eos', 'enable'],
    ['eos', 'disable'],
    ['asa', 'disable'],
    ['junos', 'configure'],
    ['junos', 'edit'],
    ['junos', 'exit'],
    ['junos', 'quit'],
    ['vrp', 'system-view'],
    ['vrp', 'sys'],
    ['vrp', 'quit'],
    ['vrp', 'q'],
    ['vrp', 'return'],
    ['vrp', 'ret'],
    ['panos', 'configure'],
    ['panos', 'exit'],
    ['fortios', 'config system interface'],
    ['aireos', 'logout'],
    ['ftd', 'exit']
  ]
  it.each(cases)('%s: "%s" is refused, not exec', (platform, line) => {
    const a = analyze(platform, [line])
    expect(a.shape).not.toBe('exec')
    expect(a.kind === 'refused' || a.kind === 'blocked').toBe(true)
  })
  it('real exec commands keep the exec shape', () => {
    expect(analyze('ios', ['clear counters'])).toMatchObject({ kind: 'config', shape: 'exec' })
    expect(analyze('nxos', ['clear counters'])).toMatchObject({ shape: 'exec' })
    expect(analyze('eos', ['clear counters'])).toMatchObject({ shape: 'exec' })
    expect(analyze('junos', ['clear interfaces statistics all'])).toMatchObject({ shape: 'exec' })
    expect(analyze('junos', ['set cli screen-length 0'])).toMatchObject({ shape: 'exec' })
    expect(analyze('vrp', ['reset counters interface'])).toMatchObject({ shape: 'exec' })
    expect(analyze('asa', ['clear xlate'])).toMatchObject({ kind: 'disruptive', shape: 'exec' })
    expect(analyze('aireos', ['config sysname wlc2'])).toMatchObject({ shape: 'exec' })
  })
})

describe('M2: configuration lines go through the configuration session', () => {
  it('Junos set / EOS no / PAN-OS set are configuration, with the disruptive check', () => {
    expect(analyze('junos', ['set interfaces ge-0/0/0 disable'])).toMatchObject({ kind: 'disruptive', shape: 'config', wrapper: { before: ['configure private'] } })
    expect(analyze('junos', ['set system host-name x'])).toMatchObject({ kind: 'config', shape: 'config' })
    expect(analyze('eos', ['no ip routing'])).toMatchObject({ kind: 'disruptive', shape: 'config', wrapper: { before: ['configure terminal'], after: ['end'] } })
    expect(analyze('panos', ['set deviceconfig system hostname x'], { user: 'admin' })).toMatchObject({ shape: 'config', wrapper: { before: expect.arrayContaining(['configure']) } })
    // The one-line and the two-line Junos change now get the same verdict.
    expect(analyze('junos', ['set interfaces ge-0/0/0 disable']).kind).toBe(analyze('junos', ['set interfaces ge-0/0/0 description x', 'set interfaces ge-0/0/0 disable']).kind)
    // Send-to-many still refuses the disruptive one.
    expect(analyze('junos', ['set interfaces ge-0/0/0 disable'], { multi: true })).toMatchObject({ kind: 'refused' })
  })
  it('authorization errors are device errors (review Low 8)', () => {
    expect(commandError('ios', 'Command authorization failed.')).toMatch(/authorization failed/)
    expect(commandError('iosxe', '% Authorization failed.')).toMatch(/Authorization failed/)
    expect(commandError('iosxr', '% Permission denied')).toMatch(/Permission denied/)
    expect(commandError('nxos', '% Permission denied for the role')).toMatch(/Permission denied/)
    expect(commandError('asa', 'Command authorization failed')).toMatch(/authorization failed/)
    expect(commandError('eos', '% Authorization denied for command \'show run\'')).toMatch(/Authorization denied/)
    expect(commandError('aireos', 'Incorrect usage: invalid interface')).toMatch(/Incorrect usage/)
    expect(commandError('junos', 'error: permission denied')).toMatch(/permission denied/)
  })
  it('commandError reads the head of the output only', () => {
    expect(commandError('ios', "        ^\n% Invalid input detected at '^' marker.")).toMatch(/Invalid input/)
    expect(commandError('junos', 'syntax error.')).toMatch(/syntax error/)
    const longLog = Array.from({ length: 40 }, (_, i) => `Nov 25 10:${String(i).padStart(2, '0')}: %LINK-3-UPDOWN: Interface Gi1/0/${i}, changed state to up`).join('\n')
    expect(commandError('ios', `${longLog}\n% Invalid input detected at '^' marker.`)).toBeNull()
  })
})

describe('against the IOS simulator', { timeout: 30_000 }, () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeIosDevice(), port: 0 })
  })
  afterAll(() => sim.close())

  async function setup() {
    const { tab, client, raw } = await fakeTab(sim.port)
    const audit = new AuditLog(openDb(':memory:'))
    const term = localControl(tab)
    const runner = new GuardedRunner({ term, settings, audit })
    const rows = () => audit.list(100).reverse() as AuditRow[]
    return { tab, raw, client, runner, rows, term }
  }

  it('M1: "configure terminal" and "enable" are refused, nothing is typed and IOS stays at the exec prompt', async () => {
    const t = await setup()
    try {
      for (const line of ['configure terminal', 'conf t', 'enable', 'disable', 'exit']) {
        const a = analyze('iosxe', [line])
        const r = await t.runner.run('tab-1', a, { source: 'snippet', approved: true, hostname: 'core-sw1' })
        expect(r.status).toBe('refused')
      }
      expect(detectPrompt(t.tab.tail, 'iosxe').mode).toBe('exec')
      expect(t.rows().every((x) => x.decision === 'refused')).toBe(true)
      expect(t.rows().some((x) => x.decision === 'executed')).toBe(false)
    } finally {
      t.client.end()
    }
  })

  it('M2: a read the device rejects is failed (not ok) and audited as an error', async () => {
    const t = await setup()
    try {
      // Simulate the lost first character: the device sees "how version".
      const a = analyze('iosxe', ['show version'])
      const fake = { ...t.term, exec: (tab: never, _c: string, kind: never, opts: never) => t.term.exec(tab, 'how version' as never, kind, opts) }
      const runner = new GuardedRunner({ term: fake as never, settings, audit: (t.runner as unknown as { d: { audit: AuditLog } }).d.audit })
      const r = await runner.run('tab-1', a, { source: 'snippet', approved: true })
      expect(r.status).toBe('error')
      expect(r.reason).toMatch(/device reported an error/)
      expect(t.rows().at(-1)).toMatchObject({ command: 'show version', decision: 'error' })
    } finally {
      t.client.end()
    }
  })

  it('M3a: a read is refused when the prompt shows another device than the preview', async () => {
    const t = await setup()
    try {
      const a = analyze('iosxe', ['show version'])
      const r = await t.runner.run('tab-1', a, { source: 'multi', approved: true, hostname: 'other-sw' })
      expect(r).toMatchObject({ status: 'refused', reason: expect.stringMatching(/device changed since the preview/) })
      expect(t.rows()).toMatchObject([{ command: 'show version', decision: 'refused' }])
      const ok = await t.runner.run('tab-1', a, { source: 'multi', approved: true, hostname: 'core-sw1' })
      expect(ok.status).toBe('ok')
    } finally {
      t.client.end()
    }
  })
})

describe('against the Junos simulator', { timeout: 30_000 }, () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeDevice('junos'), port: 0 })
  })
  afterAll(() => sim.close())

  it('M2: one "set system host-name" line runs inside configure private … commit and-quit, not at the exec prompt', async () => {
    const { tab, client } = await fakeTab(sim.port, 1000, { platform: 'junos' })
    for (let i = 0; i < 300 && detectPrompt(tab.tail, 'junos').mode === 'unknown'; i++) await new Promise((r) => setTimeout(r, 10))
    try {
      const audit = new AuditLog(openDb(':memory:'))
      const runner = new GuardedRunner({ term: localControl(tab), settings, audit })
      const p = detectPrompt(tab.tail, 'junos')
      const first = await runner.analyze('tab-1', ['set system location building b9'])
      expect(first!.analysis).toMatchObject({ shape: 'config' })
      const r = await runner.run('tab-1', first!.analysis, { source: 'snippet', approved: true, hostname: p.hostname })
      expect(r.status).toBe('ok')
      const executed = (audit.list(100).reverse() as AuditRow[]).filter((x) => x.decision === 'executed').map((x) => x.command)
      expect(executed).toEqual(['configure private', 'set system location building b9', 'commit and-quit'])
      const shown = await execute(tab, 'junos', 'show configuration system', { timeoutMs: 5000, capBytes: 256 * 1024 })
      expect(shown.output).toMatch(/building b9/)
      expect(detectPrompt(tab.tail, 'junos').mode).toBe('exec')
    } finally {
      client.end()
    }
  })
})

describe('M2/M8: a re-run block the device rejects is failed', () => {
  it('maps % Invalid input to error and audits it so', async () => {
    const audit = new AuditLog(openDb(':memory:'))
    const tab = { tabId: 't', session: { id: 's', name: 'r1', host: 'h', platform: 'iosxe' } }
    const term = {
      get: () => tab,
      prompt: async () => ({ mode: 'exec' as const, prompt: 'r1#', hostname: 'r1' }),
      exec: async () => ({ status: 'ok' as const, output: "how version\n    ^\n% Invalid input detected at '^' marker.", durationMs: 1, bytes: 10 })
    }
    const r = await rerunBlock({ term: term as never, audit, settings }, 't', 'show version')
    expect(r).toMatchObject({ action: 'ran', status: 'error', error: expect.stringMatching(/Invalid input/) })
    expect(audit.list()[0]).toMatchObject({ decision: 'error' })
  })
})
