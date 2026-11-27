import { ViewerGrip } from '../../design/ViewerGrip'
import { isIpv4 } from '@hopline/cli-model'
import { ArrowLeft, Ban, Check, CircleSlash, Cloud, Folder as FolderIcon, Loader2, OctagonAlert, Play, Search, Server, Square, Tag, TerminalSquare, X } from 'lucide-react'
import { Tabs } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MultiPreviewRow, TargetSpec } from '@shared/productivity'
import { compareOutputs, stripEcho } from '@shared/output-diff'
import { Badge, Button, cn, ConfirmCheck, DataTable, Dialog, EmptyState, Input, Kbd, Segmented, SelectMenu, Toggle, useRovingList } from '../../design'
import { sentence } from '../../lib/sentence'
import { notifyError } from '../../lib/connect'
import { toast } from '../../lib/notify'
import { copyTicketReport } from '../../lib/command-evidence'
import { isShortcut } from '../../lib/keys'
import { PLATFORM_SHORT, platformLabel } from '../../lib/platforms'
import { useUi } from '../../store'
import { mergeTables } from './tables'
import { attachRun, isFinal, subscribeMulti, useMulti, type TargetResult } from './store'

type Kind = keyof Required<TargetSpec>

const KIND_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = { read: 'ok', config: 'warn', disruptive: 'danger', blocked: 'danger', refused: 'neutral' }

const total = (p: Required<TargetSpec>) => p.tabs.length + p.sessions.length + p.folders.length + p.tags.length

interface PickItem {
  kind: Kind
  id: string
  icon: React.ReactNode
  label: string
  hint?: string
}

type OptionProps = ReturnType<ReturnType<typeof useRovingList>['optionProps']> & { onClick: () => void }

/** One target row: an option in a multi-select listbox (module scope, so focus survives a toggle). */
function PickRow({ item, on, props }: { item: PickItem; on: boolean; props: OptionProps }): React.JSX.Element {
  return (
    <div
      {...props}
      aria-selected={on}
      data-kind={item.kind}
      className={cn(
        'flex h-7 w-full cursor-default items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-3.5',
        on ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
      )}
    >
      <span aria-hidden className={cn('flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border', on ? 'border-accent bg-accent text-white' : 'border-line-input')}>
        {on && <Check className="!size-2.5" strokeWidth={3} />}
      </span>
      <span aria-hidden className="shrink-0 text-fg-subtle">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint && <span className="shrink-0 font-mono text-2xs text-fg-subtle">{item.hint}</span>}
    </div>
  )
}

function PickSection({ title, children }: { title: string; children: React.ReactNode[] }): React.JSX.Element | null {
  if (!children.length) return null
  return (
    <div role="group" aria-label={title} className="pb-2">
      <div aria-hidden className="px-2 pb-1 pt-1.5 text-2xs font-medium text-fg-subtle">{title}</div>
      {children}
    </div>
  )
}

const SECTIONS: [Kind, string][] = [
  ['tabs', 'Open tabs'],
  ['folders', 'Folders'],
  ['tags', 'Tags'],
  ['sessions', 'Sessions']
]

/**
 * Open tabs, folders, tags and sessions as one multi-select listbox (roving focus: arrows,
 * Home/End, Space or Enter toggles; Down from the filter enters the list). Devices are resolved in main.
 */
