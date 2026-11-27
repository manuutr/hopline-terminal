import type { ExecTarget } from '../src/session-host/executor'

/**
 * Fake device line editors for the echo check (Phase 4 fix-round review E1–E6): IOS `$` scrolling
 * (backspace and CR forms), the readline/libedit wrap, logging synchronous redraws, dropped
 * characters, a clear key taken literally, devices that never echo, and 1-byte delivery.
 */
export interface LineDeviceOptions {
  prompt?: string
  /** IOS `$` scrolling: input columns before the line scrolls (10 at a time). */
  width?: number
  form?: 'bs' | 'cr'
  /** readline/libedit wrap at this terminal width (` \r` at the wrap column). */
  wrapCols?: number
  /** Drop the n-th typed character (0-based, counted over the whole session). */
  drop?: number
  /** Ctrl-U: erases the line (default), is shown and kept as text (`^U`), or does nothing. */
  ctrlU?: 'erase' | 'literal' | 'ignore'
  /** Keys that erase one character (default DEL and backspace). */
  eraseKeys?: string[]
  /** The device echoes typed characters (default true). */
  echo?: boolean
  /** After this many typed characters, a syslog line is printed; `sync`: the prompt and line are redrawn after it. */
  logAfter?: number
  logSync?: boolean
}

export class LineDevice {
  line = ''
  offset = 0
  typed = 0
  logged = false
  readonly ran: string[] = []
  constructor(readonly o: LineDeviceOptions = {}) {}

  get prompt(): string {
    return this.o.prompt ?? 'core-sw1#'
  }

  private window(): string {
    return this.offset ? '$' + this.line.slice(this.offset + 1) : this.line
  }

  /** The bytes the device writes for one key. */
  key(ch: string): string {
    const echo = this.o.echo !== false
    if (ch === '\r') {
      const l = this.line
      this.line = ''
      this.offset = 0
      this.ran.push(l)
      return `\r\n${l ? `output of ${l}\r\n` : ''}${this.prompt}`
    }
    if (ch === '\x15') {
      const mode = this.o.ctrlU ?? 'erase'
      if (mode === 'ignore') return ''
      if (mode === 'literal') return this.insert('\x15', '^U')
      this.line = ''
      this.offset = 0
      return echo ? `\r${this.prompt}\x1b[K` : ''
    }
    if ((this.o.eraseKeys ?? ['\x7f', '\b']).includes(ch)) {
      if (!this.line) return echo ? '\x07' : ''
      this.line = this.line.slice(0, -1)
      if (!echo) return ''
      if (this.offset && this.line.length - this.offset < (this.o.width ?? Infinity) - 10) {
        this.offset = Math.max(0, this.offset - 10)
        return `\r${this.prompt}${this.window()}\x1b[K`
      }
      return '\b \b'
    }
    if (ch < ' ' || ch === '\x7f') return ''
    const n = this.typed++
    if (n === this.o.drop) return ''
    let out = this.insert(ch, ch)
    if (this.o.logAfter !== undefined && !this.logged && this.typed >= this.o.logAfter) {
      this.logged = true
      out += '\r\n*Nov 25 10:00:00: %LINK-3-UPDOWN: Interface Gi1/0/1, changed state to up\r\n'
      if (this.o.logSync) out += this.prompt + this.window()
    }
    return out
  }

  private insert(stored: string, shown: string): string {
    const echo = this.o.echo !== false
    this.line += stored
    if (!echo) return ''
    const width = this.o.width
    if (width !== undefined && this.line.length - this.offset >= width) {
      const old = this.line.length - stored.length - this.offset
      this.offset += 10
      const w = this.window()
      const pad = Math.max(0, old - w.length)
      const head = this.o.form === 'cr' ? `\r${this.prompt}` : '\b'.repeat(old)
      return head + w + ' '.repeat(pad) + '\b'.repeat(pad)
    }
    const cols = this.o.wrapCols
    if (cols) {
      let out = ''
      for (const c of shown) {
        out += c
        const col = this.prompt.length + this.line.length
        if (col % cols === 0) out += ' \r'
      }
      return out
    }
    return shown
  }
}

/** What an IOS-style device echoes for `cmd` typed in one go. */
export function iosScrollEcho(cmd: string, o: { width: number; form: 'bs' | 'cr'; prompt: string; drop?: number }): string {
  const d = new LineDevice({ prompt: o.prompt, width: o.width, form: o.form, drop: o.drop })
  return [...cmd].map((c) => d.key(c)).join('')
}

/** An ExecTarget around a LineDevice: sends are answered after a tick, optionally one byte at a time. */
export function lineTab(o: LineDeviceOptions & { chunk?: number; cols?: number; echoes?: boolean } = {}) {
  const dev = new LineDevice(o)
  const taps = new Set<(t: string) => void>()
  const sent: string[] = []
  let unsent: string | null = null
  const tab = {
    connected: true,
    tail: `\r\n${dev.prompt}`,
    lock: null as ExecTarget['lock'],
    dev,
    sent,
    notices: [] as string[],
    addTap: (fn: (t: string) => void) => (taps.add(fn), () => void taps.delete(fn)),
    width: () => o.cols ?? 80,
    echoes: () => o.echoes,
    unsent: () => unsent,
    markUnsent: (text: string) => void (unsent = text),
    clearUnsent: () => void (unsent = null),
    send(data: string) {
      sent.push(data)
      const out = [...data].map((c) => dev.key(c)).join('')
      if (!out) return
      const size = o.chunk ?? out.length
      const pieces: string[] = []
      for (let i = 0; i < out.length; i += size) pieces.push(out.slice(i, i + size))
      let delay = 2
      for (const p of pieces) {
        setTimeout(() => {
          tab.tail = (tab.tail + p).slice(-16384)
          for (const f of taps) f(p)
        }, delay)
        delay += size === 1 ? 0 : 1
      }
    }
  }
  return tab
}
