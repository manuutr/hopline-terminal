import type { Settings } from '@shared/types'
import { Button, Input } from '../../design'
import { Managed } from '../trust/Managed'
import { useLocks, useTrust } from '../trust/store'
import { Row, Toggle } from './parts'

/**
 * Settings › Assistant, Trust UX rows: the per-run token budget and the "what left this
 * machine" log. Values the team policy fixes are shown locked.
 */
export function TrustRows({ form, up }: { form: Settings; up: <K extends keyof Settings>(k: K, v: Settings[K]) => void }): React.JSX.Element {
  const locks = useLocks()
  const policy = useTrust((s) => s.policy)
  const max = locks.runMaxTokenBudget
  return (
    <>
      <Row k="aiRunTokenBudget" label="Run budget" hint={`Tokens one question may use, all model turns together (output counts 5×). The run is told to finish at the limit.${max ? ` The team policy allows at most ${max.toLocaleString('en-US')}.` : ''}`}>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            aria-label="Run budget"
            min={Math.min(20, max ? Math.floor(max / 1000) : 20)}
            max={max ? Math.floor(max / 1000) : 4000}
            value={Math.round(form.aiRunTokenBudget / 1000)}
            onChange={(e) => up('aiRunTokenBudget', Math.min(max ?? 4_000_000, Math.max(20, Number(e.target.value) || 20) * 1000))}
            className="w-24"
          />
          <span className="text-xs text-fg-subtle">thousand tokens</span>
          {max && <Managed what="Maximum run budget" />}
        </div>
      </Row>
      <Row k="egressLog" label="Log what leaves" hint="Keep every request sent to a model, exactly as sent (redacted), encrypted on this machine. The oldest are removed past 64 MB.">
        <div className="flex items-center gap-2">
          <Toggle label="Log what leaves this machine" checked={form.egressLog} disabled={locks.egressLogRequired} onChange={(v) => up('egressLog', v)} />
          {locks.egressLogRequired && <Managed what="The log" />}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => useTrust.getState().openEgress(true)}>
            View log…
          </Button>
        </div>
      </Row>
      {policy.state === 'active' && (
        <Row label="Team policy" hint="Settings marked Managed by policy are set by your administrator.">
          <div data-testid="policy-info" className="space-y-0.5 text-xs text-fg-muted">
            <div>
              {policy.name ?? 'Team policy'} · <span className="font-mono text-2xs">{policy.source}</span>
            </div>
            {policy.message && <div className="text-fg-subtle">{policy.message}</div>}
          </div>
        </Row>
      )}
    </>
  )
}
