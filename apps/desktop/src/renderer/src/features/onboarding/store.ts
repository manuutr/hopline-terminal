import { create } from 'zustand'
import { CHECKLIST_ITEMS, ONBOARDING_DEFAULT, type ChecklistItem, type OnboardingState } from '@shared/ux'
import { useUi } from '../../store'
import { onChecklist } from '../../lib/checklist'

interface OnboardingStore {
  state: OnboardingState
  loaded: boolean
  /** The checklist is drawn open (it starts as one line). Per window, not stored. */
  expanded: boolean
  load: () => Promise<void>
  /** First-run steps finished or skipped: they never come back by themselves. */
  finishSteps: () => void
  /** A checklist item was done (idempotent). */
  mark: (item: ChecklistItem) => void
  dismiss: () => void
  /** Show the checklist again (palette, Settings), open. */
  reopen: () => void
}

/** Write through to main; the store is the truth for this window. */
const persist = (s: OnboardingState) => void window.hopline.ux.onboarding.set(s).catch(() => {})

export const useOnboarding = create<OnboardingStore>((set, get) => ({
  state: ONBOARDING_DEFAULT,
  loaded: false,
  expanded: false,
  load: async () => {
    const state = await window.hopline.ux.onboarding.get()
    set({ state, loaded: true })
  },
  finishSteps: () => {
    if (get().state.stepsDone) return
    const state = { ...get().state, stepsDone: true }
    set({ state })
    persist(state)
  },
  mark: (item) => {
    const cur = get().state
    if (!get().loaded || cur.done[item]) return
    const state = { ...cur, done: { ...cur.done, [item]: Date.now() } }
    set({ state })
    persist(state)
  },
  dismiss: () => {
    const state = { ...get().state, checklistDismissed: true }
    set({ state, expanded: false })
    persist(state)
  },
  reopen: () => {
    const state = { ...get().state, checklistDismissed: false, stepsDone: true }
    set({ state, expanded: true })
    persist(state)
    // The checklist lives at the foot of the session sidebar.
    useUi.getState().set({ sidebarOpen: true, settingsOpen: false, paletteOpen: false })
  }
}))

export const checklistProgress = (s: OnboardingState): { done: number; total: number } => ({
  done: CHECKLIST_ITEMS.filter((i) => s.done[i]).length,
  total: CHECKLIST_ITEMS.length
})

let wired = false
/**
 * Tick checklist items from what the user actually does, wherever they do it: a tab reaching a
 * device, the palette opening, a question to the assistant, a multi-device or fleet run. The first
 * connection by any route also ends the first-run steps (they exist to get someone connected).
 */
export function wireOnboarding(): void {
  if (wired) return
  wired = true
  void useOnboarding.getState().load()
  // The assistant and the multi-device/fleet runners tick their items through lib/checklist.
  onChecklist((item) => useOnboarding.getState().mark(item))
  useUi.subscribe((s, prev) => {
    const o = useOnboarding.getState()
    if (s.paletteOpen && !prev.paletteOpen) o.mark('palette')
    if (s.tabs !== prev.tabs && s.tabs.some((t) => t.state === 'connected' && prev.tabs.find((p) => p.tabId === t.tabId)?.state !== 'connected')) {
      o.mark('connect')
      o.finishSteps()
    }
  })
}

