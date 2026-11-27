import type { ITerminalOptions, ITheme } from '@xterm/xterm'
import type { Settings } from '@shared/types'
import type { CustomTheme, TermColors } from '@shared/ux'
import { reducedMotion, cssVar } from '../../design/theme'
import { HOPLINE_PRESETS } from './presets'
import { useThemes } from '../themes/store'

type Palette = Required<Pick<ITheme, 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'>>

// Tuned for the app's #0d0e10 / #fcfcfc terminal: every colour but black is >= 4.5:1 (most >= 7:1)
// on its background (test/design-tokens.test.ts), and hues stay apart for highlighting.
export const hoplineDark: Palette = {
  black: '#2a2c31', red: '#f07a78', green: '#6ccf8f', yellow: '#e6bd6a', blue: '#73a9f5', magenta: '#c89af0', cyan: '#5ec9b6', white: '#c6c9cf',
  brightBlack: '#7b808a', brightRed: '#ff9895', brightGreen: '#8fe0ab', brightYellow: '#f5d390', brightBlue: '#9cc3ff', brightMagenta: '#dcb9fa', brightCyan: '#86ddcd', brightWhite: '#f2f3f5'
}
export const hoplineLight: Palette = {
  black: '#1d1f23', red: '#b42d33', green: '#1d7440', yellow: '#865a00', blue: '#1f5bb8', magenta: '#8338ad', cyan: '#0a6c60', white: '#555a62',
  brightBlack: '#666b73', brightRed: '#c2393e', brightGreen: '#1f7f47', brightYellow: '#946300', brightBlue: '#2a66c4', brightMagenta: '#9142bd', brightCyan: '#0b766a', brightWhite: '#17181b'
}

export interface TermThemeDef {
  id: string
  label: string
  /** Fixed colors; null means "follow the app theme" (Hopline tokens). */
  colors: TermColors | null
}

/**
 * Curated themes. Highlighting uses ANSI palette colors, so every theme keeps it readable.
 * Third-party palettes are their published, permissively licensed color values.
 */
export const TERM_THEMES: TermThemeDef[] = [
  { id: 'auto', label: 'Hopline Terminal (follows app theme)', colors: null },
  {
    id: 'moba-classic',
    label: 'MobaXterm style',
    colors: {
      background: '#101218', foreground: '#ececec', cursor: '#b4b4c0', cursorAccent: '#101218', selectionBackground: '#394057',
      black: '#202229', red: '#ff6060', green: '#60ff60', yellow: '#ffff36', blue: '#6060ff', magenta: '#ff36ff', cyan: '#36ffff', white: '#ececec',
      brightBlack: '#61636c', brightRed: '#ff8080', brightGreen: '#80ff80', brightYellow: '#ffff80', brightBlue: '#8080ff', brightMagenta: '#ff80ff', brightCyan: '#80ffff', brightWhite: '#ffffff'
    }
  },
  {
    id: 'royal-putty',
    label: 'Royal TS style (PuTTY)',
    colors: {
      background: '#000000', foreground: '#bbbbbb', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#344661',
      black: '#000000', red: '#bb0000', green: '#00bb00', yellow: '#bbbb00', blue: '#0000bb', magenta: '#bb00bb', cyan: '#00bbbb', white: '#bbbbbb',
      brightBlack: '#555555', brightRed: '#ff5555', brightGreen: '#55ff55', brightYellow: '#ffff55', brightBlue: '#5555ff', brightMagenta: '#ff55ff', brightCyan: '#55ffff', brightWhite: '#ffffff'
    }
  },
  {
    id: 'midnight',
    label: 'Midnight (high contrast)',
    colors: { background: '#000000', foreground: '#e6e6e6', cursor: '#ffcc00', cursorAccent: '#000000', selectionBackground: '#264f78', ...hoplineDark, white: '#e6e6e6' }
  },
  {
    id: 'graphite',
    label: 'Graphite (soft dark)',
    colors: {
      background: '#1c1d21', foreground: '#c9ccd2', cursor: '#c9ccd2', cursorAccent: '#1c1d21', selectionBackground: '#3a3d45',
      black: '#3a3d44', red: '#e08a85', green: '#9cc792', yellow: '#dcc28a', blue: '#8fb0d8', magenta: '#c3a3d6', cyan: '#8cc5bd', white: '#bfc2c8',
      brightBlack: '#80858f', brightRed: '#eea39e', brightGreen: '#b2d6aa', brightYellow: '#e8d3a3', brightBlue: '#a9c4e6', brightMagenta: '#d4bbe3', brightCyan: '#a5d4cd', brightWhite: '#e8e9ec'
    }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    colors: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'nord',
    label: 'Nord',
    colors: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
    }
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    colors: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2'
    }
  },
  {
    id: 'paper',
    label: 'Paper (light)',
    colors: { background: '#fbfaf7', foreground: '#1b2129', cursor: '#1f5fbf', cursorAccent: '#fbfaf7', selectionBackground: '#cfe0f7', ...hoplineLight }
  },
  ...HOPLINE_PRESETS
]

