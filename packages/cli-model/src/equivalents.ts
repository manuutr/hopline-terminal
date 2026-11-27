import { PROFILES } from './profiles'
import { PLATFORM_IDS, type LiveSource, type PlatformId } from './types'

/**
 * The same question asked on different platforms: "show interfaces status" on IOS is
 * "show interfaces terse" on Junos. Multi-device runs use this to send each device its own
 * command. Data only, and small: most rows come from the profiles (the version probe and the live
 * listing commands autocomplete already knows); a few are written out here.
 */
export interface Equivalent {
  id: string
  label: string
  commands: Partial<Record<PlatformId, string>>
}

const fromLive = (id: string, label: string, src: LiveSource): Equivalent => ({
  id,
  label,
  commands: Object.fromEntries(PLATFORM_IDS.flatMap((p) => (PROFILES[p].live[src] ? [[p, PROFILES[p].live[src]!.command]] : [])))
})

/** Hand-written rows: commands whose per-platform form is not in a profile. */
const EXTRA: Equivalent[] = [
  {
    id: 'interface-status',
    label: 'Interface status',
    commands: {
      ios: 'show interfaces status',
      iosxe: 'show interfaces status',
      nxos: 'show interface status',
      eos: 'show interfaces status',
      junos: 'show interfaces terse',
      iosxr: 'show interfaces brief',
      aoscx: 'show interface brief',
      vrp: 'display interface brief'
    }
  },
  {
    id: 'lldp-neighbors',
    label: 'LLDP neighbors',
    commands: {
      ios: 'show lldp neighbors',
      iosxe: 'show lldp neighbors',
      nxos: 'show lldp neighbors',
      eos: 'show lldp neighbors',
      junos: 'show lldp neighbors',
      iosxr: 'show lldp neighbors',
      aoscx: 'show lldp neighbor-info',
      vrp: 'display lldp neighbor brief'
    }
  },
  {
    id: 'ipsec-tunnels',
    label: 'IPsec tunnel status',
    commands: { asa: 'show crypto ipsec sa', fortios: 'get vpn ipsec tunnel summary', panos: 'show vpn flow' }
  },
  {
    id: 'routes',
    label: 'Routing table',
    commands: { ios: 'show ip route', iosxe: 'show ip route', nxos: 'show ip route', eos: 'show ip route', junos: 'show route', iosxr: 'show route', asa: 'show route', vrp: 'display ip routing-table', fortios: 'get router info routing-table all', panos: 'show routing route' }
  }
]

export const EQUIVALENTS: readonly Equivalent[] = [
  {
    id: 'version',
    label: 'Software version',
    commands: Object.fromEntries(PLATFORM_IDS.map((p) => [p, PROFILES[p].probe]))
  },
  ...EXTRA,
  fromLive('ip-interfaces', 'IP interfaces', 'interfaces'),
  fromLive('vlans', 'VLANs', 'vlans'),
  fromLive('bgp-summary', 'BGP summary', 'bgp-neighbors'),
  fromLive('ospf-neighbors', 'OSPF neighbors', 'ospf-neighbors')
]

const norm = (c: string) => c.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The row a typed command belongs to: an exact (whitespace- and case-insensitive) match of one of
 * its commands, or `expand(command, platform)` (abbreviations expanded by the caller's resolver)
 * equal for some platform of the row. `interface-status` and `ip-interfaces` share commands on some
 * platforms (EOS lists interfaces with `show interfaces status`); the first row listed wins.
 */
export function equivalentOf(command: string, expand?: (command: string, platform: PlatformId) => string): Equivalent | undefined {
  const typed = norm(command)
  for (const e of EQUIVALENTS) if (Object.values(e.commands).some((c) => norm(c) === typed)) return e
  if (!expand) return undefined
  const words = typed.split(' ')
  for (const e of EQUIVALENTS)
    for (const [p, c] of Object.entries(e.commands) as [PlatformId, string][]) {
      // A classifier may resolve the known head of a command and leave the selection
      // (VRF, tunnel ID, filter) in its tail. Only expand abbreviations of the whole row.
      const form = norm(c).split(' ')
      if (form.length !== words.length || !form.every((word, i) => word.startsWith(words[i]!))) continue
      const x = expand(command, p)
      if (x && norm(x) === norm(expand(c, p) || c)) return e
    }
  return undefined
}
