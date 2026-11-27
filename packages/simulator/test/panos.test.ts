import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'
import { buildLab } from '../src/topology.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

function rig(rows = 1000, d: Device = makeDevice('panos', T0)) {
  const clock = new ManualClock(T0)
  setClock(d, clock)
  let out = ''
  let closed = false
  const sh = new Shell(d, { write: (s) => (out += s), close: () => (closed = true) }, rows, { user: 'admin', from: '10.10.10.50' })
  sh.start()
  const clean = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '')
  return {
    d,
    clock,
    closed: () => closed,
    async send(keys: string): Promise<string> {
      out = ''
      sh.input(keys)
      await sh.idle()
      await new Promise((r) => setTimeout(r, 2))
      return clean(out)
    },
    async run(cmd: string): Promise<string> {
      return this.send(cmd + '\r')
    },
    raw: () => out
  }
}

describe('panos modes and prompts', () => {
  it('uses admin@fw1> in op mode and [edit] + admin@fw1# in configure mode', async () => {
    const r = rig()
    expect(await r.run('')).toMatch(/admin@fw1> $/)
    const cfg = await r.run('configure')
    expect(cfg).toContain('Entering configuration mode\n[edit]\nadmin@fw1# ')
    expect(await r.run('edit network interface')).toContain('[edit network interface]\nadmin@fw1# ')
    expect(await r.run('top')).toContain('[edit]\nadmin@fw1# ')
    const out = await r.run('exit')
    expect(out).toContain('Exiting configuration mode')
    expect(out).toMatch(/admin@fw1> $/)
  })

  it('fingerprints as PA-VM 11.1.6', async () => {
    const r = rig()
    const info = await r.run('show system info')
    expect(info).toContain('hostname: fw1')
    expect(info).toContain('model: PA-VM')
    expect(info).toContain('sw-version: 11.1.6')
  })

  it('reports errors in the PAN-OS shape', async () => {
    const r = rig()
    expect(await r.run('shwo system info')).toContain('Unknown command: shwo')
    expect(await r.run('show routing route bogus')).toContain('Invalid syntax.')
    await r.run('configure')
    expect(await r.run('set network interface ethernet ethernet1/1 layer3 ip 10.0.3.300/30')).toContain('Invalid syntax.')
  })

  it('lists options on ? and completes on Tab', async () => {
    const r = rig()
    const h = await r.send('show ?')
    expect(h).toMatch(/\n> system +Show system related information/)
    expect(h).toMatch(/\n {2}clock +Show the system time/)
    expect(h).toContain('admin@fw1> show ')
    await r.send('\x15')
    expect(await r.send('show sys\t')).toContain('system ')
  })

  it('pages with --more-- on a small terminal and stops after set cli pager off', async () => {
    const r = rig(8)
    const first = await r.run('show interface all')
    expect(first).toContain('--more--')
    const rest = await r.send('q')
    expect(rest).toMatch(/admin@fw1> $/)
    await r.run('set cli pager off')
    expect(await r.run('show interface all')).not.toContain('--more--')
  })

  it('applies link-state down and new policy objects only on commit', async () => {
    const r = rig()
    expect(await r.run('show interface all')).toMatch(/ethernet1\/3\s+\d+\s+1000\/full\/up/)
    await r.run('configure')
    await r.run('set network interface ethernet ethernet1/3 link-state down')
    expect(await r.run('run show interface all')).toMatch(/ethernet1\/3\s+\d+\s+1000\/full\/up/)
    await r.run('set address web1 ip-netmask 10.100.0.20/32')
    await r.run('set rulebase security rules web-in from untrust to dmz source any destination web1 application any service any action allow')
    const commit = await r.run('commit')
    expect(commit).toContain('Configuration committed successfully')
    expect(await r.run('run show interface all')).toMatch(/ethernet1\/3\s+\d+\s+ukn\/ukn\/down/)
    expect(await r.run('run show running security-policy')).toContain('web-in')
    expect(await r.run('run test security-policy-match from untrust to dmz destination 10.100.0.20 destination-port 443 protocol 6')).toContain('web-in')
    expect(await r.run('commit')).toContain('There are no changes to commit.')
  })

  it('warns about uncommitted changes on exit', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set deviceconfig system hostname fw9')
    const out = await r.run('exit')
    expect(out).toContain('There are uncommitted changes')
    expect(r.d.hostname).toBe('fw1')
  })

  it('Ctrl-C discards the line and returns a fresh prompt', async () => {
    const r = rig()
    const out = await r.send('show sys\x03')
    expect(out).toMatch(/admin@fw1> $/)
    expect(r.closed()).toBe(false)
    expect(await r.run('show clock')).toMatch(/2026/)
  })

  it('reads live values from the model (wrong peer AS, hostile text)', async () => {
    const d = makeDevice('panos', T0)
    d.bgp[0]!.peerAs = 65099
    const esc = 'evil\x1b]0;pwned\x07\x1b[31mred\x1b[0m'
    d.interfaces[0]!.description = esc
    const r = rig(1000, d)
    r.clock.advance(10_000)
    const bgp = await r.run('show routing protocol bgp summary')
    expect(bgp).toContain('peer edge-r1: AS 65000, Active, IP 10.0.3.1')
    expect(bgp).toContain('peer core-sw1: AS 65001, Established')
    await r.run('show interface ethernet1/1')
    expect(r.raw()).toContain(esc)
  })

  it('works on the topology lab device (fw1)', async () => {
    const lab = buildLab(T0)
    const r = rig(1000, lab.device('fw1'))
    expect(await r.run('show interface all')).toContain('10.0.0.14/30')
    await r.run('configure')
    await r.run('set address lab1 ip-netmask 10.9.9.9/32')
    expect(await r.run('commit')).toContain('Configuration committed successfully')
    await r.run('set network interface ethernet ethernet1/2 link-state down')
    await r.run('commit')
    const bgp = await r.run('run show routing protocol bgp summary')
    expect(bgp).toMatch(/peer core-sw2: AS 65001, (Idle|Active)/)
    expect(bgp).toContain('peer pe1: AS 64500, Established')
    expect(await r.run('run show session all')).toContain('(203.0.113.6[')
    expect(await r.run('run show arp all')).not.toContain('10.0.3.')
  })
})
