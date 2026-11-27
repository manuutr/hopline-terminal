import { Check, CircleAlert, Folder as FolderIcon, Loader2, Network, Search, Server, ShieldAlert, Square, Tag } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { askConfirm, confirmOpen } from '../../lib/confirm'
import type { FleetReport, FleetStep, LaneStatus } from '@shared/fleet'
import { Group, Panel, type GroupImperativeHandle, type PanelImperativeHandle } from 'react-resizable-panels'
import { Button, cn, Dialog, EmptyState, Kbd, Segmented, Select } from '../../design'
import { Divider } from '../../design/Divider'
import { panelSize, savePanelSize } from '../../lib/panel-sizes'
import { notifyError } from '../../lib/connect'
import { isShortcut } from '../../lib/keys'
import { PLATFORM_SHORT } from '../../lib/platforms'
import { useUi } from '../../store'
import { Markdown } from '../ai/Markdown'
import { impliedSessions, isRunning, newInvestigation, pickedCount, resolveScope, startRun, stopLane, stopRun, subscribeFleet, toggleSelected, useFleet, type Lane, type Picked } from './store'
import { reducedMotion } from '../terminal/theme'
import { fixMention } from './mentions'

/**
 * Fleet run (F10, read-only): pick a scope, ask one question, watch one lane per device and the
 * merged answer. Everything here was resolved, guarded, redacted and verified in main.
 */

const STATUS_TEXT: Record<LaneStatus, string> = {
  idle: 'not dispatched',
  queued: 'queued',
  connecting: 'connecting',
  running: 'running',
  found: 'found',
  not_found: 'not found',
  blocked: 'blocked',
  error: 'error',
  timeout: 'timed out',
  cancelled: 'stopped',
  excluded: 'excluded'
}
const STATUS_TONE: Record<LaneStatus, string> = {
  idle: 'text-fg-subtle',
  queued: 'text-fg-muted',
  connecting: 'text-accent',
  running: 'text-accent',
  found: 'text-ok',
  not_found: 'text-fg-muted',
  blocked: 'text-danger',
  error: 'text-danger',
  timeout: 'text-danger',
  cancelled: 'text-fg-muted',
  excluded: 'text-fg-subtle'
}
const DOT: Record<LaneStatus, string> = {
  idle: 'bg-fg-subtle/40',
  queued: 'bg-fg-subtle',
  connecting: 'bg-accent',
  running: 'bg-accent animate-pulse',
  found: 'bg-ok',
  not_found: 'bg-fg-muted',
  blocked: 'bg-danger',
  error: 'bg-danger',
  timeout: 'bg-danger',
  cancelled: 'bg-fg-muted',
  excluded: 'bg-transparent border border-fg-subtle'
}

/** Lanes that still hold a connection or a model turn: these can be stopped one by one. */
const ACTIVE: LaneStatus[] = ['queued', 'connecting', 'running']
/** More lanes than this: a compact status grid above the columns. */
const GRID_AFTER = 8

/** Stopping is a confirmed choice, and Cancel has the focus (review P2: Enter stopped the device). */
async function confirmStopLane(name: string): Promise<void> {
  if (await askConfirm(`Stop ${name}?`, `The worker on ${name} stops and its connection closes. The other devices go on.`, 'Stop device', { defaultCancel: true, keepFocus: true })) stopLane(name)
}

/** The header's Stop run (and Mod+.): confirmed, Cancel focused. */
export async function confirmStopRun(): Promise<void> {
  const s = useFleet.getState()
  if (!isRunning(s) || s.stopAsked || confirmOpen()) return
  const n = s.lanes.filter((l) => ACTIVE.includes(l.status)).length
  if (await askConfirm('Stop the run?', `Every device's worker stops${n ? ` (${n} still working)` : ''} and the coordinator answers with what it has.`, 'Stop run', { defaultCancel: true, keepFocus: true })) stopRun()
}

