import { providerName } from '@shared/providers'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from '../../lib/notify'
import type { EgressDetail, EgressRow, EgressStats } from '@shared/egress'
import { Badge, Button, cn, Dialog, Input, useRovingList } from '../../design'
import { useTrust } from './store'

const p2 = (n: number) => String(n).padStart(2, '0')
const fmtTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const tokens = (r: EgressRow) => (r.inputTokens === null && r.outputTokens === null ? '—' : `${(r.inputTokens ?? 0).toLocaleString('en-US')} / ${(r.outputTokens ?? 0).toLocaleString('en-US')}`)
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e))

const STATUS_TONE: Record<EgressRow['status'], 'ok' | 'warn' | 'danger' | 'neutral'> = { ok: 'ok', sending: 'neutral', error: 'danger', cancelled: 'warn', unknown: 'warn' }
const STATUS_HINT: Partial<Record<EgressRow['status'], string>> = {
  unknown: 'Hopline stopped while this request was being sent: it may have left.',
  error: 'The request failed; it may still have reached the server.',
  cancelled: 'Cancelled; it may still have reached the server.'
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; payloadsSearched: boolean }

/** One request row (module scope: a component declared in render re-mounts and drops focus). */
function RequestRow({ r, selected, option, onPick }: { r: EgressRow; selected: boolean; option: ReturnType<ReturnType<typeof useRovingList>['optionProps']>; onPick: () => void }): React.JSX.Element {
  return (
    <div
      {...option}
      aria-selected={selected}
      data-testid="egress-row"
      onClick={onPick}
      className={cn(
        'grid cursor-default grid-cols-[auto_1fr_auto] items-baseline gap-x-2 rounded px-2 py-1 text-left text-xs outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-active hover:bg-active'
      )}
    >
      {/* fg-subtle is under 4.5:1 on bg-active: a selected row's metadata is fg-muted. */}
      <span className={cn('font-mono text-2xs tabular-nums', selected ? 'text-fg-muted' : 'text-fg-subtle')}>{fmtTime(r.ts).slice(5)}</span>
      <span className="min-w-0 truncate text-fg">
        {providerName(r.provider)} · <span className="font-mono">{r.destination}</span>
      </span>
      {r.status !== 'ok' ? <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> : <span className={cn('text-2xs tabular-nums', selected ? 'text-fg-muted' : 'text-fg-subtle')}>{kb(r.bytes)}</span>}
      <span />
      <span className={cn('col-span-2 min-w-0 truncate text-2xs', selected ? 'text-fg-muted' : 'text-fg-subtle')}>
        {r.model} · {r.source}
        {r.sessionName ? ` · ${r.sessionName}` : ''}
        {r.lane && r.lane !== r.sessionName ? ` · ${r.lane}` : ''} · tokens {tokens(r)}
      </span>
    </div>
  )
}

/**
 * "What left this machine": every model request as it was sent (the redacted prompt and tool
 * results; never headers or the API key). Payloads are decrypted in main when a row is opened.
 * Loading, failures and a locked vault are said as such, never shown as an empty log (review M3).
 */
