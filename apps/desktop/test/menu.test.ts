import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDockTemplate, buildTemplate, MAX_RECENT, MAX_TABS, MENU_COMMANDS, type MenuSnapshot, type TemplateItem } from '../src/shared/menu'

const flat = (items: TemplateItem[]): TemplateItem[] => items.flatMap((item) => [item, ...flat(item.submenu ?? [])])
const state: MenuSnapshot = {
  items: {
    'app.about': { label: '&About', enabled: true },
    'palette.open': { label: 'Command &palette', keys: 'Mod+K', enabled: true },
    'ai.readOnly': { label: '&Read-only', kind: 'checkbox', checked: true, enabled: false },
    'help.devTools': { label: 'Developer tools', enabled: true }
  },
  recent: Array.from({ length: 12 }, (_, i) => ({ id: String(i), label: 'R&D ' + i })),
  tabs: Array.from({ length: 52 }, (_, i) => ({ id: String(i), label: 'Tab ' + i, active: i === 1 }))
}

describe('application menu template', () => {
  it('exposes native roles before the macOS renderer sends state', () => {
    const items = flat(buildTemplate(null, { mac: true, dev: false }))
    expect(items.map((i) => i.role)).toEqual(expect.arrayContaining(['undo', 'copy', 'paste', 'quit', 'minimize']))
    expect(items.some((i) => i.command)).toBe(false)
    expect(buildTemplate(null, { mac: false, dev: false })).toEqual([])
  })

  for (const mac of [true, false]) {
    it('resolves the platform labels, keys, checked state and dynamic commands on ' + (mac ? 'macOS' : 'Windows/Linux'), () => {
      const menu = buildTemplate(state, { mac, dev: false })
      const items = flat(menu)
      const byId = (id: string) => items.filter((i) => i.command?.id === id)
      expect(byId('app.about')).toHaveLength(1)
      expect(byId('palette.open')[0]).toMatchObject({ label: mac ? 'Command palette' : 'Command &palette', accelerator: mac ? 'Cmd+K' : 'Ctrl+Shift+K' })
      expect(byId('ai.readOnly')[0]).toMatchObject({ type: 'checkbox', checked: true, enabled: false })
      expect(byId('help.devTools')).toHaveLength(0)
      expect(flat(buildTemplate(state, { mac, dev: true })).some((i) => i.command?.id === 'help.devTools')).toBe(true)
      expect(byId('session.openRecent')).toHaveLength(MAX_RECENT)
      expect(byId('session.openRecent')[0]).toMatchObject({ label: 'R&D 0', command: { arg: '0' } })
      expect(byId('tab.activate')).toHaveLength(MAX_TABS)
      expect(byId('tab.activate').filter((i) => i.checked).map((i) => i.command?.arg)).toEqual(['1'])
      for (const { submenu } of items) {
        if (!submenu) continue
        expect(submenu[0]?.type).not.toBe('separator')
        expect(submenu.at(-1)?.type).not.toBe('separator')
        expect(submenu.some((i, n) => i.type === 'separator' && submenu[n - 1]?.type === 'separator')).toBe(false)
      }
    })
  }

  it('keeps the dock useful before any recent sessions exist', () => {
    expect(buildDockTemplate(null)).toEqual([{ label: 'New window', command: { id: 'window.new' } }])
    expect(buildDockTemplate(state).slice(2).map((i) => i.command?.arg)).toEqual(state.recent.slice(0, MAX_RECENT).map((r) => r.id))
  })

  it('references declared renderer actions, including the import action factory', () => {
    const root = join(__dirname, '../src/renderer/src/features')
    const ids = new Set<string>()
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      for (const match of source.matchAll(/\bid:\s*'([\w.]+)'|\bimportFrom\('[^']+',\s*'([\w.]+)'/g)) ids.add((match[1] ?? match[2])!)
    }
    expect([...MENU_COMMANDS].filter((id) => !ids.has(id))).toEqual([])
  })
})
