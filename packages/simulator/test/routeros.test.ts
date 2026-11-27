import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'

const LAB_TIME = Date.UTC(2026, 10, 24, 11, 2, 11, 418)

function session(rows = 1000, prep?: (d: Device) => void) {
  const clock = new ManualClock(LAB_TIME)
  const d = makeDevice('routeros', LAB_TIME)
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

describe('RouterOS 7 personality', () => {
  it('banner, root prompt and path prompts', async () => {
    const s = session()
    const b = s.take()
    expect(b).toContain('MikroTik RouterOS 7.14.3')
    expect(b).toMatch(/\[admin@mt-br1\] > $/)
    expect(await s.run('/interface vlan')).toMatch(/\[admin@mt-br1\] \/interface\/vlan> $/)
    expect(await s.run('..')).toMatch(/\[admin@mt-br1\] \/interface> $/)
    expect(await s.run('/ip/address')).toMatch(/\[admin@mt-br1\] \/ip\/address> $/)
    expect(await s.run('/')).toMatch(/\[admin@mt-br1\] > $/)
  })

  it('system resource and routerboard carry the fingerprint fields', async () => {
    const s = session()
    const r = await s.run('/system resource print')
    expect(r).toMatch(/^ +version: 7\.14\.3 \(stable\)$/m)
    expect(r).toMatch(/^ +board-name: RB5009UG\+S\+$/m)
    expect(r).toMatch(/^ +architecture-name: arm64$/m)
    expect(r).toMatch(/^ +uptime: 4w2d3h12m5s$/m)
    expect(await s.run('/system routerboard print')).toMatch(/model: RB5009UG\+S\+/)
  })

  it('print tables: interfaces, addresses, routes, bgp sessions', async () => {
    const s = session()
    const i = await s.run('/interface print')
    expect(i).toMatch(/^Flags: X - DISABLED, R - RUNNING, S - SLAVE$/m)
    expect(i).toMatch(/^Columns: NAME, TYPE, ACTUAL-MTU, L2MTU, MAX-L2MTU, MAC-ADDRESS$/m)
    expect(i).toMatch(/^ 5 X  ether6 +ether +1500/m)
    expect(i).toMatch(/^ 0 R  ;;; uplink to core-sw1$/m)
    expect(await s.run('/ip address print')).toMatch(/^0 10\.0\.6\.2\/30 +10\.0\.6\.0 +ether1$/m)
    const r = await s.run('/ip route print')
    expect(r).toMatch(/^0 As  0\.0\.0\.0\/0 +10\.0\.6\.1 +1$/m)
    expect(r).toMatch(/^ {2}DAb 172\.16\.0\.0\/16 +10\.0\.6\.1 +20$/m)
    const b = await s.run('/routing bgp session print')
    expect(b).toMatch(/^ 0 E name="core-sw1-1"$/m)
    expect(b).toMatch(/remote\.address=10\.0\.6\.1 \.as=65001/)
  })

  it('errors, help and Tab', async () => {
    const s = session()
    s.take()
    expect(await s.run('/foo')).toMatch(/^bad command name foo \(line 1 column 2\)$/m)
    expect(await s.run('/interface print bar')).toMatch(/^expected end of command \(line 1 column 18\)$/m)
    expect(await s.run('/ip address add address="10.1')).toMatch(/^syntax error \(line 1 column 17\)$/m)
    expect(await s.run('/interface disable 42')).toMatch(/^no such item$/m)
    const h = await s.send('/interface ?')
    expect(h).toMatch(/^Interface configuration$/m)
    expect(h).toMatch(/^vlan\/ -- Virtual LAN$/m)
    expect(h).toMatch(/^print -- Print values of item properties$/m)
    await s.send('\x15')
    expect(await s.send('/interf\t')).toBe('/interf' + 'ace ')
    expect(await s.send('pr\t')).toBe('pr' + 'int ')
    await s.send('\x15')
  })

  it('pager: -- [Q quit|D dump|down], D dumps, Q quits, without-paging bypasses', async () => {
    const s = session(6)
    s.take()
    const first = await s.run('/export')
    expect(first).toMatch(/-- \[Q quit\|D dump\|down\]$/)
    const rest = await s.send('D')
    expect(rest).toMatch(/set name=mt-br1\n\[admin@mt-br1\] > $/)
    expect(await s.run('/ip route print')).toMatch(/-- \[Q quit\|D dump\|down\]$/)
    expect(await s.send('q')).toMatch(/^\r? *\r?\[admin@mt-br1\] > $/)
    const all = await s.run('/ip route print without-paging')
    expect(all).not.toContain('-- [Q quit')
    expect(all).toMatch(/198\.51\.100\.0\/30/)
  })

  it('disable/enable by number and name change print and BGP', async () => {
    const s = session()
    await s.run('/interface disable 0')
    expect(await s.run('/interface print')).toMatch(/^ 0 X  ;;; uplink to core-sw1$/m)
    expect(await s.run('/routing bgp session print')).toMatch(/^ 0 {3}name="core-sw1-1"$/m)
    expect(await s.run('/ip route print')).not.toMatch(/10\.0\.6\.0\/30/)
    await s.run('/interface enable ether1')
    s.clock.advance(5000)
    expect(await s.run('/routing bgp session print')).toMatch(/^ 0 E name="core-sw1-1"$/m)
    await s.run('/interface set [ find name=ether8 ] disabled=yes comment="spare port"')
    expect(await s.run('/interface print')).toMatch(/^ 7 X  ;;; spare port\n +ether8 /m)
  })

  it('/interface vlan add shows in vlan print and export; remove deletes it', async () => {
    const s = session()
    s.take()
    expect(await s.run('/interface vlan add name=vlan50 vlan-id=50 interface=bridge')).toMatch(/interface=bridge\n\[admin@mt-br1\] > $/)
    const p = await s.run('/interface vlan print')
    expect(p).toMatch(/^1 R vlan50 +1500 +enabled +50 +bridge$/m)
    expect(s.d.vlans.some((v) => v.id === 50)).toBe(true)
    expect(await s.run('/interface vlan export')).toMatch(/^add interface=bridge name=vlan50 vlan-id=50$/m)
    expect(await s.run('/interface vlan add vlan-id=5000 interface=bridge')).toMatch(/out of range/)
    await s.run('/interface vlan remove vlan50')
    expect(await s.run('/interface vlan print')).not.toContain('vlan50')
  })

  it('honours wrong peer AS, OSPF MTU, duplex counters, CPU hog and hostile comments', async () => {
    const esc = 'x\x1b]0;owned\x07\x1b[2J'
    const s = session(1000, (d) => {
      d.bgp[0]!.peerAs = 65099
      d.bgp[0]!.upSince = undefined
      d.ospf!.neighbors[0]!.peerMtu = 9000
      const e = d.interfaces.find((i) => i.name === 'ether8')!
      e.duplex = 'full'
      e.peer = { duplex: 'half' }
      e.faultSince = LAB_TIME - 600_000
      d.cpu.hog = { pid: 99, name: 'dns', pct: 71 }
      d.interfaces.find((i) => i.name === 'ether7')!.description = esc
    })
    s.take()
    expect(await s.run('/routing bgp session print')).toMatch(/^ 0 {3}name="core-sw1-1"\n +remote\.address=10\.0\.6\.1 \.as=65001\n(.*\n){3}.*state=active$/m)
    expect(await s.run('/routing ospf neighbor print')).toContain('state="ExStart"')
    expect(await s.run('/interface print stats')).toMatch(/^ 7 R +ether8( +\d+){4} +[1-9]\d*/m)
    expect(await s.run('/system resource print')).toMatch(/cpu-load: 73%/)
    expect(await s.run('/tool profile')).toMatch(/^dns +71%$/m)
    expect(await s.run('/interface print')).toContain(`;;; ${esc}`)
  })
})
