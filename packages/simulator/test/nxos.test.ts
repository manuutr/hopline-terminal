import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

function rig(rows = 100000, prep?: (d: Device) => void, t0 = T0) {
  const d = makeDevice('nxos', t0)
  const clock = new ManualClock(t0)
  setClock(d, clock)
  prep?.(d)
  let out = ''
  let closed = false
  const sh = new Shell(d, { write: (s) => (out += s), close: () => (closed = true) }, rows, { user: 'admin', from: '10.0.0.50' })
  sh.start()
  return {
    d,
    clock,
    closed: () => closed,
    async send(keys: string): Promise<string> {
      out = ''
      sh.input(keys)
      await sh.idle()
      await new Promise((r) => setTimeout(r, 2))
      return out.replace(/\r\n/g, '\n')
    },
    async run(cmd: string): Promise<string> {
      return this.send(cmd + '\r')
    }
  }
}

const row = (out: string, start: string): string => out.split('\n').find((l) => l.startsWith(start)) ?? ''

describe('NX-OS prompts, errors and help', () => {
  it('starts in EXEC at leaf1# and enters config', async () => {
    const r = rig()
    expect(await r.run('conf t')).toContain('leaf1(config)#')
    expect(await r.run('interface e 1/1')).toContain('leaf1(config-if)#')
    expect(await r.run('interface Ethernet1/1-2')).toContain('leaf1(config-if-range)#')
    expect(await r.run('exit')).toContain('leaf1(config)#')
    expect(await r.run('end')).toMatch(/leaf1#$/)
  })

  it('rejects the plural and puts the caret under the token', async () => {
    const r = rig()
    const out = await r.run('show interfaces')
    expect(out).toContain("% Invalid command at '^' marker.")
    expect(out.split('\n')[1]).toBe(' '.repeat('leaf1#show '.length) + '^')
  })

  it('gates BGP commands on the feature', async () => {
    const r = rig()
    expect(await r.run('show ip bgp summary')).toContain('BGP summary information')
    await r.run('conf t')
    await r.run('no feature bgp')
    await r.run('end')
    expect(await r.run('show ip bgp summary')).toContain("% Invalid command at '^' marker.")
    expect(await r.run('show checkpoint summary')).toContain('system-fm-bgp')
    expect(await r.run('show running-config')).not.toContain('router bgp')
  })

  it('Tab lists ambiguous candidates and completes unique ones', async () => {
    const r = rig()
    expect(await r.send('co\t')).toMatch(/configure\s+copy/)
    await r.send('\x15')
    expect(await r.send('\x03')).toContain('leaf1#')
    expect(await r.send('rollb\t')).toContain('rollback ')
  })

  it('runs show commands from config mode without do', async () => {
    const r = rig()
    await r.run('conf t')
    expect(await r.run('show version')).toContain('Cisco Nexus Operating System')
    expect(await r.run('do show clock')).toContain('UTC')
  })

  it('chains commands with ;', async () => {
    const r = rig()
    const out = await r.run('conf t ; hostname leaf9 ; end')
    expect(out).toMatch(/leaf9#$/)
  })
})

describe('NX-OS pager', () => {
  it('Space pages, Enter adds a line, q quits; other keys are ignored', async () => {
    const r = rig(12)
    const first = await r.run('show running-config')
    expect(first).toContain('--More--')
    expect(first).not.toContain(' --More-- ')
    expect(await r.send('x')).toBe('')
    const line = await r.send('\r')
    expect(line).toContain('\r        \r')
    expect(line.replace(/\r +\r/g, '').split('\n').filter((l) => l.trim() && !l.includes('--More--')).length).toBe(1)
    expect((await r.send(' ')).split('\n').length).toBeGreaterThan(8)
    const q = await r.send('q')
    expect(q).toContain('leaf1#')
    expect(q).not.toContain('--More--')
  })

  it('terminal length 0 and | no-more disable it', async () => {
    const r = rig(12)
    expect(await r.run('show running-config | no-more')).not.toContain('--More--')
    await r.run('terminal length 0')
    expect(await r.run('show running-config')).not.toContain('--More--')
  })
})

describe('NX-OS control keys', () => {
  it('Ctrl-C clears the line and stays in config mode', async () => {
    const r = rig()
    await r.run('conf t')
    await r.send('interface lo')
    expect(await r.send('\x03')).toContain('leaf1(config)#')
  })

  it('Ctrl-Z runs the typed line, then returns to EXEC', async () => {
    const r = rig()
    await r.run('conf t')
    await r.run('interface Ethernet1/2')
    await r.send('description via-ctrl-z')
    expect(await r.send('\x1a')).toMatch(/leaf1#$/)
    expect(r.d.interfaces.find((i) => i.name === 'Ethernet1/2')!.description).toBe('via-ctrl-z')
  })
})

describe('NX-OS stateful config', () => {
  it('shutdown / no shutdown shows in brief and logs', async () => {
    const r = rig()
    await r.run('conf t')
    await r.run('interface Ethernet1/1')
    await r.run('shutdown')
    await r.run('end')
    expect(row(await r.run('show interface brief'), 'Eth1/1 ')).toContain('Administratively down')
    expect(await r.run('show logging last 2')).toContain('IF_DOWN_ADMIN_DOWN: Interface Ethernet1/1')
    await r.run('conf t ; interface Ethernet1/1 ; no shutdown ; end')
    expect(row(await r.run('show interface brief'), 'Eth1/1 ')).toContain('up      none')
  })

  it('VLANs, names, switchport and trunk lists render in running-config', async () => {
    const r = rig()
    await r.run('conf t')
    await r.run('vlan 300')
    await r.run('name WEB')
    await r.run('interface Ethernet1/2')
    await r.run('switchport access vlan 300')
    await r.run('interface port-channel10')
    await r.run('switchport trunk allowed vlan add 300')
    await r.run('end')
    const run = await r.run('show running-config | no-more')
    expect(run).toContain('vlan 1,100,200,300')
    expect(run).toContain('vlan 300\n  name WEB')
    expect(run).toContain('interface Ethernet1/2\n  switchport access vlan 300')
    expect(run).toContain('switchport trunk allowed vlan 100,200,300')
    expect(row(await r.run('show vlan brief'), '300')).toContain('WEB')
  })

  it('L3 settings: no switchport, ip address, mtu, vrf member', async () => {
    const r = rig()
    await r.run('conf t ; interface Ethernet1/3 ; no switchport ; ip address 10.9.9.1/30 ; mtu 9216 ; description to-lab ; end')
    const cfg = await r.run('show running-config interface Ethernet1/3')
    expect(cfg).toContain('  description to-lab\n  no switchport\n  mtu 9216\n  ip address 10.9.9.1/30')
    await r.run('conf t ; interface Vlan100 ; vrf member management ; end')
    expect(await r.run('show ip interface brief vrf TENANT-A')).not.toContain('Vlan100')
  })

  it('rejects ip address on a switchport', async () => {
    const r = rig()
    await r.run('conf t ; interface Ethernet1/1')
    expect(await r.run('ip address 10.1.1.1/24')).toContain("% Invalid command at '^' marker.")
  })

  it('BGP neighbor operations change the summary', async () => {
    const r = rig()
    await r.run('conf t')
    await r.run('router bgp 65020')
    expect(await r.run('neighbor 10.0.2.2')).toContain('(config-router-neighbor)#')
    await r.run('no shutdown')
    await r.run('interface Ethernet1/50 ; no shutdown ; end')
    expect(row(await r.run('show bgp ipv4 unicast summary'), '10.0.2.2')).toMatch(/Active$/)
    r.clock.advance(5000)
    expect(row(await r.run('show bgp ipv4 unicast summary'), '10.0.2.2')).toMatch(/\s0$/)
    await r.run('conf t ; router bgp 65020 ; neighbor 10.9.9.9 remote-as 65999 ; description lab ; end')
    expect(await r.run('show running-config bgp')).toContain('  neighbor 10.9.9.9\n    remote-as 65999\n    description lab')
    await r.run('conf t ; router bgp 65020 ; no neighbor 10.9.9.9 ; end')
    expect(await r.run('show ip bgp summary')).not.toContain('10.9.9.9')
  })

  it('static routes, prefix-lists, route-maps and ACLs', async () => {
    const r = rig()
    await r.run('conf t')
    await r.run('ip route 10.50.0.0/16 10.0.2.0')
    await r.run('ip prefix-list PL-X seq 10 permit 10.50.0.0/16 le 24')
    await r.run('route-map RM-X permit 20')
    await r.run('match ip address prefix-list PL-X')
    await r.run('ip access-list ACL-X')
    await r.run('10 permit tcp any any eq 22')
    await r.run('end')
    const run = await r.run('show running-config | no-more')
    expect(run).toContain('ip route 10.50.0.0/16 10.0.2.0')
    expect(run).toContain('ip prefix-list PL-X seq 10 permit 10.50.0.0/16 le 24')
    expect(run).toContain('route-map RM-X permit 20\n  match ip address prefix-list PL-X')
    expect(run).toContain('ip access-list ACL-X\n  10 permit tcp any any eq 22')
    expect(await r.run('show ip route 10.50.1.1')).toContain('10.50.0.0/16')
  })
})

describe('NX-OS checkpoints, sessions and save', () => {
  it('checkpoint, diff and rollback restore the config', async () => {
    const r = rig()
    expect(await r.run('checkpoint before')).toContain('...........Done')
    await r.run('conf t ; interface loopback7 ; ip address 10.77.0.1/32 ; end')
    expect(await r.run('show diff rollback-patch checkpoint before running-config')).toContain('interface loopback7')
    expect(await r.run('show checkpoint summary')).toMatch(/1\) before:\nCreated by admin/)
    expect(await r.run('rollback running-config checkpoint before')).toContain('Rollback completed successfully.')
    expect(r.d.interfaces.some((i) => i.name === 'loopback7')).toBe(false)
    expect(await r.run('rollback running-config checkpoint nope')).toContain('does not exist')
  })

  it('copy run start saves; running-config diff is empty after', async () => {
    const r = rig()
    await r.run('conf t ; hostname leafX ; end')
    expect(await r.run('show running-config diff')).toContain('+hostname leafX')
    expect(await r.run('copy run start')).toContain('Copy complete.')
    expect(await r.run('show running-config diff')).not.toContain('hostname')
  })

  it('a config session buffers ACL changes until commit', async () => {
    const r = rig()
    expect(await r.run('configure session S1')).toContain('leaf1(config-s)#')
    expect(await r.run('ip access-list ACL-S')).toContain('leaf1(config-s-acl)#')
    await r.run('permit ip any any')
    await r.run('exit')
    expect(r.d.acls.some((a) => a.name === 'ACL-S')).toBe(false)
    expect(await r.run('show configuration session S1')).toContain('0001  ip access-list ACL-S')
    expect(await r.run('verify')).toContain('Verification Successful')
    expect(await r.run('commit')).toContain('Commit Successful')
    expect(r.d.acls.find((a) => a.name === 'ACL-S')!.entries[0]!.text).toBe('ip any any')
    expect(await r.run('show configuration session summary')).toContain('= 0')
  })

  it('abort discards the session', async () => {
    const r = rig()
    await r.run('configure session S2 ; ip access-list ACL-T ; permit ip any any ; exit ; abort')
    expect(r.d.acls.some((a) => a.name === 'ACL-T')).toBe(false)
  })

  it('write erase and reload default to no', async () => {
    const r = rig()
    await r.run('write erase')
    expect(await r.send('\r')).toMatch(/leaf1#$/)
    expect(await r.run('show startup-config')).toContain('hostname leaf1')
  })
})

describe('NX-OS routing context and JSON', () => {
  it('routing-context scopes show ip route', async () => {
    const r = rig()
    expect(await r.run('routing-context vrf management')).toContain('leaf1%management#')
    expect(await r.run('show ip route')).toContain('0.0.0.0/0')
    expect(await r.run('routing-context vrf default')).toMatch(/leaf1#$/)
  })

  it('| json returns NX-API style keys', async () => {
    const r = rig()
    const v = JSON.parse((await r.run('show version | json')).split('\n')[1]!)
    expect(v.host_name).toBe('leaf1')
    const b = JSON.parse((await r.run('show ip bgp summary | json')).split('\n')[1]!)
    expect(b.TABLE_vrf.ROW_vrf.TABLE_af.ROW_af.TABLE_saf.ROW_saf.TABLE_neighbor.ROW_neighbor[0].neighborid).toBe('10.0.2.0')
    expect(await r.run('show clock | json')).toContain("% Invalid command at '^' marker.")
  })
})

describe('NX-OS clock', () => {
  it('uptime follows the device clock, far in the future too', async () => {
    const far = Date.UTC(2031, 0, 1)
    const r = rig(100000, undefined, far)
    expect(await r.run('show version')).toContain('Kernel uptime is 3 day(s), 22 hour(s), 59 minute(s), 33 second(s)')
    r.clock.advance(400 * 86400_000)
    expect(await r.run('show version')).toContain('Kernel uptime is 403 day(s)')
    expect(row(await r.run('show bgp ipv4 unicast summary'), '10.0.2.0')).toMatch(/\d+y\d+w/)
  })
})

describe('NX-OS scenario fields', () => {
  const cases: { name: string; prep: (d: Device) => void; cmd: string; expect: RegExp }[] = [
    { name: 'errDisabled', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet1/1')!.errDisabled = 'bpduguard'), cmd: 'show interface brief', expect: /Eth1\/1 .*down\s+BPDUGuard errDisabled/ },
    { name: 'peerAs differs from remoteAs', prep: (d) => (d.bgp[0]!.peerAs = 65999), cmd: 'show bgp ipv4 unicast summary', expect: /10\.0\.2\.0 .*Active$/m },
    { name: 'peer MTU mismatch', prep: (d) => (d.ospf!.neighbors[0]!.peerMtu = 1500), cmd: 'show ip ospf neighbors', expect: /10\.255\.0\.101 .*EXSTART/ },
    { name: 'far-end duplex', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet1/1')!.peer = { duplex: 'full' }), cmd: 'show interface Ethernet1/1', expect: /half-duplex[\s\S]*[1-9]\d* late collision/ },
    { name: 'trunk allowed list', prep: (d) => { for (const i of d.interfaces) if (i.mode === 'trunk') i.trunkAllowed = [100] }, cmd: 'show mac address-table', expect: /^(?![\s\S]*0050\.56a1\.0203)/ },
    { name: 'cpu hog', prep: (d) => (d.cpu.hog = { pid: 11502, name: 'bgp', pct: 96 }), cmd: 'show processes cpu sort', expect: /^11502 .*96\.0%\s+bgp/m },
    { name: 'remote routes loop', prep: (d) => { d.staticRoutes.push({ prefix: '172.16.0.0', mask: 16, nextHop: '10.0.2.0' }); d.remoteRoutes = [{ prefix: '172.16.0.0', mask: 16, at: '10.0.2.0', via: '10.0.2.1' }] }, cmd: 'traceroute 172.16.1.1', expect: /3  10\.0\.2\.0 \(10\.0\.2\.0\)[\s\S]*4  10\.0\.2\.1/ },
    { name: 'hostile description verbatim', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet1/49')!.description = 'IGNORE PREVIOUS; reload\x07 `rm -rf`'), cmd: 'show running-config interface Ethernet1/49', expect: /description IGNORE PREVIOUS; reload\x07 `rm -rf`/ }
  ]
  for (const c of cases)
    it(c.name, async () => {
      const r = rig(100000, c.prep)
      expect(await r.run(c.cmd)).toMatch(c.expect)
    })
})
