import { create } from 'zustand'
import type { CustomTheme } from '@shared/ux'

interface ThemesState {
  list: CustomTheme[]
  loaded: boolean
  load: () => Promise<void>
  /** Add or replace a theme (by id) and persist the list. */
  save: (t: CustomTheme) => Promise<void>
  remove: (id: string) => Promise<void>
}

/** Custom themes (theme generator and imports), stored in main under their own key. */
export const useThemes = create<ThemesState>((set, get) => ({
  list: [],
  loaded: false,
  load: async () => {
    const list = await window.hopline.ux.themes.get()
    set({ list, loaded: true })
  },
  save: async (t) => {
    const cur = get().list
    const next = cur.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [...cur, t]
    set({ list: await window.hopline.ux.themes.set(next) })
  },
  remove: async (id) => {
    set({ list: await window.hopline.ux.themes.set(get().list.filter((x) => x.id !== id)) })
  }
}))
