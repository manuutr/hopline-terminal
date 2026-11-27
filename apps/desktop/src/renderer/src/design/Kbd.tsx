import { cn } from './cn'

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

const MAC_SYMBOL: Record<string, string> = { Mod: '⌘', Meta: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↩', Backspace: '⌫', Delete: '⌦', Escape: '⎋' }

/** Key names as people read them, on every platform (the sheet printed "ArrowLeft"). */
const KEY_NAME: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Delete: 'Del',
  ' ': 'Space',
  Space: 'Space'
}

/**
 * "Mod+Shift+K" → "Ctrl+Shift+K" on Windows/Linux, "⌘⇧K" on macOS. Mod already means Ctrl+Shift off
 * macOS, so "Mod+Shift+M" reads "Ctrl+Shift+M" there, never "Ctrl+Shift+Shift+M".
 */
export function kbdLabel(keys: string, mac = isMac): string {
  // "Mod++" style bindings: a trailing "+" is the key itself.
  const raw = keys.endsWith('++') ? [...keys.slice(0, -2).split('+'), '+'] : keys.split('+')
  const parts = raw.flatMap((k) => (k === 'Mod' && !mac ? ['Ctrl', 'Shift'] : [k])).filter((k, i, all) => all.indexOf(k) === i)
  return mac ? parts.map((k) => MAC_SYMBOL[k] ?? KEY_NAME[k] ?? k).join('') : parts.map((k) => KEY_NAME[k] ?? k).join('+')
}

/** A shortcut as one key cap ("Ctrl+Shift+K", "⌘K"): one cap reads as one chord, three caps as three keys. */
export function Kbd({ keys, className }: { keys: string; className?: string }): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center whitespace-nowrap rounded-[3px] bg-active px-1 font-sans text-2xs leading-none tabular-nums text-fg-muted',
        className
      )}
    >
      {kbdLabel(keys)}
    </kbd>
  )
}
