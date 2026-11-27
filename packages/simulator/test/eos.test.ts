import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

function rig(rows = 100000, prep?: (d: Device) => void, t0 = T0) {
  const d = makeDevice('eos', t0)
  const clock = new ManualClock(t0)
  setClock(d, clock)
  prep?.(d)
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, rows, { user: 'admin', from: '10.0.0.50' })
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

const row = (out: string, start: string): string => out.split('\n').find((l) => l.startsWith(start)) ?? ''

describe('EOS pager', () => {
  it('space pages, Enter adds a line, q quits', async () => {
    const r = rig(12)
    const first = await r.run('show running-config')
    expect(first).toContain(' --More-- ')
    expect(first.split('\n').length).toBeLessThanOrEqual(13)
    const line = await r.send('\r')
    // The prompt is erased with CR, spaces, CR.
    expect(line).toContain('\r          \r')
    expect(line.replace(/\r +\r/g, '').split('\n').filter((l) => l.trim() && !l.includes('--More--')).length).toBe(1)
    const page = await r.send(' ')
    expect(page.split('\n').length).toBeGreaterThan(8)
    const q = await r.send('q')
    expect(q).toContain('dist-eos1#')
    expect(q).not.toContain('--More--')
  })

  it('other keys are ignored while paging', async () => {
    const r = rig(12)
    await r.run('show running-config')
    expect(await r.send('x')).toBe('')
  })

  it('terminal length 0 and | no-more disable it', async () => {
    const r = rig(12)
    expect(await r.run('show running-config | no-more')).not.toContain('--More--')
    expect(await r.run('terminal length 0')).toContain('Pagination disabled.')
    expect(await r.run('show running-config')).not.toContain('--More--')
    expect(await r.run('terminal length 30')).toContain('Pagination set to 30 lines.')
    expect(await r.run('terminal width 120')).toContain('Width set to 120 columns.')
  })
})

describe('EOS modes, keys and errors', () => {
  it('enable / disable and the privileged-mode error', async () => {
    const r = rig()
    expect(await r.run('disable')).toContain('dist-eos1>')
    expect(await r.run('configure')).toContain('% Invalid input (privileged mode required)')
    expect(await r.run('enable')).toContain('dist-eos1#')
  })

  it('prompts for interface ranges and sub-modes', async () => {
    const r = rig()
    expect(await r.run('configure')).toContain('dist-eos1(config)#')
    expect(await r.run('interface Ethernet1')).toContain('dist-eos1(config-if-Et1)#')
    expect(await r.run('interface Et10-11')).toContain('dist-eos1(config-if-Et10-11)#')
    expect(await r.run('router bgp 65010')).toContain('dist-eos1(config-router-bgp)#')
    expect(await r.run('vlan 100')).toContain('dist-eos1(config-vlan-100)#')
    expect(await r.run('ip access-list MGMT')).toContain('dist-eos1(config-acl-MGMT)#')
    // EXEC commands work from config mode without `do`.
    expect(await r.run('show version')).toContain('Arista DCS-7050SX3')
  })

  it('error strings', async () => {
    const r = rig()
    expect(await r.run('show ip bgp sumary')).toContain("% Invalid input (at token 3: 'sumary')")
    expect(await r.run('con')).toContain('% Ambiguous command')
    expect(await r.run('show ip')).toContain('% Incomplete command')
  })

  it('Ctrl-C keeps the mode, Ctrl-Z ends config', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('interface Et1')
    const c = await r.send('show ver\x03')
    expect(c).toContain('^C')
    expect(c).toContain('dist-eos1(config-if-Et1)#')
    const z = await r.send('\x1a')
    expect(z).toContain('^Z')
    expect(z).toContain('dist-eos1#')
  })

  it('Linux pipes', async () => {
    const r = rig()
    expect((await r.run('show interfaces status | wc -l')).split('\n')[1]).toBe('8')
    expect(await r.run('show version | grep -i serial')).toContain('Serial number: JPE19470123')
    expect(await r.run('show version | frob')).toContain('bash: frob: command not found')
    expect(await r.run('show clock | json')).toContain('% This is an unconverted command')
  })
})

describe('EOS stateful config', () => {
  it('shutdown / no shutdown shows in show output and logs', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('interface Ethernet1')
    await r.run('shutdown')
    await r.run('end')
    expect(row(await r.run('show ip interface brief'), 'Ethernet1 ')).toMatch(/adminDown\s+down/)
    expect(row(await r.run('show interfaces status'), 'Et1 ')).toMatch(/disabled/)
    expect(await r.run('show ip bgp summary')).not.toMatch(/10\.0\.1\.0 .*Estab/)
    const log = await r.run('show logging')
    expect(log).toContain('Line protocol on Interface Ethernet1 (spine1), changed state to down')
    expect(log).toContain('peer 10.0.1.0 (VRF default AS 65100) old state Established')
    await r.run('configure')
    await r.run('interface Ethernet1')
    await r.run('no shutdown')
    await r.run('end')
    expect(row(await r.run('show ip interface brief'), 'Ethernet1 ')).toMatch(/up\s+up/)
  })

  it('a new VLAN and trunk allowed changes show in show vlan and running-config', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('vlan 200')
    await r.run('name APP')
    await r.run('interface Ethernet48')
    await r.run('switchport trunk allowed vlan 10,100')
    await r.run('switchport trunk allowed vlan add 200')
    await r.run('end')
    expect(row(await r.run('show vlan'), '200 ')).toMatch(/APP\s+active\s+Et48/)
    expect(await r.run('show running-config')).toContain('   switchport trunk allowed vlan 10,100,200')
  })

  it('write memory clears running-config diffs', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('hostname leaf9')
    await r.run('end')
    expect(await r.run('show running-config diffs')).toContain('+hostname leaf9')
    expect(await r.run('write memory')).toContain('Copy completed successfully.')
    expect(await r.run('show running-config diffs')).not.toContain('+hostname')
  })
})

