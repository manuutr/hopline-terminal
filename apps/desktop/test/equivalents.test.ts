import { describe, expect, it } from 'vitest'
import { EQUIVALENTS, equivalentOf, type PlatformId } from '@hopline/cli-model'
import { classify } from '@hopline/guard'
import { translate } from '../src/main/productivity/multi-plan'

describe('cli-model equivalents', () => {
  it('every mapped command is read-only on its own platform (guard v2)', () => {
    const bad: string[] = []
    for (const e of EQUIVALENTS)
      for (const [p, c] of Object.entries(e.commands) as [PlatformId, string][]) {
        const v = classify(c, p)
        if (v.kind !== 'read') bad.push(`${e.id} ${p}: "${c}" is ${v.kind} (${v.reason})`)
      }
    expect(bad).toEqual([])
  })

  it('ids are unique and every row covers several platforms', () => {
    expect(new Set(EQUIVALENTS.map((e) => e.id)).size).toBe(EQUIVALENTS.length)
    for (const e of EQUIVALENTS) expect(Object.keys(e.commands).length).toBeGreaterThan(2)
  })

  it('finds the row by the exact command or an abbreviation', () => {
    const expand = (c: string, p: PlatformId) => classify(c, p).expanded
    expect(equivalentOf('show interfaces status')?.id).toBe('interface-status')
    expect(equivalentOf('SHOW  interfaces   terse')?.id).toBe('interface-status')
    expect(equivalentOf('sh ip int br', expand)?.id).toBe('ip-interfaces')
    expect(equivalentOf('show running-config', expand)).toBeUndefined()
  })

  it('translates per platform, and leaves a command without a row alone', () => {
    expect(translate('show interfaces status', 'junos')).toEqual({ command: 'show interfaces terse', translated: true })
    expect(translate('show interfaces status', 'iosxe')).toEqual({ command: 'show interfaces status', translated: false })
    expect(translate('show version', 'fortios')).toEqual({ command: 'get system status', translated: true })
    expect(translate('show clock', 'junos')).toEqual({ command: 'show clock', translated: false })
  })

  it('never replaces a scoped or filtered command with an unqualified equivalent', () => {
    for (const cmd of ['show routing route virtual-router tenant-a', 'show vpn flow tunnel-id 2', 'show vpn flow | match active']) {
      expect(translate(cmd, 'fortios')).toEqual({ command: cmd, translated: false })
    }
    expect(translate('show vpn flow', 'fortios')).toEqual({ command: 'get vpn ipsec tunnel summary', translated: true })
    expect(translate('get vpn ipsec tunnel summary', 'panos')).toEqual({ command: 'show vpn flow', translated: true })
  })
})
