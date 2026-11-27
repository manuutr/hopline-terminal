/**
 * NetBox / Nautobot device pull. Pages through `/api/dcim/devices/` and maps
 * each device to a session: name, primary IP (prefix length stripped), site
 * (or Nautobot location) as folder, platform slug via the mapping table, tags.
 *
 * Safety:
 * - The token is only ever sent to the origin of `url`. A `next` link pointing
 *   elsewhere (a proxy rewriting http/https, or a hostile server) is rebased
 *   onto that origin, and every request URL is checked against it.
 * - Any HTTP error, including one mid-pagination, throws: a partial device list
 *   must never look complete, because re-sync would read it as deletions. For
 *   the same reason, fewer devices than the API's `count` throws too.
 * - Errors never include the token.
 */
import { guessPlatform, platformFromSlug } from './platform'
import { addNote, ResultBuilder } from './result'
import { DEFAULT_PORTS, type ImportedSession, type ImportResult, type Protocol } from './types'

export interface FetchResponseLike {
  ok: boolean
  status: number
  statusText?: string
  json(): Promise<unknown>
}
export type FetchLike = (url: string, init: { method?: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseLike>

export interface NetBoxOptions {
  /** Base URL, e.g. https://netbox.example.com (an /api suffix is accepted). */
  url: string
  token: string
  /** Extra query parameters (NetBox filters such as site, role, status, tag) or a raw query string. */
  filter?: Record<string, string | number | boolean | (string | number)[]> | string
  /** Devices per page (default 250). */
  pageSize?: number
  /** Safety cap on pages (default 200). */
  maxPages?: number
  /** Nautobot needs `depth=1` for nested objects. Default 'netbox'. */
  flavor?: 'netbox' | 'nautobot'
  /** Protocol for every device (default ssh). */
  protocol?: Protocol
  signal?: AbortSignal
}

export class NetBoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'auth' | 'http' | 'network' | 'format' = 'http'
  ) {
    super(message)
    this.name = 'NetBoxError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOf = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)
const nested = (o: Obj, k: string, field: string) => (isObj(o[k]) ? strOf((o[k] as Obj)[field]) : undefined)

/** "10.0.0.1/32" → "10.0.0.1", "2001:db8::1/128" → "2001:db8::1". */
export const stripPrefixLength = (addr: string) => addr.trim().replace(/\/\d{1,3}$/, '')

function buildQuery(filter: NetBoxOptions['filter']): string {
  if (!filter) return ''
  if (typeof filter === 'string') return filter.replace(/^[?&]+/, '')
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(filter)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, String(x))
  return p.toString()
}

/** NetBox 4.5+ v2 tokens ("nbt_…") use Bearer; v1 tokens and Nautobot use "Token". */
const authHeader = (token: string) => (token.startsWith('nbt_') ? `Bearer ${token}` : `Token ${token}`)

export async function fetchNetBox(opts: NetBoxOptions, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<ImportResult> {
  if (!opts.token) throw new NetBoxError('An API token is required', undefined, 'auth')
  let base: URL
  try {
    base = new URL(opts.url.replace(/\/+$/, '').replace(/\/api$/i, '') + '/')
  } catch {
    throw new NetBoxError(`Not a valid URL: ${opts.url}`, undefined, 'format')
  }
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 250, 1000))
  const maxPages = opts.maxPages ?? 200
  const flavor = opts.flavor ?? 'netbox'
  const protocol = opts.protocol ?? 'ssh'
  const query = [`limit=${pageSize}`, flavor === 'nautobot' ? 'depth=1' : '', buildQuery(opts.filter)].filter(Boolean).join('&')
  const apiBase = new URL('api/', base)
  let next: string | null = new URL(`dcim/devices/?${query}`, apiBase).toString()
  const headers = { Authorization: authHeader(opts.token), Accept: 'application/json' }

  const b = new ResultBuilder()
  let pages = 0
  let expected: number | undefined
  let received = 0
  while (next) {
    if (++pages > maxPages) throw new NetBoxError(`Stopped after ${maxPages} pages; narrow the filter or raise maxPages`, undefined, 'format')
    const target = rebase(next, apiBase, base)
    let res: FetchResponseLike
    try {
      res = await fetchImpl(target, { method: 'GET', headers, signal: opts.signal })
    } catch (e) {
      throw new NetBoxError(`Could not reach ${base.origin}: ${(e as Error).message}`, undefined, 'network')
    }
    if (res.status === 401 || res.status === 403) {
      throw new NetBoxError(`Authentication failed (HTTP ${res.status}): check the API token and its permissions`, res.status, 'auth')
    }
    if (!res.ok) throw new NetBoxError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} on page ${pages}`, res.status)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new NetBoxError(`Page ${pages} is not JSON`, res.status, 'format')
    }
    if (!isObj(body) || !Array.isArray(body.results)) throw new NetBoxError(`Page ${pages} has no "results" list: is this a NetBox/Nautobot API URL?`, res.status, 'format')
    if (typeof body.count === 'number') expected = body.count
    for (const d of body.results) {
      received++
      mapDevice(b, d, base, protocol)
    }
    next = typeof body.next === 'string' && body.next ? body.next : null
  }
  if (expected !== undefined && received < expected) {
    // A short list would read as deletions on re-sync.
    throw new NetBoxError(`Incomplete device list: the API reported ${expected} devices but returned ${received}`, undefined, 'format')
  }
  return b.finish()
}

/**
 * The URL to fetch for a `next` link: its path and query on the configured
 * origin. Never `new URL(path, origin)`: a path starting with `//` would be read
 * as a network-path reference to another host.
 */
function rebase(next: string, apiBase: URL, base: URL): string {
  let u: URL
  try {
    u = new URL(next, apiBase)
  } catch {
    throw new NetBoxError('The API returned an invalid "next" page link', undefined, 'format')
  }
  const target = new URL(base.origin)
  target.pathname = u.pathname
  target.search = u.search
  // The token never leaves the configured origin.
  if (target.origin !== base.origin) throw new NetBoxError('Refusing to send the token to another origin', undefined, 'format')
  return target.toString()
}

function mapDevice(b: ResultBuilder, d: unknown, base: URL, protocol: Protocol) {
  if (!isObj(d)) return
  const id = strOf(d.id)
  const name = strOf(d.name)?.trim()
  const item = name || strOf(d.display) || `device #${id ?? '?'}`
  if (!name) {
    b.warn(item, 'Skipped: device has no name')
    return
  }
  const ip = nested(d, 'primary_ip', 'address') ?? nested(d, 'primary_ip4', 'address') ?? nested(d, 'primary_ip6', 'address')
  if (!ip) {
    b.warn(item, 'Skipped: device has no primary IP')
    return
  }
  const site = nested(d, 'site', 'name') ?? nested(d, 'location', 'name')
  const s: ImportedSession = {
    name,
    folderPath: site ? [site] : [],
    host: stripPrefixLength(ip),
    port: DEFAULT_PORTS[protocol],
    protocol,
    username: '',
    notes: '',
    options: {},
    tags: Array.isArray(d.tags) ? d.tags.map((t) => (isObj(t) ? strOf(t.name) ?? strOf(t.slug) : strOf(t))).filter((t): t is string => !!t) : [],
    source: { format: 'netbox', ref: new URL(`api/dcim/devices/${id ?? ''}/`, base).toString(), id }
  }
  const slug = nested(d, 'platform', 'slug') ?? nested(d, 'platform', 'network_driver') ?? nested(d, 'platform', 'name')
  const pm = platformFromSlug(slug)
  const platform = pm.platform ?? (pm.unsupported ? undefined : guessPlatform(nested(d, 'platform', 'name')))
  if (platform) s.platform = platform
  else if (slug) {
    s.tags.push(`platform:${slug}`)
    b.warn(item, `Platform "${slug}" ${pm.unsupported ? 'is not supported yet' : 'is not in the mapping table'}; choose one after import`)
  }
  const role = nested(d, 'role', 'name') ?? nested(d, 'device_role', 'name')
  if (role) addNote(s, `Role: ${role}`)
  const model = nested(d, 'device_type', 'model')
  if (model) addNote(s, `Model: ${model}`)
  b.add(s)
}
