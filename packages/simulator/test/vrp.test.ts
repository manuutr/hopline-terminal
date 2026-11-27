import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'

const LAB_TIME = Date.UTC(2026, 10, 24, 11, 2, 11, 418)

function session(rows = 1000, prep?: (d: Device) => void) {
  const clock = new ManualClock(LAB_TIME)
  const d = makeDevice('vrp', LAB_TIME)
  setClock(d, clock)
  prep?.(d)
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, rows)
  sh.start()
  const take = (): string => {
    const o = out.replace(/\r\n/g, '\n')
    out = ''
    return o
  }
  const send = async (keys: string): Promise<string> => {
    sh.input(keys)
    await sh.idle()
    await new Promise((r) => setTimeout(r, 2))
    return take()
  }
  const run = (cmd: string): Promise<string> => send(cmd + '\r')
  return { d, clock, sh, take, send, run }
}

describe('VRP personality (CE6800)', () => {
  it('prompts per view, quit/return and Ctrl-Z', async () => {
    const s = session()
    expect(s.take()).toMatch(/<hw-agg1>$/)
    expect(await s.run('system-view')).toMatch(/Enter system view, return user view with return command\.\n\[~hw-agg1\]$/)
    expect(await s.run('interface 10GE1/0/3')).toMatch(/\[~hw-agg1-10GE1\/0\/3\]$/)
    expect(await s.run('quit')).toMatch(/\[~hw-agg1\]$/)
    expect(await s.run('int 10ge 1/0/4')).toMatch(/\[~hw-agg1-10GE1\/0\/4\]$/)
    expect(await s.run('vlan 77')).toMatch(/\[\*hw-agg1-vlan77\]$/)
    expect(await s.run('return')).toMatch(/Uncommitted configurations found.*\[Y\(yes\)\/N\(no\)\/C\(cancel\)\]:$/)
    expect(await s.send('n\r')).toMatch(/<hw-agg1>$/)
    await s.run('system-view')
    expect(await s.send('\x1a')).toMatch(/<hw-agg1>$/)
  })

  it('display version carries the fingerprint strings', async () => {
    const s = session()
    const out = await s.run('display version')
    expect(out).toContain('Huawei Versatile Routing Platform Software')
    expect(out).toMatch(/VRP \(R\) software, Version 8\.\d+ \(CE6881 V200R019C10SPC800\)/)
    expect(out).toMatch(/HUAWEI CE6881-48S6CQ uptime is 23 days, 4 hours, 51 minutes/)
  })

  it('tables: ip interface brief, bgp peer, ospf peer, lldp', async () => {
    const s = session()
    expect(await s.run('dis ip int br')).toMatch(/10GE1\/0\/1\s+10\.0\.4\.2\/30\s+up\s+up/)
    const bgp = await s.run('display bgp peer')
    expect(bgp).toMatch(/Local AS number : 65001/)
    expect(bgp).toMatch(/10\.0\.4\.1\s+4\s+65001\s+\d+\s+\d+\s+0 \S+\s+Established\s+3/)
    expect(await s.run('display ospf peer brief')).toMatch(/0\.0\.0\.0\s+10GE1\/0\/1\s+10\.255\.0\.1\s+Full/)
    expect(await s.run('display lldp neighbor brief')).toMatch(/10GE1\/0\/1\s+core-sw1\s+Gi1\/0\/47/)
    expect(await s.run('display interface brief')).toMatch(/10GE1\/0\/6\s+\*down\s+down/)
  })

  it('errors with caret, help and Tab', async () => {
    const s = session()
    s.take()
    const err = await s.run('display foo')
    expect(err).toContain("Error: Unrecognized command found at '^' position.")
    // caret under the 'f' of foo: prompt (9) + offset 8
    expect(err.split('\n')[1]).toBe(' '.repeat(17) + '^')
    expect(await s.run('display vlan 99999')).toContain("Error: Wrong parameter found at '^' position.")
    expect(await s.run('display bgp')).toContain("Error: Incomplete command found at '^' position.")
    const h = await s.send('display ?')
    expect(h).toMatch(/^  version\s+Display version information$/m)
    expect(h).toMatch(/^  bgp\s+BGP information$/m)
    await s.send('\x15')
    const t = await s.send('dis\t')
    expect(t).toBe('dis' + 'play ')
    await s.send('\x15')
  })

  it('pages with ---- More ---- and screen-length 0 temporary disables it', async () => {
    const s = session(10)
    s.take()
    const first = await s.run('display current-configuration')
    expect(first).toMatch(/ {2}---- More ----$/)
    const next = await s.send(' ')
    expect(next).toMatch(/---- More ----$/)
    expect(await s.send('q')).toMatch(/<hw-agg1>$/)
    expect(await s.run('screen-length 0 temporary')).toContain('Info: The configuration takes effect on the current user terminal interface only.')
    const all = await s.run('display current-configuration')
    expect(all).not.toContain('---- More ----')
    expect(all).toMatch(/\nreturn\n<hw-agg1>$/)
  })

  it('shutdown / undo shutdown only apply on commit and drive BGP', async () => {
    const s = session()
    await s.run('system-view')
    await s.run('interface 10GE1/0/2')
    expect(await s.run('shutdown')).toMatch(/\[\*hw-agg1-10GE1\/0\/2\]$/)
    expect(await s.run('display interface brief | include 10GE1/0/2')).toMatch(/10GE1\/0\/2\s+up/)
    const cand = await s.run('display configuration candidate changed')
    expect(cand).toMatch(/\+ shutdown/)
    expect(await s.run('commit')).toMatch(/\[~hw-agg1-10GE1\/0\/2\]$/)
    expect(await s.run('display interface brief | include 10GE1/0/2')).toMatch(/10GE1\/0\/2\s+\*down\s+down/)
    expect(await s.run('display bgp peer')).toMatch(/10\.0\.5\.2\s+4\s+65100.*Idle/)
    await s.run('undo shutdown')
    await s.run('commit')
    s.clock.advance(5000)
    expect(await s.run('display bgp peer')).toMatch(/10\.0\.5\.2\s+4\s+65100.*Established/)
  })

  it('vlan and vlan batch show in display vlan after commit', async () => {
    const s = session()
    await s.run('system-view')
    await s.run('vlan 50')
    await s.run('name GUESTS')
    await s.run('quit')
    await s.run('vlan batch 60 to 62')
    expect(await s.run('display vlan')).not.toMatch(/^ {2}50 /m)
    await s.run('commit')
    const v = await s.run('display vlan')
    expect(v).toMatch(/^ {2}50 common .*GUESTS$/m)
    expect(v).toMatch(/^ {2}61 common .*VLAN 0061$/m)
    expect(await s.run('display current-configuration | include vlan batch')).toMatch(/vlan batch 10 20 30 50 60 to 62/)
  })

  it('save asks [Y/N] and writes startup', async () => {
    const s = session()
    expect(await s.run('save')).toMatch(/Warning: The current configuration will be written to the device\. Continue\? \[Y\/N\]:$/)
    const r = await s.send('y\r')
    expect(r).toContain('Info: Save the configuration successfully.')
    expect(s.d.startup?.takenAt).toBe(LAB_TIME)
  })

  it('honours error-down, wrong peer AS, OSPF MTU, duplex, CPU hog and hostile text', async () => {
    const esc = 'evil\x1b]0;pwned\x07\x1b[31mred\x1b[0m'
    const s = session(1000, (d) => {
      d.interfaces.find((i) => i.name === '10GE1/0/3')!.errDisabled = 'bpdu-protection'
      d.bgp[1]!.peerAs = 65999
      d.ospf!.neighbors[0]!.peerMtu = 9000
      const p = d.interfaces.find((i) => i.name === '10GE1/0/4')!
      p.peer = { duplex: 'half' }
      p.duplex = 'full'
      p.faultSince = LAB_TIME - 600_000
      d.cpu.hog = { pid: 9, name: 'SNMP-HOG', pct: 80 }
      d.interfaces.find((i) => i.name === '10GE1/0/6')!.description = esc
    })
    expect(await s.run('display interface 10GE1/0/3')).toContain('current state : ERROR DOWN(bpdu-protection)')
    expect(await s.run('display bgp peer')).toMatch(/10\.0\.5\.2\s+4\s+65100.*Active/)
    expect(await s.run('display ospf peer brief')).toMatch(/10\.255\.0\.1\s+ExStart/)
    expect(await s.run('display interface 10GE1/0/4')).toMatch(/CRC: [1-9]\d* packets/)
    const cpu = await s.run('display cpu-usage')
    expect(cpu).toMatch(/CPU utilization for five seconds: 89%/)
    expect(cpu).toMatch(/TaskName.*\nSNMP-HOG\s+80%/)
    expect(await s.run('display current-configuration interface 10GE1/0/6')).toContain(` description ${esc}`)
    // shutdown + undo shutdown + commit recovers error-down
    await s.run('system-view')
    await s.run('interface 10GE1/0/3')
    await s.run('shutdown')
    await s.run('undo shutdown')
    await s.run('commit')
    expect(await s.run('display interface 10GE1/0/3')).toMatch(/current state : UP/)
  })
})
