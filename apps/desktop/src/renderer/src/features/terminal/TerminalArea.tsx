import { Maximize2 } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import { Group, Panel, type GroupImperativeHandle } from 'react-resizable-panels'
import { FocusFrame } from '../../design/FocusFrame'
import { Divider } from '../../design/Divider'
import { cn, Kbd } from '../../design'
import { findPane, panes, type LayoutNode, type PaneNode } from '../../lib/layout'
import { openSession } from '../../lib/connect'
import { activeWorkspace, useUi, type Workspace } from '../../store'
import { Launcher } from './Launcher'
import { attachTerminal, TerminalHost } from './TerminalHost'
import { useShortcutMap } from '../../lib/actions'

/** Pane minimum, about 20 columns × 5 rows of 13 px JetBrains Mono plus padding. */
export const PANE_MIN = { w: 180, h: 96 } as const

/**
 * Divider: 1 px visible line; the library keeps an 8 px hit area around it. The hover colour
 * waits 200 ms (crossing a seam should not flash it); dragging shows it at once.
 */
const divider = (dir: 'row' | 'column') =>
  cn(
    'relative shrink-0 bg-line-strong transition-colors duration-[var(--dur-fast)] ease-out',
    'data-[separator=hover]:bg-accent/60 data-[separator=hover]:delay-200',
    'data-[separator=active]:bg-accent data-[separator=active]:delay-0 data-[separator=active]:duration-0',
    dir === 'row' ? 'w-px' : 'h-px'
  )

function PaneSlot({ ws, node, multi }: { ws: Workspace; node: PaneNode; multi: boolean }): React.JSX.Element {
  const sc = useShortcutMap()
  const root = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const focused = ws.focusedPaneId === node.id
  const zoomed = ws.zoomedPaneId === node.id

  // Move the (never remounted) terminal into this slot. See TerminalHost.
  useLayoutEffect(() => {
    if (!node.tabId || !slot.current) return
    return attachTerminal(node.tabId, slot.current)
  }, [node.tabId])

  // Click or focus inside focuses the pane. Native capture listeners: the terminal is rendered
  // through a portal elsewhere in the React tree, so React events from it never reach this div.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const focus = () => useUi.getState().focusPane(node.id)
    el.addEventListener('pointerdown', focus, true)
    el.addEventListener('focusin', focus, true)
    return () => {
      el.removeEventListener('pointerdown', focus, true)
      el.removeEventListener('focusin', focus, true)
    }
  }, [node.id])

  return (
    <div
      ref={root}
      data-pane-id={node.id}
      data-tab-id={node.tabId ?? ''}
      data-focused={focused || undefined}
      className="relative h-full w-full overflow-hidden bg-term"
    >
      <div className="absolute inset-0">
        {node.tabId ? (
          <div ref={slot} className="absolute inset-0" />
        ) : (
          <Launcher
            compact
            focused={focused}
            onPick={(s) => useUi.getState().openInPane(node.id, s)}
            onDismiss={() => useUi.getState().closePane(node.id)}
          />
        )}
      </div>
      {multi && !focused && <div aria-hidden className="pane-shade pointer-events-none absolute inset-0" />}
      {zoomed && (
        <div className="pointer-events-none absolute right-3 top-2 z-10 flex animate-fade-in items-center gap-1.5 rounded-md bg-overlay/90 px-2 py-0.5 text-2xs text-fg-muted shadow-overlay">
          <Maximize2 className="size-3" /> Zoomed
          <Kbd keys={sc('pane.zoom') ?? 'Mod+Enter'} />
        </div>
      )}
    </div>
  )
}

function Node({ ws, node, multi }: { ws: Workspace; node: LayoutNode; multi: boolean }): React.JSX.Element {
  if (node.type === 'pane') return <PaneSlot ws={ws} node={node} multi={multi} />
  return <SplitView ws={ws} node={node} multi={multi} />
}

function SplitView({ ws, node, multi }: { ws: Workspace; node: Extract<LayoutNode, { type: 'split' }>; multi: boolean }): React.JSX.Element {
  const group = useRef<GroupImperativeHandle | null>(null)
  const horizontal = node.dir === 'row'
  const save = (layout: Record<string, number>) => useUi.getState().setSplitSizes(ws.id, node.id, node.children.map((c) => layout[c.id] ?? 0))
  return (
    <Group
      groupRef={group}
      // Remount the group when its children change: sizes live in our store, not in the library.
      key={node.children.map((c) => c.id).join('|')}
      id={node.id}
      orientation={horizontal ? 'horizontal' : 'vertical'}
      resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
      className="h-full w-full animate-workspace-in"
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return
        if (node.children.length === 2) {
          const [a, b] = node.children
          const value = layout[a!.id] ?? 0
          const snap = [100 / 3, 50, 200 / 3].find((n) => Math.abs(value - n) < 1.5)
          if (snap !== undefined && Math.abs(value - snap) > .02) {
            const applied = group.current?.setLayout({ [a!.id]: snap, [b!.id]: 100 - snap })
            if (applied) return save(applied)
          }
        }
        save(layout)
      }}
    >
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && (
            <Divider
              id={`${node.id}-sep-${i}`}
              label={horizontal ? 'Resize panes left and right' : 'Resize panes up and down'}
              group={group}
              before={node.children[i - 1]!.id}
              after={c.id}
              horizontal={horizontal}
              onKeyboardResize={save}
              className={divider(node.dir)}
            />
          )}
          <Panel id={c.id} defaultSize={`${node.sizes[i]}%`} minSize={horizontal ? PANE_MIN.w : PANE_MIN.h} className="h-full w-full" style={{ overflow: 'hidden' }}>
            <Node ws={ws} node={c} multi={multi} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  )
}

function WorkspaceView({ ws }: { ws: Workspace }): React.JSX.Element {
  const multi = panes(ws.root).length > 1
  const zoomed = ws.zoomedPaneId ? findPane(ws.root, ws.zoomedPaneId) : undefined
  if (zoomed) return <PaneSlot ws={ws} node={zoomed} multi={false} />
  return <Node ws={ws} node={ws.root} multi={multi} />
}

export function TerminalArea(): React.JSX.Element {
  const ws = useUi(activeWorkspace)
  return (
    <div className="relative h-full bg-term" data-terminal-area="">
      {ws ? <WorkspaceView key={ws.id} ws={ws} /> : <Launcher onPick={openSession} />}
      {ws && !ws.zoomedPaneId && panes(ws.root).length > 1 && <FocusFrame selector="[data-pane-id][data-focused]" identity={ws.focusedPaneId} />}
      <TerminalHost />
    </div>
  )
}
