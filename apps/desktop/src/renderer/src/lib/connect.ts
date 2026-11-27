import { toast } from './notify'
import type { Folder, Session } from '@shared/types'
import { useUi } from '../store'
import { askText } from './prompt'
import { rememberEndpoint } from './quick-history'
import { quickSessionInput, type QuickTarget } from './quickconnect'

/** Open a new tab for a session. Terminal sizing happens once the xterm mounts. */
export function openSession(s: Session): void {
  const tabId = crypto.randomUUID()
  useUi.getState().addTab({ tabId, sessionId: s.id, title: s.name, state: 'connecting' })
}

/** Focus the session if it is already open in a tab or pane, otherwise open it in a new tab. */
export function focusOrOpen(s: Session): void {
  const ui = useUi.getState()
  const open = ui.tabs.find((t) => t.sessionId === s.id && t.tabId === ui.activeTabId) ?? ui.tabs.find((t) => t.sessionId === s.id)
  if (open) ui.activate(open.tabId)
  else openSession(s)
}

/** Open a session in a new pane split to the right of the focused one (or a new tab if none). */
export function openInSplit(s: Session): void {
  const ui = useUi.getState()
  const paneId = ui.split('row')
  if (paneId) ui.openInPane(paneId, s)
  else openSession(s)
}

/** "Lab / Core": the folder path of a session, for secondary text. */
export function folderPath(folders: Folder[], folderId: string | null): string {
  const parts: string[] = []
  let id = folderId
  for (let depth = 0; id && depth < 32; depth++) {
    const f = folders.find((x) => x.id === id)
    if (!f) break
    parts.unshift(f.name)
    id = f.parentId
  }
  return parts.join(' / ')
}

export function notifyError(title: string, e: unknown): void {
  toast.error(title, { description: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) })
}

/**
 * Quick connect: main registers an unsaved session (same path to the session host as a saved one)
 * and a tab opens for it. SSH without a user asks for one first.
 */
export async function quickConnect(target: QuickTarget): Promise<Session | undefined> {
  const s = await createQuickSession(target)
  if (s) openSession(s)
  return s
}

/** Register a quick-connect session with main without opening it (the empty-pane launcher opens it in place). */
export async function createQuickSession(target: QuickTarget): Promise<Session | undefined> {
  let t = target
  if (t.protocol === 'ssh' && !t.username) {
    const user = (await askText(`Username for ${t.label}`, '', { description: 'Add it next time as user@host.' }))?.trim()
    if (!user) return undefined
    t = { ...t, username: user, label: `${user}@${t.label}` }
  }
  try {
    const s = await window.hopline.sessions.createEphemeral(quickSessionInput(t))
    const ui = useUi.getState()
    // Callers open a tab right away (same tick): the store drops quick sessions no tab uses.
    ui.set({ quick: [...ui.quick, s] })
    rememberEndpoint(t)
    return s
  } catch (e) {
    notifyError('Quick connect failed', e)
    return undefined
  }
}

/** Tab context menu: keep a quick-connect session. The tab stays connected; it now points at the saved one. */
export async function saveQuickSession(id: string): Promise<void> {
  const ui = useUi.getState()
  const q = ui.quick.find((x) => x.id === id)
  if (!q) return
  const name = (await askText('Save as session', q.name, { description: `${q.protocol.toUpperCase()} ${q.host}${q.port ? ':' + q.port : ''}` }))?.trim()
  if (!name) return
  try {
    const saved = await window.hopline.sessions.saveEphemeral(id, { name, folderId: null })
    await useUi.getState().load()
    const now = useUi.getState()
    useUi.setState({
      quick: now.quick.filter((x) => x.id !== id),
      tabs: now.tabs.map((t) => (t.sessionId === id ? { ...t, title: saved.name } : t))
    })
    toast.success(`Saved ${saved.name}`, { action: { label: 'Edit', onClick: () => useUi.getState().set({ editing: { open: true, session: saved } }) } })
  } catch (e) {
    notifyError('Could not save session', e)
  }
}
