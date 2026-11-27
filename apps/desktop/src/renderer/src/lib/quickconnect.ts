import { SESSION_PLATFORMS } from '@hopline/guard'
import { SERIAL_DEFAULTS, type Protocol, type QuickSessionInput, type SerialSettings, type SessionPlatform } from '@shared/types'

/**
 * Quick connect: turn what the user typed into a connection target.
 *
 *   admin@10.0.0.1:2222        ssh (the default protocol)
 *   ssh://admin@core-sw1:2222  ssh
 *   telnet://lab-ts1:2003      telnet
 *   raw://10.0.0.5:4001        raw TCP (tcp:// too)
 *   serial:///dev/ttyUSB0?baud=115200   serial://COM3   serial:COM3
 *   [2001:db8::1]:22  admin@[fe80::1]  2001:db8::1
 *   core-sw1                   bare host: ssh on 22
 *
 * `?platform=eos` picks the CLI platform (default IOS-XE, the most common and what the guard
 * treats most conservatively among Cisco dialects). Serial also takes baud, databits, parity,
 * stopbits and flow. Passwords in the URL (`user:pass@`) are refused: secrets are never typed into
 * a field that ends up in a tab title, history or the palette.
 */
export interface QuickTarget {
  protocol: Protocol
  host: string
  port: number
  username: string
  platform: SessionPlatform
  serial?: SerialSettings
  /** Plain word with no user, port, scheme or dots: could just as well be a search. */
  bare: boolean
  /** Display form, also the tab title. */
  label: string
}

export type QuickParse = { ok: true; target: QuickTarget } | { ok: false; error: string }

// Auto-detect: the first connect identifies the device (F8); the guard refuses AI commands until then.
export const DEFAULT_QUICK_PLATFORM: SessionPlatform = 'auto'
const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, telnet: 23, raw: 23, serial: 0 }
const SCHEMES: Record<string, Protocol> = { ssh: 'ssh', telnet: 'telnet', raw: 'raw', tcp: 'raw', serial: 'serial' }

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$/
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV6 = /^[0-9A-Fa-f:.]+(?:%[\w.-]+)?$/
const USER = /^[A-Za-z0-9._\\-][A-Za-z0-9._\\@-]{0,119}$/

const isIpv6 = (h: string) => IPV6.test(h) && (h.match(/:/g)?.length ?? 0) >= 2
const fail = (error: string): QuickParse => ({ ok: false, error })

function parsePort(raw: string | undefined, protocol: Protocol): number | string {
  if (raw === undefined || raw === '') return DEFAULT_PORT[protocol]
  if (!/^\d{1,5}$/.test(raw)) return `Invalid port "${raw}"`
  const n = Number(raw)
  if (n < 1 || n > 65535) return `Port ${n} is out of range (1-65535)`
  return n
}

/** decodeURIComponent that reports a bad escape ("100%", "%zz") instead of throwing. */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

function parseQuery(q: string): Map<string, string> | string {
  const m = new Map<string, string>()
  for (const part of q.split('&')) {
    if (!part) continue
    const [k, v = ''] = part.split('=')
    const dk = decode(k!)
    const dv = decode(v)
    if (dk === null || dv === null) return `Invalid "%" escape in "${part}" (write %25 for a literal %)`
    m.set(dk.toLowerCase(), dv)
  }
  return m
}

function platformFrom(q: Map<string, string>): SessionPlatform | string {
  const p = q.get('platform')?.toLowerCase()
  if (!p) return DEFAULT_QUICK_PLATFORM
  return (SESSION_PLATFORMS as readonly string[]).includes(p) ? (p as SessionPlatform) : `Unknown platform "${p}" (${SESSION_PLATFORMS.join(', ')})`
}

