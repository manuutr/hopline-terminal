import { useEffect, useState } from 'react'
import { StatusDot } from '../../design/Badge'
import { Button, Kbd } from '../../design'
import { notifyError } from '../../lib/connect'
import { requestCloseFocusedPane } from '../../lib/confirm'
import { terminals } from '../../lib/terminals'
import { sessionById, useUi, type Tab } from '../../store'
import { elapsed, useSignals } from './liveness'

export function EchoLatency({ id }: { id: string }) {
  const sample = useSignals((s) => s[id]?.vitals)
  const hasSample = sample?.connectedAt && sample.echoRtt !== undefined
  return <span title={hasSample ? 'Device echo round trip, sampled ' + new Date(sample.sampledAt!).toLocaleTimeString() : 'Waiting for a matching device echo at the prompt'} className="inline-flex gap-1 font-mono tabular-nums" aria-label="Device echo round trip">
    <span key={sample?.echoRtt} className="metric-value">{hasSample ? sample.echoRtt + ' ms' : '—'}</span> RTT
  </span>
}

export function SessionSignal({ tab }: { tab?: Tab }) {
  const signal = useSignals((s) => tab && s[tab.tabId])
  const [inspect, setInspect] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!inspect) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [inspect])
  const v = signal?.vitals
  const activity = Math.max(v?.rxAt ?? 0, v?.txAt ?? 0)
  const now = Date.now()
  const label = [tab?.state ?? 'Idle', v?.connectedAt && 'Uptime ' + elapsed(now - v.connectedAt), v?.echoRtt && v.echoRtt + ' ms echo RTT', activity && 'Last activity ' + elapsed(now - activity) + ' ago'].filter(Boolean).join(' · ')
  const alert = signal?.alert
  return <span title={label} onMouseEnter={() => setInspect(true)} onMouseLeave={() => setInspect(false)} className="inline-flex shrink-0 items-center gap-1">
    <span className="relative inline-flex size-3 items-center justify-center" data-glyph={tab?.state ?? 'idle'}>
      <StatusDot state={tab?.state ?? 'idle'} />
      {activity > 0 && <span key={activity} aria-hidden className="activity-blip" />}
    </span>
    {alert && tab && !alert.marker.isDisposed && <button type="button" aria-label={alert.label + ' · Jump to line'} title={alert.label + ' · Jump to line'} className="rounded bg-danger-soft px-1 text-2xs font-medium text-danger" onClick={(e) => {
      e.stopPropagation()
      useUi.getState().activate(tab.tabId)
      requestAnimationFrame(() => terminals.get(tab.tabId)?.term.scrollToLine(alert.marker.line))
    }}>{alert.count}</button>}
  </span>
}

export function reconnectTab(tab: Tab) {
  void window.hopline.term.reconnect(tab.tabId).catch((e) => notifyError('Could not reconnect to ' + tab.title, e))
}

export function ConnectionStrip({ tab, focused, visible }: { tab: Tab; focused: boolean; visible: boolean }) {
  const session = useUi((s) => sessionById(s, tab.sessionId))
  const v = useSignals((s) => s[tab.tabId]?.vitals)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible || (!v?.retryAt && !v?.connectedAt)) return
    const update = () => setNow(Date.now())
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [visible, v?.retryAt, v?.connectedAt])
  const retry = v?.retryAt && tab.state === 'reconnecting' ? Math.max(0, Math.ceil((v.retryAt - now) / 1000)) : null
  const lost = tab.state === 'down' || retry !== null
  const connecting = !lost && (tab.state === 'connecting' || tab.state === 'reconnecting')
  const steps = v?.steps ?? []
  const detail = /authentication failed/i.test(tab.detail ?? '') && session
    ? 'Authentication failed for ' + (session.username ? session.username + '@' : '') + session.name + '. Check the credentials or the device’s AAA configuration.'
    : tab.detail?.split('; retry in')[0]
  const status = tab.state === 'connected' ? steps.at(-1) ?? 'Connected' : steps.join(' › ') || 'Connecting…'
  return <div data-connection-strip role={lost ? 'status' : undefined} aria-atomic={lost ? false : undefined} className="absolute inset-x-0 top-0 flex h-7 items-center gap-2 overflow-hidden border-b border-line bg-surface px-3 text-2xs text-fg-muted">
    <StatusDot state={tab.state} />
    {lost ? <>
      <span className="min-w-0 flex-1 truncate" title={detail}><strong className="font-medium text-fg">{retry !== null ? 'Connection lost' : 'Disconnected'}</strong> · {detail}</span>
      {retry !== null && <span className="inline-flex items-center gap-1 whitespace-nowrap"><svg aria-hidden width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--c-line-strong)" /><circle cx="8" cy="8" r="6" fill="none" stroke="var(--c-warn)" pathLength="100" strokeDasharray={Math.min(100, 100 * retry / Number(/retry in (\d+)s/.exec(tab.detail ?? '')?.[1] || retry || 1)) + ' 100'} transform="rotate(-90 8 8)" /></svg>Retry in {retry}s</span>}
      <Button size="sm" variant="ghost" onClick={() => reconnectTab(tab)}>Reconnect {focused && <Kbd keys="R" />}</Button>
      {session && !session.ephemeral && <Button size="sm" variant="ghost" onClick={() => useUi.getState().set({ editing: { session, open: true } })}>Edit session</Button>}
      <Button size="sm" variant="ghost" onClick={() => { useUi.getState().activate(tab.tabId); requestCloseFocusedPane() }}>Close</Button>
    </> : <>
      <span className="shrink-0 font-mono uppercase text-fg-subtle">{session?.protocol}</span>
      <span className="min-w-0 truncate" role="status" title={steps.join(' → ')}>{status}</span>
      <span className="ml-auto shrink-0 font-mono" title="Session uptime">{v?.connectedAt ? elapsed(now - v.connectedAt) : ''}</span>
    </>}
    {connecting && <span aria-hidden className="connect-progress absolute inset-x-0 top-0 h-0.5 bg-accent" />}
  </div>
}
