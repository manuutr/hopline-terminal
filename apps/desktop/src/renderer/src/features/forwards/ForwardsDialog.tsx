import { ExternalLink, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from '../../lib/notify'
import { create } from 'zustand'
import type { ForwardStatus } from '@shared/files'
import { describeForward, isAnyAddressBind, isExposedBind } from '@shared/files'
import { Badge, Button, cn, Dialog, Tooltip } from '../../design'
import { useUi } from '../../store'
import { sentence } from '../../lib/sentence'
import { cleanError, formatBytes } from '../files/store'
import { forwardErrors, ForwardFields, type ForwardDraft, type ForwardErrors } from './ForwardFields'

const NONE: ForwardStatus[] = []
const useForwards = create<{ tabId: string | null; byTab: Record<string, ForwardStatus[]> }>(() => ({ tabId: null, byTab: {} }))

let subscribed = false
function subscribe(): void {
  if (subscribed || !window.hopline?.forward) return
  subscribed = true
  window.hopline.forward.onEvent((e) => useForwards.setState((s) => ({ byTab: { ...s.byTab, [e.tabId]: e.forwards } })))
}

/** Open the port forwarding manager for a tab (tab menu). */
export function openForwards(tabId: string): void {
  subscribe()
  useForwards.setState({ tabId })
  void window.hopline.forward.list(tabId).then(
    (list) => useForwards.setState((s) => ({ byTab: { ...s.byTab, [tabId]: list } })),
    (e: unknown) => toast.error('Port forwarding is not available', { description: cleanError(e) })
  )
}

const TONE: Record<ForwardStatus['state'], string> = {
  listening: 'bg-ok',
  starting: 'bg-warn animate-pulse-dot',
  waiting: 'bg-warn',
  error: 'bg-danger',
  stopped: 'bg-fg-subtle'
}
const STATE_TEXT: Record<ForwardStatus['state'], string> = {
  listening: 'Listening',
  starting: 'Starting',
  waiting: 'Waiting for the connection',
  error: 'Error',
  stopped: 'Stopped'
}

/** A wildcard or IPv6 bind is opened on loopback, the address the browser can reach. */
const browserHost = (h: string) => (isAnyAddressBind(h) ? '127.0.0.1' : h.includes(':') ? `[${h}]` : h)

function ForwardRow({ tabId, f }: { tabId: string; f: ForwardStatus }): React.JSX.Element {
  const api = window.hopline.forward
  const running = f.state === 'listening' || f.state === 'waiting' || f.state === 'starting'
  const act = (p: Promise<unknown>) => void p.catch((e: unknown) => toast.error('Port forwarding', { description: sentence(cleanError(e)) })).then(() => openForwards(tabId))
  return (
    <li className="flex items-start gap-3 border-b border-line px-1 py-2.5 last:border-b-0">
      <span role="img" aria-label={STATE_TEXT[f.state]} className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', TONE[f.state])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-fg">{describeForward(f.spec, f.boundPort)}</span>
          {f.spec.label && <span className="truncate text-xs text-fg-subtle">{f.spec.label}</span>}
          <Badge tone="neutral">{f.saved ? 'saved' : 'this tab'}</Badge>
          {isExposedBind(f.spec.bindHost) && (
            <Tooltip label="Reachable from your network, not just this computer">
              <Badge tone="warn">{isAnyAddressBind(f.spec.bindHost) ? 'all interfaces' : 'network'}</Badge>
            </Tooltip>
          )}
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-fg-subtle">
          {STATE_TEXT[f.state]}
          {running && ` · ${f.active} open · ${f.total} total · ↓ ${formatBytes(f.bytesIn)} ↑ ${formatBytes(f.bytesOut)}`}
        </div>
        {f.error && <div className="mt-0.5 text-xs text-danger">{sentence(f.error)}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {f.spec.kind === 'L' && f.state === 'listening' && (
          <Tooltip label={`Open http://${browserHost(f.spec.bindHost)}:${f.boundPort ?? f.spec.bindPort} in your browser`}>
            <Button size="sm" variant="ghost" aria-label={`Open ${describeForward(f.spec, f.boundPort)} in the browser`} onClick={() => void window.hopline.links.open(`http://${browserHost(f.spec.bindHost)}:${f.boundPort ?? f.spec.bindPort}/`)}>
              <ExternalLink />
              Open
            </Button>
          </Tooltip>
        )}
        {running ? (
          <Button size="sm" onClick={() => act(api.stop(tabId, f.spec.id))} aria-label={`Stop ${describeForward(f.spec)}`}>
            <Square />
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={() => act(api.start(tabId, f.spec.id))} aria-label={`Start ${describeForward(f.spec)}`}>
            <Play />
            Start
          </Button>
        )}
        {!f.saved && (
          <Tooltip label="Remove">
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${describeForward(f.spec)}`} onClick={() => act(api.remove(tabId, f.spec.id))}>
              <Trash2 />
            </Button>
          </Tooltip>
        )}
      </div>
    </li>
  )
}

/** Port forwarding manager for one tab: status per forward, start/stop live, add one for this tab. */
export function ForwardsDialog(): React.JSX.Element {
  const tabId = useForwards((s) => s.tabId)
  const list = useForwards((s) => (s.tabId ? (s.byTab[s.tabId] ?? NONE) : NONE))
  const tab = useUi((s) => s.tabs.find((t) => t.tabId === tabId))
  const blank: ForwardDraft = { kind: 'L', bindHost: '127.0.0.1', bindPort: '', destHost: '', destPort: '' }
  const [draft, setDraft] = useState<ForwardDraft>(blank)
  const [errors, setErrors] = useState<ForwardErrors>({})
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!tabId) {
      setDraft(blank)
      setErrors({})
      setFailed(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])
  const close = () => useForwards.setState({ tabId: null })
  const change = (patch: Partial<ForwardDraft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setFailed(null)
    // Once a submit showed errors, they follow the fields as they are fixed.
    if (Object.keys(errors).length) setErrors(forwardErrors(next))
  }
  const add = async () => {
    if (!tabId) return
    const e = forwardErrors(draft)
    setErrors(e)
    if (Object.keys(e).length) return
    const kind = draft.kind
    setBusy(true)
    try {
      const st = await window.hopline.forward.add(tabId, {
        kind,
        bindHost: draft.bindHost.trim() || '127.0.0.1',
        bindPort: Number(draft.bindPort || (kind === 'D' ? 1080 : 0)),
        ...(kind !== 'D' ? { destHost: (draft.destHost ?? '').trim(), destPort: Number(draft.destPort) } : {})
      })
      setDraft({ ...blank, kind })
      setFailed(st.state === 'error' ? `The forward did not start: ${st.error ?? 'unknown error'}` : null)
      openForwards(tabId)
    } catch (err) {
      setFailed(`Could not add the forward: ${cleanError(err)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!tabId} onOpenChange={(o) => !o && close()} title="Port forwarding" description={tab ? `${tab.title} · forwards run while the session is connected and come back after a reconnect` : undefined} className="w-[min(640px,94vw)]">
      {list.length === 0 ? (
        <p className="text-sm text-fg-muted">No forwards yet. Add one below, or save forwards on the session (Edit session → SSH) so they start on every connect.</p>
      ) : (
        <ul aria-label="Forwards" className="-mt-1">
          {list.map((f) => (
            <ForwardRow key={f.spec.id} tabId={tabId!} f={f} />
          ))}
        </ul>
      )}
      <form
        className="mt-4 rounded-lg border border-line bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <div className="mb-2 text-xs font-medium text-fg-muted">Add a forward for this tab</div>
        <ForwardFields idPrefix="fwd" value={draft} onChange={change} errors={errors} />
        {failed && <p className="mt-2 text-xs text-danger">{failed}</p>}
        <div className="mt-3 flex justify-end">
          <Button type="submit" variant="primary" disabled={busy}>
            <Plus />
            Add and start
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
