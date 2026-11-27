import { describe, expect, it } from 'vitest'
import {
  closePane,
  detectConfigMode,
  deserialize,
  findPane,
  focusAfterClose,
  focusDirection,
  glyphsFor,
  normalizeSizes,
  pane,
  paneOfTab,
  paneRects,
  panes,
  pruneLayout,
  serialize,
  setPaneTab,
  setSizes,
  splitPane,
  toggleZoom,
  topGlyph,
  touchMru,
  type LayoutNode,
  type SerializedNode,
  type SplitNode
} from '../src/renderer/src/lib/layout'

const ids = (n: LayoutNode) => panes(n).map((p) => p.id)
/** Shape as a compact string: row(a,column(b,c)). */
const shape = (n: LayoutNode): string => (n.type === 'pane' ? n.id : `${n.dir}(${n.children.map(shape).join(',')})`)

/** a | b over c, i.e. row(a, column(b, c)). */
function threePanes(): LayoutNode {
  let root: LayoutNode = pane('t1', 'a')
  root = splitPane(root, 'a', 'row', pane('t2', 'b'))
  root = splitPane(root, 'b', 'column', pane(null, 'c'))
  return root
}

describe('splitPane', () => {
  it('splits a single pane into a 50/50 split', () => {
    const root = splitPane(pane('t1', 'a'), 'a', 'row', pane(null, 'b'), 's1')
    expect(root).toEqual({ type: 'split', id: 's1', dir: 'row', sizes: [50, 50], children: [pane('t1', 'a'), pane(null, 'b')] })
  })

  it('adds a sibling when splitting in the parent direction, halving the split pane', () => {
    let root = splitPane(pane('t1', 'a'), 'a', 'row', pane(null, 'b'))
    root = splitPane(root, 'a', 'row', pane(null, 'c'))
    expect(shape(root)).toBe('row(a,c,b)')
    expect((root as SplitNode).sizes).toEqual([25, 25, 50])
  })

  it('nests a split when the direction differs', () => {
    expect(shape(threePanes())).toBe('row(a,column(b,c))')
  })

  it('ignores an unknown pane', () => {
    const root = pane('t1', 'a')
    expect(splitPane(root, 'zz', 'row', pane())).toBe(root)
  })

  it('does not mutate its input', () => {
    const root = threePanes()
    const before = JSON.stringify(root)
    splitPane(root, 'c', 'row', pane())
    closePane(root, 'b')
    expect(JSON.stringify(root)).toBe(before)
  })
})

describe('closePane', () => {
  it('returns null for the last pane', () => {
    expect(closePane(pane('t1', 'a'), 'a')).toBeNull()
  })

  it('collapses a two-child split into the survivor', () => {
    const root = splitPane(pane('t1', 'a'), 'a', 'row', pane('t2', 'b'))
    expect(closePane(root, 'a')).toEqual(pane('t2', 'b'))
  })

  it('collapses a nested split and keeps the rest', () => {
    const root = closePane(threePanes(), 'c')!
    expect(shape(root)).toBe('row(a,b)')
    expect((root as SplitNode).sizes).toEqual([50, 50])
  })

  it('gives the removed share to the previous sibling', () => {
    let root = splitPane(pane('t1', 'a'), 'a', 'row', pane(null, 'b'))
    root = splitPane(root, 'b', 'row', pane(null, 'c')) // 50, 25, 25
    root = setSizes(root, (root as SplitNode).id, [40, 30, 30])
    const after = closePane(root, 'b') as SplitNode
    expect(shape(after)).toBe('row(a,c)')
    expect(after.sizes).toEqual([70, 30])
  })

  it('gives the share to the next sibling when the first pane closes', () => {
    let root = splitPane(pane('t1', 'a'), 'a', 'row', pane(null, 'b'))
    root = splitPane(root, 'b', 'row', pane(null, 'c'))
    root = setSizes(root, (root as SplitNode).id, [40, 30, 30])
    expect((closePane(root, 'a') as SplitNode).sizes).toEqual([70, 30])
  })

  it('merges a child split into a parent of the same direction', () => {
    // row(a, column(b, row(c, d))) → close b → row(a, c, d) with c and d sharing b's column
    let root = threePanes()
    root = splitPane(root, 'c', 'row', pane(null, 'd'))
    expect(shape(root)).toBe('row(a,column(b,row(c,d)))')
    const after = closePane(root, 'b') as SplitNode
    expect(shape(after)).toBe('row(a,c,d)')
    expect(after.sizes).toEqual([50, 25, 25])
  })

  it('ignores an unknown pane', () => {
    expect(shape(closePane(threePanes(), 'zz')!)).toBe('row(a,column(b,c))')
  })
})

