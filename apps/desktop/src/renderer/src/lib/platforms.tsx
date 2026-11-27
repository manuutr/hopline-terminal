import { PLATFORM_LABELS, PLATFORM_VENDORS, PLATFORMS, SESSION_PLATFORM_LABELS, type Platform, type SessionPlatform } from '@hopline/guard'
import { ScanSearch } from 'lucide-react'
import { PlatformMark, type SelectGroup } from '../design/SelectMenu'

/** Three or four letters for dense lists (tree rows, chips). */
export const PLATFORM_SHORT: Readonly<Record<SessionPlatform, string>> = {
  auto: 'AUTO',
  ios: 'IOS',
  iosxe: 'XE',
  nxos: 'NX',
  iosxr: 'XR',
  asa: 'ASA',
  c9800: 'WLC',
  aireos: 'AIR',
  ciscosb: 'SB',
  ftd: 'FTD',
  eos: 'EOS',
  junos: 'JUN',
  panos: 'PAN',
  fortios: 'FOS',
  aoscx: 'CX',
  vrp: 'VRP'
}

/** One line under the label in the platform menu: what the entry covers. */
const HINT: Partial<Record<Platform, string>> = {
  ios: 'classic IOS, 12.x/15.x',
  iosxe: 'Catalyst 9k, ISR, ASR 1k',
  iosxr: 'ASR 9k, NCS, 8000',
  c9800: 'wireless controller',
  aireos: 'legacy wireless controller',
  ciscosb: 'small business switches',
  ftd: 'Firepower Threat Defense',
  aoscx: 'CX switches'
}

export const platformLabel = (p: SessionPlatform | string): string => SESSION_PLATFORM_LABELS[p as SessionPlatform] ?? p

/** Vendor monogram for a platform (a letter, never a logo). */
export const platformMark = (p: SessionPlatform) =>
  p === 'auto' ? <ScanSearch className="size-3.5 text-accent" /> : <PlatformMark code={PLATFORM_VENDORS[p][0]!} />

const vendorGroups = (): SelectGroup<Platform>[] =>
  [...new Set(PLATFORMS.map((p) => PLATFORM_VENDORS[p]))].map((vendor) => ({
    label: vendor,
    options: PLATFORMS.filter((p) => PLATFORM_VENDORS[p] === vendor).map((p) => ({
      value: p,
      label: PLATFORM_LABELS[p],
      icon: <PlatformMark code={vendor[0]!} />,
      hint: HINT[p]
    }))
  }))

/** Platform menu groups: "Detect" (Auto-detect) on top when `auto` is offered, then each vendor. */
export function platformGroups(withAuto: boolean): SelectGroup<SessionPlatform>[] {
  const groups: SelectGroup<SessionPlatform>[] = vendorGroups()
  if (!withAuto) return groups
  return [
    {
      label: 'Detect',
      options: [{ value: 'auto', label: 'Auto-detect', text: 'Auto-detect', icon: platformMark('auto'), hint: 'on first connect' }]
    },
    ...groups
  ]
}
