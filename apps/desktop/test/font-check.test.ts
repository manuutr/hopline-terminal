import { describe, expect, it } from 'vitest'
import { diffCount, differs, ligaturesIn, nerdGlyphsIn, type Renderer, type Run } from '../src/renderer/src/features/themes/font-check'

/**
 * A fake font on a 1-row "canvas" of 64 pixels: each character inks a pattern at its x. A
 * ligature font draws a listed sequence as one different glyph; a font "has" some glyphs, and
 * every missing one draws the same box.
 */
function fakeFont(opts: { ligatures?: string[]; has?: string[]; noise?: boolean } = {}): Renderer {
  const glyph = (ch: string): number[] => {
    // Private-use codepoints the font lacks all draw the same missing-glyph box.
    if (ch.codePointAt(0)! > 0xe000) return opts.has?.includes(ch) ? [0, 255, 0, 255, 0, 255, 0, 255] : [255, 0, 255, 0, 255, 0, 255, 0]
    const c = ch.charCodeAt(0)
    return [0, 1, 2, 3].map((i) => ((c >> i) & 1 ? 255 : 0))
  }
  return {
    advance: () => 4,
    render(runs: readonly Run[]) {
      const px = new Array<number>(64).fill(0)
      for (const r of runs) {
        if (runs.length === 1 && opts.ligatures?.includes(r.text)) {
          // One joined glyph, same width as the characters it replaces.
          for (let i = 0; i < r.text.length * 4; i++) px[r.x + i] = 128
          continue
        }
        let x = r.x
        for (const ch of r.text) {
          glyph(ch).forEach((v, i) => (px[x + i] = Math.max(px[x + i]!, v)))
          x += 4
        }
      }
      // Anti-aliasing noise below the tolerance must not count.
      return opts.noise ? px.map((v, i) => (i % 2 ? Math.min(255, v + 10) : v)) : px
    }
  }
}

describe('font checks by pixel comparison', () => {
  it('a font without ligatures draws each sequence like its characters side by side', () => {
    expect(ligaturesIn(fakeFont(), '"Plain Mono"')).toEqual([])
    expect(ligaturesIn(fakeFont({ noise: true }), '"Plain Mono"')).toEqual([])
  })

  it('a ligature font is caught even though the advance width is the same', () => {
    expect(ligaturesIn(fakeFont({ ligatures: ['->', '!='] }), '"Fira Code"')).toEqual(['->', '!='])
  })

  it('Nerd glyphs: the family draws them, or they look exactly like its missing-glyph box', () => {
    expect(nerdGlyphsIn(fakeFont(), '"Plain Mono"')).toEqual([])
    expect(nerdGlyphsIn(fakeFont({ has: ['', ''] }), '"Hack Nerd Font"')).toEqual(['', ''])
  })

  it('diff counting ignores small differences and needs a real share of the ink', () => {
    expect(diffCount([0, 255, 0], [10, 240, 0])).toBe(0)
    expect(diffCount([0, 255], [255, 0])).toBe(2)
    expect(differs([255, 255, 255, 255, 255], [255, 255, 255, 255, 0])).toBe(false)
    expect(differs(new Array(10).fill(255), new Array(10).fill(0))).toBe(true)
  })
})
