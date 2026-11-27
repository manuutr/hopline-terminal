import { toast } from '../../lib/notify'
import { create } from 'zustand'
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'
import type { ConflictChoice, FilesInfo, OverwritePolicy, QueueResult, TransferConflict, TransferItem } from '@shared/files'

interface FilesState {
  /** The files panel is open (it follows the active tab). */
  open: boolean
  /** Transfers of this window, in queue order. */
  items: TransferItem[]
  /** Per tab: the file channel (SFTP/SCP) and the folder being browsed. */
  byTab: Record<string, { info?: FilesInfo; cwd?: string; error?: string; shellDir?: string; followShell?: boolean }>
  policy: OverwritePolicy
  showHidden: boolean
  /** Conflicts waiting for the user, answered one at a time. */
  conflicts: TransferConflict[]
  downloadDir: string | null
  /** The queue lists every tab's transfers instead of the active tab's. */
  allTabs: boolean
  /** Narrow panel: the transfer queue shows as an overlay while this is on. */
  queueOpen: boolean
  /** Opening the panel asks the browser to take focus once it is ready (consumed by `takeFocus`). */
  wantFocus: boolean
  /** When Esc last moved focus from the panel to the terminal (a second Esc soon after closes it). */
  escAt: number
  set: (p: Partial<FilesState>) => void
}

const POLICY_KEY = 'hopline.files.policy'
const HIDDEN_KEY = 'hopline.files.hidden'
const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* per-viewer convenience only */
  }
}

const storedPolicy = read(POLICY_KEY)
export const useFiles = create<FilesState>((set) => ({
  open: false,
  items: [],
  byTab: {},
  policy: storedPolicy === 'skip' || storedPolicy === 'overwrite' || storedPolicy === 'rename' ? storedPolicy : 'ask',
  showHidden: read(HIDDEN_KEY) === '1',
  conflicts: [],
  downloadDir: null,
  allTabs: false,
  queueOpen: false,
  wantFocus: false,
  escAt: 0,
  set: (p) => {
    if (p.policy) write(POLICY_KEY, p.policy)
    if (p.showHidden !== undefined) write(HIDDEN_KEY, p.showHidden ? '1' : '0')
    set(p)
  }
}))

let subscribed = false
/** Listen to transfer events once per window. */
export function subscribeTransfers(): void {
  if (subscribed || !window.hopline?.transfer) return
  subscribed = true
  const api = window.hopline.transfer
  void api.list().then((items) => useFiles.setState({ items }))
  void api.downloadDir().then((downloadDir) => useFiles.setState({ downloadDir }))
  api.onEvent((e) => {
    const s = useFiles.getState()
    if (e.kind === 'removed') return useFiles.setState({ items: s.items.filter((i) => i.id !== e.id) })
    const i = s.items.findIndex((x) => x.id === e.item.id)
    const prev = i >= 0 ? s.items[i] : undefined
    const items = i >= 0 ? s.items.map((x, j) => (j === i ? e.item : x)) : [...s.items, e.item]
    useFiles.setState({ items })
    // A finished upload or download refreshes the folder it touched.
    if (prev?.state === 'running' && e.item.state !== 'running') {
      if (e.item.state === 'error') toast.error(`${e.item.direction === 'upload' ? 'Upload' : 'Download'} failed: ${e.item.localName}`, { description: e.item.error })
      refreshers.get(e.item.tabId)?.()
    }
  })
}

/** Folder refresh callbacks, by tab (set by the open panel). */
export const refreshers = new Map<string, () => void>()

export function openFiles(tabId?: string): void {
  useFiles.setState({ open: true, wantFocus: true, escAt: 0 })
  if (tabId) void ensureInfo(tabId)
}

/** Give the keyboard back to the focused pane's terminal. */
export function focusTerminal(): void {
  const id = useUi.getState().activeTabId
  if (id) terminals.get(id)?.focus()
}

/** Close the panel; focus inside it goes back to the terminal instead of being dropped on <body>. */
export function closeFiles(): void {
  const inside = !!document.activeElement?.closest('[data-files-panel]')
  useFiles.setState({ open: false, queueOpen: false, wantFocus: false, escAt: 0 })
  if (inside) focusTerminal()
}

/**
 * Esc model: Esc in the panel gives focus back to the terminal; a second Esc within
 * SECOND_ESC_MS (focus now in the terminal) closes the panel and is not sent to the device.
 * Later Escs reach the device as usual. Installed once by the panel.
 */
export function installSecondEsc(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
    const s = useFiles.getState()
    if (!s.open || !s.escAt || Date.now() - s.escAt > SECOND_ESC_MS) return
    if (!(e.target as Element | null)?.closest?.('.xterm')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    closeFiles()
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}

/**
 * Focus `el` if the panel asked for focus on open; true when it did. `interim` focuses without
 * settling the request (the panel itself while the list is still loading).
 */
export function takeFocus(el: HTMLElement | null | undefined, interim = false): boolean {
  if (!el || !useFiles.getState().wantFocus) return false
  if (!interim) useFiles.setState({ wantFocus: false })
  el.focus({ preventScroll: true })
  return true
}

/** How long after Esc moved focus to the terminal a second Esc closes the panel (and is not sent). */
export const SECOND_ESC_MS = 1500

export async function ensureInfo(tabId: string, force = false): Promise<FilesInfo | undefined> {
  const cur = useFiles.getState().byTab[tabId]
  if (cur?.info && !force) return cur.info
  try {
    const info = await window.hopline.transfer.open(tabId)
    useFiles.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId], info, cwd: s.byTab[tabId]?.cwd ?? info.home, error: undefined } } }))
    return info
  } catch (e) {
    const error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
    useFiles.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId], info: undefined, error } } }))
    return undefined
  }
}

export const cleanError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Report a queue result: conflicts go to the conflict dialog, refusals to a toast. */
export function handleQueue(r: QueueResult | null): void {
  if (!r) return
  if (r.skipped.length) {
    const s = r.skipped
    toast(s.length === 1 ? `Skipped ${s[0]!.name}` : `Skipped ${s.length} items`, { description: s.length === 1 ? s[0]!.reason : s.map((x) => `${x.name}: ${x.reason}`).join('\n') })
  }
  if (r.conflicts.length) useFiles.setState((st) => ({ conflicts: [...st.conflicts, ...r.conflicts] }))
}

export async function answerConflict(c: TransferConflict, choice: ConflictChoice): Promise<void> {
  useFiles.setState((s) => ({ conflicts: s.conflicts.filter((x) => x.token !== c.token) }))
  try {
    const r = await window.hopline.transfer.resolve(c.token, choice)
    // The user just chose Skip: no toast to say so.
    handleQueue(choice === 'skip' ? { ...r, skipped: [] } : r)
  } catch (e) {
    toast.error('Could not queue the transfer', { description: cleanError(e) })
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return ''
  if (s < 60) return `${Math.ceil(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

/** Working-directory reports stay in the window and never change the SSH endpoint. */
export function reportShellDirectory(tabId: string, shellDir: string): void {
  useFiles.setState((s) => {
    const row = s.byTab[tabId]
    if (row?.shellDir === shellDir) return s
    return { byTab: { ...s.byTab, [tabId]: { ...row, shellDir, ...(row?.followShell && { cwd: shellDir }) } } }
  })
}
