import { describe, expect, it } from 'vitest'
import { checkContrast } from '../src/shared/oklch'
import { contrast } from '../src/shared/theme-file'
import { TERM_COLOR_KEYS } from '../src/shared/ux'
import { HOPLINE_PRESETS } from '../src/renderer/src/features/terminal/presets'
import { kbdLabel } from '../src/renderer/src/design/Kbd'
import { isLightBg, TERM_THEMES } from '../src/renderer/src/features/terminal/theme'

describe('terminal minimum contrast (P2-17)', () => {
  it('tells light from dark backgrounds, hex or rgb()', () => {
    expect(isLightBg('#ffffff')).toBe(true)
    expect(isLightBg('#fdf6e3')).toBe(true)
    expect(isLightBg('#0e1115')).toBe(false)
    expect(isLightBg('rgb(14, 17, 21)')).toBe(false)
    expect(isLightBg('rgb(250 250 250)')).toBe(true)
    expect(isLightBg(undefined)).toBe(false)
  })

  it('ships distinct IDs and complete, legible colors for every new preset', () => {
    expect(new Set(TERM_THEMES.map((t) => t.id)).size).toBe(TERM_THEMES.length)
    for (const { label, colors } of HOPLINE_PRESETS) {
      for (const key of TERM_COLOR_KEYS) expect(colors[key], label + ' ' + key).toMatch(/^#[0-9a-f]{6}$/)
      expect(checkContrast({ term: colors }).filter((c) => !c.pass), label).toEqual([])
      expect(contrast(colors.foreground, colors.selectionBackground), label).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors.cursor, colors.cursorAccent), label).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every bundled theme has a background it can classify', () => {
    for (const t of TERM_THEMES) if (t.colors) expect(t.colors.background).toMatch(/^#|^rgb/)
  })
})

describe('Kbd labels (P2-3)', () => {
  it('one chord, platform-correct', () => {
    expect(kbdLabel('Mod+K', false)).toBe('Ctrl+Shift+K')
    expect(kbdLabel('Mod+K', true)).toBe('⌘K')
    expect(kbdLabel('Mod+Shift+F', true)).toBe('⌘⇧F')
    expect(kbdLabel('Alt+Enter', false)).toBe('Alt+Enter')
  })
  it('round 2: arrows and named keys read as people say them, Mod+Shift never doubles Shift', () => {
    expect(kbdLabel('Mod+ArrowUp', false)).toBe('Ctrl+Shift+↑')
    expect(kbdLabel('Mod+ArrowDown', true)).toBe('⌘↓')
    expect(kbdLabel('Alt+ArrowLeft', false)).toBe('Alt+←')
    expect(kbdLabel('Ctrl+ArrowRight', true)).toBe('⌃→')
    expect(kbdLabel('Ctrl+PageDown', false)).toBe('Ctrl+PgDn')
    expect(kbdLabel('Escape', false)).toBe('Esc')
    expect(kbdLabel('Delete', false)).toBe('Del')
    expect(kbdLabel('Backspace', true)).toBe('⌫')
    expect(kbdLabel('Mod+Shift+M', false)).toBe('Ctrl+Shift+M')
    expect(kbdLabel('Mod+Shift+M', true)).toBe('⌘⇧M')
    expect(kbdLabel('Mod++', false)).toBe('Ctrl+Shift++')
  })
})
