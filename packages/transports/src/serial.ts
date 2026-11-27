/**
 * Serial console transport (RS-232 / USB-serial / USB console ports) built on `serialport` 13.
 *
 * Testing
 * -------
 * Unit tests inject `@serialport/binding-mock` through the `binding` option (see
 * `test/serial.test.ts`); one test also runs the default native binding against a missing port.
 *
 * Platform limits of the native binding: on Linux and macOS, `mark`/`space` parity and 1.5 stop
 * bits are rejected at open (mapped to a `protocol` TransportError). Windows supports them.
 *
 * Virtual PTY pair (Linux/macOS, usable in CI):
 *
 *     socat -d -d pty,raw,echo=0 pty,raw,echo=0
 *     # socat prints two paths, e.g. /dev/pts/3 and /dev/pts/4
 *
 * Open one end with `new SerialTransport({ path: '/dev/pts/3', baudRate: 9600, ... })` and talk to
 * the other with `cat /dev/pts/4` / `echo hi > /dev/pts/4` or a second transport. PTYs ignore baud,
 * parity and flow settings, and BREAK / DTR / RTS ioctls may fail or be no-ops on a PTY, so test
 * `sendBreak` and `setSignals` on real hardware. On Windows use a com0com pair instead.
 *
 * Real hardware: plug in a USB console cable (FTDI, PL2303, CP210x, CH340 or a Cisco USB console)
 * and connect to a switch at 9600 8N1, no flow control. On Linux the user must be in `dialout`
 * (Debian/Ubuntu/Fedora) or `uucp` (Arch); use `/dev/cu.*` rather than `/dev/tty.*` on macOS. A
 * Cisco device in ROMMON confirms BREAK works: power-cycle it and call `sendBreak()` within the
 * first ~60 s of boot.
 */
import { EventEmitter } from 'node:events'
import { SerialPortStream } from '@serialport/stream'
import { TransportError, type TermSize, type Transport, type TransportErrorCode } from './types'

/**
 * Port metadata as returned by a binding's `list()` (`PortInfo` in `@serialport/bindings-interface`).
 *
 * The binding types are declared structurally here instead of being imported: the published
 * `@serialport/bindings-interface` and `@serialport/binding-mock` packages have an `exports` map
 * that hides their `.d.ts` from `moduleResolution: "Bundler"` (TS7016), and importing them would
 * break the typecheck of every consumer of this package.
 */
export interface SerialPortInfo {
  path: string
  manufacturer?: string | undefined
  serialNumber?: string | undefined
  pnpId?: string | undefined
  locationId?: string | undefined
  productId?: string | undefined
  vendorId?: string | undefined
}

/** Any `serialport` binding (the native auto-detected one, or `@serialport/binding-mock`). */
export interface SerialBinding {
  list(): Promise<SerialPortInfo[]>
  open(options: { path: string; baudRate: number } & Record<string, unknown>): Promise<object>
}

export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space'
export type SerialFlow = 'none' | 'rtscts' | 'xonxoff'

export interface SerialOptions {
  /** `COM7` on Windows, `/dev/ttyUSB0` on Linux, `/dev/cu.usbserial-XXXX` on macOS. */
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: SerialParity
  stopBits: 1 | 1.5 | 2
  flow: SerialFlow
  /** Assert DTR after opening. Left untouched (normally asserted by the OS) when omitted. */
  dtr?: boolean
  /** Assert RTS after opening. Left untouched (normally asserted by the OS) when omitted. */
  rts?: boolean
  /** Default BREAK length for `sendBreak()`. Cisco wants ~300 ms or more. */
  breakMs?: number
  /** Injected for tests. Defaults to the auto-detected native binding from `serialport`. */
  binding?: SerialBinding
}

export const DEFAULT_BREAK_MS = 300

/** Why opening a port failed, a finer split than `TransportErrorCode`. */
export type SerialOpenFailure = 'not-found' | 'access-denied' | 'busy' | 'other'

/** A `TransportError` from `SerialTransport.connect()` that also says which serial failure it was. */
export class SerialOpenError extends TransportError {
  constructor(
    code: TransportErrorCode,
    readonly failure: SerialOpenFailure,
    message: string,
    cause?: unknown
  ) {
    super(code, message, cause)
    this.name = 'SerialOpenError'
  }
}

