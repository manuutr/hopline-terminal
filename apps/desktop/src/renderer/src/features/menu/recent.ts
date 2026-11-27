import { create } from 'zustand'
import { MAX_RECENT } from '@shared/menu'
import type { Session } from '@shared/types'

/**
 * File › Open recent: saved sessions by when they last connected (main stamps `lastConnectedAt`).
 * "Clear recent" hides everything connected before now. It is a per-machine view setting, so it
 * lives in local storage and never touches the sessions themselves.
 */
const KEY = 'hopline.recentClearedAt'
const read = (): number => {
  try {
    return Number(localStorage.getItem(KEY)) || 0
  } catch {
    return 0
  }
}

export const useRecent = create<{ clearedAt: number }>(() => ({ clearedAt: read() }))

export function clearRecent(): void {
  const now = Date.now()
  try {
    localStorage.setItem(KEY, String(now))
  } catch {
    // Storage blocked: cleared for this run only.
  }
  useRecent.setState({ clearedAt: now })
}

export function recentSessions(sessions: readonly Session[], clearedAt = useRecent.getState().clearedAt): Session[] {
  return sessions
    .filter((s) => !s.ephemeral && !!s.lastConnectedAt && s.lastConnectedAt > clearedAt)
    .sort((a, b) => b.lastConnectedAt! - a.lastConnectedAt!)
    .slice(0, MAX_RECENT)
}
