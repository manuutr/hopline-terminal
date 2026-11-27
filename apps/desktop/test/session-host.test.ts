import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '@hopline/transports'
import type { OpenSpec, PortToHost, PortToRenderer } from '@shared/host-protocol'
import { sign, verify, newKey } from '@shared/verdict'
import { closeKind, HostTab, type TabPort } from '../src/session-host/tab'

class FakeTransport extends EventEmitter implements Transport {
  readonly kind = 'ssh' as const
  paused = false
  written: string[] = []
  size = { cols: 0, rows: 0 }
  fail: Error | null = null
  async connect() {
    if (this.fail) throw this.fail
  }
  write(d: Buffer | string) {
    this.written.push(String(d))
  }
  resize(s: { cols: number; rows: number }) {
    this.size = s
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
  end() {
    this.emit('close')
  }
}

class FakePort implements TabPort {
  sent: PortToRenderer[] = []
  private fn: ((e: { data: PortToHost }) => void) | null = null
  closed = false
  postMessage(m: PortToRenderer) {
    this.sent.push(m)
  }
  on(_e: 'message', fn: (e: { data: PortToHost }) => void) {
    this.fn = fn
  }
  start() {}
  close() {
    this.closed = true
  }
  fromRenderer(m: PortToHost) {
    this.fn?.({ data: m })
  }
  text() {
    return this.sent.map((m) => (m.t === 'd' ? m.d : '')).join('')
  }
}

const spec = (): OpenSpec => ({
  tabId: 't1',
  session: { id: 's1', name: 'core-sw1', host: 'h', port: 22, platform: 'iosxe', protocol: 'ssh', username: 'admin', logToFile: false } as OpenSpec['session'],
  cols: 80,
  rows: 24,
  auth: { username: 'admin', password: 'pw' },
  settings: { keepAliveSec: 0, autoReconnect: false, log: { dir: '/tmp', template: '%S.log', timestamps: false, rotateDaily: false } }
})

async function open() {
  const t = new FakeTransport()
  const states: string[] = []
  const tab = new HostTab(spec(), { state: (i) => states.push(i.state), makeTransport: () => t })
  await tab.connect()
  const port = new FakePort()
  tab.attach(port)
  return { t, tab, port, states }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('HostTab', () => {
  it('relays output to the port in batches and keystrokes to the device', async () => {
    const { t, port, states } = await open()
    t.emit('data', Buffer.from('core-sw1#'))
    t.emit('data', Buffer.from(' '))
    await tick()
    expect(port.text()).toBe('core-sw1# ')
    expect(port.sent.filter((m) => m.t === 'd')).toHaveLength(1)
    expect(port.sent.some((m) => m.t === 'vitals' && m.sample.connectedAt)).toBe(true)
    port.fromRenderer({ t: 'w', d: 'show ver\r' })
    expect(t.written).toEqual(['show ver\r'])
    expect(states).toEqual(['connecting', 'connected'])
  })

  it('queues output until a port attaches', async () => {
    const t = new FakeTransport()
    const tab = new HostTab(spec(), { state: () => {}, makeTransport: () => t })
    await tab.connect()
    t.emit('data', Buffer.from('banner\r\n'))
    await tick()
    const port = new FakePort()
    tab.attach(port)
    expect(port.text()).toBe('banner\r\n')
  })

  it('pauses the device above the high watermark and resumes after acks', async () => {
    const { t, port } = await open()
    const chunk = 'x'.repeat(200 * 1024)
    for (let i = 0; i < 3; i++) {
      t.emit('data', Buffer.from(chunk))
      await tick()
    }
    expect(t.paused).toBe(true)
    port.fromRenderer({ t: 'a', n: 200 * 1024 })
    expect(t.paused).toBe(true) // 400K still unacked, above the low watermark
    port.fromRenderer({ t: 'a', n: 350 * 1024 })
    expect(t.paused).toBe(false)
  })

  it('validates renderer messages', async () => {
    const { t, tab, port } = await open()
    port.fromRenderer({ t: 'r', cols: 5, rows: 24 })
    port.fromRenderer({ t: 'r', cols: 132.5, rows: 24 })
    port.fromRenderer({ t: 'w', d: 42 as unknown as string })
    port.fromRenderer(undefined as unknown as PortToHost)
    expect(t.size).toEqual({ cols: 0, rows: 0 })
    expect(t.written).toEqual([])
    port.fromRenderer({ t: 'r', cols: 132, rows: 40 })
    expect(t.size).toEqual({ cols: 132, rows: 40 })
    expect(tab.spec.cols).toBe(132)
  })

  it('blocks user input while the agent holds the lock, except Ctrl-C', async () => {
    const { t, tab, port } = await open()
    const onInterrupt = vi.fn()
    tab.lock = { owner: 'agent', onInterrupt }
    port.fromRenderer({ t: 'w', d: 'conf t\r' })
    expect(t.written).toEqual([])
    port.fromRenderer({ t: 'w', d: '\x03' })
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('does not retry permanent failures and wipes secrets on dispose', async () => {
    const t = new FakeTransport()
    const { TransportError } = await import('@hopline/transports')
    t.fail = new TransportError('auth', 'Authentication failed')
    const states: string[] = []
    const tab = new HostTab(spec(), { state: (i) => states.push(i.state), makeTransport: () => t })
    await expect(tab.connect()).rejects.toThrow('Authentication failed')
    expect(states.at(-1)).toBe('down')
    tab.dispose()
    expect(tab.spec.auth.password).toBeUndefined()
  })
})

describe('HostTab lifecycle (review fixes)', () => {
  it('a superseded connect neither clears the new transport nor reports failure', async () => {
    let release!: () => void
    const slow = new FakeTransport()
    slow.connect = () => new Promise<void>((_, rej) => (release = () => rej(new Error('late failure'))))
    const fresh = new FakeTransport()
    const ts = [slow, fresh]
    const states: string[] = []
    const tab = new HostTab(spec(), { state: (i) => states.push(i.state), makeTransport: () => ts.shift()! })
    const first = tab.connect()
    await tick(1)
    await tab.reconnect()
    release()
    await first
    expect(tab.info().state).toBe('connected')
    const port = new FakePort()
    tab.attach(port)
    port.fromRenderer({ t: 'w', d: 'x' })
    expect(fresh.written).toEqual(['x'])
  })

  it('Ctrl-C cancels a connection attempt in progress', async () => {
    const t = new FakeTransport()
    t.connect = () => new Promise<void>(() => {})
    const ended = vi.spyOn(t, 'end')
    const tab = new HostTab(spec(), { state: () => {}, makeTransport: () => t })
    void tab.connect()
    await tick(1)
    const port = new FakePort()
    tab.attach(port)
    port.fromRenderer({ t: 'w', d: '\x03' })
    expect(ended).toHaveBeenCalled()
    expect(tab.info().state).toBe('down')
  })

  it('refuses BREAK and modem signals while the agent holds the lock', async () => {
    const { t, tab, port } = await open()
    const brk = vi.fn()
    ;(t as unknown as { sendBreak: () => Promise<void> }).sendBreak = brk
    tab.lock = { owner: 'agent', onInterrupt: () => {} }
    port.fromRenderer({ t: 'b' } as PortToHost)
    expect(brk).not.toHaveBeenCalled()
  })

  it('serial lines: reports DTR/RTS after a change, keeps the old state when the port refuses, and BREAK while it is sent', async () => {
    const { t, port } = await open()
    // A serial transport: lines as the port has them.
    const lines = { dtr: true, rts: true, brk: false }
    let refuse = false
    Object.assign(t, {
      lines,
      setSignals: async (s: { dtr?: boolean; rts?: boolean }) => {
        if (refuse) throw new Error('Error: Inappropriate ioctl for device')
        if (s.dtr !== undefined) lines.dtr = s.dtr
        if (s.rts !== undefined) lines.rts = s.rts
      },
      sendBreak: async () => {}
    })
    const sigs = () => port.sent.filter((m) => m.t === 'sig')
    port.fromRenderer({ t: 'sig', dtr: false })
    await tick(1)
    expect(sigs().at(-1)).toEqual({ t: 'sig', dtr: false, rts: true, brk: false })
    refuse = true
    port.fromRenderer({ t: 'sig', rts: false })
    await tick(1)
    expect(sigs().at(-1)).toEqual({ t: 'sig', dtr: false, rts: true, brk: false, error: 'The port refused the change: Inappropriate ioctl for device' })
    port.fromRenderer({ t: 'b' })
    await tick(1)
    expect(sigs().slice(-2).map((m) => (m as { brk: boolean }).brk)).toEqual([true, false])
  })

  it('a bad log folder does not block the session', async () => {
    const t = new FakeTransport()
    const s = spec()
    s.session.logToFile = true
    // A regular file where the log folder should be: mkdir fails (ENOTDIR).
    const base = mkdtempSync(join(tmpdir(), 'hoplog-'))
    writeFileSync(join(base, 'file'), '')
    s.settings.log.dir = join(base, 'file', 'logs')
    const tab = new HostTab(s, { state: () => {}, makeTransport: () => t })
    await tab.connect()
    expect(tab.info().state).toBe('connected')
  })

  it('no output after dispose', async () => {
    const { t, tab, port } = await open()
    tab.dispose()
    t.emit('data', Buffer.from('late'))
    await tick()
    expect(port.text()).not.toContain('late')
  })

  it('classifies close reasons', () => {
    expect(closeKind('logout: session ended by the device', 60_000)).toEqual({ text: 'session ended by the device', deliberate: true })
    expect(closeKind('remote-closed: Connection closed by remote host', 2_000).deliberate).toBe(true)
    expect(closeKind('remote-closed: Connection closed by remote host', 60_000).deliberate).toBe(false)
    expect(closeKind('keepalive timeout', 1_000).deliberate).toBe(false)
    expect(closeKind(undefined, 0).deliberate).toBe(true)
  })
})

describe('verdict tokens', () => {
  const key = newKey()
  it('verify a token bound to one tab and command', () => {
    const tok = sign(key, { tabId: 't1', command: 'show version', kind: 'read', platform: 'iosxe' })
    expect(verify(key, tok, 't1', 'show version')?.kind).toBe('read')
    expect(verify(key, tok, 't2', 'show version')).toBeNull()
    expect(verify(key, tok, 't1', 'reload')).toBeNull()
    expect(verify(newKey(), tok, 't1', 'show version')).toBeNull()
  })
  it('reject tampered and expired tokens', () => {
    const tok = sign(key, { tabId: 't1', command: 'show run', kind: 'read', platform: 'iosxe' }, 0)
    expect(verify(key, tok, 't1', 'show run', 1)).not.toBeNull()
    expect(verify(key, tok, 't1', 'show run', 61_000)).toBeNull()
    const [body, sig] = tok.split('.')
    const forged = JSON.parse(Buffer.from(body!, 'base64url').toString())
    forged.kind = 'config'
    expect(verify(key, Buffer.from(JSON.stringify(forged)).toString('base64url') + '.' + sig, 't1', 'show run', 1)).toBeNull()
    expect(verify(key, 'garbage', 't1', 'show run')).toBeNull()
  })
  it('bind the platform, the disruptive acknowledgement and the probe candidates', () => {
    const forge = (tok: string, patch: Record<string, unknown>) => {
      const [body, sig] = tok.split('.')
      const v = { ...JSON.parse(Buffer.from(body!, 'base64url').toString()), ...patch }
      return Buffer.from(JSON.stringify(v)).toString('base64url') + '.' + sig
    }
    const dis = sign(key, { tabId: 't1', command: 'clear ip bgp *', kind: 'disruptive', platform: 'iosxe', ack: 'core-sw1' })
    expect(verify(key, dis, 't1', 'clear ip bgp *')).toMatchObject({ kind: 'disruptive', ack: 'core-sw1', platform: 'iosxe' })
    expect(verify(key, forge(dis, { ack: 'edge-r1' }), 't1', 'clear ip bgp *')).toBeNull()
    expect(verify(key, forge(dis, { platform: 'eos' }), 't1', 'clear ip bgp *')).toBeNull()
    const cfg = sign(key, { tabId: 't1', command: 'clear ip bgp *', kind: 'config', platform: 'iosxe' })
    expect(verify(key, forge(cfg, { kind: 'disruptive', ack: 'core-sw1' }), 't1', 'clear ip bgp *')).toBeNull()
    const probe = sign(key, { tabId: 't1', command: 'show version', kind: 'read', platform: 'auto', probe: ['ios', 'iosxe'] })
    expect(verify(key, probe, 't1', 'show version')?.probe).toEqual(['ios', 'iosxe'])
    expect(verify(key, forge(probe, { probe: ['ios', 'iosxe', 'junos'] }), 't1', 'show version')).toBeNull()
  })

  it('writes a status notice above the prompt and draws the prompt again', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('Last login: today\r\n'))
    t.emit('data', Buffer.from('leaf1#'))
    ;(tab as unknown as { notice: (s: string) => void }).notice('forward L 127.0.0.1:1 → h:2: listening')
    await tick()
    // The device just sent that line: wait until it is quiet.
    expect(port.text()).toBe('Last login: today\r\nleaf1#')
    await tick(600)
    expect(port.text()).toBe('Last login: today\r\nleaf1#\r\x1b[2K\x1b[2m[hopline] forward L 127.0.0.1:1 → h:2: listening\x1b[0m\r\nleaf1#')
  })

  it('never splits a line the device is still sending', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('Building configuration'))
    ;(tab as unknown as { notice: (s: string) => void }).notice('forward D 127.0.0.1:1080 (SOCKS5): listening')
    await tick(100)
    t.emit('data', Buffer.from('...\r\n[OK]\r\nleaf1#'))
    await tick(600)
    expect(port.text()).toBe('Building configuration...\r\n[OK]\r\nleaf1#\r\x1b[2K\x1b[2m[hopline] forward D 127.0.0.1:1080 (SOCKS5): listening\x1b[0m\r\nleaf1#')
  })

  it('writes a notice on its own lines when the cursor is at a line start, and holds it while the agent types', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('banner\r\n'))
    const notice = (tab as unknown as { notice: (s: string) => void }).notice.bind(tab)
    notice('one')
    await tick()
    expect(port.text()).toBe('banner\r\n\r\n\x1b[2m[hopline] one\x1b[0m\r\n')
    tab.lock = { owner: 'agent' } as unknown as HostTab['lock']
    notice('two')
    await tick(250)
    expect(port.text()).not.toContain('two')
    tab.lock = null
    await tick(250)
    expect(port.text()).toContain('[hopline] two')
  })
})

