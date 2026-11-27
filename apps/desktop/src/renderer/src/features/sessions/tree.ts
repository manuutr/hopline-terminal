import { SESSION_PLATFORM_LABELS as PLATFORM_LABELS } from '@hopline/guard'
import type { Folder, Session } from '@shared/types'

/**
 * Pure helpers behind the session tree: the flat list of visible rows (which drives rendering,
 * arrow keys, range selection and ARIA levels), search matching and highlighting, selection, and
 * drag-and-drop planning. No React, no IPC: unit-tested in test/tree.test.ts.
 */

/** Selection is by entity: the same session can show in Favorites, Recent and its folder. */
export type EntityKey = `s:${string}` | `f:${string}`
export type SectionId = 'fav' | 'recent'

export interface Row {
  /** Unique per row (focus, React key): section + entity. */
  key: string
  kind: 'section' | 'folder' | 'session'
  entity: EntityKey | null
  section: SectionId | 'tree'
  /** 1-based, for aria-level. */
  level: number
  posinset: number
  setsize: number
  expanded?: boolean
  session?: Session
  folder?: Folder
  /** Section and folder rows: number of matching sessions below. */
  count?: number
  label: string
}

export const RECENT_LIMIT = 10
export const sKey = (id: string): EntityKey => `s:${id}`
export const fKey = (id: string): EntityKey => `f:${id}`
export const idOf = (k: EntityKey): string => k.slice(2)
export const isSessionKey = (k: EntityKey): boolean => k.startsWith('s:')

export const SECTION_LABEL: Record<SectionId, string> = { fav: 'Favorites', recent: 'Recent' }

// ------------------------------------------------------------------ search

export function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function fuzzyIndices(text: string, word: string): number[] {
  const indices: number[] = []
  for (const c of word) {
    const i = text.indexOf(c, (indices.at(-1) ?? -1) + 1)
    if (i < 0) return []
    indices.push(i)
  }
  return indices
}

/** Every term must appear in the name, host, a tag or the platform (id or label). */
export function matchesSession(s: Session, words: string[], tags: ReadonlySet<string> = new Set()): boolean {
  for (const t of tags) if (!s.tags.includes(t)) return false
  if (!words.length) return true
  const hay = [s.name, s.host, s.platform, PLATFORM_LABELS[s.platform] ?? '', ...s.tags].map((field) => field.toLowerCase())
  return words.every((w) => hay.some((field) => field.includes(w) || (!Object.hasOwn(PLATFORM_LABELS, w) && fuzzyIndices(field, w).length > 0)))
}

export interface Segment {
  text: string
  hit: boolean
}

/** Split `text` into plain and matching runs for <mark>. Overlapping and adjacent hits merge. */
export function highlight(text: string, words: string[]): Segment[] {
  if (!words.length || !text) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const w of words) {
    if (!lower.includes(w)) for (const i of fuzzyIndices(lower, w)) marks[i] = true
    for (let i = lower.indexOf(w); i >= 0 && w; i = lower.indexOf(w, i + 1)) marks.fill(true, i, i + w.length)
  }
  const out: Segment[] = []
  for (let i = 0; i < text.length; ) {
    let j = i
    while (j < text.length && marks[j] === marks[i]) j++
    out.push({ text: text.slice(i, j), hit: marks[i]! })
    i = j
  }
  return out
}

