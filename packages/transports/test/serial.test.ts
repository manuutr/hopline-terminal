import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockBinding, type MockPortBinding } from '@serialport/binding-mock'
import { SerialTransport, SerialOpenError, mapSerialOpenError, type SerialBinding, type SerialOptions } from '../src/serial'
import { friendlyName, labelSerialPorts, listSerialPorts, watchSerialPorts } from '../src/serial-ports'
import { TransportError } from '../src/types'

const PATH = '/dev/ttyUSB0'

/** Wraps the mock binding so tests can reach the opened port (to spy on set() or simulate unplug). */
function harness() {
  const opened: MockPortBinding[] = []
  const setSpies: { mock: { calls: unknown[][] } }[] = []
  const binding: SerialBinding = {
    list: () => MockBinding.list(),
    open: async options => {
      const port = await MockBinding.open(options)
      setSpies.push(vi.spyOn(port, 'set'))
      opened.push(port)
      return port
    }
  }
  return {
    binding,
    /** Arguments of every set() on the most recently opened port, including during connect(). */
    setCalls(): unknown[] {
      return (setSpies.at(-1)?.mock.calls ?? []).map(c => c[0])
    },
    port(): MockPortBinding {
      const p = opened.at(-1)
      if (!p) throw new Error('no port opened')
      return p
    }
  }
}

