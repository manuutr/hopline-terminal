import { errorText } from './lib/errors'
import { toast } from './lib/notify'
import { create } from 'zustand'
import { useDrafts } from './features/ai/drafts'
import type { ConnState, CredentialInfo, Folder, Session, Settings, TabInfo, VaultInfo } from '@shared/types'
import {
  closePane as closeNode,
  deserialize,
  findPane,
  focusAfterClose,
  focusDirection,
  nodeId,
  pane,
  paneOfTab,
  panes,
  pruneLayout,
  serialize,
  setPaneTab,
  setSizes as setNodeSizes,
  splitPane,
  toggleZoom as zoomToggle,
  touchMru,
  type FocusDir,
  type LayoutNode,
  type SerializedNode,
  type SplitDir
} from './lib/layout'

/** One terminal: a connection to one session. `tabId` is its id for IPC and the AI thread. */
export interface Tab {
  tabId: string
  sessionId: string
  title: string
  state: ConnState
  detail?: string
  logPath?: string
  /** Agent is currently driving this tab (input is locked in main). */
  agentBusy?: boolean
  /** Prompt shows a configuration mode, e.g. "(config-if)#". */
  configMode?: boolean
  /** BEL received while the pane was not focused. */
  bell?: boolean
  /** Output arrived while the pane was not visible. */
  unread?: boolean
}

/**
 * An entry in the Open connections list. It owns a split-pane tree whose panes each hold one terminal (or the
 * "Connect to…" launcher). A tab with one pane looks and behaves like a plain terminal tab.
 */
export interface Workspace {
  id: string
  root: LayoutNode
  focusedPaneId: string
  zoomedPaneId: string | null
}

export interface ClosedTab {
  title: string
  layout: SerializedNode
}

interface UiState {
  folders: Folder[]
  sessions: Session[]
  /** Quick-connect sessions main knows about but never stored (until "Save as session"). */
  quick: Session[]
  credentials: CredentialInfo[]
  settings: Settings | null
  vault: VaultInfo | null
  /** Every open terminal, across all workspaces. */
  tabs: Tab[]
  workspaces: Workspace[]
  activeWsId: string | null
  /** The focused pane's terminal in the active workspace (null for an empty pane). */
  activeTabId: string | null
  /** Workspace ids, most recently used first (Ctrl+Tab). */
  mru: string[]
  /** Recently closed tabs, newest last (Mod+T). */
  closed: ClosedTab[]
  sidebarOpen: boolean
  aiOpen: boolean
  paletteOpen: boolean
  switcherOpen: boolean
  editing: { session?: Partial<Session>; open: boolean }
  /** Session ids for the bulk edit dialog (null: closed). */
  bulkEdit: string[] | null
  quickOpen: boolean
  settingsOpen: boolean
  auditOpen: boolean
  /** The keyboard shortcut sheet (Mod+/). */
  shortcutsOpen: boolean

  /** The first load of sessions, credentials and settings has finished (or failed: `loadError`). */
  loaded: boolean
  loadError: string | null
  load: () => Promise<void>
  setSettings: (s: Settings) => void
  /** Open a terminal in a new tab. */
  addTab: (t: Tab) => void
  updateTab: (info: Partial<Tab> & { tabId: string }) => void
  /** Close one terminal (and its pane). */
  closeTab: (tabId: string) => void
  /** Focus a terminal: its workspace becomes active and its pane focused. */
  activate: (tabId: string | null) => void
  activateWs: (wsId: string) => void
  focusPane: (paneId: string) => void
  focusDir: (dir: FocusDir) => boolean
  /** Split the focused pane; returns the new (empty) pane's id. */
  split: (dir: SplitDir) => string | null
  /** Open a session in an (empty) pane. */
  openInPane: (paneId: string, session: Session) => void
  closePane: (paneId: string) => void
  closeWorkspace: (wsId: string) => void
  toggleZoom: () => void
  setSplitSizes: (wsId: string, splitId: string, sizes: number[]) => void
  splitWorkspace: (sourceId: string, targetPane: string, dir: SplitDir) => void
  moveWs: (wsId: string, to: number) => void
  reopenClosed: () => void
  set: (patch: Partial<UiState>) => void
}

const MAX_CLOSED = 20

const newTab = (s: Session): Tab => ({ tabId: crypto.randomUUID(), sessionId: s.id, title: s.name, state: 'connecting' })

const closeTerminal = (tabId: string) => {
  useDrafts.getState().clear(tabId)
  void window.hopline?.term.close(tabId).catch(() => {})
}

type Core = Pick<UiState, 'tabs' | 'workspaces' | 'activeWsId' | 'activeTabId' | 'mru'>

