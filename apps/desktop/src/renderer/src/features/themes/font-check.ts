/**
 * What a font can do, decided by comparing pixels (Settings → Themes and fonts → Font preview).
 *
 * Monospace ligatures keep the advance width of the characters they replace, so measuring text
 * cannot see them; drawing can. The pure part takes an injected `render` so it is unit-tested
 * without a DOM; `canvasRenderer` is the browser implementation.
 */

export interface Run {
  text: string
  /** Left edge in CSS pixels. */
  x: number
}

export interface Renderer {
  /** Draw runs in `family` and return one alpha value per pixel (same canvas size every call). */
  render(runs: readonly Run[], family: string): Uint8ClampedArray | number[]
  /** Advance width of one character in `family`. */
  advance(ch: string, family: string): number
}

/**
 * A codepoint no font assigns (plane 16 private use): drawn in the family it shows the family's
 * missing-glyph box, the baseline for "this font does not have that glyph".
 */
export const UNASSIGNED = '\u{10fffd}'

export const LIGATURE_SEQUENCES = ['->', '=>', '!=', '===', '<=', '>='] as const
/** Powerline and Nerd Font private-use glyphs: separator, branch, git (Octicons), a box. */
export const NERD_GLYPHS = ['\ue0b0', '\ue0a0', '\uf113', '\uf489'] as const

/** How many pixels differ by more than a little anti-aliasing noise. */
export function diffCount(a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 24): number {
  let n = 0
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > tolerance) n++
  return n
}

const ink = (a: ArrayLike<number>) => {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i]! > 24) n++
  return n
}

/** Different enough to be a different drawing (more than 3% of the inked pixels, at least 4). */
export const differs = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => diffCount(a, b) > Math.max(4, 0.03 * Math.max(ink(a), ink(b)))

/**
 * Ligatures: a sequence drawn as one string vs each character drawn on its own at the same
 * advance. Any sequence that draws differently means the font joins it. Returns the ones that do.
 */
export function ligaturesIn(r: Renderer, family: string, seqs: readonly string[] = LIGATURE_SEQUENCES): string[] {
  return seqs.filter((seq) => {
    const whole = r.render([{ text: seq, x: 0 }], family)
    let x = 0
    const apart: Run[] = []
    for (const ch of seq) {
      apart.push({ text: ch, x })
      x += r.advance(ch, family)
    }
    return differs(whole, r.render(apart, family))
  })
}

/**
 * Nerd Font glyphs: each glyph vs a codepoint no font has, both drawn in the family. The same
 * pixels mean the glyph is missing too (both are the missing-glyph box). Returns the ones it draws.
 */
export function nerdGlyphsIn(r: Renderer, family: string, glyphs: readonly string[] = NERD_GLYPHS): string[] {
  const missing = r.render([{ text: UNASSIGNED, x: 0 }], family)
  return glyphs.filter((g) => differs(r.render([{ text: g, x: 0 }], family), missing))
}

/** The browser renderer: a small offscreen canvas, alpha channel only. */
export function canvasRenderer(size = { w: 120, h: 40, px: 22 }): Renderer {
  const canvas = document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const font = (family: string) => `${size.px}px ${family}`
  return {
    render(runs, family) {
      ctx.clearRect(0, 0, size.w, size.h)
      ctx.font = font(family)
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#000'
      for (const r of runs) ctx.fillText(r.text, 4 + r.x, size.h / 2)
      const data = ctx.getImageData(0, 0, size.w, size.h).data
      const alpha = new Uint8ClampedArray(size.w * size.h)
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]!
      return alpha
    },
    advance(ch, family) {
      ctx.font = font(family)
      return ctx.measureText(ch).width
    }
  }
}
