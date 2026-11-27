import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { cn } from './cn'

/** The first field a dialog should open on: an explicit [autofocus]/[data-autofocus], else the first form control. */
const FIRST_FIELD = '[autofocus], [data-autofocus], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Focus after a dialog closes (Phase 6 keyboard pass): back to the element that had it when the
 * dialog opened, if it is still on screen; else (it was the palette, or a row that went away) the
 * focused pane's terminal or launcher, so the keyboard is never left on <body>.
 */
export function restoreFocus(e: Event, opener: HTMLElement | null): void {
  e.preventDefault()
  const usable = (el: HTMLElement | null): el is HTMLElement => !!el && el.isConnected && !el.closest('[inert]') && (el.offsetParent !== null || el.classList.contains('xterm-helper-textarea'))
  const fallback = () =>
    document.querySelector<HTMLElement>('[data-terminal-area] [data-pane-id][data-focused] .xterm-helper-textarea') ??
    document.querySelector<HTMLElement>('[data-terminal-area] [data-pane-id][data-focused] [data-launcher] input') ??
    document.querySelector<HTMLElement>('[data-terminal-area] .xterm-helper-textarea') ??
    document.querySelector<HTMLElement>('[data-launcher] input') ??
    document.querySelector<HTMLElement>('#session-search')
  // After Radix has unmounted the dialog (and any other dialog it opened from has settled).
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return
    const target = usable(opener) ? opener : fallback()
    target?.focus({ preventScroll: true })
  })
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  variant = 'default',
  fill = false,
  bodyClassName
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
  /**
   * Where focus goes when the dialog opens. Default: the first [autofocus] element or form field,
   * else the dialog itself (never the close button, where Enter would close the dialog).
   */
  onOpenAutoFocus?: (e: Event) => void
  /** Where focus goes when it closes. Default (Radix): back to the element focused before it opened. */
  onCloseAutoFocus?: (e: Event) => void
  /** Esc inside the dialog: call `e.preventDefault()` to keep it open (e.g. Esc means something closer to focus). */
  onEscapeKeyDown?: (e: KeyboardEvent) => void
  /**
   * 'alert' (P2-5): a one-sentence confirmation. Title, body and buttons in one band, no dividers,
   * no close button (Esc and Cancel close it).
   */
  variant?: 'default' | 'alert'
  /**
   * The body fills the dialog instead of scrolling at 65vh: the dialog is a flex column capped at
   * 88vh (set its height with `className`) and the body is `flex-1 min-h-0`, laid out by the children.
   */
  fill?: boolean
  /** Replaces the body's padding (a dialog with its own layout, e.g. Settings' left nav). */
  bodyClassName?: string
}): React.JSX.Element {
  const content = useRef<HTMLDivElement>(null)
  // Where the keyboard was when the dialog opened (Radix calls onOpenAutoFocus before moving focus).
  const opener = useRef<HTMLElement | null>(null)
  const defaultAutoFocus = (e: Event) => {
    e.preventDefault()
    const el = content.current
    const target = el?.querySelector<HTMLElement>(FIRST_FIELD) ?? el
    target?.focus()
  }
  const autoFocus = (e: Event) => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    ;(onOpenAutoFocus ?? defaultAutoFocus)(e)
  }
  const closeAutoFocus = onCloseAutoFocus ?? ((e: Event) => restoreFocus(e, opener.current))
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[var(--z-scrim)] bg-scrim animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content
          ref={content}
          onOpenAutoFocus={autoFocus}
          onCloseAutoFocus={closeAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          className={cn(
            'fixed left-1/2 top-[12vh] z-[var(--z-dialog)] w-[min(520px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg bg-overlay shadow-overlay animate-pop-in focus:outline-none data-[state=closed]:animate-pop-out',
            fill && variant === 'default' && 'flex max-h-[88vh] flex-col',
            className
          )}
        >
          {variant === 'alert' ? (
            <div className="px-4 pb-3 pt-4">
              <D.Title className="text-base font-semibold">{title}</D.Title>
              <D.Description asChild>
                <div className="mt-1 text-sm text-fg-muted">{children}</div>
              </D.Description>
              {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-start gap-3 border-b border-line py-2.5 pl-4 pr-11">
                <div className="min-w-0 flex-1">
                  <D.Title className="text-sm font-semibold leading-6">{title}</D.Title>
                  {description ? (
                    <D.Description className="text-xs text-fg-muted">{description}</D.Description>
                  ) : (
                    <D.Description className="sr-only">{title}</D.Description>
                  )}
                </div>
              </div>
              <div className={cn(fill ? 'flex min-h-0 flex-1 flex-col' : 'max-h-[65vh] overflow-auto', bodyClassName ?? (fill ? 'px-4 py-3' : 'px-4 py-3.5'))}>{children}</div>
              {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-surface px-4 py-2.5">{footer}</div>}
              {/* Last in tab order (Esc closes too); drawn in the header's corner. */}
              <D.Close
                className="absolute right-3 top-2.5 rounded p-1 text-fg-subtle transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg"
                aria-label="Close"
              >
                <X className="size-4" />
              </D.Close>
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
