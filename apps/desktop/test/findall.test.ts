import { describe, expect, it } from 'vitest'
import { findInBuffers, resolveHit, type SearchBuffer } from '../src/renderer/src/lib/findall'

/**
 * A fake xterm buffer `cols` wide. Each entry is one logical line; lines longer than `cols` are
 * soft-wrapped onto continuation rows (isWrapped), the way xterm stores them.
 */
function buffer(lines: string[], cols = 20): SearchBuffer & { rows: { text: string; isWrapped: boolean }[]; trim: (n: number) => void } {
  const rows: { text: string; isWrapped: boolean }[] = []
  for (const l of lines) {
    const chunks = l.match(new RegExp(`.{1,${cols}}`, 'g')) ?? ['']
    chunks.forEach((c, i) => rows.push({ text: c.padEnd(cols), isWrapped: i > 0 }))
  }
  return {
    rows,
    get length() {
      return rows.length
    },
    getLine: (y) => {
      const r = rows[y]
      return r && { isWrapped: r.isWrapped, translateToString: (trim?: boolean) => (trim ? r.text.trimEnd() : r.text) }
    },
    trim: (n) => void rows.splice(0, n)
  }
}
const search = (buf: SearchBuffer, q: string) => findInBuffers([{ tabId: 't', term: { buffer: { active: buf } } }], q)

describe('findInBuffers', () => {
  it('finds matches newest first, case-insensitive', () => {
    const buf = buffer(['show version', 'Cisco IOS XE', 'core-sw1#', 'cisco again'])
    const hits = search(buf, 'CISCO')
    expect(hits.map((h) => [h.line, h.text, h.start])).toEqual([
      [3, 'cisco again', 0],
      [1, 'Cisco IOS XE', 0]
    ])
  })

  it('finds a match split across a soft wrap, reporting the first row of the line', () => {
    // 20 columns: "...aabb.cc" | "00.0001 ..." — the MAC spans the wrap.
    const line = 'Gi1/0/1 up  aabb.cc00.0001 dynamic'
    const buf = buffer(['prompt#', line, 'prompt#'])
    expect(buf.rows[2]!.isWrapped).toBe(true)
    const [hit] = search(buf, 'aabb.cc00.0001')
    expect(hit).toMatchObject({ line: 1, text: line, start: 12, end: 26 })
  })

  it('keeps spaces at the end of a wrapped row', () => {
    // Row 1 is "Gi1/0/1 is up, line " (ends in a space), row 2 "protocol up": right-trimming
    // row 1 would join them as "line protocol" without the space.
    const buf = buffer(['Gi1/0/1 is up, line protocol up'], 20)
    expect(buf.rows[0]!.text.endsWith(' ')).toBe(true)
    expect(search(buf, 'line protocol')).toHaveLength(1)
    expect(search(buf, 'lineprotocol')).toHaveLength(0)
  })
})

describe('resolveHit', () => {
  it('uses the recorded row while it still holds the line', () => {
    const buf = buffer(['a', 'b', 'Cisco IOS XE', 'c'])
    const [hit] = search(buf, 'ios')
    expect(resolveHit(buf, hit!)).toEqual({ row: 2, col: 6, length: 3 })
  })

  it('finds the line again after the scrollback was trimmed', () => {
    const buf = buffer(['a', 'b', 'c', 'Cisco IOS XE', 'd'])
    const [hit] = search(buf, 'ios')
    expect(hit!.line).toBe(3)
    buf.trim(2) // two lines scrolled out of the scrollback since the search
    expect(resolveHit(buf, hit!)).toEqual({ row: 1, col: 6, length: 3 })
  })

  it('maps a match on a continuation row to that row and column', () => {
    const line = 'Gi1/0/1 up  aabb.cc00.0001 dynamic'
    const buf = buffer(['x', 'y', line])
    const [hit] = search(buf, 'dynamic')
    buf.trim(1)
    // Line now starts at row 1; "dynamic" is at offset 27 = row 2, column 7.
    expect(resolveHit(buf, hit!)).toEqual({ row: 2, col: 7, length: 7 })
  })

  it('falls back to a search for the query when the exact line is gone', () => {
    const buf = buffer(['a', 'Cisco IOS XE 17.9', 'b'])
    const [hit] = search(buf, 'ios')
    buf.rows.splice(0, 3, ...buffer(['Cisco IOS XE 17.12', 'z']).rows)
    expect(resolveHit(buf, hit!)).toEqual({ row: 0, col: 6, length: 3 })
  })

  it('gives up when the match left the buffer', () => {
    const buf = buffer(['a', 'Cisco IOS XE', 'b'])
    const [hit] = search(buf, 'ios')
    buf.trim(2)
    expect(resolveHit(buf, hit!)).toBeUndefined()
  })
})
