/**
 * Keeps this package's local session shapes in sync with the desktop app's
 * (type-only import: no runtime dependency on apps/desktop).
 */
import { describe, expect, it } from 'vitest'
import type * as Desktop from '../../../apps/desktop/src/shared/types'
import { guessPlatform, platformFromSlug, SERIAL_DEFAULTS, toSessionInput, type Folder, type ImportedSession, type Session } from '../src'

describe('types stay compatible with apps/desktop/src/shared/types', () => {
  // Checked by `tsc` (root typecheck). Assignability, not equality, so additive
  // changes to the desktop types don't break this package; a new required field
  // on SessionInput, or a Protocol/Platform the importers can't produce, does.
  it('accepts desktop sessions and folders as planImport input', () => {
    const toLocal = (s: Desktop.Session, f: Desktop.Folder): [Session, Folder] => [s, f]
    expect(typeof toLocal).toBe('function')
  })
  it('produces a desktop SessionInput', () => {
    const imp: ImportedSession = { name: 'r1', folderPath: [], host: 'h', port: 22, protocol: 'ssh', username: '', notes: '', options: {}, tags: [], source: { format: 'csv', ref: 'row 2' } }
    const input: Desktop.SessionInput = toSessionInput(imp, { folderId: null, platform: 'ios' })
    expect(input.name).toBe('r1')
  })
  it('uses the same serial defaults', async () => {
    const desktop = await import('../../../apps/desktop/src/shared/types')
    expect(SERIAL_DEFAULTS).toEqual(desktop.SERIAL_DEFAULTS)
  })
})

describe('platform helpers', () => {
  it.each([
    ['core-nxos-01', 'nxos'],
    ['Cisco IOS-XE', 'iosxe'],
    ['edge_iosxe_2', 'iosxe'],
    ['spine-eos', 'eos'],
    ['Arista 7050', 'eos'],
    ['mx-junos-1', 'junos'],
    ['r1-ios', 'ios'],
    ['Cisco IOS XR', 'iosxr'],
    ['edge-fortigate-1', 'fortios'],
    ['Palo Alto PA-3220', 'panos'],
    ['dc1-asa-01', 'asa'],
    ['huawei-ce6800', 'vrp'],
    ['basalt-host', undefined],
    ['cisco-asr-1001', undefined],
    ['geos-server', undefined],
    ['bios-update', undefined],
    ['', undefined]
  ])('guessPlatform(%j) → %s', (text, want) => expect(guessPlatform(text)).toBe(want))

  it('maps slugs by exact table entry only', () => {
    expect(platformFromSlug('cisco_xe')).toEqual({ platform: 'iosxe' })
    expect(platformFromSlug('Cisco-IOS')).toEqual({ platform: 'ios' })
    expect(platformFromSlug('fortios')).toEqual({ platform: 'fortios' })
    expect(platformFromSlug('cisco-ios-xr')).toEqual({ platform: 'iosxr' })
    expect(platformFromSlug('cisco_s300')).toEqual({ platform: 'ciscosb' })
    expect(platformFromSlug('huawei_vrpv8')).toEqual({ platform: 'vrp' })
    expect(platformFromSlug('mikrotik_routeros')).toEqual({ unsupported: true })
    expect(platformFromSlug('vyos')).toEqual({ unsupported: true })
    expect(platformFromSlug('ios-something')).toEqual({})
  })
})
