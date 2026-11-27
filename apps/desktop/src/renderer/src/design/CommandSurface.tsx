import { Dialog as D } from 'radix-ui'
import { useRef, type ReactNode } from 'react'
import { restoreFocus } from './Dialog'
import { cn } from './cn'
import { Kbd } from './Kbd'

/**
 * The one shell for keyboard-first overlays: command palette, session switcher, quick connect and
 * find in all tabs. Same width, same top offset, a 40 px input row with a 14 px leading icon,
 * dense 28 px rows, sentence-case section labels and a 28 px hint footer.
 */
export function CommandSurface({
  open,
  onOpenChange,
  title,
  description,
  children,
  onCloseAutoFocus,
  className,
  ...rest
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible name (visually hidden: the input says what the surface is for). */
  title: string
  description: string
  children: ReactNode
  onCloseAutoFocus?: (e: Event) => void
  className?: string
  'aria-describedby'?: string
}): React.JSX.Element {
  // Focus goes back where it was (or to the terminal) when the surface closes, like every dialog.
  const opener = useRef<HTMLElement | null>(null)
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay data-command-backdrop="" className="fixed inset-0 z-[var(--z-scrim)] bg-scrim backdrop-blur-[2px] animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
          }}
          onCloseAutoFocus={onCloseAutoFocus ?? ((e) => restoreFocus(e, opener.current))}
          aria-describedby={rest['aria-describedby']}
          className={cn(
            'fixed left-1/2 top-[14vh] z-[var(--z-dialog)] flex max-h-[72vh] w-[min(620px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-overlay shadow-overlay',
            'animate-pop-in data-[state=closed]:animate-pop-out focus:outline-none',
            className
          )}
        >
          <D.Title className="sr-only">{title}</D.Title>
          {!rest['aria-describedby'] && <D.Description className="sr-only">{description}</D.Description>}
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** The 44 px input row: a 16 px icon, then the input (cmdk's Command.Input or a plain input). */
export function CommandInputRow({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    // The field's focus mark: an accent underline while the input has the keyboard.
    <div className={cn('flex h-10 shrink-0 items-center gap-2.5 border-b border-line px-3.5 focus-within:shadow-[inset_0_-1px_0_var(--c-accent)] [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-subtle', className)}>
      {icon}
      {children}
    </div>
  )
}

/** Classes for the input inside CommandInputRow. */
export const commandInput = 'h-full w-full min-w-0 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none'

/** cmdk group with an in-list section label. */
export const commandGroup =
  'px-1 py-0.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-subtle'

/** A 32 px row; selected via cmdk's data-selected or aria-selected. */
export const commandRow =
  'flex h-7 cursor-default items-center gap-2.5 rounded px-2 text-sm text-fg-muted data-[selected=true]:bg-active data-[selected=true]:text-fg aria-selected:bg-active aria-selected:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-subtle'

/** The 32 px footer: key + label pairs. */
export function CommandFooter({ hints }: { hints: [keys: string, label: string][] }): React.JSX.Element {
  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line px-3.5 text-2xs text-fg-subtle">
      {hints.map(([keys, label]) => (
        <span key={keys} className="flex items-center gap-1.5">
          <Kbd keys={keys} /> {label}
        </span>
      ))}
    </div>
  )
}
