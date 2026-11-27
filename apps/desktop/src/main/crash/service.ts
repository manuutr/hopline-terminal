import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createStackParser, createTransport, Scope, type Event, type Transport, type TransportMakeRequestResponse, type TransportRequest } from '@sentry/core'
import { nodeStackLineParser, ServerRuntimeClient } from '@sentry/core/server'
import type { Settings } from '@shared/types'
import type { PolicyLocks } from '@shared/policy'
import { dsnTarget, parseDsn, type CrashDump, type CrashStatus, type Dsn, type RendererError } from '@shared/privacy'
import { scrubEvent, scrubText, type ScrubContext } from './scrub'

/**
 * Opt-in crash reporting (D7). Off by default; nothing here runs until the user turns it on.
 *
 * - JavaScript errors (main, the renderer, a process that died) go through a Sentry client built
 *   from `@sentry/core` with no integrations: no breadcrumbs, no auto-instrumentation, no session
 *   tracking, no client reports. `beforeSend` replaces every event with the scrubbed allow-list
 *   version (scrub.ts); an event that cannot be scrubbed is dropped.
 * - The client is only constructed while reports are on, and closed when they are turned off, so
 *   nothing (not even an SDK heartbeat) can leave before the opt-in.
 * - Native crash dumps (Electron's crashReporter / Crashpad) are written locally only
 *   (`uploadToServer: false`). A dump is process memory and cannot be scrubbed: it can hold
 *   terminal output, a typed password or the vault key. Each one is sent only after its own
 *   confirmation, from Settings › Privacy, with that warning.
 */

export interface CrashDeps {
  settings: () => Settings
  locks: () => PolicyLocks
  /** The user's own values (session names, hosts, usernames…), removed from every message. */
  known: () => string[]
  version: string
  /** The DSN built into this release (CI secret), or ''. */
  builtInDsn: string
  /** Electron's net.fetch in the app (system proxy), a stub in tests. */
  fetch: (url: string, init: { method: string; body: Uint8Array | string | FormData; headers?: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null } }>
  /** Where Crashpad writes native dumps. */
  dumpsDir: () => string
  /** Start Crashpad (local only). Called at most once. */
  startNative?: () => void
  /** A confirmation main shows itself (the renderer cannot answer it for the user). */
  confirm: (message: string, detail: string, ok: string) => Promise<boolean>
  platform?: string
  arch?: string
  electron?: string
  environment?: 'production' | 'beta' | 'development'
  now?: () => number
  /**
   * "What left this machine": called before a report or dump is sent, with metadata only (the
   * destination host, the kind and the size); the returned function records the HTTP status.
   */
  egress?: (e: { kind: 'report' | 'dump'; destination: string; bytes: number }) => (status: number | null) => void
}

const statOr0 = async (p: string): Promise<number> => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** Most events one run sends: a crash loop must not flood anyone's project. */
export const MAX_EVENTS_PER_RUN = 20
/** "Send a test crash" presses per run (review L4): a renderer cannot flood the DSN through it. */
export const MAX_TESTS_PER_RUN = 3
/** Native dumps older than this are deleted at startup (review M2; docs/SIGNING.md › Crash reports). */
export const DUMP_RETENTION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The dumps folder, owner-only (0700) on macOS and Linux, created before Crashpad writes to it.
 * Windows: under the user's own AppData, which only that user (and admins) can read.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
}

const GONE_REASONS = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit', 'memory-eviction'])

export class CrashReporting {
  private client: ServerRuntimeClient | null = null
  private clientDsn = ''
  private nativeStarted = false
  private sent = 0
  private tests = 0
  private seen = new Set<string>()
  /** The last transport result, for "Send a test crash". */
  private lastStatus: number | null = null

  constructor(private readonly d: CrashDeps) {}