/** Every tag in use, most used first, then by name. */
export function allTags(sessions: Session[]): { tag: string; count: number }[] {
  const n = new Map<string, number>()
  for (const s of sessions) for (const t of s.tags) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

// ------------------------------------------------------------------ rows

export interface RowsInput {
  folders: Folder[]
  sessions: Session[]
  /** Folder ids and section ids that are collapsed. */
  collapsed: ReadonlySet<string>
  sessionOrder?: readonly string[]
  query?: string
  tags?: ReadonlySet<string>
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

/**
 * The rows the tree shows, top to bottom. Without a filter: Favorites, Recent, then folders and
 * loose sessions. With a search or tag filter: only the folder tree, pruned to matches and fully
 * expanded (the sections would only repeat the same hits).
 */
export function visibleRows({ folders, sessions, collapsed, sessionOrder = [], query = '', tags = new Set() }: RowsInput): Row[] {
  const words = terms(query)
  const filtering = words.length > 0 || tags.size > 0
  const hits = filtering ? sessions.filter((s) => matchesSession(s, words, tags)) : sessions
  const rows: Row[] = []
  const folderIds = new Set(folders.map((f) => f.id))

  const pushSet = (items: Omit<Row, 'posinset' | 'setsize'>[]) => {
    items.forEach((r, i) => rows.push({ ...r, posinset: i + 1, setsize: items.length }))
  }

  // Top level siblings: section headers, root folders and loose sessions share one set for aria-posinset.
  const top: { row: Omit<Row, 'posinset' | 'setsize'>; children: () => void }[] = []

  if (!filtering) {
    const sections: [SectionId, Session[]][] = [
      ['fav', sessions.filter((s) => s.favorite).sort(byName)],
      [
        'recent',
        sessions
          .filter((s) => s.lastConnectedAt)
          .sort((a, b) => b.lastConnectedAt! - a.lastConnectedAt!)
          .slice(0, RECENT_LIMIT)
      ]
    ]
    for (const [id, list] of sections) {
      if (!list.length) continue
      const expanded = !collapsed.has(id)
      top.push({
        row: { key: `sec:${id}`, kind: 'section', entity: null, section: id, level: 1, expanded, count: list.length, label: SECTION_LABEL[id] },
        children: () => {
          if (!expanded) return
          pushSet(list.map((s) => ({ key: `${id}:s:${s.id}`, kind: 'session', entity: sKey(s.id), section: id, level: 2, session: s, label: s.name })))
        }
      })
    }
  }

  // Count matches per folder subtree, so filtered views can drop empty folders.
  const kids = new Map<string | null, Folder[]>()
  for (const f of folders) {
    const p = f.parentId && folderIds.has(f.parentId) ? f.parentId : null
    kids.set(p, [...(kids.get(p) ?? []), f])
  }
  const inFolder = new Map<string | null, Session[]>()
  for (const s of hits) {
    const f = s.folderId && folderIds.has(s.folderId) ? s.folderId : null
    inFolder.set(f, [...(inFolder.get(f) ?? []), s])
  }
  const rank = new Map(sessionOrder.map((id, index) => [id, index]))
  for (const list of inFolder.values()) list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || byName(a, b))
  const total = new Map<string, number>()
  const count = (f: Folder, seen = new Set<string>()): number => {
    if (total.has(f.id)) return total.get(f.id)!
    if (seen.has(f.id)) return 0
    seen.add(f.id)
    const n = (inFolder.get(f.id)?.length ?? 0) + (kids.get(f.id) ?? []).reduce((a, k) => a + count(k, seen), 0)
    total.set(f.id, n)
    return n
  }

  const level = (parent: string | null, depth: number, seen: Set<string>): { row: Omit<Row, 'posinset' | 'setsize'>; children: () => void }[] => {
    const out: { row: Omit<Row, 'posinset' | 'setsize'>; children: () => void }[] = []
    for (const f of kids.get(parent) ?? []) {
      if (seen.has(f.id)) continue
      const n = count(f)
      if (filtering && n === 0) continue
      const expanded = filtering || !collapsed.has(f.id)
      const next = new Set(seen).add(f.id)
      out.push({
        row: { key: `tree:f:${f.id}`, kind: 'folder', entity: fKey(f.id), section: 'tree', level: depth, expanded, folder: f, count: n, label: f.name },
        children: () => expanded && emit(level(f.id, depth + 1, next))
      })
    }
    for (const s of inFolder.get(parent) ?? []) {
      out.push({ row: { key: `tree:s:${s.id}`, kind: 'session', entity: sKey(s.id), section: 'tree', level: depth, session: s, label: s.name }, children: () => {} })
    }
    return out
  }
  const emit = (items: { row: Omit<Row, 'posinset' | 'setsize'>; children: () => void }[]) => {
    items.forEach(({ row, children }, i) => {
      rows.push({ ...row, posinset: i + 1, setsize: items.length })
      children()
    })
  }
  emit([...top, ...level(null, 1, new Set())])
  return rows
}

/** Visible entities in row order, each once (first appearance wins). */
export function entityOrder(rows: Row[]): EntityKey[] {
  const seen = new Set<EntityKey>()
  for (const r of rows) if (r.entity) seen.add(r.entity)
  return [...seen]
}

// ------------------------------------------------------------------ selection

/** Shift-click / Shift+arrow: everything between anchor and target, in visible order. */
export function rangeSelect(order: EntityKey[], anchor: EntityKey | null, target: EntityKey): EntityKey[] {
  const a = anchor ? order.indexOf(anchor) : -1
  const b = order.indexOf(target)
  if (b < 0) return []
  if (a < 0) return [target]
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return order.slice(lo, hi + 1)
}

/** Ctrl/Cmd-click and Space: add or remove one entity. */
export function toggleSelect(sel: readonly EntityKey[], key: EntityKey): EntityKey[] {
  return sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key]
}

