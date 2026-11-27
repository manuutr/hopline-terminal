import type { QuickTarget } from './quickconnect'
import { parseQuickConnect } from './quickconnect'

const KEY = 'hopline.quickEndpoints'

export function recentEndpoints(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && parseQuickConnect(v)?.ok).slice(0, 12) : []
  } catch { return [] }
}

/** Rebuild from validated fields. The raw input and supplied passwords never enter history. */
export function rememberEndpoint(t: QuickTarget) {
  const host = t.host.includes(':') && t.protocol !== 'serial' ? '[' + t.host + ']' : t.host
  const user = t.username ? encodeURIComponent(t.username) + '@' : ''
  const query = new URLSearchParams()
  if (t.platform !== 'auto') query.set('platform', t.platform)
  if (t.serial) {
    for (const [key, value] of Object.entries({ baud: t.serial.baudRate, parity: t.serial.parity, databits: t.serial.dataBits, stopbits: t.serial.stopBits, flow: t.serial.flow })) query.set(key, String(value))
  }
  const endpoint = `${t.protocol}://${user}${host}${t.port ? ':' + t.port : ''}${query.size ? '?' + query : ''}`
  try { localStorage.setItem(KEY, JSON.stringify([endpoint, ...recentEndpoints().filter((s) => s !== endpoint)].slice(0, 12))) } catch { /* Storage may be unavailable. */ }
}
