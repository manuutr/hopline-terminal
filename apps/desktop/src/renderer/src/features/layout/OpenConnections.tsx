import { Columns2, Maximize2, X } from 'lucide-react'
import { ContextMenu as CM } from 'radix-ui'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn, StatusDot, Tooltip } from '../../design'
import { SelectionIndicator } from '../../design/SelectionIndicator'
import { useListMotion } from '../../design/useListMotion'
import { panes } from '../../lib/layout'
import { requestCloseWorkspace, requestCloseWorkspaces } from '../../lib/confirm'
import { ContextItem, menuContent, menuItem, menuSeparator } from '../../design/Menu'
import { askText } from '../../lib/prompt'
import { isMac } from '../../lib/keys'
import { openSession, saveQuickSession } from '../../lib/connect'
import { COLOR_CLASS } from '../sessions/colors'
import { openSetPlatform } from '../sessions/PlatformDetect'
import { openFiles } from '../files/store'
import { openForwards } from '../forwards/ForwardsDialog'
import { backupNow, openBackups } from '../backups/store'
import { useMulti } from '../multi/store'
import { sessionById, useUi, type Workspace } from '../../store'
import { GLYPH_LABEL, StatusGlyph, useWorkspaceSummary } from './StatusGlyph'
import { useShortcutMap } from '../../lib/actions'

const DRAG_THRESHOLD = 4