  /** The DSN in force and where it came from. The policy's wins, then the user's, then the built-in one. */
  private dsn(): { dsn: Dsn; raw: string; source: CrashStatus['dsnSource'] } | null {
    const l = this.d.locks()
    const pick: [string | null | undefined, CrashStatus['dsnSource']][] = [
      [l.crashReportDsn, 'policy'],
      [this.d.settings().crashReportDsn, 'user'],
      [this.d.builtInDsn, 'built-in']
    ]
    for (const [raw, source] of pick) {
      const dsn = raw ? parseDsn(raw) : null
      if (dsn && raw) return { dsn, raw: raw.trim(), source }
    }
    return null
  }

  enabled(): boolean {
    const s = this.d.settings()
    return s.crashReports && !this.d.locks().crashReportsDisabled && !!this.dsn()
  }

  status(): CrashStatus {
    const d = this.dsn()
    return {
      enabled: this.enabled(),
      managed: this.d.locks().crashReportsDisabled,
      target: d ? dsnTarget(d.dsn) : null,
      dsnSource: d?.source ?? null,
      dumps: this.listDumps()
    }
  }

  /** Settings or policy changed: build, rebuild or drop the client. */
  apply(): void {
    // Opting out deletes every dump on disk (M2); opted in, old ones expire.
    this.sweepDumps()
    const d = this.enabled() ? this.dsn() : null
    if (!d) {
      void this.client?.close(2000)
      this.client = null
      this.clientDsn = ''
      return
    }
    if (!this.nativeStarted && this.d.startNative) {
      this.nativeStarted = true
      try {
        this.d.startNative()
      } catch (e) {
        console.error('[hopline] crash reporter did not start:', e instanceof Error ? e.message : e)
      }
    }
    if (this.client && this.clientDsn === d.raw) return
    void this.client?.close(2000)
    this.clientDsn = d.raw
    this.client = new ServerRuntimeClient({
      dsn: d.raw,
      release: `hopline@${this.d.version}`,
      environment: this.d.environment ?? 'production',
      integrations: [],
      stackParser: createStackParser(nodeStackLineParser()),
      transport: (o) => this.transport(o),
      sendClientReports: false,
      maxBreadcrumbs: 0,
      sendDefaultPii: false,
      beforeBreadcrumb: () => null,
      beforeSend: (ev) => scrubEvent(ev, this.ctx()) as typeof ev | null,
      beforeSendTransaction: () => null,
      platform: 'node',
      serverName: ''
    })
    this.client.init()
  }

  private ctx(): ScrubContext {
    let known: string[] = []
    try {
      known = this.d.known()
    } catch {
      // No list (DB closed during shutdown): the shape rules still run.
    }
    return { known }
  }

  private transport(o: Parameters<typeof createTransport>[0] & { url: string }): Transport {
    return createTransport(o, async (req: TransportRequest): Promise<TransportMakeRequestResponse> => {
      const body = typeof req.body === 'string' ? req.body : new Uint8Array(req.body)
      const log = this.egress('report', o.url, typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength)
      let r: Awaited<ReturnType<CrashDeps['fetch']>>
      try {
        r = await this.d.fetch(o.url, { method: 'POST', body, headers: { 'content-type': 'application/x-sentry-envelope' } })
      } catch (e) {
        log?.(null)
        throw e
      }
      log?.(r.status)
      this.lastStatus = r.status
      return { statusCode: r.status, headers: { 'x-sentry-rate-limits': r.headers.get('x-sentry-rate-limits'), 'retry-after': r.headers.get('retry-after') } }
    })
  }

  /** One metadata-only row in "What left this machine" per report or dump (L5): where, what, how big. Never the content. */
  private egress(kind: 'report' | 'dump', url: string, bytes: number): ((status: number | null) => void) | undefined {
    if (!this.d.egress) return undefined
    let destination = ''
    try {
      destination = new URL(url).host
    } catch {
      destination = 'unknown'
    }
    try {
      return this.d.egress({ kind, destination, bytes })
    } catch {
      return undefined
    }
  }

  private tags(process: string, kind: string, extra: Record<string, string> = {}): Record<string, string> {
    return { process, kind, os: this.d.platform ?? '', arch: this.d.arch ?? '', electron: this.d.electron ?? '', channel: this.d.settings().updateChannel, ...extra }
  }

