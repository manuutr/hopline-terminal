import { OctagonAlert, ShieldAlert } from 'lucide-react'
import { sameHost } from '@shared/cli'
import { Badge } from './Badge'
import { cn } from './cn'
import { Input } from './Input'

/**
 * One confirmation for configuration and disruptive changes (round 2): snippets, send-to-many and
 * the AI approval card share these parts, so a change always reads the same way:
 *   header (icon · target · kind) → reason (disruptive) → the exact lines in the platform wrapper →
 *   typed hostname (disruptive) or an explicit acknowledgement (configuration on several devices).
 * The caller owns the dialog/card chrome and the buttons; `canConfirm` tells it when to enable them.
 */
export type ChangeKind = 'config' | 'disruptive'

export interface PlanLine {
  command: string
  kind?: string
}

export function canConfirm(kind: ChangeKind, hostname: string | null | undefined, typed: string): boolean {
  if (kind !== 'disruptive') return true
  return !!hostname && sameHost(typed, hostname)
}

export function ConfirmHeader({ kind, children, className }: { kind: ChangeKind; children: React.ReactNode; className?: string }): React.JSX.Element {
  const d = kind === 'disruptive'
  return (
    <div className={cn('flex items-center gap-2 text-xs text-fg-muted', className)}>
      {d ? <OctagonAlert className="size-3.5 shrink-0 text-danger" /> : <ShieldAlert className="size-3.5 shrink-0 text-warn" />}
      <span className="min-w-0 flex-1">{children}</span>
      <Badge tone={d ? 'danger' : 'warn'}>{d ? 'Disruptive' : 'Configuration'}</Badge>
    </div>
  )
}

export function DisruptiveReasons({ reasons, className }: { reasons: string[]; className?: string }): React.JSX.Element | null {
  if (!reasons.length) return null
  return (
    <ul aria-label="Why it is disruptive" className={cn('space-y-0.5 rounded-md border border-danger/25 bg-danger-soft px-2.5 py-1.5 text-xs text-danger', className)}>
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  )
}

/** The exact lines, inside the platform's wrapper (configure terminal … end, commit …) when there is one. */
export function PlanLines({ before = [], lines, after = [], className }: { before?: string[]; lines: PlanLine[]; after?: string[]; className?: string }): React.JSX.Element {
  const wrapped = before.length + after.length > 0
  const all = [...before.map((c) => ({ c, t: 'wrap' as const })), ...lines.map((l) => ({ c: l.command, t: l.kind === 'disruptive' ? ('danger' as const) : ('line' as const) })), ...after.map((c) => ({ c, t: 'wrap' as const }))]
  return (
    <pre data-testid="plan-lines" className={cn('selectable overflow-x-auto rounded-md bg-term p-2 font-mono text-[12px] leading-[1.55]', className)}>
      {all.map((x, i) => (
        <span key={i} className={x.t === 'wrap' ? 'text-fg-subtle' : x.t === 'danger' ? 'text-danger' : 'text-ok'}>
          {x.t !== 'wrap' && wrapped ? '+ ' : ''}
          {x.c}
          {i < all.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  )
}

/** The typed-hostname gate for a disruptive change. Without a hostname on the prompt it can't be confirmed. */
export function TypedHostname({
  hostname,
  value,
  onChange,
  onSubmit,
  verb = 'run it',
  autoFocus = true,
  className
}: {
  hostname: string | null | undefined
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  verb?: string
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  if (!hostname) return <p className={cn('text-xs text-fg-muted', className)}>The device prompt shows no hostname, so this can't be confirmed here.</p>
  const ok = sameHost(value, hostname)
  return (
    <label className={cn('block text-xs text-fg-muted', className)}>
      Type <code className="select-text font-mono text-fg">{hostname}</code> to {verb}
      <Input
        autoFocus={autoFocus}
        aria-label={`Type ${hostname} to confirm`}
        className="mt-1 h-7 font-mono text-xs"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ok) {
            e.preventDefault()
            onSubmit?.()
          }
        }}
      />
    </label>
  )
}

/** The explicit acknowledgement for configuration on several devices (disruptive never goes to many). */
export function ConfirmCheck({ checked, onChange, children, label = 'Confirm the configuration change' }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; label?: string }): React.JSX.Element {
  return (
    <label className="flex items-center gap-2.5 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-fg">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 shrink-0 accent-[var(--color-warn)]" aria-label={label} />
      <span>{children}</span>
    </label>
  )
}

/** The whole single-device confirmation body (snippet, send to one tab). */
export function ConfigConfirm({
  kind,
  target,
  reasons = [],
  before,
  lines,
  after,
  hostname,
  typed,
  onTyped,
  onSubmit,
  testId
}: {
  kind: ChangeKind
  /** "core-sw1 · Cisco IOS-XE · prompt core-sw1" */
  target: React.ReactNode
  reasons?: string[]
  before?: string[]
  lines: PlanLine[]
  after?: string[]
  hostname?: string | null
  typed: string
  onTyped: (v: string) => void
  onSubmit?: () => void
  testId?: string
}): React.JSX.Element {
  return (
    <div className="space-y-3" data-testid={testId} data-kind={kind}>
      <ConfirmHeader kind={kind}>{target}</ConfirmHeader>
      {kind === 'disruptive' && <DisruptiveReasons reasons={reasons} />}
      <PlanLines before={before} lines={lines} after={after} />
      {kind === 'disruptive' && <TypedHostname hostname={hostname} value={typed} onChange={onTyped} onSubmit={onSubmit} />}
    </div>
  )
}