describe('focusDirection', () => {
  it('moves between neighbours', () => {
    const root = threePanes()
    expect(focusDirection(root, 'a', 'right')).toBe('b') // b is on top, wins the tie by reading order
    expect(focusDirection(root, 'b', 'down')).toBe('c')
    expect(focusDirection(root, 'c', 'up')).toBe('b')
    expect(focusDirection(root, 'c', 'left')).toBe('a')
    expect(focusDirection(root, 'b', 'left')).toBe('a')
  })

  it('returns undefined at an edge', () => {
    const root = threePanes()
    expect(focusDirection(root, 'a', 'left')).toBeUndefined()
    expect(focusDirection(root, 'a', 'up')).toBeUndefined()
    expect(focusDirection(root, 'b', 'right')).toBeUndefined()
    expect(focusDirection(pane('t', 'x'), 'x', 'right')).toBeUndefined()
  })

  it('prefers the neighbour with the largest overlap', () => {
    // column(row(a, b), c) with a 20 % and b 80 % wide: from c, up goes to b.
    let root: LayoutNode = pane('t1', 'a')
    root = splitPane(root, 'a', 'column', pane(null, 'c'))
    root = splitPane(root, 'a', 'row', pane(null, 'b'))
    const inner = (root as SplitNode).children[0] as SplitNode
    root = setSizes(root, inner.id, [20, 80])
    expect(focusDirection(root, 'c', 'up')).toBe('b')
  })

  it('computes pane rectangles from the sizes', () => {
    const r = paneRects(threePanes())
    expect(r.get('a')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(r.get('c')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  })
})

describe('zoom', () => {
  it('toggles on and off', () => {
    const root = threePanes()
    expect(toggleZoom(root, null, 'b')).toBe('b')
    expect(toggleZoom(root, 'b', 'b')).toBeNull()
    expect(toggleZoom(root, 'b', 'c')).toBe('c')
  })

  it('refuses a single pane or an unknown one', () => {
    expect(toggleZoom(pane('t', 'a'), null, 'a')).toBeNull()
    expect(toggleZoom(threePanes(), null, 'zz')).toBeNull()
  })
})

describe('helpers', () => {
  it('finds panes and swaps their tab', () => {
    let root = threePanes()
    expect(paneOfTab(root, 't2')?.id).toBe('b')
    root = setPaneTab(root, 'c', 't3')
    expect(findPane(root, 'c')?.tabId).toBe('t3')
    expect(ids(root)).toEqual(['a', 'b', 'c'])
  })

  it('normalizes sizes to 100', () => {
    expect(normalizeSizes([1, 1, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6)
    expect(normalizeSizes([0, 0])).toEqual([50, 50])
    expect(normalizeSizes([Number.NaN, 30])).toEqual([0, 100])
  })

  it('setSizes ignores a size list of the wrong length', () => {
    const root = threePanes() as SplitNode
    expect(setSizes(root, root.id, [10])).toBe(root)
    expect((setSizes(root, root.id, [30, 70]) as SplitNode).sizes).toEqual([30, 70])
  })
})

describe('serialization', () => {
  const sessionOf = (t: string) => ({ t1: 'core-sw1', t2: 'dist-eos1' })[t]

  it('round-trips the shape and sizes, mapping tabs to sessions', () => {
    let root = threePanes()
    root = setSizes(root, (root as SplitNode).id, [30, 70])
    const data = serialize(root, sessionOf)
    expect(data).toEqual({ split: 'row', sizes: [30, 70], children: [{ pane: 'core-sw1' }, { split: 'column', sizes: [50, 50], children: [{ pane: 'dist-eos1' }, { pane: null }] }] })

    const opened: string[] = []
    const back = deserialize(JSON.parse(JSON.stringify(data)), (s) => {
      opened.push(s)
      return `new-${s}`
    })
    expect(opened).toEqual(['core-sw1', 'dist-eos1'])
    expect(panes(back).map((p) => p.tabId)).toEqual(['new-core-sw1', 'new-dist-eos1', null])
    expect(serialize(back, (t) => t.replace('new-', ''))).toEqual(data)
  })

  it('rejects malformed input', () => {
    expect(() => deserialize(null, () => 'x')).toThrow()
    expect(() => deserialize({ split: 'diagonal', sizes: [], children: [] }, () => 'x')).toThrow()
    expect(() => deserialize({ pane: 42 }, () => 'x')).toThrow()
    expect(() => deserialize({ split: 'row', sizes: [], children: [] }, () => 'x')).toThrow()
  })

  it('collapses degenerate splits and repairs bad sizes', () => {
    expect(deserialize({ split: 'row', sizes: [100], children: [{ pane: 's' }] }, () => 't').type).toBe('pane')
    const s = deserialize({ split: 'row', sizes: [1], children: [{ pane: 'a' }, { pane: 'b' }] }, (x) => x) as SplitNode
    expect(s.sizes).toEqual([50, 50])
  })
})

describe('focusAfterClose', () => {
  it('focuses the sibling inside the same split, not the previous pane in reading order', () => {
    // row(a, column(b, c)): b and c share the column, so closing b gives its space (and focus) to c.
    expect(focusAfterClose(threePanes(), 'b')).toBe('c')
    expect(focusAfterClose(threePanes(), 'c')).toBe('b')
    expect(focusAfterClose(threePanes(), 'a')).toBe('b')
  })

  it('picks the nearest pane of a sibling split', () => {
    // row(column(a, d), b): closing b focuses d, the last pane of the column next to it.
    let root: LayoutNode = splitPane(pane('t1', 'a'), 'a', 'row', pane('t2', 'b'))
    root = splitPane(root, 'a', 'column', pane(null, 'd'))
    expect(shape(root)).toBe('row(column(a,d),b)')
    expect(focusAfterClose(root, 'b')).toBe('d')
    expect(focusAfterClose(root, 'a')).toBe('d')
  })

  it('has no answer for the last pane or an unknown one', () => {
    expect(focusAfterClose(pane('t1', 'a'), 'a')).toBeUndefined()
    expect(focusAfterClose(threePanes(), 'zz')).toBeUndefined()
  })
})

describe('pruneLayout', () => {
  const data = { split: 'row', sizes: [30, 70], children: [{ pane: 'core-sw1' }, { split: 'column', sizes: [40, 60], children: [{ pane: 'dist-eos1' }, { pane: null }] }] } satisfies SerializedNode as SerializedNode
  const only = (...ids: string[]) => (id: string) => ids.includes(id)

  it('keeps a layout whose sessions all exist', () => {
    expect(pruneLayout(data, only('core-sw1', 'dist-eos1'))).toEqual(data)
  })

  it('drops panes of deleted sessions and collapses the split they leave', () => {
    expect(pruneLayout(data, only('dist-eos1'))).toEqual({ split: 'column', sizes: [40, 60], children: [{ pane: 'dist-eos1' }, { pane: null }] })
    expect(pruneLayout(data, only('core-sw1'))).toEqual({ split: 'row', sizes: [30, 70], children: [{ pane: 'core-sw1' }, { pane: null }] })
  })

  it('returns null when no pane with a session is left, even if empty panes are', () => {
    expect(pruneLayout(data, only())).toBeNull()
    expect(pruneLayout({ pane: 'gone' }, only())).toBeNull()
    expect(pruneLayout({ pane: null }, only())).toBeNull()
  })

  it('renormalizes sizes when a middle child goes', () => {
    const three = { split: 'row' as const, sizes: [25, 25, 50], children: [{ pane: 'a' }, { pane: 'gone' }, { pane: 'b' }] }
    expect(pruneLayout(three, only('a', 'b'))).toEqual({ split: 'row', sizes: [33.33, 66.67], children: [{ pane: 'a' }, { pane: 'b' }] })
  })
})

describe('status glyphs', () => {
  it('orders by priority: approval > auth > down > reconnecting > config > bell > unread', () => {
    expect(glyphsFor({ state: 'connected', needsApproval: true, configMode: true, bell: true, unread: true })).toEqual(['approval', 'config', 'bell', 'unread'])
    expect(glyphsFor({ state: 'down', detail: 'All configured authentication methods failed' })).toEqual(['auth'])
    expect(glyphsFor({ state: 'down', detail: 'closed', unread: true })).toEqual(['down', 'unread'])
    expect(glyphsFor({ state: 'reconnecting', bell: true })).toEqual(['reconnecting', 'bell'])
    expect(glyphsFor({ state: 'connected' })).toEqual([])
  })

  it('shows config mode only while connected', () => {
    expect(glyphsFor({ state: 'down', configMode: true })).toEqual(['down'])
  })

  it('picks the most urgent glyph across panes', () => {
    expect(topGlyph([{ state: 'connected', unread: true }, { state: 'connected', configMode: true }])).toBe('config')
    expect(topGlyph([{ state: 'connected', configMode: true }, { state: 'connected', needsApproval: true }])).toBe('approval')
    expect(topGlyph([{ state: 'connected' }])).toBeUndefined()
  })

  it.each([
    ['core-sw1(config)#', true],
    ['core-sw1(config-if)# ', true],
    ['dist-eos1(config-if-Et1)#', true],
    ['core-sw1#', false],
    ['core-sw1>', false],
    ['Building configuration...', undefined],
    ['interface Gi1/0/1', undefined]
  ])('detects config mode in %j', (line, want) => {
    expect(detectConfigMode(line)).toBe(want)
  })

  it('detects Junos configuration mode from the [edit] banner', () => {
    expect(detectConfigMode('admin@mx1#', '[edit]')).toBe(true)
    expect(detectConfigMode('admin@mx1>', '')).toBe(false)
  })
})

describe('touchMru', () => {
  it('moves to front, drops closed ids and appends new ones', () => {
    expect(touchMru(['a', 'b', 'c'], 'c', ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
    expect(touchMru(['a', 'b', 'c'], 'a', ['a', 'c', 'd'])).toEqual(['a', 'c', 'd'])
    expect(touchMru([], 'x', ['y'])).toEqual(['y'])
  })
})
