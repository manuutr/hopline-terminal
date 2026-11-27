import { create } from 'zustand'
import type { Settings } from '@shared/types'
import { effectiveSettings, OVERRIDES_DEFAULT, pruneOverrides, resolveOverrides, type HostOverrides, type OverrideStore } from '@shared/ux'
import { sessionById, useUi } from '../../store'

interface OverridesState {
  store: OverrideStore
  load: () => Promise<void>
  /** Replace one session's or folder's overrides (empty: inherit everything). */
  set: (scope: 'session' | 'folder', id: string, o: HostOverrides) => Promise<void>
}

/** Per-session and per-folder overrides (Settings that a scope changes for everything below it). */
export const useOverrides = create<OverridesState>((set, get) => ({
  store: OVERRIDES_DEFAULT,
  load: async () => set({ store: await window.hopline.ux.overrides.get() }),
  set: async (scope, id, o) => {
    const cur = get().store
    const key = scope === 'session' ? 'sessions' : 'folders'
    const next: OverrideStore = { ...cur, [key]: { ...cur[key], [id]: o } }
    const ui = useUi.getState()
    // Deleted sessions and folders lose their overrides the next time anything is saved.
    const pruned = pruneOverrides(next, { sessions: ui.sessions.map((s) => s.id), folders: ui.folders.map((f) => f.id) })
    set({ store: await window.hopline.ux.overrides.set(pruned) })
  }
}))

/** The settings a session's terminal uses: global settings with its folders' and its own overrides on top. */
export function sessionSettings(sessionId: string | undefined): Settings | null {
  const ui = useUi.getState()
  const s = ui.settings
  if (!s) return null
  const session = sessionById(ui, sessionId)
  if (!session) return s
  return effectiveSettings(s, resolveOverrides(useOverrides.getState().store, ui.folders, { session }).values)
}
