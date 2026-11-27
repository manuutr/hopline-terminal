import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SETTINGS } from '../src/shared/settings-registry'
import { renderShortcuts, SETTINGS_PAGE, SHORTCUTS_PAGE, shortcutDecls, stalePages, undocumentedSettings } from '../scripts/docs-reference'

/**
 * The guide's settings and shortcut pages are generated from the code (scripts/docs-reference.ts).
 * These fail when the code gains a setting or a default shortcut the pages do not have yet.
 * Fix: `node apps/desktop/scripts/docs-reference.ts`, then commit the two pages.
 */
describe('generated reference pages', () => {
  it('every setting in the registry has a description', () => {
    expect(undocumentedSettings()).toEqual([])
  })

  it('every setting in the registry is on the settings page', () => {
    const page = readFileSync(SETTINGS_PAGE, 'utf8')
    const missing = SETTINGS.filter((s) => !page.includes(`\`hopline://settings/${s.section}/${s.key}\``)).map((s) => s.key)
    expect(missing).toEqual([])
  })

  it('finds the declared default shortcuts', () => {
    const ids = shortcutDecls().map((d) => d.id)
    for (const id of ['palette.open', 'files.toggle', 'multi.run', 'blocks.table', 'a11y.bufferView', 'pane.focus.*', 'tab.goto.*']) expect(ids).toContain(id)
    expect(renderShortcuts()).toContain('`Ctrl+Shift+K`')
  })

  it('every default shortcut is on the shortcuts page', () => {
    const page = readFileSync(SHORTCUTS_PAGE, 'utf8')
    expect(shortcutDecls().filter((d) => !page.includes(`\`${d.id}\``)).map((d) => d.id)).toEqual([])
  })

  it('both pages match the code (run node apps/desktop/scripts/docs-reference.ts)', () => {
    expect(stalePages()).toEqual([])
  })
})