function parseSerial(rest: string, q: Map<string, string>): QuickParse {
  // serial:///dev/ttyUSB0 → "/dev/ttyUSB0"; serial://COM3 and serial:COM3 → "COM3".
  const path = rest.startsWith('//') ? rest.slice(2) : rest
  if (!path || /[\s?#]/.test(path)) return fail('Serial needs a port, e.g. serial:///dev/ttyUSB0 or serial://COM3')
  const s: SerialSettings = { ...SERIAL_DEFAULTS }
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined)
  const baud = num('baud') ?? num('baudrate')
  if (baud !== undefined) {
    if (!Number.isInteger(baud) || baud < 50 || baud > 4_000_000) return fail(`Invalid baud rate "${q.get('baud') ?? q.get('baudrate')}"`)
    s.baudRate = baud
  }
  const bits = num('databits')
  if (bits !== undefined) {
    if (![5, 6, 7, 8].includes(bits)) return fail('Data bits must be 5, 6, 7 or 8')
    s.dataBits = bits as SerialSettings['dataBits']
  }
  const stop = num('stopbits')
  if (stop !== undefined) {
    if (![1, 1.5, 2].includes(stop)) return fail('Stop bits must be 1, 1.5 or 2')
    s.stopBits = stop as SerialSettings['stopBits']
  }
  const parity = q.get('parity')?.toLowerCase()
  if (parity !== undefined) {
    if (!['none', 'even', 'odd', 'mark', 'space'].includes(parity)) return fail(`Invalid parity "${parity}"`)
    s.parity = parity as SerialSettings['parity']
  }
  const flow = q.get('flow')?.toLowerCase()
  if (flow !== undefined) {
    if (!['none', 'rtscts', 'xonxoff'].includes(flow)) return fail(`Invalid flow control "${flow}" (none, rtscts, xonxoff)`)
    s.flow = flow as SerialSettings['flow']
  }
  const platform = platformFrom(q)
  if (!SESSION_PLATFORMS.includes(platform as SessionPlatform)) return fail(platform)
  return {
    ok: true,
    target: { protocol: 'serial', host: path, port: 0, username: '', platform: platform as SessionPlatform, serial: s, bare: false, label: `${path} @ ${s.baudRate}` }
  }
}

/** Parse quick-connect input. `null`: not a connection target at all (e.g. a search with spaces). */
export function parseQuickConnect(input: string): QuickParse | null {
  const text = input.trim()
  if (!text || /\s/.test(text)) return null

  let protocol: Protocol = 'ssh'
  let rest = text
  let explicitScheme = false
  const scheme = /^([a-z]+):(.*)$/i.exec(text)
  if (scheme && SCHEMES[scheme[1]!.toLowerCase()] && (scheme[1]!.toLowerCase() === 'serial' || scheme[2]!.startsWith('//'))) {
    protocol = SCHEMES[scheme[1]!.toLowerCase()]!
    rest = scheme[2]!
    explicitScheme = true
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return fail(`Unsupported scheme "${text.split(':')[0]}" (ssh, telnet, raw, serial)`)
  }

  const qi = rest.indexOf('?')
  const query = parseQuery(qi >= 0 ? rest.slice(qi + 1) : '')
  if (typeof query === 'string') return fail(query)
  rest = qi >= 0 ? rest.slice(0, qi) : rest
  if (protocol === 'serial') return parseSerial(rest, query)
  if (explicitScheme) rest = rest.slice(2).replace(/\/$/, '')
  if (!rest) return fail('Missing host')

  // userinfo: everything before the last "@" (usernames like "admin@corp" are valid).
  const at = rest.lastIndexOf('@')
  let username = ''
  if (at >= 0) {
    const user = decode(rest.slice(0, at))
    if (user === null) return fail(`Invalid "%" escape in the username (write %25 for a literal %)`)
    username = user
    rest = rest.slice(at + 1)
    if (username.includes(':')) return fail('Passwords are not accepted in quick connect; you will be asked for it')
    if (!USER.test(username)) return fail(`Invalid username "${username}"`)
  }

  let host: string
  let portRaw: string | undefined
  if (rest.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(.*))?$/.exec(rest)
    if (!m || !isIpv6(m[1]!)) return fail(`Invalid IPv6 address "${rest}"`)
    host = m[1]!
    portRaw = m[2]
  } else if (isIpv6(rest) && !IPV4.test(rest)) {
    host = rest
  } else {
    const c = rest.lastIndexOf(':')
    host = c >= 0 ? rest.slice(0, c) : rest
    portRaw = c >= 0 ? rest.slice(c + 1) : undefined
    if (c >= 0 && portRaw === '') return fail('Missing port after ":"')
  }
  if (!host) return fail('Missing host')
  if (!isIpv6(host) && !IPV4.test(host) && !HOSTNAME.test(host)) {
    // Something like "show ip int" never gets here (spaces); "foo/bar" or "a,b" are just not hosts.
    return explicitScheme || username || portRaw !== undefined ? fail(`Invalid host "${host}"`) : null
  }
  if (!explicitScheme && !username && portRaw === '23') protocol = 'telnet'
  const port = parsePort(portRaw, protocol)
  if (typeof port === 'string') return fail(port)
  const platform = platformFrom(query)
  if (!SESSION_PLATFORMS.includes(platform as SessionPlatform)) return fail(platform)

  const hostShown = isIpv6(host) ? `[${host}]` : host
  const portShown = port !== DEFAULT_PORT[protocol] ? `:${port}` : ''
  const user = username ? `${username}@` : ''
  const label = protocol === 'ssh' ? `${user}${hostShown}${portShown}` : `${protocol}://${user}${hostShown}${portShown}`
  const bare = !explicitScheme && !username && portRaw === undefined && !host.includes('.') && !isIpv6(host)
  return { ok: true, target: { protocol, host, port, username, platform: platform as SessionPlatform, bare, label } }
}

/** The unsaved session main registers for a quick connect. */
export function quickSessionInput(t: QuickTarget): QuickSessionInput {
  return { name: t.label, host: t.host, port: t.port, protocol: t.protocol, platform: t.platform, username: t.username, options: t.serial ? { serial: t.serial } : {} }
}