/**
 * Maps a `serialport` open error to a `TransportError`. Pure, so it can be tested with the native
 * messages of every platform:
 * - unix: `Error: <strerror>, cannot open <path>` and `Error Resource temporarily unavailable Cannot lock port`
 * - windows: `Opening COM7: File not found` / `Opening COM7: Access denied`
 * - mock: `Port does not exist ...` / `Port is locked cannot open`
 */
export function mapSerialOpenError(err: unknown, path: string, platform: NodeJS.Platform = process.platform): SerialOpenError {
  const raw = err instanceof Error ? err.message : String(err)
  const msg = raw.toLowerCase()
  const code = (err as { code?: unknown } | null)?.code

  const notFound =
    code === 'ENOENT' ||
    msg.includes('no such file or directory') ||
    msg.includes('file not found') ||
    msg.includes('no such device') || // ENXIO "No such device or address", ENODEV
    msg.includes('does not exist')
  if (notFound) {
    return new SerialOpenError(
      'unreachable',
      'not-found',
      `Serial port ${path} not found. Check the cable is plugged in and pick the port again (USB adapters can change name when replugged).`,
      err
    )
  }

  // Windows reports a port held by another program (PuTTY, SecureCRT) as "Access denied".
  if (platform === 'win32' && msg.includes('access denied')) {
    return new SerialOpenError(
      'refused',
      'busy',
      `Serial port ${path} is in use by another program (or access was denied). Close other terminal apps using it and try again.`,
      err
    )
  }

  const busy =
    code === 'EBUSY' ||
    msg.includes('cannot lock port') ||
    msg.includes('resource temporarily unavailable') ||
    msg.includes('resource busy') || // linux "Device or resource busy", darwin "Resource busy"
    msg.includes('port is locked')
  if (busy) {
    return new SerialOpenError('refused', 'busy', `Serial port ${path} is in use by another program. Close it and try again.`, err)
  }

  const denied =
    code === 'EACCES' || code === 'EPERM' || msg.includes('permission denied') || msg.includes('access denied') || msg.includes('operation not permitted')
  if (denied) {
    let hint = ''
    if (platform === 'linux') {
      hint =
        ' Add your user to the serial group and log out and back in: `sudo usermod -aG dialout $USER` (Debian, Ubuntu, Fedora) or `sudo usermod -aG uucp $USER` (Arch). Snap/Flatpak builds also need serial-port permission.'
    } else if (platform === 'darwin') {
      hint = ' Use the /dev/cu.* device rather than /dev/tty.*, and check no other app has it open.'
    }
    return new SerialOpenError('other', 'access-denied', `Permission denied opening serial port ${path}.${hint}`, err)
  }

  // The unix bindings support only none/even/odd parity and 1 or 2 stop bits (Windows supports all).
  if (msg.includes('invalid parity') || msg.includes('invalid stop bits') || msg.includes('invalid data bits')) {
    return new SerialOpenError('protocol', 'other', `Serial settings not supported for ${path} on this OS: ${raw}`, err)
  }

  return new SerialOpenError('other', 'other', `Could not open serial port ${path}: ${raw}`, err)
}

function describeFrame(o: SerialOptions): string {
  const parity = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[o.parity]
  const flow = o.flow === 'none' ? '' : `, ${o.flow === 'rtscts' ? 'RTS/CTS' : 'XON/XOFF'}`
  return `${o.baudRate} ${o.dataBits}${parity}${o.stopBits}${flow}`
}

async function defaultBinding(): Promise<SerialBinding> {
  // Lazy: loading the native addon costs startup time and isn't needed until a port is used.
  const { SerialPort } = await import('serialport')
  return SerialPort.binding as SerialBinding
}

type State = 'idle' | 'connecting' | 'open' | 'closed'

