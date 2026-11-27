import { PLATFORM_IDS, type PlatformId } from '@hopline/cli-model'

/**
 * Platforms the desktop app offers for sessions (pickers, IPC schema, importers, executor prompt
 * detection): every cli-model platform, Cisco first. Adding a platform is a data change in
 * cli-model plus a label here.
 */
export const PLATFORMS = PLATFORM_IDS
export type Platform = PlatformId

/** Every platform the guard can classify. */
export const GUARD_PLATFORMS: readonly PlatformId[] = PLATFORM_IDS
export type GuardPlatform = PlatformId

/**
 * Static strings (equal to the cli-model profile labels and vendors, checked by a test) so the
 * renderer's pickers do not have to bundle the profiles.
 */
export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  ios: 'Cisco IOS',
  iosxe: 'Cisco IOS-XE',
  nxos: 'Cisco NX-OS',
  iosxr: 'Cisco IOS-XR',
  asa: 'Cisco ASA',
  c9800: 'Cisco Catalyst 9800 WLC',
  aireos: 'Cisco AireOS WLC',
  ciscosb: 'Cisco SG/CBS switch',
  ftd: 'Cisco FTD',
  eos: 'Arista EOS',
  junos: 'Juniper Junos',
  panos: 'Palo Alto PAN-OS',
  fortios: 'Fortinet FortiOS',
  aoscx: 'HPE Aruba AOS-CX',
  vrp: 'Huawei VRP'
}

export const PLATFORM_VENDORS: Readonly<Record<Platform, string>> = {
  ios: 'Cisco',
  iosxe: 'Cisco',
  nxos: 'Cisco',
  iosxr: 'Cisco',
  asa: 'Cisco',
  c9800: 'Cisco',
  aireos: 'Cisco',
  ciscosb: 'Cisco',
  ftd: 'Cisco',
  eos: 'Arista',
  junos: 'Juniper',
  panos: 'Palo Alto Networks',
  fortios: 'Fortinet',
  aoscx: 'HPE Aruba',
  vrp: 'Huawei'
}

/**
 * What a session stores: a platform, or `auto` until the first connect identifies the device.
 * The guard knows no `auto` profile, so it refuses every agent command until then.
 */
export const SESSION_PLATFORMS = ['auto', ...PLATFORM_IDS] as const
export type SessionPlatform = Platform | 'auto'

export const SESSION_PLATFORM_LABELS: Readonly<Record<SessionPlatform, string>> = { auto: 'Auto-detect', ...PLATFORM_LABELS }

export const isPlatform = (p: string | null | undefined): p is Platform => !!p && (PLATFORM_IDS as readonly string[]).includes(p)
