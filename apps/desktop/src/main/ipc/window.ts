import { app, BrowserWindow, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import { handler as h, registerAll, type Handler } from '.'
import type { FrameState } from '@shared/types'

/**
 * The frameless window (docs/design/VISUAL-DIRECTION.md § Window): tabs live in the title bar.
 * macOS keeps its native traffic lights; Windows and Linux draw Hopline's own minimise /
 * maximise / close, which call back here. Close goes through `win.close()`, so the window's
 * "Close N open sessions?" confirmation still runs.
 */
export const TITLEBAR_HEIGHT = 36

export function frameOptions(platform = process.platform): BrowserWindowConstructorOptions {
  return platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 11 } } : { frame: false }
}

const none = { parse: (): undefined => undefined }
const of = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
const stateOf = (w: BrowserWindow | null): FrameState => ({
  platform: process.platform,
  maximized: !!w?.isMaximized(),
  fullScreen: !!w?.isFullScreen()
})

export function windowHandlers(): Record<string, Handler> {
  return {
    'frame:state': h(none, (_, e) => stateOf(of(e))),
    'frame:minimize': h(none, (_, e) => void of(e)?.minimize()),
    'frame:toggleMaximize': h(none, (_, e) => {
      const w = of(e)
      if (w) (w.isMaximized() ? w.unmaximize() : w.maximize())
      return stateOf(w)
    }),
    'frame:close': h(none, (_, e) => void of(e)?.close()),
    'a11y:screenReader': h(none, () => screenReaderActive())
  }
}

/**
 * The OS has a screen reader (or other assistive technology) attached. e2e runs on dev builds can
 * pretend one is (HOPLINE_E2E_SCREEN_READER=1): the WSL and CI desktops never report one.
 */
export function screenReaderActive(): boolean {
  if (process.env['HOPLINE_E2E'] && !app.isPackaged && process.env['HOPLINE_E2E_SCREEN_READER'] === '1') return true
  return app.accessibilitySupportEnabled
}

export function registerWindowIpc(): void {
  registerAll(windowHandlers())
}

/** Tell the renderer when the frame changes (maximise icon, traffic-light padding in full screen). */
export function watchFrame(win: BrowserWindow): void {
  const send = () => !win.webContents.isDestroyed() && win.webContents.send('frame:state', stateOf(win))
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'maximize', send)
  // A screen reader started or stopped: the renderer offers (or keeps) screen reader mode.
  const sr = () => !win.webContents.isDestroyed() && win.webContents.send('a11y:screenReader', screenReaderActive())
  app.on('accessibility-support-changed', sr)
  win.on('closed', () => app.off('accessibility-support-changed', sr))
}
