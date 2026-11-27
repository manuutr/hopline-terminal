import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { detectConfigMode, findPane, panes } from '../../lib/layout'
import { terminals } from '../../lib/terminals'
import { activeWorkspace, useUi } from '../../store'
import { TerminalView } from './TerminalView'

/*
 * Why this exists: a TerminalView owns a live xterm *and* the SSH session behind it, so it must
 * never remount when the split layout changes shape (react-resizable-panels Groups and Panels do
 * remount as the tree changes).
 *
 * Every TerminalView is rendered exactly once, from one flat list keyed by tabId, through a portal
 * into a container div that is created once per tab and kept in `containers`. React only ever
 * sees those portals, never where the container sits. Pane slots then *move* the container's DOM
 * node into themselves (and back to a hidden parking div when they unmount). Moving a DOM node
 * does not touch React's fiber tree, so the TerminalView and its xterm stay mounted.
 */

const containers = new Map<string, HTMLDivElement>()
let park: HTMLDivElement | null = null

export function terminalContainer(tabId: string): HTMLDivElement {
  let el = containers.get(tabId)
  if (!el) {
    el = document.createElement('div')
    el.className = 'absolute inset-0'
    el.dataset['terminalContainer'] = tabId
    containers.set(tabId, el)
    park?.appendChild(el)
  }
  return el
}

/** Move a terminal into a pane slot. Returns the cleanup that parks it again. */
export function attachTerminal(tabId: string, slot: HTMLElement): () => void {
  const el = terminalContainer(tabId)
  const hadFocus = el.contains(document.activeElement)
  slot.appendChild(el)
  // Moving a node blurs whatever was focused inside it: give focus back to the terminal.
  if (hadFocus || document.activeElement === document.body) {
    const tab = useUi.getState().activeTabId
    if (tab === tabId) requestAnimationFrame(() => terminals.get(tabId)?.focus())
  }
  return () => {
    if (el.parentElement === slot) park?.appendChild(el)
  }
}

// ---- test hook: mount counts --------------------------------------------------------------

/** tabId → number of times its TerminalView subtree mounted. Must stay 1 for a tab's lifetime. */
const mounts = new Map<string, number>()
;(window as unknown as { __hoplinePanes: unknown }).__hoplinePanes = {
  mounts: (): Record<string, number> => Object.fromEntries(mounts)
}

/** Rendered as a sibling of TerminalView in the same keyed portal, so it mounts exactly when it does. */
function MountProbe({ tabId }: { tabId: string }): null {
  useEffect(() => {
    mounts.set(tabId, (mounts.get(tabId) ?? 0) + 1)
  }, [tabId])
  return null
}

// ---- attention watcher: config mode, bell, unread ------------------------------------------

/** tabId → time of the last output (for the session switcher). */
export const lastOutput = new Map<string, number>()

function isVisible(tabId: string): boolean {
  const ws = activeWorkspace(useUi.getState())
  if (!ws) return false
  if (ws.zoomedPaneId) return findPane(ws.root, ws.zoomedPaneId)?.tabId === tabId
  return panes(ws.root).some((p) => p.tabId === tabId)
}

/**
 * Observes the xterm (read-only) once it exists. It does not touch the data path: it listens to
 * xterm's own parse and bell events and reads the cursor line.
 */
function Watch({ tabId }: { tabId: string }): null {
  useEffect(() => {
    const subs: { dispose: () => void }[] = []
    let raf = 0
    let poll = 0
    const attach = () => {
      const h = terminals.get(tabId)
      if (!h) {
        poll = window.setTimeout(attach, 100)
        return
      }
      const term = h.term
      const check = () => {
        raf = 0
        const s = useUi.getState()
        const tab = s.tabs.find((t) => t.tabId === tabId)
        if (!tab) return
        const buf = term.buffer.active
        const y = buf.baseY + buf.cursorY
        const line = buf.getLine(y)?.translateToString(true) ?? ''
        const above = buf.getLine(y - 1)?.translateToString(true) ?? ''
        const cfg = detectConfigMode(line, above)
        const patch: { configMode?: boolean; unread?: boolean } = {}
        if (cfg !== undefined && cfg !== !!tab.configMode) patch.configMode = cfg
        if (!tab.unread && !isVisible(tabId)) patch.unread = true
        if (Object.keys(patch).length) s.updateTab({ tabId, ...patch })
      }
      subs.push(
        term.onWriteParsed(() => {
          lastOutput.set(tabId, Date.now())
          if (!raf) raf = requestAnimationFrame(check)
        }),
        term.onBell(() => {
          const s = useUi.getState()
          if (s.activeTabId !== tabId) s.updateTab({ tabId, bell: true })
        })
      )
    }
    attach()
    return () => {
      clearTimeout(poll)
      cancelAnimationFrame(raf)
      subs.forEach((d) => d.dispose())
      lastOutput.delete(tabId)
    }
  }, [tabId])
  return null
}

/** Renders every terminal once. Placement is done by the pane slots (see `attachTerminal`). */
export function TerminalHost(): React.JSX.Element {
  const tabs = useUi((s) => s.tabs)
  const ws = useUi(activeWorkspace)
  const parkRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    park = parkRef.current
    for (const el of containers.values()) if (!el.parentElement) park?.appendChild(el)
  }, [])

  // Keyboard focus follows the focused pane synchronously, so keys typed right after
  // Ctrl+Alt+Arrow, Ctrl+Tab or closing a pane land in the new pane, not the old one.
  // Only when focus is already in the terminal area (never steal it from a dialog or the AI input).
  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        const ws = activeWorkspace(s)
        if (!ws) return
        const prevWs = activeWorkspace(prev)
        if (s.activeTabId === prev.activeTabId && ws.focusedPaneId === prevWs?.focusedPaneId) return
        const a = document.activeElement
        if (a && a !== document.body && !a.closest('[data-terminal-area]')) return
        const h = s.activeTabId ? terminals.get(s.activeTabId) : undefined
        if (h) h.focus()
        else document.querySelector<HTMLInputElement>(`[data-pane-id="${ws.focusedPaneId}"] [data-launcher] input`)?.focus()
      }),
    []
  )

  // Drop containers of closed tabs (their portals have already unmounted).
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.tabId))
    for (const [id, el] of containers) {
      if (!live.has(id)) {
        el.remove()
        containers.delete(id)
      }
    }
  }, [tabs])

  const visible = new Set<string>()
  let focused: string | null = null
  if (ws) {
    for (const p of panes(ws.root)) if (p.tabId && (!ws.zoomedPaneId || p.id === ws.zoomedPaneId)) visible.add(p.tabId)
    focused = findPane(ws.root, ws.focusedPaneId)?.tabId ?? null
  }

  return (
    <div ref={parkRef} hidden aria-hidden data-terminal-park="">
      {tabs.map((t) =>
        createPortal(
          <>
            <MountProbe tabId={t.tabId} />
            <Watch tabId={t.tabId} />
            <TerminalView tab={t} active={visible.has(t.tabId)} focused={focused === t.tabId} />
          </>,
          terminalContainer(t.tabId),
          t.tabId
        )
      )}
    </div>
  )
}
