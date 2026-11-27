import { app, BrowserWindow, dialog, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron'
import { release, type } from 'node:os'
import { join } from 'node:path'
import { buildDockTemplate, buildTemplate, HELP_URLS, type MainCommand, type MenuSnapshot, type TemplateItem } from '@shared/menu'
import type { AppInfo } from '@shared/types'
import { openConfirmedLink, type ConfirmLink } from './ipc/links'
import { registerMenuIpc } from './ipc/menu'
import { writePrivateFile } from './private-file'
import { displayKey, readStateFile, restoreBounds, withState, writeStateFile, type WindowState } from './window-state'

/**
 * The application menu, the dock and the jump list (shared/menu.ts holds the tree), Help › About,
 * and window placement. See docs/guide/menus.md.
 *
 * Windows and Linux have no native menu: the window is frameless and the renderer draws its own
 * menu bar, so no native accelerator can ever take a key from the terminal. macOS has the native
 * menu bar, rebuilt from the renderer's snapshot.
 */
const mac = process.platform === 'darwin'
let last: MenuSnapshot | null = null
const snapshots = new WeakMap<Electron.WebContents, MenuSnapshot>()
let pendingRecent: string | undefined

/** The window a menu acts on: the one clicked from, the focused one, else the first. */
const target = (w?: BrowserWindow | null): BrowserWindow | undefined => (w && !w.isDestroyed() ? w : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]))

/** Send a command to a window's renderer, which checks it against its own list and its gate. */
export function sendCommand(id: string, arg?: string, w?: BrowserWindow | null): void {
  const win = target(w)
  if (!win || win.webContents.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.webContents.send('menu:command', arg === undefined ? { id } : { id, arg })
}

function toElectron(items: TemplateItem[], extra?: (id: string) => (() => void) | undefined): MenuItemConstructorOptions[] {
  return items.map((it) => {
    const { command, submenu, ...rest } = it
    const o: MenuItemConstructorOptions = { ...rest }
    if (submenu) o.submenu = toElectron(submenu, extra)
    if (command) {
      const own = extra?.(command.id)
      o.click = (_i, w) => (own ? own() : sendCommand(command.id, command.arg, w as BrowserWindow | undefined))
    }
    return o
  })
}

/** Build the native menu (macOS) or clear it (Windows, Linux: the in-app bar is the menu). */
export function installMenu(): void {
  if (!mac) return Menu.setApplicationMenu(null)
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectron(buildTemplate(last, { mac: true, dev: !app.isPackaged }))))
}

let newWindow: () => void = () => {}

function installDock(): void {
  if (!mac || !app.dock) return
  app.dock.setMenu(Menu.buildFromTemplate(toElectron(buildDockTemplate(last), (id) => (id === 'window.new' ? newWindow : undefined))))
}

/** Windows: recent sessions in the taskbar's jump list (packaged builds; they relaunch the exe). */
function installJumpList(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const items = (last?.recent ?? []).map((r) => ({ type: 'task' as const, title: r.label, description: `Connect to ${r.label}`, program: process.execPath, args: `--hopline-open=${r.id}`, iconPath: process.execPath, iconIndex: 0 }))
  try {
    app.setJumpList(items.length ? [{ type: 'custom', name: 'Recent sessions', items }] : null)
  } catch (e) {
    console.warn('[hopline] jump list:', e)
  }
}

/** `--hopline-open=<session id>` from a jump list entry (validated; the renderer checks it exists). */
export function openArg(argv: readonly string[]): string | undefined {
  const v = argv.find((a) => a.startsWith('--hopline-open='))?.slice('--hopline-open='.length)
  return v && /^[\w-]{1,64}$/.test(v) ? v : undefined
}

const ZOOM_MIN = -3
const ZOOM_MAX = 5

function runMainCommand(id: MainCommand, sender: Electron.WebContents, logDir: () => string, confirm: ConfirmLink): void | Promise<void> {
  const win = BrowserWindow.fromWebContents(sender)
  const zoom = (z: number) => sender.setZoomLevel(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)))
  switch (id) {
    case 'app.quit':
      return app.quit()
    case 'window.minimize':
      return void win?.minimize()
    case 'window.zoom':
      return void (win && (win.isMaximized() ? win.unmaximize() : win.maximize()))
    case 'window.close':
      return void win?.close()
    case 'view.fullScreen':
      return void win?.setFullScreen(!win.isFullScreen())
    case 'view.zoomIn':
      return zoom(sender.getZoomLevel() + 0.5)
    case 'view.zoomOut':
      return zoom(sender.getZoomLevel() - 0.5)
    case 'view.zoomReset':
      return zoom(0)
    case 'help.guide':
    case 'help.releaseNotes':
    case 'help.reportIssue':
      // Fixed URLs (shared/menu.ts): nothing from the renderer is opened.
      return openConfirmedLink(HELP_URLS[id], confirm).then(() => {})
    case 'help.logsFolder':
      return void shell.openPath(logDir())
    case 'help.devTools':
      if (!app.isPackaged) sender.toggleDevTools()
      return
  }
}

export function appInfo(): AppInfo {
  return {
    name: 'Hopline Terminal',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    v8: process.versions.v8,
    os: `${type()} ${release()} (${process.arch})`,
    license: 'Apache-2.0'
  }
}

function showSnapshot(snapshot: MenuSnapshot | null): void {
  last = snapshot
  if (mac) installMenu()
  installDock()
  installJumpList()
}

export function setupAppMenu(opts: { firstRecent?: string; confirm: ConfirmLink; logDir: () => string; newWindow: () => void }): void {
  newWindow = opts.newWindow
  pendingRecent = opts.firstRecent
  app.on('browser-window-focus', (_event, win) => showSnapshot(snapshots.get(win.webContents) ?? null))
  registerMenuIpc({
    snapshot: (s, sender) => {
      snapshots.set(sender, s)
      if (pendingRecent) {
        sendCommand('session.openRecent', pendingRecent, BrowserWindow.fromWebContents(sender))
        pendingRecent = undefined
      }
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused || focused.webContents === sender) showSnapshot(s)
    },
    command: (id, sender) => runMainCommand(id, sender, opts.logDir, opts.confirm),
    info: appInfo,
    savePath: async (name) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const o = { title: 'Save output as', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Text', extensions: ['txt', 'log'] }] }
      const r = await (win ? dialog.showSaveDialog(win, o) : dialog.showSaveDialog(o))
      return r.canceled ? null : (r.filePath ?? null)
    },
    // Terminal output can hold device secrets: the file is readable by this user only.
    write: (path, text) => writePrivateFile(path, text)
  })
  installMenu()
  installDock()
}

// ---------------------------------------------------------------- window placement

const statePath = () => join(app.getPath('userData'), 'window-state.json')

/** Saved placement for the current displays, ready for `new BrowserWindow` (null: defaults). */
export function savedPlacement(min: { width: number; height: number }): WindowState | null {
  const displays = screen.getAllDisplays()
  const file = readStateFile(statePath())
  return restoreBounds(file.setups[displayKey(displays)], displays.map((d) => d.workArea), min)
}

/** Remember the window's placement (debounced on move and resize, and on close). */
export function trackPlacement(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), zoom: win.webContents.getZoomLevel() }
    const file = withState(readStateFile(statePath()), displayKey(screen.getAllDisplays()), state)
    void writeStateFile(statePath(), file).catch((e) => console.warn('[hopline] window state:', e))
  }
  const soon = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) win.on(ev as 'resize', soon)
  win.webContents.on('zoom-changed', soon)
  win.on('close', save)
}