/**
 * Recompute derived fields after any layout change: the active terminal, the MRU order, and the
 * attention flags that no longer apply (unread is cleared once visible, bell once focused).
 */
function derive(s: Pick<Core, 'tabs' | 'workspaces' | 'activeWsId' | 'mru'>): Core {
  const ws = s.workspaces.find((w) => w.id === s.activeWsId) ?? s.workspaces.at(-1)
  const activeWsId = ws?.id ?? null
  const activeTabId = (ws && findPane(ws.root, ws.focusedPaneId)?.tabId) ?? null
  const visible = new Set(
    ws ? panes(ws.root).filter((p) => !ws.zoomedPaneId || p.id === ws.zoomedPaneId).flatMap((p) => (p.tabId ? [p.tabId] : [])) : []
  )
  let changed = false
  const tabs = s.tabs.map((t) => {
    const unread = t.unread && !visible.has(t.tabId)
    const bell = t.bell && t.tabId !== activeTabId
    if (unread === t.unread && bell === t.bell) return t
    changed = true
    return { ...t, unread, bell }
  })
  const ids = s.workspaces.map((w) => w.id)
  const mru = activeWsId ? touchMru(s.mru, activeWsId, ids) : s.mru.filter((x) => ids.includes(x))
  return { tabs: changed ? tabs : s.tabs, workspaces: s.workspaces, activeWsId, activeTabId, mru }
}

const wsOfPane = (workspaces: Workspace[], paneId: string) => workspaces.find((w) => findPane(w.root, paneId))
const wsOfTab = (workspaces: Workspace[], tabId: string) => workspaces.find((w) => paneOfTab(w.root, tabId))

