import { open, writeFile } from 'node:fs/promises'
import { parseThemeFile, themeFileLimit } from '@shared/theme-file'
import type { SimulatorLab } from '../lab'
import { CustomThemeSchema, CustomThemes, Onboarding, OverrideStoreSchema, type UxStore } from '../ux'
import { handler as h, registerAll, type Handler } from '.'

const none = { parse: (): undefined => undefined }

export interface UxPickers {
  /** Pick a supported palette file, or return null when cancelled. */
  openTheme(): Promise<string | null>
  /** Where to save an exported theme; null when cancelled. */
  saveTheme(defaultName: string): Promise<string | null>
}

/** Onboarding, per-host overrides, custom themes and the bundled lab. Exported for the IPC contract test. */
export function uxHandlers(store: UxStore, lab: Pick<SimulatorLab, 'start' | 'info'> | undefined, pickers: UxPickers): Record<string, Handler> {
  return {
    'ux:onboarding:get': h(none, () => store.onboarding()),
    'ux:onboarding:set': h(Onboarding, (s) => store.setOnboarding(s)),
    'ux:overrides:get': h(none, () => store.overrides()),
    'ux:overrides:set': h(OverrideStoreSchema, (s) => store.setOverrides(s)),
    'ux:themes:get': h(none, () => store.themes()),
    'ux:themes:set': h(CustomThemes, (list) => store.setThemes(list)),
    /** Pick a file in main's own dialog and parse it; nothing is saved until the user keeps it. */
    'ux:themes:import': h(none, async () => {
      const path = await pickers.openTheme()
      if (!path) return null
      const file = await open(path, 'r')
      try {
        const limit = themeFileLimit(path)
        const st = await file.stat()
        if (!st.isFile() || st.size > limit) throw new Error('That file is too large for a theme')
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of file.createReadStream({ end: limit, autoClose: false })) {
          length += chunk.length
          if (length > limit) throw new Error('That file is too large for a theme')
          chunks.push(chunk)
        }
        const bytes = Buffer.concat(chunks, length)
        const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
        return parseThemeFile(path, bytes.toString(utf16 ? 'utf16le' : 'utf8'))
      } finally { await file.close() }
    }),
    'ux:themes:export': h(CustomThemeSchema, async (t) => {
      const path = await pickers.saveTheme(`${t.label.replace(/[^\w.-]+/g, '-')}.hopline-theme.json`)
      if (!path) return false
      await writeFile(path, JSON.stringify({ hoplineTheme: 1, ...t }, null, 2) + '\n', 'utf8')
      return true
    }),
    ...(__HOPLINE_DEV_LAB__ && lab ? {
      'lab:info': h(none, () => lab.info()),
      'lab:start': h(none, () => lab.start())
    } : {})
  }
}

export function registerUxIpc(store: UxStore, lab: SimulatorLab | undefined, pickers: UxPickers): void {
  registerAll(uxHandlers(store, lab, pickers))
}
