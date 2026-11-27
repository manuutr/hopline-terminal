/**
 * `openSettings(target)`: the one way into Settings. Every "change this" link in the app names the
 * setting it means (a key from shared/settings-registry.ts, a section, or a tab), and Settings opens
 * on that tab with the row scrolled into view, highlighted and focused. Deep links
 * (`hopline://settings/<section>/<key>`) land here too.
 *
 * test/settings-registry.test.ts forbids opening Settings any other way (`settingsOpen: true`).
 */
import { create } from 'zustand'
import { resolveTarget, type SettingsTarget } from '@shared/settings-registry'
import { useUi } from '../store'

interface NavState {
  /** Where Settings should land; bumped on every call so the same target can be opened twice. */
  target: (SettingsTarget & { n: number; via?: 'link' }) | null
}

export const useSettingsNav = create<NavState>(() => ({ target: null }))

let n = 0

/**
 * Open Settings on a setting key ("keepAliveSec"), a section ("notifications"), a tab ("security") or "section/key".
 *
 * `via: 'link'` (a hopline:// deep link from the OS, untrusted): the row is scrolled to and
 * highlighted, but focus goes to its section heading, never to a control. Some controls save at
 * once (crash reports, update checks), and a link plus one stray Space must not change a setting
 * (review M7).
 */
export function openSettings(target?: string, opts?: { via?: 'link' }): void {
  useSettingsNav.setState({ target: { ...resolveTarget(target), n: ++n, ...(opts?.via ? { via: opts.via } : {}) } })
  useUi.getState().set({ settingsOpen: true })
}
