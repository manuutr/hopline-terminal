import { cn } from './cn'
import { Tooltip } from './Tooltip'

/**
 * The one on/off control (round 2): a switch, optionally with its label beside it.
 * Settings rows pass `label` for the accessible name only; toolbars pass `inline` to show it.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  inline,
  className
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
  /** Show the label next to a compact switch; the whole thing is one button. */
  inline?: boolean
  className?: string
}): React.JSX.Element {
  const track = (
    <span
      aria-hidden
      className={cn(
        'relative shrink-0 rounded-full transition-colors duration-[var(--dur-fast)]',
        inline ? 'h-4 w-7' : 'h-5 w-9',
        checked ? 'bg-accent' : 'bg-line-input ring-1 ring-inset ring-line-input'
      )}
    >
      <span
        className={cn(
          'switch-thumb absolute left-0 top-0.5 rounded-full bg-white shadow transition-transform duration-[var(--dur-fast)]',
          inline ? 'size-3' : 'size-4',
          checked ? (inline ? 'translate-x-[14px]' : 'translate-x-[18px]') : 'translate-x-0.5'
        )}
      />
    </span>
  )
  const btn = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={inline ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-md disabled:text-fg-subtle',
        inline && 'h-7 whitespace-nowrap px-1.5 text-xs text-fg-muted transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg',
        className
      )}
    >
      {track}
      {inline && <span>{label}</span>}
    </button>
  )
  return hint ? <Tooltip label={hint}>{btn}</Tooltip> : btn
}
