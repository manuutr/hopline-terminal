import { describe, expect, it } from 'vitest'
import { compareOutputs, diffLines, normalizeOutput, stripEcho } from '@shared/output-diff'

describe('cross-device diff noise filter', () => {
  it('drops clocks, uptimes, counters and the final prompt', () => {
    expect(normalizeOutput('*03:34:28.123 UTC Wed Nov 25 2026\ncore-sw1#')).toBe('<time>')
    expect(normalizeOutput('core-sw1 uptime is 3 weeks, 2 days, 4 hours, 12 minutes')).toBe('core-sw1 uptime is <duration>')
    expect(normalizeOutput('     12345 packets input, 987654 bytes, 0 no buffer')).toBe('     <n> packets input, <n> bytes, 0 no buffer')
    expect(normalizeOutput('  5 minute input rate 2000 bits/sec, 3 packets/sec')).toBe('  5 minute input rate <rate>, <rate>')
    expect(normalizeOutput('Last update 2026-11-25T03:34:28Z')).toBe('Last update <time>')
    expect(normalizeOutput('BGP up for 1w2d')).toBe('BGP up for <duration>')
  })
  it('keeps what matters: names, states, addresses and VLAN numbers', () => {
    const s = 'Vlan10   10.0.10.1   YES manual up   up\nGi1/0/1  unassigned  YES unset  down  down'
    expect(normalizeOutput(s)).toBe(s)
  })
  it('diffs lines and counts the changed ones against a baseline', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'x' },
      { op: 'same', text: 'c' }
    ])
    const base = 'Version 17.9\nuptime is 2 days, 3 hours\n10 packets input'
    const r = compareOutputs(base, [
      { key: 'same', text: 'Version 17.9\nuptime is 5 weeks, 1 day\n999 packets input\nsw2#' },
      { key: 'other', text: 'Version 17.6\nuptime is 1 hour\n1 packets input' }
    ], { noise: true })
    expect(r.map((x) => [x.key, x.changed])).toEqual([['same', 0], ['other', 2]])
    expect(compareOutputs(base, [{ key: 'raw', text: 'Version 17.9\nuptime is 5 weeks, 1 day\n999 packets input' }], { noise: false })[0]!.changed).toBe(4)
  })
  it('strips the echoed command', () => {
    expect(stripEcho('show clock\n12:00:00 UTC', 'show clock')).toBe('12:00:00 UTC')
    expect(stripEcho('12:00:00 UTC', 'show clock')).toBe('12:00:00 UTC')
  })
})
