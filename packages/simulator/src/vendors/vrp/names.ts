/**
 * VRP interface names. core/ifname.ts needs a leading letter, so `10GE1/0/1` is parsed here.
 * Accepts `10GE1/0/1`, `10ge 1/0/1`, `loopback 0`, `LoopBack0`, `vlanif10`, `meth 0/0/0`.
 */
import type { Device, Iface } from '../../state.ts'

export const VRP_TYPES = ['10GE', '25GE', '40GE', '100GE', 'GE', 'MEth', 'LoopBack', 'Vlanif', 'NULL', 'Eth-Trunk', 'Tunnel', 'Nve']

/** Types that can be created with `interface X` in system view. */
export const VIRTUAL_TYPES = new Set(['LoopBack', 'Vlanif', 'Eth-Trunk', 'Tunnel', 'Nve'])

export function parseVrpIf(text: string): { name: string; type: string; num: string } | undefined {
  const q = text.replace(/\s+/g, '')
  const m = /^(\d*[a-z][a-z-]*?)(\d[\d/.:]*)$/i.exec(q)
  if (!m) return undefined
  const t = m[1]!.toLowerCase()
  const num = m[2]!
  const exact = VRP_TYPES.find((x) => x.toLowerCase() === t)
  const cands = exact ? [exact] : VRP_TYPES.filter((x) => x.toLowerCase().startsWith(t))
  if (cands.length !== 1) return undefined
  return { name: cands[0]! + num, type: cands[0]!, num }
}

export function findVrpIf(d: Device, text: string): Iface | undefined {
  const r = parseVrpIf(text)
  if (!r) return undefined
  return d.interfaces.find((i) => i.name.toLowerCase() === r.name.toLowerCase())
}

/** Join "10GE 1/0/1" / "LoopBack 0" into one token so the tree sees a single interface word. */
export function joinIfTokens(line: string): string {
  return line.replace(/\b(\d+GE|GE|MEth|LoopBack|Vlanif|NULL|Eth-Trunk|Tunnel|Nve)\s+(?=\d)/gi, '$1')
}

/** Cisco dotted MAC to Huawei dashed (0c4b-7d21-0001). */
export const hwMac = (m: string): string => {
  const hex = m.replace(/[^0-9a-f]/gi, '').toLowerCase().padStart(12, '0')
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

export const isPhysical = (i: Iface): boolean => /^(\d+GE|GE|MEth)/.test(i.name)
