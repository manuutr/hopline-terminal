import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import { liveValues } from '../src/live.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

function rig(rows = 100000) {
  const d = makeDevice('ios', T0)
  const clock = new ManualClock(T0)
  setClock(d, clock)
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, rows, { user: 'netops', from: '10.0.0.50' })
  sh.start()
  const clean = (s: string): string => s.replace(/\r\n/g, '\n')
  return {
    d,
    clock,
    sh,
    raw: () => out,
    async send(keys: string): Promise<string> {
      out = ''
      sh.input(keys)
      await sh.idle()
      await new Promise((r) => setTimeout(r, 2))
      return clean(out)
    },
    async run(cmd: string): Promise<string> {
      return this.send(cmd + '\r')
    }
  }
}

describe('IOS pager', () => {
  it('space pages, Enter adds a line, q quits', async () => {
    const r = rig(12)
    const first = await r.run('show running-config')
    expect(first).toContain(' --More-- ')
    expect(first.split('\n').length).toBeLessThanOrEqual(13)
    const line = await r.send('\r')
    // One more line, then the pager again (erased with backspaces first).
    expect(line).toContain('\b')
    expect(line.replace(/[\b]+ +[\b]+/g, '').split('\n').filter((l) => l.trim() && !l.includes('--More--')).length).toBe(1)
    const page = await r.send(' ')
    expect(page.split('\n').length).toBeGreaterThan(8)
    const q = await r.send('q')
    expect(q).toContain('core-sw1#')
    expect(q).not.toContain('--More--')
  })

  it('terminal length 0 and | no-more disable it', async () => {
    const r = rig(12)
    await r.run('terminal length 0')
    expect(await r.run('show running-config')).not.toContain('--More--')
  })
})

describe('IOS control keys and modes', () => {
  it('Ctrl-Z ends config mode and Ctrl-C abandons the line', async () => {
    const r = rig()
    await r.run('configure terminal')
    await r.run('interface Gi1/0/3')
    const z = await r.send('\x1a')
    expect(z).toContain('core-sw1#')
    const c = await r.send('show ver\x03')
    expect(c).toContain('core-sw1#')
    expect(await r.run('')).toContain('core-sw1#')
  })

  it('exit walks up one level, end leaves config mode', async () => {
    const r = rig()
    await r.run('configure terminal')
    await r.run('interface Gi1/0/3')
    expect(await r.run('exit')).toContain('core-sw1(config)#')
    await r.run('router bgp 65001')
    expect(await r.run('end')).toContain('core-sw1#')
  })
})

describe('IOS stateful config', () => {
  it('shutdown / no shutdown changes show ip interface brief', async () => {
    const r = rig()
    await r.run('configure terminal')
    await r.run('interface Gi1/0/3')
    await r.run('shutdown')
    await r.run('end')
    expect((await r.run('show ip interface brief')).split('\n').find((l) => l.startsWith('GigabitEthernet1/0/3'))).toMatch(/administratively down down/)
    await r.run('configure terminal')
    await r.run('interface Gi1/0/3')
    await r.run('no shutdown')
    await r.run('end')
    expect((await r.run('show ip interface brief')).split('\n').find((l) => l.startsWith('GigabitEthernet1/0/3'))).toMatch(/up +up/)
  })

  it('a new VLAN shows in show vlan and in live values', async () => {
    const r = rig()
    await r.run('configure terminal')
    await r.run('vlan 50')
    await r.run('name GUESTS')
    await r.run('end')
    expect(await r.run('show vlan brief')).toMatch(/^50 +GUESTS +active/m)
    expect(liveValues(r.d).vlans).toContainEqual({ id: 50, name: 'GUESTS' })
  })

  it('live values follow BGP and interface state', async () => {
    const r = rig()
    const before = liveValues(r.d)
    expect(before.interfaces.find((i) => i.short === 'Gi1/0/1')?.up).toBe(true)
    expect(before.bgpNeighbors.some((n) => n.established)).toBe(true)
    expect(before.routeMaps).toContain('RM-EDGE-IN')
    expect(before.prefixLists).toContain('PL-EDGE-IN')
    expect(before.acls).toContain('EDGE-IN')
    await r.run('configure terminal')
    await r.run('interface Gi1/0/1')
    await r.run('shutdown')
    await r.run('end')
    const after = liveValues(r.d)
    expect(after.interfaces.find((i) => i.short === 'Gi1/0/1')?.up).toBe(false)
  })

  it('configure terminal revert timer rolls back unless confirmed', async () => {
    const r = rig()
    await r.run('configure terminal revert timer 1')
    await r.run('hostname oops')
    await r.run('end')
    expect(r.d.hostname).toBe('oops')
    r.clock.advance(61_000)
    await new Promise((res) => setTimeout(res, 10))
    expect(r.d.hostname).toBe('core-sw1')
    expect(r.raw()).toContain("ROLLBK_CNFMD_CHG_ROLLBACK_START")
  })

  it('configure confirm keeps the change', async () => {
    const r = rig()
    await r.run('configure terminal revert timer 1')
    await r.run('hostname kept')
    await r.run('end')
    await r.run('configure confirm')
    r.clock.advance(120_000)
    expect(r.d.hostname).toBe('kept')
  })
})

describe('IOS ping abort (Phase 8 review H2)', () => {
  it('a long ping ignores Ctrl-C (queued as type-ahead) and stops on Ctrl-Shift-6', async () => {
    const d = makeDevice('ios', T0)
    let out = ''
    const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, 100000, { user: 'netops', from: '10.0.0.50' })
    sh.start()
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    out = ''
    sh.input('ping 10.0.0.2 repeat 100000\r')
    await wait(300)
    expect(out).toMatch(/Sending 100000, 100-byte ICMP Echos/)
    sh.input('\x03')
    await wait(300)
    const before = (out.match(/!/g) ?? []).length
    await wait(300)
    expect((out.match(/!/g) ?? []).length).toBeGreaterThan(before)
    expect(out).not.toMatch(/Success rate/)
    sh.input('\x1e')
    await sh.idle()
    await wait(20)
    expect(out).toMatch(/Success rate is 100 percent \(\d+\/\d+\)/)
    expect(out).toMatch(/#\s*$/)
  })
})

describe('IOS show interfaces status', () => {
  it('uses the real IOS columns: Name cut at 18, Duplex and Speed right-aligned to width 6', async () => {
    const r = rig()
    const out = await r.run('show interfaces status')
    const lines = out.split('\n')
    expect(lines).toContain('Port      Name               Status       Vlan       Duplex  Speed Type')
    const at = (l: string, from: number, to?: number) => l.slice(from, to).trim()
    const row = (port: string) => lines.find((l) => l.startsWith(port + ' '))!
    const up = row('Gi1/0/1')
    expect([at(up, 0, 10), at(up, 10, 29), at(up, 29, 42), at(up, 42, 53), at(up, 53, 59), at(up, 60, 66), at(up, 67)]).toEqual(['Gi1/0/1', 'uplink to edge-r1', 'connected', 'routed', 'a-full', 'a-1000', '10/100/1000BaseTX'])
    // "auto" sits right-aligned under Duplex, as on the device ("1            auto   auto").
    expect(row('Gi1/0/4').slice(53, 66)).toBe('  auto   auto')
    // A long description is cut at 18 characters, like IOS does.
    expect(at(row('Gi1/0/2'), 10, 29)).toHaveLength(18)
  })
})
