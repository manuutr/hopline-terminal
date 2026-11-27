/**
 * Generic interactive terminal for one CLI session: raw bytes in, echo/prompt/output out.
 * Line editing (cursor, history, Emacs keys), the pager, confirm prompts, abort of running
 * commands and unsolicited messages are handled here; the vendor Personality does the rest.
 */
import { tickBgp, type Device } from '../state.ts'
import type { AskOptions, Personality, PersonalityFactory, PrintOptions, PromptReason, Session } from './personality.ts'
import { runtime, type DeviceRuntime } from './runtime.ts'

export interface TerminalIO {
  write: (s: string) => void
  close: () => void
  /** Resolves once the transport has taken what was written (backpressure for streamed output). */
  drain?: () => Promise<void>
}

/**
 * A command the vendor tree doesn't know, handled before the personality (bench/test only, see
 * bench.ts). Returns false when the line isn't one of its commands.
 */
export type ExtraCommand = (line: string, t: Terminal) => Promise<boolean> | false

export interface TerminalOptions {
  rows?: number
  user?: string
  password?: string
  from?: string
  /** Extra commands tried before the personality (`SimOptions.bench`). */
  extra?: readonly ExtraCommand[]
}

const CRLF = '\r\n'
const crlf = (s: string): string => s.replace(/\r?\n/g, CRLF)

interface Pending {
  lines: string[]
  shown: number
  total: number
  resolve: () => void
}

interface Question {
  opts: AskOptions
  buf: string
  resolve: (answer: string) => void
}

export class Terminal implements Session {
  readonly d: Device
  readonly rt: DeviceRuntime
  readonly user: string
  readonly password: string
  readonly from: string
  rows: number
  pageLength: number
  private readonly io: TerminalIO
  private p!: Personality
  private line = ''
  private cursor = 0
  private history: string[] = []
  private histIdx = -1
  private busy = false
  private queue = ''
  private escape = ''
  private lastWasCR = false
  private literalNext = false
  private pager: Pending | null = null
  private pagerText = ''
  private question: Question | null = null
  private abortFlag = false
  private abortWaiters = new Set<() => void>()
  private closed = false
  private notices: string[] = []
  private unsubscribe: (() => void) | undefined
  private killed = ''
  /** The user quit the pager: drop the rest of this command's output. */
  private squelch = false
  private readonly extra: readonly ExtraCommand[]

  constructor(d: Device, io: TerminalIO, factory: PersonalityFactory, opts: TerminalOptions = {}) {
    this.d = d
    this.io = io
    this.rt = runtime(d)
    this.rows = opts.rows ?? 24
    this.pageLength = this.rows - 1
    this.user = opts.user ?? d.user
    this.password = opts.password ?? 'admin'
    this.from = opts.from ?? '10.10.10.50'
    this.extra = opts.extra ?? []
    this.p = factory(this)
  }

  get aborted(): boolean {
    return this.abortFlag
  }

  /** Resolves once no command is running (or one is waiting for an answer / a pager key) and input is drained. */
  async idle(): Promise<void> {
    while ((this.busy && !this.question && !this.pager) || this.queue) await new Promise((r) => setTimeout(r, 5))
  }

  start(): void {
    this.unsubscribe = this.rt.subscribe((text) => this.notify(text))
    const b = this.p.banner()
    if (b) this.io.write(crlf(b))
    this.showPrompt('start')
  }

  resize(rows: number): void {
    const following = this.pageLength === this.rows - 1
    this.rows = rows
    if (following) this.pageLength = rows - 1
  }

  write = (s: string): void => {
    if (!this.closed) this.io.write(s)
  }

  /** Wait until the transport has taken what was written so far (no-op without backpressure). */
  drain = async (): Promise<void> => {
    if (!this.closed) await this.io.drain?.()
  }

  get isClosed(): boolean {
    return this.closed
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.p.dispose?.()
    setTimeout(() => this.io.close(), 10)
  }

  /** Connection dropped by the client. */
  detach(): void {
    this.closed = true
    this.unsubscribe?.()
    this.p.dispose?.()
  }

  private showPrompt(reason: PromptReason): void {
    if (this.closed) return
    this.io.write(crlf(this.p.prompt(reason)))
  }

