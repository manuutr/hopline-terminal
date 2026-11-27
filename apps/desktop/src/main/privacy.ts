import { app, crashReporter, net } from 'electron'
import { execFileSync } from 'node:child_process'
import { hostname, userInfo } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { UpdateMode } from '@shared/privacy'
import type { Repo } from './db/repo'
import type { PolicyService } from './policy/policy'
import type { SettingsService } from './settings'
import { CrashReporting, ensurePrivateDir } from './crash/service'
import type { EgressLog } from './egress/store'
import { UpdateService, type UpdaterBackend } from './update/service'
import { decideUpdateMode, hasPublisherName } from './update/mode'
import { registerPrivacyIpc } from './ipc/privacy'

/**
 * Wiring for updates and crash reports (Phase 7) in the real app. The logic is in update/service.ts
 * and crash/service.ts; this file only connects them to Electron.
 */

/** Built in by CI from the HOPLINE_SENTRY_DSN secret (electron.vite.config.ts); '' otherwise. */
declare const __HOPLINE_SENTRY_DSN__: string
declare const __HOPLINE_RELEASES_URL__: string

let signedCache: boolean | null = null
/** macOS: Squirrel.Mac only installs an update signed by the same Developer ID. */
function macSigned(): boolean {
  if (signedCache !== null) return signedCache
  try {
    // .../Hopline.app/Contents/MacOS/Hopline → .../Hopline.app
    const bundle = dirname(dirname(dirname(app.getPath('exe'))))
    const out = execFileSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
    signedCache = /Authority=Developer ID Application/.test(out)
  } catch (e) {
    // codesign prints to stderr, and exits 0 for a signed app.
    const text = String((e as { stderr?: unknown }).stderr ?? '')
    signedCache = /Authority=Developer ID Application/.test(text)
  }
  return signedCache
}

