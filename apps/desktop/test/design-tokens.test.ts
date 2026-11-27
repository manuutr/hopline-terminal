import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hoplineDark, hoplineLight, TERM_THEMES } from '../src/renderer/src/features/terminal/theme'

/**
 * WCAG AA for the design tokens (docs/design/VISUAL-DIRECTION.md): every text token on every
 * surface it is drawn on, in both themes. rgba tokens are composited over their surface first.
 */
const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

type RGB = [number, number, number]
const parse = (v: string, over: RGB): RGB => {
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as RGB
  const m = v.match(/rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)/)
  if (!m) throw new Error(`unparsed colour ${v}`)
  const a = m[4] ? Number(m[4]) : 1
  return [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * a + over[k]! * (1 - a))) as RGB
}
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('design tokens meet WCAG AA', () => {
  const light = block(':root')
  const dark = { ...light, ...block('.dark') }
  for (const [name, t] of [
    ['light', light],
    ['dark', dark],
    ['high contrast', { ...dark, ...block('.dark.contrast') }]
  ] as const) {
    it(`${name}: text tokens >= 4.5:1 on canvas, surface, raised and overlay`, () => {
      for (const s of ['c-canvas', 'c-surface', 'c-raised', 'c-overlay', 'c-float', 'term-bg']) {
        const bg = parse(t[s]!, [0, 0, 0])
        for (const f of ['c-fg', 'c-fg-muted', 'c-fg-subtle', 'c-accent', 'c-ok', 'c-warn', 'c-danger', 'c-info', 'term-fg']) {
          expect(ratio(parse(t[f]!, bg), bg), `${f} on ${s}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
    it(`${name}: risk labels on their soft tints, and the primary button`, () => {
      const bg = parse(t['c-surface']!, [0, 0, 0])
      for (const k of ['ok', 'warn', 'danger', 'accent']) {
        const tint = parse(t[`c-${k}-soft`]!, bg)
        expect(ratio(parse(t[`c-${k}`]!, tint), tint), `${k} on ${k}-soft`).toBeGreaterThanOrEqual(4.5)
      }
      expect(ratio(parse(t['c-accent-fg']!, [0, 0, 0]), parse(t['c-accent']!, [0, 0, 0]))).toBeGreaterThanOrEqual(4.5)
    })
  }

  for (const [name, t] of [
    ['light', light],
    ['dark', dark]
  ] as const) {
    it(`${name}: selected rows (bg-active) keep their metadata at AA with fg-muted (review P2)`, () => {
      // The egress dialog's selected row (overlay), list rows in panels (surface) and wells (raised).
      for (const s of ['c-overlay', 'c-surface', 'c-raised', 'c-canvas']) {
        const base = parse(t[s]!, [0, 0, 0])
        for (const layer of ['c-active', 'c-hover']) {
          const bg = parse(t[layer]!, base)
          for (const f of ['c-fg', 'c-fg-muted']) expect(ratio(parse(t[f]!, bg), bg), `${f} on ${layer} over ${s}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it(`${name}: inactive text uses fg-subtle, not opacity (review P2)`, () => {
      // Unticked proposal lines (term well), the expired card (raised), the fleet scope list (overlay).
      for (const s of ['term-bg', 'c-raised', 'c-overlay', 'c-surface']) {
        const bg = parse(t[s]!, [0, 0, 0])
        expect(ratio(parse(t['c-fg-subtle']!, bg), bg), `fg-subtle on ${s}`).toBeGreaterThanOrEqual(4.5)
        // What opacity-50 did to the same text: under AA, which is why it is gone.
        const faded = parse(t['c-fg-muted']!, bg).map((v, i) => Math.round(v * 0.5 + bg[i]! * 0.5)) as RGB
        expect(ratio(faded, bg), `fg-muted at 50% on ${s}`).toBeLessThan(4.5)
      }
    })
  }

  it('the proposal card and the fleet scope list fade no text with opacity', () => {
    for (const f of ['features/ai/ProposalCard.tsx', 'features/fleet/FleetView.tsx', 'features/trust/EgressDialog.tsx']) {
      const src = readFileSync(join(__dirname, '../src/renderer/src', f), 'utf8')
      expect(src, f).not.toMatch(/['" ]opacity-(50|60|70)['" ]/)
    }
  })

  it('the default terminal palettes: every ANSI colour but black is >= 4.5:1 on its background', () => {
    for (const [p, bg] of [
      [hoplineDark, dark['term-bg']!],
      [hoplineLight, light['term-bg']!]
    ] as const) {
      const b = parse(bg, [0, 0, 0])
      for (const [k, v] of Object.entries(p)) if (k !== 'black') expect(ratio(parse(v, b), b), k).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('theme ids are stable (they are stored in settings)', () => {
    const ids = TERM_THEMES.map((t) => t.id)
    for (const id of ['auto', 'midnight', 'solarized-dark', 'nord', 'gruvbox-dark', 'paper']) expect(ids).toContain(id)
  })
})
