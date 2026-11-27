import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERM_MIN_CONTRAST } from '../src/renderer/src/features/terminal/theme'

/**
 * Phase 6 accessibility pack: WCAG AA (4.5:1) for every text/background pair the UI draws, in both
 * themes, including the composited states (hover, selected, accent and status tints, disabled
 * controls, hovered buttons). design-tokens.test.ts covers the plain tokens; this covers the
 * layers. Colours are composited exactly as the browser does: rgba layers over their surface.
 */
const root = join(__dirname, '../src/renderer/src')
const css = readFileSync(join(root, 'styles.css'), 'utf8')
const button = readFileSync(join(root, 'design/Button.tsx'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

type RGB = [number, number, number]
type RGBA = [number, number, number, number]
function rgba(v: string): RGBA {
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [...([0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as RGB), 1]
  const m = v.match(/rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)/)
  if (!m) throw new Error(`unparsed colour ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 1]
}
/** `c` (with its own alpha, times `alpha`) over the opaque `under`. */
const over = (c: RGBA, under: RGB, alpha = 1): RGB => {
  const a = c[3] * alpha
  return [0, 1, 2].map((k) => Math.round(c[k]! * a + under[k]! * (1 - a))) as RGB
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
/** CSS brightness(f): each channel times f, clamped. */
const brightness = (c: RGB, f: number): RGB => c.map((v) => Math.min(255, Math.round(v * f))) as RGB

const light = block(':root')
const dark = { ...light, ...block('.dark') }
const THEMES = [
  ['light', light],
  ['dark', dark]
] as const

const SURFACES = ['c-canvas', 'c-surface', 'c-raised', 'c-overlay', 'term-bg']
/** Row and control backgrounds drawn on a surface: hover, selected (active), the tints. */
const LAYERS = ['c-hover', 'c-active', 'c-accent-soft', 'c-ok-soft', 'c-warn-soft', 'c-danger-soft']
const NEUTRAL = ['c-fg', 'c-fg-muted', 'c-fg-subtle']
const STATE = ['c-accent', 'c-ok', 'c-warn', 'c-danger']

describe('every text/background pair meets WCAG AA (4.5:1)', () => {
  for (const [name, t] of THEMES) {
    const c = (k: string) => rgba(t[k]!)
    const surf = (s: string) => over(c(s), [0, 0, 0])

    it(`${name}: neutral text on every surface and every layer (hover, selected, tints)`, () => {
      const fails: string[] = []
      for (const s of SURFACES) {
        const base = surf(s)
        for (const layer of [null, ...LAYERS]) {
          const bg = layer ? over(c(layer), base) : base
          for (const f of NEUTRAL) {
            const r = ratio(over(c(f), bg), bg)
            if (r < 4.5) fails.push(`${f} on ${layer ?? 'plain'} over ${s}: ${r.toFixed(2)}`)
          }
        }
      }
      expect(fails).toEqual([])
    })

    it(`${name}: state colours on their surfaces, on hover and selected rows, and on their own tint`, () => {
      const fails: string[] = []
      for (const s of SURFACES) {
        const base = surf(s)
        for (const f of STATE) {
          const own = `${f}-soft`
          for (const layer of [null, 'c-hover', 'c-active', own]) {
            const bg = layer ? over(c(layer), base) : base
            const r = ratio(over(c(f), bg), bg)
            if (r < 4.5) fails.push(`${f} on ${layer ?? 'plain'} over ${s}: ${r.toFixed(2)}`)
          }
        }
      }
      expect(fails).toEqual([])
    })

    it(`${name}: buttons at rest, hovered, pressed and disabled`, () => {
      const fails: string[] = []
      const check = (what: string, fg: RGB, bg: RGB) => {
        const r = ratio(fg, bg)
        if (r < 4.5) fails.push(`${what}: ${r.toFixed(2)}`)
      }
      for (const s of ['c-canvas', 'c-surface', 'c-raised', 'c-overlay']) {
        const base = surf(s)
        const accent = over(c('c-accent'), base)
        // primary: accent-fg on accent, hover brightness(1.1), pressed brightness(0.95), its key cap (black/15)
        check(`primary on ${s}`, over(c('c-accent-fg'), accent), accent)
        check(`primary hover on ${s}`, over(c('c-accent-fg'), accent), brightness(accent, 1.1))
        check(`primary pressed on ${s}`, over(c('c-accent-fg'), accent), brightness(accent, 0.95))
        check(`primary key cap on ${s}`, over(c('c-accent-fg'), accent), over([0, 0, 0, 0.15], accent))
        // danger / ok: their colour on its tint, and on the hover (/20) and pressed (/25) fills
        for (const k of ['danger', 'ok']) {
          const col = c(`c-${k}`)
          // The fills the Button variant really uses (hover:bg-danger/12 …), read from its source.
          const fills = [...button.matchAll(new RegExp(`(?:hover|active):bg-${k}/(\\d+)`, 'g'))].map((m) => Number(m[1]) / 100)
          expect(fills.length, `${k} hover and pressed fills`).toBe(2)
          for (const a of fills) {
            const bg = over(col, base, a)
            check(`${k} button at ${a * 100}% on ${s}`, over(col, bg), bg)
          }
        }
        // danger-solid: white text in light, near-black in dark
        const solid = over(c('c-danger'), base)
        check(`danger-solid on ${s}`, name === 'light' ? [255, 255, 255] : [0x1a, 0x06, 0x06], solid)
        // secondary: fg on raised, hover/pressed on active
        check(`secondary hover on ${s}`, over(c('c-fg'), over(c('c-active'), base)), over(c('c-active'), base))
        // disabled (any variant): fg-subtle on the hover fill, no opacity
        const dis = over(c('c-hover'), base)
        check(`disabled on ${s}`, over(c('c-fg-subtle'), dis), dis)
      }
      expect(fails).toEqual([])
    })

    it(`${name}: overlays over the terminal (the zoom badge at 90 %) and selected terminal text`, () => {
      const term = surf('term-bg')
      const badge = over(c('c-overlay'), term, 0.9)
      for (const f of NEUTRAL) expect(ratio(over(c(f), badge), badge), `${f} on overlay/90`).toBeGreaterThanOrEqual(4.5)
      const sel = over(c('term-selection'), term)
      expect(ratio(over(c('term-fg'), sel), sel), 'term-fg on the selection').toBeGreaterThanOrEqual(4.5)
    })
  }

  it('every terminal theme: xterm lifts any cell below 4.5:1 (selection, dim text and device colours included)', () => {
    // A static palette check cannot cover what devices paint (SGR 2, 256 colours, the selection
    // blend), so the terminal enforces it: minimumContrastRatio is applied per cell, on its real background.
    expect(TERM_MIN_CONTRAST).toBeGreaterThanOrEqual(4.5)
    // Every place that sets it uses the one constant, whatever the theme.
    const sets = ['features/terminal/theme.ts', 'features/terminal/TerminalView.tsx'].flatMap((f) => [...readFileSync(join(root, f), 'utf8').matchAll(/minimumContrastRatio\s*[:=]\s*([^,\n]+)/g)].map((m) => m[1]!.trim()))
    expect(sets.length).toBeGreaterThanOrEqual(2)
    for (const v of sets) expect(v).toBe('TERM_MIN_CONTRAST')
  })
})

/** Every .tsx file of the renderer. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('no text is faded with opacity', () => {
  it('opacity only hides (0), shows (100) or marks an item being dragged', () => {
    const bad: string[] = []
    for (const file of sources(root)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/[\w:[\]=-]*opacity-(\d+|\[[\d.]+\])/g)) {
            if (m[1] === '0' || m[1] === '100') continue
            // A dragged tab, tree row or bar button is transient feedback under the pointer.
            if (/drag/i.test(line)) continue
            bad.push(`${file.slice(root.length + 1)}:${i + 1} ${m[0]}`)
          }
        })
    }
    expect(bad).toEqual([])
  })

  it('no text colour token is drawn with an alpha modifier (text-fg-subtle/80 is below 4.5:1)', () => {
    const bad: string[] = []
    for (const file of sources(root)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/\btext-fg(?:-muted|-subtle)?\/\d+/g)) bad.push(`${file.slice(root.length + 1)}:${i + 1} ${m[0]}`)
        })
    }
    expect(bad).toEqual([])
  })
})