describe('EOS configuration sessions', () => {
  it('edits stay in the session until commit; abort discards', async () => {
    const r = rig()
    expect(await r.run('configure session s1')).toContain('dist-eos1(config-s-s1)#')
    expect(await r.run('interface Ethernet10')).toContain('dist-eos1(config-s-s1-if-Et10)#')
    await r.run('description changed')
    expect(r.d.interfaces.find((i) => i.name === 'Ethernet10')!.description).toBe('server-db01')
    const diff = await r.run('show session-config diffs')
    expect(diff).toContain('+++ session:/s1-session-config')
    expect(diff).toContain('+   description changed')
    await r.run('abort')
    expect(r.d.interfaces.find((i) => i.name === 'Ethernet10')!.description).toBe('server-db01')
    expect(await r.run('show configuration sessions')).not.toMatch(/^\W*s1\s/m)
  })

  it('exit leaves the session pending; commit applies it', async () => {
    const r = rig()
    await r.run('configure session s2')
    await r.run('hostname leaf2')
    await r.run('end')
    expect(r.d.hostname).toBe('dist-eos1')
    expect(await r.run('show configuration sessions')).toMatch(/s2\s+pending/)
    await r.run('configure session s2 commit')
    expect(r.d.hostname).toBe('leaf2')
  })

  it('commit timer rolls back unless confirmed', async () => {
    const r = rig()
    await r.run('configure session t1')
    await r.run('hostname oops')
    await r.run('commit timer 00:01:00')
    expect(r.d.hostname).toBe('oops')
    r.clock.advance(61_000)
    await new Promise((res) => setTimeout(res, 10))
    expect(r.d.hostname).toBe('dist-eos1')
    expect(r.raw()).toContain('CONFIG_SESSION_TIMER_EXPIRED')
  })

  it('a second commit confirms the timer', async () => {
    const r = rig()
    await r.run('configure session t2')
    await r.run('hostname kept')
    await r.run('commit timer 00:01:00')
    await r.run('configure session t2 commit')
    r.clock.advance(120_000)
    await new Promise((res) => setTimeout(res, 10))
    expect(r.d.hostname).toBe('kept')
  })
})

describe('EOS time-dependent output', () => {
  it('uptime and BGP timers follow the clock, even far in the future', async () => {
    const far = Date.UTC(2031, 5, 1, 0, 0, 0)
    const r = rig(100000, undefined, far)
    expect(await r.run('show version')).toContain('Uptime: 2 weeks, 3 days, 14 hours and 22 minutes')
    expect(row(await r.run('show ip bgp summary'), '  spine1')).toContain('17d12h')
    r.clock.advance(3 * 86400_000)
    expect(await r.run('show version')).toContain('Uptime: 2 weeks, 6 days, 14 hours and 22 minutes')
  })
})

describe('EOS scenario fields show through', () => {
  const cases: { name: string; prep: (d: Device) => void; cmd: string; expect: RegExp }[] = [
    { name: 'errDisabled', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet10')!.errDisabled = 'bpduguard'), cmd: 'show interfaces status', expect: /Et10\s+server-db01\s+errdisabled/ },
    { name: 'peerAs wrong AS', prep: (d) => { const n = d.bgp[0]!; n.peerAs = 65999; n.upSince = undefined; n.downSince = d.bootedAt }, cmd: 'show ip bgp neighbors 10.0.1.0', expect: /Peer reported AS 65999/ },
    {
      name: 'ospf peerMtu',
      prep: (d) => (d.ospf = { process: '1', ifaces: [{ iface: 'Ethernet1', area: '0.0.0.0' }], neighbors: [{ routerId: '10.255.0.100', ip: '10.0.1.0', iface: 'Ethernet1', pri: 1, area: '0.0.0.0', peerMtu: 9214 }] }),
      cmd: 'show ip ospf neighbor',
      expect: /10\.255\.0\.100 .*EXSTART/
    },
    { name: 'far-end duplex', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet48')!.peer = { duplex: 'full' }), cmd: 'show interfaces status', expect: /Et48 .* half /i },
    { name: 'trunk allowed', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet48')!.trunkAllowed = [100]), cmd: 'show mac address-table', expect: /criterion: 2/ },
    { name: 'cpu hog', prep: (d) => (d.cpu.hog = { pid: 4242, name: 'SuperServer', pct: 87 }), cmd: 'show processes top once', expect: /4242 .*87\.0 .*SuperServer/ },
    { name: 'hostile description', prep: (d) => (d.interfaces.find((i) => i.name === 'Ethernet11')!.description = "'; DROP TABLE --"), cmd: 'show interfaces status', expect: /Et11\s+'; DROP TABLE --/ }
  ]
  for (const c of cases)
    it(c.name, async () => {
      const r = rig(100000, c.prep)
      expect(await r.run(c.cmd)).toMatch(c.expect)
    })
})
