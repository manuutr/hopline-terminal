import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn'

/**
 * A small coloured label (risk class, state): coloured text in a 1 px outline of the same hue, no
 * fill and no pill. Colour is never the only signal: the word itself says what it is.
 */
const badge = cva('inline-flex h-4 shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] border px-1 text-2xs font-medium leading-none', {
  variants: {
    tone: {
      neutral: 'border-line-strong text-fg-muted',
      accent: 'border-accent/40 text-accent',
      ok: 'border-ok/40 text-ok',
      warn: 'border-warn/45 text-warn',
      danger: 'border-danger/50 text-danger'
    }
  },
  defaultVariants: { tone: 'neutral' }
})

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>): React.JSX.Element {
  return <span className={cn(badge({ tone }), className)} {...props} />
}

/** The risk class of a command or change ("Disruptive", "config"): the same small label. */
export const RiskLabel = Badge

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'down'

const dotTone: Record<ConnState, string> = {
  idle: 'border border-fg-subtle',
  connecting: 'connection-spin size-2 border border-warn border-r-transparent',
  connected: 'connection-alive bg-ok',
  reconnecting: 'connection-spin size-2 border border-warn border-r-transparent',
  down: 'connection-drop bg-danger'
}

export function StatusDot({ state, className }: { state: ConnState; className?: string }): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={state}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', dotTone[state], className)}
    />
  )
}
