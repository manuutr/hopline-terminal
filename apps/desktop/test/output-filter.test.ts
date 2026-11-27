import { describe, expect, it } from 'vitest'
import { applyFilter, describeFilter, FilterError, GREP_TIMEOUT_MS, OutputFilter } from '../src/main/agent/filter'

const log = Array.from({ length: 2410 }, (_, i) => `*Nov 25 10:${String(i % 60).padStart(2, '0')}: ${i % 100 === 0 ? '%LINK-3-UPDOWN: Interface Gi1/0/2, changed state to down' : `%SYS-5-CONFIG_I: line ${i}`}`).join('\n')

describe('client-side output filters (F5b)', () => {
  it('tail keeps the last N lines and says what was filtered', () => {
    const r = applyFilter(log, { tail: 30 })
    expect(r.text.split('\n')).toHaveLength(30)
    expect(r.text.split('\n').at(-1)).toMatch(/line 2409$/)
    expect(r.note).toBe('showing last 30 of 2,410 lines')
  })

  it('head keeps the first N lines', () => {
    const r = applyFilter('a\nb\nc\n', { head: 2 })
    expect(r.text).toBe('a\nb')
    expect(r.note).toBe('showing first 2 of 3 lines')
  })

  it('grep supports regex alternation, ignoreCase and invert', () => {
    const r = applyFilter(log, { grep: 'updown|nothing', ignoreCase: true })
    expect(r.text.split('\n')).toHaveLength(25)
    expect(r.note).toBe('showing 25 matching lines (of 2,410 lines)')
    const v = applyFilter('up\ndown\nup', { grep: 'up', invert: true })
    expect(v.text).toBe('down')
  })

  it('grep then tail, and count', () => {
    const r = applyFilter(log, { grep: 'UPDOWN', tail: 2 })
    expect(r.text.split('\n')).toHaveLength(2)
    expect(r.note).toBe('showing last 2 of 25 matching lines (of 2,410 lines)')
    expect(applyFilter(log, { grep: 'UPDOWN', count: true })).toEqual({ text: '25', note: '25 lines of 2,410 lines match /UPDOWN/' })
  })

  it('context lines (-B/-A) with "--" between separate groups', () => {
    const text = ['a', 'b', 'HIT', 'c', 'd', 'e', 'f', 'HIT', 'g'].join('\n')
    expect(applyFilter(text, { grep: 'HIT', before: 1, after: 1 }).text).toBe(['b', 'HIT', 'c', '--', 'f', 'HIT', 'g'].join('\n'))
    // Overlapping windows merge without duplicates.
    expect(applyFilter('x\nHIT\nHIT\ny', { grep: 'HIT', before: 1, after: 1 }).text).toBe('x\nHIT\nHIT\ny')
  })

  it('a catastrophic-backtracking pattern is stopped by the time budget instead of hanging', () => {
    const evil = 'a'.repeat(5000) + '!'
    const t = Date.now()
    expect(() => applyFilter(evil, { grep: '(a+)+$' })).toThrow(FilterError)
    expect(Date.now() - t).toBeLessThan(GREP_TIMEOUT_MS + 1500)
    // The shared sandbox still works afterwards.
    expect(applyFilter('ok\nno', { grep: 'ok' }).text).toBe('ok')
  })

  it('an invalid regex is a FilterError, and the schema bounds every field', () => {
    expect(() => applyFilter('x', { grep: '(' })).toThrow(/invalid grep pattern/)
    expect(OutputFilter.safeParse({ grep: 'x'.repeat(201) }).success).toBe(false)
    expect(OutputFilter.safeParse({ tail: 0 }).success).toBe(false)
    expect(OutputFilter.safeParse({ tail: 1.5 }).success).toBe(false)
    expect(OutputFilter.safeParse({ tail: 10_001 }).success).toBe(false)
    expect(OutputFilter.safeParse({ before: 51 }).success).toBe(false)
    expect(OutputFilter.safeParse({ shell: 'rm -rf' }).success).toBe(false)
    expect(OutputFilter.safeParse({ tail: 30, grep: 'down', ignoreCase: true }).success).toBe(true)
  })

  it('labels the filter for the command card', () => {
    expect(describeFilter({ tail: 30 })).toBe('last 30 lines')
    expect(describeFilter({ grep: 'down', ignoreCase: true, after: 2, tail: 1 })).toBe('grep /down/i -A2 · last 1 line')
    expect(describeFilter({ grep: 'up', invert: true, count: true })).toBe('grep -v /up/ · count')
  })
})
