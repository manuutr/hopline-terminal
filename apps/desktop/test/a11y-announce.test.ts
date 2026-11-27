import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANNOUNCE, AnnounceQueue, AnnounceScheduler, visibleText } from '../src/renderer/src/lib/announce'
import { bufferText, findAll } from '../src/renderer/src/lib/buffer-text'

describe('screen reader announcements: polite, throttled, never a flood', () => {
  afterEach(() => vi.useRealTimers())

  it('a short answer is read whole, with the prompt that follows it', () => {
    const q = new AnnounceQueue()
    q.push(['*10:02:11.123 UTC Mon Nov 25 2026', ''])
    q.setPartial('core-sw1#')
    expect(q.take()).toBe('*10:02:11.123 UTC Mon Nov 25 2026\ncore-sw1#')
    expect(q.take()).toBeNull()
    q.push(['*10:04:20.000 UTC Mon Nov 25 2026'])
    q.setPartial('core-sw1#')
    expect(q.take()).toBe('*10:04:20.000 UTC Mon Nov 25 2026\ncore-sw1#')
  })

  it('typing alone is never echoed: the prompt line is only read along with new output', () => {
    const q = new AnnounceQueue()
    q.setPartial('core-sw1#show ver')
    expect(q.take()).toBeNull()
  })

  it('a flood is summarised: the count and the last lines, bounded in length', () => {
    const q = new AnnounceQueue()
    q.push(Array.from({ length: 5000 }, (_, i) => `interface GigabitEthernet1/0/${i} description uplink-${i}`))
    q.setPartial('core-sw1#')
    const said = q.take()!
    expect(said).toMatch(/^5001 lines of output\. Last: /)
    expect(said).toContain('core-sw1#')
    expect(said.length).toBeLessThan(300)
  })

  it('long single lines are summarised too', () => {
    const q = new AnnounceQueue()
    q.push(['x'.repeat(ANNOUNCE.maxChars + 1)])
    expect(q.take()).toMatch(/^1 lines of output/)
  })

  it('the scheduler speaks at most once per interval, and nothing is lost between batches', () => {
    vi.useFakeTimers()
    let t = 0
    const said: string[] = []
    const q = new AnnounceQueue()
    const s = new AnnounceScheduler(q, (x) => said.push(x), () => t)
    for (let i = 0; i < 20; i++) {
      q.push([`line ${i}`])
      s.kick()
      t += 50
      vi.advanceTimersByTime(50)
    }
    // 1 s of output in 50 ms steps: at most two announcements so far.
    expect(said.length).toBeLessThanOrEqual(2)
    t += 5000
    vi.advanceTimersByTime(5000)
    expect(said.join('\n')).toMatch(/line 19/)
    const times: number[] = []
    const s2 = new AnnounceScheduler(q, () => times.push(t), () => t)
    for (let i = 0; i < 50; i++) {
      q.push([`more ${i}`])
      s2.kick()
      t += 100
      vi.advanceTimersByTime(100)
    }
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(ANNOUNCE.intervalMs)
    s.dispose()
    s2.dispose()
  })
})

const fakeBuf = (rows: [string, boolean][]) => ({
  length: rows.length,
  getLine: (y: number) => (rows[y] ? { isWrapped: rows[y]![1], translateToString: (trim?: boolean) => (trim ? rows[y]![0].trimEnd() : rows[y]![0]) } : undefined)
})

describe('accessible buffer view text', () => {
  it('joins soft-wrapped rows, maps rows to offsets, drops the unused screen below', () => {
    const b = bufferText(
      fakeBuf([
        ['core-sw1#show ip int br   ', false],
        ['Gi1/0/1  10.0.0.1 up', false],
        ['Gi1/0/2  a very long line that ', false],
        ['wrapped onto the next row', true],
        ['core-sw1#', false],
        ['', false],
        ['', false]
      ])
    )
    expect(b.text).toBe('core-sw1#show ip int br\nGi1/0/1  10.0.0.1 up\nGi1/0/2  a very long line that wrapped onto the next row\ncore-sw1#')
    expect(b.offsetOfRow(1)).toBe(b.text.indexOf('Gi1/0/1'))
    expect(b.offsetOfRow(3)).toBe(b.text.indexOf('Gi1/0/2'))
    expect(b.offsetOfRow(4)).toBe(b.text.lastIndexOf('core-sw1#'))
    expect(b.rowAt(b.text.indexOf('wrapped'))).toBe(3)
    expect(b.rowAt(0)).toBe(0)
  })

  it('find is case-insensitive by default', () => {
    expect(findAll('Up up UP down', 'up')).toEqual([0, 3, 6])
    expect(findAll('Up up UP down', 'up', true)).toEqual([3])
    expect(findAll('abc', '')).toEqual([])
  })
})

/** A row of cells: `[chars, invisible?, width?]`. */
const cells = (spec: [string, boolean?, number?][]) => ({
  length: spec.length,
  getCell: (x: number) => {
    const c = spec[x]
    return c ? { getChars: () => c[0], getWidth: () => c[2] ?? 1, isInvisible: () => (c[1] ? 1 : 0) } : undefined
  }
})
const row = (s: string, hidden: (i: number) => boolean = () => false) => cells([...s].map((ch, i) => [ch, hidden(i)] as [string, boolean]))

describe('live region: says nothing the screen does not show (Phase 6–8 review addendum)', () => {
  afterEach(() => vi.useRealTimers())

  it('concealed (SGR 8) cells are spoken as blanks, never as their text', () => {
    expect(visibleText(row('key: hunter2', (i) => i >= 5))).toBe('key:')
    expect(visibleText(row('pass hunter2 ok', (i) => i >= 5 && i < 12))).toBe('pass         ok')
    expect(visibleText(row('core-sw1#'))).toBe('core-sw1#')
    // A wide character's right half is not doubled; empty cells are spaces, trailing ones trimmed.
    expect(visibleText(cells([['界', false, 2], ['', false, 0], ['x'], [''], ['']]))).toBe('界x')
    expect(visibleText(undefined)).toBe('')
  })

  it('a batch queued for a tab the user left, or after the mode was turned off, is dropped, not read late', () => {
    vi.useFakeTimers()
    const said: string[] = []
    let ok = true
    const q = new AnnounceQueue()
    const s = new AnnounceScheduler(q, (t) => said.push(t), () => Date.now(), ANNOUNCE.intervalMs, () => ok)
    q.push(['output of tab A'])
    s.kick()
    ok = false // switched tab / mode off before the settle ran out
    vi.advanceTimersByTime(2000)
    expect(said).toEqual([])
    expect(q.pending).toBe(false)
    ok = true
    q.push(['next'])
    s.kick()
    vi.advanceTimersByTime(2000)
    expect(said).toEqual(['next'])
  })

  it('at most one announcement per interval under a steady stream', () => {
    vi.useFakeTimers()
    const at: number[] = []
    const q = new AnnounceQueue()
    const s = new AnnounceScheduler(q, () => at.push(Date.now()))
    for (let i = 0; i < 50; i++) {
      q.push([`line ${i}`])
      s.kick()
      vi.advanceTimersByTime(100)
    }
    vi.advanceTimersByTime(3000)
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(ANNOUNCE.intervalMs)
    expect(at.length).toBeGreaterThanOrEqual(4)
  })
})
