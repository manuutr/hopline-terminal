import { create } from 'zustand'

interface Draft {
  text: string
  attachment?: { label: string; selection: string }
}

interface DraftState {
  byTab: Record<string, Draft>
  edit(tabId: string, patch: Partial<Draft>): void
  clear(tabId: string): void
}

/** Unsent text and captured output belong to one live terminal, including when it is in a split. */
export const useDrafts = create<DraftState>((set) => ({
  byTab: {},
  edit: (tabId, patch) => set(({ byTab }) => ({
    byTab: { ...byTab, [tabId]: { text: '', ...byTab[tabId], ...patch } }
  })),
  clear: (tabId) => set((state) => {
    if (!(tabId in state.byTab)) return state
    const { [tabId]: removed, ...byTab } = state.byTab
    return { byTab }
  })
}))
