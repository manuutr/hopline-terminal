import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { Button, Dialog } from '../design'
import { useAi } from '../features/ai/store'
import { activeWorkspace, useUi } from '../store'
import { findPane, panes } from './layout'
import { terminals } from './terminals'

export interface ConfirmOptions {
  /** 'danger' (default) for destructive actions, 'primary' for a plain go-ahead. */
  tone?: 'danger' | 'primary'
  /** Monospace preview under the description (e.g. the lines about to be pasted). */
  preview?: string
  /** Cancel has focus, so Enter does not confirm (stopping a fleet lane or run: review P2). */
  defaultCancel?: boolean
  /** The cancel button's label (default "Cancel"). */
  cancel?: string
  /** On close, focus goes back where it was (a dialog under this one), not to the terminal. */
  keepFocus?: boolean
}

interface ConfirmRequest extends ConfirmOptions {
  title: string
  description: string
  confirm: string
  resolve: (ok: boolean) => void
}
const useConfirm = create<{ req: ConfirmRequest | null }>(() => ({ req: null }))

/** A confirm is showing (a shortcut must not open another one over it and orphan its answer). */
export const confirmOpen = (): boolean => !!useConfirm.getState().req



/** A small yes/no dialog. Enter confirms (the confirm button has focus), Esc cancels. */
export function askConfirm(title: string, description: string, confirm = 'OK', opts: ConfirmOptions = {}): Promise<boolean> {
  useConfirm.getState().req?.resolve(false)
  return new Promise((resolve) => useConfirm.setState({ req: { title, description, confirm, ...opts, resolve } }))
}

export function ConfirmHost(): React.JSX.Element {
  const req = useConfirm((s) => s.req)
  const ok = useRef<HTMLButtonElement>(null)
  const no = useRef<HTMLButtonElement>(null)
  const keep = useRef(false)
  const done = (v: boolean) => {
    keep.current = !!req?.keepFocus
    req?.resolve(v)
    // Unmount now (and with it the focus trap), then focus the terminal in the same task: Radix's
    // own close autofocus runs a tick later, and keys typed in that gap would land on the page.
    flushSync(() => useConfirm.setState({ req: null }))
    if (keep.current) return
    const id = useUi.getState().activeTabId
    if (id) terminals.get(id)?.focus()
  }
  // Esc is the confirm's, even over another dialog: Radix handed it to the dialog underneath (the
  // fleet view closed and left the confirm up). A window capture listener runs before Radix's own.
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      done(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  return (
    <Dialog
      open={!!req}
      onOpenChange={(o) => !o && done(false)}
      title={req?.title ?? ''}
      className="w-[min(420px,92vw)]"
      variant="alert"
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        ;(req?.defaultCancel ? no : ok).current?.focus()
      }}
      onCloseAutoFocus={(e) => {
        // Radix puts focus back where it was (inside the dialog under this one).
        if (keep.current) return
        // The element focused before may belong to the terminal that was just closed: focus the active one.
        // Synchronously, so keys typed right after Esc reach the device instead of the page.
        e.preventDefault()
        const id = useUi.getState().activeTabId
        if (id) terminals.get(id)?.focus()
      }}
      footer={
        <>
          <Button ref={no} variant="secondary" onClick={() => done(false)}>
            {req?.cancel ?? 'Cancel'}
          </Button>
          <Button ref={ok} variant={req?.tone === 'primary' ? 'primary' : 'danger'} onClick={() => done(true)}>
            {req?.confirm}
          </Button>
        </>
      }
    >
      <p>{req?.description}</p>
      {req?.preview && (
        <pre className="selectable mt-3 max-h-40 overflow-auto whitespace-pre rounded-md border border-line bg-term px-2.5 py-2 font-mono text-xs leading-5 text-fg">{req.preview}</pre>
      )}
    </Dialog>
  )
}

/** Why closing these terminals needs a confirmation, or undefined when they can close right away. */
export function liveReason(tabIds: string[]): string | undefined {
  const { tabs } = useUi.getState()
  const ai = useAi.getState().byTab
  const list = tabs.filter((t) => tabIds.includes(t.tabId))
  if (list.some((t) => ai[t.tabId]?.runId || t.agentBusy)) return 'The AI agent is working on it and will be stopped.'
  if (list.some((t) => ai[t.tabId]?.entries.some((e) => e.kind === 'proposal' && e.state === 'pending')))
    return 'The AI agent has a change proposal waiting for your approval.'
  const live = list.filter((t) => t.state === 'connected')
  if (live.length > 1) return `${live.length} sessions are connected and will be disconnected.`
  if (live.length) return 'The session is connected and will be disconnected.'
  return undefined
}

const titleOf = (tabIds: string[], fallback: string) => useUi.getState().tabs.find((t) => t.tabId === tabIds[0])?.title ?? fallback

/** Close a pane, asking first when its session is live. Empty, down or idle panes close at once. */
export async function requestClosePane(paneId: string): Promise<void> {
  const ws = useUi.getState().workspaces.find((w) => findPane(w.root, paneId))
  const tabId = ws && findPane(ws.root, paneId)?.tabId
  const ids = tabId ? [tabId] : []
  const why = liveReason(ids)
  const multi = !!ws && panes(ws.root).length > 1
  if (why && !(await askConfirm(`Close ${titleOf(ids, 'pane')}?`, why, multi ? 'Close pane' : 'Close tab'))) return
  useUi.getState().closePane(paneId)
}

/** Close the focused pane of the active tab (Mod+W). */
export function requestCloseFocusedPane(): void {
  const ws = activeWorkspace(useUi.getState())
  if (ws) void requestClosePane(ws.focusedPaneId)
}

/** Close a whole tab (all its panes), asking first when any of its sessions is live. */
/** Close several tabs (Close others, Close tabs below): one question for all of them. */
export async function requestCloseWorkspaces(wsIds: string[]): Promise<void> {
  const list = useUi.getState().workspaces.filter((w) => wsIds.includes(w.id))
  if (!list.length) return
  const ids = list.flatMap((ws) => panes(ws.root).flatMap((p) => (p.tabId ? [p.tabId] : [])))
  const why = liveReason(ids)
  if (why && !(await askConfirm(`Close ${list.length} tab${list.length === 1 ? '' : 's'}?`, why, 'Close tabs'))) return
  for (const ws of list) useUi.getState().closeWorkspace(ws.id)
}

export async function requestCloseWorkspace(wsId: string): Promise<void> {
  const ws = useUi.getState().workspaces.find((w) => w.id === wsId)
  if (!ws) return
  const ids = panes(ws.root).flatMap((p) => (p.tabId ? [p.tabId] : []))
  const why = liveReason(ids)
  const focused = findPane(ws.root, ws.focusedPaneId)?.tabId
  const name = titleOf(focused ? [focused] : ids, 'tab')
  const title = ids.length > 1 ? `Close ${name} and ${ids.length - 1} more pane${ids.length > 2 ? 's' : ''}?` : `Close ${name}?`
  if (why && !(await askConfirm(title, why, 'Close tab'))) return
  useUi.getState().closeWorkspace(wsId)
}
