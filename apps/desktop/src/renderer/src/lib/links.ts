import { askConfirm } from './confirm'

/** Only http(s) links without credentials are ever offered (main checks again). */
export function linkTarget(uri: string): string | null {
  try {
    const u = new URL(uri)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null
    return u.href
  } catch {
    return null
  }
}

/**
 * A link in terminal output (an OSC 8 hyperlink or a URL the device printed). The device chose it,
 * so the user sees the exact address in the in-app dialog before anything opens; then main hands
 * it to the OS browser. Anything but http(s) is ignored.
 */
export async function openTerminalLink(uri: string, ask: typeof askConfirm = askConfirm): Promise<boolean> {
  const href = linkTarget(uri)
  if (!href) return false
  const ok = await ask('Open this link?', 'The address comes from the device output. It opens in your browser.', 'Open link', { tone: 'primary', preview: href })
  if (!ok) return false
  await window.hopline.links.open(href)
  return true
}

/** Plain URLs in output open only on Ctrl+click (Cmd+click on macOS), never on a single click. */
export const isLinkClick = (e: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>): boolean => e.ctrlKey || e.metaKey
