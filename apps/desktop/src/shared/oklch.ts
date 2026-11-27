/**
 * OKLCH colour maths and the theme generator (Settings → Themes and fonts). Pure: no DOM.
 *
 * - Conversions: #hex ↔ linear sRGB ↔ OKLab ↔ OKLCH (Björn Ottosson's OKLab).
 * - Gamut mapping: a colour outside sRGB keeps its lightness and hue and loses chroma (binary
 *   search on C), so generated colours never clip into a different hue.
 * - `generateTheme`: a terminal palette and the app's UI tokens from one base and one accent, with
 *   every text colour searched in lightness until it passes WCAG AA on the surfaces it sits on.
 *   ok / warn / danger are never generated: state colours stay the app's own.
 */
import { contrast } from './theme-file'
import type { TermColors, UiTokenKey } from './ux'

export interface Oklab {
  L: number
  a: number
  b: number
}
export interface Oklch {
  L: number
  C: number
  /** Degrees, 0–360. */
  h: number
}
type Rgb = [number, number, number]

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as Rgb
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Linear sRGB → OKLab. */
export function linearToOklab([r, g, b]: Rgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

/** OKLab → linear sRGB (may be out of 0–1: out of gamut). */
export function oklabToLinear({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

export const oklabToOklch = ({ L, a, b }: Oklab): Oklch => {
  const C = Math.hypot(a, b)
  const h = C < 1e-7 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  return { L, C, h }
}
export const oklchToOklab = ({ L, C, h }: Oklch): Oklab => ({ L, a: C * Math.cos((h * Math.PI) / 180), b: C * Math.sin((h * Math.PI) / 180) })

export const hexToOklch = (hex: string): Oklch => oklabToOklch(linearToOklab(hexToRgb(hex).map(toLinear) as Rgb))

const EPS = 1e-6
export const inGamut = (rgb: Rgb): boolean => rgb.every((v) => v >= -EPS && v <= 1 + EPS)

/** OKLCH → #hex, reducing chroma (same L and h) until the colour fits sRGB. */
export function oklchToHex(c: Oklch): string {
  const L = Math.min(1, Math.max(0, c.L))
  const lin = (C: number) => oklabToLinear(oklchToOklab({ L, C, h: c.h }))
  let rgb = lin(c.C)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = c.C
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(lin(mid))) lo = mid
      else hi = mid
    }
    rgb = lin(lo)
  }
  return rgbToHex(rgb.map((v) => toGamma(Math.min(1, Math.max(0, v)))) as Rgb)
}

/** The chroma actually kept after gamut mapping (for tests and the preview). */
export const gamutChroma = (c: Oklch): number => hexToOklch(oklchToHex(c)).C

/** Mix two colours in OKLab (t = 0 → a, 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const x = linearToOklab(hexToRgb(a).map(toLinear) as Rgb)
  const y = linearToOklab(hexToRgb(b).map(toLinear) as Rgb)
  const lab = { L: x.L + (y.L - x.L) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t }
  return oklchToHex(oklabToOklch(lab))
}

/**
 * Walk lightness from `start` toward `dir` (+1 lighter, -1 darker) in small steps until the colour
 * reaches `min` contrast on every background. Returns the first hex that passes, or the extreme.
 */
export function searchL(start: number, C: number, h: number, bgs: readonly string[], min: number, dir: 1 | -1): string {
  let L = Math.min(1, Math.max(0, start))
  for (let i = 0; i <= 220; i++) {
    const hex = oklchToHex({ L, C, h })
    if (bgs.every((bg) => contrast(hex, bg) >= min)) return hex
    if ((dir > 0 && L >= 1) || (dir < 0 && L <= 0)) return hex
    L = Math.min(1, Math.max(0, L + dir * 0.005))
  }
  return oklchToHex({ L, C, h })
}

export interface GenerateInput {
  /** The base colour: its hue tints the surfaces. */
  base: string
  /** The one accent: focus, selection, the cursor. */
  accent: string
  mode: 'dark' | 'light'
  /** How much of the base hue the surfaces carry (0–0.4, default 0.02). */
  chroma?: number
}

export interface GeneratedTheme {
  term: TermColors
  ui: Record<UiTokenKey, string>
}

/** ANSI hue angles in OKLCH, chosen to stay apart for output highlighting. */
const ANSI_HUES = { red: 25, green: 145, yellow: 85, blue: 255, magenta: 320, cyan: 195 } as const

