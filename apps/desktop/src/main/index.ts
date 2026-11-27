import { AccountClients } from './llm/account-clients'
import { app, BrowserWindow, dialog, Notification, powerMonitor, session, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type { VaultInfo } from '@shared/types'
import { AuditLog } from './db/audit'
import { openDb, type DB } from './db'
import { Repo } from './db/repo'
import { visibleDevices } from './db/legacy-lab'
import { registerCoreIpc, setTrustedPage, trustedSender, type Pickers } from './ipc'
import { APP_HOST, APP_INDEX, APP_SCHEME, registerAppScheme, serveApp } from './app-protocol'
import { FolderSync, SYNC_PASSPHRASE_SETTING } from './backup/sync'
import { NetBoxStore } from './importer/netbox'
import { registerTermIpc } from './ipc/term'
import { registerAgentIpc } from './ipc/agent'
import { registerBlocksIpc } from './ipc/blocks'
import { Agent } from './agent/agent'
import { WorkspaceChat } from './agent/workspace-chat'
import { workspaceChatHandlers } from './ipc/workspace-chat'
import { PlatformDetector } from './detect'
import { AiService } from './llm/service'
import { registerAiIpc } from './ipc/ai'
import { registerLinksIpc } from './ipc/links'
import { frameOptions, registerWindowIpc, watchFrame } from './ipc/window'
import { keymapHandlers, multiHandlers, registerProductivityIpc, snippetHandlers } from './ipc/productivity'
import { MultiService } from './productivity/multi'
import { FleetService } from './fleet/service'
import { registerFleetIpc } from './ipc/fleet'
import { registerParser } from './productivity/parsers'
import { parseSafe } from './parse/safe'
import { ProductivityStore } from './productivity/store'
import { GuardedRunner } from './productivity/runner'
import { SnippetService } from './productivity/snippets'
import { PacketWorkspace } from './packets/workspace'
import { packetsHandlers } from './ipc/packets'
import { registerAll } from './ipc'
import { registerFilesIpc } from './ipc/files'
import { registerBackupIpc } from './ipc/backups'
import { BackupService } from './backups/service'
import { BackupStore } from './backups/store'
import { isLocked } from './vault/datakey'
import { SessionHostClient } from './host/client'
import { PromptBroker } from './prompts'
import { SettingsService } from './settings'
import { ScrollbackStore } from './store/scrollback'
import { legacyUnseal, noKeychain, osKeychain, testKeychain } from './vault'
import { UnlockBroker } from './vault/unlock'
import { Vault } from './vault/vault'
import { loadPolicy, PolicyService } from './policy/policy'
import { EgressLog } from './egress/store'
import { registerTrustIpc } from './ipc/trust'
import { UxStore } from './ux'
import { registerUxIpc } from './ipc/ux'
import { Notifier, type DesktopNote } from './notify'
import { parseDeepLink, type DeepLink } from '@shared/settings-registry'
import { resolveOverrides } from '@shared/ux'
import { setupPrivacy, startCrashpadIfOptedIn } from './privacy'
import { isSmoke, runSmoke } from './smoke'
import { flushAll } from './flush'
import windowIcon from '../../build/icons/256x256.png?asset'
import { installMenu, openArg, savedPlacement, sendCommand, setupAppMenu, trackPlacement } from './app-menu'

// The vault reads its own records before the repo exists (the repo needs the vault's key).
const peekSetting = (db: DB, k: string): string | undefined => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value
const putSetting = (db: DB, k: string, v: string | null): void => {
  if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k)
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
}

/** True only in the benchmark's own local build (electron.vite.config.ts); never in a release. */
declare const __HOPLINE_BENCH_BUILD__: boolean
const benchBuild = typeof __HOPLINE_BENCH_BUILD__ === 'boolean' && __HOPLINE_BENCH_BUILD__

// P8 I4: a packaged build refuses to run with a remote-debugging switch. Electron has no fuse for
// it, and over CDP a same-user process could drive the renderer and its bridge. (`--inspect` on
// main is fused off.) The benchmark's own unfused build is the one exception.
const debugRefused = app.isPackaged && !benchBuild && ['remote-debugging-port', 'remote-debugging-pipe'].some((s) => app.commandLine.hasSwitch(s))
if (debugRefused) {
  console.error('[hopline] refusing to start with a remote-debugging switch')
  app.exit(1)
}

// P8 M4: the renderer is served from app://hopline (app-protocol.ts), registered before ready.
registerAppScheme()