export function EgressDialog(): React.JSX.Element {
  const open = useTrust((s) => s.egressOpen)
  const [rows, setRows] = useState<EgressRow[]>([])
  const [stats, setStats] = useState<EgressStats | null>(null)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<number | null>(null)
  const [detail, setDetail] = useState<EgressDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const seq = useRef(0)

  const refresh = async (search = q) => {
    const n = ++seq.current
    setLoad({ state: 'loading' })
    try {
      const [r, s] = await Promise.all([window.hopline.egress.search({ search: search.trim() || undefined, limit: 1000 }), window.hopline.egress.stats()])
      if (n !== seq.current) return
      setRows(r.rows)
      setStats(s)
      setLoad({ state: 'ready', payloadsSearched: r.payloadsSearched })
      setSel((cur) => (r.rows.some((x) => x.id === cur) ? cur : (r.rows[0]?.id ?? null)))
    } catch (e) {
      if (n !== seq.current) return
      setLoad({ state: 'error', message: errText(e) })
    }
  }

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => void refresh(q), q ? 250 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q])

  useEffect(() => {
    setDetail(null)
    setDetailError(null)
    if (sel === null || !open) return
    let live = true
    window.hopline.egress
      .get(sel)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setDetailError(errText(e)))
    return () => {
      live = false
    }
  }, [sel, open])

  const selIndex = Math.max(0, rows.findIndex((r) => r.id === sel))
  const list = useRovingList({ count: rows.length, active: selIndex, onActiveChange: (i) => setSel(rows[i]?.id ?? null) })

  const exportRows = async () => {
    try {
      const r = await window.hopline.egress.exportTo(q.trim() ? rows.map((x) => x.id) : [])
      if (r.file) toast.success(`Exported ${r.rows} request${r.rows === 1 ? '' : 's'}`, { description: r.file })
    } catch (e) {
      toast.error('Export failed', { description: errText(e) })
    }
  }

  const close = () => useTrust.getState().openEgress(false)
  const current = rows.find((r) => r.id === sel)
  const searching = !!q.trim()
  const empty =
    load.state === 'loading' && !rows.length ? (
      <span className="flex items-center gap-1.5" data-testid="egress-loading">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </span>
    ) : load.state === 'error' ? null : !rows.length ? (
      searching ? 'No request matches.' : 'Nothing has been sent to a model yet.'
    ) : null

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="What left this machine"
      description="Every request sent to a model, exactly as sent: the redacted prompt and tool results, and the connect checks. Headers and the API key are never recorded. Stored encrypted on this machine."
      className="h-[min(760px,86vh)] w-[min(1200px,96vw)]"
      fill
      footer={
        <>
          <span className="mr-auto text-2xs text-fg-subtle" data-testid="egress-count">
            {rows.length} request{rows.length === 1 ? '' : 's'}
            {stats && ` · ${kb(stats.bytes)} of ${kb(stats.maxBytes)} kept; oldest removed first`}
          </span>
          <Button variant="secondary" disabled={!rows.length || load.state !== 'ready'} onClick={() => void exportRows()}>
            <Download /> Export{searching ? ' matches' : ''}
          </Button>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="mb-2 flex shrink-0 gap-2">
        <Input autoFocus aria-label="Search requests" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts, tool results, models, sessions…" />
        <Button variant="ghost" size="icon" aria-label="Refresh" aria-busy={load.state === 'loading'} onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
      </div>
      {load.state === 'error' && (
        <div role="alert" data-testid="egress-error" className="mb-2 shrink-0 text-xs text-danger">
          Could not read the log: {load.message}
        </div>
      )}
      {load.state === 'ready' && searching && !load.payloadsSearched && (
        <div role="status" data-testid="egress-locked" className="mb-2 shrink-0 text-xs text-warn">
          The vault is locked: only models, sessions and destinations were searched. Unlock to search payloads.
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-3">
        <div {...list.listProps} aria-label="Requests" aria-busy={load.state === 'loading'} className="min-h-0 space-y-px overflow-y-auto border-r border-line pr-1">
          {empty && <div className="px-2 py-3 text-xs text-fg-subtle">{empty}</div>}
          {rows.map((r, i) => (
            <RequestRow key={r.id} r={r} selected={r.id === sel} option={list.optionProps(i)} onPick={() => list.setActive(i, true)} />
          ))}
        </div>
        <div className="flex min-h-0 flex-col">
          {current && (
            <dl className="mb-2 grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs">
              <dt className="text-fg-subtle">Sent</dt>
              <dd className="font-mono text-fg-muted">
                {fmtTime(current.ts)}
                {current.durationMs !== null ? ` · ${(current.durationMs / 1000).toFixed(1)} s` : ''}
                {current.attempts && current.attempts > 1 ? ` · sent ${current.attempts} times (retries)` : ''}
              </dd>
              <dt className="text-fg-subtle">To</dt>
              <dd className="font-mono text-fg-muted">
                {current.provider} · {current.destination} · {current.model}
              </dd>
              <dt className="text-fg-subtle">Run</dt>
              <dd className="truncate font-mono text-fg-muted">{current.runId ?? '—'}</dd>
              <dt className="text-fg-subtle">Size</dt>
              <dd className="font-mono text-fg-muted">
                {current.bytes.toLocaleString('en-US')} bytes · tokens in / out {tokens(current)}
              </dd>
              {STATUS_HINT[current.status] && (
                <>
                  <dt className="text-fg-subtle">Status</dt>
                  <dd className="text-fg-muted">{STATUS_HINT[current.status]}</dd>
                </>
              )}
            </dl>
          )}
          {/* The payload wraps (long JSON lines), and only this well scrolls. */}
          <pre
            data-testid="egress-payload"
            tabIndex={0}
            aria-label="Request payload"
            className="selectable min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-term px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] text-fg-muted [overflow-wrap:anywhere]"
          >
            {detailError
              ? detailError
              : !current
                ? load.state === 'loading'
                  ? ''
                  : 'Pick a request.'
                : !current.hasPayload
                  ? 'The payload was not stored (the vault was locked when it was sent). The metadata above is what is known.'
                  : (detail?.payload ?? 'Decrypting…')}
          </pre>
        </div>
      </div>
    </Dialog>
  )
}
