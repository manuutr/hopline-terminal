import { closeSync, createWriteStream, mkdirSync, openSync, readSync, statSync, type WriteStream } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

// CSI, OSC and other escape sequences, so log files read like a transcript.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g

export interface LogOptions {
  dir: string
  /**
   * File name template with SecureCRT-compatible tokens:
   * %S session name, %H host, %P port, %U user, %Y %M %D date, %h %m %s time, %t epoch ms, %% literal.
   * May contain "/" to create subfolders (e.g. "%Y-%M/%S_%h%m%s.log"); it can never escape `dir`.
   */
  template: string
  /** Prefix every line with a local timestamp. */
  timestamps: boolean
  /** Start a new file when the local date changes. */
  rotateDaily: boolean
}

export interface LogContext {
  session: string
  host: string
  port: number
  user: string
}

export const DEFAULT_LOG_TEMPLATE = '%S_%Y-%M-%D_%h-%m-%s.log'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
/** Header fields come from user data: one line, no control characters. */
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200)
const safe = (s: string) => s.replace(/[^\w.@-]+/g, '_').slice(0, 60) || 'session'

/** Expand a log-name template. Pure, exported for tests. */
export function expandTemplate(template: string, ctx: LogContext, d: Date): string {
  const map: Record<string, string> = {
    S: safe(ctx.session),
    H: safe(ctx.host),
    P: String(ctx.port),
    U: safe(ctx.user),
    Y: String(d.getFullYear()),
    M: pad(d.getMonth() + 1),
    D: pad(d.getDate()),
    h: pad(d.getHours()),
    m: pad(d.getMinutes()),
    s: pad(d.getSeconds()),
    t: String(d.getTime()),
    '%': '%'
  }
  return template.replace(/%(.)/g, (whole, k: string) => map[k] ?? whole)
}

/** Resolve the log path for a template, refusing anything outside `dir`. */
export function resolveLogPath(dir: string, template: string, ctx: LogContext, d: Date): string {
  let name = expandTemplate(template || DEFAULT_LOG_TEMPLATE, ctx, d).replace(/\\/g, '/')
  name = name
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    // No hidden files or folders (".bashrc", ".ssh/…"): logs are plain, visible files.
    .map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_'))
    .join(sep)
  if (!name || isAbsolute(name)) name = expandTemplate(DEFAULT_LOG_TEMPLATE, ctx, d)
  // Always a .log file, so a template can never name a script, key or config file.
  if (!/\.log$/i.test(name)) name += '.log'
  const full = normalize(join(dir, name))
  if (!full.startsWith(normalize(dir + sep))) return normalize(join(dir, expandTemplate(DEFAULT_LOG_TEMPLATE, ctx, d)))
  return full
}

const stamp = (d: Date) => `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}] `
const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** Strip terminal control sequences and apply backspaces, so the log reads like a transcript. */
export function cleanForLog(text: string): string {
  let t = text.replace(ANSI, '')
  while (/[^\x08\n]\x08/.test(t)) t = t.replace(/[^\x08\n]\x08/g, '')
  return t.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

const HEADER = '=== Hopline session log: '

/**
 * Appends to `path` only if it is a Hopline log (or new). Anything else gets a numbered sibling, so
 * a template that happens to match an existing file never writes into it.
 */
function claimLogFile(path: string): string {
  for (let i = 0; i < 1000; i++) {
    const p = i === 0 ? path : path.replace(/(\.log)?$/i, `-${i}.log`)
    try {
      if (!statSync(p).isFile()) continue
      const fd = openSync(p, 'r')
      const buf = Buffer.alloc(HEADER.length)
      readSync(fd, buf, 0, buf.length, 0)
      closeSync(fd)
      if (buf.toString() === HEADER) return p
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return p
      throw e
    }
  }
  throw new Error('no free log file name')
}

export class SessionLogger {
  private out: WriteStream | null = null
  private draining = new Set<Promise<void>>()
  path!: string
  private day = ''
  private atLineStart = true

  /**
   * Throws if the log file can't be created (bad folder, permissions); callers continue without
   * logging. Later write errors disable logging and call `onError` once; they never throw.
   */
  constructor(
    private readonly opts: LogOptions,
    private readonly ctx: LogContext,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (e: Error) => void = () => {}
  ) {
    this.openFile(this.now())
  }

  private openFile(d: Date): void {
    const wanted = resolveLogPath(this.opts.dir, this.opts.template, this.ctx, d)
    mkdirSync(dirname(wanted), { recursive: true })
    this.path = claimLogFile(wanted)
    const out = createWriteStream(this.path, { flags: 'a', mode: 0o600 })
    out.on('error', (e) => {
      if (this.out !== out) return
      this.out = null
      this.onError(e)
    })
    this.out = out
    this.day = dayOf(d)
    const c = this.ctx
    out.write(`${HEADER}${oneLine(c.session)} (${oneLine(c.user)}@${oneLine(c.host)}:${c.port}) — ${d.toString()} ===\n`)
  }

  private rotateIfNeeded(d: Date): void {
    if (!this.opts.rotateDaily || dayOf(d) === this.day || !this.out) return
    this.out.write(`\n=== continued in next file — ${d.toString()} ===\n`)
    this.endFile(this.out)
    this.out = null
    try {
      this.openFile(d)
    } catch (e) {
      this.onError(e as Error)
    }
    this.atLineStart = true
  }

  write(text: string): void {
    if (!this.out) return
    const d = this.now()
    this.rotateIfNeeded(d)
    let t = cleanForLog(text)
    if (!t) return
    if (this.opts.timestamps) {
      const ts = stamp(d)
      t = (this.atLineStart ? ts : '') + t.replace(/\n(?=.)/g, '\n' + ts)
      this.atLineStart = t.endsWith('\n')
    }
    this.out?.write(t)
  }

  note(msg: string): void {
    this.out?.write(`\n=== ${oneLine(msg)} — ${this.now().toLocaleString()} ===\n`)
    this.atLineStart = true
  }

  private endFile(out: WriteStream): void {
    const finished = new Promise<void>((resolve) => out.end(resolve))
    this.draining.add(finished)
    void finished.then(() => this.draining.delete(finished))
  }

  async close(): Promise<void> {
    if (this.out) this.endFile(this.out)
    this.out = null
    await Promise.all(this.draining)
  }
}
