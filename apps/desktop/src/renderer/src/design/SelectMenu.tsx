import { Check, ChevronDown } from 'lucide-react'
import { Select as S } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from './cn'

export interface SelectOption<V extends string> {
  value: V
  label: ReactNode
  /** Plain text for type-ahead and the accessible name when `label` is not a string. */
  text?: string
  /** A 16 px mark before the label (e.g. a vendor monogram). */
  icon?: ReactNode
  /** Short trailing note in the menu only ("· admin · password"). */
  hint?: ReactNode
  disabled?: boolean
}

export interface SelectGroup<V extends string> {
  /** In-list section label; omit for an unlabelled group (drawn after a separator). */
  label?: string
  options: SelectOption<V>[]
}

/** Radix Select can't hold "" as an item value; an empty choice travels as this. */
const EMPTY = '__empty__'

/**
 * The design-system select (P1-11): a themed trigger and popup on Radix Select, keyboard-first
 * (type-ahead, arrows, Enter, Esc), 28 px items with a check mark. Replaces native <select>, whose
 * OS popup ignores the app theme.
 */
export function SelectMenu<V extends string>({
  value,
  onValueChange,
  options,
  groups,
  placeholder,
  className,
  disabled,
  id,
  ...aria
}: {
  value: V
  onValueChange: (v: V) => void
  options?: SelectOption<V>[]
  /** Instead of `options`: groups with section labels (e.g. "Detect" above the vendor list). */
  groups?: SelectGroup<V>[]
  placeholder?: string
  className?: string
  disabled?: boolean
  id?: string
  'aria-label': string
}): React.JSX.Element {
  const all = groups ?? [{ options: options ?? [] }]
  const enc = (v: string) => (v === '' ? EMPTY : v)
  const dec = (v: string) => (v === EMPTY ? '' : v) as V
  const current = all.flatMap((g) => g.options).find((o) => o.value === value)
  return (
    <S.Root value={enc(value)} onValueChange={(v) => onValueChange(dec(v))} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={aria['aria-label']}
        className={cn(
          'group flex h-7 w-full min-w-0 items-center gap-2 rounded-md border border-line-input bg-surface pl-2.5 pr-2 text-left text-sm text-fg',
          'transition-colors duration-[var(--dur-fast)] hover:border-fg-subtle/60 focus:outline-none focus-visible:border-accent/60 data-[state=open]:border-accent/60',
          'disabled:text-fg-subtle data-[placeholder]:text-fg-subtle',
          className
        )}
      >
        {current?.icon && <span className="flex size-4 shrink-0 items-center justify-center">{current.icon}</span>}
        <span className="min-w-0 flex-1 truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon asChild>
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-fast)] group-data-[state=open]:rotate-180" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-[60] max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md bg-overlay text-fg-muted shadow-overlay',
            'animate-pop-in data-[state=closed]:animate-fade-out'
          )}
        >
          <S.Viewport className="p-1">
            {all.map((g, gi) => (
              <S.Group key={g.label ?? gi}>
                {gi > 0 && <S.Separator className="my-1 h-px bg-line" />}
                {g.label && <S.Label className="px-2 pb-1 pt-1.5 text-2xs font-medium text-fg-subtle">{g.label}</S.Label>}
                {g.options.map((o) => (
                  <S.Item
                    key={o.value}
                    value={enc(o.value)}
                    disabled={o.disabled}
                    textValue={o.text ?? (typeof o.label === 'string' ? o.label : undefined)}
                    className={cn(
                      'relative flex h-7 cursor-default select-none items-center gap-2 rounded-sm pl-2 pr-7 text-sm outline-none',
                      'data-[highlighted]:bg-hover data-[highlighted]:text-fg data-[state=checked]:text-fg data-[disabled]:text-fg-subtle'
                    )}
                  >
                    {o.icon !== undefined && <span className="flex size-4 shrink-0 items-center justify-center">{o.icon}</span>}
                    <S.ItemText>{o.label}</S.ItemText>
                    {o.hint && <span className="truncate text-2xs text-fg-subtle">{o.hint}</span>}
                    <S.ItemIndicator className="absolute right-2 flex items-center">
                      <Check className="size-3.5 text-accent" />
                    </S.ItemIndicator>
                  </S.Item>
                ))}
              </S.Group>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}

/** A small vendor mark for platform lists: a one-letter monogram, never a vendor logo. */
export function PlatformMark({ code }: { code: string }): React.JSX.Element {
  return (
    <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-active text-[10px] font-semibold leading-none text-fg-muted">
      {code}
    </span>
  )
}
