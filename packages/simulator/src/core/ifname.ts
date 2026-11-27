/**
 * Interface-name canonicalisation for CLIs that accept abbreviations ("gi1/0/1", "Gi 1/0/1",
 * "e1/1", "et1"). Each vendor passes its type table.
 */
import type { Device, Iface } from '../state.ts'

export interface IfType {
  full: string
  short: string
}

export interface IfRef {
  /** Canonical full name (may not exist yet, e.g. `interface Loopback5`). */
  name: string
  type: IfType
  num: string
}

/** Parse "gi1/0/1" / "Gi 1/0/1" / "GigabitEthernet1/0/1" against a type table. */
export function parseIfName(text: string, types: IfType[]): IfRef | 'ambiguous' | undefined {
  const q = text.replace(/\s+/g, '')
  const m = /^([a-z][a-z-]*?)(\d[\d/.:]*)$/i.exec(q)
  if (!m) return undefined
  const t = m[1]!.toLowerCase()
  const num = m[2]!
  const exact = types.filter((x) => x.full.toLowerCase() === t || x.short.toLowerCase() === t)
  const cands = exact.length ? exact : types.filter((x) => x.full.toLowerCase().startsWith(t))
  if (!cands.length) return undefined
  if (new Set(cands.map((c) => c.full)).size > 1) return 'ambiguous'
  const type = cands[0]!
  return { name: type.full + num, type, num }
}

/** Find an existing interface by any accepted spelling. */
export function findIface(d: Device, text: string, types: IfType[]): Iface | undefined {
  const q = text.replace(/\s+/g, '').toLowerCase()
  if (!q) return undefined
  const direct = d.interfaces.find((i) => i.name.toLowerCase() === q || i.short.toLowerCase() === q)
  if (direct) return direct
  const ref = parseIfName(text, types)
  if (!ref || ref === 'ambiguous') return undefined
  return d.interfaces.find((i) => i.name.toLowerCase() === ref.name.toLowerCase())
}

export const IOS_TYPES: IfType[] = [
  { full: 'GigabitEthernet', short: 'Gi' },
  { full: 'TenGigabitEthernet', short: 'Te' },
  { full: 'TwentyFiveGigE', short: 'Twe' },
  { full: 'FortyGigabitEthernet', short: 'Fo' },
  { full: 'HundredGigE', short: 'Hu' },
  { full: 'FastEthernet', short: 'Fa' },
  { full: 'Vlan', short: 'Vl' },
  { full: 'Loopback', short: 'Lo' },
  { full: 'Port-channel', short: 'Po' },
  { full: 'Tunnel', short: 'Tu' },
  { full: 'Null', short: 'Nu' }
]

/** Short name for a full name ("GigabitEthernet1/0/1" → "Gi1/0/1"). */
export function shortName(name: string, types: IfType[]): string {
  for (const t of types) if (name.startsWith(t.full) && /^\d/.test(name.slice(t.full.length))) return t.short + name.slice(t.full.length)
  return name
}
