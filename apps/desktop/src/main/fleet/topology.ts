import type { Session, SessionPlatform } from '@shared/types'
import { stripInvisible } from '../agent/untrusted'
import { parseSafe } from '../parse/safe'

/**
 * CDP/LLDP neighbour tables → neighbour names and management addresses → saved sessions
 * (FLEET-AGENT §2, topology scope). Pure: the commands run elsewhere (scope.ts, guarded and audited).
 *
 * Neighbour names are device-controlled text (a hostile LLDP system name lands here first). They are
 * only ever used to *match* a saved session; a match contributes the saved session's own name, and
 * an unmatched neighbour is shown to the user as capped plain text. Nothing here reaches a prompt.
 */

/** Neighbour-table commands per platform, in the order they are tried. All are read-only on that platform. */
export const TOPOLOGY_COMMANDS: Partial<Record<SessionPlatform, string[]>> = {
  ios: ['show cdp neighbors detail', 'show lldp neighbors detail'],
  iosxe: ['show cdp neighbors detail', 'show lldp neighbors detail'],
  c9800: ['show cdp neighbors detail', 'show lldp neighbors detail'],
  nxos: ['show cdp neighbors detail', 'show lldp neighbors detail'],
  iosxr: ['show cdp neighbors detail', 'show lldp neighbors detail'],
  eos: ['show lldp neighbors detail'],
  junos: ['show lldp neighbors'],
  panos: ['show lldp neighbors all']
}

export interface Neighbor {
  /** Normalised (lowercase, no quotes, no domain, no NX-OS serial). */
  name: string
  /** As printed, cleaned of control characters and capped. Display only. */
  shown: string
  ip?: string
}

const MAX_SHOWN = 64
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

export function cleanShown(s: string): string {
  return stripInvisible(s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^"(.*)"$/, '$1').slice(0, MAX_SHOWN)
}

/** A neighbour or session name in comparable form: `"edge-r1.lab.example.net"` → `edge-r1`, `spine1(FDO24120AB1)` → `spine1`. */
export function normaliseName(raw: string): string {
  let s = raw.trim().replace(/^["']|["']$/g, '').trim()
  s = s.replace(/\([^)]*\)\s*$/, '').trim()
  if (!IPV4.test(s)) s = s.split('.')[0] ?? s
  return s.toLowerCase()
}

const validIp = (s: string | undefined): string | undefined => {
  const v = s?.trim()
  if (!v || !IPV4.test(v) || v === '0.0.0.0' || v.split('.').some((o) => Number(o) > 255)) return undefined
  return v
}

const cell = (c: string | string[] | undefined): string => (Array.isArray(c) ? (c[0] ?? '') : (c ?? ''))

/** Neighbours from TextFSM rows (table formats), when a bundled template parses the output. */
function fromTemplate(platform: SessionPlatform, command: string, text: string): Neighbor[] | null {
  const p = parseSafe(platform, command, text)
  if (!p?.rows.length) return null
  const iName = p.headers.findIndex((h) => h === 'NEIGHBOR_NAME' || h === 'NEIGHBOR')
  const iIp = p.headers.findIndex((h) => h === 'MGMT_ADDRESS' || h === 'MANAGEMENT_IP')
  if (iName < 0) return null
  return p.rows.map((r) => ({ raw: cell(r[iName]), ip: iIp >= 0 ? validIp(cell(r[iIp])) : undefined })).filter((n) => n.raw.trim()).map((n) => ({ name: normaliseName(n.raw), shown: cleanShown(n.raw), ...(n.ip ? { ip: n.ip } : {}) }))
}

/** Neighbours from the detail formats by their labels (Device ID, System Name, and the address lines after them). */
function fromLabels(text: string): Neighbor[] {
  const out: Neighbor[] = []
  let cur: { raw: string; ip?: string } | null = null
  const push = () => {
    if (cur?.raw.trim()) out.push({ name: normaliseName(cur.raw), shown: cleanShown(cur.raw), ...(cur.ip ? { ip: cur.ip } : {}) })
    cur = null
  }
  for (const line of text.split(/\r?\n/)) {
    const name = /^\s*(?:-\s*)?(?:Device ID|System Name)\s*:\s*(.+?)\s*$/i.exec(line)
    if (name) {
      push()
      cur = { raw: name[1]! }
      continue
    }
    const ip = /^\s*(?:-\s*)?(?:IP(?:v4)? address|IP|Management Address(?:es)?|IPv4 Address)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/i.exec(line)
    if (ip && cur && !cur.ip) cur.ip = validIp(ip[1])
  }
  push()
  return out
}

/** Neighbours in one command's (redacted) output. Deduplicated by name. */
export function parseNeighbors(platform: SessionPlatform, command: string, text: string): Neighbor[] {
  // The labelled detail formats keep a name whole (a template's \S+ would cut "a b" to "a");
  // the table formats (Junos) need the bundled template.
  const labelled = fromLabels(text)
  const list = labelled.length ? labelled : (fromTemplate(platform, command, text) ?? [])
  const seen = new Map<string, Neighbor>()
  for (const n of list) {
    if (!n.name) continue
    const prev = seen.get(n.name)
    if (!prev) seen.set(n.name, n)
    else if (!prev.ip && n.ip) prev.ip = n.ip
  }
  return [...seen.values()]
}

export type MatchBy = 'name' | 'short name' | 'host' | 'ip'

/**
 * The saved session a neighbour is, or null: by session name, then by the session's host as a name,
 * then by management IP, but only when exactly one saved session has that host. `by` says how:
 * `name` only when the advertised name is the session name as printed; `short name` when it took
 * stripping a domain or "(serial)" (`PROD-FW1.attacker.example(x)` is a short-name match). Every
 * one of these is device-controlled text, so a match only ever proposes a device: scope.ts leaves
 * it unselected until the user ticks it.
 */
export function matchSession(n: Neighbor, sessions: Session[]): { session: Session; by: MatchBy } | null {
  const shown = n.shown.trim().toLowerCase()
  const exact = sessions.filter((s) => s.name.trim().toLowerCase() === n.name)
  if (exact.length === 1) return { session: exact[0]!, by: exact[0]!.name.trim().toLowerCase() === shown ? 'name' : 'short name' }
  const byName = sessions.filter((s) => normaliseName(s.name) === n.name)
  if (!exact.length && byName.length === 1) return { session: byName[0]!, by: 'short name' }
  const byHost = sessions.filter((s) => !IPV4.test(s.host) && normaliseName(s.host) === n.name)
  if (byHost.length === 1) return { session: byHost[0]!, by: 'host' }
  if (n.ip) {
    const byIp = sessions.filter((s) => s.host === n.ip)
    if (byIp.length === 1) return { session: byIp[0]!, by: 'ip' }
  }
  return null
}
