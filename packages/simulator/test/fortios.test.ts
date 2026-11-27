import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'
import { buildLab } from '../src/topology.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

function rig(rows = 1000, d: Device = makeDevice('fortios', T0)) {
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

describe('fortios contexts and prompts', () => {
  it('shows the innermost config context in the prompt', async () => {
    const r = rig()
    expect(await r.run('')).toMatch(/fgt-edge1 # $/)
    expect(await r.run('config system interface')).toMatch(/fgt-edge1 \(interface\) # $/)
    expect(await r.run('edit port1')).toMatch(/fgt-edge1 \(port1\) # $/)
    expect(await r.run('next')).toMatch(/fgt-edge1 \(interface\) # $/)
    expect(await r.run('end')).toMatch(/fgt-edge1 # $/)
    await r.run('config firewall address')
    expect(await r.run('edit WEB1')).toContain("new entry 'WEB1' added\nfgt-edge1 (WEB1) # ")
    expect(await r.run('abort')).toMatch(/fgt-edge1 \(address\) # $/)
    await r.run('end')
    expect(await r.run('config system global')).toMatch(/fgt-edge1 \(global\) # $/)
  })

  it('fingerprints as FortiGate-VM64 v7.4.4', async () => {
    const r = rig()
    const st = await r.run('g sy stat')
    expect(st).toContain('Version: FortiGate-VM64 v7.4.4,build2662,240514 (GA.F)')
    expect(st).toContain('Hostname: fgt-edge1')
    expect(st).toContain('Current HA mode: standalone')
  })

  it('reports parse errors with return codes and no caret', async () => {
    const r = rig()
    expect(await r.run('shw system status')).toContain('Unknown action 0')
    await r.run('config firewall policy')
    await r.run('edit 10')
    expect(await r.run('set bogus 1')).toContain("command parse error before 'bogus'\nCommand fail. Return code -61")
    expect(await r.run('set srcaddr NOPE')).toContain("entry not found in datasource\n\nvalue parse error before 'NOPE'\nCommand fail. Return code -3")
    await r.run('abort')
    await r.run('edit 30')
    expect(await r.run('next')).toContain("Attribute 'srcintf' MUST be set.\nCommand fail. Return code 1")
  })

  it('lists options on ? and cycles matches on Tab', async () => {
    const r = rig()
    const h = await r.send('get router info ?')
    expect(h).toContain('bgp           Show BGP information.')
    expect(h).toContain('routing-table Show routing table information.')
    await r.send('\x15')
    await r.run('config system interface')
    await r.run('edit port1')
    const st = await r.send('set status ?')
    expect(st).toContain('up      Interface up.\ndown    Interface down.')
    await r.send('\x15')
    const first = await r.send('set s\t')
    expect(first).toContain('set status')
    const second = await r.send('\t')
    expect(second).toContain('snmp-index')
  })

  it('pages with --More-- until config system console sets output standard', async () => {
    const r = rig(8)
    const first = await r.run('get system status')
    expect(first).toContain('--More--')
    expect(await r.send('q')).toMatch(/fgt-edge1 # $/)
    await r.run('config system console')
    await r.run('set output standard')
    await r.run('end')
    expect(await r.run('get system status')).not.toContain('--More--')
    // The setting is persistent config: a new session on the same device starts unpaged.
    const r2 = rig(8, r.d)
    expect(await r2.run('get system status')).not.toContain('--More--')
  })

  it('applies set status down and new firewall objects on next/end', async () => {
    const r = rig()
    expect(await r.run('get system interface physical')).toMatch(/==\[port3\]\n {8}mode: static\n.*\n.*\n {8}status: up/)
    await r.run('config system interface')
    await r.run('edit port3')
    await r.run('set status down')
    // Not applied until the entry is saved.
    expect(r.d.interfaces.find((i) => i.name === 'port3')!.adminUp).toBe(true)
    await r.run('end')
    const phys = await r.run('get system interface physical')
    expect(phys).toMatch(/==\[port3\]\n {8}mode: static\n.*\n.*\n {8}status: down\n {8}speed: n\/a/)
    expect(await r.run('get router info routing-table all')).not.toContain('10.20.0.0/24')
    await r.run('config firewall address')
    await r.run('edit WEB1')
    await r.run('set subnet 10.10.10.5/32')
    await r.run('end')
    await r.run('config firewall policy')
    await r.run('edit 30')
    await r.run('set name "to-web"')
    await r.run('set srcintf port2')
    await r.run('set dstintf port1')
    await r.run('set srcaddr all')
    await r.run('set dstaddr WEB1')
    await r.run('set schedule always')
    await r.run('set service HTTPS')
    await r.run('set action accept')
    expect(await r.run('end')).toMatch(/fgt-edge1 # $/)
    const pol = await r.run('show firewall policy 30')
    expect(pol).toContain('    edit 30\n        set name "to-web"')
    expect(pol).toContain('set dstaddr "WEB1"')
    expect(await r.run('show firewall address WEB1')).toContain('set subnet 10.10.10.5 255.255.255.255')
  })

  it('Ctrl-C aborts a config block, and closes the session at the top level', async () => {
    const r = rig()
    await r.run('config system interface')
    await r.run('edit port1')
    await r.run('set alias CHANGED')
    expect(await r.send('\x03')).toMatch(/fgt-edge1 # $/)
    expect(r.d.interfaces[0]!.alias).toBeUndefined()
    expect(r.closed()).toBe(false)
    await r.send('\x03')
    await new Promise((ok) => setTimeout(ok, 20))
    expect(r.closed()).toBe(true)
  })

  it('reads live values from the model (wrong peer AS, hostile text)', async () => {
    const d = makeDevice('fortios', T0)
    d.bgp[0]!.peerAs = 65099
    const esc = 'evil\x1b]0;pwned\x07\x1b[31mred\x1b[0m'
    d.interfaces[1]!.alias = esc
    const r = rig(1000, d)
    r.clock.advance(10_000)
    const bgp = await r.run('get router info bgp summary')
    expect(bgp).toMatch(/10\.0\.2\.2 +4 +65001 .* (Active|Connect|Idle) /)
    expect(bgp).toMatch(/203\.0\.113\.1 +4 +64500 .*2d03h1\dm +1$/m)
    await r.run('show system interface port2')
    expect(r.raw()).toContain(esc)
  })

  it('works on the topology lab device (fgt-edge1)', async () => {
    const lab = buildLab(T0)
    const r = rig(1000, lab.device('fgt-edge1'))
    expect(await r.run('get system interface physical')).toContain('ip: 10.0.0.18 255.255.255.252')
    expect(await r.run('diagnose lldprx neighbor summary')).toMatch(/port 'port2' 4 mac (\S+) chassis \1 port 'Gi1\/0\/2' system 'core-sw2'/)
    expect(await r.run('get system arp')).not.toContain('10.0.2.2')
    await r.run('config system interface')
    await r.run('edit port2')
    await r.run('set status down')
    await r.run('end')
    expect(await r.run('get router info bgp summary')).toMatch(/^10\.0\.0\.17 .* Idle/m)
    expect(await r.run('get router info routing-table all')).not.toContain('10.0.0.16/30')
  })
})
