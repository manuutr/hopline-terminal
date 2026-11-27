import { describe, expect, it } from 'vitest'
import { classify } from '../../src'
import { CORPUS } from './corpus'

const key = (a: (typeof CORPUS)[number]) => `${a.p}|${a.mode ?? 'exec'}|${a.cmd}`

describe('red-team corpus', () => {
  it('has at least 300 distinct attempts', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(300)
    const seen = new Set<string>()
    const dupes = CORPUS.filter((a) => (seen.has(key(a)) ? true : (seen.add(key(a)), false))).map(key)
    expect(dupes).toEqual([])
  })

  it('is written in ASCII (control and Unicode characters as escapes)', () => {
    // Guards against an editor silently normalizing the attack strings.
    expect(CORPUS.some((a) => /[^\x20-\x7e]/.test(a.cmd))).toBe(true)
  })

  it('every attempt classifies exactly as expected (100%)', () => {
    const misses = CORPUS.map((a) => ({ a, got: classify(a.cmd, a.p, { mode: a.mode }) }))
      .filter(({ a, got }) => got.kind !== a.expect)
      .map(({ a, got }) => `[${a.cat}] ${a.p}${a.mode ? ` (${a.mode})` : ''}: ${JSON.stringify(a.cmd)} expected ${a.expect}, got ${got.kind}: ${got.reason}`)
    expect(misses).toEqual([])
  })

  it('no attack is ever runnable as read', () => {
    for (const a of CORPUS.filter((x) => x.expect !== 'read')) expect(classify(a.cmd, a.p, { mode: a.mode }).kind, key(a)).not.toBe('read')
  })
})