/** Lane columns (px); the answer column takes clamp(280px, 32%, 380px) of the row (review P2). */
const LANE_W = 264

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))
const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// ------------------------------------------------------------------ scope step

function ScopePicker(): React.JSX.Element {
  const { folders, sessions } = useUi()
  const picked = useFleet((s) => s.picked)
  const [q, setQ] = useState('')
  const f = q.trim().toLowerCase()
  const hit = (...t: string[]) => !f || t.some((x) => x.toLowerCase().includes(f))
  const tags = useMemo(() => [...new Set(sessions.flatMap((s) => s.tags))].sort((a, b) => a.localeCompare(b)), [sessions])
  const set = (p: Partial<Picked>) => useFleet.setState({ picked: { ...useFleet.getState().picked, ...p }, preview: null })
  const toggle = (kind: 'sessions' | 'folders' | 'tags', id: string) => {
    const list = picked[kind]
    set({ [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id], seed: null })
  }
  // Sessions a ticked folder (with its subfolders) or tag already brings in: shown ticked, "via …"
  // (review P2: ticking a folder left its sessions looking unticked). Main resolves the same way.
  const via = useMemo(() => impliedSessions(picked, folders, sessions), [picked, folders, sessions])
  const row = (kind: 'sessions' | 'folders' | 'tags', id: string, icon: React.ReactNode, label: string, hint?: string) => {
    const own = picked[kind].includes(id)
    const by = kind === 'sessions' && !own ? via.get(id) : undefined
    const on = own || !!by
    // A device seed replaces this list: its rows read as inactive (fg-subtle, AA), not faded.
    const idle = !!picked.seed
    return (
      <button
        key={`${kind}:${id}`}
        role="checkbox"
        aria-checked={on}
        data-kind={kind}
        data-via={by ? 'true' : undefined}
        title={by ? `Included by ${by}` : undefined}
        onClick={() => toggle(kind, id)}
        className={cn(
          'flex h-7 w-full items-center gap-2 rounded px-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-3.5',
          idle ? 'text-fg-subtle hover:bg-hover' : own ? 'bg-accent-soft text-fg' : by ? 'text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
        )}
      >
        <span aria-hidden className={cn('flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border', own && !idle ? 'border-accent bg-accent text-accent-fg' : on && !idle ? 'border-accent text-accent' : 'border-line-input')}>
          {on && <Check className="!size-2.5" strokeWidth={3} />}
        </span>
        <span aria-hidden className="shrink-0 text-fg-subtle">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {by && <span className="shrink-0 text-2xs text-fg-subtle">via {by}</span>}
        {hint && <span className="shrink-0 font-mono text-2xs text-fg-subtle">{hint}</span>}
      </button>
    )
  }
  const section = (title: string, items: React.ReactNode[]) =>
    items.length ? (
      <div role="group" aria-label={title} className="pb-2">
        <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-fg-muted">{title}</div>
        {items}
      </div>
    ) : null
  const saved = sessions.filter((s) => !s.ephemeral)
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex h-7 shrink-0 items-center gap-2 rounded border border-line-input bg-raised px-2 focus-within:border-accent/60">
        <Search aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter devices, folders, tags" aria-label="Filter scope" className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none" />
      </div>
      {picked.seed && <div className="shrink-0 px-2 text-2xs text-fg-subtle">The device walk below sets the scope; this list is not used.</div>}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Scope" role="group">
        {section('Folders', folders.filter((x) => hit(x.name)).map((x) => row('folders', x.id, <FolderIcon />, x.name)))}
        {section('Tags', tags.filter((t) => hit(t)).map((t) => row('tags', t, <Tag />, `#${t}`)))}
        {section('Sessions', saved.filter((s) => hit(s.name, s.host)).map((s) => row('sessions', s.id, <Server />, s.name, PLATFORM_SHORT[s.platform])))}
        {!saved.length ? (
          <EmptyState title="No sessions yet" body="Save a device to select it here." action={<Button size="sm" onClick={() => { useFleet.getState().close(); useUi.getState().set({ editing: { open: true } }) }}>Add a device</Button>} />
        ) : !folders.some((x) => hit(x.name)) && !tags.some((t) => hit(t)) && !saved.some((s) => hit(s.name, s.host)) ? (
          <p className="px-2 py-2 text-xs text-fg-subtle">Nothing matches “{q.trim()}”.</p>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-line pt-2">
        <div className="pb-1 text-xs font-medium text-fg-muted">Or start from a device</div>
        {/* Stacked: the select keeps its full width in the 280 px column (it clipped beside the hops). */}
        <div className="flex flex-col gap-1.5">
          <Select aria-label="Start from device" value={picked.seed ?? ''} onChange={(e) => set({ seed: e.target.value || null })} className="w-full">
            <option value="">None (no CDP/LLDP walk)</option>
            {saved.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {/* Hops only mean something with a device picked (review P2: it looked active without one). */}
          <Segmented
            label="Hops"
            size="sm"
            value={String(picked.hops) as '1' | '2'}
            onChange={(v) => set({ hops: v === '2' ? 2 : 1 })}
            items={[
              { value: '1', label: '1 hop', disabled: !picked.seed },
              { value: '2', label: '2 hops', disabled: !picked.seed }
            ]}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Opened from "@ai … @device" (F11): what came from the message, the mentions that still need a fix
 * (they block the start), and a quick-connect tab that can't take part.
 */
function FromMentionsBlock({ startRef }: { startRef: React.RefObject<HTMLButtonElement | null> }): React.JSX.Element | null {
  const mention = useFleet((s) => s.mention)
  const preview = useFleet((s) => s.preview)
  const tabName = useUi((s) => (mention ? s.tabs.find((t) => t.tabId === mention.tabId)?.title : undefined))
  const firstFix = useRef<HTMLButtonElement>(null)
  // After each resolution: Enter starts the run (the preview is the consent), or the first fix has the focus.
  useEffect(() => {
    if (!mention) return
    const f = requestAnimationFrame(() => (mention.errors.length ? firstFix.current : startRef.current)?.focus())
    return () => cancelAnimationFrame(f)
  }, [mention?.seq, preview]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!mention) return null
  const cur = mention.current
  return (
    <div data-testid="fleet-mentions" className="flex flex-col gap-1 text-xs">
      <div className="text-fg-muted">
        From your <span className="font-mono text-fg">@ai</span> question{tabName ? <> in {tabName}</> : null}
        {cur && 'sessionId' in cur ? (
          <>
            {' '}
            · this device: <span className="text-fg">{cur.name}</span>
          </>
        ) : null}
      </div>
      {cur && 'quick' in cur && (
        <div data-testid="mention-quick" className="flex items-start gap-1.5 text-warn">
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>This tab is a quick-connect session, so it can't be in a fleet run. Save it as a session to include it, or start without it.</span>
        </div>
      )}
      {mention.errors.length > 0 && (
        <ul role="alert" data-testid="mention-errors" className="flex flex-col">
          {mention.errors.map((err, i) => (
            <li key={`${err.raw}:${i}`} data-mention={err.raw} className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line py-1">
              <CircleAlert aria-hidden className="size-3.5 shrink-0 text-danger" />
              <span className="text-danger">{err.message}</span>
              <span className="ml-auto flex flex-wrap items-center gap-1">
                {err.candidates?.map((c, j) => (
                  <Button key={c.name} ref={i === 0 && j === 0 ? firstFix : undefined} size="sm" variant="secondary" onClick={() => fixMention(err, c.name)} title={c.detail}>
                    {c.name}
                    {c.detail && c.detail !== 'folder' && c.detail !== 'tag' && <span className="font-mono text-2xs text-fg-subtle">{c.detail}</span>}
                  </Button>
                ))}
                <Button ref={i === 0 && !err.candidates?.length ? firstFix : undefined} size="sm" variant="ghost" onClick={() => fixMention(err, null)}>
                  Not a device
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ScopeStep(): React.JSX.Element {
  const { picked, preview, selected, resolving, question, concurrency, tokenBudget, status, mention } = useFleet()
  const startRef = useRef<HTMLButtonElement>(null)
  const included = preview?.devices.filter((d) => !d.excluded && selected.includes(d.sessionId)) ?? []
  const runnable = preview?.devices.filter((d) => !d.excluded).length ?? 0
  const tooMany = !!preview && included.length > preview.limits.maxDevices
  const canStart = !!preview && included.length > 0 && !tooMany && question.trim().length > 0 && status !== 'starting' && !mention?.errors.length
  const go = () => {
    if (canStart) void startRun().catch((e) => notifyError('Could not start the investigation', e))
  }
  const resolve = () => void resolveScope().catch((e) => notifyError('Could not resolve the scope', e))
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] gap-0">
      <div className="flex min-h-0 flex-col border-r border-line p-3">
        <ScopePicker />
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
        <FromMentionsBlock startRef={startRef} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Question</span>
          <textarea
            data-autofocus
            value={question}
            onChange={(e) => useFleet.setState({ question: e.target.value })}
            onKeyDown={(e) => {
              if (isShortcut(e, 'Mod+Enter')) {
                e.preventDefault()
                if (preview) go()
                else if (pickedCount(picked)) resolve()
              }
            }}
            rows={3}
            placeholder="What should the selected devices be checked for?"
            aria-label="Question"
            className="resize-none rounded border border-line-input bg-raised px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button onClick={resolve} disabled={!pickedCount(picked) || resolving} aria-busy={resolving}>
            {resolving && <Loader2 className="animate-spin" />}
            {picked.seed ? 'Walk neighbours' : 'Resolve scope'}
          </Button>
          <span className="text-xs text-fg-subtle">Read-only. Workers run show commands through the guard; nothing is changed.</span>
        </div>
        {!preview && !mention?.errors.length && (
          <div data-testid="fleet-scope-empty" className="text-xs text-fg-subtle">
            {resolving ? 'Resolving the scope…' : pickedCount(picked) ? <>Resolve the scope to see the devices (<Kbd keys="Mod+Enter" />).</> : 'Pick folders, tags or sessions on the left, or start from a device.'}
          </div>
        )}
        {preview && (
          <div className="flex flex-col gap-3" data-testid="fleet-scope">
            <table className="w-full text-sm">
              <caption className="pb-1 text-left text-xs font-medium text-fg-muted">
                {included.length} of {runnable} devices selected{tooMany ? ` (at most ${preview.limits.maxDevices} per run)` : ''}
              </caption>
              <tbody>
                {preview.devices.map((d) => {
                  const on = !d.excluded && selected.includes(d.sessionId)
                  return (
                    <tr key={d.sessionId} data-device={d.name} data-excluded={d.excluded ? 'true' : 'false'} data-selected={on ? 'true' : 'false'} className="h-7 border-t border-line">
                      <td className="w-6">
                        {!d.excluded && (
                          <button
                            role="checkbox"
                            aria-checked={on}
                            aria-label={`Include ${d.name}`}
                            onClick={() => toggleSelected(d.sessionId)}
                            className={cn('flex size-3.5 items-center justify-center rounded-[3px] border outline-none focus-visible:ring-1 focus-visible:ring-ring', on ? 'border-accent bg-accent text-accent-fg' : 'border-line-input')}
                          >
                            {on && <Check className="size-2.5" strokeWidth={3} />}
                          </button>
                        )}
                      </td>
                      <td className={cn('pr-2', d.excluded || !on ? 'text-fg-subtle' : 'text-fg')}>{d.name}</td>
                      <td className="pr-2 font-mono text-2xs text-fg-subtle">{PLATFORM_SHORT[d.platform]}</td>
                      <td className="pr-2 text-2xs text-fg-subtle">{d.via}</td>
                      <td className="text-xs text-fg-muted">
                        {d.excluded ??
                          (d.match ? (
                            <span data-testid="scope-match" className="font-mono text-2xs" title="A neighbour name is device data: check it is the device you mean before ticking it">
                              {d.match.by} match: "{d.match.neighbor}" seen from {d.match.seenFrom}
                            </span>
                          ) : (
                            ''
                          ))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {preview.unmatched.length > 0 && (
              <div data-testid="fleet-unmatched">
                <div className="pb-1 text-xs font-medium text-fg-muted">Neighbours not in your sessions (never contacted)</div>
                <ul className="flex flex-col">
                  {preview.unmatched.map((u, i) => (
                    <li key={i} className="flex h-6 items-center gap-2 border-t border-line text-xs">
                      <span className="min-w-0 truncate font-mono text-fg-muted">{u.name}</span>
                      {u.ip && <span className="font-mono text-2xs text-fg-subtle">{u.ip}</span>}
                      <span className="ml-auto shrink-0 text-2xs text-fg-subtle">seen from {u.seenFrom}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
              <label className="flex items-center gap-1.5">
                Parallel
                <Select aria-label="Parallel devices" value={String(concurrency)} onChange={(e) => useFleet.setState({ concurrency: Number(e.target.value) })} className="w-16">
                  {Array.from({ length: preview.limits.maxConcurrency }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex items-center gap-1.5">
                Token budget
                <Select aria-label="Token budget" value={String(tokenBudget)} onChange={(e) => useFleet.setState({ tokenBudget: Number(e.target.value) })} className="w-24">
                  {[100_000, 200_000, 400_000, 800_000, 1_600_000].map((n) => (
                    <option key={n} value={n}>
                      {fmtTokens(n)}
                    </option>
                  ))}
                </Select>
              </label>
              <span>
                {Math.round(preview.budget.laneMs / 60_000)} min per device, {Math.round(preview.budget.runMs / 60_000)} min per run
              </span>
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center justify-end gap-2 pt-2">
          <Button
            ref={startRef}
            variant="primary"
            onClick={go}
            disabled={!canStart}
            onKeyDown={(e) => {
              // A held Enter (the one that sent the @ai line) must not start the run: one fresh press does.
              if (e.key === 'Enter' && e.repeat) e.preventDefault()
            }}
          >
            <Network />
            Investigate {included.length ? `${included.length} device${included.length === 1 ? '' : 's'}` : ''}
            <Kbd keys="Mod+Enter" className="ml-1" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ run step

function StepLine({ s }: { s: FleetStep }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const mark =
    s.status === 'running' ? (
      <Loader2 className="size-3 animate-spin text-accent" />
    ) : s.status === 'ok' ? (
      <Check className="size-3 text-ok" />
    ) : s.status === 'blocked' ? (
      <ShieldAlert className="size-3 text-danger" />
    ) : (
      <CircleAlert className="size-3 text-warn" />
    )
  const more = !!s.preview || (!!s.reason && s.status !== 'ok' && s.status !== 'running')
  return (
    <li data-step-status={s.status} data-command={s.command}>
      <button disabled={!more} onClick={() => setOpen(!open)} title={s.reason} className="flex h-6 w-full items-center gap-1.5 text-left disabled:cursor-default">
        <span className="shrink-0">{mark}</span>
        <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', s.status === 'blocked' ? 'text-fg-subtle line-through' : 'text-fg')}>{s.command}</span>
        {s.status !== 'ok' && s.status !== 'running' && <span className={cn('shrink-0 text-2xs', s.status === 'blocked' ? 'text-danger' : 'text-warn')}>{s.status}</span>}
        {s.copiedFrom && (
          <span className="shrink-0 text-2xs text-warn" title={`This command contains text from ${s.copiedFrom}'s output`}>
            copied
          </span>
        )}
      </button>
      {open && (
        <div className="mb-1 ml-4">
          {s.reason && s.status !== 'ok' && <div className="py-0.5 text-2xs text-fg-muted">{s.reason}</div>}
          {s.preview && <pre className="max-h-48 overflow-auto rounded bg-raised px-2 py-1 font-mono text-2xs leading-4 text-fg-muted">{s.preview}</pre>}
        </div>
      )}
    </li>
  )
}

function ReportView({ r }: { r: FleetReport }): React.JSX.Element {
  return (
    <div data-testid="lane-report" className="flex flex-col gap-1.5 border-t border-line pt-1.5 text-xs">
      {r.findings.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {r.findings.map((f, i) => (
            <li key={i} className="text-fg">
              {f}
            </li>
          ))}
        </ul>
      )}
      {r.evidence.map((g, i) => (
        <div key={i}>
          <div className="font-mono text-2xs text-fg-subtle">{g.command}</div>
          {g.lines.map((l, j) => (
            <div key={j} data-testid="evidence-line" className="truncate font-mono text-2xs text-fg-muted" title={l}>
              {l}
            </div>
          ))}
        </div>
      ))}
      {r.recommendations.length > 0 && (
        <div>
          <div className="text-2xs text-fg-subtle">Recommendation, not applied</div>
          {r.recommendations.map((x, i) => (
            <div key={i} className="font-mono text-2xs text-fg-muted">
              {x}
            </div>
          ))}
        </div>
      )}
      {r.flags.map((f, i) => (
        <div key={i} data-testid="report-flag" className="text-2xs text-warn">
          {f}
        </div>
      ))}
      <div className="text-2xs text-fg-subtle">confidence {r.confidence}</div>
    </div>
  )
}

function LaneColumn({ lane }: { lane: Lane }): React.JSX.Element {
  const active = ACTIVE.includes(lane.status)
  return (
    <section tabIndex={-1} data-lane={lane.name} data-status={lane.status} aria-label={`${lane.name}: ${STATUS_TEXT[lane.status]}`} style={{ width: LANE_W }} className="flex min-h-0 shrink-0 flex-col border-r border-line outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[lane.status])} />
        <span className="min-w-0 truncate text-sm text-fg">{lane.name}</span>
        <span className="shrink-0 font-mono text-2xs text-fg-subtle">{PLATFORM_SHORT[lane.platform] ?? ''}</span>
        <span className={cn('ml-auto shrink-0 text-2xs', STATUS_TONE[lane.status])}>{STATUS_TEXT[lane.status]}</span>
        {active && (
          <button aria-label={`Stop ${lane.name}`} title="Stop this device (Esc)" onClick={() => void confirmStopLane(lane.name)} className="flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle outline-none hover:bg-hover hover:text-danger focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3">
            <Square />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2.5 py-2">
        {lane.excluded && <div className="text-xs text-fg-subtle">{lane.excluded}</div>}
        {lane.task && <div className="text-xs text-fg-muted">{lane.task}</div>}
        {lane.steps.length > 0 && (
          <ul aria-label={`Commands on ${lane.name}`} className="flex flex-col">
            {lane.steps.map((s) => (
              <StepLine key={s.stepId} s={s} />
            ))}
          </ul>
        )}
        {lane.reason && !lane.report?.findings.length && lane.status !== 'running' && <div className="text-2xs text-danger">{lane.reason}</div>}
        {lane.report && <ReportView r={lane.report} />}
      </div>
    </section>
  )
}

function RunHeader(): React.JSX.Element {
  const { asked, status, startedAt, endedAt, usage, lanes, error, budgetTokens, stopAsked } = useFleet()
  const [now, setNow] = useState(Date.now())
  const running = isRunning({ status })
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const elapsed = (endedAt ?? now) - startedAt
  const n = lanes.filter((l) => !l.excluded).length
  // The meter's own figure (output and cache weighted as the budget counts them), so the header and the stop agree.
  const total = usage.metered
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3">
      <span className="min-w-0 flex-1 truncate text-sm text-fg" title={asked}>
        {asked}
      </span>
      <span data-testid="fleet-usage" className={cn('shrink-0 font-mono text-2xs tabular-nums', budgetTokens && total >= budgetTokens * 0.8 ? 'text-warn' : 'text-fg-muted')}>
        {n} device{n === 1 ? '' : 's'} · {fmtElapsed(elapsed)} · {fmtTokens(total)} / {fmtTokens(budgetTokens)} tok{usage.costUsd !== null ? ` · ~$${usage.costUsd.toFixed(2)}` : ''}
      </span>
      <span data-testid="fleet-status" data-status={status} className={cn('shrink-0 text-xs', status === 'error' ? 'text-danger' : status === 'done' ? 'text-ok' : 'text-fg-muted')} title={error}>
        {status === 'starting' ? 'starting' : status}
      </span>
      {running ? (
        <Button variant="danger" size="sm" onClick={() => void confirmStopRun()} disabled={stopAsked} aria-keyshortcuts="Control+Shift+. Meta+.">
          <Square />
          Stop run
          <Kbd keys="Mod+." className="ml-1 text-fg" />
        </Button>
      ) : (
        <Button size="sm" onClick={newInvestigation}>
          New investigation
        </Button>
      )}
    </div>
  )
}

/** Many lanes: one compact tile per device; a click brings its column into view and focuses it. */
function StatusGrid({ lanes }: { lanes: Lane[] }): React.JSX.Element {
  const counts = lanes.reduce<Partial<Record<LaneStatus, number>>>((a, l) => ((a[l.status] = (a[l.status] ?? 0) + 1), a), {})
  const go = (name: string) => {
    const el = document.querySelector<HTMLElement>(`section[data-lane="${CSS.escape(name)}"]`)
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    el?.focus()
  }
  return (
    <div data-testid="fleet-grid" className="shrink-0 border-b border-line px-3 py-1.5">
      <div className="pb-1 text-2xs text-fg-subtle">
        {Object.entries(counts)
          .map(([s, n]) => `${n} ${STATUS_TEXT[s as LaneStatus]}`)
          .join(' · ')}
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-x-2">
        {lanes.map((l, i) => (
          <li key={`${i}:${l.name}`}>
            <button data-grid-lane={l.name} data-status={l.status} onClick={() => go(l.name)} title={`${l.name}: ${STATUS_TEXT[l.status]}`} className="flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-2xs outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-ring">
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[l.status])} />
              <span className="min-w-0 flex-1 truncate text-fg-muted">{l.name}</span>
              <span className={cn('shrink-0', STATUS_TONE[l.status])}>{STATUS_TEXT[l.status]}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const answerHandle =
  'relative w-px bg-line transition-colors duration-[var(--dur-fast)] data-[separator=hover]:bg-accent/50 data-[separator=hover]:delay-200 data-[separator=active]:bg-accent data-[separator=active]:delay-0 data-[separator=active]:duration-0 before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""]'

function RunStep(): React.JSX.Element {
  const { lanes, answer, notes, status, error } = useFleet()
  const running = lanes.filter((l) => !l.excluded)
  const strip = useRef<HTMLDivElement>(null)
  const group = useRef<GroupImperativeHandle | null>(null)
  const answerPanel = useRef<PanelImperativeHandle | null>(null)
  const [answerSize] = useState(() => panelSize('fleetAnswer', 0, 280, 640))
  // Lanes past the right edge (review P2: at 1100 px the third lane was clipped with no sign of more).
  const [hidden, setHidden] = useState(0)
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const measure = () => setHidden(Math.max(0, Math.ceil((el.scrollWidth - el.clientWidth - el.scrollLeft - 8) / LANE_W)))
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [running.length])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunHeader />
      {lanes.some((l) => l.excluded) && (
        <ul aria-label="Not in this run" className="flex shrink-0 flex-wrap gap-x-4 border-b border-line px-3 py-1 text-2xs text-fg-subtle">
          {lanes
            .filter((l) => l.excluded)
            .map((l) => (
              <li key={`x:${l.name}`} data-lane={l.name} data-status="excluded" title={l.excluded}>
                <span className="text-fg-muted">{l.name}</span> not in this run: {l.excluded}
              </li>
            ))}
        </ul>
      )}
      {running.length > GRID_AFTER && <StatusGrid lanes={running} />}
      <Group orientation="horizontal" className="min-h-0 flex-1" groupRef={group}>
        <Panel id="lanes" minSize={240} className="relative flex min-h-0 min-w-0" style={{ overflow: 'hidden' }}>
          <div ref={strip} data-testid="fleet-lanes" className="flex min-h-0 min-w-0 flex-1 overflow-x-auto" aria-label="Lanes">
            {lanes.length ? (
              running.map((l, i) => <LaneColumn key={`${i}:${l.name}`} lane={l} />)
            ) : status === 'error' ? (
              <div role="alert" className="p-3 text-sm text-danger">Did not start: {error ?? 'unknown error'}</div>
            ) : (
              <div className="p-3 text-sm text-fg-subtle">Starting…</div>
            )}
          </div>
          {hidden > 0 && (
            <button
              data-testid="fleet-more-lanes"
              onClick={() => strip.current?.scrollBy({ left: LANE_W, behavior: reducedMotion() ? 'auto' : 'smooth' })}
              className="absolute bottom-4 right-0 z-10 flex h-6 items-center rounded-l border border-r-0 border-line bg-overlay px-2 text-2xs text-fg-muted shadow-overlay hover:text-fg"
            >
              {hidden} more ›
            </button>
          )}
        </Panel>
        {/* The answer column keeps its width between runs; the divider is keyboard-resizable too. */}
        <Divider label="Resize answer column" group={group} before="lanes" after="answer" horizontal panel={answerPanel} panelSide="after" className={answerHandle} />
        <Panel id="answer" panelRef={answerPanel} defaultSize={answerSize || '32%'} minSize={280} maxSize={640} style={{ overflow: 'hidden' }} onResize={(sz) => savePanelSize('fleetAnswer', sz.inPixels, 280)}>
        <aside aria-label="Answer" data-testid="fleet-answer-col" className="flex h-full min-h-0 flex-col">
          <div className="flex h-8 shrink-0 items-center border-b border-line px-3 text-xs font-medium text-fg-muted">Answer</div>
          <div data-testid="fleet-answer" className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
            {answer ? <Markdown text={answer} /> : <span className="text-fg-subtle">{isRunning({ status }) ? 'The coordinator is working…' : 'No answer.'}</span>}
            {notes.map((n, i) => (
              <div key={i} className="mt-2 text-xs text-warn">
                {n}
              </div>
            ))}
            {error && status === 'error' && <div className="mt-2 text-xs text-danger">{error}</div>}
            <div className="mt-3 text-2xs text-fg-subtle">Findings come from read-only commands. Device text in reports is treated as untrusted data. Nothing was changed.</div>
          </div>
        </aside>
        </Panel>
      </Group>
    </div>
  )
}

export function FleetView(): React.JSX.Element {
  const { open, step } = useFleet()
  useEffect(() => subscribeFleet(), [])
  // Mod+. stops the run (through the same confirm) while the view is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, 'Mod+.') || !isRunning(useFleet.getState())) return
      e.preventDefault()
      void confirmStopRun()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? useFleet.setState({ open: true }) : useFleet.getState().close())}
      onEscapeKeyDown={(e) => {
        // Esc on a focused, still-active lane stops that lane (after a confirm) instead of closing the view.
        const lane = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('section[data-lane]') : null
        const name = lane?.dataset.lane
        if (!name || !ACTIVE.includes(lane.dataset.status as LaneStatus)) return
        e.preventDefault()
        void confirmStopLane(name)
      }}
      title="Investigate across devices" description="One question, one read-only worker per device, one merged answer." fill className="h-[88vh] w-[min(1400px,96vw)] top-[6vh]">
      {step === 'scope' ? <ScopeStep /> : <RunStep />}
    </Dialog>
  )
}

