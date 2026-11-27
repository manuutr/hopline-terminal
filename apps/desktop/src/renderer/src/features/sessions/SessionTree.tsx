import { SESSION_PLATFORM_LABELS as PLATFORM_LABELS } from '@hopline/guard'
import { ContextMenu as CM } from 'radix-ui'
import { MenuCheck, MenuChevron, MenuShortcut, menuContent, menuDanger, menuItem, menuSeparator } from '../../design/Menu'
import { ChevronRight, FolderPlus, Import, Plus, Search, Zap } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../lib/notify'
import { SESSION_COLORS, type Session, type SessionColor } from '@shared/types'
import { Button, cn, EmptyState, Loading, Input, PanelHeader, Tooltip } from '../../design'
import { useListMotion } from '../../design/useListMotion'
import { FocusFrame } from '../../design/FocusFrame'
import { elapsed } from '../terminal/liveness'
import { SessionStatus } from '../layout/StatusGlyph'
import { openImport } from '../import/store'
import { backupNow, openBackups } from '../backups/store'
import { useMulti } from '../multi/store'
import { useFleet } from '../fleet/store'
import { askConfirm } from '../../lib/confirm'
import { modalOpen } from '../../lib/keys'
import { notifyError, openInSplit, openSession } from '../../lib/connect'
import { askText } from '../../lib/prompt'
import { PLATFORM_SHORT } from '../../lib/platforms'
import { useUi } from '../../store'
import { COLOR_CLASS } from './colors'
import {
  allTags,
  highlight,
  dropFolder,
  entityOrder,
  idOf,
  isSessionKey,
  parentRow,
  planMove,
  rangeSelect,
  stepFocus,
  tagHue,
  terms,
  toggleSelect,
  visibleRows,
  zoneAt,
  type DropZone,
  type EntityKey,
  type Row,
  type Segment
} from './tree'
import { useShortcutMap } from '../../lib/actions'
import { Checklist } from '../onboarding/Checklist'
import { openOverrides } from '../overrides/OverridesDialog'


/**
 * Secondary text for a search hit whose name doesn't explain the match: the host, else the
 * platform (label, or fully marked when only the id matched, e.g. "iosxe").
 */
function matchHint(s: Session, words: string[]): { parts: Segment[]; mono: boolean } | null {
  const rest = words.filter((w) => !s.name.toLowerCase().includes(w) && !s.tags.some((t) => t.includes(w)))
  if (!rest.length) return null
  if (rest.some((w) => s.host.toLowerCase().includes(w))) return { parts: highlight(s.host, words), mono: true }
  const label = PLATFORM_LABELS[s.platform] ?? s.platform
  if (rest.some((w) => label.toLowerCase().includes(w))) return { parts: highlight(label, words), mono: false }
  if (rest.some((w) => s.platform.includes(w))) return { parts: [{ text: label, hit: true }], mono: false }
  return null
}

const DRAG_THRESHOLD = 4
const INDENT = 14

const sep = menuSeparator

function Marked({ parts, className }: { parts: Segment[]; className?: string }): React.JSX.Element {
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[2px] bg-accent-soft text-fg [box-decoration-break:clone]">
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </span>
  )
}

/**
 * A tag. In rows it is neutral and never truncated (a cut chip carries nothing): rows show chips
 * only while they fit. As a filter it is neutral at full opacity, and takes its hue only while
 * pressed, so "off" never reads as "disabled".
 */
export function TagChip({ tag, active, words, onClick }: { tag: string; active?: boolean; words?: string[]; onClick?: () => void }): React.JSX.Element {
  const body = words?.length ? <Marked parts={highlight(tag, words)} /> : tag
  const cls = 'inline-flex shrink-0 items-center whitespace-nowrap rounded-[3px] text-2xs font-medium leading-none'
  if (!onClick) return <span className={cn(cls, 'h-4 bg-active px-1 text-fg-muted')}>{body}</span>
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        cls,
        'h-5 cursor-default px-1.5 ring-1 ring-inset transition-[background-color,color,box-shadow] duration-[var(--dur-fast)]',
        active ? cn(COLOR_CLASS[tagHue(tag)].chip, 'ring-current') : 'bg-transparent text-fg-muted ring-line-strong hover:bg-hover hover:text-fg'
      )}
    >
      {body}
    </button>
  )
}

interface DropView {
  /** Row the indicator is drawn on; null = the empty area (top level). */
  key: string | null
  zone: DropZone
  valid: boolean
  label: string
}

/**
 * The session sidebar: Favorites, Recent and the folder tree as one ARIA tree. Flat rows (not
 * nested groups) so every treeitem's accessible name is just its own label, with aria-level /
 * posinset / setsize describing the hierarchy.
 */