  /** Report one error. Returns the event id, or null when nothing was sent (off, a repeat, the cap). */
  capture(err: unknown, process: 'main' | 'renderer' | 'session-host', kind: 'exception' | 'rejection' | 'render' | 'test'): string | null {
    const c = this.client
    if (!c || !this.enabled()) return null
    // One report per distinct error per run (after scrubbing, so two hosts count as one error).
    const key = `${process}:${kind}:${scrubText(err instanceof Error ? `${err.name}: ${err.message}` : String(err), this.ctx())}`
    if (kind === 'test') {
      // Not deduplicated (each press must arrive), but capped: crash:test is a renderer IPC (L4).
      if (this.tests >= MAX_TESTS_PER_RUN) return null
      this.tests++
    } else {
      if (this.seen.has(key) || this.sent >= MAX_EVENTS_PER_RUN) return null
      this.seen.add(key)
      this.sent++
    }
    // A scope of our own: the allow-listed tags only, nothing from Sentry's global scopes' setters.
    const scope = new Scope()
    scope.setTags(this.tags(process, kind))
    scope.setLevel(kind === 'test' ? 'info' : 'error')
    return c.captureException(err, { mechanism: { type: `hopline.${kind}`, handled: kind === 'test' || kind === 'render' } }, scope)
  }

  /** A renderer error, forwarded over IPC: rebuilt as an Error so the stack parser reads it. */
  captureRenderer(r: RendererError, kind: 'exception' | 'rejection' | 'render'): string | null {
    const e = new Error(r.message)
    e.name = r.name || 'Error'
    e.stack = r.stack || `${e.name}: ${r.message}`
    return this.capture(e, 'renderer', kind)
  }

  /** A renderer, GPU or utility process (the session host) died: what happened, never its memory. */
  processGone(type: string, reason: string, exitCode: number): string | null {
    if (!GONE_REASONS.has(reason) || !this.client || !this.enabled()) return null
    if (this.sent >= MAX_EVENTS_PER_RUN) return null
    this.sent++
    const proc = /renderer/i.test(type) ? 'renderer' : /gpu/i.test(type) ? 'gpu' : /utility/i.test(type) ? 'session-host' : 'unknown'
    return this.client.captureEvent({
      level: 'fatal',
      message: `process gone: ${proc} (${reason}, exit code ${Number.isFinite(exitCode) ? exitCode : -1})`,
      tags: this.tags(proc, 'process-gone', { reason: reason.slice(0, 30) })
    })
  }

  /**
   * "Send a test crash": a synthetic error through the same pipeline (scrubbing included). It never
   * crashes a process: that would end the user's open sessions.
   */
  async sendTest(): Promise<{ ok: boolean; status: number | null; id: string | null }> {
    this.apply()
    if (!this.client) return { ok: false, status: null, id: null }
    this.lastStatus = null
    const err = new Error('Test crash report from Settings (nothing is wrong)')
    err.name = 'HoplineTestCrash'
    const id = this.capture(err, 'main', 'test')
    const flushed = await this.client.flush(8000)
    const ok = flushed && this.lastStatus !== null && this.lastStatus >= 200 && this.lastStatus < 300
    return { ok, status: this.lastStatus, id }
  }

  // ------------------------------------------------------------------ native dumps

  /** The user turned reports off, or the policy forbids them: no dump may stay on disk. */
  private optedOut(): boolean {
    return !this.d.settings().crashReports || this.d.locks().crashReportsDisabled
  }

  /**
   * Dump housekeeping (review M2), at startup, on every settings change and at quit:
   * - opted out (or forbidden by policy): every dump is deleted. Crashpad cannot be stopped once
   *   started, so dumps written after an opt-out in the same run go at quit or the next start;
   * - opted in: dumps older than DUMP_RETENTION_DAYS are deleted, the rest are made owner-only.
   */
  sweepDumps(): number {
    const now = (this.d.now ?? Date.now)()
    const all = this.optedOut()
    let removed = 0
    for (const d of this.allDumps()) {
      try {
        if (all || now - d.at > DUMP_RETENTION_DAYS * DAY_MS) (rmSync(d.path, { force: true }), removed++)
        else if (process.platform !== 'win32') chmodSync(d.path, 0o600)
      } catch {
        // gone meanwhile
      }
    }
    return removed
  }