export class SerialTransport extends EventEmitter implements Transport {
  readonly kind = 'serial' as const
  private readonly opts: SerialOptions
  private port: SerialPortStream<SerialBinding> | null = null
  private state: State = 'idle'
  private userEnded = false
  private lastError: Error | null = null
  /** `SerialPortStream.set()` resets unnamed lines to defaults, so we always send all three. */
  private signals = { dtr: true, rts: true, brk: false }
  private signalWrites: Promise<void> = Promise.resolve()
  private breakChain: Promise<void> = Promise.resolve()
  /** Set while connect() sets up an opened port; called if the port closes meanwhile. */
  private wakeConnect: (() => void) | undefined
  /** Why the port closed while connect() was still setting it up. */
  private connectCloseCause: Error | null = null

  constructor(opts: SerialOptions) {
    super()
    if (!opts.path) throw new TypeError('SerialTransport: path is required')
    if (!Number.isInteger(opts.baudRate) || opts.baudRate <= 0) throw new TypeError(`SerialTransport: invalid baudRate ${opts.baudRate}`)
    if (opts.breakMs !== undefined && !(opts.breakMs > 0)) throw new TypeError(`SerialTransport: invalid breakMs ${opts.breakMs}`)
    this.opts = { ...opts }
  }

  /** Current modem-control line state as last set by this transport. */
  get lines(): { dtr: boolean; rts: boolean; brk: boolean } {
    return { ...this.signals }
  }

  async connect(): Promise<void> {
    if (this.state !== 'idle') throw new TransportError('other', `SerialTransport.connect() called in state ${this.state}`)
    this.state = 'connecting'
    const o = this.opts
    let binding: SerialBinding
    try {
      binding = o.binding ?? (await defaultBinding())
    } catch (err) {
      this.state = 'closed'
      throw new TransportError('other', `Could not load the serialport native module (@serialport/bindings-cpp): ${(err as Error).message}`, err)
    }

    let port: SerialPortStream<SerialBinding>
    try {
      port = new SerialPortStream<SerialBinding>({
        binding,
        path: o.path,
        baudRate: o.baudRate,
        dataBits: o.dataBits,
        parity: o.parity,
        stopBits: o.stopBits,
        rtscts: o.flow === 'rtscts',
        xon: o.flow === 'xonxoff',
        xoff: o.flow === 'xonxoff',
        autoOpen: false
      })
    } catch (err) {
      this.state = 'closed'
      throw new TransportError('other', `Invalid serial settings for ${o.path}: ${(err as Error).message}`, err)
    }
    this.port = port

    try {
      await new Promise<void>((resolve, reject) => port.open(err => (err ? reject(err) : resolve())))
    } catch (err) {
      this.state = 'closed'
      this.port = null
      if (this.userEnded) throw new TransportError('cancelled', 'Serial connect cancelled', err)
      throw mapSerialOpenError(err, o.path)
    }

    port.on('data', (chunk: Buffer) => this.emit('data', chunk))
    port.on('error', (err: Error) => {
      // Never let an 'error' go unhandled: it would crash the session host.
      this.lastError = err
      if (this.state === 'open') this.emit('notice', `Serial error: ${err.message}`)
    })
    port.on('close', (err?: Error | null) => this.onPortClose(err ?? null))

    // Stay 'connecting' until set-up is done: an unplug or end() in between must make connect()
    // reject (and emit no 'close' for a session that never opened), not resolve on a dead port.
    if (!this.userEnded && (o.dtr !== undefined || o.rts !== undefined)) {
      const closed = new Promise<void>(r => (this.wakeConnect = r))
      try {
        // Race the port closing: a set() on a vanished device may never call back.
        await Promise.race([this.applySignals(o), closed])
      } catch (err) {
        if (this.state === 'connecting') this.emit('notice', `Could not set DTR/RTS: ${(err as Error).message}`)
      } finally {
        this.wakeConnect = undefined
      }
    }

    if (this.state !== 'connecting' || this.userEnded) {
      // The port closed during set-up, or end() was called while we were opening.
      const cause = this.connectCloseCause
      this.abortConnect()
      if (this.userEnded) throw new TransportError('cancelled', 'Serial connect cancelled', cause ?? undefined)
      const why = cause ? `: ${cause.message}` : ''
      throw new TransportError('unreachable', `Serial port ${o.path} closed while connecting${why}. Was the USB adapter unplugged?`, cause ?? undefined)
    }

    this.state = 'open'
    this.emit('notice', `Opened ${o.path} at ${describeFrame(o)}`)
  }

