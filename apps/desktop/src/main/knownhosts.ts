import { createHash } from 'node:crypto'

export interface KnownHostEntry {
  host: string
  port: number
  keyType: string
  fingerprint: string
}

export interface ParseResult {
  entries: KnownHostEntry[]
  /** Hashed host names (HashKnownHosts yes) cannot be mapped back to a host. */
  hashed: number
  /** @cert-authority / @revoked lines and malformed lines. */
  skipped: number
}

/** OpenSSH-style SHA256 fingerprint of a base64 public key blob. */
export function fingerprintOf(keyB64: string): string | null {
  const blob = Buffer.from(keyB64, 'base64')
  if (blob.length < 16 || blob.toString('base64').replace(/=+$/, '') !== keyB64.replace(/=+$/, '')) return null
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/** Parse an OpenSSH known_hosts file. Pure; never throws. */
export function parseKnownHosts(text: string): ParseResult {
  const out: ParseResult = { entries: [], hashed: 0, skipped: 0 }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields[0]!.startsWith('@')) {
      out.skipped++
      continue
    }
    const [hosts, keyType, key] = fields
    const fp = key && keyType ? fingerprintOf(key) : null
    if (!hosts || !fp) {
      out.skipped++
      continue
    }
    for (const h of hosts.split(',')) {
      if (h.startsWith('|1|')) {
        out.hashed++
        continue
      }
      if (h.startsWith('!') || /[*?]/.test(h)) {
        out.skipped++
        continue
      }
      const m = /^\[([^\]]+)\]:(\d+)$/.exec(h)
      const host = (m ? m[1]! : h).toLowerCase()
      const port = m ? Number(m[2]) : 22
      out.entries.push({ host, port, keyType: keyType!, fingerprint: fp })
    }
  }
  return out
}