export const useUi = create<UiState>((set, get) => {
  /** Apply a layout change and recompute derived state. */
  const commit = (patch: Partial<Pick<Core, 'tabs' | 'workspaces' | 'activeWsId'>> & { closed?: ClosedTab[] }) => {
    const s = get()
    const { closed, ...core } = patch
    const next = derive({ tabs: s.tabs, workspaces: s.workspaces, activeWsId: s.activeWsId, mru: s.mru, ...core })
    // Main forgets a quick-connect session when its last tab closes; so does the renderer.
    const quick = s.quick.some((q) => !next.tabs.some((t) => t.sessionId === q.id)) ? s.quick.filter((q) => next.tabs.some((t) => t.sessionId === q.id)) : s.quick
    set({ ...next, quick, ...(closed ? { closed } : {}) })
  }
  const updateWs = (wsId: string, f: (w: Workspace) => Workspace) => get().workspaces.map((w) => (w.id === wsId ? f(w) : w))
  const remember = (title: string, layout: LayoutNode): ClosedTab[] => {
    const tabs = get().tabs
    const data = serialize(layout, (id) => tabs.find((t) => t.tabId === id)?.sessionId)
    if (!panes(layout).some((p) => p.tabId)) return get().closed
    return [...get().closed, { title, layout: data }].slice(-MAX_CLOSED)
  }
  const titleOf = (w: Workspace) => {
    const tabs = get().tabs
    const p = findPane(w.root, w.focusedPaneId)
    return tabs.find((t) => t.tabId === p?.tabId)?.title ?? tabs.find((t) => panes(w.root).some((x) => x.tabId === t.tabId))?.title ?? 'tab'
  }

  return {
    folders: [],
    sessions: [],
    quick: [],
    credentials: [],
    settings: null,
    vault: null,
    tabs: [],
    workspaces: [],
    activeWsId: null,
    activeTabId: null,
    mru: [],
    closed: [],
    sidebarOpen: true,
    // P1-8: closed until there is a key (first settings load) or the user asks (@ai, Explain, Mod+I).
    aiOpen: false,
    paletteOpen: false,
    switcherOpen: false,
    editing: { open: false },
    bulkEdit: null,
    quickOpen: false,
    settingsOpen: false,
    auditOpen: false,
    shortcutsOpen: false,

    loaded: false,
    loadError: null,
    load: async () => {
      try {
        const [{ folders, sessions }, credentials, settings, vault] = await Promise.all([
          window.hopline.sessions.list(),
          window.hopline.credentials.list(),
          window.hopline.settings.get(),
          window.hopline.vault.status()
        ])
        set({ folders, sessions, credentials, settings, vault, loaded: true, loadError: null })
      } catch (e) {
        // Shown in the sidebar and the launcher instead of "No sessions yet", which would be a lie.
        set({ loaded: true, loadError: errorText(e) })
      }
    },
    setSettings: (settings) => set((st) => (st.settings === null && settings.aiConfigured ? { settings, aiOpen: true } : { settings })),

    addTab: (t) => {
      const p = pane(t.tabId)
      const ws: Workspace = { id: nodeId('w'), root: p, focusedPaneId: p.id, zoomedPaneId: null }
      commit({ tabs: [...get().tabs, t], workspaces: [...get().workspaces, ws], activeWsId: ws.id })
    },
    updateTab: (info) => set({ tabs: get().tabs.map((t) => (t.tabId === info.tabId ? { ...t, ...info } : t)) }),

    closeTab: (tabId) => {
      const ws = wsOfTab(get().workspaces, tabId)
      const p = ws && paneOfTab(ws.root, tabId)
      if (p) get().closePane(p.id)
      else {
        closeTerminal(tabId)
        commit({ tabs: get().tabs.filter((t) => t.tabId !== tabId) })
      }
    },

    activate: (tabId) => {
      if (!tabId) return
      const ws = wsOfTab(get().workspaces, tabId)
      const p = ws && paneOfTab(ws.root, tabId)
      if (!ws || !p) return
      commit({ workspaces: updateWs(ws.id, (w) => ({ ...w, focusedPaneId: p.id, zoomedPaneId: w.zoomedPaneId && w.zoomedPaneId !== p.id ? null : w.zoomedPaneId })), activeWsId: ws.id })
    },
    activateWs: (wsId) => {
      if (get().workspaces.some((w) => w.id === wsId)) commit({ activeWsId: wsId })
    },
    focusPane: (paneId) => {
      const ws = wsOfPane(get().workspaces, paneId)
      if (!ws) return
      if (ws.focusedPaneId === paneId && get().activeWsId === ws.id) return
      commit({ workspaces: updateWs(ws.id, (w) => ({ ...w, focusedPaneId: paneId })), activeWsId: ws.id })
    },
    focusDir: (dir) => {
      const ws = get().workspaces.find((w) => w.id === get().activeWsId)
      if (!ws || ws.zoomedPaneId) return false
      const next = focusDirection(ws.root, ws.focusedPaneId, dir)
      if (!next) return false
      get().focusPane(next)
      return true
    },

    split: (dir) => {
      const ws = get().workspaces.find((w) => w.id === get().activeWsId)
      if (!ws) return null
      const added = pane(null)
      commit({
        workspaces: updateWs(ws.id, (w) => ({ ...w, root: splitPane(w.root, w.focusedPaneId, dir, added), focusedPaneId: added.id, zoomedPaneId: null }))
      })
      return added.id
    },
    openInPane: (paneId, session) => {
      const ws = wsOfPane(get().workspaces, paneId)
      const p = ws && findPane(ws.root, paneId)
      if (!ws || !p) return
      if (p.tabId) closeTerminal(p.tabId)
      const t = newTab(session)
      commit({
        tabs: [...get().tabs.filter((x) => x.tabId !== p.tabId), t],
        workspaces: updateWs(ws.id, (w) => ({ ...w, root: setPaneTab(w.root, paneId, t.tabId), focusedPaneId: paneId })),
        activeWsId: ws.id
      })
    },

    closePane: (paneId) => {
      const s = get()
      const ws = wsOfPane(s.workspaces, paneId)
      const p = ws && findPane(ws.root, paneId)
      if (!ws || !p) return
      const root = closeNode(ws.root, paneId)
      if (!root) return get().closeWorkspace(ws.id)
      if (p.tabId) closeTerminal(p.tabId)
      const closed = p.tabId ? remember(s.tabs.find((t) => t.tabId === p.tabId)?.title ?? 'pane', p) : s.closed
      // Focus moves to the pane that took the space: one in the sibling inside the same split.
      const focus = ws.focusedPaneId === paneId ? (focusAfterClose(ws.root, paneId) ?? panes(root)[0]!.id) : ws.focusedPaneId
      commit({
        tabs: s.tabs.filter((t) => t.tabId !== p.tabId),
        workspaces: updateWs(ws.id, (w) => ({ ...w, root, focusedPaneId: focus, zoomedPaneId: w.zoomedPaneId === paneId ? null : w.zoomedPaneId })),
        closed
      })
    },
    closeWorkspace: (wsId) => {
      const s = get()
      const idx = s.workspaces.findIndex((w) => w.id === wsId)
      const ws = s.workspaces[idx]
      if (!ws) return
      const ids = new Set(panes(ws.root).flatMap((p) => (p.tabId ? [p.tabId] : [])))
      ids.forEach(closeTerminal)
      const closed = remember(titleOf(ws), ws.root)
      const workspaces = s.workspaces.filter((w) => w.id !== wsId)
      // Same rule as before splits existed: closing the active tab activates its left neighbour.
      const activeWsId = s.activeWsId === wsId ? (workspaces[Math.max(0, idx - 1)]?.id ?? null) : s.activeWsId
      commit({ tabs: s.tabs.filter((t) => !ids.has(t.tabId)), workspaces, activeWsId, closed })
    },

    toggleZoom: () => {
      const ws = get().workspaces.find((w) => w.id === get().activeWsId)
      if (!ws) return
      commit({ workspaces: updateWs(ws.id, (w) => ({ ...w, zoomedPaneId: zoomToggle(w.root, w.zoomedPaneId, w.focusedPaneId) })) })
    },
    setSplitSizes: (wsId, splitId, sizes) => set({ workspaces: updateWs(wsId, (w) => ({ ...w, root: setNodeSizes(w.root, splitId, sizes) })) }),
    splitWorkspace: (sourceId, targetPane, dir) => {
      const state = get()
      const source = state.workspaces.find((w) => w.id === sourceId)
      let target = wsOfPane(state.workspaces, targetPane)
      if (!source || !target) return
      if (source === target) {
        target = state.workspaces.find((w) => w.id !== sourceId)
        if (!target) { get().focusPane(targetPane); get().split(dir); return }
        targetPane = target.focusedPaneId
      }
      const root = splitPane(target.root, targetPane, dir, source.root)
      const joined = { ...target, root, zoomedPaneId: null, focusedPaneId: source.focusedPaneId }
      commit({ workspaces: state.workspaces.filter((w) => w.id !== source.id).map((w) => w.id === joined.id ? joined : w), activeWsId: joined.id })
    },
    moveWs: (wsId, to) => {
      const list = [...get().workspaces]
      const from = list.findIndex((w) => w.id === wsId)
      if (from < 0) return
      const dest = Math.max(0, Math.min(list.length - 1, to))
      if (dest === from) return
      const [w] = list.splice(from, 1)
      list.splice(dest, 0, w!)
      set({ workspaces: list })
    },

    reopenClosed: () => {
      const s = get()
      const last = s.closed.at(-1)
      if (!last) return
      // Sessions deleted since the tab was closed are skipped; with none left there is nothing to reopen.
      const layout = pruneLayout(last.layout, (id) => s.sessions.some((x) => x.id === id))
      if (!layout) {
        set({ closed: s.closed.slice(0, -1) })
        // Quick-connect sessions end with their tab (ids from main's EphemeralSessions start with "quick-").
        const quick = JSON.stringify(last.layout).includes('"quick-')
        toast(`Cannot reopen ${last.title}`, {
          description: quick ? 'Quick connect tabs are not kept. Connect again, or use Save as session next time.' : 'Its sessions have been deleted.'
        })
        return
      }
      const added: Tab[] = []
      const root = deserialize(layout, (sessionId) => {
        const session = s.sessions.find((x) => x.id === sessionId)
        if (!session) return null
        const t = newTab(session)
        added.push(t)
        return t.tabId
      })
      const first = panes(root).find((p) => p.tabId) ?? panes(root)[0]!
      const ws: Workspace = { id: nodeId('w'), root, focusedPaneId: first.id, zoomedPaneId: null }
      commit({ tabs: [...s.tabs, ...added], workspaces: [...s.workspaces, ws], activeWsId: ws.id, closed: s.closed.slice(0, -1) })
    },

    set: (patch) => set(patch)
  }
})

