/**
 * Bind-address checks for port forwards. Pure (no Node APIs), so the renderer can use it too
 * (`@hopline/transports/src/bind.ts`).
 *
 * The OS resolver accepts many spellings of "every interface" (`0`, `0.0`, `0x0`, `::0`,
 * `0:0:0:0:0:0:0:0`, `0000::`) and of other hosts, so a forward is treated as local-only only when
 * its bind host is a loopback literal in strict form or `localhost`. Everything else (wildcards in
 * any spelling, LAN addresses, names, empty) counts as reachable from the network.
 */

/** Strict dotted-quad IPv4 (four decimal parts 0–255, no leading zeros), or null. */
function ipv4(h: string): number[] | null {
  const parts = h.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** IPv6 literal (optionally in brackets, with an embedded IPv4 tail) as eight 16-bit groups, or null. */
function ipv6(raw: string): number[] | null {
  let h = raw
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (!h.includes(':') || h.includes('%')) return null
  // An embedded IPv4 tail (`::ffff:127.0.0.1`) becomes two hex groups.
  const lastColon = h.lastIndexOf(':')
  const last = h.slice(lastColon + 1)
  if (last.includes('.')) {
    const v4 = ipv4(last)
    if (!v4) return null
    h = `${h.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`
  }
  const tail: number[] = []
  const halves = h.split('::')
  if (halves.length > 2) return null
  const group = (s: string): number[] | null => {
    if (!s) return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const a = group(halves[0]!)
  const b = halves.length === 2 ? group(halves[1]!) : []
  if (!a || !b) return null
  const want = 8 - tail.length
  if (halves.length === 1) return a.length === want ? [...a, ...tail] : null
  if (a.length + b.length >= want) return null
  return [...a, ...Array<number>(want - a.length - b.length).fill(0), ...b, ...tail]
}

/** True only for a loopback literal (`127.x.y.z`, `::1` in any spelling, `::ffff:127.x.y.z`) or `localhost`. */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === 'localhost') return true
  const v4 = ipv4(h)
  if (v4) return v4[0] === 127
  const v6 = ipv6(h)
  if (!v6) return false
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return true
  // IPv4-mapped loopback.
  return v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff && v6[6]! >> 8 === 127
}

/**
 * The bind host means "every interface" in some spelling the resolver accepts: empty, `*`, an
 * all-zero IPv6 literal, or a number form of 0 (`0`, `0.0`, `0x0`, `00`, `0.0.0.0`).
 */
export function isAnyAddressBind(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === '' || h === '*') return true
  const v6 = ipv6(h)
  if (v6) return v6.every((g) => g === 0) || (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff && v6[6] === 0 && v6[7] === 0)
  // inet_aton forms: 1–4 parts, each decimal, octal (0…) or hex (0x…); zero in every part.
  const parts = h.split('.')
  if (parts.length > 4) return false
  return parts.every((p) => /^(?:0x0*|0+)$/.test(p) || /^0x0+$/.test(p))
}

/** The listener can be reached from other machines (anything that is not a loopback literal). */
export const isExposedBind = (host: string): boolean => !isLoopbackBind(host)

/**
 * The address a local listener actually binds, from the bind host the check looked at (Phase 4
 * fix-round review F1, F2): trimmed, brackets dropped (`[::1]` → `::1`; `listen` does not take
 * brackets and would fail with ENOTFOUND), and `localhost` as the literal `127.0.0.1`, so the
 * resolver (an /etc/hosts entry) can never turn the name the check trusted into another address.
 */
export function listenHost(host: string): string {
  let h = host.trim()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return h.toLowerCase() === 'localhost' ? '127.0.0.1' : h
}

/** A remote (-R) bind address as the server is asked for it: trimmed, brackets dropped. */
export function remoteBindHost(host: string): string {
  const h = host.trim()
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}
