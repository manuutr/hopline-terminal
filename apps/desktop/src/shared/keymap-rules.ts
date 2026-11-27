/**
 * Key combos as data: normalising "Mod+K" to the physical keys it means on this OS, recording a
 * combo from a keydown (by physical key, `e.code`), and the rules for what a user may bind.
 *
 * Pure (no DOM, no store) so the keymap editor's rules are unit-tested directly, and shared with
 * main, which enforces the reserved keys again when a keymap is saved or loaded (review L10).
 */
/** Same test as renderer/src/lib/keys.ts; main passes `mac` explicitly. */
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

export interface Physical {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** Upper-case letter, digit, punctuation character or a key name (Enter, ArrowLeft, F5, PageUp…). */
  key: string
}

/** e.code → the key name used in combos, for keys whose e.key changes with Shift or the layout. */
const CODE_KEY: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space'
}

const NAMED = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'])
const isFn = (k: string) => /^F([1-9]|1[0-2])$/.test(k)

/** "Mod+Shift+k" → physical keys. `Mod` is ⌘ on macOS and Ctrl+Shift elsewhere. */
export function toPhysical(combo: string, mac = isMac): Physical {
  const parts = combo.split('+')
  // "Ctrl++" is not used; a trailing empty part would mean "+".
  const raw = parts.at(-1) || '+'
  const mods = new Set(parts.slice(0, -1).map((m) => m[0]!.toUpperCase() + m.slice(1).toLowerCase()))
  const mod = mods.has('Mod')
  const key = raw.length === 1 ? raw.toUpperCase() : raw[0]!.toUpperCase() + raw.slice(1)
  return {
    ctrl: mods.has('Ctrl') || (mod && !mac),
    shift: mods.has('Shift') || (mod && !mac),
    alt: mods.has('Alt'),
    meta: mods.has('Meta') || (mod && mac),
    key: key === 'Esc' ? 'Escape' : key === 'Return' ? 'Enter' : key
  }
}

/** A stable string for comparing combos: "Ctrl+Shift+K" means the same as "Mod+K" on Linux. */
export function physicalId(combo: string, mac = isMac): string {
  const p = toPhysical(combo, mac)
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Meta', p.key].filter(Boolean).join('+')
}

/** The key part of a keydown, by physical key where that matters; null for a bare modifier press. */
export function keyOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  if (/^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock)/.test(e.key) || /^(Control|Shift|Alt|Meta|OS)(Left|Right)$/.test(e.code)) return null
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1]
  if (letter) return letter
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1]
  if (digit) return digit
  if (CODE_KEY[e.code]) return CODE_KEY[e.code]!
  if (e.key === ' ') return 'Space'
  if (NAMED.has(e.key) || isFn(e.key)) return e.key
  if (e.key === 'Esc') return 'Escape'
  return e.key.length === 1 ? e.key.toUpperCase() : null
}

/**
 * Record a combo from a keydown, in the form the app shows ("Mod+K" for Ctrl+Shift+K on
 * Windows/Linux and ⌘K on macOS). Null while only modifiers are held.
 */
export function comboFromEvent(e: KeyLike, mac = isMac): string | null {
  const key = keyOf(e)
  if (!key) return null
  const parts: string[] = []
  const mod = mac ? e.metaKey : e.ctrlKey && e.shiftKey
  if (mod) parts.push('Mod')
  if (e.ctrlKey && (mac || !mod)) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey && (mac || !mod)) parts.push('Shift')
  if (e.metaKey && !mac) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

/**
 * Why a combo can't be bound, or null. These keys belong to the device CLI (or to typing), so the
 * app never takes them, whatever the user asks:
 * - keys without a modifier, and Shift+key (that is typing), except F1–F12;
 * - Tab and Shift+Tab (device completion);
 * - Ctrl+letter (Ctrl+C interrupt, Ctrl+Z end, Ctrl+D, Ctrl+R, Ctrl+A/E line edits, Ctrl+P/N history…);
 * - Ctrl+[ ] \ ^ @ _ and Ctrl+Space (escape, telnet escape, quit, Cisco break, NUL, undo);
 * - Alt+letter (Esc-B / Esc-F word motion on IOS, Junos and readline shells);
 * - copy and paste in the terminal (Ctrl+Shift+C/V, ⌘C/⌘V), and ⌘Q on macOS.
 */