  /** Unsolicited message: shown now if idle at the prompt, else after the current command. */
  private notify(text: string): void {
    if (this.closed) return
    if (this.busy || this.pager || this.question) {
      this.notices.push(text)
      return
    }
    this.io.write(CRLF + crlf(text.replace(/\n$/, '')) + CRLF)
    this.showPrompt('notify')
    this.io.write(this.line)
    if (this.cursor < this.line.length) this.io.write('\b'.repeat(this.line.length - this.cursor))
  }

  // ------------------------------------------------------------------ output

  print = (text: string, opts: PrintOptions = {}): Promise<void> => {
    if (this.closed || this.squelch || text === '') return Promise.resolve()
    const lines = text.replace(/\r?\n/g, '\n').replace(/\n$/, '').split('\n')
    const len = opts.noMore ? 0 : this.pageLength
    if (len <= 0 || lines.length <= len) {
      this.io.write(lines.join(CRLF) + CRLF)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.io.write(lines.slice(0, len).join(CRLF) + CRLF)
      this.pager = { lines, shown: len, total: lines.length, resolve }
      this.showPager()
    })
  }

  private showPager(): void {
    const pg = this.pager!
    this.pagerText = this.p.pager.text(Math.floor((pg.shown / pg.total) * 100))
    this.io.write(this.pagerText)
  }

  private pagerKey(ch: string): void {
    const pg = this.pager!
    const action = this.p.pager.keys[ch] ?? this.p.pager.other
    if (action === 'ignore') return
    this.io.write(this.p.pager.erase(this.pagerText))
    const take = { line: 1, page: this.pageLength, half: Math.max(1, Math.floor(this.pageLength / 2)), all: Infinity, quit: 0 }[action]
    if (take) {
      const chunk = pg.lines.slice(pg.shown, pg.shown + take)
      pg.shown += chunk.length
      if (chunk.length) this.io.write(chunk.join(CRLF) + CRLF)
    }
    if (action === 'quit' || pg.shown >= pg.total) {
      if (action === 'quit') this.squelch = true
      this.pager = null
      pg.resolve()
    } else this.showPager()
  }

  ask = (question: string, opts: AskOptions = { mode: 'key' }): Promise<string> => {
    this.io.write(crlf(question))
    return new Promise((resolve) => {
      this.question = { opts, buf: '', resolve }
    })
  }

  private questionKey(ch: string): void {
    const q = this.question!
    const done = (answer: string): void => {
      this.question = null
      q.resolve(answer)
    }
    if (ch === '\x03') {
      this.io.write(CRLF)
      return done('')
    }
    if (q.opts.mode === 'key') {
      this.io.write(CRLF)
      return done(ch === '\r' || ch === '\n' ? '' : ch)
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\n' && this.lastWasCR) return
      this.io.write(CRLF)
      return done(q.buf)
    }
    if (ch === '\x7f' || ch === '\b') {
      if (q.buf) {
        q.buf = q.buf.slice(0, -1)
        if (q.opts.echo !== false) this.io.write('\b \b')
      }
      return
    }
    if (ch >= ' ' && ch <= '~') {
      q.buf += ch
      if (q.opts.echo !== false) this.io.write(ch)
    }
  }

  sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (this.abortFlag) return resolve(false)
      const t = setTimeout(() => {
        this.abortWaiters.delete(wake)
        resolve(true)
      }, ms)
      const wake = (): void => {
        clearTimeout(t)
        resolve(false)
      }
      this.abortWaiters.add(wake)
    })

  // ------------------------------------------------------------------ input

  input(data: string): void {
    for (let k = 0; k < data.length; k++) {
      const ch = data[k]!
      if (this.closed) return
      if (this.question) {
        this.questionKey(ch)
        this.lastWasCR = ch === '\r'
        continue
      }
      if (this.pager) {
        this.pagerKey(ch)
        continue
      }
      if (this.busy) {
        if (this.p.abortKeys.includes(ch)) {
          this.abortFlag = true
          for (const w of this.abortWaiters) w()
          this.abortWaiters.clear()
        } else this.queue += ch
        continue
      }
      if (this.escape || (ch === '\x1b' && !this.literalNext)) {
        this.escape += ch
        if (this.handleEscape()) this.escape = ''
        continue
      }
      this.key(ch)
      this.lastWasCR = ch === '\r'
    }
  }

  /** Returns true when the escape sequence is complete (handled or dropped). */
  private handleEscape(): boolean {
    const e = this.escape
    if (e === '\x1b') return false
    if (e === '\x1b[' || e === '\x1bO') return false
    if (/^\x1b[[O][0-9;]*$/.test(e)) return false
    const fin = e.at(-1)!
    if (/^\x1b[[O][A-D]$/.test(e)) {
      if (fin === 'A') this.histPrev()
      else if (fin === 'B') this.histNext()
      else if (fin === 'C') this.moveTo(this.cursor + 1)
      else this.moveTo(this.cursor - 1)
    } else if (/^\x1b\[[1-4]?~?$/.test(e) || /^\x1b[[O][HF]$/.test(e)) {
      if (fin === 'H' || e === '\x1b[1~') this.moveTo(0)
      if (fin === 'F' || e === '\x1b[4~') this.moveTo(this.line.length)
      if (e === '\x1b[3~') this.deleteAt()
    } else if (e === '\x1bb' || e === '\x1bB') this.wordLeft()
    else if (e === '\x1bf' || e === '\x1bF') this.wordRight()
    return true
  }

  private redrawFrom(pos: number): void {
    // Rewrite from `pos` to the end, clear one extra cell, and put the cursor back.
    const tail = this.line.slice(pos)
    this.io.write(tail + ' ' + '\b'.repeat(tail.length + 1))
  }

  private moveTo(pos: number): void {
    pos = Math.max(0, Math.min(this.line.length, pos))
    if (pos < this.cursor) this.io.write('\b'.repeat(this.cursor - pos))
    else if (pos > this.cursor) this.io.write(this.line.slice(this.cursor, pos))
    this.cursor = pos
  }

  private setLine(next: string): void {
    this.moveTo(this.line.length)
    this.io.write('\b \b'.repeat(this.line.length) + next)
    this.line = next
    this.cursor = next.length
  }

  private insert(s: string): void {
    this.line = this.line.slice(0, this.cursor) + s + this.line.slice(this.cursor)
    this.io.write(s)
    this.cursor += s.length
    if (this.cursor < this.line.length) {
      const tail = this.line.slice(this.cursor)
      this.io.write(tail + '\b'.repeat(tail.length))
    }
  }

  private backspace(): void {
    if (!this.cursor) return
    this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
    this.cursor--
    this.io.write('\b')
    this.redrawFrom(this.cursor)
  }

  private deleteAt(): void {
    if (this.cursor >= this.line.length) return
    this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1)
    this.redrawFrom(this.cursor)
  }

  private killRange(from: number, to: number): void {
    if (to <= from) return
    this.killed = this.line.slice(from, to)
    this.moveTo(from)
    const removed = to - from
    this.line = this.line.slice(0, from) + this.line.slice(to)
    const tail = this.line.slice(from)
    this.io.write(tail + ' '.repeat(removed) + '\b'.repeat(tail.length + removed))
  }

  private wordLeft(): void {
    let p = this.cursor
    while (p > 0 && this.line[p - 1] === ' ') p--
    while (p > 0 && this.line[p - 1] !== ' ') p--
    this.moveTo(p)
  }

  private wordRight(): void {
    let p = this.cursor
    while (p < this.line.length && this.line[p] === ' ') p++
    while (p < this.line.length && this.line[p] !== ' ') p++
    this.moveTo(p)
  }

  private histPrev(): void {
    if (!this.history.length) return
    this.histIdx = this.histIdx < 0 ? this.history.length - 1 : Math.max(0, this.histIdx - 1)
    this.setLine(this.history[this.histIdx]!)
  }

  private histNext(): void {
    if (this.histIdx < 0) return
    this.histIdx++
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1
      this.setLine('')
    } else this.setLine(this.history[this.histIdx]!)
  }

  private redisplay(): void {
    this.showPrompt('help')
    this.io.write(this.line)
    if (this.cursor < this.line.length) this.io.write('\b'.repeat(this.line.length - this.cursor))
  }

  private key(ch: string): void {
    if (this.literalNext) {
      this.literalNext = false
      if (ch >= ' ' || ch === '\t') this.insert(ch)
      return
    }
    switch (ch) {
      case '\r':
      case '\n': {
        if (ch === '\n' && this.lastWasCR) return
        this.io.write(CRLF)
        const line = this.line
        this.line = ''
        this.cursor = 0
        this.histIdx = -1
        void this.run(line)
        return
      }
      case '\x7f':
      case '\b':
        return this.backspace()
      case '\x01':
        return this.moveTo(0)
      case '\x05':
        return this.moveTo(this.line.length)
      case '\x02':
        return this.moveTo(this.cursor - 1)
      case '\x06':
        return this.moveTo(this.cursor + 1)
      case '\x04':
        return this.deleteAt()
      case '\x0b':
        return this.killRange(this.cursor, this.line.length)
      case '\x15':
      case '\x18':
        return this.killRange(0, this.cursor === 0 ? this.line.length : this.cursor)
      case '\x17': {
        let p = this.cursor
        while (p > 0 && this.line[p - 1] === ' ') p--
        while (p > 0 && this.line[p - 1] !== ' ') p--
        return this.killRange(p, this.cursor)
      }
      case '\x19':
        if (this.killed) this.insert(this.killed)
        return
      case '\x10':
        return this.histPrev()
      case '\x0e':
        return this.histNext()
      case '\x0c':
      case '\x12':
        this.io.write(CRLF)
        return this.redisplay()
      case '\x16':
        this.literalNext = true
        return
      case '\x03':
      case '\x1a':
        return this.control(ch === '\x03' ? 'c' : 'z')
      case '\t': {
        const r = this.p.tab(this.line.slice(0, this.cursor))
        return this.applyTab(r)
      }
      case ' ': {
        const r = this.p.space && this.cursor === this.line.length ? this.p.space(this.line) : null
        if (r) return this.applyTab(r)
        return this.insert(' ')
      }
      case '?': {
        this.io.write('?' + CRLF)
        const text = this.p.help(this.line.slice(0, this.cursor))
        if (text) this.io.write(crlf(text.replace(/\n$/, '')) + CRLF)
        return this.redisplay()
      }
      default:
        if (ch >= ' ' && ch !== '\x7f') this.insert(ch)
    }
  }

  private applyTab(r: { line?: string; list?: string; bell?: boolean }): void {
    if (r.bell) this.io.write('\x07')
    if (r.list !== undefined) {
      this.io.write(CRLF + crlf(r.list.replace(/\n$/, '')) + CRLF)
      if (r.line !== undefined) {
        this.line = r.line
        this.cursor = r.line.length
      }
      return this.redisplay()
    }
    if (r.line !== undefined) {
      const rest = this.line.slice(this.cursor)
      const before = this.line.slice(0, this.cursor)
      if (r.line.startsWith(before) && !rest) this.insert(r.line.slice(before.length))
      else this.setLine(r.line + rest)
    }
  }

  private control(k: 'c' | 'z'): void {
    const r = this.p.control(k, this.line)
    if (r.echo) this.io.write(crlf(r.echo))
    if (r.disconnect) return this.close()
    if (r.execute !== undefined) {
      this.line = ''
      this.cursor = 0
      void this.run(r.execute, 'interrupt', r.then)
      return
    }
    r.then?.()
    if (!r.keepLine) {
      this.line = ''
      this.cursor = 0
    }
    this.showPrompt('interrupt')
    if (r.keepLine) this.io.write(this.line)
  }

  private async run(raw: string, reason: PromptReason = 'command', then?: () => void): Promise<void> {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      then?.()
      return this.after(reason === 'interrupt' ? 'interrupt' : 'empty')
    }
    if (this.history.at(-1) !== line) this.history.push(line)
    if (this.history.length > 50) this.history.shift()
    await this.exec(line)
    then?.()
    this.after(reason === 'interrupt' ? 'interrupt' : 'command')
  }

  private async exec(line: string): Promise<void> {
    this.busy = true
    this.abortFlag = false
    this.squelch = false
    try {
      tickBgp(this.d)
      for (const x of this.extra) {
        const r = x(line, this)
        if (r && (await r)) return
      }
      await this.p.execute(line)
    } catch (e) {
      await this.print(`% simulator error: ${(e as Error).message}`)
    } finally {
      this.busy = false
      this.abortFlag = false
    }
  }

  private after(reason: PromptReason): void {
    if (this.closed) return
    for (const n of this.notices.splice(0)) this.io.write(crlf(n.replace(/\n$/, '')) + CRLF)
    this.showPrompt(reason)
    if (this.queue) {
      const q = this.queue
      this.queue = ''
      this.input(q)
    }
  }
}
