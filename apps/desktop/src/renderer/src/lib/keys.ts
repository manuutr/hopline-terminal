export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/**
 * Physical key codes for punctuation. Shift changes `e.key` (Shift+, is "<", Shift+/ is "?"), and
 * "Mod" includes Shift on Win/Linux, so punctuation shortcuts are matched by `e.code`.
 */
const PUNCT_CODE: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote'
}

/**
 * "Mod" is ⌘ on macOS and Ctrl+Shift elsewhere. Plain Ctrl+letter belongs to the device CLI
 * (Ctrl+P/N history, Ctrl+K kill line, Ctrl+W delete word, Ctrl+B back), so we never steal it
 * while the terminal has focus.
 */
export function isShortcut(e: KeyLike, combo: string, mac = isMac): boolean {
  const parts = combo.split('+')
  // "Mod++" style combos are not used; the last part is the key.
  const raw = parts.at(-1)!
  const key = raw.toLowerCase()
  const mod = parts.includes('Mod')
  const shift = parts.includes('Shift')
  const alt = parts.includes('Alt')
  const code = e.code.toLowerCase()
  const punct = PUNCT_CODE[raw]
  // Letters match by physical key (e.code "KeyO") whenever the event has one: e.key varies with
  // Shift, Caps Lock, the layout (Cyrillic "щ") and IMEs ("Process" on Windows), e.code does not.
  const letter = /^[a-z]$/.test(key)
  const keyHit = punct
    ? e.code === punct || (!e.shiftKey && e.key === raw)
    : key === 'space'
      ? e.code === 'Space' || e.key === ' '
      : letter && /^Key[A-Z]$/.test(e.code)
      ? code === `key${key}`
      : e.key.toLowerCase() === key || code === `key${key}` || code === `digit${key}`
  if (!keyHit) return false
  if (e.altKey !== alt) return false
  if (mod) {
    if (mac) return e.metaKey && !e.ctrlKey && e.shiftKey === shift
    return e.ctrlKey && e.shiftKey && !e.metaKey
  }
  return e.ctrlKey === parts.includes('Ctrl') && e.shiftKey === shift && e.metaKey === parts.includes('Meta')
}

export const inTerminal = (e: Event): boolean => !!(e.target as HTMLElement | null)?.closest?.('.xterm')

/**
 * A modal dialog is open (Radix dialogs, the palette, the switcher, prompts, confirmations). A
 * dialog playing its ~100 ms exit animation (data-state=closed) no longer counts.
 */
export const modalOpen = (): boolean => !!document.querySelector('[role=dialog]:not([data-state=closed]),[role=alertdialog]:not([data-state=closed])')

/**
 * Keys xterm does not translate itself but the device needs. Ctrl+Shift+6 is Ctrl+^ (0x1E), the
 * Cisco escape that aborts ping/traceroute and starts the "Ctrl+^ x" suspend sequence; xterm 6
 * produces nothing for it because Shift+6 is "^" on US layouts. Returns the bytes to send.
 */
export function deviceKeyFor(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string | undefined {
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Digit6') return '\x1e'
  return undefined
}
