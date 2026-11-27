import { lookup } from './text'
import type { Platform } from './types'

/**
 * Platform slugs and drivers seen in NetBox, Nautobot (network_driver), Netmiko
 * and CSV exports. `null` marks a known OS that Hopline has no `Platform` for
 * (yet): it is reported, never mapped to a lookalike.
 */
const SLUGS: Record<string, Platform | null> = {
  ios: 'ios',
  'cisco-ios': 'ios',
  'ios-xe': 'iosxe',
  iosxe: 'iosxe',
  'cisco-ios-xe': 'iosxe',
  'cisco-iosxe': 'iosxe',
  'cisco-xe': 'iosxe',
  nxos: 'nxos',
  'nx-os': 'nxos',
  'cisco-nxos': 'nxos',
  'cisco-nx-os': 'nxos',
  'cisco-nxos-ssh': 'nxos',
  'ios-xr': 'iosxr',
  iosxr: 'iosxr',
  'cisco-ios-xr': 'iosxr',
  'cisco-iosxr': 'iosxr',
  'cisco-xr': 'iosxr',
  asa: 'asa',
  'cisco-asa': 'asa',
  ftd: 'ftd',
  'cisco-ftd': 'ftd',
  'cisco-fxos': 'ftd',
  c9800: 'c9800',
  'cisco-9800': 'c9800',
  'cisco-c9800': 'c9800',
  'catalyst-9800': 'c9800',
  'cisco-wlc-9800': 'c9800',
  aireos: 'aireos',
  'cisco-aireos': 'aireos',
  'cisco-wlc': 'aireos',
  'cisco-s300': 'ciscosb',
  'cisco-sg300': 'ciscosb',
  'cisco-sb': 'ciscosb',
  'cisco-cbs': 'ciscosb',
  ciscosb: 'ciscosb',
  eos: 'eos',
  'arista-eos': 'eos',
  junos: 'junos',
  'juniper-junos': 'junos',
  panos: 'panos',
  'pan-os': 'panos',
  'paloalto-panos': 'panos',
  'palo-alto-panos': 'panos',
  fortios: 'fortios',
  fortinet: 'fortios',
  'fortinet-fortios': 'fortios',
  aoscx: 'aoscx',
  'aos-cx': 'aoscx',
  'aruba-aoscx': 'aoscx',
  'aruba-aos-cx': 'aoscx',
  'hp-aoscx': 'aoscx',
  vrp: 'vrp',
  huawei: 'vrp',
  'huawei-vrp': 'vrp',
  'huawei-vrpv8': 'vrp',
  // Known, but not a Hopline Platform yet (tier 3 and older switch OSes).
  'aruba-os': null,
  'aruba-osswitch': null,
  'hp-procurve': null,
  procurve: null,
  'mikrotik-routeros': null,
  routeros: null,
  'checkpoint-gaia': null,
  'dell-os10': null,
  'dell-force10': null,
  'extreme-exos': null,
  'extreme-vsp': null,
  vyos: null,
  edgeos: null,
  linux: null
}

export interface PlatformMatch {
  platform?: Platform
  /** The slug names an OS Hopline knows of but has no Platform for. */
  unsupported?: boolean
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, '-')

/** Map a NetBox/Nautobot platform slug, network driver or CSV platform cell. Exact table lookup only. */
export function platformFromSlug(slug: string | null | undefined): PlatformMatch {
  if (!slug) return {}
  const key = norm(slug)
  const p = lookup(SLUGS, key)
  if (p === undefined) return {}
  return p ? { platform: p } : { unsupported: true }
}

/**
 * Conservative guess from free text such as a session name ("core-nxos-01") or a
 * platform label ("Cisco IOS-XE"). Only explicit OS or vendor-OS words count; a
 * bare "cisco" or a model number is not enough. IOS-XR is checked before IOS so
 * it never reads as IOS. Returns undefined when unsure.
 */
export function guessPlatform(text: string | null | undefined): Platform | undefined {
  if (!text) return undefined
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  if (/ ios ?xr /.test(t)) return 'iosxr'
  if (/ ios ?xe /.test(t)) return 'iosxe'
  if (/ nx ?os | nexus /.test(t)) return 'nxos'
  if (/ junos | juniper /.test(t)) return 'junos'
  if (/ eos | arista /.test(t)) return 'eos'
  if (/ pan ?os | palo ?alto /.test(t)) return 'panos'
  if (/ fortios | fortigate /.test(t)) return 'fortios'
  if (/ aos ?cx /.test(t)) return 'aoscx'
  if (/ vrp | huawei /.test(t)) return 'vrp'
  if (/ aireos /.test(t)) return 'aireos'
  if (/ asa /.test(t)) return 'asa'
  if (/ ios /.test(t)) return 'ios'
  return undefined
}
