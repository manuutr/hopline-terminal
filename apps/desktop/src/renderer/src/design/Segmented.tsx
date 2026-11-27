import { useRef } from 'react'
import { SelectionIndicator } from './SelectionIndicator'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

export interface SegmentedItem<V extends string> {
  value: V
  label: string
  /** With `iconOnly`, the icon is the face and the label becomes the tooltip and accessible name. */
  icon?: React.ReactNode
  disabled?: boolean
}

/**
 * The one segmented control (round 2): a radiogroup with roving focus. Arrow keys move and select,
 * Home/End jump; only the selected segment is in the tab order.
 */
export function Segmented<V extends string>({
  label,
  value,
  onChange,
  items,
  iconOnly,
  size = 'md',
  className
}: {
  label: string
  value: V
  onChange: (v: V) => void
  items: readonly SegmentedItem<V>[]
  iconOnly?: boolean
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const enabled = items.filter((i) => !i.disabled)
  const move = (delta: number | 'first' | 'last') => {
    if (!enabled.length) return
    const at = Math.max(0, enabled.findIndex((i) => i.value === value))
    const next = delta === 'first' ? 0 : delta === 'last' ? enabled.length - 1 : (at + delta + enabled.length) % enabled.length
    const v = enabled[next]!.value
    onChange(v)
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(v)}"]`)?.focus()
  }
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={cn('relative isolate inline-flex shrink-0 items-center rounded-md border border-line-strong bg-surface p-0.5', size === 'sm' ? 'h-6' : 'h-7', className)}
      onKeyDown={(e) => {
        const k = e.key
        if (k === 'ArrowRight' || k === 'ArrowDown') move(1)
        else if (k === 'ArrowLeft' || k === 'ArrowUp') move(-1)
        else if (k === 'Home') move('first')
        else if (k === 'End') move('last')
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <SelectionIndicator kind="segment" value={value} items={items.map((it) => it.value).join('|')} />
      {items.map((it) => {
        const on = it.value === value
        const btn = (
          <button
            key={it.value}
            type="button"
            role="radio"
            data-value={it.value}
            aria-checked={on}
            aria-label={iconOnly ? it.label : undefined}
            disabled={it.disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.value)}
            className={cn(
              'relative z-[1] inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-xs transition-colors duration-[var(--dur-fast)] disabled:text-fg-subtle [&_svg]:size-3.5 [&_svg]:shrink-0',
              iconOnly ? 'aspect-square' : 'px-2',
              on ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg'
            )}
          >
            {it.icon}
            {!iconOnly && it.label}
          </button>
        )
        return iconOnly ? (
          <Tooltip key={it.value} label={it.label}>
            {btn}
          </Tooltip>
        ) : (
          btn
        )
      })}
    </div>
  )
}
