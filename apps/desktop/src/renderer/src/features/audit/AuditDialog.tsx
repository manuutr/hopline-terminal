import { Copy, RefreshCw, ScrollText } from 'lucide-react'
import { writeClipboard } from '../../lib/clipboard'
import { useMemo, useState } from 'react'
import { toast } from '../../lib/notify'
import type { AuditRow } from '@shared/types'
import { Badge, Button, Dialog, EmptyState, Input, LoadError, Loading, useLoad } from '../../design'
import { useUi } from '../../store'

const TONE: Record<AuditRow['decision'], 'ok' | 'warn' | 'danger' | 'neutral'> = {
  executed: 'ok',
  blocked: 'danger',
  refused: 'warn',
  rejected: 'neutral',
  timeout: 'warn',
  capped: 'warn',
  error: 'danger',
  cancelled: 'neutral',
  inserted: 'neutral',
  verified: 'ok',
  'not-verified': 'warn',
  confirmed: 'ok',
  'rolled-back': 'warn',
  expired: 'warn',
  unknown: 'danger'
}

const fmtTime = (ts: number) => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function toCsv(rows: AuditRow[]): string {
  const cols = ['ts', 'sessionName', 'host', 'source', 'command', 'kind', 'decision', 'reason', 'approver', 'durationMs', 'bytes', 'redactions'] as const
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','))].join('\n')
}

export function AuditDialog(): React.JSX.Element {
  const open = useUi((s) => s.auditOpen)
  const [q, setQ] = useState('')
  const list = useLoad(() => window.hopline.audit.list(2000), [], open)
  const rows: AuditRow[] = list.data ?? []
  const load = list.reload

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((r) => [r.command, r.sessionName, r.host, r.decision, r.reason, r.approver ?? ''].some((v) => v.toLowerCase().includes(needle)))
  }, [rows, q])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && useUi.getState().set({ auditOpen: false })}
      title="AI audit log"
      description="Every command Hopline Terminal sent or tried to send for you, including blocked, refused and rejected ones. Append-only."
      className="w-[min(1100px,96vw)]"
      footer={
        <>
          <span className="mr-auto text-2xs text-fg-subtle">
            {shown.length} of {rows.length} entries
          </span>
          <Button
            variant="secondary"
            disabled={!shown.length}
            onClick={() => void writeClipboard(toCsv(shown)).then(() => toast.success('Copied as CSV'))}
          >
            <Copy /> Copy CSV
          </Button>
          <Button variant="ghost" onClick={() => useUi.getState().set({ auditOpen: false })}>
            Close
          </Button>
        </>
      }
    >
      <div className="mb-3 flex gap-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by command, device, decision, approver…" />
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()}>
          <RefreshCw />
        </Button>
      </div>
      {list.error ? (
        <LoadError what="the audit log" error={list.error} onRetry={() => void load()} />
      ) : list.loading && !list.data ? (
        <Loading what="the audit log" />
      ) : shown.length === 0 ? (
        <EmptyState action={<Button size="sm" onClick={() => rows.length ? setQ('') : useUi.getState().set({ auditOpen: false })}>{rows.length ? 'Clear filter' : 'Return to workspace'}</Button>} icon={<ScrollText />} title={rows.length ? 'No matches' : 'Nothing yet'} body={rows.length ? 'Try a different filter.' : 'Commands the assistant runs or attempts will appear here.'} />
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-md border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-raised text-2xs text-fg-subtle">
              <tr>
                {['Time', 'Device', 'Command', 'Decision', 'Approver', 'Duration', 'Redacted', 'Reason'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2.5 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="selectable">
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-line align-top hover:bg-hover">
                  <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-fg-subtle">{fmtTime(r.ts)}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-fg-muted">
                    {r.sessionName}
                    <div className="font-mono text-2xs text-fg-subtle">{r.host}</div>
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-fg">{r.command}</td>
                  <td className="px-2.5 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={TONE[r.decision]}>{r.decision}</Badge>
                      {r.kind === 'config' && <Badge tone="warn">config</Badge>}
                      {r.kind === 'disruptive' && <Badge tone="danger">disruptive</Badge>}
                      {r.source === 'app' && <Badge tone="neutral">auto-detect</Badge>}
                      {r.source === 'snippet' && <Badge tone="neutral">snippet</Badge>}
                      {r.source === 'multi' && <Badge tone="neutral">multi-device</Badge>}
                      {(r.source === 'transfer' || r.source === 'forward') && <Badge tone="neutral">{r.kind}</Badge>}
                      {r.source === 'capture' && <Badge tone="neutral">packet capture</Badge>}
                      {r.source === 'backup' && <Badge tone="neutral">backup</Badge>}
                      {r.source === 'fleet' && <Badge tone="neutral">{r.lane ? `fleet · ${r.lane}` : 'fleet'}</Badge>}
                      {r.source === 'safety-net' && <Badge tone="neutral">safety net</Badge>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-fg-muted">{r.approver ?? '—'}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-fg-subtle">{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-fg-subtle">{r.redactions || '—'}</td>
                  <td className="max-w-72 px-2.5 py-1.5 text-fg-subtle">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  )
}
