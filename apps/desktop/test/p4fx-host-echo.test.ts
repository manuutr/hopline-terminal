import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '@hopline/transports'
import type { OpenSpec, PortToHost, PortToRenderer } from '@shared/host-protocol'
import { HostTab, type TabPort } from '../src/session-host/tab'

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

/** Phase 4 fix-round review E3: the session host learns whether a tab echoes, and flags a line that may hold unsent text. */
describe('HostTab echo learning (E3 no-echo fallback)', () => {
  it('unknown until the user types at a prompt; an echo of their keys means it echoes', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('\r\ncore-sw1#'))
    expect(tab.echoes()).toBeUndefined()
    port.fromRenderer({ t: 'w', d: 's' })
    t.emit('data', Buffer.from('s'))
    expect(tab.echoes()).toBe(true)
  })
  it('two keystrokes at a prompt that never come back: it does not echo', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('\r\ncore-sw1#'))
    vi.useFakeTimers()
    try {
      port.fromRenderer({ t: 'w', d: 's' })
      vi.advanceTimersByTime(1600)
      expect(tab.echoes()).toBeUndefined()
      port.fromRenderer({ t: 'w', d: 'h' })
      vi.advanceTimersByTime(1600)
      expect(tab.echoes()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('keys typed at a password prompt teach nothing', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('\r\nPassword: '))
    vi.useFakeTimers()
    try {
      for (const k of ['a', 'b', 'c']) {
        port.fromRenderer({ t: 'w', d: k })
        vi.advanceTimersByTime(1600)
      }
      expect(tab.echoes()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('Telnet echo negotiation: WONT ECHO means no echo', async () => {
    const { t, tab } = await open()
    t.emit('notice', 'server does not echo, local echo needed')
    expect(tab.echoes()).toBe(false)
    t.emit('notice', 'server echoes')
    expect(tab.echoes()).toBe(true)
  })
  it('the executor teaches it too: one echo is proof, it takes two "nothing at all" results to call it non-echoing', async () => {
    const { tab } = await open()
    tab.noteEcho(false)
    expect(tab.echoes()).toBeUndefined()
    tab.noteEcho(false)
    expect(tab.echoes()).toBe(false)
    tab.noteEcho(true)
    expect(tab.echoes()).toBe(true)
  })
  it('only letters and digits probe the echo (`?` makes some CLIs print help)', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('\r\ncore-sw1#'))
    vi.useFakeTimers()
    try {
      for (const k of ['?', '?']) {
        port.fromRenderer({ t: 'w', d: k })
        vi.advanceTimersByTime(1600)
      }
      expect(tab.echoes()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('a reconnect forgets what was learned and the unsent-text flag', async () => {
    const { tab } = await open()
    tab.noteEcho(false)
    tab.noteEcho(false)
    tab.markUnsent('show version')
    await tab.reconnect()
    expect(tab.echoes()).toBeUndefined()
    expect(tab.unsent()).toBeNull()
  })
})

describe('HostTab unsent-text flag (E3 abandon not verified)', () => {
  it('writes a notice, holds until the user clears or runs the line', async () => {
    const { t, tab, port } = await open()
    t.emit('data', Buffer.from('\r\n<HUAWEI>'))
    tab.markUnsent('display version')
    expect(tab.unsent()).toBe('display version')
    await tick(400)
    expect(port.text()).toMatch(/may still hold "display version", typed by Hopline but not sent/)
    port.fromRenderer({ t: 'w', d: 'x' })
    expect(tab.unsent()).toBe('display version')
    port.fromRenderer({ t: 'w', d: '\x15' })
    expect(tab.unsent()).toBeNull()
    tab.markUnsent('display version')
    port.fromRenderer({ t: 'w', d: '\r' })
    expect(tab.unsent()).toBeNull()
  })
})
