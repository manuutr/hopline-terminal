import { ClipboardList, Copy, MessageSquareText, RotateCw, SquareChevronRight, Table2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'
import { useDrafts } from '../ai/drafts'
import { useUi } from '../../store'
import { fmtTime } from '../../lib/when'
import { cn, Tooltip } from '../../design'
import { useShortcut } from '../../lib/actions'
import { useBlockError } from './useBlockError'
import type { Block } from '../../lib/blocks'
import { diffTables } from '../../lib/table'
import type { BlockController } from './controller'
import { useBlocks } from './store'

/** xterm's rendered cell size (private API, with a fallback), as the autocomplete overlay does. */
function cell(term: BlockController['term']): { w: number; h: number } | null {
  const d = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell
  if (d?.width && d.height) return { w: d.width, h: d.height }
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || !term.rows) return null
  return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows }
}

/** The block under a pointer position (the terminal context menu acts on it). */
export function blockAtPoint(ctl: BlockController, clientY: number): Block | undefined {
  const c = cell(ctl.term)
  const screen = ctl.term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!c || !screen) return undefined
  const row = Math.floor((clientY - screen.getBoundingClientRect().top) / c.h)
  return row >= 0 && row < ctl.term.rows ? ctl.tracker.blockAt(ctl.term.buffer.active.viewportY + row) : undefined
}

const toolBtn =
  'flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-fg-muted outline-none transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5'

/**
 * The one overlay for command blocks: an accent rail beside the active block (hovered, or picked
 * with Mod+↑/↓) and a small toolbar on its prompt row. One set of DOM nodes per terminal, never a
 * decoration per block, and nothing at all while output streams without a block under the mouse.
 */
export function BlockLayer({ ctl }: { ctl: BlockController }): React.JSX.Element | null {
  const tabId = ctl.tabId
  const selectedId = useBlocks((s) => s.selected[tabId] ?? null)
  const parsedMap = useBlocks((s) => s.parsed[tabId])
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = ctl.byId(hoverId) ?? ctl.byId(selectedId)

  const error = useBlockError(ctl, active)

  // Hover: which block is under the mouse (only re-renders when that changes).
  useEffect(() => {
    const el = ctl.term.element
    if (!el) return
    const onMove = (e: MouseEvent) => {
      clearTimeout(leaveTimer.current)
      const c = cell(ctl.term)
      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      if (!c || !screen) return
      const row = Math.floor((e.clientY - screen.getBoundingClientRect().top) / c.h)
      const b = row >= 0 && row < ctl.term.rows ? ctl.tracker.blockAt(ctl.term.buffer.active.viewportY + row) : undefined
      setHoverId(b?.id ?? null)
    }
    const onLeave = (event: MouseEvent) => {
      clearTimeout(leaveTimer.current)
      // The toolbar is a sibling of xterm. Its React mouse-enter can run before
      // xterm's native mouse-leave for the very same pointer movement.
      if (event.relatedTarget instanceof Node && toolbarRef.current?.contains(event.relatedTarget)) return
      leaveTimer.current = setTimeout(() => setHoverId(null), 250)
    }
    // A stationary pointer over an older block must yield to keyboard navigation.
    const offSelection = useBlocks.subscribe((state, previous) => {
      if (state.selected[tabId] !== previous.selected[tabId]) setHoverId(null)
    })
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      offSelection()
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      clearTimeout(leaveTimer.current)
    }
  }, [ctl])

  // Typing clears the keyboard pick (the live prompt is where the user is).
  useEffect(() => {
    const d = ctl.term.onData(() => useBlocks.getState().selected[tabId] != null && useBlocks.getState().select(tabId, null))
    return () => d.dispose()
  }, [ctl, tabId])

  // Follow scrolling and resizes only while a block is shown, at most once per frame.
  useEffect(() => {
    if (!active) return
    let raf = 0
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), redraw()))
    }
    const subs = [ctl.term.onScroll(kick), ctl.term.onResize(kick), ctl.term.onRender(kick)]
    const off = ctl.onChange(kick)
    return () => {
      cancelAnimationFrame(raf)
      subs.forEach((s) => s.dispose())
      off()
    }
  }, [ctl, active])

  if (!active) return null
  const c = cell(ctl.term)
  const screen = ctl.term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!c || !screen) return null
  const vy = ctl.term.buffer.active.viewportY
  const rows = ctl.term.rows
  const from = Math.max(active.start.line, vy)
  const to = Math.min(active.end.line, vy + rows)
  if (to <= from) return null
  // Offsets of the grid inside the host (the host has padding).
  const host = ctl.term.element!.parentElement!
  const ox = screen.getBoundingClientRect().left - host.getBoundingClientRect().left
  const oy = screen.getBoundingClientRect().top - host.getBoundingClientRect().top
  const top = host.offsetTop + oy + (from - vy) * c.h
  const height = (to - from) * c.h
  const parsed = parsedMap?.[active.id]
  const changed = parsed?.prev ? diffTables(parsed.prev.result, parsed.result) : undefined
  const changes = changed?.comparable ? changed.status.filter((s) => s !== 'same').length + changed.removed.length : 0
  const picked = active.id === selectedId

  return (
    <>
      <div
        aria-hidden
        data-testid="block-rail"
        className={cn('pointer-events-none absolute z-[4] w-[2px] rounded-full', error ? 'bg-danger' : picked ? 'bg-accent' : 'bg-accent/55')}
        style={{ left: Math.max(2, ox - 6), top, height }}
      />
      {picked && <div aria-hidden className="pointer-events-none absolute right-0 z-[3] bg-accent/[0.06]" style={{ left: ox - 4, top, height }} />}
      <Toolbar
        toolbarRef={toolbarRef}
        block={active}
        error={error}
        ctl={ctl}
        promptTop={top}
        firstVisible={active.start.line >= vy}
        gridTop={host.offsetTop + oy}
        textEnd={ox + Math.min(ctl.term.cols, (active.prompt + active.command).length) * c.w}
        cmdRows={Math.max(1, Math.ceil((active.prompt + active.command).length / Math.max(1, ctl.term.cols)))}
        cellH={c.h}
        hostWidth={host.clientWidth}
        rows={parsed?.result.rows.length}
        changes={changes}
        onEnter={() => clearTimeout(leaveTimer.current)}
        onLeave={() => {
          clearTimeout(leaveTimer.current)
          leaveTimer.current = setTimeout(() => setHoverId(null), 250)
        }}
      />
    </>
  )
}