/** Built-in themes, then the user's own (theme generator and imports). */
export function allTermThemes(custom: readonly CustomTheme[] = useThemes.getState().list): TermThemeDef[] {
  return [...TERM_THEMES, ...custom.map((t) => ({ id: t.id, label: t.label, colors: t.term }))]
}

/** xterm theme for a theme id; "auto" reads the app's CSS tokens (light or dark). A deleted custom theme falls back to "auto". */
export function terminalTheme(id = 'auto'): TermColors {
  const def = allTermThemes().find((t) => t.id === id)
  if (def?.colors) return def.colors
  const isDark = document.documentElement.classList.contains('dark')
  return {
    background: cssVar('--term-bg'),
    foreground: cssVar('--term-fg'),
    cursor: cssVar('--term-cursor'),
    cursorAccent: cssVar('--term-bg'),
    selectionBackground: cssVar('--term-selection'),
    ...(isDark ? hoplineDark : hoplineLight)
  }
}

/** The OS asks for reduced motion (read live, so a change applies on the next settings pass). */
export { reducedMotion } from '../../design/theme'

export const BUNDLED_FONT = '"JetBrains Mono Variable"'

/** Terminal options derived from user settings. Safe to apply to a live terminal. */
/** True when a terminal background colour (#rrggbb or rgb()) is light. */
export function isLightBg(color: string | undefined): boolean {
  const m = color?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i) ?? color?.match(/(\d+)\D+(\d+)\D+(\d+)/)
  if (!m) return false
  const [r, g, b] = m.slice(1, 4).map((x) => (color!.startsWith('#') ? parseInt(x!, 16) : Number(x)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 140
}

/**
 * xterm raises any cell colour below this ratio against its background, selection included: every
 * theme, dim (SGR 2) text and device-chosen colours stay at WCAG AA (Phase 6; dark themes were 3).
 */
export const TERM_MIN_CONTRAST = 4.5

export function terminalOptions(s: Partial<Settings> | null | undefined): ITerminalOptions {
  const family = s?.termFontFamily?.trim()
  const theme = terminalTheme(s?.termTheme)
  return {
    // P2-17: dim ANSI colours and SGR 2 lines stay readable (xterm defaults to 1, i.e. off).
    minimumContrastRatio: TERM_MIN_CONTRAST,
    // Screen reader mode: xterm keeps an accessible row tree (its live region is silenced in TerminalView).
    screenReaderMode: !!s?.termScreenReader,
    fontFamily: [family, BUNDLED_FONT, 'monospace'].filter(Boolean).join(', '),
    fontSize: s?.termFontSize ?? 13,
    lineHeight: s?.termLineHeight ?? 1.2,
    cursorStyle: s?.termCursorStyle ?? 'bar',
    // A blinking cursor is motion too: reduced motion holds it steady.
    cursorBlink: (s?.termCursorBlink ?? true) && !s?.reduceMotion && !reducedMotion(),
    smoothScrollDuration: s?.reduceMotion || reducedMotion() ? 0 : 120,
    scrollback: s?.termScrollback ?? 20_000,
    theme
  }
}