export function reservedReason(combo: string, mac = isMac): string | null {
  const p = toPhysical(combo, mac)
  const letter = /^[A-Z]$/.test(p.key)
  const fn = isFn(p.key)
  if (p.key === 'Tab' && !p.ctrl) return 'Tab is the device\'s command completion'
  if (!p.ctrl && !p.alt && !p.meta) {
    if (fn) return null
    return p.shift ? 'Shift+key is typing: it goes to the device' : 'A key without Ctrl, Alt or ⌘ is typing: it goes to the device'
  }
  if (p.ctrl && !p.shift && !p.alt && !p.meta && letter) return `Ctrl+${p.key} belongs to the device CLI (interrupt, history, line editing)`
  if (p.ctrl && !p.alt && !p.meta && ['[', ']', '\\', 'Space'].includes(p.key)) return `Ctrl+${p.key} belongs to the device (escape, telnet escape, quit, NUL)`
  if (p.ctrl && p.shift && !p.alt && !p.meta && ['6', '2', '-'].includes(p.key)) return `Ctrl+Shift+${p.key} is Ctrl+${p.key === '6' ? '^' : p.key === '2' ? '@' : '_'} for the device (Cisco break, NUL, undo)`
  if (p.alt && !p.ctrl && !p.meta && letter) return `Alt+${p.key} is word motion on the device CLI (Esc-${p.key})`
  const mod = mac ? p.meta && !p.ctrl && !p.alt && !p.shift : p.ctrl && p.shift && !p.alt && !p.meta
  if (mod && (p.key === 'C' || p.key === 'V')) return `${p.key === 'C' ? 'Copy' : 'Paste'} in the terminal`
  if (mac && mod && p.key === 'Q') return '⌘Q quits Hopline'
  return null
}

export interface BindingOwner {
  id: string
  title: string
  keys: readonly string[]
}

export interface KeyConflict {
  /** The physical combo ("Ctrl+Shift+K") two or more actions answer to. */
  combo: string
  owners: { id: string; title: string }[]
}

/**
 * Combos that more than one action answers to right now. The editor refuses new conflicts, but an
 * update can add a default key that a user binding already took: list those so the user can fix them.
 */
export function findConflicts(owners: readonly BindingOwner[], mac = isMac): KeyConflict[] {
  const by = new Map<string, { id: string; title: string }[]>()
  for (const o of owners)
    for (const k of new Set(o.keys.map((x) => physicalId(x, mac)))) {
      const list = by.get(k) ?? []
      list.push({ id: o.id, title: o.title })
      by.set(k, list)
    }
  return [...by.entries()].filter(([, l]) => l.length > 1).map(([combo, l]) => ({ combo, owners: l }))
}

/**
 * Check a new combo for `actionId` against the reserved keys and every other action's current
 * keys. Returns the reason it is refused, or null.
 */
export function bindingProblem(combo: string, actionId: string, owners: readonly BindingOwner[], mac = isMac): string | null {
  const reserved = reservedReason(combo, mac)
  if (reserved) return `${reserved}, so it can't be a shortcut`
  const id = physicalId(combo, mac)
  const other = owners.find((o) => o.id !== actionId && o.keys.some((k) => physicalId(k, mac) === id))
  if (other) return `Already used by “${other.title}”`
  return null
}

/**
 * A stored keymap with every reserved combo taken out (review L10). The editor already refuses
 * them; this runs again in main when a keymap is saved or loaded, and in the renderer when it is
 * loaded, so a hand-edited database, an old build or a compromised renderer cannot take Ctrl+C,
 * Tab or Enter away from the device or the approval card.
 */
export function withoutReserved(km: Record<string, readonly string[]>, mac = isMac): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, keys] of Object.entries(km)) {
    if (!Array.isArray(keys)) continue
    out[id] = keys.filter((k) => typeof k === 'string' && reservedReason(k, mac) === null)
  }
  return out
}