  /** Give up a connect() whose port is (or must be) closed, without emitting 'close'. */
  private abortConnect(): void {
    const port = this.port
    this.state = 'closed'
    this.port = null
    if (!port) return
    port.removeAllListeners('data')
    // Our 'close' listener sees state 'closed' and stays quiet; keep an 'error' listener attached.
    if (port.isOpen) port.close(() => undefined)
  }

  write(data: Buffer | string): void {
    if (this.state !== 'open' || !this.port) return
    this.port.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
  }

  /** Serial lines have no window size. */
  resize(_size: TermSize): void {}

  pause(): void {
    this.port?.pause()
  }

  resume(): void {
    this.port?.resume()
  }

  end(): void {
    this.userEnded = true
    if (this.state === 'open') this.closePort()
    else if (this.state === 'idle') this.state = 'closed'
    // 'connecting': connect() sees userEnded once open settles; if it is setting up an already
    // opened port, wake it now rather than waiting on DTR/RTS.
    else this.wakeConnect?.()
  }

  /** Assert BREAK for `ms` (default `breakMs`, 300 ms): ROMMON entry, password recovery. */
  sendBreak(ms: number = this.opts.breakMs ?? DEFAULT_BREAK_MS): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.state !== 'open' || !this.port) throw new TransportError('other', 'Serial port is not open')
      try {
        await this.applySignals({ brk: true })
        await new Promise<void>(r => setTimeout(r, ms))
      } finally {
        if (this.state === 'open') await this.applySignals({ brk: false })
      }
      this.emit('notice', `Sent BREAK (${ms} ms)`)
    }
    // Serialise overlapping breaks so one can't release another's BREAK early.
    const p = this.breakChain.then(run, run)
    this.breakChain = p.catch(() => undefined)
    return p
  }

  async setSignals(s: { dtr?: boolean; rts?: boolean }): Promise<void> {
    if (this.state !== 'open' || !this.port) throw new TransportError('other', 'Serial port is not open')
    return this.applySignals(s)
  }

  private applySignals(change: { dtr?: boolean; rts?: boolean; brk?: boolean }): Promise<void> {
    // Each set writes all three lines. Base it on the last successful write to avoid
    // reapplying a refused change when another request is already waiting.
    const write = this.signalWrites.then(async () => {
      const port = this.port
      if (!port?.isOpen) throw new TransportError('other', 'Serial port is not open')
      const next = {
        dtr: change.dtr ?? this.signals.dtr,
        rts: change.rts ?? this.signals.rts,
        brk: change.brk ?? this.signals.brk
      }
      await new Promise<void>((resolve, reject) => port.set(next, err => (err ? reject(err) : resolve())))
      this.signals = next
    })
    this.signalWrites = write.catch(() => undefined)
    return write
  }

  private closePort(): void {
    const port = this.port
    if (!port) return
    if (port.isOpen) {
      // Callback form so "Port is not open" races don't surface as 'error'.
      port.close(err => {
        // A failed close emits no 'close' event; make sure ours still fires.
        if (err) this.onPortClose(null)
      })
    } else {
      this.onPortClose(null)
    }
  }

  private onPortClose(err: Error | null): void {
    if (this.state === 'closed') return
    if (this.state === 'connecting') {
      // connect() is still setting up: it rejects; a session that never opened emits no 'close'.
      this.connectCloseCause = err ?? this.lastError
      this.state = 'closed'
      this.wakeConnect?.()
      return
    }
    this.state = 'closed'
    const port = this.port
    this.port = null
    port?.removeAllListeners('data')
    if (this.userEnded) {
      this.emit('close')
      return
    }
    const cause = err ?? this.lastError
    const disconnected = (cause as { disconnected?: boolean } | null)?.disconnected === true
    const reason = disconnected
      ? `Serial device disconnected (${cause?.message}). Was the USB adapter unplugged?`
      : cause
        ? `Serial port closed: ${cause.message}`
        : 'Serial port closed unexpectedly'
    this.emit('close', reason)
  }
}