function make(binding: SerialBinding, over: Partial<SerialOptions> = {}): SerialTransport {
  return new SerialTransport({ path: PATH, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', binding, ...over })
}

/** Lets promise/nextTick work settle without moving (fake) timers; vi.waitFor would advance them. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>(r => process.nextTick(r))
}

function nextClose(t: SerialTransport): Promise<unknown[]> {
  return new Promise(resolve => t.once('close', (...args: unknown[]) => resolve(args)))
}

beforeEach(() => {
  MockBinding.reset()
  MockBinding.createPort(PATH, { echo: false, record: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SerialTransport open/close', () => {
  it('opens the port, reports a notice, and end() closes it with no reason', async () => {
    const h = harness()
    const t = make(h.binding)
    const notices: string[] = []
    t.on('notice', (n: string) => notices.push(n))
    await t.connect()
    expect(t.kind).toBe('serial')
    expect(h.port().isOpen).toBe(true)
    expect(notices).toContain(`Opened ${PATH} at 9600 8N1`)

    const closed = nextClose(t)
    t.end()
    expect(await closed).toEqual([])
    expect(h.port().isOpen).toBe(false)
  })

  it('end() before connect() completes cancels the connect', async () => {
    const h = harness()
    const t = make(h.binding)
    const p = t.connect()
    t.end()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('resize is a no-op', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    expect(() => t.resize({ cols: 80, rows: 24 })).not.toThrow()
    t.end()
  })
})

describe('data', () => {
  it('writes to the device and emits data from it', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()

    t.write('show version\r')
    await vi.waitFor(() => expect(h.port().lastWrite?.toString()).toBe('show version\r'))
    t.write(Buffer.from([0x03]))
    await vi.waitFor(() => expect(h.port().lastWrite).toEqual(Buffer.from([0x03])))

    const got: Buffer[] = []
    t.on('data', (b: Buffer) => got.push(b))
    h.port().emitData('Router>')
    await vi.waitFor(() => expect(Buffer.concat(got).toString()).toBe('Router>'))
    t.end()
  })

  it('pause() stops data events until resume()', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    const got: Buffer[] = []
    t.on('data', (b: Buffer) => got.push(b))

    t.pause()
    h.port().emitData('held')
    await new Promise(r => setTimeout(r, 20))
    expect(got).toHaveLength(0)

    t.resume()
    await vi.waitFor(() => expect(Buffer.concat(got).toString()).toBe('held'))
    t.end()
  })

  it('ignores writes when not open', async () => {
    const h = harness()
    const t = make(h.binding)
    expect(() => t.write('x')).not.toThrow()
  })
})

describe('line settings', () => {
  it('passes framing and RTS/CTS flow control through to the binding', async () => {
    const h = harness()
    const t = make(h.binding, { baudRate: 115200, dataBits: 7, parity: 'even', stopBits: 2, flow: 'rtscts' })
    await t.connect()
    expect(h.port().openOptions).toMatchObject({ baudRate: 115200, dataBits: 7, parity: 'even', stopBits: 2, rtscts: true, xon: false, xoff: false })
    t.end()
  })

  it('passes XON/XOFF flow control through to the binding', async () => {
    const h = harness()
    const t = make(h.binding, { flow: 'xonxoff', parity: 'mark', stopBits: 1.5, dataBits: 5 })
    await t.connect()
    expect(h.port().openOptions).toMatchObject({ rtscts: false, xon: true, xoff: true, parity: 'mark', stopBits: 1.5, dataBits: 5 })
    t.end()
  })

  it('no flow control disables both', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    expect(h.port().openOptions).toMatchObject({ rtscts: false, xon: false, xoff: false })
    t.end()
  })

  it('applies initial DTR/RTS from options after opening', async () => {
    const h = harness()
    const t = make(h.binding, { dtr: false })
    await t.connect()
    expect(h.setCalls()).toEqual([{ dtr: false, rts: true, brk: false, cts: false }])
    expect(t.lines).toEqual({ dtr: false, rts: true, brk: false })
    t.end()
  })
})

describe('sendBreak', () => {
  it('asserts BREAK for the default 300 ms, then releases it', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    const set = vi.spyOn(h.port(), 'set')
    set.mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const done = t.sendBreak()
    await flush()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[0]).toMatchObject({ brk: true })

    await vi.advanceTimersByTimeAsync(299)
    expect(set).toHaveBeenCalledTimes(1)
    expect(t.lines.brk).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[1]?.[0]).toMatchObject({ brk: false })
    expect(t.lines.brk).toBe(false)
    vi.useRealTimers()
    t.end()
  })

  it('uses an explicit length and the breakMs option', async () => {
    const h = harness()
    const t = make(h.binding, { breakMs: 500 })
    await t.connect()
    const set = vi.spyOn(h.port(), 'set')
    set.mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const a = t.sendBreak()
    await flush()
    expect(set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await a
    expect(set).toHaveBeenCalledTimes(2)

    const b = t.sendBreak(1000)
    await flush()
    expect(set).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(999)
    expect(set).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    await b
    expect(set).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
    t.end()
  })

  it('keeps DTR/RTS as they were while toggling BREAK', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    await t.setSignals({ rts: false })
    const set = vi.spyOn(h.port(), 'set')
    set.mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const done = t.sendBreak(100)
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(set.mock.calls.map(c => c[0])).toEqual([
      { dtr: true, rts: false, brk: true, cts: false },
      { dtr: true, rts: false, brk: false, cts: false }
    ])
    vi.useRealTimers()
    t.end()
  })

  it('rejects when the port is not open', async () => {
    const t = make(harness().binding)
    await expect(t.sendBreak()).rejects.toBeInstanceOf(TransportError)
  })
})

describe('setSignals', () => {
  it('sets DTR and RTS, keeping the line not named', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    const set = vi.spyOn(h.port(), 'set')
    set.mockClear()

    await t.setSignals({ dtr: false })
    expect(set).toHaveBeenLastCalledWith({ dtr: false, rts: true, brk: false, cts: false })
    await t.setSignals({ rts: false })
    expect(set).toHaveBeenLastCalledWith({ dtr: false, rts: false, brk: false, cts: false })
    await t.setSignals({ dtr: true, rts: true })
    expect(set).toHaveBeenLastCalledWith({ dtr: true, rts: true, brk: false, cts: false })
    t.end()
  })

  it('rejects when the port is not open', async () => {
    const t = make(harness().binding)
    await expect(t.setSignals({ dtr: false })).rejects.toBeInstanceOf(TransportError)
  })

  it('keeps the previous line state when the port refuses the change', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    vi.spyOn(h.port(), 'set').mockRejectedValueOnce(new Error('Inappropriate ioctl for device'))
    await expect(t.setSignals({ dtr: false })).rejects.toThrow(/ioctl/)
    expect(t.lines).toEqual({ dtr: true, rts: true, brk: false })
    t.end()
  })

  it('a refused DTR change does not carry into the next RTS write', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    const set = vi.spyOn(h.port(), 'set').mockRejectedValueOnce(new Error('DTR refused'))
    const dtr = t.setSignals({ dtr: false })
    const rts = t.setSignals({ rts: false })
    await expect(dtr).rejects.toThrow('DTR refused')
    await rts
    expect(set).toHaveBeenLastCalledWith({ dtr: true, rts: false, brk: false, cts: false })
    expect(t.lines).toEqual({ dtr: true, rts: false, brk: false })
    t.end()
  })
})

describe('open errors', () => {
  it('maps a missing port to unreachable', async () => {
    const t = make(harness().binding, { path: '/dev/ttyUSB9' })
    const err = await t.connect().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect(err).toBeInstanceOf(SerialOpenError)
    expect(err).toMatchObject({ code: 'unreachable', failure: 'not-found' })
    expect((err as Error).message).toContain('/dev/ttyUSB9')
  })

  it('uses the native binding by default and maps its missing-port error', async () => {
    // A name the platform's binding would actually try to open: COMx on Windows, a device node elsewhere.
    const path = process.platform === 'win32' ? 'COM250' : '/dev/hopline-no-such-port'
    const t = new SerialTransport({ path, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none' })
    const err = await t.connect().catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'unreachable', failure: 'not-found' })
  })

  it('maps a port held by someone else to refused (busy)', async () => {
    const h = harness()
    const first = make(h.binding)
    await first.connect()
    const second = make(h.binding)
    await expect(second.connect()).rejects.toMatchObject({ code: 'refused', failure: 'busy' })
    first.end()
  })

  it.each([
    ['Error: No such file or directory, cannot open /dev/ttyUSB0', 'linux', 'unreachable', 'not-found'],
    ['Error: No such device or address, cannot open /dev/ttyACM0', 'linux', 'unreachable', 'not-found'],
    ['Opening COM7: File not found', 'win32', 'unreachable', 'not-found'],
    ['Opening COM7: Access denied', 'win32', 'refused', 'busy'],
    ['Error Resource temporarily unavailable Cannot lock port', 'linux', 'refused', 'busy'],
    ['Error: Device or resource busy, cannot open /dev/ttyS0', 'linux', 'refused', 'busy'],
    ['Error: Permission denied, cannot open /dev/ttyUSB0', 'linux', 'other', 'access-denied'],
    ['Error: Permission denied, cannot open /dev/cu.usbserial-1', 'darwin', 'other', 'access-denied'],
    ['Error: Resource busy, cannot open /dev/cu.usbserial-1', 'darwin', 'refused', 'busy'],
    ['Invalid parity setting 3', 'linux', 'protocol', 'other'],
    ['Invalid stop bits setting 2', 'darwin', 'protocol', 'other'],
    ['Error: Input/output error, cannot open /dev/ttyS4', 'linux', 'other', 'other']
  ] as const)('%s (%s) -> %s/%s', (message, platform, code, failure) => {
    const e = mapSerialOpenError(new Error(message), '/dev/x', platform)
    expect(e).toMatchObject({ code, failure })
    expect(e.permanent).toBe(false)
  })

  it('mentions the dialout group for Linux permission errors', () => {
    const e = mapSerialOpenError(new Error('Error: Permission denied, cannot open /dev/ttyUSB0'), '/dev/ttyUSB0', 'linux')
    expect(e.message).toContain('dialout')
    expect(e.message).toContain('usermod -aG')
    expect(mapSerialOpenError(new Error('Error: Permission denied'), 'x', 'darwin').message).not.toContain('dialout')
  })
})

describe('unplug', () => {
  it('emits close with a reason when reads start failing (USB adapter unplugged)', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    t.on('data', () => undefined) // reads are in flight
    const closed = nextClose(t)

    const port = h.port()
    port.read = () => Promise.reject(Object.assign(new Error('Input/output error'), { code: 'EIO' }))
    port.emitData('') // wake the pending read, which now fails

    const [reason] = await closed
    expect(typeof reason).toBe('string')
    expect(reason).toMatch(/disconnected/i)
    expect(reason).toContain('Input/output error')
    // write/end after unplug are harmless
    expect(() => t.write('x')).not.toThrow()
    expect(() => t.end()).not.toThrow()
  })

  it('emits close with a reason (once) when writes start failing', async () => {
    const h = harness()
    const t = make(h.binding)
    await t.connect()
    const closes: unknown[][] = []
    t.on('close', (...a: unknown[]) => closes.push(a))

    h.port().write = () => Promise.reject(new Error('Input/output error'))
    t.write('x')

    await vi.waitFor(() => expect(closes).toHaveLength(1))
    await new Promise(r => setTimeout(r, 20))
    expect(closes).toHaveLength(1)
    expect(closes[0]?.[0]).toMatch(/Input\/output error/)
    expect(closes[0]?.[0]).toMatch(/disconnected/i)
  })
})

describe('unplug or end() while connect() sets DTR/RTS', () => {
  /** A binding whose port runs `onSet` instead of the mock's set() (the DTR/RTS call in connect()). */
  function withSet(onSet: (port: MockPortBinding) => Promise<void>): { binding: SerialBinding; port: () => MockPortBinding } {
    let last: MockPortBinding | undefined
    return {
      binding: {
        list: () => MockBinding.list(),
        open: async options => {
          const port = await MockBinding.open(options)
          port.set = () => onSet(port)
          last = port
          return port
        }
      },
      port: () => last!
    }
  }

  function watch(t: SerialTransport): { closes: unknown[][]; notices: string[] } {
    const closes: unknown[][] = []
    const notices: string[] = []
    t.on('close', (...a: unknown[]) => closes.push(a))
    t.on('notice', (n: string) => notices.push(n))
    return { closes, notices }
  }

  const unplug = (port: MockPortBinding): void => {
    port.read = () => Promise.reject(Object.assign(new Error('Input/output error'), { code: 'EIO' }))
    port.emitData('') // wake a pending read, which now fails
  }

  it.each([
    ['set() never calls back', () => new Promise<void>(() => {})],
    ['set() succeeds afterwards', () => new Promise<void>(r => setTimeout(r, 30))]
  ] as const)('an unplug rejects connect() with "unreachable" (%s)', async (_name, settle) => {
    const h = withSet(port => {
      unplug(port)
      return settle()
    })
    const t = make(h.binding, { dtr: true })
    const { closes, notices } = watch(t)
    const err = await t.connect().then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(TransportError)
    expect(err).toMatchObject({ code: 'unreachable' })
    expect((err as Error).message).toMatch(/closed while connecting/)
    await new Promise(r => setTimeout(r, 50))
    expect(closes).toEqual([])
    expect(notices.some(n => n.startsWith('Opened'))).toBe(false)
    expect(() => t.write('x')).not.toThrow()
  })

  it.each([
    ['set() succeeds after end()', (end: () => void) => (end(), Promise.resolve())],
    ['set() never calls back', (end: () => void) => (setTimeout(end, 5), new Promise<void>(() => {}))]
  ] as const)('end() rejects connect() with "cancelled" and closes the port (%s)', async (_name, settle) => {
    let t!: SerialTransport
    const h = withSet(() => settle(() => t.end()))
    t = make(h.binding, { rts: false })
    const { closes, notices } = watch(t)
    await expect(t.connect()).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(h.port().isOpen).toBe(false))
    await new Promise(r => setTimeout(r, 30))
    expect(closes).toEqual([])
    expect(notices.some(n => n.startsWith('Opened'))).toBe(false)
  })
})