/** The row index arrow keys land on: clamped, never on nothing. */
export function stepFocus(rows: Row[], current: string | null, delta: number): number {
  if (!rows.length) return -1
  const i = current ? rows.findIndex((r) => r.key === current) : -1
  if (i < 0) return delta > 0 ? 0 : rows.length - 1
  return Math.max(0, Math.min(rows.length - 1, i + delta))
}

/** ArrowLeft on a child: its parent row (folder or section). */
export function parentRow(rows: Row[], index: number): number {
  const r = rows[index]
  if (!r || r.level <= 1) return -1
  for (let i = index - 1; i >= 0; i--) if (rows[i]!.level < r.level) return i
  return -1
}

// ------------------------------------------------------------------ drag and drop

export type DropZone = 'before' | 'inside' | 'after'

/** Where a drop on `row` puts things: a folder id, null for the top level, undefined for "not here". */
export function dropFolder(row: Row | null, zone: DropZone): string | null | undefined {
  if (!row) return null
  if (row.section !== 'tree') return undefined
  if (row.kind === 'folder') return zone === 'inside' ? row.folder!.id : (row.folder!.parentId ?? null)
  if (row.kind === 'session') return row.session!.folderId ?? null
  return undefined
}

/** Folder rows split into before / inside / after by pointer height; session rows have no inside. */
export function zoneAt(kind: Row['kind'], offsetY: number, height: number): DropZone {
  const f = height > 0 ? offsetY / height : 0.5
  if (kind === 'folder') return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside'
  return f < 0.5 ? 'before' : 'after'
}

export type MovePlan = { sessionIds: string[]; folderIds: string[] }

/** Ancestors of a folder, nearest first. */
function ancestors(folders: Folder[], id: string | null): string[] {
  const out: string[] = []
  const byId = new Map(folders.map((f) => [f.id, f]))
  for (let cur = id ? byId.get(id) : undefined; cur && out.length < 64; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur.id)
  return out
}

/**
 * What a drop of `dragged` into `target` actually moves. Items whose folder is also dragged ride
 * along with it; items already there are skipped. A folder into itself or its subtree is refused.
 */
export function planMove(folders: Folder[], sessions: Session[], dragged: EntityKey[], target: string | null): MovePlan | { error: string } | null {
  const draggedFolders = new Set(dragged.filter((k) => !isSessionKey(k)).map(idOf))
  const targetChain = target === null ? [] : ancestors(folders, target)
  for (const f of draggedFolders) if (targetChain.includes(f)) return { error: 'A folder cannot move into itself' }
  const coveredBy = (folderId: string | null) => ancestors(folders, folderId).some((a) => draggedFolders.has(a))
  const folderById = new Map(folders.map((f) => [f.id, f]))
  const folderIds = [...draggedFolders].filter((id) => {
    const f = folderById.get(id)
    return f && !coveredBy(f.parentId) && (f.parentId ?? null) !== target
  })
  const sessionIds = dragged
    .filter(isSessionKey)
    .map(idOf)
    .filter((id) => {
      const s = sessions.find((x) => x.id === id)
      return s && !coveredBy(s.folderId) && (s.folderId ?? null) !== target
    })
  return sessionIds.length || folderIds.length ? { sessionIds, folderIds } : null
}

// ------------------------------------------------------------------ colors

/** Tag chips get a stable hue from their name: the same tag always looks the same. */
export const TAG_HUES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export function tagHue(tag: string): (typeof TAG_HUES)[number] {
  // FNV-1a: spreads short, similar names ("core", "prod", "edge") better than a polynomial hash.
  let h = 0x811c9dc5
  for (const c of tag) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0
  return TAG_HUES[h % TAG_HUES.length]!
}