export function SessionTree(): React.JSX.Element {
  const sc = useShortcutMap()
  const folders = useUi((s) => s.folders)
  const sessions = useUi((s) => s.sessions)
  const loaded = useUi((s) => s.loaded)
  const loadError = useUi((s) => s.loadError)
  const tabs = useUi((s) => s.tabs)
  const activeId = useUi((s) => s.tabs.find((tab) => tab.tabId === s.activeTabId)?.sessionId)
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => {
    try {
      const ids: unknown = JSON.parse(localStorage.getItem('hopline.sessionOrder') ?? '[]')
      return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
    } catch { return [] }
  })
  const orderRef = useRef(sessionOrder)
  const reorderSessions = (moved: string[], target: Session, after: boolean) => {
    const { sessions: all, folders } = useUi.getState()
    const movedIds = new Set(moved)
    const siblings = visibleRows({ folders, sessions: all, collapsed: new Set(), sessionOrder: orderRef.current })
      .filter((r) => r.section === 'tree' && r.session && r.session.folderId === target.folderId && !movedIds.has(r.session.id))
      .map((r) => r.session!.id)
    const index = siblings.indexOf(target.id)
    if (index < 0) return
    siblings.splice(index + Number(after), 0, ...moved)
    const live = new Set(all.map((s) => s.id))
    const placed = new Set(siblings)
    const next = [...orderRef.current.filter((id) => !placed.has(id) && live.has(id)), ...siblings]
    setSessionOrder(next)
    try { localStorage.setItem('hopline.sessionOrder', JSON.stringify(next)) } catch { /* Order still applies in this window. */ }
  }
  const [q, setQ] = useState('')
  const [tagFilter, setTagFilter] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<EntityKey[]>([])
  const anchor = useRef<EntityKey | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const renamingRef = useRef<string | null>(null)
  const [drop, setDrop] = useState<DropView | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; n: number; label: string } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ row: Row; x0: number; y0: number; items: EntityKey[]; started: boolean } | null>(null)
  const suppressClick = useRef(false)

  const words = useMemo(() => terms(q), [q])
  const rowsRef = useRef<Row[]>([])
  const rows = useMemo(() => visibleRows({ folders, sessions, collapsed, query: q, tags: tagFilter, sessionOrder }), [folders, sessions, collapsed, q, tagFilter, sessionOrder])
  const rowKeys = useMemo(() => rows.map((r) => r.key).join('|'), [rows])
  useListMotion(treeRef, 'data-row-key', rowKeys)
  useLayoutEffect(() => {
    orderRef.current = sessionOrder
    renamingRef.current = renaming
    rowsRef.current = rows
  }, [sessionOrder, renaming, rows])
  const order = useMemo(() => entityOrder(rows), [rows])
  const tagList = useMemo(() => allTags(sessions), [sessions])
  const selSet = useMemo(() => new Set(selected), [selected])
  const filtering = words.length > 0 || tagFilter.size > 0
  const matchCount = filtering ? new Set(rows.filter((r) => r.kind === 'session').map((r) => r.session!.id)).size : 0

  // Drop selections that vanished (deleted, filtered out).
  useEffect(() => {
    const visible = new Set(order)
    if (selected.some((k) => !visible.has(k))) setSelected((sel) => sel.filter((k) => visible.has(k)))
  }, [order, selected])
  // A rename whose row is gone (filtered out, folder collapsed, deleted) ends; otherwise tree keys stay dead.
  useEffect(() => {
    if (renaming && !rows.some((r) => r.key === renaming)) setRenaming(null)
  }, [rows, renaming])
  // Tag filters for tags nobody uses any more.
  useEffect(() => {
    const live = new Set(tagList.map((t) => t.tag))
    if ([...tagFilter].some((t) => !live.has(t))) setTagFilter(new Set([...tagFilter].filter((t) => live.has(t))))
  }, [tagList, tagFilter])

  /**
   * Move DOM focus to a row. Synchronously when the row exists (arrow keys), so the next key lands
   * on it; a frame later only for a row that has yet to render, and never over a rename input.
   */
  const focusRow = (key: string | null) => {
    setFocusKey(key)
    if (!key) return
    const find = () => treeRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)
    const el = find()
    if (el) return el.focus()
    requestAnimationFrame(() => {
      if (!renamingRef.current) find()?.focus()
    })
  }
  const tabbable = rows.some((r) => r.key === focusKey) ? focusKey : (rows[0]?.key ?? null)

  const reload = () => useUi.getState().load()
  const edit = (session?: Partial<Session>) => useUi.getState().set({ editing: { open: true, session } })
  const sessionOf = (k: EntityKey) => (isSessionKey(k) ? sessions.find((s) => s.id === idOf(k)) : undefined)
  const selectedSessions = () => selected.map(sessionOf).filter((s): s is Session => !!s)
  const toggleOpen = (id: string) => {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setCollapsed(next)
  }
  const rowId = (r: Row) => (r.kind === 'section' ? r.section : r.kind === 'folder' ? r.folder!.id : '')

  /** Act on the row's selection when the row is part of it, otherwise on the row alone. */
  const targetsOf = (r: Row): EntityKey[] => (r.entity && selSet.has(r.entity) ? selected : r.entity ? [r.entity] : [])

  // ---------------------------------------------------------------- actions
  const newFolder = async (parentId: string | null) => {
    const name = await askText('New folder')
    if (!name?.trim()) return
    await window.hopline.sessions.saveFolder({ name: name.trim(), parentId })
    await reload()
  }

  /** More than a handful at once (Enter on a big selection) is asked first. */
  const connectAll = async (list: Session[]) => {
    if (list.length > 5 && !(await askConfirm(`Connect to ${list.length} sessions?`, `This opens ${list.length} tabs and logs in to every selected device.`, 'Connect all'))) return
    list.forEach((s) => openSession(s))
  }

  const duplicate = async (list: Session[]) => {
    try {
      const copies: Session[] = []
      for (const s of list) {
        const { id: _id, lastConnectedAt: _l, ephemeral: _e, ...rest } = s
        copies.push(await window.hopline.sessions.save({ ...rest, name: `${s.name} copy`, favorite: false }))
      }
      await reload()
      const keys = copies.map((c) => `s:${c.id}` as EntityKey)
      setSelected(keys)
      anchor.current = keys[0] ?? null
      if (copies.length === 1) {
        const c = copies[0]!
        // Open the folders above the copy so its row exists to rename in place.
        const open = new Set<string>()
        for (let id = c.folderId, n = 0; id && n < 64; n++, id = folders.find((f) => f.id === id)?.parentId ?? null) open.add(id)
        setCollapsed((cur) => new Set([...cur].filter((x) => !open.has(x))))
        setRenaming(`tree:s:${c.id}`)
        setFocusKey(`tree:s:${c.id}`)
      }
    } catch (e) {
      notifyError('Duplicate failed', e)
    }
  }

  const removeItems = async (keys: EntityKey[]) => {
    const ss = keys.filter(isSessionKey).map(sessionOf).filter((s): s is Session => !!s)
    const fs = keys.filter((k) => !isSessionKey(k)).map((k) => folders.find((f) => f.id === idOf(k))).filter((f) => !!f)
    if (!ss.length && !fs.length) return
    const what =
      ss.length + fs.length === 1
        ? ss[0]
          ? `session "${ss[0].name}"`
          : `folder "${fs[0]!.name}"`
        : [ss.length && `${ss.length} session${ss.length > 1 ? 's' : ''}`, fs.length && `${fs.length} folder${fs.length > 1 ? 's' : ''}`].filter(Boolean).join(' and ')
    const open = ss.filter((s) => tabs.some((t) => t.sessionId === s.id)).length
    // Sessions that hop through one being deleted (and aren't deleted themselves) lose their path.
    const gone = new Set(ss.map((s) => s.id))
    const dependents = sessions.filter((s) => !gone.has(s.id) && s.options.ssh?.jump?.some((j) => gone.has(j)))
    const body = [
      dependents.length
        ? `Used as a jump host by ${dependents
            .slice(0, 5)
            .map((s) => `"${s.name}"`)
            .join(', ')}${dependents.length > 5 ? ` and ${dependents.length - 5} more` : ''}: ${dependents.length === 1 ? 'it' : 'they'} will no longer connect through it.`
        : '',
      fs.length ? 'Sessions inside a deleted folder move up a level.' : '',
      open ? `${open === 1 ? 'An open tab keeps' : `${open} open tabs keep`} running until closed.` : '',
      ss.length ? 'Saved terminal history for these sessions is deleted too.' : ''
    ]
      .filter(Boolean)
      .join(' ')
    if (!(await askConfirm(`Delete ${what}?`, body || 'This cannot be undone.', 'Delete'))) return
    try {
      // One call, one transaction: all of it is deleted or none.
      await window.hopline.sessions.removeMany({ sessionIds: ss.map((s) => s.id), folderIds: fs.map((f) => f.id) })
      await reload()
      setSelected([])
    } catch (e) {
      notifyError('Delete failed', e)
    }
  }

  const bulk = async (keys: EntityKey[], patch: Parameters<typeof window.hopline.sessions.bulkUpdate>[1], done?: string) => {
    const ids = keys.filter(isSessionKey).map(idOf)
    if (!ids.length) return
    try {
      await window.hopline.sessions.bulkUpdate(ids, patch)
      await reload()
      if (done) toast(done)
    } catch (e) {
      notifyError('Update failed', e)
    }
  }

  const editTags = async (list: Session[]) => {
    const current = list.length === 1 ? list[0]!.tags.join(', ') : ''
    const raw = await askText(list.length === 1 ? `Tags for ${list[0]!.name}` : `Add tags to ${list.length} sessions`, current, {
      description: 'Comma or space separated, e.g. core, prod, dc1'
    })
    if (raw === null) return
    const tags = raw.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (list.length === 1) {
      const s = list[0]!
      await bulk([`s:${s.id}`], { addTags: tags, removeTags: s.tags.filter((t) => !tags.includes(t)) })
    } else await bulk(list.map((s) => `s:${s.id}` as EntityKey), { addTags: tags }, `Tagged ${list.length} sessions`)
  }

  const commitRename = async (r: Row, value: string) => {
    renamingRef.current = null
    setRenaming(null)
    const name = value.trim()
    focusRow(r.key)
    if (!name || name === r.label) return
    try {
      if (r.kind === 'session') {
        const { id, lastConnectedAt: _l, ephemeral: _e, ...rest } = r.session!
        await window.hopline.sessions.save({ ...rest, id, name })
      } else if (r.kind === 'folder') await window.hopline.sessions.saveFolder({ id: r.folder!.id, name, parentId: r.folder!.parentId })
      await reload()
    } catch (e) {
      notifyError('Rename failed', e)
    }
  }

  // ---------------------------------------------------------------- selection
  const selectRow = (r: Row, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    setFocusKey(r.key)
    if (!r.entity) return
    if (e.shiftKey) setSelected(rangeSelect(order, anchor.current ?? r.entity, r.entity))
    else if (e.ctrlKey || e.metaKey) {
      setSelected(toggleSelect(selected, r.entity))
      anchor.current = r.entity
    } else {
      setSelected([r.entity])
      anchor.current = r.entity
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Context menus are portalled but React still bubbles their keys here: only handle the tree's own.
    if (!e.currentTarget.contains(e.target as Node)) return
    if (renaming) return
    const i = rows.findIndex((r) => r.key === tabbable)
    const r = rows[i]
    if (!r) return
    if (r.section === 'tree' && r.session && e.altKey && e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault()
      const down = e.key === 'ArrowDown'
      const next = rows[i + (down ? 1 : -1)]?.session
      if (next && next.folderId === r.session.folderId) reorderSessions([r.session.id], next, down)
      return
    }
    const go = (j: number, extend = e.shiftKey) => {
      const t = rows[j]
      if (!t) return
      focusRow(t.key)
      if (!t.entity) return
      if (extend) setSelected(rangeSelect(order, anchor.current ?? r.entity ?? t.entity, t.entity))
      else if (!(e.ctrlKey || e.metaKey)) {
        setSelected([t.entity])
        anchor.current = t.entity
      }
    }
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        go(stepFocus(rows, r.key, 1))
        break
      case 'ArrowUp':
        go(stepFocus(rows, r.key, -1))
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (r.kind !== 'session' && !r.expanded) toggleOpen(rowId(r))
        else if (r.kind !== 'session' && rows[i + 1]?.level === r.level + 1) go(i + 1, false)
        break
      case 'ArrowLeft':
        if (r.kind !== 'session' && r.expanded && !filtering) toggleOpen(rowId(r))
        else {
          const p = parentRow(rows, i)
          if (p >= 0) go(p, false)
        }
        break
      case 'Enter': {
        if (r.kind === 'session' && e.altKey) openInSplit(r.session!)
        else if (r.kind === 'session') {
          const list = r.entity && selSet.has(r.entity) && selected.length > 1 ? selectedSessions() : [r.session!]
          void connectAll(list)
        } else if (!filtering) toggleOpen(rowId(r))
        break
      }
      case ' ':
        if (r.entity) {
          setSelected(toggleSelect(selected, r.entity))
          anchor.current = r.entity
        }
        break
      case 'F2':
        if (r.kind !== 'section') setRenaming(r.key)
        break
      case 'Delete':
        void removeItems(targetsOf(r))
        break
      case 'Escape':
        if (selected.length) setSelected([])
        else handled = false
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // ---------------------------------------------------------------- drag and drop (pointer based, like the tab bar)
  useEffect(() => {
    const targetAt = (x: number, y: number): { row: Row | null; zone: DropZone; outside: boolean } => {
      const tree = treeRef.current
      const box = areaRef.current?.getBoundingClientRect()
      if (!tree || !box || x < box.left || x > box.right || y < box.top || y > box.bottom) return { row: null, zone: 'inside', outside: true }
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-row-key]')
      const row = el && tree.contains(el) ? (rowsRef.current.find((r) => r.key === el.dataset['rowKey']) ?? null) : null
      if (!row || !el) return { row: null, zone: 'inside', outside: false }
      const rect = el.getBoundingClientRect()
      return { row, zone: zoneAt(row.kind, y - rect.top, rect.height), outside: false }
    }
    const evaluate = (d: NonNullable<typeof drag.current>, x: number, y: number) => {
      const { row, zone, outside } = targetAt(x, y)
      if (outside) return null
      const folderId = dropFolder(row, zone)
      const { folders: fs, sessions: ss } = useUi.getState()
      const plan = folderId === undefined ? null : planMove(fs, ss, d.items, folderId)
      const name = folderId ? (fs.find((f) => f.id === folderId)?.name ?? '') : 'top level'
      const reorder = row?.kind === 'session' && row.section === 'tree' && !d.items.includes(row.entity!) && d.items.every(isSessionKey)
      return { row, zone, folderId, plan, name, reorder }
    }
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.started && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return
      d.started = true
      const r = evaluate(d, e.clientX, e.clientY)
      const first = d.items.length === 1 ? (d.row.label ?? '') : `${d.items.length} items`
      setGhost({ x: e.clientX, y: e.clientY, n: d.items.length, label: first })
      if (!r) return setDrop(null)
      const valid = r.reorder || (!!r.plan && !('error' in r.plan))
      setDrop({ key: r.row?.key ?? null, zone: r.zone, valid, label: r.reorder ? `Place ${r.zone} ${r.row!.label}` : valid ? `Move to ${r.name}` : r.plan && 'error' in r.plan ? r.plan.error : '' })
    }
    const up = (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      if (!d?.started) return
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
      setDrop(null)
      setGhost(null)
      const r = evaluate(d, e.clientX, e.clientY)
      if (!r) return
      const reorder = () => { if (r.reorder && r.row?.session) reorderSessions(d.items.map(idOf), r.row.session, r.zone === 'after') }
      if (!r.plan) return reorder()
      if ('error' in r.plan) return void toast.error(r.plan.error)
      const plan = r.plan
      const n = plan.sessionIds.length + plan.folderIds.length
      window.hopline.sessions
        .moveMany(plan, r.folderId ?? null)
        .then(async () => {
          await reload()
          reorder()
          if (r.folderId) setCollapsed((c) => new Set([...c].filter((x) => x !== r.folderId)))
          toast(`Moved ${n === 1 ? (d.items.length === 1 ? d.row.label : '1 item') : `${n} items`} to ${r.name}`)
        })
        .catch((err) => notifyError('Move failed', err))
    }
    const cancel = () => {
      drag.current = null
      setDrop(null)
      setGhost(null)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && drag.current?.started && cancel()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPointerDown = (e: React.PointerEvent, r: Row) => {
    if (e.button !== 0 || renaming === r.key || r.kind === 'section' || !r.entity) return
    drag.current = { row: r, x0: e.clientX, y0: e.clientY, items: targetsOf(r), started: false }
  }

  // ---------------------------------------------------------------- menus
  /**
   * Radix would refocus the row when a menu closes, which steals focus from an inline rename that
   * just mounted. A second context menu or a dialog can also take focus before the next frame.
   */
  const afterMenu = (r: Row) => (e: Event) => {
    e.preventDefault()
    requestAnimationFrame(() => {
      if (renamingRef.current || modalOpen() || document.querySelector('[role="menu"][data-state="open"]')) return
      treeRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(r.key)}"]`)?.focus()
    })
  }
  const ColorMenu = ({ keys, current }: { keys: EntityKey[]; current: SessionColor | null | undefined }) => (
    <CM.Sub>
      <CM.SubTrigger className={menuItem}>
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span className={cn('size-2.5 rounded-full', current ? COLOR_CLASS[current].bar : 'border border-line-strong')} />
        </span>
        <span className="flex-1">Color</span>
        <MenuChevron />
      </CM.SubTrigger>
      <CM.Portal>
        <CM.SubContent className={menuContent} sideOffset={4}>
          {SESSION_COLORS.map((c) => (
            <CM.Item key={c} className={menuItem} onSelect={() => void bulk(keys, { color: c })}>
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <span className={cn('size-2.5 rounded-full', COLOR_CLASS[c].bar)} />
              </span>
              <span className="flex-1">{COLOR_CLASS[c].label}</span>
              <MenuCheck on={current === c} />
            </CM.Item>
          ))}
          <CM.Separator className={sep} />
          <CM.Item className={menuItem} onSelect={() => void bulk(keys, { color: null })}>
            No color
          </CM.Item>
        </CM.SubContent>
      </CM.Portal>
    </CM.Sub>
  )

  const sessionMenu = (r: Row) => {
    const keys = targetsOf(r)
    const list = keys.map(sessionOf).filter((s): s is Session => !!s)
    const folderKeys = keys.filter((k) => !isSessionKey(k))
    const many = keys.length > 1
    const s = r.session!
    const allFav = list.every((x) => x.favorite)
    return (
      <CM.Content className={menuContent} onCloseAutoFocus={afterMenu(r)}>
        <CM.Item className={menuItem} onSelect={() => void connectAll(many ? list : [s])}>
          <span className="flex-1">{many ? `Connect ${list.length} sessions` : 'Connect'}</span>
          <MenuShortcut keys="Enter" />
        </CM.Item>
        {!many && (
          <CM.Item className={menuItem} onSelect={() => openInSplit(s)}>
            <span className="flex-1">Connect in split</span>
            <MenuShortcut keys="Alt+Enter" />
          </CM.Item>
        )}
        <CM.Separator className={sep} />
        {/* Multi-device: the selected sessions, plus any selected folders. */}
        <CM.Item className={menuItem} onSelect={() => useMulti.getState().show('run', { sessions: list.map((x) => x.id), folders: folderKeys.map(idOf) })}>
          {many ? `Run on ${keys.length} selected…` : 'Run a show command…'}
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => useMulti.getState().show('send', { sessions: list.map((x) => x.id), folders: folderKeys.map(idOf) })}>
          {many ? `Send to ${keys.length} selected…` : 'Send commands…'}
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => useFleet.getState().show({ sessions: list.map((x) => x.id), folders: folderKeys.map(idOf) })}>
          Investigate across devices…
        </CM.Item>
        <CM.Separator className={sep} />
        <CM.Item className={menuItem} disabled={!list.length} onSelect={() => void backupNow(list.map((x) => x.id))}>
          {many ? `Back up ${list.length} configs` : 'Back up config'}
        </CM.Item>
        {!many && (
          <CM.Item className={menuItem} onSelect={() => openBackups(s.id)}>
            Config history…
          </CM.Item>
        )}
        <CM.Separator className={sep} />
        {many ? (
          <CM.Item className={menuItem} disabled={!list.length} onSelect={() => useUi.getState().set({ bulkEdit: list.map((x) => x.id) })}>
            Edit {list.length} sessions…
          </CM.Item>
        ) : (
          <>
            <CM.Item className={menuItem} onSelect={() => edit(s)}>
              Edit…
            </CM.Item>
            <CM.Item className={menuItem} onSelect={() => setRenaming(r.key)}>
              <span className="flex-1">Rename</span>
              <MenuShortcut keys="F2" />
            </CM.Item>
          </>
        )}
        {!many && (
          <CM.Item className={menuItem} onSelect={() => openOverrides('session', s.id)}>
            Overrides…
          </CM.Item>
        )}
        <CM.Item className={menuItem} disabled={!list.length} onSelect={() => void duplicate(list)}>
          {many ? `Duplicate ${list.length}` : 'Duplicate'}
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => void bulk(keys, { favorite: !allFav })}>
          {allFav ? 'Remove from favorites' : 'Add to favorites'}
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => void editTags(list)}>
          {many ? 'Add tags…' : 'Tags…'}
        </CM.Item>
        <ColorMenu keys={keys} current={many ? undefined : s.color} />
        <CM.Separator className={sep} />
        <CM.Item className={cn(menuItem, menuDanger)} onSelect={() => void removeItems(keys)}>
          <span className="flex-1">{many ? `Delete ${keys.length} items…` : 'Delete…'}</span>
          <MenuShortcut keys="Delete" />
        </CM.Item>
        {folderKeys.length > 0 && <CM.Label className="pl-7 pr-2 pt-1 text-xs text-fg-subtle">Includes {folderKeys.length} folder{folderKeys.length > 1 ? 's' : ''}</CM.Label>}
      </CM.Content>
    )
  }

  /** Sessions in the selected folders (with their subfolders) and selected sessions, deduplicated. */
  const folderSessions = (keys: EntityKey[]): string[] => {
    const { folders, sessions } = useUi.getState()
    const inside = new Set(keys.filter((k) => !isSessionKey(k)).map(idOf))
    for (let grew = true; grew; ) {
      grew = false
      for (const f of folders)
        if (f.parentId && inside.has(f.parentId) && !inside.has(f.id)) {
          inside.add(f.id)
          grew = true
        }
    }
    const ids = new Set(keys.filter(isSessionKey).map(idOf))
    for (const x of sessions) if (x.folderId && inside.has(x.folderId)) ids.add(x.id)
    return [...ids]
  }

  const folderMenu = (r: Row) => {
    const f = r.folder!
    const keys = targetsOf(r)
    const many = keys.length > 1
    return (
      <CM.Content className={menuContent} onCloseAutoFocus={afterMenu(r)}>
        <CM.Item className={menuItem} onSelect={() => edit({ folderId: f.id })}>
          New session here…
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => void newFolder(f.id)}>
          New subfolder…
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => useMulti.getState().show('run', { folders: keys.filter((k) => !isSessionKey(k)).map(idOf), sessions: keys.filter(isSessionKey).map(idOf) })}>
          {many ? `Run on ${keys.length} selected…` : 'Run on this folder…'}
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => useMulti.getState().show('send', { folders: keys.filter((k) => !isSessionKey(k)).map(idOf), sessions: keys.filter(isSessionKey).map(idOf) })}>
          {many ? `Send to ${keys.length} selected…` : 'Send to this folder…'}
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => useFleet.getState().show({ folders: keys.filter((k) => !isSessionKey(k)).map(idOf), sessions: keys.filter(isSessionKey).map(idOf) })}>
          Investigate across devices…
        </CM.Item>
        <CM.Separator className={sep} />
        <CM.Item className={menuItem} disabled={!folderSessions(keys).length} onSelect={() => void backupNow(folderSessions(keys))}>
          {many ? `Back up ${folderSessions(keys).length} configs` : 'Back up folder'}
        </CM.Item>
        {!many && (
          <CM.Item className={menuItem} onSelect={() => openBackups(null, 'schedules', { kind: 'folder', target: f.id })}>
            Schedule backups…
          </CM.Item>
        )}
        <CM.Separator className={sep} />
        <CM.Item className={menuItem} onSelect={() => openImport({ targetFolderId: f.id })}>
          Import sessions here…
        </CM.Item>
        <CM.Item className={menuItem} onSelect={() => setRenaming(r.key)}>
          <span className="flex-1">Rename</span>
          <MenuShortcut keys="F2" />
        </CM.Item>
        {!many && (
          <CM.Item className={menuItem} onSelect={() => openOverrides('folder', f.id)}>
            Overrides for this folder…
          </CM.Item>
        )}
        <CM.Separator className={sep} />
        <CM.Item className={cn(menuItem, menuDanger)} onSelect={() => void removeItems(keys)}>
          {many ? `Delete ${keys.length} items…` : 'Delete folder…'}
        </CM.Item>
      </CM.Content>
    )
  }

  // ---------------------------------------------------------------- rows
  const focusEntity = rows.find((x) => x.key === focusKey)?.entity
  const renderRow = (r: Row) => {
    const isSel = !!r.entity && selSet.has(r.entity)
    // The same session in Recent/Favorites and in its folder: only the row you are on gets the full
    // selection colour, its twin a quieter tint (P2-8).
    const twin = isSel && r.key !== focusKey && focusEntity === r.entity
    const pad = 6 + (r.level - 1) * INDENT
    const dropHere = drop && drop.key === r.key
    const common = {
      role: 'treeitem' as const,
      'aria-level': r.level,
      'aria-posinset': r.posinset,
      'aria-setsize': r.setsize,
      'aria-selected': r.kind === 'section' ? undefined : isSel,
      'aria-expanded': r.kind === 'session' ? undefined : r.expanded,
      'aria-label': r.label,
      'data-row-key': r.key,
      'data-active-session': r.section === 'tree' && r.session?.id === activeId && r.kind === 'session' || undefined,
      tabIndex: r.key === tabbable ? 0 : -1,
      onFocus: () => setFocusKey(r.key),
      onPointerDown: (e: React.PointerEvent) => onPointerDown(e, r),
      onContextMenu: () => {
        // Right-click outside the selection acts on that row alone (Finder, VS Code).
        if (r.entity && !selSet.has(r.entity)) {
          setSelected([r.entity])
          anchor.current = r.entity
        }
        setFocusKey(r.key)
      }
    }
    const rowCls = cn(
      'group relative flex h-7 w-full cursor-default select-none items-center gap-1.5 rounded-md pr-2 text-left text-sm outline-none',
      'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring transition-colors duration-[var(--dur-fast)]',
      twin ? 'bg-active text-fg' : isSel ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
      dropHere && drop.zone === 'inside' && (drop.valid ? 'bg-accent-soft ring-1 ring-inset ring-accent' : 'ring-1 ring-inset ring-danger/60'),
      drag.current?.started && drag.current.items.includes(r.entity as EntityKey) && 'opacity-50'
    )
    const line = dropHere && drop.zone !== 'inside' && drop.valid && (
      <span
        aria-hidden
        className={cn('pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-accent', drop.zone === 'before' ? '-top-px' : '-bottom-px')}
        style={{ left: pad }}
      />
    )

    if (r.kind === 'section') {
      return (
        <div
          key={r.key}
          {...common}
          onClick={() => {
            setFocusKey(r.key)
            toggleOpen(r.section as string)
          }}
          className={cn(rowCls, 'mt-1 h-6 text-xs font-medium text-fg-subtle first:mt-0 hover:text-fg-muted')}
          style={{ paddingLeft: pad - 2 }}
        >
          <ChevronRight className={cn('size-3 transition-transform duration-[var(--dur-fast)]', r.expanded && 'rotate-90')} />
          <span className="flex-1 truncate">{r.label}</span>
          <span className="tabular-nums">{r.count}</span>
        </div>
      )
    }

    const label =
      renaming === r.key ? (
        <Input
          autoFocus
          ref={(el) => {
            if (el) requestAnimationFrame(() => document.activeElement !== el && el.isConnected && el.focus())
          }}
          defaultValue={r.label}
          aria-label={`Rename ${r.label}`}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void commitRename(r, e.currentTarget.value)
            if (e.key === 'Escape') {
              renamingRef.current = null
              setRenaming(null)
              focusRow(r.key)
            }
          }}
          onBlur={(e) => renamingRef.current === r.key && void commitRename(r, e.currentTarget.value)}
          className="h-6 flex-1 px-1.5"
        />
      ) : null

    if (r.kind === 'folder') {
      const f = r.folder!
      return (
        <CM.Root key={r.key} modal={false}>
          <CM.Trigger asChild>
            <div
              {...common}
              onClick={(e) => {
                if (suppressClick.current) return
                selectRow(r, e)
                if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !filtering) toggleOpen(f.id)
              }}
              className={cn(rowCls, 'font-medium', !isSel && 'text-fg')}
              style={{ paddingLeft: pad - 2 }}
            >
              {line}
              <ChevronRight className={cn('size-3.5 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-fast)]', r.expanded && 'rotate-90')} />
              {label ?? <span className="flex-1 truncate">{f.name}</span>}
              {!label && <span className="text-2xs tabular-nums text-fg-subtle">{r.count || ''}</span>}
            </div>
          </CM.Trigger>
          <CM.Portal>{folderMenu(r)}</CM.Portal>
        </CM.Root>
      )
    }

    const s = r.session!
    const live = tabs.filter((t) => t.sessionId === s.id)
    const why = matchHint(s, words)
    // Matching tags first, so a hit is never hidden behind "+n".
    const shownTags = (words.length ? [...s.tags].sort((a, b) => Number(words.some((w) => b.includes(w))) - Number(words.some((w) => a.includes(w)))) : s.tags).slice(0, 2)
    const hitTag = words.length ? s.tags.find((t) => words.some((w) => t.includes(w))) : undefined
    return (
      <CM.Root key={r.key} modal={false}>
        <CM.Trigger asChild>
          <div
            {...common}
            onClick={(e) => !suppressClick.current && selectRow(r, e)}
            onDoubleClick={() => openSession(s)}
            className={rowCls}
            style={{ paddingLeft: pad + 14 }}
            title={`${s.name} · ${s.username ? s.username + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}${s.tags.length ? `\n${s.tags.map((t) => '#' + t).join(' ')}` : ''}`}
          >
            {line}
            {s.color && <span aria-hidden className={cn('absolute bottom-1.5 top-1.5 w-0.5 rounded-full', COLOR_CLASS[s.color].bar)} style={{ left: pad + 2 }} />}
            {label ?? (
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                {words.length ? <Marked className="truncate" parts={highlight(s.name, words)} /> : <span title={s.name} className="inline-flex min-w-0"><span className="truncate">{s.name.slice(0, -3)}</span><span className="shrink-0">{s.name.slice(-3)}</span></span>}
                {why && <Marked className={cn('truncate text-2xs text-fg-subtle', why.mono && 'font-mono')} parts={why.parts} />}
              </span>
            )}
            {!label && (
              <>
                {/* Wide tree: up to two chips. Narrow: only the chip a search matched; the rest are in the tooltip. */}
                {shownTags.length > 0 && (
                  <span className="hidden shrink-0 items-center gap-1 @[280px]/tree:flex">
                    {shownTags.map((t) => (
                      <TagChip key={t} tag={t} words={words} />
                    ))}
                    {s.tags.length > 2 && <span className="text-2xs text-fg-subtle">+{s.tags.length - 2}</span>}
                  </span>
                )}
                {hitTag && (
                  <span className="flex shrink-0 @[280px]/tree:hidden">
                    <TagChip tag={hitTag} words={words} />
                  </span>
                )}
                {r.section === 'recent' && !!s.lastConnectedAt && <time title={new Date(s.lastConnectedAt).toLocaleString()} className="hidden shrink-0 text-2xs text-fg-subtle @[220px]/tree:block">{elapsed(Date.now() - s.lastConnectedAt)} ago</time>}
                <SessionStatus tabs={live} />
                <Marked className={cn('vendor-chip', s.platform === 'eos' ? 'vendor-eos' : s.platform === 'fortios' ? 'vendor-fos' : 'vendor-default')} parts={highlight(PLATFORM_SHORT[s.platform], words)} />
              </>
            )}
          </div>
        </CM.Trigger>
        <CM.Portal>{sessionMenu(r)}</CM.Portal>
      </CM.Root>
    )
  }

  const toggleTag = (t: string) => {
    const next = new Set(tagFilter)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setTagFilter(next)
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* The title keeps its width (review P2: "Sessi…" with a tab open); the icon row is tighter instead. */}
      <PanelHeader title="Sessions" titleClassName="flex-none" className="gap-0.5 px-2">
        <Tooltip label="Quick connect" shortcut={sc('session.quickConnect')}>
          <Button variant="ghost" size="icon-sm" onClick={() => useUi.getState().set({ quickOpen: true })} aria-label="Quick connect">
            <Zap />
          </Button>
        </Tooltip>
        <Tooltip label="Import sessions…">
          <Button variant="ghost" size="icon-sm" onClick={() => openImport()} aria-label="Import sessions">
            <Import />
          </Button>
        </Tooltip>
        <Tooltip label="New folder">
          <Button variant="ghost" size="icon-sm" onClick={() => void newFolder(null)} aria-label="New folder">
            <FolderPlus />
          </Button>
        </Tooltip>
        <Tooltip label="New session" shortcut={sc('session.new')}>
          <Button variant="ghost" size="icon-sm" onClick={() => edit()} aria-label="New session">
            <Plus />
          </Button>
        </Tooltip>
      </PanelHeader>
      <div className="relative shrink-0 px-2 pt-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 mt-1 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <Input
          id="session-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('')
            const first = rows.find((r) => r.kind === 'session')
            if (e.key === 'Enter' && first) openSession(first.session!)
            if (e.key === 'ArrowDown' && rows[0]) {
              e.preventDefault()
              const r = first ?? rows[0]
              focusRow(r.key)
              if (r.entity) {
                setSelected([r.entity])
                anchor.current = r.entity
              }
            }
          }}
          // Short, so it never truncates in a narrow sidebar (review P2); the label says what it searches.
          placeholder="Search"
          aria-label="Search sessions by name, host, tag or platform"
          title="Search by name, host, tag or platform"
          aria-controls="session-tree"
          className="pl-7"
        />
      </div>
      {tagList.length > 0 && (
        <div role="group" aria-label="Filter by tag" data-tag-filter className="flex max-h-16 shrink-0 flex-wrap gap-1 overflow-auto px-2 pt-2">
          {tagList.map(({ tag }) => (
            <TagChip key={tag} tag={tag} active={tagFilter.has(tag)} onClick={() => toggleTag(tag)} />
          ))}
          {tagFilter.size > 0 && (
            <button type="button" onClick={() => setTagFilter(new Set())} className="h-5 cursor-default rounded-[3px] px-1 text-2xs text-fg-subtle hover:text-fg">
              Clear
            </button>
          )}
        </div>
      )}
      {filtering && sessions.length > 0 && (
        <div aria-live="polite" className="shrink-0 px-3 pt-1.5 text-2xs text-fg-subtle">
          {matchCount} match{matchCount === 1 ? '' : 'es'}
        </div>
      )}
      <div
        ref={areaRef}
        data-tree-scroller
        // Scrolled: a hairline under the search and tag rows, so a half-clipped row never reads as
        // sitting under the chips (0.6 review).
        onScroll={(e) => e.currentTarget.toggleAttribute('data-scrolled', e.currentTarget.scrollTop > 0)}
        className={cn('@container/tree relative mt-1.5 min-h-0 flex-1 overflow-auto border-t border-transparent px-2 py-2 data-[scrolled]:border-line', drop && drop.key === null && (drop.valid ? 'bg-accent-soft/40 ring-1 ring-inset ring-accent/50' : ''))}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected([])
        }}
      >
        {loadError ? (
          <p role="alert" data-testid="tree-load-error" className="px-2 py-1.5 text-xs text-danger">
            Could not read your sessions: {loadError}. Restart Hopline; if it keeps failing, restore a backup from Settings → Sync &amp; export.
          </p>
        ) : !loaded ? <Loading what="sessions" /> : !sessions.length && !folders.length ? (
          <EmptyState title="No sessions yet" body="Save a device to connect to it again." action={<Button size="sm" onClick={() => edit()}>Add a device</Button>} />
        ) : !rows.length ? (
          <EmptyState icon={<Search />} title={q ? `No sessions match “${q}”` : 'No sessions with these tags'} body="Try a device name, address or vendor." action={<Button size="sm" onClick={() => { setQ(''); setTagFilter(new Set()) }}>Clear filters</Button>} />
        ) : (
          <div id="session-tree" ref={treeRef} role="tree" aria-label="Sessions" aria-multiselectable onKeyDown={onKeyDown} className="relative flex flex-col">
            {rows.map(renderRow)}
            {activeId && rows.some((r) => r.section === 'tree' && r.session?.id === activeId) && <FocusFrame selector="[data-active-session]" identity={activeId + rowKeys} rail />}
          </div>
        )}
        {/* Room below the last row to drop at the top level. */}
        <div className="h-8" aria-hidden />
      </div>
      <Checklist />
      {ghost && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md bg-overlay px-2 py-1 text-xs text-fg shadow-overlay',
            drop && !drop.valid && 'text-fg-subtle'
          )}
          style={{ left: 0, top: 0, transform: `translate(${ghost.x + 12}px,${ghost.y + 8}px)`, transition: 'transform var(--dur-fast) var(--ease-spring)' }}
        >
          <span className="font-medium">{ghost.label}</span>
          {drop?.label && <span className="text-fg-subtle">· {drop.label}</span>}
        </div>
      )}
    </div>
  )
}