describe('saved forwards on connect (review M4, M10)', () => {
  const withForwards = (background?: boolean): OpenSpec => {
    const s = spec()
    const forwards = [
      { id: 'lo', kind: 'L' as const, bindHost: '127.0.0.1', bindPort: 0, destHost: '10.0.0.1', destPort: 80 },
      { id: 'name', kind: 'D' as const, bindHost: 'localhost', bindPort: 0 },
      { id: 'v6', kind: 'D' as const, bindHost: '::1', bindPort: 0 },
      { id: 'off', kind: 'D' as const, bindHost: '127.0.0.1', bindPort: 0, autoStart: false },
      ...['0', '0.0', '0x0', '::0', '0:0:0:0:0:0:0:0', '0.0.0.0', '::', '*', '', '192.168.1.20'].map((h, i) => ({ id: `w${i}`, kind: 'R' as const, bindHost: h, bindPort: 8000 + i, destHost: '127.0.0.1', destPort: 22 }))
    ]
    return { ...s, ...(background ? { background } : {}), session: { ...s.session, options: { ssh: { forwards } } } as OpenSpec['session'] }
  }
  it('only loopback-bound saved forwards start by themselves', () => {
    const tab = new HostTab(withForwards(), { state: () => {}, makeTransport: () => new FakeTransport() })
    expect(tab.savedForwards().map((f) => f.id)).toEqual(['lo', 'name', 'v6'])
    tab.dispose()
  })
  it('a background connection gets no forwards at all', () => {
    const tab = new HostTab(withForwards(true), { state: () => {}, makeTransport: () => new FakeTransport() })
    expect(tab.savedForwards()).toEqual([])
    expect(tab.forwards).toBeNull()
    tab.dispose()
  })
})
