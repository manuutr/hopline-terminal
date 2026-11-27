import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

function rig(rows = 1000, d: Device = makeDevice('junos', T0)) {
  const clock = new ManualClock(T0)
  setClock(d, clock)
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, rows, { user: 'netops', from: '192.168.100.50' })
  sh.start()
  const clean = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '')
  return {
    d,
    clock,
    sh,
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

describe('junos operational mode', () => {
  it('abbreviates, completes on space and reports ambiguity', async () => {
    const r = rig()
    expect(await r.run('sh int te')).toContain('ge-0/0/0.0              up    up   inet     203.0.113.2/30')
    // Space completes a unique prefix, echoing more than was typed.
    expect(await r.send('sh ')).toContain('show ')
    await r.send('\x15')
    const amb = await r.send('s ')
    expect(amb).toContain("'s' is ambiguous.")
    expect(amb).toContain('Possible completions:')
    await r.send('\x15')
    const err = await r.run('show c')
    expect(err).toContain("'c' is ambiguous.")
  })

  it('pages with ---(more N%)--- and honours screen-length 0 and | no-more', async () => {
    const r = rig(10)
    const first = await r.run('show configuration')
    expect(first).toMatch(/---\(more \d+%\)---/)
    const line = await r.send('\r')
    expect(line.split('\n').filter(Boolean).length).toBeLessThanOrEqual(2)
    const quit = await r.send('q')
    expect(quit).toContain('netops@edge-r1> ')
    expect(await r.run('show configuration | no-more')).not.toContain('---(more')
    await r.run('set cli screen-length 0')
    expect(await r.run('show configuration')).not.toContain('---(more')
  })

  it('Ctrl-C stops an endless ping and prints the statistics', async () => {
    const r = rig()
    r.sh.input('ping 10.0.0.5\r')
    await new Promise((res) => setTimeout(res, 50))
    const out = await r.send('\x03')
    expect(out).toContain('--- 10.0.0.5 ping statistics ---')
    expect(await r.run('ping 10.0.0.5 rapid count 3')).toContain('3 packets transmitted, 3 packets received, 0% packet loss')
  })

  it('request system reboot defaults to no', async () => {
    const r = rig()
    const q = await r.run('request system reboot')
    expect(q).toContain('Reboot the system ? [yes,no] (no) ')
    const a = await r.send('\r')
    expect(a).not.toContain('shutdown')
  })
})

describe('junos configuration mode', () => {
  it('set / show | compare / commit changes the operational view', async () => {
    const r = rig()
    expect(await r.run('configure')).toContain('Entering configuration mode\n\n[edit]\nnetops@edge-r1# ')
    await r.run('delete interfaces ge-0/0/2 disable')
    await r.run('set interfaces ge-0/0/2 unit 0 family inet address 10.9.9.1/24')
    const cmp = await r.run('show | compare')
    expect(cmp).toContain('[edit interfaces ge-0/0/2]\n-   disable;\n+   unit 0 {')
    expect(await r.run('run show interfaces terse ge-0/0/2')).toContain('ge-0/0/2                down  down')
    expect(await r.run('commit')).toContain('commit complete')
    const terse = await r.run('run show interfaces terse ge-0/0/2')
    expect(terse).toContain('ge-0/0/2.0              up    up   inet     10.9.9.1/24')
    expect(r.d.interfaces.find((i) => i.name === 'ge-0/0/2')?.adminUp).toBe(true)
  })

  it('edit / up / top move the [edit] banner', async () => {
    const r = rig()
    await r.run('configure')
    expect(await r.run('edit protocols bgp group CORE')).toContain('[edit protocols bgp group CORE]\nnetops@edge-r1# ')
    expect(await r.run('show')).toContain('peer-as 65001;')
    expect(await r.run('up')).toContain('[edit protocols bgp]')
    expect(await r.run('top')).toContain('\n[edit]\n')
    expect(await r.run('up')).toContain('warning: Already at the top of the configuration.')
  })

  it('commit check reports a missing peer-as and commit refuses it', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set protocols bgp group NEW type external')
    await r.run('set protocols bgp group NEW neighbor 10.0.0.9')
    const chk = await r.run('commit check')
    expect(chk).toContain('[edit protocols bgp group NEW neighbor 10.0.0.9]')
    expect(chk).toContain('error: configuration check-out failed')
    expect(await r.run('commit')).toContain('error: configuration check-out failed')
    await r.run('set protocols bgp group NEW peer-as 65099')
    expect(await r.run('commit check')).toContain('configuration check succeeds')
  })

  it('syntax errors put the caret under the bad token', async () => {
    const r = rig()
    await r.run('configure')
    const e = await r.run('set foo bar')
    const lines = e.split('\n')
    const i = lines.findIndex((l) => l.trim() === '^')
    expect(lines[i]!.indexOf('^')).toBe('netops@edge-r1# set '.length)
    expect(lines[i + 1]).toBe('syntax error.')
    expect(await r.run('set interfaces ge-0/0/2 mtu')).toContain('syntax error, expecting <mtu>.')
    expect(await r.run('delete interfaces ge-0/0/9')).toContain('warning: statement not found')
  })

  it('commit confirmed rolls back automatically when not confirmed', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set interfaces ge-0/0/1 disable')
    const c = await r.run('commit confirmed 2')
    expect(c).toContain('commit confirmed will be automatically rolled back in 2 minutes unless confirmed\ncommit complete')
    expect(c).toContain('# commit confirmed will be rolled back in 2 minutes\n[edit]')
    expect(r.d.interfaces.find((i) => i.name === 'ge-0/0/1')?.adminUp).toBe(false)
    expect(await r.run('run show system commit')).toMatch(/^0 +.*commit confirmed, rollback in 2mins/m)
    r.clock.advance(2 * 60_000 + 1)
    await new Promise((res) => setTimeout(res, 10))
    expect(r.raw()).toContain('Commit was not confirmed; automatic rollback complete.')
    expect(r.d.interfaces.find((i) => i.name === 'ge-0/0/1')?.adminUp).toBe(true)
    expect(await r.run('show interfaces ge-0/0/1')).not.toContain('disable;')
  })

  it('a plain commit confirms a pending commit confirmed', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set interfaces ge-0/0/2 description SPARE')
    await r.run('commit confirmed 1')
    expect(await r.run('commit')).not.toContain('# commit confirmed')
    r.clock.advance(5 * 60_000)
    expect(r.d.interfaces.find((i) => i.name === 'ge-0/0/2')?.description).toBe('SPARE')
  })

  it('rollback N loads an older commit into the candidate', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set system host-name edge-r9')
    await r.run('commit')
    expect(r.d.hostname).toBe('edge-r9')
    expect(await r.run('rollback 1')).toContain('load complete')
    expect(await r.run('show | compare')).toContain('-   host-name edge-r9;\n+   host-name edge-r1;')
    await r.run('commit')
    expect(r.d.hostname).toBe('edge-r1')
    expect(await r.run('rollback 99')).toContain('syntax error')
  })

  it('exit with uncommitted changes asks, exit configuration-mode only warns', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set interfaces ge-0/0/2 description X')
    const q = await r.run('exit')
    expect(q).toContain('The configuration has been changed but not committed\nExit with uncommitted changes? [yes,no] (yes) ')
    expect(await r.send('no\r')).toContain('[edit]')
    const e = await r.run('exit configuration-mode')
    expect(e).toContain('The configuration has been changed but not committed\nExiting configuration mode')
    expect(e).toContain('netops@edge-r1> ')
    // Shared candidate keeps the change for the next configure.
    expect(await r.run('configure')).toContain('The configuration has been changed but not committed')
  })

  it('bgp peer-as change is reflected in show bgp summary', async () => {
    const r = rig()
    await r.run('configure')
    await r.run('set protocols bgp group CORE peer-as 65009')
    await r.run('commit and-quit')
    const s = await r.run('show bgp summary')
    expect(s).toMatch(/10\.0\.0\.5 +65009 .*(Active|Idle|Connect)/)
  })
})
