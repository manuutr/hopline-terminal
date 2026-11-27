import { describe, expect, it } from 'vitest'
import { checkContrast, gamutChroma, generateTheme, hexToOklch, hexToRgb, inGamut, linearToOklab, mixHex, oklabToLinear, oklchToHex, rgbToHex } from '@shared/oklch'
import { contrast } from '@shared/theme-file'
import { TERM_COLOR_KEYS, UI_TOKEN_KEYS } from '@shared/ux'

describe('OKLCH conversions', () => {
  it('round-trips #hex → OKLCH → #hex exactly for in-gamut colours', () => {
    for (const hex of ['#000000', '#ffffff', '#5ec9b6', '#0a6c60', '#f17a78', '#1d1f23', '#808080', '#ff0000', '#00ff00', '#0000ff', '#e3ad57']) expect(oklchToHex(hexToOklch(hex))).toBe(hex)
  })

  it('matches published reference values (white L=1, black L=0, sRGB red ≈ L 0.628 C 0.258 h 29.2)', () => {
    expect(hexToOklch('#ffffff').L).toBeCloseTo(1, 3)
    expect(hexToOklch('#ffffff').C).toBeLessThan(1e-3)
    expect(hexToOklch('#000000').L).toBeCloseTo(0, 6)
    const red = hexToOklch('#ff0000')
    expect(red.L).toBeCloseTo(0.628, 2)
    expect(red.C).toBeCloseTo(0.258, 2)
    expect(red.h).toBeCloseTo(29.2, 0)
  })

  it('OKLab ↔ linear sRGB are inverses', () => {
    const rgb: [number, number, number] = [0.2, 0.5, 0.8]
    const back = oklabToLinear(linearToOklab(rgb))
    back.forEach((v, i) => expect(v).toBeCloseTo(rgb[i]!, 6))
  })

  it('gamut mapping keeps lightness and hue and only reduces chroma', () => {
    const wild = { L: 0.7, C: 0.4, h: 145 }
    const hex = oklchToHex(wild)
    const got = hexToOklch(hex)
    expect(inGamut(hexToRgb(hex))).toBe(true)
    expect(got.L).toBeCloseTo(0.7, 2)
    expect(Math.abs(got.h - 145)).toBeLessThan(2)
    expect(got.C).toBeLessThan(0.4)
    expect(gamutChroma(wild)).toBeGreaterThan(0.1)
    // An in-gamut colour keeps its chroma.
    expect(gamutChroma({ L: 0.6, C: 0.05, h: 200 })).toBeCloseTo(0.05, 2)
    // Out-of-range lightness clamps.
    expect(oklchToHex({ L: 1.4, C: 0, h: 0 })).toBe('#ffffff')
  })

  it('mixes in OKLab and formats hex', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000')
    expect(() => hexToRgb('red')).toThrow()
  })
})

describe('generateTheme: AA by construction', () => {
  const bases = ['#0d0e10', '#1e3a5f', '#3b2a4a', '#2e3440', '#fcfcfc', '#ffcc00', '#7f7f7f', '#006400']
  const accents = ['#5ec9b6', '#ff5555', '#ffcc00', '#3366ff', '#ffffff', '#000000', '#9b59b6']
  for (const mode of ['dark', 'light'] as const)
    it(`every text pair passes for ${bases.length * accents.length} base/accent pairs (${mode})`, () => {
      for (const base of bases)
        for (const accent of accents) {
          const t = generateTheme({ base, accent, mode })
          const fails = checkContrast(t).filter((c) => !c.pass)
          expect(fails, `${mode} ${base} ${accent}: ${fails.map((f) => `${f.pair} ${f.ratio}`).join(', ')}`).toEqual([])
          for (const k of TERM_COLOR_KEYS) expect(t.term[k]).toMatch(/^#[0-9a-f]{6}$/)
          for (const k of UI_TOKEN_KEYS) expect(t.ui[k]).toMatch(/^#[0-9a-f]{6}$/)
        }
    })

  it('dark themes are dark and light themes are light; the surfaces carry the base hue lightly', () => {
    const d = generateTheme({ base: '#1e3a5f', accent: '#5ec9b6', mode: 'dark' })
    const l = generateTheme({ base: '#1e3a5f', accent: '#5ec9b6', mode: 'light' })
    expect(hexToOklch(d.ui.canvas).L).toBeLessThan(0.25)
    expect(hexToOklch(l.ui.canvas).L).toBeGreaterThan(0.95)
    expect(hexToOklch(d.ui.canvas).C).toBeLessThanOrEqual(0.021)
    expect(Math.abs(hexToOklch(d.ui.surface).h - hexToOklch('#1e3a5f').h)).toBeLessThan(8)
    // chroma 0: neutral greys.
    expect(hexToOklch(generateTheme({ base: '#1e3a5f', accent: '#5ec9b6', mode: 'dark', chroma: 0 }).ui.canvas).C).toBeLessThan(0.002)
  })

  it('the accent keeps its hue; the cursor is the accent; bright ANSI stays at least as readable', () => {
    const t = generateTheme({ base: '#0d0e10', accent: '#3366ff', mode: 'dark' })
    expect(Math.abs(hexToOklch(t.ui.accent).h - hexToOklch('#3366ff').h)).toBeLessThan(3)
    expect(t.term.cursor).toBe(t.ui.accent)
    for (const k of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      const b = `bright${k[0]!.toUpperCase()}${k.slice(1)}` as 'brightRed'
      expect(contrast(t.term[b], t.term.background)).toBeGreaterThanOrEqual(contrast(t.term[k], t.term.background) - 0.05)
    }
  })

  it('ANSI colours keep their hues; bright is lighter on dark and darker on light', () => {
    const hues = { red: 25, green: 145, yellow: 85, blue: 255, magenta: 320, cyan: 195 } as const
    const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
    for (const mode of ['dark', 'light'] as const)
      for (const base of ['#0d0e10', '#1e3a5f', '#fcfcfc']) {
        const t = generateTheme({ base, accent: '#5ec9b6', mode })
        for (const [k, h] of Object.entries(hues) as [keyof typeof hues, number][]) {
          expect(dist(hexToOklch(t.term[k]).h, h), `${mode} ${k}`).toBeLessThan(12)
          const b = `bright${k[0]!.toUpperCase()}${k.slice(1)}` as 'brightRed'
          const [L, bL] = [hexToOklch(t.term[k]).L, hexToOklch(t.term[b]).L]
          if (mode === 'dark') expect(bL, `${mode} ${b}`).toBeGreaterThan(L)
          else expect(bL, `${mode} ${b}`).toBeLessThan(L)
        }
      }
  })

  it('checkContrast reports failures of a hand-made theme', () => {
    const t = generateTheme({ base: '#0d0e10', accent: '#5ec9b6', mode: 'dark' })
    const bad = checkContrast({ term: { ...t.term, red: '#330000' } })
    const red = bad.find((c) => c.pair === 'red on background')!
    expect(red.pass).toBe(false)
    expect(red.min).toBe(4.5)
    // Without UI tokens only terminal pairs are checked.
    expect(bad.every((c) => !c.pair.startsWith('fg'))).toBe(true)
  })
})