export function generateTheme({ base, accent, mode, chroma }: GenerateInput): GeneratedTheme {
  const dark = mode === 'dark'
  const b = hexToOklch(base)
  const a = hexToOklch(accent)
  const tint = Math.min(b.C, Math.max(0, Math.min(0.4, chroma ?? 0.02)))
  const surf = (L: number) => oklchToHex({ L, C: tint, h: b.h })
  const canvas = surf(dark ? 0.17 : 0.985)
  const surface = surf(dark ? 0.195 : 0.965)
  const raised = surf(dark ? 0.235 : 0.998)
  const overlay = surf(dark ? 0.245 : 0.998)
  const bgs = [canvas, surface, raised]
  const dir = dark ? 1 : -1
  const textC = Math.min(tint, 0.015)
  const fg = searchL(dark ? 0.93 : 0.22, textC, b.h, bgs, 7, dir)
  const fgMuted = searchL(dark ? 0.74 : 0.42, textC, b.h, bgs, 4.5, dir)
  const fgSubtle = searchL(dark ? 0.64 : 0.5, textC, b.h, bgs, 4.5, dir)
  // The accent keeps its hue and chroma; only lightness moves until it reads on the canvas (3:1, non-text).
  const accentHex = searchL(a.L, Math.min(a.C, 0.2), a.h, [canvas], 3, dir)
  const ink = dark ? oklchToHex({ L: 0.16, C: Math.min(a.C, 0.04), h: a.h }) : '#ffffff'
  const alt = dark ? '#ffffff' : oklchToHex({ L: 0.16, C: Math.min(a.C, 0.04), h: a.h })
  const accentFg = contrast(ink, accentHex) >= contrast(alt, accentHex) ? ink : alt

  // ANSI: each hue searched from a mode-appropriate start until 4.5:1 on the terminal background.
  const ansiC = 0.13
  const hue = (h: number) => searchL(dark ? 0.72 : 0.5, ansiC, h, [canvas], 4.5, dir)
  const bright = (hex: string) => {
    const c = hexToOklch(hex)
    // A step further from the background, so bright stays at least as readable as normal.
    return searchL(c.L + (dark ? 0.08 : -0.05), c.C, c.h, [canvas], 4.5, dir)
  }
  const named = Object.fromEntries(Object.entries(ANSI_HUES).map(([k, h]) => [k, hue(h)])) as Record<keyof typeof ANSI_HUES, string>
  const white = searchL(dark ? 0.82 : 0.45, textC, b.h, [canvas], 4.5, dir)
  const brightBlack = searchL(dark ? 0.6 : 0.5, textC, b.h, [canvas], 4.5, dir)
  const black = oklchToHex({ L: dark ? 0.3 : 0.25, C: textC, h: b.h })
  const term: TermColors = {
    background: canvas,
    foreground: fg,
    cursor: accentHex,
    cursorAccent: canvas,
    selectionBackground: mixHex(canvas, accentHex, dark ? 0.3 : 0.2),
    black,
    ...named,
    white,
    brightBlack,
    brightRed: bright(named.red),
    brightGreen: bright(named.green),
    brightYellow: bright(named.yellow),
    brightBlue: bright(named.blue),
    brightMagenta: bright(named.magenta),
    brightCyan: bright(named.cyan),
    brightWhite: searchL(dark ? 0.96 : 0.18, textC, b.h, [canvas], 4.5, dir)
  }
  return { term, ui: { canvas, surface, raised, overlay, fg, 'fg-muted': fgMuted, 'fg-subtle': fgSubtle, accent: accentHex, 'accent-fg': accentFg } }
}

export interface ContrastCheck {
  pair: string
  fg: string
  bg: string
  ratio: number
  min: number
  pass: boolean
}

const ANSI_TEXT: (keyof TermColors)[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']

/**
 * The AA report: UI text tokens on canvas, surface and raised (4.5), the accent on the canvas (3)
 * and its text on it (4.5); the terminal foreground and every ANSI colour but black on the
 * terminal background (4.5).
 */
export function checkContrast(t: { term: TermColors; ui?: Partial<Record<UiTokenKey, string>> }): ContrastCheck[] {
  const out: ContrastCheck[] = []
  const add = (pair: string, fg: string | undefined, bg: string | undefined, min: number) => {
    if (!fg || !bg) return
    const ratio = Math.round(contrast(fg, bg) * 100) / 100
    out.push({ pair, fg, bg, ratio, min, pass: ratio >= min })
  }
  const ui = t.ui ?? {}
  for (const tok of ['fg', 'fg-muted', 'fg-subtle'] as const) for (const s of ['canvas', 'surface', 'raised'] as const) add(`${tok} on ${s}`, ui[tok], ui[s], 4.5)
  add('accent on canvas', ui.accent, ui.canvas, 3)
  add('accent-fg on accent', ui['accent-fg'], ui.accent, 4.5)
  add('foreground on background', t.term.foreground, t.term.background, 4.5)
  for (const k of ANSI_TEXT) add(`${k} on background`, t.term[k], t.term.background, 4.5)
  return out
}