/** The dev server (unpackaged builds only): in a packaged build it would load any page with the full bridge. */
const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
const devOrigin = (() => {
  try {
    return devUrl ? new URL(devUrl).origin : null
  } catch {
    return null
  }
})()
/** The app's own origin: app://hopline, or the dev server in unpackaged builds. */
const ownOrigin = (u: URL): boolean => (u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && !u.port && !u.username) || (!!devOrigin && u.origin === devOrigin)
/** The app's own page (origin and path; the hash route varies). */
const ownPage = (u: URL): boolean => ownOrigin(u) && (u.pathname === '/index.html' || (!!devOrigin && u.origin === devOrigin && u.pathname === '/'))
const parsed = (raw: string | undefined): URL | null => {
  try {
    return raw ? new URL(raw) : null
  } catch {
    return null
  }
}

/**
 * Every web contents (the window, and anything that might ever be created): no navigation away,
 * no redirects, no new windows (links go through links:open, which asks in main), no webviews
 * (P8 M4, C-L3, I5).
 */
app.on('web-contents-created', (_e, wc: WebContents) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.on('will-redirect', (e) => e.preventDefault())
  wc.on('will-frame-navigate', (e) => {
    if (!e.isSameDocument) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
})

/**
 * Chromium permissions (P8 C-L2): only the clipboard, which the terminal uses for copy and paste,
 * and only for the app's own page. Camera, microphone, geolocation, notifications (main shows
 * those itself), HID, serial (node-serialport in the host), USB and the rest are denied.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])
function lockPermissions(): void {
  const s = session.defaultSession
  s.setPermissionRequestHandler((wc, permission, cb, details) => {
    const u = parsed(details.requestingUrl) ?? parsed(wc.getURL())
    cb(ALLOWED_PERMISSIONS.has(permission) && !!u && ownOrigin(u))
  })
  s.setPermissionCheckHandler((_wc, permission, origin) => {
    const u = parsed(origin)
    return ALLOWED_PERMISSIONS.has(permission) && !!u && ownOrigin(u)
  })
  s.setDevicePermissionHandler(() => false)
}

if (process.platform === 'linux' && /microsoft/i.test(release())) {
  if (process.env['HOPLINE_GPU'] === '1') {
    // WSLg can stall the GPU thread rasterizing new UI tiles. Keep WebGL and GPU
    // compositing for xterm while Chromium rasterizes the surrounding UI on the CPU.
    app.commandLine.appendSwitch('disable-gpu-rasterization')
  } else {
    // Software compositing avoids diagonal artifacts on bordered elements under WSLg.
    app.disableHardwareAcceleration()
  }
}

/** Multi-device runs, stopped when the window that started them reloads or closes. */
let multi: MultiService | undefined
/** Fleet runs (F10), stopped the same way. */
let fleet: FleetService | undefined
let snippets: SnippetService | undefined
/** Waits for scrollback writes (set once the store exists): window close and quit flush first (L8). */
let scrollbackIdle: (() => Promise<void>) | null = null
/** A quit is under way (before-quit ran its flush). */
let quitting = false

function createWindow(host?: SessionHostClient): void {
  // Honoured in packaged builds too (window placement only, nothing else): the startup benchmark
  // runs the packaged app and must not pop a window over the user's desktop (docs/PERFORMANCE.md).
  const hidden = process.env['HOPLINE_HIDDEN'] === '1'
  // Where the window was last time on these displays (never under test: tests place it themselves).
  const placed = hidden ? null : savedPlacement({ width: 900, height: 560 })
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(placed?.bounds ?? {}),
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0d0e10',
    // Linux takes the window and taskbar icon from here (Windows and macOS from the executable).
    ...(process.platform === 'linux' ? { icon: windowIcon } : {}),
    // Frameless: the tabs are the title bar (ipc/window.ts).
    ...frameOptions(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // No DevTools in a packaged build (P8 I4); there is no menu path to them either.
      devTools: !app.isPackaged || benchBuild,
      // Hidden test windows must keep rendering and running timers at full speed.
      ...(hidden ? { backgroundThrottling: false } : {}),
      // e2e (dev builds only): the renderer keeps its clipboard in memory, never the user's real one.
      ...(process.env['HOPLINE_E2E'] && !app.isPackaged ? { additionalArguments: ['--hopline-e2e'] } : {})
    },
    // Off-screen, out of the taskbar and never focusable: the user's desktop is untouched, but the
    // page still counts as visible, so rendering and animation frames run at full speed.
    ...(hidden ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {})
  })
  // Tests run with HOPLINE_HIDDEN=1: the window renders and takes input but stays off-screen and never steals focus.
  win.once('ready-to-show', () => {
    performance.mark('hopline:main:readyToShow')
    if (hidden) {
      // Off-screen at the full test size, whatever the display: an OS may fit a new window to a
      // small screen (a CI runner's 1024x768), which would wrap device output and move drag targets.
      win.setBounds({ x: -32000, y: -32000, width: 1440, height: 900 })
      win.showInactive()
    } else {
      if (placed?.maximized) win.maximize()
      win.show()
    }
  })
  if (!hidden) {
    trackPlacement(win)
    if (placed?.zoom) win.webContents.once('did-finish-load', () => win.webContents.setZoomLevel(placed.zoom))
  }
  watchFrame(win)
  // A reload or close drops the renderer's ports: close its tabs so nothing keeps running unseen.
  const wc = win.webContents
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) (host?.closeFor(wc), multi?.cancelFor(wc), fleet?.cancelFor(wc), snippets?.dropFor(wc))
  })
  wc.on('destroyed', () => (host?.closeFor(wc), multi?.cancelFor(wc), fleet?.cancelFor(wc), snippets?.dropFor(wc)))
  // No new windows and no navigation: see 'web-contents-created' above. Links go through links:open.
  // Closing the window ends every session in it: ask first.
  let flushed = false
  win.on('close', (e) => {
    if (flushed) return
    const n = host?.openCount(win.webContents) ?? 0
    // e2e (dev builds only) skips the prompt; a packaged build always asks.
    if (n > 0 && !(process.env['HOPLINE_E2E'] && !app.isPackaged)) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Close sessions and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Close ${n} open session${n === 1 ? '' : 's'}?`,
        detail: 'Every device connection in this window will end.'
      })
      if (r !== 0) return void e.preventDefault()
    }
    // Review L8: every tab saves its scrollback before the window goes, then the window closes
    // (a quit flushes every window itself in before-quit).
    if (!scrollbackIdle || quitting) return
    e.preventDefault()
    flushed = true
    void flushAll([win.webContents], scrollbackIdle).finally(() => {
      if (!win.isDestroyed()) win.close()
    })
  })

  // Dev-only: HOPLINE_SCREENSHOT=out.png [HOPLINE_HASH=#/design] captures the window and quits.
  const shot = process.env['HOPLINE_SCREENSHOT']
  const typing = process.env['HOPLINE_TYPE']
  const reply = process.env['HOPLINE_PROMPT_REPLY']
  const keys = process.env['HOPLINE_KEYS']
  const sendKeys = (text: string) => {
    for (const ch of text.replace(/\\r/g, '\r')) {
      if (ch === '\r') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      } else {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
        win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
      }
    }
  }
  // Dev-only: type HOPLINE_KEYS as real key events (exercises xterm's input path, e.g. "@ai").
  const typeKeys = () => keys && setTimeout(() => sendKeys(keys), Number(process.env['HOPLINE_KEYS_DELAY'] ?? 2500))
  if (reply && !app.isPackaged) {
    // Dev-only: answer the first password prompt for scripted screenshots, once it has focus.
    const poll = async (tries: number): Promise<void> => {
      const ready = await win.webContents.executeJavaScript(`document.activeElement?.getAttribute('type') === 'password'`).catch(() => false)
      if (!ready) return void (tries > 0 && setTimeout(() => void poll(tries - 1), 200))
      win.webContents.insertText(reply)
      sendKeys('\r')
      typeKeys()
    }
    win.webContents.once('did-finish-load', () => void poll(100))
  } else if (keys && !app.isPackaged) win.webContents.once('did-finish-load', () => typeKeys())
  if (typing && !app.isPackaged) {
    // Dev-only: type into the focused terminal once it is connected (\r separated lines).
    const lines = typing.replace(/\\r/g, '\r').split(/(?<=\r)/)
    const next = (i: number) => i < lines.length && (sendKeys(lines[i]!), setTimeout(() => next(i + 1), 700))
    setTimeout(() => next(0), Number(process.env['HOPLINE_TYPE_DELAY'] ?? 2500))
  }
  if (shot && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage()
        writeFileSync(shot, img.toPNG())
        app.quit()
      }, Number(process.env['HOPLINE_SHOT_DELAY'] ?? 1500))
    })
  }

  const hash = process.env['HOPLINE_HASH']?.replace(/^#/, '')
  // Every finished load (the first one, a reload) delivers a deep link that waited for the page.
  wc.on('did-finish-load', () => {
    if (!pendingLink || BrowserWindow.getAllWindows()[0] !== win) return
    const link = pendingLink
    pendingLink = null
    wc.send('app:deep-link', link)
  })
  // A dev server URL only in dev builds (devUrl above): in a packaged (signed) build it would load
  // any page with the full preload bridge. Otherwise the app's own origin, never file:// (P8 M4).
  if (devUrl) void win.loadURL(devUrl + (hash ? `#${hash}` : ''))
  else void win.loadURL(APP_INDEX + (hash ? `#${hash}` : ''))
}

// Isolated profile for tests and side-by-side dev instances (ignored in packaged builds).
if (process.env['HOPLINE_USER_DATA'] && !app.isPackaged) app.setPath('userData', process.env['HOPLINE_USER_DATA'])
else if (__HOPLINE_DEV_LAB__ && !app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Hopline Development'))

/**
 * The application menu lives in app-menu.ts (tree: shared/menu.ts). Windows and Linux get no native
 * menu: Electron's default one would bind Ctrl+R / Ctrl+W (reload, close) and drop every live
 * session, and those keys belong to the device. The renderer draws the menu bar there instead.
 */
const broadcast = (channel: string, payload: unknown): void => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload)
}