function TargetPicker(): React.JSX.Element {
  const { tabs, folders, sessions } = useUi()
  const picked = useMulti((s) => s.picked)
  const [q, setQ] = useState('')
  const f = q.trim().toLowerCase()
  const hit = (...t: string[]) => !f || t.some((x) => x.toLowerCase().includes(f))
  const tags = [...new Set(sessions.flatMap((s) => s.tags))].sort((a, b) => a.localeCompare(b))
  const items: PickItem[] = [
    ...tabs.filter((t) => hit(t.title)).map((t): PickItem => ({ kind: 'tabs', id: t.tabId, icon: <TerminalSquare />, label: t.title, hint: t.state === 'connected' ? undefined : t.state })),
    ...folders.filter((x) => hit(x.name)).map((x): PickItem => ({ kind: 'folders', id: x.id, icon: <FolderIcon />, label: x.name })),
    ...tags.filter((t) => hit(t)).map((t): PickItem => ({ kind: 'tags', id: t, icon: <Tag />, label: `#${t}` })),
    ...sessions.filter((s) => hit(s.name, s.host)).map((s): PickItem => ({ kind: 'sessions', id: s.id, icon: <Server />, label: s.name, hint: PLATFORM_SHORT[s.platform] }))
  ]
  const toggle = (it: PickItem) => {
    const cur = useMulti.getState().picked
    const list = cur[it.kind]
    useMulti.setState({ picked: { ...cur, [it.kind]: list.includes(it.id) ? list.filter((x) => x !== it.id) : [...list, it.id] } })
  }
  const list = useRovingList({ count: items.length, onSpace: (i) => toggle(items[i]!), onEnter: (i) => toggle(items[i]!) })
  const row = (it: PickItem, i: number) => (
    <PickRow
      key={`${it.kind}:${it.id}`}
      item={it}
      on={picked[it.kind].includes(it.id)}
      props={{
        ...list.optionProps(i),
        onClick: () => {
          list.setActive(i)
          toggle(it)
        }
      }}
    />
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <label className="flex h-7 shrink-0 items-center gap-2 rounded-md border border-line-input bg-surface px-2 focus-within:border-accent/60">
        <Search aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && items.length) {
              e.preventDefault()
              list.focus()
            }
          }}
          placeholder="Filter devices, folders, tags"
          aria-label="Filter targets"
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
        />
      </label>
      <div {...list.listProps} aria-label="Targets" aria-multiselectable className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {SECTIONS.map(([kind, title]) => (
          <PickSection key={kind} title={title}>
            {items.flatMap((it, i) => (it.kind === kind ? [row(it, i)] : []))}
          </PickSection>
        ))}
        {!items.length && <EmptyState title={f ? `Nothing matches “${q.trim()}”.` : 'No sessions yet'} body={f ? 'Try a device name or address.' : 'Add a device to select it here.'} action={<Button size="sm" onClick={() => {
          if (f) setQ('')
          else { useMulti.getState().close(); useUi.getState().set({ editing: { open: true } }) }
        }}>{f ? 'Clear search' : 'Add a device'}</Button>} />}
      </div>
    </div>
  )
}

