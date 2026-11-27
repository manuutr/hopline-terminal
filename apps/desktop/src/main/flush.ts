import { ipcMain, type WebContents } from 'electron'
import { trustedSender } from './ipc/sender'

/**
 * Save every tab's scrollback before a window closes or Hopline quits (review L8). The periodic
 * save runs every 30 s and a busy tab may wait another 30 s, so without this a quit could lose up
 * to a minute of history; the renderer's unmount saves never run when the window is destroyed.
 *
 * Main asks each window to save now (`scrollback:flush`), waits for its answer (bounded), then
 * waits for the store's writes to land (also bounded). A window that does not answer only costs
 * the timeout, never the quit.
 */
let seq = 0

export function flushWindow(wc: WebContents, timeoutMs = 2000): Promise<void> {
  if (wc.isDestroyed()) return Promise.resolve()
  const nonce = `f${++seq}`
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t)
      ipcMain.removeListener('scrollback:flushed', onAck)
      resolve()
    }
    const onAck = (e: Electron.IpcMainEvent, n: unknown) => {
      if (e.sender === wc && n === nonce && trustedSender(e)) done()
    }
    const t = setTimeout(done, timeoutMs)
    ipcMain.on('scrollback:flushed', onAck)
    try {
      wc.send('scrollback:flush', nonce)
    } catch {
      done()
    }
  })
}

/** Ask every window, then wait for the writes (each step bounded). */
export async function flushAll(wcs: WebContents[], idle: () => Promise<void>, timeoutMs = 3000): Promise<void> {
  await Promise.all(wcs.map((wc) => flushWindow(wc)))
  await Promise.race([idle(), new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.())])
}
