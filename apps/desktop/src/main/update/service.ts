import type { Settings } from '@shared/types'
import type { PolicyLocks } from '@shared/policy'
import type { RestartResult, UpdateMode, UpdateState, UpdateStatus } from '@shared/privacy'

/**
 * Auto-update (Phase 7). The update check is the only thing Hopline sends on its own (D8), and it
 * can be turned off by the user or the team policy.
 *
 * The rule that shapes everything here: **Hopline never restarts while sessions are open.** An
 * update downloads in the background, the status bar says "Update ready — restart when you're
 * done", and it installs when Hopline quits. "Restart now" is refused in main while any session
 * is open, whatever the renderer asks.
 *
 * electron-updater sits behind `UpdaterBackend` so the state machine is tested with a fake, and
 * the e2e test drives the real one against a local server.
 */

/** The part of electron-updater's AppUpdater this service uses. */
export interface UpdaterBackend {
  channel: string | null
  allowPrerelease: boolean
  allowDowngrade: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string }; isUpdateAvailable?: boolean } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
}

export interface UpdateDeps {
  /** Built on first use, so nothing touches electron-updater while updates are off. */
  backend: () => UpdaterBackend
  settings: () => Settings
  locks: () => PolicyLocks
  version: string
  mode: () => UpdateMode
  /** Open sessions in every window (tabs connecting, connected or reconnecting). */
  openSessions: () => number
  /** Refuse (true) or allow again (false) new sessions while an install is starting. */
  freeze?: (on: boolean) => void
  emit: (s: UpdateStatus) => void
  /** The release page for a version (notify mode). */
  releaseUrl: (version: string) => string | null
  /** A dev build without a test feed: never checks. */
  dev: boolean
  /** Install when Hopline quits. False in tests: the updater must never install there. */
  installOnQuit: boolean
  now?: () => number
  firstDelayMs?: number
  intervalMs?: number
}

export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export class UpdateService {
  private state: UpdateState = { kind: 'idle' }
  private b: UpdaterBackend | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastCheckedAt: number | null = null
  private running: Promise<UpdateStatus> | null = null

  constructor(private readonly d: UpdateDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)()
  }

  /** Why automatic checks are off, or null. Policy first: it also blocks "Check now". */
  private offReason(auto: boolean): Extract<UpdateState, { kind: 'off' }>['reason'] | null {
    if (this.d.locks().updatesDisabled) return 'policy'
    if (this.d.dev) return 'dev'
    if (!auto) return null
    const s = this.d.settings()
    if (!s.privacyReviewed) return 'consent'
    if (!s.updateAutoCheck) return 'setting'
    return null
  }

  status(): UpdateStatus {
    const s = this.d.settings()
    const l = this.d.locks()
    // A quiet state that only says why checks are off is recomputed; progress is kept.
    let state = this.state
    if (state.kind === 'idle' || state.kind === 'off') {
      const why = this.offReason(true)
      state = why ? { kind: 'off', reason: why } : { kind: 'idle' }
    }
    return {
      state,
      current: this.d.version,
      mode: this.d.mode(),
      channel: s.updateChannel,
      autoCheck: s.updateAutoCheck,
      managed: { disabled: l.updatesDisabled, channel: !!l.updateChannel },
      lastCheckedAt: this.lastCheckedAt
    }
  }

  private set(state: UpdateState): void {
    this.state = state
    this.d.emit(this.status())
  }

  private backend(): UpdaterBackend {
    if (this.b) return this.b
    const b = this.d.backend()
    // Hopline decides when to download and never restarts on its own.
    b.autoDownload = false
    b.autoInstallOnAppQuit = this.d.installOnQuit
    b.on('download-progress', (p) => {
      if (this.state.kind === 'downloading') this.set({ ...this.state, percent: Math.max(0, Math.min(100, Math.round(p.percent))) })
    })
    b.on('error', (e) => {
      if (this.state.kind === 'downloading' || this.state.kind === 'checking') this.set({ kind: 'error', message: errorText(e), at: this.now() })
    })
    this.b = b
    return b
  }

  /** Stable reads latest*.yml without prereleases; beta reads beta*.yml (which stable releases also write). */
  private applyChannel(b: UpdaterBackend): void {
    const beta = this.d.settings().updateChannel === 'beta'
    b.channel = beta ? 'beta' : 'latest'
    b.allowPrerelease = beta
    // electron-updater turns downgrades on whenever the channel is set: switching from beta back
    // to stable waits for stable to catch up instead of installing an older version.
    b.allowDowngrade = false
  }

  /** Start the schedule (first check shortly after launch, then every few hours). */
  start(): void {
    this.reschedule()
    this.d.emit(this.status())
  }

  /** Settings or consent changed. */
  reconfigure(): void {
    if (this.b) this.applyChannel(this.b)
    this.reschedule()
    this.d.emit(this.status())
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.offReason(true)) return
    const delay = this.lastCheckedAt === null ? (this.d.firstDelayMs ?? FIRST_CHECK_DELAY_MS) : (this.d.intervalMs ?? CHECK_INTERVAL_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check(false).finally(() => this.reschedule())
    }, delay)
    this.timer.unref?.()
  }

  /**
   * Check now (`manual`: the user pressed "Check now", which works with automatic checks off but
   * never against the policy). A found update downloads in the background in `auto` mode.
   */
  check(manual: boolean): Promise<UpdateStatus> {
    if (this.running) return this.running
    const off = this.offReason(!manual)
    if (off) return Promise.resolve(this.status())
    if (this.state.kind === 'downloading' || this.state.kind === 'ready') return Promise.resolve(this.status())
    this.running = this.run().finally(() => (this.running = null))
    return this.running
  }

  private async run(): Promise<UpdateStatus> {
    this.set({ kind: 'checking' })
    let b: UpdaterBackend
    try {
      b = this.backend()
      this.applyChannel(b)
      const r = await b.checkForUpdates()
      this.lastCheckedAt = this.now()
      // null: electron-updater is inactive here (not packaged, no feed).
      if (!r) return this.done({ kind: 'off', reason: 'dev' })
      const version = r.updateInfo?.version
      const available = r.isUpdateAvailable ?? (!!version && version !== this.d.version)
      if (!available || !version) return this.done({ kind: 'current', checkedAt: this.lastCheckedAt })
      if (this.d.mode() === 'notify') return this.done({ kind: 'available', version, url: this.d.releaseUrl(version) })
      this.set({ kind: 'downloading', version, percent: 0 })
      await b.downloadUpdate()
      return this.done({ kind: 'ready', version })
    } catch (e) {
      return this.done({ kind: 'error', message: errorText(e), at: this.now() })
    }
  }

  private done(s: UpdateState): UpdateStatus {
    this.set(s)
    return this.status()
  }

  /** "Restart now": only with an update ready and no session open anywhere. */
  restart(): RestartResult {
    if (this.state.kind !== 'ready' || !this.b) return { ok: false, reason: 'not-ready' }
    // Close the door first, then count (review L1): quitAndInstall starts the installer at once and
    // quits a tick later, and a session opened in that gap would run under the installer.
    this.d.freeze?.(true)
    const open = this.d.openSessions()
    if (open > 0) {
      this.d.freeze?.(false)
      return { ok: false, reason: 'sessions', open }
    }
    this.b.quitAndInstall(false, true)
    return { ok: true }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** electron-updater errors can be long (a whole HTTP response); keep one short line for Settings. */
function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const line = m.split(/\r?\n/)[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || 'Update check failed'
}
