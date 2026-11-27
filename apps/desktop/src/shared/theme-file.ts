/**
 * Theme files: a Hopline theme (`.hopline-theme.json`, what Export writes) or an iTerm2
 * `.itermcolors` plist. Pure; main reads the file and hands the text here.
 *
 * The result is a draft: the renderer shows it, and nothing is stored until the user keeps it.
 */
import { CUSTOM_PREFIX, TERM_COLOR_KEYS, UI_TOKEN_KEYS, type CustomTheme, type TermColors } from './ux'

export interface ThemeDraft {
  theme: CustomTheme
  /** What the file did not say (colours filled from the base palette). */
  notes: string[]
}

const HEX = /^#[0-9a-f]{6}$/i

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'theme'

export const themeIdFor = (label: string, taken: Iterable<string> = []): string => {
  const used = new Set(taken)
  const base = `${CUSTOM_PREFIX}${slug(label)}`
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`
}

/** Relative luminance of #rrggbb (WCAG 2.x). */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}

/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

/** Hopline's dark and light terminal palettes: what an iTerm2 file leaves out is filled from these. */
export const FALLBACK_TERM: Record<'dark' | 'light', TermColors> = {
  dark: {
    background: '#0d0e10', foreground: '#dcdee2', cursor: '#5ec9b6', cursorAccent: '#0d0e10', selectionBackground: '#1f3d39',
    black: '#2a2c31', red: '#f07a78', green: '#6ccf8f', yellow: '#e6bd6a', blue: '#73a9f5', magenta: '#c89af0', cyan: '#5ec9b6', white: '#c6c9cf',
    brightBlack: '#7b808a', brightRed: '#ff9895', brightGreen: '#8fe0ab', brightYellow: '#f5d390', brightBlue: '#9cc3ff', brightMagenta: '#dcb9fa', brightCyan: '#86ddcd', brightWhite: '#f2f3f5'
  },
  light: {
    background: '#fcfcfc', foreground: '#1d1f23', cursor: '#0a6c60', cursorAccent: '#fcfcfc', selectionBackground: '#d3e6e3',
    black: '#1d1f23', red: '#b42d33', green: '#1d7440', yellow: '#865a00', blue: '#1f5bb8', magenta: '#8338ad', cyan: '#0a6c60', white: '#555a62',
    brightBlack: '#666b73', brightRed: '#c2393e', brightGreen: '#1f7f47', brightYellow: '#946300', brightBlue: '#2a66c4', brightMagenta: '#9142bd', brightCyan: '#0b766a', brightWhite: '#17181b'
  }
}

function fromJson(name: string, text: string): ThemeDraft {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('That file is not a Hopline theme (it is not valid JSON)')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('That file is not a Hopline theme')
  const term = (raw['term'] ?? {}) as Record<string, unknown>
  const notes: string[] = []
  const colors = {} as TermColors
  for (const k of TERM_COLOR_KEYS) {
    const v = term[k]
    if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`The theme file has no valid "${k}" colour`)
    colors[k] = v.toLowerCase()
  }
  const label = typeof raw['label'] === 'string' && raw['label'].trim() ? raw['label'].trim().slice(0, 60) : name
  const mode = raw['mode'] === 'light' ? 'light' : raw['mode'] === 'dark' ? 'dark' : luminance(colors.background) > 0.4 ? 'light' : 'dark'
  const ui =
    raw['ui'] && typeof raw['ui'] === 'object'
      ? Object.fromEntries(
          Object.entries(raw['ui'] as Record<string, unknown>)
            .filter(([k, v]) => (UI_TOKEN_KEYS as readonly string[]).includes(k) && typeof v === 'string' && HEX.test(v))
            .map(([k, v]) => [k, (v as string).toLowerCase()])
        )
      : undefined
  return { theme: { id: themeIdFor(label), label, mode, term: colors, ...(ui && Object.keys(ui).length ? { ui } : {}) }, notes }
}

export type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(n) || n > 0x10ffff) throw new Error('The colour file has a bad character reference')
      return String.fromCodePoint(n)
    }
    const v = ENTITIES[e]
    if (v === undefined) throw new Error('The colour file uses an entity Hopline does not read')
    return v
  })

/**
 * A small XML property-list reader for colour files: dict, array, key, string, real, integer,
 * true/false. No DOM and no DTD: a DOCTYPE with an internal subset or any ENTITY declaration is
 * refused, and only the five predefined entities and character references are decoded.
 */
export function parsePlist(text: string): PlistValue {
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('The colour file declares entities; it is refused')
  const body = text
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
  // `[^<>]*` (not `[^>]*?`): a tag ends at the next < or >, so input with no `>` is read in linear
  // time (review L3: 254 KB of "<a" took 5 s and blocked main). A stray `<` is its own token (malformed).
  const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)[^<>]*?(\/?)>|([^<]+)|</g)]
  let i = 0
  const isText = (t: RegExpMatchArray | undefined) => !!t && t[4] !== undefined
  const skipWs = () => {
    while (isText(tokens[i]) && !tokens[i]![4]!.trim()) i++
  }
  const textUntil = (tag: string): string => {
    let out = ''
    while (isText(tokens[i])) out += tokens[i++]![4]
    const close = tokens[i++]
    if (!close || close[1] !== '/' || close[2] !== tag) throw new Error(`The colour file is malformed (<${tag}> not closed)`)
    return decode(out)
  }
  const value = (depth: number): PlistValue => {
    if (depth > 16) throw new Error('The colour file is nested too deeply')
    skipWs()
    const t = tokens[i++]
    if (!t || isText(t) || t[1] === '/') throw new Error('The colour file is malformed')
    const tag = t[2]!
    const selfClosing = t[3] === '/'
    switch (tag) {
      case 'true':
      case 'false':
        if (!selfClosing) textUntil(tag)
        return tag === 'true'
      case 'string':
      case 'key':
      case 'data':
      case 'date':
        return selfClosing ? '' : textUntil(tag)
      case 'real':
      case 'integer': {
        const n = Number(textUntil(tag).trim())
        if (!Number.isFinite(n)) throw new Error('The colour file has a number Hopline cannot read')
        return n
      }
      case 'array': {
        const out: PlistValue[] = []
        if (selfClosing) return out
        for (;;) {
          skipWs()
          const n = tokens[i]
          if (!n) throw new Error('The colour file is malformed (<array> not closed)')
          if (n[1] === '/' && n[2] === 'array') return (i++, out)
          out.push(value(depth + 1))
        }
      }
      case 'dict': {
        const out: { [k: string]: PlistValue } = Object.create(null) as { [k: string]: PlistValue }
        if (selfClosing) return out
        for (;;) {
          skipWs()
          const n = tokens[i]
          if (!n) throw new Error('The colour file is malformed (<dict> not closed)')
          if (n[1] === '/' && n[2] === 'dict') return (i++, out)
          if (n[2] !== 'key') throw new Error('The colour file is malformed (a dict entry without a key)')
          const k = value(depth + 1) as string
          out[k] = value(depth + 1)
        }
      }
      case 'plist': {
        if (selfClosing) throw new Error('The colour file is empty')
        const v = value(depth + 1)
        skipWs()
        const close = tokens[i++]
        if (!close || close[1] !== '/' || close[2] !== 'plist') throw new Error('The colour file is malformed (<plist> not closed)')
        return v
      }
      default:
        throw new Error(`The colour file has an unknown element <${tag}>`)
    }
  }
  return value(0)
}

const ANSI_ORDER = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

const ITERM_KEYS: [string, keyof TermColors][] = [
  ['Background Color', 'background'],
  ['Foreground Color', 'foreground'],
  ['Cursor Color', 'cursor'],
  ['Cursor Text Color', 'cursorAccent'],
  ['Selection Color', 'selectionBackground'],
  ...ANSI_ORDER.map((k, n): [string, keyof TermColors] => [`Ansi ${n} Color`, k])
]

const component = (v: PlistValue | undefined): number | null => (typeof v === 'number' && v >= 0 && v <= 1.0001 ? Math.min(1, v) : null)

/** An iTerm2 `.itermcolors` file: Red/Green/Blue Component reals 0–1 (sRGB and Calibrated read alike). */
export function fromItermColors(name: string, text: string): ThemeDraft {
  const root = parsePlist(text)
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('That is not an iTerm2 colour file')
  const dict = root as Record<string, PlistValue>
  const found: Partial<TermColors> = {}
  for (const [key, k] of ITERM_KEYS) {
    const c = dict[key]
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue
    const rgb = ['Red Component', 'Green Component', 'Blue Component'].map((x) => component((c as Record<string, PlistValue>)[x]))
    if (rgb.some((x) => x === null)) continue
    found[k] = '#' + rgb.map((x) => Math.round(x! * 255).toString(16).padStart(2, '0')).join('')
  }
  if (!Object.keys(found).length) throw new Error('That iTerm2 file has no colours Hopline can read')
  return draftFromPalette(name, found)
}

function draftFromPalette(name: string, found: Partial<TermColors>): ThemeDraft {
  const mode = found.background && luminance(found.background) > 0.4 ? 'light' : 'dark'
  const base = FALLBACK_TERM[mode]
  const missing = TERM_COLOR_KEYS.filter((k) => !found[k])
  const term = Object.fromEntries(TERM_COLOR_KEYS.map((k) => [k, found[k] ?? base[k]])) as unknown as TermColors
  const label = name.trim().slice(0, 60) || 'Imported theme'
  const notes = missing.length ? [`Not in the file, taken from Hopline ${mode}: ${missing.join(', ')}.`] : []
  return { theme: { id: themeIdFor(label), label, mode, term }, notes }
}

const mobaKeys = new Map<string, keyof TermColors>([
  ['backgroundcolour', 'background'], ['foregroundcolour', 'foreground'], ['cursorcolour', 'cursor'],
  ...ANSI_ORDER.map((k): [string, keyof TermColors] => [k.toLowerCase().replace(/^bright/, 'bold'), k])
])

/** Read only the [Colors] section. A full MobaXterm.ini can also contain saved sessions. */
function fromMoba(name: string, text: string): ThemeDraft {
  const found: Partial<TermColors> = {}
  let colors = false
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      colors = section[1]!.toLowerCase() === 'colors'
      continue
    }
    if (!colors) continue
    const rgb = /^\s*([a-z]+)\s*=\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/i.exec(line)
    if (!rgb) continue
    const key = mobaKeys.get(rgb[1]!.toLowerCase())
    const values = rgb.slice(2).map(Number)
    if (key && values.every((v) => v <= 255)) found[key] = '#' + values.map((v) => v.toString(16).padStart(2, '0')).join('')
  }
  if (!Object.keys(found).length) throw new Error('No RGB palette found in the MobaXterm [Colors] section')
  return draftFromPalette(name, found)
}

const royalKeys = new Map<string, keyof TermColors>([
  ['background', 'background'], ['foreground', 'foreground'], ['cursorbackground', 'cursor'],
  ['cursorforeground', 'cursorAccent'], ['selectionbackground', 'selectionBackground'],
  ...ANSI_ORDER.map((k): [string, keyof TermColors] => ['ansi' + k.toLowerCase(), k])
])

function fromRoyal(name: string, text: string): ThemeDraft {
  let root
  try { root = JSON.parse(text) } catch { throw new Error('Invalid Royal TS terminal palette') }
  if (root?.terminal !== true || !Array.isArray(root.colors)) throw new Error('Choose a Royal TS terminal colour scheme')
  const found: Partial<TermColors> = {}
  for (const item of root.colors) {
    const key = typeof item?.terminalMapping === 'string' && royalKeys.get(item.terminalMapping.toLowerCase())
    const color = typeof item?.color === 'string' ? item.color.replace(/^##/, '#') : ''
    if (key && HEX.test(color)) found[key] = color.toLowerCase()
  }
  if (!Object.keys(found).length) throw new Error('No terminal colours found in the Royal TS palette')
  return draftFromPalette(typeof root.paletteName === 'string' && root.paletteName.trim() ? root.paletteName : name, found)
}

/** Standalone palettes are small. A MobaXterm INI can include unrelated settings. */
export const THEME_FILE_MAX_BYTES = 64 * 1024

export const themeFileLimit = (path: string): number => /\.ini$/i.test(path) ? 4 * 1024 * 1024 : THEME_FILE_MAX_BYTES

export function parseThemeFile(path: string, text: string): ThemeDraft {
  text = text.replace(/^\uFEFF/, '')
  if (text.length > themeFileLimit(path)) throw new Error('That file is too large for a theme')
  const name = (path.split(/[\\/]/).pop() ?? 'Imported theme').replace(/\.(hopline-theme\.json|json|itermcolors|termcolors|rtcp|ini)$/i, '')
  if (/\.ini$/i.test(path)) return fromMoba(name, text)
  if (/\.(?:termcolors|rtcp)$/i.test(path)) return fromRoyal(name, text)
  if (/\.itermcolors$/i.test(path) || /^\s*(<\?xml|<plist|<!DOCTYPE)/i.test(text)) return fromItermColors(name, text)
  return fromJson(name, text)
}