function ConnectionRow({ ws, index, active, dragging, showIndex, onPointerDown }: {
  ws: Workspace
  index: number
  active: boolean
  dragging: boolean
  showIndex: boolean
  onPointerDown: (event: React.PointerEvent, ws: Workspace) => void
}): React.JSX.Element {
  const sc = useShortcutMap()
  const { title, glyph, focused } = useWorkspaceSummary(ws)
  const session = useUi((x) => sessionById(x, focused?.sessionId))
  const quick = useUi((x) => (focused ? x.quick.some((q) => q.id === focused.sessionId) : false))
  const accent = session?.color ? COLOR_CLASS[session.color] : undefined
  const paneCount = panes(ws.root).length
  const s = useUi.getState()
  const digit = index < 8 ? index + 1 : undefined
  const hint = [title, focused?.detail ?? focused?.state, glyph && GLYPH_LABEL[glyph], quick && 'quick connect, not saved', paneCount > 1 && `${paneCount} panes`, ws.zoomedPaneId && 'Pane zoomed', showIndex && digit && `Shortcut ${digit}`].filter(Boolean).join(' · ')

  const tab = (
    <div
      role="tab"
      aria-selected={active}
      aria-keyshortcuts="Delete Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
      tabIndex={active ? 0 : -1}
      data-ws-id={ws.id}
      data-ws-index={index}
      data-active={active || undefined}
      data-color={session?.color ?? undefined}
      data-quick={quick || undefined}
      title={hint}
      onPointerDown={(e) => onPointerDown(e, ws)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void requestCloseWorkspace(ws.id)
        }
      }}
      onClick={() => s.activateWs(ws.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          s.activateWs(ws.id)
        }
        if (e.key === 'Delete') {
          e.preventDefault()
          void requestCloseWorkspace(ws.id)
        }
        const direction = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
        if (direction || e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          if (direction && e.shiftKey && e.altKey) {
            s.moveWs(ws.id, index + direction)
            return
          }
          const rows = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=tab]')
          if (rows?.length) {
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (index + direction + rows.length) % rows.length
            rows[next]?.focus()
          }
        }
      }}
      className={cn(
        'group relative flex h-8 w-full shrink-0 cursor-default select-none items-center gap-2 rounded-md pl-3 pr-1.5 text-sm',
        active ? 'bg-active font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
        dragging && 'opacity-50'
      )}
    >
      <span aria-hidden className="flex w-4 shrink-0 items-center justify-center">
        {glyph ? <StatusGlyph glyph={glyph} /> : focused && <StatusDot state={focused.state} />}
      </span>
      <span aria-hidden className="flex min-w-0 flex-1" title={title}>
        <span className="truncate">{title.slice(0, -3)}</span><span className="shrink-0">{title.slice(-3)}</span>
      </span>
      <span className="sr-only">{title}</span>
      {accent && <span aria-hidden className={cn('h-0.5 w-2.5 shrink-0 rounded-full', accent.bar)} />}
      {ws.zoomedPaneId && (
        <Tooltip label="Pane zoomed" shortcut={sc('pane.zoom')}>
          <Maximize2 aria-hidden className="size-3 shrink-0 text-fg-subtle" />
        </Tooltip>
      )}
      {paneCount > 1 && <span aria-hidden className="flex shrink-0 items-center gap-0.5 text-2xs text-fg-subtle"><Columns2 className="size-3" />{paneCount}</span>}
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        {showIndex && digit && <span aria-hidden className="text-xs tabular-nums text-fg-muted group-hover:invisible">{digit}</span>}
        {/* Delete and the context menu provide the keyboard equivalent of this pointer target. */}
        <span
          aria-hidden
          data-tab-close
          title={`Close ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            void requestCloseWorkspace(ws.id)
          }}
          className={cn('absolute inset-0 flex items-center justify-center rounded-sm text-fg-subtle hover:bg-raised hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100',
            active && !showIndex ? 'opacity-100' : 'opacity-0')}
        >
          <X className="size-3.5" />
        </span>
      </span>
    </div>
  )
  const trigger = <CM.Trigger asChild>{tab}</CM.Trigger>
  const all = useUi((x) => x.workspaces)
  const others = all.filter((w) => w.id !== ws.id).map((w) => w.id)
  const below = all.slice(index + 1).map((w) => w.id)
  return (
    <CM.Root modal={false}>
      {trigger}
      <CM.Portal>
        <CM.Content className={menuContent}>
          {focused && (
            <>
              {quick && <ContextItem label="Save as session…" onSelect={() => void saveQuickSession(focused.sessionId)} />}
              <ContextItem
                label="Rename…"
                onSelect={() =>
                  void askText('Rename tab', focused.title).then((t) => {
                    if (t?.trim()) s.updateTab({ tabId: focused.tabId, title: t.trim().slice(0, 120) })
                  })
                }
              />
              {!quick && session && <ContextItem label="Duplicate" onSelect={() => openSession(session)} />}
              <ContextItem label="Reconnect" disabled={focused.state === 'connecting' || focused.state === 'reconnecting'} onSelect={() => void window.hopline.term.reconnect(focused.tabId).catch(() => {})} />
              <CM.Separator className={menuSeparator} />
              <ContextItem label="Set platform…" onSelect={() => openSetPlatform(focused.sessionId)} />
              {session?.protocol === 'ssh' && (
                <>
                  <ContextItem
                    label="Files (SFTP/SCP)…"
                    keys={sc('files.toggle')}
                    onSelect={() => {
                      s.activate(focused.tabId)
                      openFiles(focused.tabId)
                    }}
                  />
                  <ContextItem label="Port forwarding…" onSelect={() => openForwards(focused.tabId)} />
                </>
              )}
              <ContextItem label="Run on…" onSelect={() => useMulti.getState().show('run', { tabs: [focused.tabId] })} />
              <ContextItem label="Send to…" onSelect={() => useMulti.getState().show('send', { tabs: [focused.tabId] })} />
              {!quick && (
                <>
                  <ContextItem label="Back up config" onSelect={() => void backupNow([focused.sessionId])} />
                  <ContextItem label="Config history…" onSelect={() => openBackups(focused.sessionId)} />
                </>
              )}
              <CM.Separator className={menuSeparator} />
            </>
          )}
          {all.length > 1 && <CM.Sub>
            <CM.SubTrigger className={menuItem}>Move into split <span aria-hidden className="ml-auto">›</span></CM.SubTrigger>
            <CM.Portal><CM.SubContent className={menuContent}>
              {all.filter((w) => w.id !== ws.id).map((w) => {
                const name = s.tabs.find((t) => panes(w.root).some((p) => p.tabId === t.tabId))?.title ?? 'Empty pane'
                return <ContextItem key={w.id} label={'Beside ' + name} onSelect={() => s.splitWorkspace(ws.id, w.focusedPaneId, 'row')} />
              })}
            </CM.SubContent></CM.Portal>
          </CM.Sub>}
          <ContextItem label="Close others" disabled={!others.length} onSelect={() => void requestCloseWorkspaces(others)} />
          <ContextItem label="Close tabs below" disabled={!below.length} onSelect={() => void requestCloseWorkspaces(below)} />
          <ContextItem label="Close tab" onSelect={() => void requestCloseWorkspace(ws.id)} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  )
}

export function OpenConnections(): React.JSX.Element | null {
  const workspaces = useUi((s) => s.workspaces)
  const activeWsId = useUi((s) => s.activeWsId)
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const list = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; x0: number; y0: number; started: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [dragView, setDragView] = useState<{ id: string; y?: number } | null>(null)
  // Jump digits show only while the jump modifier is held (Alt; ⌘ on macOS), like Linear and Arc.
  const [showIndex, setShowIndex] = useState(false)
  useEffect(() => {
    const jumpKey = isMac ? 'Meta' : 'Alt'
    // Shown after a 150 ms hold, so Alt+B / Alt+F line editing in the terminal never flashes digits.
    let timer: ReturnType<typeof setTimeout> | undefined
    const reset = () => {
      clearTimeout(timer)
      setShowIndex(false)
    }
    const down = (e: KeyboardEvent) => {
      if (e.key === jumpKey && !e.ctrlKey && !e.shiftKey && !e.repeat) timer = setTimeout(() => setShowIndex(true), 150)
      else if (e.key !== jumpKey && !/^\d$/.test(e.key)) clearTimeout(timer)
    }
    const up = (e: KeyboardEvent) => e.key === jumpKey && reset()
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', reset)
      clearTimeout(timer)
    }
  }, [])

  const keys = workspaces.map((ws) => ws.id).join('|')
  useListMotion(list, 'data-ws-id', keys)
  useLayoutEffect(() => {
    if (activeWsId && sidebarOpen) list.current?.querySelector<HTMLElement>('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }, [activeWsId, sidebarOpen, keys])

  useEffect(() => {
    const destination = (event: PointerEvent, id: string) => {
      const el = list.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null
      const others = Array.from(el.querySelectorAll<HTMLElement>('[role=tab]')).filter((row) => row.dataset.wsId !== id)
      const before = others.findIndex((row) => {
        const box = row.getBoundingClientRect()
        return event.clientY < box.top + box.height / 2
      })
      if (before < 0) return { index: others.length, y: (others.at(-1)?.getBoundingClientRect().bottom ?? rect.top) - rect.top + el.scrollTop }
      return { index: before, y: others[before]!.getBoundingClientRect().top - rect.top + el.scrollTop }
    }
    const paneTarget = (event: PointerEvent) => {
      const pane = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-pane-id]')
      if (!pane) return null
      const rect = pane.getBoundingClientRect()
      const dir = (event.clientY - rect.top) / rect.height > .66 ? 'column' as const : 'row' as const
      return { pane, dir }
    }
    const clearTarget = () => document.querySelector('[data-split-target]')?.removeAttribute('data-split-target')
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.started && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_THRESHOLD) return
      d.started = true
      clearTarget()
      const dest = paneTarget(e)
      if (dest) dest.pane.dataset.splitTarget = dest.dir
      setDragView({ id: d.id, y: destination(e, d.id)?.y })
    }
    const up = (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      if (!d?.started) return
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
      clearTarget()
      const dest = paneTarget(e)
      if (dest) useUi.getState().splitWorkspace(d.id, dest.pane.dataset.paneId!, dest.dir)
      else {
        const drop = destination(e, d.id)
        if (drop) useUi.getState().moveWs(d.id, drop.index)
      }
      setDragView(null)
    }
    const cancel = () => {
      clearTarget()
      drag.current = null
      setDragView(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent, ws: Workspace) => {
    if (e.button !== 0) return
    drag.current = { id: ws.id, x0: e.clientX, y0: e.clientY, started: false }
  }

  if (!workspaces.length) return null
  return (
    <div data-open-connections className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-line bg-surface pb-2">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-medium text-fg-muted">
        <h2 id="open-connections-title">Open connections</h2>
        <span aria-hidden className="tabular-nums text-fg-subtle">{workspaces.length}</span>
      </div>
      <div
        ref={list}
        role="tablist"
        aria-labelledby="open-connections-title"
        aria-orientation="vertical"
        data-show-index={showIndex || undefined}
        className="relative min-h-0 overflow-y-auto overscroll-contain px-1.5"
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.stopPropagation()
            e.preventDefault()
          }
        }}
      >
        {activeWsId && <SelectionIndicator kind="tab" value={activeWsId} items={keys} />}
        {workspaces.map((ws, index) => (
          <ConnectionRow key={ws.id} ws={ws} index={index} active={ws.id === activeWsId}
            dragging={dragView?.id === ws.id} showIndex={showIndex} onPointerDown={onPointerDown} />
        ))}
        {dragView?.y !== undefined && <span aria-hidden className="pointer-events-none absolute inset-x-2 z-10 h-px bg-accent" style={{ top: dragView.y }} />}
      </div>
    </div>
  )
}
