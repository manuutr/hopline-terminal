import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/**
 * Which page may use the bridge (P8 C-L4): main/index.ts sets it to the app's own page (app://hopline,
 * or the dev server's page in unpackaged builds). Until then nothing is trusted.
 */
let trustedPage: (url: URL) => boolean = () => false
export function setTrustedPage(fn: (url: URL) => boolean): void {
  trustedPage = fn
}

/**
 * IPC only from the main frame of the app's own page: never a subframe, never a page the window
 * was navigated to. Compared on origin and path (the hash route varies). Electron checklist #17.
 */
export function trustedSender(e: Pick<IpcMainInvokeEvent | IpcMainEvent, 'sender' | 'senderFrame'>): boolean {
  const f = e.senderFrame
  if (!f || f.parent !== null) return false
  const main = e.sender.mainFrame
  if (!main || f.processId !== main.processId || f.routingId !== main.routingId) return false
  try {
    return trustedPage(new URL(f.url))
  } catch {
    return false
  }
}
