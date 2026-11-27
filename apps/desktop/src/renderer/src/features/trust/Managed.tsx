import { Lock, OctagonAlert } from 'lucide-react'
import { MANAGED_BY_POLICY } from '@shared/policy'
import { cn, Tooltip } from '../../design'
import { policyName, useTrust } from './store'

/** "Managed by policy" next to a setting the team policy fixes. */
export function Managed({ className, what }: { className?: string; what?: string }): React.JSX.Element {
  const policy = useTrust((s) => s.policy)
  const where = policy.source ? ` (${policy.source})` : ''
  return (
    <Tooltip label={`${what ? `${what}: ` : ''}set by ${policyName(policy)}${where}. Ask your administrator to change it.`}>
      <span data-testid="managed-by-policy" className={cn('inline-flex items-center gap-1 text-2xs text-fg-muted', className)}>
        <Lock className="size-3" /> {MANAGED_BY_POLICY}
      </span>
    </Tooltip>
  )
}

/**
 * App-wide line for the team policy. Invalid: a danger banner (read-only on, AI off). Active:
 * nothing here (each locked setting says so); its message, if any, is shown in Settings.
 */
export function PolicyBanner(): React.JSX.Element | null {
  const policy = useTrust((s) => s.policy)
  if (policy.state !== 'invalid') return null
  return (
    <div role="alert" data-testid="policy-banner" className="flex items-center gap-2 border-b border-danger/30 bg-danger-soft px-3 py-1.5 text-xs text-danger">
      <OctagonAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={`${policy.source}: ${policy.error}`}>
        Team policy is invalid ({policy.error}). Read-only mode is on and the assistant is off. File: <span className="font-mono">{policy.source}</span>
      </span>
    </div>
  )
}
