import { describe, expect, it } from 'vitest'
import { Shell } from '../src/shell.ts'
import { makeDevice } from '../src/devices/index.ts'
import { ManualClock, setClock } from '../src/core/runtime.ts'
import type { Device } from '../src/state.ts'

const LAB_TIME = Date.UTC(2026, 10, 24, 11, 2, 11, 418)

function session(rows = 1000, prep?: (d: Device) => void) {
  const clock = new ManualClock(LAB_TIME)
  const d = makeDevice('aireos', LAB_TIME)
  setClock(d, clock)
  prep?.(d)
  let out = ''
  let closed = false
  const sh = new Shell(d, { write: (s) => (out += s), close: () => (closed = true) }, rows)
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
  return { d, clock, sh, take, send, run, closed: () => closed }
}

describe('AireOS WLC personality', () => {
  it('prompts: exec and config mode, exit and Ctrl-Z', async () => {
    const s = session()
    expect(s.take()).toBe('(Cisco Controller) >')
    expect(await s.run('config')).toMatch(/\n\(Cisco Controller\) config>$/)
    expect(await s.run('exit')).toMatch(/\n\(Cisco Controller\) >$/)
    await s.run('config')
    expect(await s.send('\x1a')).toMatch(/\(Cisco Controller\) >$/)
  })

  it('show sysinfo has the fingerprint fields', async () => {
    const s = session()
    const out = await s.run('show sysinfo')
    expect(out).toMatch(/^Manufacturer's Name\.+ Cisco Systems Inc\.$/m)
    expect(out).toMatch(/^Product Name\.+ Cisco Controller$/m)
    expect(out).toMatch(/^Product Version\.+ 8\.10\.185\.0$/m)
    expect(out).toMatch(/^System Name\.+ wlc1$/m)
  })

  it('tables: ap, wlan, client, interface summaries', async () => {
    const s = session()
    expect(await s.run('show ap summary')).toMatch(/^AP-Lobby +3 +C9120AXI-B +3c:41:0e:5b:77:00 +Lobby +US +10\.10\.30\.22 +2 /m)
    expect(await s.run('show wlan summary')).toMatch(/^2 +GUEST \/ GUEST-WIFI +Enabled +wifi-users/m)
    expect(await s.run('show client summary')).toMatch(/^Number of Clients\.+ 5$/m)
    expect(await s.run('show interface summary')).toMatch(/^management +LAG +10 +10\.10\.10\.5 +Static +Yes/m)
  })

  it('errors, help and Tab', async () => {
    const s = session()
    s.take()
    expect(await s.run('show foo')).toContain("Incorrect usage. Use the '?' or <TAB> key to list commands.")
    expect(await s.run('show')).toContain('Incorrect usage.')
    const h = await s.send('show ?')
    expect(h).toMatch(/^sysinfo +Display system information\.$/m)
    await s.send('\x15')
    expect(await s.send('show sys\t')).toBe('show sys' + 'info ')
    await s.send('\x15')
  })

  it('pager --More-- or (q)uit and config paging disable', async () => {
    const s = session(8)
    s.take()
    expect(await s.run('show sysinfo')).toMatch(/--More-- or \(q\)uit$/)
    expect(await s.send('q')).toMatch(/\(Cisco Controller\) >$/)
    await s.run('config paging disable')
    const all = await s.run('show sysinfo')
    expect(all).not.toContain('--More--')
    expect(all).toMatch(/Licensing Type/)
  })

  it('config ap disable and config wlan disable change the show output', async () => {
    const s = session()
    await s.run('config ap disable AP-Lobby')
    expect(await s.run('show ap summary')).toMatch(/^AP-Lobby .* 0 +\[0 ,0 ,0 \]$/m)
    expect(await s.run('show ap config general AP-Lobby')).toMatch(/Administrative State\.+ ADMIN_DISABLED/)
    await s.run('config')
    await s.run('wlan disable 2')
    await s.run('exit')
    expect(await s.run('show wlan summary')).toMatch(/^2 +GUEST \/ GUEST-WIFI +Disabled/m)
    expect(await s.run('show client summary')).toMatch(/^Number of Clients\.+ 2$/m)
    expect(await s.run('config ap disable AP-Nope')).toContain('Cisco AP AP-Nope is not found.')
    await s.run('config ap enable AP-Lobby')
    expect(await s.run('show ap status')).toMatch(/^AP-Lobby +Enabled/m)
  })

  it('save config asks (y/n); logout offers to save unsaved changes', async () => {
    const s = session()
    await s.run('config wlan enable 3')
    expect(await s.run('save config')).toMatch(/Are you sure you want to save\? \(y\/n\) $/)
    expect(await s.send('y\r')).toContain('Configuration Saved!')
    await s.run('config wlan disable 3')
    expect(await s.run('logout')).toMatch(/Would you like to save them now\? \(y\/N\) $/)
    await s.send('n\r')
    await new Promise((r) => setTimeout(r, 20))
    expect(s.closed()).toBe(true)
  })

  it('honours CPU hog, duplex counters and hostile AP locations', async () => {
    const esc = 'Lab\x1b]8;;http://x\x07link\x1b]8;;\x07'
    const s = session(1000, (d) => {
      d.cpu.hog = { pid: 6, name: 'emWeb', pct: 88 }
      const p = d.interfaces.find((i) => i.name === '1')!
      p.duplex = 'full'
      p.peer = { duplex: 'half' }
      p.faultSince = LAB_TIME - 600_000
      ;(d.vendor['aireos'] as { aps: { location: string }[] }).aps[0]!.location = esc
    })
    expect(await s.run('show cpu')).toMatch(/Current CPU\(s\) load: 91%/)
    expect(await s.run('show process cpu')).toMatch(/^Name.*\nemWeb +\( *\d+\/124\) +88  %/m)
    expect(await s.run('show port detailed-info 1')).toMatch(/CRC Errors\.+ [1-9]/)
    expect(await s.run('show ap config general AP-3F-East')).toContain(esc)
  })
})