export const activeTab = (s: UiState): Tab | undefined => s.tabs.find((t) => t.tabId === s.activeTabId)

/** A saved or quick-connect session by id. Use this, not `sessions.find`, for anything a tab points at. */
export const sessionById = (s: Pick<UiState, 'sessions' | 'quick'>, id: string | undefined): Session | undefined =>
  id === undefined ? undefined : (s.sessions.find((x) => x.id === id) ?? s.quick.find((x) => x.id === id))
export const activeWorkspace = (s: UiState): Workspace | undefined => s.workspaces.find((w) => w.id === s.activeWsId)

/** Push main-process tab state into the store. */
export function syncTabState(info: TabInfo): void {
  const ui = useUi.getState()
  const before = ui.tabs.find((t) => t.tabId === info.tabId)?.state
  ui.updateTab({ tabId: info.tabId, state: info.state, detail: info.detail, logPath: info.logPath })
  // Main stamps lastConnectedAt in the database; mirror it so Recent updates without a reload.
  if (info.state === 'connected' && before !== 'connected' && ui.sessions.some((s) => s.id === info.sessionId)) {
    const at = Date.now()
    useUi.setState({ sessions: useUi.getState().sessions.map((s) => (s.id === info.sessionId ? { ...s, lastConnectedAt: at } : s)) })
  }
}

// Read-only test hook: which tab has focus (used by e2e with __hoplineTest.selection()).
;(window as unknown as { __hoplineActiveTab: () => string | null }).__hoplineActiveTab = () => useUi.getState().activeTabId
