/**
 * Split-pane layout tree. Pure functions only (no React, no store, no DOM) so they are unit tested.
 *
 * Every workspace in the open connections list owns one tree. Leaves are panes holding one terminal tab id
 * (`null` = an empty pane showing the "Connect to…" launcher). Inner nodes are splits with a
 * direction, two or more children and their sizes in percent (summing to 100).
 */

export type SplitDir = 'row' | 'column' // row: children side by side (split right); column: stacked (split down)
export type FocusDir = 'left' | 'right' | 'up' | 'down'

export interface PaneNode {
  type: 'pane'
  id: string
  tabId: string | null
}

export interface SplitNode {
  type: 'split'
  id: string
  dir: SplitDir
  children: LayoutNode[]
  /** Percent of the parent, one per child, summing to 100. */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

let seq = 0
/** Ids only need to be unique within the renderer session. */
export const nodeId = (prefix = 'n'): string => `${prefix}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const pane = (tabId: string | null = null, id = nodeId('p')): PaneNode => ({ type: 'pane', id, tabId })

/** Panes in reading order (depth first, left to right / top to bottom). */
export function panes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panes)
}

export function findPane(root: LayoutNode, paneId: string): PaneNode | undefined {
  return panes(root).find((p) => p.id === paneId)
}

export function paneOfTab(root: LayoutNode, tabId: string): PaneNode | undefined {
  return panes(root).find((p) => p.tabId === tabId)
}

/** Rebuild the tree, replacing nodes for which `f` returns a node. */
function mapNode(node: LayoutNode, f: (n: LayoutNode) => LayoutNode | undefined): LayoutNode {
  const hit = f(node)
  if (hit) return hit
  if (node.type === 'pane') return node
  let changed = false
  const children = node.children.map((c) => {
    const m = mapNode(c, f)
    if (m !== c) changed = true
    return m
  })
  return changed ? { ...node, children } : node
}

export function setPaneTab(root: LayoutNode, paneId: string, tabId: string | null): LayoutNode {
  return mapNode(root, (n) => (n.type === 'pane' && n.id === paneId ? { ...n, tabId } : undefined))
}

/** Round to 0.01 % and make the sizes sum to exactly 100. */
export function normalizeSizes(sizes: number[]): number[] {
  if (!sizes.length) return []
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  const pct = total > 0 ? clean.map((s) => (s / total) * 100) : clean.map(() => 100 / clean.length)
  const rounded = pct.map((s) => Math.round(s * 100) / 100)
  const drift = Math.round((100 - rounded.reduce((a, b) => a + b, 0)) * 100) / 100
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1]! + drift) * 100) / 100
  return rounded
}

/**
 * Split `paneId` in `dir`, putting `added` after it. Splitting in the same direction as the
 * parent adds a sibling (halving the split pane's share) instead of nesting another split.
 */
export function splitPane(root: LayoutNode, paneId: string, dir: SplitDir, added: LayoutNode, splitId = nodeId('s')): LayoutNode {
  if (!findPane(root, paneId)) return root
  const inParent = (node: LayoutNode): LayoutNode | undefined => {
    if (node.type !== 'split' || node.dir !== dir) return undefined
    const i = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId)
    if (i < 0) return undefined
    const half = node.sizes[i]! / 2
    const children = [...node.children.slice(0, i + 1), added, ...node.children.slice(i + 1)]
    const sizes = [...node.sizes.slice(0, i), half, half, ...node.sizes.slice(i + 1)]
    return { ...node, children, sizes: normalizeSizes(sizes) }
  }
  const sibling = mapNode(root, inParent)
  if (sibling !== root) return sibling
  return mapNode(root, (n) =>
    n.type === 'pane' && n.id === paneId ? { type: 'split', id: splitId, dir, children: [n, added], sizes: [50, 50] } : undefined
  )
}

/**
 * Remove a pane. Its share goes to its neighbour (the previous sibling, or the next one if it was
 * first). A split left with one child is replaced by that child, and a child split with the same
 * direction as its new parent is merged into it. Returns null when the last pane is removed.
 */
export function closePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.type === 'pane') return root.id === paneId ? null : root
  const rec = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === paneId ? null : node
    const i = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId)
    let children: LayoutNode[]
    let sizes: number[]
    if (i >= 0) {
      children = node.children.filter((_, j) => j !== i)
      sizes = node.sizes.filter((_, j) => j !== i)
      const to = i > 0 ? i - 1 : 0
      sizes[to] = sizes[to]! + node.sizes[i]!
    } else {
      children = []
      sizes = []
      node.children.forEach((c, j) => {
        const m = rec(c)
        if (m) {
          children.push(m)
          sizes.push(node.sizes[j]!)
        }
      })
    }
    if (children.length === 1) return children[0]!
    // Flatten a child split that now runs in our direction.
    const flatC: LayoutNode[] = []
    const flatS: number[] = []
    children.forEach((c, j) => {
      if (c.type === 'split' && c.dir === node.dir) {
        c.children.forEach((cc, k) => {
          flatC.push(cc)
          flatS.push((sizes[j]! * c.sizes[k]!) / 100)
        })
      } else {
        flatC.push(c)
        flatS.push(sizes[j]!)
      }
    })
    return { ...node, children: flatC, sizes: normalizeSizes(flatS) }
  }
  return rec(root)
}

/**
 * The pane that should get focus after `paneId` is closed: the one that takes its space, i.e. a
 * pane in its previous sibling (the nearest one, its last) or else its next sibling (its first).
 * In row(a, column(b, c)), closing b focuses c, not a. Undefined for the last pane.
 */
export function focusAfterClose(root: LayoutNode, paneId: string): string | undefined {
  const rec = (node: LayoutNode): string | undefined => {
    if (node.type === 'pane') return undefined
    const i = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId)
    if (i >= 0) {
      const prev = node.children[i - 1]
      if (prev) return panes(prev).at(-1)!.id
      const next = node.children[i + 1]
      return next ? panes(next)[0]!.id : undefined
    }
    for (const c of node.children) {
      const hit = rec(c)
      if (hit) return hit
    }
    return undefined
  }
  return rec(root)
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  return mapNode(root, (n) =>
    n.type === 'split' && n.id === splitId && sizes.length === n.children.length ? { ...n, sizes: normalizeSizes(sizes) } : undefined
  )
}

/** Pane rectangles in a unit square (0..1), derived from the split sizes. */
export function paneRects(root: LayoutNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const rec = (node: LayoutNode, r: Rect) => {
    if (node.type === 'pane') {
      out.set(node.id, r)
      return
    }
    let offset = 0
    node.children.forEach((c, i) => {
      const f = (node.sizes[i] ?? 0) / 100
      if (node.dir === 'row') rec(c, { x: r.x + offset * r.w, y: r.y, w: f * r.w, h: r.h })
      else rec(c, { x: r.x, y: r.y + offset * r.h, w: r.w, h: f * r.h })
      offset += f
    })
  }
  rec(root, rect)
  return out
}

/**
 * The pane next to `fromId` in `dir`: among panes whose edge touches ours on that side and that
 * overlap us on the other axis, pick the one with the largest overlap (ties: closest to our centre,
 * then reading order). Undefined at the edge of the layout.
 */
export function focusDirection(root: LayoutNode, fromId: string, dir: FocusDir): string | undefined {
  const rects = paneRects(root)
  const from = rects.get(fromId)
  if (!from) return undefined
  const eps = 1e-6
  const horizontal = dir === 'left' || dir === 'right'
  let best: { id: string; overlap: number; dist: number } | undefined
  for (const [id, r] of rects) {
    if (id === fromId) continue
    const touches =
      dir === 'left' ? Math.abs(r.x + r.w - from.x) < eps
      : dir === 'right' ? Math.abs(from.x + from.w - r.x) < eps
      : dir === 'up' ? Math.abs(r.y + r.h - from.y) < eps
      : Math.abs(from.y + from.h - r.y) < eps
    if (!touches) continue
    const overlap = horizontal
      ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y)
      : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x)
    if (overlap <= eps) continue
    const dist = horizontal ? Math.abs(r.y + r.h / 2 - (from.y + from.h / 2)) : Math.abs(r.x + r.w / 2 - (from.x + from.w / 2))
    if (!best || overlap > best.overlap + eps || (Math.abs(overlap - best.overlap) <= eps && dist < best.dist - eps)) best = { id, overlap, dist }
  }
  return best?.id
}

/** Zoom toggling: zooming the zoomed pane unzooms; a pane that no longer exists is never zoomed. */
export function toggleZoom(root: LayoutNode, zoomed: string | null, paneId: string): string | null {
  if (zoomed === paneId) return null
  if (!findPane(root, paneId) || panes(root).length < 2) return null
  return paneId
}

// ---- serialization -------------------------------------------------------------------------

/**
 * Stored shape: ids dropped, panes refer to a *session* (the connection itself cannot survive),
 * so a serialized layout can be reopened later with fresh terminals.
 */
export type SerializedNode = { pane: string | null } | { split: SplitDir; sizes: number[]; children: SerializedNode[] }

export function serialize(root: LayoutNode, sessionOf: (tabId: string) => string | undefined): SerializedNode {
  if (root.type === 'pane') return { pane: root.tabId ? (sessionOf(root.tabId) ?? null) : null }
  return { split: root.dir, sizes: [...root.sizes], children: root.children.map((c) => serialize(c, sessionOf)) }
}

/**
 * Drop panes whose session no longer exists (deleted since the tab was closed), collapsing splits
 * left with one child. Empty panes stay. Returns null when no pane with a session is left.
 */
export function pruneLayout(data: SerializedNode, exists: (sessionId: string) => boolean): SerializedNode | null {
  let live = 0
  const rec = (d: SerializedNode): SerializedNode | null => {
    if ('pane' in d) {
      if (d.pane === null) return d
      if (!exists(d.pane)) return null
      live++
      return d
    }
    const kept: { c: SerializedNode; s: number }[] = []
    d.children.forEach((c, i) => {
      const m = rec(c)
      if (m) kept.push({ c: m, s: d.sizes[i] ?? 0 })
    })
    if (!kept.length) return null
    if (kept.length === 1) return kept[0]!.c
    return { split: d.split, sizes: normalizeSizes(kept.map((k) => k.s)), children: kept.map((k) => k.c) }
  }
  const out = rec(data)
  return out && live > 0 ? out : null
}

/**
 * Rebuild a tree from its serialized form, opening each session through `open` (which returns
 * the new terminal tab id). Invalid input throws; degenerate splits are collapsed.
 */
export function deserialize(data: unknown, open: (sessionId: string) => string | null): LayoutNode {
  const rec = (d: unknown): LayoutNode | null => {
    if (!d || typeof d !== 'object') throw new Error('invalid layout node')
    if ('pane' in d) {
      const s = (d as { pane: unknown }).pane
      if (s !== null && typeof s !== 'string') throw new Error('invalid pane')
      return pane(s === null ? null : open(s))
    }
    const { split, sizes, children } = d as { split?: unknown; sizes?: unknown; children?: unknown }
    if ((split !== 'row' && split !== 'column') || !Array.isArray(children) || !Array.isArray(sizes)) throw new Error('invalid split')
    const kids = children.map(rec).filter((c): c is LayoutNode => !!c)
    if (!kids.length) return null
    if (kids.length === 1) return kids[0]!
    const sz = kids.length === sizes.length ? sizes.map(Number) : kids.map(() => 1)
    return { type: 'split', id: nodeId('s'), dir: split, children: kids, sizes: normalizeSizes(sz) }
  }
  const root = rec(data)
  if (!root) throw new Error('empty layout')
  return root
}

// ---- status glyphs --------------------------------------------------------------------------

export type Glyph = 'approval' | 'auth' | 'down' | 'reconnecting' | 'config' | 'unknown' | 'bell' | 'unread' | 'connecting'

/** Highest priority first. */
export const GLYPH_PRIORITY: Glyph[] = ['approval', 'auth', 'down', 'reconnecting', 'config', 'bell', 'unread', 'unknown', 'connecting']

export interface GlyphInput {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'down'
  detail?: string
  needsApproval?: boolean
  configMode?: boolean
  /** Auto-detect could not identify the device: the AI is blocked on it. */
  platformUnknown?: boolean
  bell?: boolean
  unread?: boolean
}

/** All glyphs that apply to one terminal, highest priority first. A live, quiet session has none. */
export function glyphsFor(t: GlyphInput): Glyph[] {
  const on: Record<Glyph, boolean> = {
    approval: !!t.needsApproval,
    auth: t.state === 'down' && /authentication/i.test(t.detail ?? ''),
    down: t.state === 'down' || t.state === 'idle',
    reconnecting: t.state === 'reconnecting',
    config: !!t.configMode && t.state === 'connected',
    unknown: !!t.platformUnknown && t.state === 'connected',
    bell: !!t.bell,
    unread: !!t.unread,
    connecting: t.state === 'connecting'
  }
  const out = GLYPH_PRIORITY.filter((g) => on[g])
  // "auth failed" is the more specific "disconnected": show one, not both.
  return out.includes('auth') ? out.filter((g) => g !== 'down') : out
}

/** The glyph to show for a tab holding several terminals: the highest priority across them. */
export function topGlyph(items: GlyphInput[]): Glyph | undefined {
  let best: number | undefined
  for (const t of items) {
    const g = glyphsFor(t)[0]
    if (g === undefined) continue
    const p = GLYPH_PRIORITY.indexOf(g)
    if (best === undefined || p < best) best = p
  }
  return best === undefined ? undefined : GLYPH_PRIORITY[best]
}

/**
 * Config mode from the prompt line (and the line above, for Junos's "[edit]" banner).
 * Returns undefined when the line is not a prompt, so the caller keeps the previous state.
 */
export function detectConfigMode(line: string, above = ''): boolean | undefined {
  const l = line.trimEnd()
  if (/\(config[^)]*\)#$/.test(l)) return true
  if (/^\S+@\S+#$/.test(l) && /^\[edit\b/.test(above.trim())) return true // Junos: [edit ...] then user@host#
  if (/^[\w.@:/-]+[#>]$/.test(l)) return false
  return undefined
}

// ---- MRU ------------------------------------------------------------------------------------

/** Move `id` to the front of the MRU list, dropping ids that no longer exist. */
export function touchMru(mru: string[], id: string, existing: string[]): string[] {
  const keep = new Set(existing)
  const rest = mru.filter((x) => x !== id && keep.has(x))
  const unseen = existing.filter((x) => x !== id && !rest.includes(x))
  return [...(keep.has(id) ? [id] : []), ...rest, ...unseen]
}
