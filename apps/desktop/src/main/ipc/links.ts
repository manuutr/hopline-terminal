import { shell } from 'electron'
import { z } from 'zod'
import { handler as h, registerAll, type Handler } from '.'

/**
 * Links from terminal output (OSC 8 hyperlinks, plain URLs the device printed). The renderer asks
 * the user first, in-app; main opens only http(s) URLs, in the OS browser, never in a window.
 */
export const ExternalUrl = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const x = new URL(u)
      return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password
    } catch {
      return false
    }
  }, 'only http(s) links without credentials are opened')

/** Asks the user natively; the renderer can't answer it (P8 M4). */
export type ConfirmLink = (message: string, detail: string, ok: string) => Promise<boolean>

/**
 * Main asks again before anything reaches the OS browser (P8 M4): the in-app prompt runs in the
 * renderer, and a compromised renderer could otherwise send data out in a URL with no one asked.
 * The dialog shows the normalized URL, which is exactly what opens. Cancel resolves quietly.
 */
export async function openConfirmedLink(url: string, confirm: ConfirmLink, open: (href: string) => Promise<void> = (href) => shell.openExternal(href)): Promise<boolean> {
  const href = new URL(url).href
  if (!(await confirm('Open this link in your browser?', href, 'Open link'))) return false
  await open(href)
  return true
}

export function linkHandlers(confirm: ConfirmLink, open?: (url: string) => Promise<void>): Record<string, Handler> {
  return { 'links:open': h(ExternalUrl, (url) => openConfirmedLink(url, confirm, open)) }
}

export function registerLinksIpc(confirm: ConfirmLink): void {
  registerAll(linkHandlers(confirm))
}