/** Native dialogs for main-owned file access. e2e replaces `dialog` methods via app.evaluate. */
const pickers: Pickers = {
  openKeyFile: async () => {
    const r = await dialog.showOpenDialog({ title: 'Choose a private key', defaultPath: join(app.getPath('home'), '.ssh'), properties: ['openFile', 'showHiddenFiles'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  saveExport: async (name) => {
    const r = await dialog.showSaveDialog({ title: 'Export Hopline Terminal data', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Hopline Terminal export', extensions: ['hopline'] }] })
    return r.canceled ? null : (r.filePath ?? null)
  },
  openExport: async () => {
    const r = await dialog.showOpenDialog({ title: 'Import Hopline Terminal data', filters: [{ name: 'Hopline Terminal export', extensions: ['hopline'] }], properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  pickDir: async () => {
    const r = await dialog.showOpenDialog({ title: 'Choose a sync folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  openImport: async ({ title, dir, filters, defaultPath }) => {
    const r = await dialog.showOpenDialog({
      title,
      defaultPath,
      ...(filters?.length ? { filters } : {}),
      properties: dir ? ['openDirectory'] : ['openFile', 'showHiddenFiles']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  sshConfigPath: () => join(app.getPath('home'), '.ssh', 'config'),
  confirm: async (message, detail, ok) => {
    const opts = { type: 'warning' as const, buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1, message, detail }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    return (await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))).response === 0
  }
}

/**
 * hopline:// deep links (shared/settings-registry.ts). Registered with the OS only in packaged
 * builds, so dev runs and tests never claim the scheme on the developer's machine. The URL is
 * untrusted: parseDeepLink allow-lists it, and it only ever navigates inside Settings.
 */
let pendingLink: DeepLink | null = null
function deliverLink(url: string): void {
  const link = parseDeepLink(url)
  if (!link) return
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isLoading()) {
    pendingLink = link
    return
  }
  if (win.isMinimized()) win.restore()
  win.webContents.send('app:deep-link', link)
}
app.on('open-url', (e, url) => {
  e.preventDefault()
  deliverLink(url)
})
/**
 * Startup gate. `--smoke` loads the native modules and exits (smoke.ts). A second instance (a
 * hopline:// link clicked while Hopline runs) hands its arguments to the first one and exits at
 * once: `app.quit()` alone would still let `ready` fire, and the second process would open the
 * database, run migrations and initialise the vault on the same profile (review M4). Nothing
 * below runs unless this process is the primary instance.
 * e2e (dev builds only): HOPLINE_E2E_SINGLE_INSTANCE=1 takes the lock like a packaged build.
 */
const smoke = isSmoke()
const lockInstance = app.isPackaged || (!!process.env['HOPLINE_E2E'] && process.env['HOPLINE_E2E_SINGLE_INSTANCE'] === '1')
const primary = !debugRefused && !smoke && (!lockInstance || app.requestSingleInstanceLock())
if (smoke && !debugRefused) void runSmoke().then((code) => app.exit(code))
else if (!primary && !debugRefused) app.exit(0)
if (primary && lockInstance) {
  app.on('second-instance', (_e, argv) => {
    if (!app.isPackaged) (globalThis as { __hoplineSecondInstance?: number }).__hoplineSecondInstance = ((globalThis as { __hoplineSecondInstance?: number }).__hoplineSecondInstance ?? 0) + 1
    const url = argv.find((a) => a.startsWith('hopline://'))
    const win = BrowserWindow.getAllWindows()[0]
    if (win) (win.isMinimized() && win.restore(), win.focus())
    if (url) deliverLink(url)
    // A jump list entry (Windows): connect to that recent session in the running window.
    const open = openArg(argv)
    if (open) sendCommand('session.openRecent', open, win)
  })
}
if (primary && app.isPackaged) {
  app.setAsDefaultProtocolClient('hopline')
  const first = process.argv.find((a) => a.startsWith('hopline://'))
  if (first) pendingLink = parseDeepLink(first)
}
// e2e (dev builds only): deliver a deep link the way the OS would.
if (process.env['HOPLINE_E2E'] && !app.isPackaged) (globalThis as { __hoplineDeepLink?: (url: string) => void }).__hoplineDeepLink = deliverLink

/** e2e (dev builds only): desktop notifications are recorded here instead of shown. */
const recordedNotes: DesktopNote[] = []
if (process.env['HOPLINE_E2E'] && !app.isPackaged) (globalThis as { __hoplineNotes?: DesktopNote[] }).__hoplineNotes = recordedNotes

if (primary) void app.whenReady().then(async () => {
  if (lockInstance && !app.isPackaged) console.log('[hopline-e2e] startup ran')
  // Startup benchmark marks (bench/specs/startup.bench.ts reads them; no effect otherwise).
  performance.mark('hopline:main:whenReady')
  installMenu()
  // P8 M4 / C-L2 / C-L4: serve the renderer, allow only the clipboard, and take IPC only from the app's own page.
  serveApp(join(__dirname, '../renderer'))
  lockPermissions()
  setTrustedPage(ownPage)
  // e2e (dev builds only): the sender check, so a spec can feed it frames that aren't the app's page.
  if (process.env['HOPLINE_E2E'] && !app.isPackaged) (globalThis as { __hoplineIpcSender?: unknown }).__hoplineIpcSender = { trustedSender }
  mkdirSync(app.getPath('userData'), { recursive: true })
  const db = openDb(join(app.getPath('userData'), 'hopline.db'))
  // e2e on machines without a keyring (CI, WSL): a stand-in keychain, dev builds only.
  // A master password set by a test still wins (the vault checks for it first).
  const e2eKeys = !!process.env['HOPLINE_E2E'] && !app.isPackaged
  const rawSettings = { getSetting: (k: string) => peekSetting(db, k), setSetting: (k: string, v: string | null) => putSetting(db, k, v) }
  const vault = new Vault({
    settings: rawSettings,
    // HOPLINE_E2E_NO_KEYCHAIN=1: the stand-in reports no keychain, like Linux without a keyring.
    keychain: e2eKeys ? (process.env['HOPLINE_E2E_NO_KEYCHAIN'] ? noKeychain : testKeychain) : osKeychain,
    // Linux fires no lock-screen event; where the OS reports a locked screen, the auto-lock timer sees it.
    screenLocked: () => {
      try {
        return powerMonitor.getSystemIdleState(60) === 'locked'
      } catch {
        return false
      }
    }
  })
  const repo = new Repo(db, vault.key, legacyUnseal)
  // Team policy (docs/POLICY.md): loaded once, before anything reads a setting. Invalid fails closed.
  const policy = new PolicyService(loadPolicy())
  if (policy.info.state === 'invalid') console.error(`[hopline] team policy ${policy.info.source} is invalid (${policy.info.error}): read-only on, AI off`)
  else if (policy.info.state === 'active') console.log(`[hopline] team policy loaded from ${policy.info.source}`)
  const settings = new SettingsService(repo, vault.key, legacyUnseal, () => policy.locks)
  // e2e (dev builds only): the first-run privacy screen is answered, unless a spec tests it.
  if (e2eKeys && process.env['HOPLINE_E2E_FIRST_RUN'] !== '1' && !settings.get().privacyReviewed) settings.update({ privacyReviewed: true })
  // "What left this machine": every model request as sent, encrypted under the data key.
  const egress = new EgressLog(db, vault.key)
  const netbox = new NetBoxStore(repo, vault.key)
  vault.on('ephemeral', () => {
    // Session-only vault: whatever was saved last run is under a key that no longer exists.
    repo.dropEphemeralSecrets()
    settings.dropEphemeralApiKey()
    netbox.dropEphemeralToken()
    egress.dropAll()
    // Folder sync stays configured but asks for its passphrase again.
    repo.setSetting(SYNC_PASSPHRASE_SETTING, null)
  })
  await vault.init().catch((e) => console.error('[hopline] vault init failed:', e))
  if (vault.info().mode === 'keychain' && !vault.info().locked) {
    // One-time move of pre-DEK secrets (sealed one by one with safeStorage) under the data key.
    await repo.migrateLegacySecrets().catch((e) => console.error('[hopline] legacy credential migration deferred:', e))
    await settings.migrateLegacyApiKey().catch((e) => console.error('[hopline] legacy API key migration deferred:', e))
  }
  // Defense in depth: a folder cycle (from an older version or a hand-edited database) would hide
  // every session below it.
  const cut = repo.repairFolderCycles()
  if (cut) console.warn(`[hopline] moved ${cut} folder(s) out of a cycle to the top level`)
  const development = __HOPLINE_DEV_LAB__ && !app.isPackaged ? await import('./lab') : undefined
  if (development) await development.seedDevelopmentSessions(repo)
  const devices = visibleDevices(repo, !!development)
  // Commands are stored redacted; the keyed hash of the original needs the data key (see db/audit.ts:
  // derived while unlocked, dropped on lock, NULL hash while locked).
  const audit = new AuditLog(db, vault.key)
  void audit.prime()
  vault.on('change', (info: VaultInfo) => (info.locked ? audit.forget() : void audit.prime()))
  const scrollback = new ScrollbackStore(join(app.getPath('userData'), 'scrollback'), vault.key)
  scrollbackIdle = () => scrollback.idle()
  const sync = new FolderSync(repo, vault.key)
  repo.onChange = () => sync.markDirty()
  sync.on('status', (s) => broadcast('sync:status', s))
  const unlock = new UnlockBroker(vault, () => broadcast('vault:unlockRequest', null))
  vault.on('change', (info: VaultInfo) => {
    broadcast('vault:state', info)
    if (!info.locked) sync.resume()
  })
  vault.startAutoLock()
  // Lock when the machine sleeps or the screen locks. Linux has no lock-screen event: there it is
  // suspend, the polled idle state (screenLocked above) and the idle timer.
  powerMonitor.on('suspend', () => vault.lock())
  powerMonitor.on('lock-screen', () => vault.lock())
  powerMonitor.on('shutdown', () => vault.lock())
  registerCoreIpc({ repo, settings, audit, scrollback, vault, unlock, sync, pickers, netbox, skipVaultConfirm: e2eKeys, developmentLab: !!development })
  void sync.start()
  const prompts = new PromptBroker()
  const term = new SessionHostClient(repo, settings, prompts, () => unlock.request())
  // The policy's extra blocked commands: refused in main before signing, and again in the host.
  term.policyRules = policy.locks.blockedCommands
  // Before the session host starts, so an opted-in user's host crashes are caught too.
  startCrashpadIfOptedIn(settings)
  term.start()
  // F8: sessions on Auto-detect are identified on connect (an audited probe at most; see detect.ts).
  const detector = new PlatformDetector({
    host: term,
    audit,
    settings: () => settings.get(),
    save: (s, platform, detection) => (s.ephemeral ? term.ephemeral.update(s.id, { platform, detected: detection }) : repo.setDetectedPlatform(s.id, platform, detection))
  })
  term.onAutoConnected = (tab) => detector.onConnected(tab)
  registerTermIpc(term, prompts, repo)
  // SFTP/SCP and port forwards (Phase 4): local files only through main, every transfer audited.
  const files = registerFilesIpc({ host: term, audit, readOnly: () => !!settings.get().aiReadOnly })
  term.onReopened = (tabId) => files.forwards.restore(tabId)
  term.onClosed = (tabId) => files.forwards.forget(tabId)
  // Config backups: guarded reads on a connected tab, or on a background connection (stored credentials
  // only, always closed) like a multi-device run; encrypted history, schedules while the app runs.
  const backupStore = new BackupStore(db, vault.key, Date.now, audit)
  const backups = new BackupService({ host: term, repo: devices, audit, settings: () => settings.get(), store: backupStore, changed: () => broadcast('backups:changed', null) })
  // Older versions were encrypted with an AAD that did not bind the session: re-encrypt them once the
  // data key is available (now, or at the next unlock).
  const migrateBackups = () => void backupStore.migrateAad().catch((e) => isLocked(e) || console.error('[hopline] backup AAD migration:', e))
  vault.on('change', (info: VaultInfo) => (info.locked ? backupStore.forget() : migrateBackups()))
  migrateBackups()
  registerBackupIpc({
    service: backups,
    store: backupStore,
    audit,
    confirm: pickers.confirm,
    saveFile: async (name) => {
      const r = await dialog.showSaveDialog({ title: 'Export configuration', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Text', extensions: ['txt', 'cfg', 'conf'] }] })
      return r.canceled ? null : (r.filePath ?? null)
    }
  })
  backups.start()
  // Only a tab the user opened counts: background connections (multi runs, background backups) would
  // otherwise re-trigger the pending backup from inside its own capture.
  term.onConnected = (tab) => {
    if (!term.tabsOf(tab.session.id).some((t) => t.tabId === tab.tabId)) return
    void backups.onConnected(tab.session.id).catch((e) => console.error('[hopline] scheduled backup on connect:', e))
  }
  // e2e hook (dev builds only): lets tests crash the session host from the main process.
  if (process.env['HOPLINE_E2E'] && !app.isPackaged) (globalThis as { __hoplineHost?: SessionHostClient }).__hoplineHost = term
  // e2e (dev builds only): a local fake Anthropic API, so a key pasted in a test never leaves the machine.
  const accounts = new AccountClients(join(app.getPath('userData'), 'provider-accounts'), settings)
  vault.on('change', () => { if (vault.info().locked) accounts.interrupt() })
  app.once('will-quit', () => accounts.close())
  const ai = new AiService(settings, { accounts, vaultLocked: () => vault.info().locked, anthropicBaseURL: e2eKeys ? (process.env['HOPLINE_E2E_ANTHROPIC_URL'] ?? 'http://127.0.0.1:9') : undefined, policy, egress })
  registerAiIpc(ai)
  registerTrustIpc({
    egress,
    policy,
    audit,
    saveFile: async (name) => {
      const r = await dialog.showSaveDialog({ title: 'Export what left this machine', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] })
      return r.canceled ? null : (r.filePath ?? null)
    }
  })
  registerLinksIpc(pickers.confirm)
  registerWindowIpc()
  setupAppMenu({ firstRecent: app.isPackaged ? openArg(process.argv) : undefined, confirm: pickers.confirm, logDir: () => settings.get().logDir, newWindow: () => createWindow(term) })
  // Phase 6: onboarding, overrides, custom themes and the bundled simulator lab.
  const ux = new UxStore(repo)
  const lab = development ? new development.SimulatorLab(repo, join(app.getPath('userData'), 'lab_host_key')) : undefined
  registerUxIpc(ux, lab, {
    openTheme: async () => {
      const r = await dialog.showOpenDialog({ title: 'Import a theme', filters: [{ name: 'Themes', extensions: ['json', 'itermcolors', 'ini', 'rtcp', 'termcolors'] }], properties: ['openFile'] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    saveTheme: async (name) => {
      const r = await dialog.showSaveDialog({ title: 'Export theme', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Hopline Terminal theme', extensions: ['json'] }] })
      return r.canceled ? null : (r.filePath ?? null)
    }
  })
  term.overridesFor = (s) => resolveOverrides(ux.overrides(), repo.listFolders(), { session: s }).values
  const e2eNotes = !!process.env['HOPLINE_E2E'] && !app.isPackaged
  const notifier = new Notifier({
    settings: () => settings.get(),
    focused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    show: (n, onClick) => {
      if (e2eNotes) return void recordedNotes.push(n)
      if (!Notification.isSupported()) return
      const note = new Notification({ title: n.title, body: n.body, silent: n.kind === 'disconnect' })
      note.on('click', onClick)
      note.show()
    },
    reveal: () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  // P8 D-L4: a background connection that trusts a new host key leaves an audit row.
  term.onBackgroundHostKey = (tab, k) =>
    audit.append({
      sessionId: tab?.session.id ?? null,
      sessionName: tab?.session.name ?? '(background connection)',
      host: `${k.host}:${k.port}`,
      source: 'app',
      command: '(host key)',
      kind: 'host-key',
      decision: 'confirmed',
      reason: `trusted a new host key on first use on a background connection, without asking: ${k.fingerprint}`,
      approver: null,
      durationMs: null,
      bytes: null,
      redactions: null
    })
  term.onDropped = (tab, info) => {
    notifier.disconnect(tab.session.id, tab.session.name, info.detail, info.state === 'reconnecting')
  }
  const agent = new Agent({
    term,
    settings,
    audit,
    provider: () => ai.provider(),
    emit: (e) => {
      // Only the window that owns the tab hears about its agent run (P8 I6).
      const wc = term.windowOf(e.tabId)
      if (wc && !wc.isDestroyed()) wc.send('agent:event', e)
      if (e.type === 'proposal') notifier.approval(e.proposalId, term.get(e.tabId)?.session.name ?? 'a session', e.commands.length, !!e.disruptive)
    }
  })
  registerAgentIpc(agent, (tabId, wc) => term.ownedBy(tabId, wc as Electron.WebContents))
  registerAll(workspaceChatHandlers(() => new WorkspaceChat(
    devices.inventory,
    () => ai.provider()
  )))
  // Phase 4: keymap, snippets and the button bar, send-to-many and multi-device runs.
  const productivity = new ProductivityStore(repo)
  const runner = new GuardedRunner({ term, settings, audit })
  const packetWindows = new WeakMap<Electron.WebContents, PacketWorkspace>()
  registerAll(packetsHandlers((wc) => {
    const current = packetWindows.get(wc)
    if (current) return current
    const workspace = new PacketWorkspace({
      runner, owns: (tabId) => term.ownedBy(tabId, wc),
      stage: (s, canFinish = false) => { if (!wc.isDestroyed()) wc.send('packets:stage', s, canFinish) },
      choose: () => pickers.openImport({ title: 'Open packet capture', dir: false, filters: [{ name: 'Packet captures', extensions: ['pcap', 'pcapng', 'cap'] }] }),
      saveAs: async (name) => {
        const r = await dialog.showSaveDialog({ title: 'Save packet capture', defaultPath: name })
        return r.canceled ? null : r.filePath ?? null
      },
      download: (id) => files.transfers.captureDownload(wc, id),
      destination: (tabId, path) => files.transfers.captureDestination(tabId, wc, path),
      receive: (tabId, path, signal, stage) => files.transfers.receiveCapture(tabId, wc, path, signal, stage),
      provider: () => ai.provider(), sessions: devices.listSessions
    })
    packetWindows.set(wc, workspace)
    const release = () => workspace.close()
    wc.on('did-navigate', release)
    wc.once('destroyed', release)
    return workspace
  }))
  // Multi-device Table tab: the bundled TextFSM templates, in a vm with a time budget (parse/safe.ts).
  registerParser((platform, command, text, opts) => parseSafe(platform, command, text, opts?.budgetMs, opts?.budget))
  multi = new MultiService({ host: term, runner, repo: devices, emit: (wc, ev) => !(wc as Electron.WebContents).isDestroyed() && (wc as Electron.WebContents).send('multi:event', ev) })
  snippets = new SnippetService(productivity, runner, repo)
  registerProductivityIpc({ ...keymapHandlers(productivity), ...snippetHandlers(productivity, snippets, (tabId, wc) => term.ownedBy(tabId, wc as Electron.WebContents)), ...multiHandlers(multi) })
  registerBlocksIpc({ term, audit, settings, owns: (tabId, wc) => term.ownedBy(tabId, wc as Electron.WebContents) })
  // F10 fleet agent (read-only): a coordinator and per-device workers on background connections.
  fleet = new FleetService({
    host: term,
    repo: devices,
    settings,
    audit,
    provider: () => ai.provider(),
    emit: (wc, ev) => !(wc as Electron.WebContents).isDestroyed() && (wc as Electron.WebContents).send('fleet:event', ev),
    policy: () => ({ fleetMaxConcurrency: policy.locks.fleetMaxConcurrency, fleetMaxTokenBudget: policy.locks.fleetMaxTokenBudget, aiOff: policy.aiOff() })
  })
  registerFleetIpc(fleet)
  // Phase 7: update checks (D8, the only phone-home) and opt-in crash reports (D7).
  const privacy = setupPrivacy({ repo, settings, policy, liveSessions: () => term.liveCount(), freezeSessions: (on) => (term.installingUpdate = on), otherSessions: () => term.sessionsSeen(), broadcast, confirm: pickers.confirm, egress })
  app.on('before-quit', (e) => {
    // Review L8: first save every window's scrollback (the vault and the store must still be up),
    // then quit for real.
    if (!quitting) {
      quitting = true
      e.preventDefault()
      void flushAll(BrowserWindow.getAllWindows().map((w) => w.webContents), () => scrollback.idle()).finally(() => app.quit())
      return
    }
    privacy.updates.stop()
    void privacy.crash.close()
    // Dumps Crashpad wrote after an opt-out in this run (it cannot be stopped) go now (M2).
    privacy.crash.sweepDumps()
    // Fleet runs first: their lanes send Ctrl-C and close their background tabs while the host is up.
    fleet?.cancelAll()
    agent.dispose()
    term.shutdown()
    backups.stop()
    sync.stop()
    vault.stop()
    void lab?.stop()
  })
  performance.mark('hopline:main:createWindow')
  createWindow(term)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(term)
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