let publisherCache: boolean | null = null
/** Windows: electron-updater verifies an installer's Authenticode signature only when app-update.yml names the publisher. */
function winPublisher(): boolean {
  if (publisherCache !== null) return publisherCache
  try {
    publisherCache = hasPublisherName(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'))
  } catch {
    publisherCache = false
  }
  return publisherCache
}

/**
 * How this install can update (update/mode.ts): auto-install only where the update's signature is
 * checked before it runs (signed Windows with a publisher, signed macOS). Everything else, every
 * Linux package included, announces the new version and links to its release page.
 */
export function updateMode(): UpdateMode {
  const e2eAuto = !!process.env['HOPLINE_E2E'] && !app.isPackaged && process.env['HOPLINE_E2E_UPDATE_MODE'] === 'auto'
  return decideUpdateMode({ platform: process.platform, macSigned, winPublisher, e2eAuto })
}

export interface PrivacySetup {
  updates: UpdateService
  crash: CrashReporting
}

let crashpadStarted = false
/** Crashpad, local dumps only (uploads are one by one after a confirmation). Started at most once. */
function startCrashpad(): void {
  if (crashpadStarted) return
  crashpadStarted = true
  // Owner-only folder before the first dump is written (M2): a dump is process memory.
  ensurePrivateDir(app.getPath('crashDumps'))
  crashReporter.start({ uploadToServer: false, compress: true })
}

/**
 * Call before any child process starts (the session host): Crashpad only watches processes created
 * after it. When the user opts in later, it starts then, and processes already running are covered
 * from the next launch. The settings overlay already reads false when the policy forbids reports.
 */
export function startCrashpadIfOptedIn(settings: SettingsService): void {
  if (process.env['HOPLINE_E2E'] && !app.isPackaged) return
  if (!settings.get().crashReports) return
  try {
    startCrashpad()
  } catch (e) {
    console.error('[hopline] crash reporter did not start:', e instanceof Error ? e.message : e)
  }
}

export function setupPrivacy(o: {
  repo: Repo
  settings: SettingsService
  policy: PolicyService
  /** Every live connection (tabs and background runs). */
  liveSessions: () => number
  /** Refuse new connections while an update install starts (review L1). */
  freezeSessions?: (on: boolean) => void
  /** Sessions not in the repo: quick connects and the sessions behind live tabs. */
  otherSessions?: () => { name: string; host: string; username: string }[]
  broadcast: (channel: string, payload: unknown) => void
  confirm: (message: string, detail: string, ok: string) => Promise<boolean>
  /** "What left this machine": crash reports and dumps get a metadata-only row (L5). */
  egress?: EgressLog
}): PrivacySetup {
  const dev = !app.isPackaged
  const e2e = !!process.env['HOPLINE_E2E'] && dev
  // e2e (dev builds only): a local fake update server. Without it a dev build never checks.
  const testFeed = e2e ? process.env['HOPLINE_E2E_UPDATE_URL'] : undefined
  const version = app.getVersion()

  // electron-updater is loaded on the first check, not at startup: requiring it costs ~40 ms
  // before the window can open (bench: startup), and most launches never check in that time.
  const loadUpdater = (): AppUpdater => (require('electron-updater') as typeof import('electron-updater')).autoUpdater
  const backend = (): UpdaterBackend => {
    const autoUpdater = loadUpdater()
    // electron-updater normally sends its per-install rollout UUID on every feed request.
    // It determines rollout eligibility locally, so the server needs no identifying value.
    autoUpdater.requestHeaders = { ...autoUpdater.requestHeaders, 'x-user-staging-id': '' }
    if (testFeed) {
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
      autoUpdater.disableDifferentialDownload = true
      // The test must see "restart" asked for, and nothing may ever be installed.
      const record = () => ((globalThis as { __hoplineInstallRequested?: number }).__hoplineInstallRequested = ((globalThis as { __hoplineInstallRequested?: number }).__hoplineInstallRequested ?? 0) + 1)
      return new Proxy(autoUpdater, {
        get: (t, k) => (k === 'quitAndInstall' ? record : (Reflect.get(t, k) as unknown)),
        set: (t, k, v) => Reflect.set(t, k, v)
      }) as unknown as UpdaterBackend
    }
    return autoUpdater as unknown as UpdaterBackend
  }

  const updates = new UpdateService({
    backend,
    settings: () => o.settings.get(),
    locks: () => o.policy.locks,
    version,
    mode: updateMode,
    openSessions: o.liveSessions,
    freeze: o.freezeSessions,
    emit: (s) => o.broadcast('update:status', s),
    releaseUrl: (v) => `${__HOPLINE_RELEASES_URL__}/tag/v${encodeURIComponent(v)}`,
    dev: dev && !testFeed,
    installOnQuit: !e2e,
    ...(testFeed ? { firstDelayMs: Number(process.env['HOPLINE_E2E_UPDATE_DELAY'] ?? 600_000) } : {})
  })

  const known = (): string[] => {
    const out: string[] = []
    for (const s of o.repo.listSessions()) out.push(s.name, s.host, s.username, ...s.tags)
    for (const s of o.otherSessions?.() ?? []) out.push(s.name, s.host, s.username)
    for (const f of o.repo.listFolders()) out.push(f.name)
    for (const c of o.repo.listCredentials()) out.push(c.name, c.username ?? '')
    try {
      out.push(userInfo().username, hostname())
    } catch {
      // no user database entry (containers)
    }
    return out
  }

  const crash = new CrashReporting({
    settings: () => o.settings.get(),
    locks: () => o.policy.locks,
    known,
    version,
    builtInDsn: typeof __HOPLINE_SENTRY_DSN__ === 'string' ? __HOPLINE_SENTRY_DSN__ : '',
    // net.fetch: Chromium's network stack, so a corporate proxy applies like it does to updates.
    fetch: async (url, init) => {
      const r = await net.fetch(url, { method: init.method, body: init.body as BodyInit, headers: init.headers })
      return { status: r.status, headers: r.headers }
    },
    dumpsDir: () => app.getPath('crashDumps'),
    // Local only: dumps are never uploaded by Crashpad, only one by one after a confirmation.
    startNative: e2e ? undefined : startCrashpad,
    confirm: o.confirm,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    environment: dev ? 'development' : /-/.test(version) ? 'beta' : 'production',
    egress: o.egress
      ? ({ kind, destination, bytes }) => {
          const log = o.egress!
          const row = log.record({ provider: 'sentry', model: kind === 'dump' ? 'crash dump' : 'crash report', destination, source: 'crash', bytes, body: { kind, bytes } })
          return (status) =>
            void row.then(({ id }) => log.finish(id, { status: status !== null && status >= 200 && status < 300 ? 'ok' : 'error' })).catch(() => undefined)
        }
      : undefined
  })

  // Errors in main. The monitor variant only observes: Electron's own handling is unchanged.
  process.on('uncaughtExceptionMonitor', (e, origin) => void crash.capture(e, 'main', origin === 'unhandledRejection' ? 'rejection' : 'exception'))
  process.on('unhandledRejection', (r) => {
    console.error('[hopline] unhandled rejection:', r)
    crash.capture(r, 'main', 'rejection')
  })
  app.on('render-process-gone', (_e, _wc, d) => void crash.processGone('renderer', d.reason, d.exitCode))
  app.on('child-process-gone', (_e, d) => void crash.processGone(d.type, d.reason, d.exitCode))

  o.settings.onChange = () => {
    updates.reconfigure()
    crash.apply()
  }
  crash.apply()
  updates.start()
  registerPrivacyIpc({ updates, crash })
  return { updates, crash }
}

