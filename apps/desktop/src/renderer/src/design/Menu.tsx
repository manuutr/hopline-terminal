import { ContextMenu as CM } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import { kbdLabel } from './Kbd'
import { cn } from './cn'

/**
 * One look for every menu: the menu bar, context menus (terminal, tab, session tree) and dropdowns.
 * Dense like a desktop menu: 28 px rows, 13 px text, a check column on the left, the shortcut
 * right-aligned in plain text, and no icons except the checkmark and the submenu chevron.
 * Disabled rows are `fg-subtle` (never faded with opacity, so they keep 4.5:1).
 */
export const menuContent = 'z-50 min-w-56 max-h-[var(--radix-popper-available-height,calc(100vh-1rem))] overflow-y-auto max-w-[min(420px,90vw)] rounded-md border border-line-strong bg-overlay p-1 text-fg-muted shadow-overlay data-[side=bottom]:[--menu-y:-3px] data-[side=top]:[--menu-y:3px] data-[side=right]:[--menu-x:-3px] data-[side=left]:[--menu-x:3px] data-[state=open]:animate-menu-in data-[state=closed]:hidden'
export const menuItem =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-sm pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg data-[disabled]:text-fg-subtle data-[state=open]:bg-hover data-[state=open]:text-fg'
export const menuDanger = 'text-danger data-[highlighted]:text-danger'
export const menuSeparator = 'mx-2 my-1 h-px bg-line'
export const menuLabel = 'truncate pl-7 pr-2 pb-0.5 pt-1.5 text-xs text-fg-subtle'

/** The text of a menu entry. `&` marks the mnemonic, underlined while `mnemonics` is on. */
export function MenuText({ label, mnemonics = false, className }: { label: string; mnemonics?: boolean; className?: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let underlined = false
  for (let i = 0; i < label.length; i++) {
    const c = label[i]!
    if (c === '&' && label[i + 1] === '&') {
      parts.push('&')
      i++
    } else if (c === '&' && !underlined && i + 1 < label.length) {
      underlined = true
      const ch = label[++i]!
      parts.push(
        <span key={i} className={mnemonics ? 'underline underline-offset-2' : undefined}>
          {ch}
        </span>
      )
    } else parts.push(c)
  }
  return <span className={cn('min-w-0 flex-1 truncate', className)}>{parts}</span>
}

/** Right-aligned shortcut hint ("Ctrl+Shift+K", "⌘K"). */
export function MenuShortcut({ keys }: { keys?: string }): React.JSX.Element | null {
  if (!keys) return null
  // Hidden from the accessible name ("Copy", not "CopyCtrl+Shift+C"): the label is the name.
  return (
    <span aria-hidden className="ml-auto shrink-0 pl-6 text-xs tabular-nums text-fg-subtle">
      {kbdLabel(keys)}
    </span>
  )
}

/** The check column: a checkmark when on (checkbox and radio items). */
export function MenuCheck({ on }: { on: boolean }): React.JSX.Element | null {
  if (!on) return null
  return <Check aria-hidden className="absolute left-2 size-3.5 text-fg" />
}

export function MenuChevron(): React.JSX.Element {
  return <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0 text-fg-subtle" />
}

export function ContextItem({ label, keys, disabled, onSelect }: { label: string; keys?: string; disabled?: boolean; onSelect: () => void }): React.JSX.Element {
  return (
    <CM.Item className={menuItem} disabled={disabled} onSelect={onSelect}>
      <MenuText label={label} />
      <MenuShortcut keys={keys} />
    </CM.Item>
  )
}