describe('port list labelling', () => {
  const info = (o: { path: string; manufacturer?: string; vendorId?: string; productId?: string; serialNumber?: string; pnpId?: string }) => ({
    manufacturer: undefined,
    serialNumber: undefined,
    pnpId: undefined,
    locationId: undefined,
    vendorId: undefined,
    productId: undefined,
    ...o
  })

  it('names common USB-serial chips', () => {
    expect(friendlyName('0403', '6001', 'FTDI')).toBe('FTDI FT232R')
    expect(friendlyName('067B', '2303', 'Prolific Technology Inc.')).toBe('Prolific PL2303')
    expect(friendlyName('10c4', 'EA60', 'Silicon Labs')).toBe('Silicon Labs CP210x')
    expect(friendlyName('1a86', '7523', undefined)).toBe('WCH CH340')
    expect(friendlyName('05A6', '0001', undefined)).toBe('Cisco USB console')
    expect(friendlyName('05a6', '0002', undefined)).toBe('Cisco USB console')
    expect(friendlyName('0403', 'ffff', undefined)).toBe('FTDI USB-serial')
    expect(friendlyName('0403', '6001', 'Juniper Networks')).toBe('Juniper console cable')
    expect(friendlyName('0403', '6015', 'Arista Networks')).toBe('Arista console cable')
    expect(friendlyName('dead', 'beef', 'Acme')).toBeUndefined()
    expect(friendlyName(undefined, undefined, undefined)).toBeUndefined()
  })

  it('builds labelled entries, USB first, with normalised ids', () => {
    const out = labelSerialPorts(
      [
        info({ path: '/dev/ttyS0' }),
        info({ path: '/dev/ttyUSB1', manufacturer: 'Prolific Technology Inc.', vendorId: '067b', productId: '2303' }),
        info({ path: '/dev/ttyUSB0', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', serialNumber: 'A50285BI' }),
        info({ path: '/dev/ttyACM0', vendorId: '5a6', productId: '1' })
      ],
      'linux'
    )
    expect(out).toEqual([
      { path: '/dev/ttyACM0', label: 'Cisco USB console (ttyACM0)', vendorId: '05a6', productId: '0001', isUsb: true },
      { path: '/dev/ttyUSB0', label: 'FTDI FT232R (ttyUSB0)', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', serialNumber: 'A50285BI', isUsb: true },
      { path: '/dev/ttyUSB1', label: 'Prolific PL2303 (ttyUSB1)', manufacturer: 'Prolific Technology Inc.', vendorId: '067b', productId: '2303', isUsb: true },
      { path: '/dev/ttyS0', label: 'Serial port (ttyS0)', isUsb: false }
    ])
  })

  it('falls back to the manufacturer string and keeps Windows COM names', () => {
    const out = labelSerialPorts(
      [
        info({ path: 'COM10', manufacturer: 'wch.cn', vendorId: '1A86', productId: '7523', pnpId: 'USB\\VID_1A86&PID_7523\\5&1' }),
        info({ path: 'COM3', manufacturer: 'Acme Corp', pnpId: 'USB\\VID_1234&PID_5678\\6&2' }),
        info({ path: 'COM1', manufacturer: '(Standard port types)', pnpId: 'ACPI\\PNP0501\\0' })
      ],
      'win32'
    )
    expect(out.map(p => [p.path, p.label, p.isUsb])).toEqual([
      ['COM3', 'Acme Corp (COM3)', true],
      ['COM10', 'WCH CH340 (COM10)', true],
      ['COM1', '(Standard port types) (COM1)', false]
    ])
  })

  it('prefers /dev/cu.* over /dev/tty.* on macOS and de-duplicates', () => {
    const out = labelSerialPorts(
      [
        info({ path: '/dev/tty.usbserial-A50285BI', manufacturer: 'FTDI', vendorId: '0403', productId: '6001' }),
        info({ path: '/dev/cu.usbserial-A50285BI' }),
        info({ path: '/dev/tty.Bluetooth-Incoming-Port' })
      ],
      'darwin'
    )
    expect(out.map(p => p.path)).toEqual(['/dev/cu.usbserial-A50285BI', '/dev/cu.Bluetooth-Incoming-Port'])
    expect(out[0]).toMatchObject({ label: 'FTDI FT232R (cu.usbserial-A50285BI)', vendorId: '0403' })
    // On Linux the same paths are left alone.
    expect(labelSerialPorts([info({ path: '/dev/tty.foo' })], 'linux')[0]?.path).toBe('/dev/tty.foo')
  })

  it('listSerialPorts uses the injected binding', async () => {
    MockBinding.createPort('/dev/ttyUSB3', { manufacturer: 'Silicon Labs', vendorId: '10c4', productId: 'ea60' })
    const ports = await listSerialPorts({ binding: harness().binding, platform: 'linux' })
    expect(ports.find(p => p.path === '/dev/ttyUSB3')?.label).toBe('Silicon Labs CP210x (ttyUSB3)')
  })
})

describe('watchSerialPorts', () => {
  it('reports the initial list and each change, then stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let ports = [{ path: '/dev/ttyUSB0', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', serialNumber: 'A1' }]
    const binding: SerialBinding = { list: async () => ports, open: async () => ({}) }
    const seen: string[][] = []
    const stop = watchSerialPorts(p => seen.push(p.map(x => x.path)), 1000, { binding, platform: 'linux' })

    await flush()
    expect(seen).toEqual([['/dev/ttyUSB0']])
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toHaveLength(1) // unchanged: no callback

    ports = [] // unplugged
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([['/dev/ttyUSB0'], []])

    ports = [{ path: '/dev/ttyUSB1', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', serialNumber: 'A1' }] // replugged, new name
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([['/dev/ttyUSB0'], [], ['/dev/ttyUSB1']])

    stop()
    ports = []
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveLength(3)
  })

  it('reports list errors and keeps polling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let fail = true
    const binding: SerialBinding = {
      list: async () => {
        if (fail) throw new Error('udevadm failed')
        return []
      },
      open: async () => ({})
    }
    const errors: unknown[] = []
    const seen: unknown[] = []
    const stop = watchSerialPorts(p => seen.push(p), 500, { binding, onError: e => errors.push(e) })
    await flush()
    expect(errors).toHaveLength(1)
    fail = false
    await vi.advanceTimersByTimeAsync(500)
    expect(seen).toEqual([[]])
    stop()
  })
})