const TOOLBAR_H = 30

function Toolbar({
  toolbarRef,
  block,
  error,
  ctl,
  promptTop,
  firstVisible,
  gridTop,
  textEnd,
  cmdRows,
  cellH,
  hostWidth,
  rows,
  changes,
  onEnter,
  onLeave
}: {
  toolbarRef: RefObject<HTMLDivElement | null>
  block: Block
  error: boolean
  ctl: BlockController
  /** Pixel top of the block's first visible row, and whether that row is the prompt. */
  promptTop: number
  firstVisible: boolean
  gridTop: number
  /** Pixel x where the prompt + command text ends (single row), and how many rows it wraps to. */
  textEnd: number
  cmdRows: number
  cellH: number
  hostWidth: number
  rows: number | undefined
  changes: number
  onEnter: () => void
  onLeave: () => void
}): React.JSX.Element {
  const keys = {
    copyOutput: useShortcut('blocks.copyOutput'),
    copyCommand: useShortcut('blocks.copyCommand'),
    copyReport: useShortcut('blocks.copyReport'),
    rerun: useShortcut('blocks.rerun'),
    ask: useShortcut('blocks.ask'),
    table: useShortcut('blocks.table')
  }
  const [width, setWidth] = useState(170)
  useLayoutEffect(() => {
    const w = toolbarRef.current?.offsetWidth
    if (w && w !== width) setWidth(w)
  })
  // Never cover the command (round 2): on the prompt row at the right when the text ends before
  // the toolbar starts; otherwise just above the block, or below the command when the block starts
  // at the top of the viewport.
  const showLabels = hostWidth >= 540
  const right = hostWidth < width + 40 ? 4 : 16
  const left = hostWidth - right - width
  let top: number
  if (!firstVisible) top = Math.max(gridTop + 2, promptTop + 2)
  else if (cmdRows === 1 && textEnd + 12 <= left) top = promptTop + 2
  else if (promptTop - TOOLBAR_H - 2 >= gridTop) top = promptTop - TOOLBAR_H - 2
  else top = promptTop + cmdRows * cellH + 2
  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={`Command block: ${block.command}`}
      data-testid="block-toolbar"
      data-block-id={block.id}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // Clicks here must not reach xterm (selection, focus).
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-[7] flex max-w-[calc(100%-8px)] items-center gap-px overflow-hidden rounded-md border border-line bg-overlay p-0.5 text-xs shadow-overlay animate-fade-in"
      style={{ top, right }}
    >
      {hostWidth > 680 && <time title={new Date(block.closedAt).toLocaleString()} className="px-1 text-2xs text-fg-subtle">{fmtTime(block.closedAt)}</time>}
      <Tooltip label="Copy output" shortcut={keys.copyOutput}>
        <button type="button" aria-label="Copy output" className={toolBtn} onClick={() => void ctl.copyOutput(block)}>
          <Copy />{showLabels && <span>Copy output</span>}
        </button>
      </Tooltip>
      <Tooltip label="Copy command" shortcut={keys.copyCommand}>
        <button type="button" aria-label="Copy command" className={toolBtn} onClick={() => void ctl.copyCommand(block)}>
          <SquareChevronRight />
        </button>
      </Tooltip>
      <Tooltip label="Copy for ticket" shortcut={keys.copyReport}>
        <button type="button" aria-label="Copy for ticket" className={toolBtn} onClick={() => void ctl.copyForTicket(block)}>
          <ClipboardList />
        </button>
      </Tooltip>
      <Tooltip label="Re-run (read-only commands run; anything else is only typed)" shortcut={keys.rerun}>
        <button type="button" aria-label="Re-run" className={toolBtn} onClick={() => void ctl.rerun(block)}>
          <RotateCw />
        </button>
      </Tooltip>
      {showLabels && <button type="button" className={toolBtn} onClick={() => {
        useDrafts.getState().edit(ctl.tabId, { attachment: ctl.attachment(block) })
        useUi.getState().set({ aiOpen: true })
      }}>Attach</button>}
      <Tooltip label="Ask AI about this block" shortcut={keys.ask}>
        <button type="button" aria-label={error ? 'Ask AI why' : 'Ask AI about this block'} className={cn(toolBtn, 'text-accent hover:text-accent')} onClick={() => ctl.ask(block)}>
          <MessageSquareText />{showLabels && <span>{error ? 'Ask AI why' : 'Ask AI'}</span>}
        </button>
      </Tooltip>
      {rows !== undefined && (
        <>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
          <Tooltip label={changes ? `Table · ${changes} change${changes === 1 ? '' : 's'} since the last run` : 'Show as table'} shortcut={keys.table}>
            <button type="button" aria-label="Show as table" className={cn(toolBtn, 'font-medium text-fg')} onClick={() => ctl.openTable(block)}>
              <Table2 />
              <span className="tabular-nums">{rows}</span>
              {changes > 0 && <span aria-hidden className="size-1.5 rounded-full bg-warn" />}
            </button>
          </Tooltip>
        </>
      )}
    </div>
  )
}