function Compose({ onPreview }: { onPreview: () => void }): React.JSX.Element {
  const { mode, command, perPlatform, concurrency, picked, resolved, info } = useMulti()
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => input.current?.focus(), [mode])
  // Resolve the picked groups to devices (in main) whenever the picks change.
  useEffect(() => {
    let live = true
    if (!total(picked)) return void useMulti.setState({ resolved: [] })
    window.hopline.multi.resolve(picked).then((r) => live && useMulti.setState({ resolved: r }), (e) => notifyError('Could not list the devices', e))
    return () => void (live = false)
  }, [picked])
  const excluded = resolved.filter((t) => t.excluded)
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,260px)_minmax(0,1fr)] gap-5">
      <TargetPicker />
      <div className="flex min-w-0 flex-col gap-3">
        <label className="block">
          <span className="text-xs font-medium text-fg-muted">{mode === 'run' ? 'Show command' : 'Commands'}</span>
          <textarea
            ref={input}
            aria-label={mode === 'run' ? 'Show command' : 'Commands to send'}
            value={command}
            rows={mode === 'run' ? 2 : 7}
            spellCheck={false}
            maxLength={4000}
            placeholder={mode === 'run' ? 'show interfaces status' : 'ntp server 10.0.0.1\nlogging host 10.0.0.5'}
            onChange={(e) => useMulti.setState({ command: e.target.value })}
            onKeyDown={(e) => {
              // The same chord the Preview button shows.
              if (isShortcut(e.nativeEvent, 'Mod+Enter')) {
                e.preventDefault()
                e.stopPropagation()
                onPreview()
              }
            }}
            className="mt-1 w-full resize-y rounded-md border border-line-input bg-term px-2.5 py-2 font-mono text-[12px] leading-[1.55] text-fg placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none"
          />
          <span className="mt-1 block text-2xs text-fg-subtle">
            {mode === 'run'
              ? 'Read-only: anything that is not a show command on a device’s platform is refused for that device.'
              : 'Each device classifies these lines for its own platform. Configuration needs your confirmation; disruptive and blocked commands are never sent to several devices.'}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {mode === 'run' && (
            <Toggle
              inline
              className="-ml-1.5"
              label="Translate per platform"
              hint="Each platform gets its own equivalent command"
              checked={perPlatform}
              onChange={(v) => useMulti.setState({ perPlatform: v })}
            />
          )}
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            At once
            <SelectMenu
              aria-label="Devices at once"
              className="w-16"
              value={String(concurrency)}
              onValueChange={(v) => useMulti.setState({ concurrency: Number(v) })}
              options={Array.from({ length: info?.maxConcurrency ?? 8 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 flex h-7 items-center justify-between gap-3 border-b border-line bg-overlay px-2.5 text-2xs text-fg-subtle">
            <span className="shrink-0" data-testid="multi-count">{resolved.length ? `${resolved.length - excluded.length} device${resolved.length - excluded.length === 1 ? '' : 's'}` : 'No devices picked'}</span>
            <span className="min-w-0 truncate" title="Open tabs are reused; others connect in the background with their stored credentials">Open tabs are reused; others connect in the background with their stored credentials</span>
          </div>
          {resolved.map((t) => (
            <div key={t.key} className="flex h-7 items-center gap-2 px-2.5 text-xs">
              <span className={cn('min-w-0 flex-1 truncate', t.excluded ? 'text-fg-subtle line-through' : 'text-fg')}>{t.name}</span>
              <span className="shrink-0 font-mono text-2xs text-fg-subtle">{PLATFORM_SHORT[t.platform]}</span>
              {t.excluded ? <span className="max-w-[55%] truncate text-2xs text-warn" title={t.excluded}>{t.excluded}</span> : t.tabId ? <Badge>open tab</Badge> : <Badge tone="neutral"><Cloud className="size-3" />background</Badge>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Lines({ row }: { row: MultiPreviewRow }): React.JSX.Element {
  if (!row.lines.length) return <span className="text-fg-subtle">—</span>
  return (
    <pre className="selectable whitespace-pre-wrap font-mono text-[11.5px] leading-[1.5]">
      {row.wrapper?.before.map((c, i) => <span key={`b${i}`} className="text-fg-subtle">{c}{'\n'}</span>)}
      {row.lines.map((l, i) => (
        <span key={i} className={l.kind === 'read' ? 'text-fg' : l.kind === 'config' ? 'text-ok' : 'text-danger'}>
          {row.wrapper ? '+ ' : ''}
          {l.command}
          {'\n'}
        </span>
      ))}
      {row.wrapper?.after.map((c, i) => <span key={`a${i}`} className="text-fg-subtle">{c}{'\n'}</span>)}
    </pre>
  )
}

function PreviewTable({ confirm, setConfirm }: { confirm: boolean; setConfirm: (v: boolean) => void }): React.JSX.Element {
  const preview = useMulti((s) => s.preview)!
  const { counts } = preview
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted" data-testid="multi-counts">
        {counts.read > 0 && <Badge tone="ok">{counts.read} read-only</Badge>}
        {counts.config > 0 && <Badge tone="warn">{counts.config} configuration</Badge>}
        {counts.refused > 0 && <Badge tone="neutral">{counts.refused} not sent</Badge>}
        <span className="ml-1 min-w-0 text-fg-subtle">Exactly what each device gets, classified for its own platform. Nothing has been sent.</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs" aria-label="Preview">
          <thead className="sticky top-0 bg-surface text-left text-2xs font-medium text-fg-subtle">
            <tr className="border-b border-line">
              <th className="w-[28%] min-w-36 px-2.5 py-1.5 font-medium">Device</th>
              <th className="w-24 px-2 py-1.5 font-medium">Guard</th>
              <th className="px-2 py-1.5 font-medium">Sends</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r) => (
              <tr key={r.target.key} data-target={r.target.name} data-kind={r.kind} className="border-b border-line align-top last:border-0">
                <td className="px-2.5 py-2">
                  <div className="truncate text-fg">{r.target.name}</div>
                  <div className="text-2xs text-fg-subtle">
                    <span className="whitespace-nowrap">{platformLabel(r.target.platform)}</span>
                    {r.target.tabId ? (
                      r.target.hostname ? (
                        <>
                          {' · '}
                          <span className="whitespace-nowrap">open tab, prompt</span>{' '}
                          <code className="inline-block max-w-full truncate whitespace-nowrap align-bottom font-mono text-fg-muted" title={r.target.hostname}>
                            {r.target.hostname}
                          </code>
                        </>
                      ) : (
                        <span className="whitespace-nowrap"> · open tab</span>
                      )
                    ) : (
                      <span className="whitespace-nowrap"> · background</span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <Badge tone={KIND_TONE[r.kind]}>{r.kind === 'refused' ? 'not sent' : r.kind}</Badge>
                  {r.translated && <div className="mt-1 text-2xs text-accent">translated</div>}
                </td>
                <td className="px-2 py-2">
                  <Lines row={r} />
                  {r.kind !== 'read' && r.kind !== 'config' && <div className="mt-1 text-2xs text-fg-muted">{sentence(r.reason)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.needsConfirm && (
        <ConfirmCheck checked={confirm} onChange={setConfirm}>
          I confirm this configuration change on {counts.config} device{counts.config === 1 ? '' : 's'}. It is logged with my name.
        </ConfirmCheck>
      )}
    </div>
  )
}

const ms = (n?: number) => (n === undefined ? '' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`)

function StatusIcon({ s }: { s?: string }): React.JSX.Element {
  if (s === 'connecting' || s === 'running') return <Loader2 className="size-3.5 animate-spin text-accent" />
  if (s === 'ok') return <Check className="size-3.5 text-ok" />
  if (s === 'blocked') return <OctagonAlert className="size-3.5 text-danger" />
  if (s === 'refused' || s === 'rejected') return <Ban className="size-3.5 text-warn" />
  if (s === 'skipped' || s === 'cancelled') return <CircleSlash className="size-3.5 text-fg-subtle" />
  if (s === 'queued' || !s) return <span className="size-1.5 rounded-full bg-fg-subtle" />
  return <X className="size-3.5 text-danger" />
}

/** The default compare baseline: the first finished device of the platform most devices share (round 2). */
export function defaultBaseline(ok: { key: string; platform: string }[]): string | undefined {
  const count = new Map<string, number>()
  for (const o of ok) count.set(o.platform, (count.get(o.platform) ?? 0) + 1)
  let best: string | undefined
  for (const o of ok) if (best === undefined || count.get(o.platform)! > count.get(best)!) best = o.platform
  return ok.find((o) => o.platform === best)?.key
}

function ResultRow({ name, status, active, props, badge, background, ms: dur }: { name: string; status?: string; active: boolean; props: OptionProps; badge?: React.ReactNode; background?: boolean; ms: string }): React.JSX.Element {
  return (
    <div
      {...props}
      aria-selected={active}
      data-target={name}
      data-status={status ?? 'queued'}
      className={cn(
        'flex h-8 w-full cursor-default items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        active ? 'bg-active text-fg' : 'text-fg-muted hover:bg-hover'
      )}
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        <StatusIcon s={status} />
      </span>
      <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
      {badge}
      {background && (
        <span title="Background connection" className="shrink-0">
          <Cloud className="size-3 text-fg-subtle" />
        </span>
      )}
      {dur && <span className="shrink-0 text-right font-mono text-2xs text-fg-subtle">{dur}</span>}
    </div>
  )
}

function Results(): React.JSX.Element {
  const { preview, results, info, mode } = useMulti()
  const rows = preview?.rows ?? []
  const [sel, setSel] = useState<string | null>(null)
  const [view, setView] = useState<'raw' | 'diff' | 'table'>('raw')
  const [destination, setDestination] = useState('')
  const addressInput = useRef<HTMLInputElement>(null)
  const [scope, setScope] = useState<'device' | 'all'>('device')
  const [noise, setNoise] = useState(true)
  const okRows = rows.filter((r) => results[r.target.key]?.status === 'ok')
  const okKeys = okRows.map((r) => r.target.key)
  const [base, setBase] = useState<string | null>(null)
  const baseline = base && okKeys.includes(base) ? base : defaultBaseline(okRows.map((r) => ({ key: r.target.key, platform: r.target.platform })))
  const selected = sel ?? rows[0]?.target.key ?? null
  const res: TargetResult | undefined = selected ? results[selected] : undefined
  const row = rows.find((r) => r.target.key === selected)
  const text = (k: string) => stripEcho(results[k]?.output ?? '', results[k]?.command ?? '')
  const diffs = useMemo(() => {
    if (view !== 'diff' || !baseline) return new Map<string, ReturnType<typeof compareOutputs>[number]>()
    return new Map(compareOutputs(text(baseline), okKeys.filter((k) => k !== baseline).map((k) => ({ key: k, text: text(k) })), { noise }).map((d) => [d.key, d]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, baseline, noise, results])
  const done = rows.filter((r) => isFinal(results[r.target.key]?.status)).length
  const tableOff = !info?.parser || mode !== 'run'
  const name = (k: string) => rows.find((r) => r.target.key === k)?.target.name ?? k
  const platformOf = (k: string | null | undefined) => rows.find((r) => r.target.key === k)?.target.platform
  const index = Math.max(0, rows.findIndex((r) => r.target.key === selected))
  const list = useRovingList({ count: rows.length, active: index, onActiveChange: (i) => setSel(rows[i]?.target.key ?? null) })

  // The merged table: every device whose output parsed with the selected device's template (or the most common one).
  const tables = rows.flatMap((r) => (results[r.target.key]?.table ? [{ key: r.target.key, name: r.target.name, table: results[r.target.key]!.table! }] : []))
  const templateCount = new Map<string, number>()
  for (const t of tables) templateCount.set(t.table.template, (templateCount.get(t.table.template) ?? 0) + 1)
  const template = res?.table?.template ?? [...templateCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const merged = useMemo(() => (template ? mergeTables(tables, template, destination) : null), [template, results, destination]) // eslint-disable-line react-hooks/exhaustive-deps
  const query = destination.trim()
  const invalidAddress = !!query && !isIpv4(query)
  const showAll = scope === 'all' && !!merged

  const pathCount = merged?.rows.length ?? 0
  const defaultPaths = merged?.defaultPaths ?? 0
  const lookupHint = invalidAddress ? 'Enter a complete IPv4 address.'
    : query && pathCount ? `${pathCount} matching ${pathCount === 1 ? 'path' : 'paths'} · ${defaultPaths} via default route`
    : 'Find the longest matching active prefix in each captured routing context.'
  const scopeSwitch = merged && merged.devices > 1 && (
    <Segmented
      label="Table scope"
      size="sm"
      value={scope}
      onChange={setScope}
      items={[
        { value: 'device', label: 'This device' },
        { value: 'all', label: `All ${merged.devices}` }
      ]}
    />
  )

  return (
    <Tabs.Root value={view} onValueChange={(value) => setView(value as typeof view)}
      className="grid min-h-0 flex-1 grid-cols-[clamp(148px,18vw,208px)_minmax(0,1fr)] gap-3">
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line px-2.5 text-2xs text-fg-subtle">
          <span className="font-medium text-fg-muted">Devices</span>
          <span className="shrink-0 tabular-nums" data-testid="multi-progress">
            {done} of {rows.length} done
          </span>
        </div>
        <div {...list.listProps} aria-label="Devices" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1">
          {rows.map((r, i) => {
            const x = results[r.target.key]
            const d = diffs.get(r.target.key)
            const badge =
              view === 'diff' && x?.status === 'ok' ? (
                r.target.key === baseline ? (
                  <Badge>baseline</Badge>
                ) : (
                  d && <Badge tone={d.changed ? 'warn' : 'ok'}>{d.changed ? `${d.changed} lines` : 'same'}</Badge>
                )
              ) : undefined
            return (
              <ResultRow
                key={r.target.key}
                name={r.target.name}
                status={x?.status}
                active={r.target.key === selected}
                badge={badge}
                background={view !== 'diff' && x?.background}
                ms={view !== 'diff' ? ms(x?.durationMs) : ''}
                props={{ ...list.optionProps(i), onClick: () => setSel(r.target.key) }}
              />
            )
          })}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Tabs.List aria-label="Result view" className="flex h-7 shrink-0 items-center rounded-md border border-line-strong bg-surface p-0.5">
            {(['raw', 'diff', 'table'] as const).map((v) => (
              <Tabs.Trigger
                key={v}
                value={v}
                disabled={v === 'table' && tableOff}
                title={v === 'table' && tableOff ? (mode !== 'run' ? 'Tables are for multi-device runs' : 'No TextFSM parser is installed yet') : undefined}
                className={cn(
                  'h-full whitespace-nowrap rounded-sm px-2 text-xs transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:text-fg-subtle',
                  view === v ? 'bg-active font-medium text-fg' : 'text-fg-muted hover:text-fg'
                )}
              >
                {v === 'raw' ? 'Output' : v === 'diff' ? 'Compare' : 'Table'}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {view === 'table' && scopeSwitch && <div className="ml-auto">{scopeSwitch}</div>}
          {view === 'diff' && (
            <>
              <SelectMenu aria-label="Baseline device" className="w-40 min-w-0" value={baseline ?? ''} onValueChange={setBase} options={okKeys.map((k) => ({ value: k, label: name(k) }))} placeholder="Baseline" />
              <Toggle inline className="ml-auto" label="Hide noise" hint="Clocks, uptimes, counters and timestamps" checked={noise} onChange={setNoise} />
            </>
          )}
          {view === 'raw' && res?.command && <code className="ml-auto min-w-0 truncate font-mono text-2xs text-fg-subtle">{res.command.split('\n')[0]}</code>}
        </div>
        <Tabs.Content value={view} className={cn('min-h-0 flex-1 rounded-md border border-line', view === 'table' ? 'flex flex-col bg-surface' : 'overflow-auto bg-term')} data-testid="multi-output">
          {view === 'raw' && (
            <>
              {res?.reason && <div className={cn('border-b border-line px-3 py-1.5 text-xs', res.status === 'ok' ? 'text-fg-muted' : 'text-warn')}>{sentence(res.reason)}</div>}
              <pre className="selectable whitespace-pre p-3 font-mono text-[12px] leading-[1.55] text-fg">
                {res?.output || (isFinal(res?.status) ? '' : res?.status === 'connecting' ? 'Connecting…' : res?.status === 'running' ? 'Running…' : 'Waiting…')}
              </pre>
            </>
          )}
          {view === 'diff' && (
            <DiffView
              baseName={baseline ? name(baseline) : ''}
              sel={selected && selected !== baseline ? selected : null}
              d={selected ? diffs.get(selected) : undefined}
              name={selected ? name(selected) : ''}
              ok={res?.status === 'ok'}
              otherPlatform={!!baseline && !!selected && platformOf(baseline) !== platformOf(selected)}
            />
          )}
          {view === 'table' && showAll && merged.source && (
            <div className="shrink-0 space-y-1 border-b border-line px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="route-destination" className="text-xs font-medium text-fg">Destination IPv4</label>
                <Input id="route-destination" ref={addressInput} aria-invalid={invalidAddress} aria-describedby="route-lookup-help" value={destination}
                  onChange={(e) => setDestination(e.target.value)} placeholder="e.g. 10.100.0.10" className="h-7 w-36 font-mono" />
                {destination && <Button variant="ghost" size="sm" onClick={() => { setDestination(''); addressInput.current?.focus() }}>Clear lookup</Button>}
              </div>
              <p id="route-lookup-help" role="status" className={cn('text-xs', invalidAddress ? 'text-warn' : 'text-fg-muted')}>
                {lookupHint}
              </p>
              {merged.limited && <p className="text-xs text-warn">Some device tables reached the row limit. Check the raw output for missing paths.</p>}
            </div>
          )}
          {view === 'table' &&
            (showAll ? (
              <DataTable
                label="Parsed table, all devices"
                emptyMessage={merged!.source && query ? (invalidAddress ? 'Enter a complete IPv4 address to look up routes.' : 'No active route matched this address in the captured, named routing contexts.') : undefined}
                headers={merged!.headers}
                rows={merged!.rows}
                title={`${merged!.devices} devices`}
                source={merged!.source ?? `TextFSM · ${template!.replace(/\.textfsm$/, '')}`}
                resetKey={`all:${merged!.source ?? template}`}
                className="flex-1"
              />
            ) : res?.table ? (
              <DataTable
                label="Parsed table"
                headers={res.table.headers}
                rows={res.table.rows}
                title={row?.target.name}
                source={`TextFSM · ${res.table.template.replace(/\.textfsm$/, '')}`}
                resetKey={selected}
                className="flex-1"
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-fg-subtle">
                <p>No table for {row?.target.name ?? 'this device'}: no template matches this command on its platform.</p>
                {merged && merged.devices > 0 && (
                  <Button size="sm" onClick={() => setScope('all')}>
                    Show all {merged.devices} parsed devices
                  </Button>
                )}
              </div>
            ))}
        </Tabs.Content>
      </div>
    </Tabs.Root>
  )
}

function DiffView({ baseName, sel, d, name, ok, otherPlatform }: { baseName: string; sel: string | null; d?: ReturnType<typeof compareOutputs>[number]; name: string; ok: boolean; otherPlatform?: boolean }): React.JSX.Element {
  if (!baseName) return <p className="p-6 text-center text-xs text-fg-subtle">Nothing to compare yet: no device finished.</p>
  if (!sel) return <p className="p-6 text-center text-xs text-fg-subtle">{baseName} is the baseline. Pick another device to compare it.</p>
  if (!ok || !d) return <p className="p-6 text-center text-xs text-fg-subtle">{name} has no output to compare.</p>
  if (!d.changed) return <p className="p-6 text-center text-xs text-fg-muted" data-testid="diff-same">{name} matches {baseName}.</p>
  return (
    <>
      {otherPlatform && <div className="border-b border-line px-3 py-1.5 text-xs text-fg-muted">{name} runs a different platform than {baseName}: expect the format itself to differ.</div>}
    <pre className="selectable p-3 font-mono text-[12px] leading-[1.55]" aria-label={`${name} compared to ${baseName}`}>
      {d.ops.map((o, i) => (
        <div key={i} className={cn('-mx-3 px-3', o.op === 'add' ? 'bg-ok-soft text-ok' : o.op === 'del' ? 'bg-danger-soft text-danger' : 'text-fg-subtle')}>
          {o.op === 'add' ? '+ ' : o.op === 'del' ? '- ' : '  '}
          {o.text || ' '}
        </div>
      ))}
    </pre>
    </>
  )
}

/** Send-to-many and multi-device runs: pick devices, preview per device, then watch the results. */
export function MultiDialog(): React.JSX.Element {
  const { open, mode, step, command, picked, perPlatform, concurrency, preview, running, resolved } = useMulti()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => subscribeMulti(), [])
  useEffect(() => setConfirm(false), [preview])
  // Leaving a preview that was never started tells main, which audits a declined configuration change.
  const dropPreview = () => {
    const { step: at, preview: p } = useMulti.getState()
    if (at === 'preview' && p) void window.hopline.multi.decline(p.previewId).catch(() => {})
  }
  const close = () => {
    dropPreview()
    useMulti.getState().close()
  }
  const runnable = resolved.some((t) => !t.excluded)
  const doPreview = async () => {
    if (!command.trim() || !runnable) return
    setBusy(true)
    try {
      const p = await window.hopline.multi.preview({ mode, targets: picked, command, ...(mode === 'run' ? { perPlatform } : {}) })
      useMulti.setState({ preview: p, step: 'preview' })
    } catch (e) {
      notifyError('Could not preview', e)
    } finally {
      setBusy(false)
    }
  }
  const start = async () => {
    if (!preview) return
    setBusy(true)
    try {
      useMulti.setState({ results: {}, running: true, step: 'results', runId: null })
      const { runId } = await window.hopline.multi.start({ previewId: preview.previewId, confirmConfig: confirm, concurrency })
      // Events that arrived before the id (a fast device) are replayed, not dropped.
      attachRun(runId)
    } catch (e) {
      useMulti.setState({ running: false, step: 'preview' })
      notifyError('Could not start', e)
    } finally {
      setBusy(false)
    }
  }
  const stop = () => {
    const id = useMulti.getState().runId
    if (id) void window.hopline.multi.cancel(id)
  }
  const copyReport = async () => {
    if (!preview) return
    const { results } = useMulti.getState()
    try {
      await copyTicketReport('run', preview.rows.map(({ target, lines }) => {
        const result = results[target.key]
        return {
          device: target.hostname || target.name,
          session: target.name,
          host: target.host,
          platform: platformLabel(target.platform),
          recordedAt: result?.recordedAt,
          status: result && isFinal(result.status) ? result.status : 'No final result received',
          reason: result?.reason,
          command: result?.command ?? lines.map((line) => line.command).join('\n'),
          output: result?.output
        }
      }))
      toast('Run report copied')
    } catch (e) {
      notifyError('Could not copy the run report', e)
    }
  }
  const willRun = preview ? preview.counts.read + preview.counts.config : 0
  const title = mode === 'run' ? 'Run on many devices' : 'Send to many devices'
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={title}
      description={mode === 'run' ? 'One read-only command on every picked device, compared side by side.' : 'The same lines to several devices, each checked by the guard for its own platform.'}
      fill={step === 'results'}
      className={step === 'results' ? 'multi-results-viewer' : 'w-[min(1080px,96vw)]'}
      footer={
        step === 'compose' ? (
          <>
            <Segmented
              label="Mode"
              className="mr-auto"
              value={mode}
              onChange={(m) => useMulti.setState({ mode: m })}
              items={[
                { value: 'run', label: 'Run show command' },
                { value: 'send', label: 'Send commands' }
              ]}
            />
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={busy || !command.trim() || !runnable} onClick={() => void doPreview()}>
              Preview <Kbd keys="Mod+Enter" className="ml-1" />
            </Button>
          </>
        ) : step === 'preview' ? (
          <>
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                dropPreview()
                useMulti.setState({ step: 'compose' })
              }}
            >
              <ArrowLeft /> Back
            </Button>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant={preview?.needsConfirm ? 'danger' : 'primary'} disabled={busy || !willRun || (preview?.needsConfirm && !confirm)} onClick={() => void start()}>
              <Play /> {mode === 'run' ? `Run on ${willRun}` : `Send to ${willRun}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="mr-auto" disabled={running} onClick={() => useMulti.setState({ step: 'compose', preview: null, results: {}, runId: null })}>
              <ArrowLeft /> New run
            </Button>
            {running ? (
              <Button variant="danger" onClick={stop}>
                <Square /> Stop all
              </Button>
            ) : (
              <>
                {mode === 'run' && <Button onClick={() => void copyReport()}>Copy run report</Button>}
                <Button variant="primary" onClick={close}>Done</Button>
              </>
            )}
          </>
        )
      }
    >
      {step === 'results' && <ViewerGrip dialog />}
      <div className={cn('flex min-h-0 flex-col', step === 'results' ? 'flex-1' : 'h-[min(540px,calc(65vh-2rem))]')} data-testid="multi-dialog" data-step={step}>
        {step === 'compose' && <Compose onPreview={() => void doPreview()} />}
        {step === 'preview' && preview && <PreviewTable confirm={confirm} setConfirm={setConfirm} />}
        {step === 'results' && <Results />}
      </div>
    </Dialog>
  )
}