  /** "Delete all" in Settings. */
  deleteAllDumps(): number {
    let removed = 0
    for (const d of this.allDumps()) {
      try {
        rmSync(d.path, { force: true })
        removed++
      } catch {
        // gone meanwhile
      }
    }
    return removed
  }

  listDumps(): CrashDump[] {
    return this.allDumps()
      .sort((a, b) => b.at - a.at)
      .slice(0, 50)
      .map(({ id, at, bytes }) => ({ id, at, bytes }))
  }

  private allDumps(): (CrashDump & { path: string })[] {
    const out: (CrashDump & { path: string })[] = []
    const walk = (dir: string, depth: number) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const n of names) {
        const p = join(dir, n)
        try {
          const st = statSync(p)
          if (st.isDirectory() && depth < 3) walk(p, depth + 1)
          else if (st.isFile() && /^[\w-]{1,80}\.dmp$/i.test(n)) out.push({ id: n.replace(/\.dmp$/i, ''), at: st.mtimeMs, bytes: st.size, path: p })
        } catch {
          // gone meanwhile
        }
      }
    }
    walk(this.d.dumpsDir(), 0)
    return out
  }

  private dumpPath(id: string): string | null {
    if (!/^[\w-]{1,80}$/.test(id)) return null
    const find = (dir: string, depth: number): string | null => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return null
      }
      for (const n of names) {
        const p = join(dir, n)
        if (n === `${id}.dmp`) return p
        try {
          if (depth < 3 && statSync(p).isDirectory()) {
            const hit = find(p, depth + 1)
            if (hit) return hit
          }
        } catch {
          // gone meanwhile
        }
      }
      return null
    }
    return find(this.d.dumpsDir(), 0)
  }

  deleteDump(id: string): boolean {
    const p = this.dumpPath(id)
    if (!p) return false
    rmSync(p, { force: true })
    return true
  }

  /**
   * Send one native dump after its own confirmation. Sentry's minidump endpoint takes the file and
   * a few attributes; nothing else is attached.
   */
  async sendDump(id: string): Promise<{ ok: boolean; reason?: 'off' | 'missing' | 'cancelled' | 'failed' }> {
    const d = this.enabled() ? this.dsn() : null
    if (!d) return { ok: false, reason: 'off' }
    const p = this.dumpPath(id)
    if (!p) return { ok: false, reason: 'missing' }
    const yes = await this.d.confirm(
      'Send this crash dump?',
      `A crash dump is a copy of a Hopline Terminal process's memory when it crashed. It cannot be cleaned: it can contain terminal output, commands, host names, and even a password or key that was in memory at the time. It goes to ${dsnTarget(d.dsn)}. Send it only if you trust that server, for example when a developer asked for this crash.`,
      'Send dump'
    )
    if (!yes) return { ok: false, reason: 'cancelled' }
    const { dsn } = d
    const url = `${dsn.protocol}://${dsn.host}${dsn.path ? `/${dsn.path}` : ''}/api/${dsn.projectId}/minidump/?sentry_key=${encodeURIComponent(dsn.publicKey)}`
    const form = new FormData()
    form.append('upload_file_minidump', new Blob([new Uint8Array(await readFile(p))]), basename(p))
    form.append('sentry', JSON.stringify({ release: `hopline@${this.d.version}`, environment: this.d.environment ?? 'production', tags: { os: this.d.platform, arch: this.d.arch, electron: this.d.electron } }))
    const log = this.egress('dump', url, (await statOr0(p)) || 0)
    try {
      const r = await this.d.fetch(url, { method: 'POST', body: form })
      log?.(r.status)
      if (r.status < 200 || r.status >= 300) return { ok: false, reason: 'failed' }
    } catch {
      log?.(null)
      return { ok: false, reason: 'failed' }
    }
    rmSync(p, { force: true })
    return { ok: true }
  }

  async close(): Promise<void> {
    await this.client?.close(2000)
    this.client = null
  }
}

export type { Event }
