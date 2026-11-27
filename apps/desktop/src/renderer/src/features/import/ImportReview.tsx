import { SESSION_PLATFORM_LABELS as PLATFORM_LABELS, SESSION_PLATFORMS as PLATFORMS } from '@hopline/guard'
import { ArrowRight, ChevronRight, CornerDownRight, FolderPlus, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CsvColumnField, SessionPlatform as Platform, SessionImportGoneRow, SessionImportPlan, SessionImportRow, SessionImportStatus } from '@shared/types'
import { Button, cn, EmptyState, Label, Select } from '../../design'
import { folderPath } from '../../lib/connect'
import { useUi } from '../../store'
import { errorText, Toggle } from '../settings/parts'
import { announce, closeImport, refreshNetBoxSource, useImport } from './store'

type Group = SessionImportStatus | 'gone'
const GROUPS: { id: Group; label: string; dot: string; hint: string }[] = [
  { id: 'new', label: 'New', dot: 'bg-ok', hint: 'Added as new sessions' },
  { id: 'changed', label: 'Changed', dot: 'bg-accent', hint: 'Only the listed fields change; credentials, colors and jump hosts set here stay' },
  { id: 'conflict', label: 'Conflicts', dot: 'bg-warn', hint: 'Ticked rows are added as separate sessions' },
  { id: 'gone', label: 'Gone from NetBox', dot: 'bg-danger', hint: 'Ticked sessions are deleted' },
  { id: 'unchanged', label: 'Unchanged', dot: 'bg-fg-subtle', hint: 'Already here and identical' }
]
const CSV_FIELDS: [CsvColumnField, string][] = [
  ['host', 'Host or IP'],
  ['name', 'Name'],
  ['port', 'Port'],
  ['protocol', 'Protocol'],
  ['username', 'Username'],
  ['folder', 'Folder'],
  ['platform', 'Platform'],
  ['tags', 'Tags'],
  ['notes', 'Notes'],
  ['baud', 'Baud rate']
]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const target = (r: SessionImportRow) =>
  r.protocol === 'serial' ? r.host : `${r.username ? `${r.username}@` : ''}${r.host}${r.port && !((r.protocol === 'ssh' && r.port === 22) || (r.protocol === 'telnet' && r.port === 23)) ? `:${r.port}` : ''}`
const defaultTick = (r: SessionImportRow) => r.status === 'new' || r.status === 'changed'
const writes = (r: SessionImportRow) => r.status !== 'unchanged'

/** Review state for the wizard: lives above the dialog so the footer can read it. */
export function useReview(plan: SessionImportPlan | null) {
  const [ticks, setTicks] = useState<ReadonlyMap<number, boolean>>(new Map())
  const [remove, setRemove] = useState<ReadonlySet<string>>(new Set())
  const [platforms, setPlatforms] = useState<Readonly<Record<number, Platform>>>({})
  const [busy, setBusy] = useState<'plan' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const token = plan?.token
  useEffect(() => {
    setTicks(new Map())
    setRemove(new Set())
    setPlatforms({})
    setError(null)
  }, [token])

  const rows = plan?.rows ?? []
  const ticked = (r: SessionImportRow) => writes(r) && (ticks.get(r.index) ?? defaultTick(r))
  const picked = rows.filter(ticked)
  // Rows without a platform import as Auto-detect unless one is chosen: nothing blocks the import.
  const missing = picked.filter((r) => r.platformPrompt === 'missing' && !platforms[r.index])
  const adds = picked.filter((r) => r.status === 'new' || r.status === 'conflict').length
  const updates = picked.filter((r) => r.status === 'changed').length
  const removes = (plan?.gone ?? []).filter((g) => remove.has(g.sessionId)).length
  const pickedFolders = (plan?.newFolders ?? []).filter((p) =>
    picked.some((r) => (r.status !== 'changed' || r.changes?.some((c) => c.field === 'folder')) && p.every((seg, i) => r.folderPath[i]?.toLowerCase() === seg.toLowerCase()))
  )

  const replan = async (patch: Partial<SessionImportPlan['options']> & { csv?: { mapping: Partial<Record<CsvColumnField, number>>; hasHeader: boolean } }) => {
    if (!plan) return
    setBusy('plan')
    setError(null)
    try {
      const { csv, ...o } = patch
      const next = await window.hopline.importer.plan(plan.token, { ...plan.options, ...o, ...(csv ? { csv } : {}) })
      useImport.setState({ plan: next })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const apply = async () => {
    if (!plan) return
    setBusy('apply')
    setError(null)
    try {
      const chosen = Object.fromEntries(
        picked.filter((r) => platforms[r.index] || r.platformPrompt === 'missing').map((r) => [String(r.index), platforms[r.index] ?? ('auto' as const)])
      )
      const out = await window.hopline.importer.apply({
        token: plan.token,
        ...plan.options,
        rows: picked.map((r) => r.index),
        remove: [...remove].filter((id) => plan.gone.some((g) => g.sessionId === id)),
        platforms: chosen
      })
      useImport.setState({ plan: null })
      closeImport()
      await useUi.getState().load()
      void refreshNetBoxSource()
      announce(out, plan.source)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return {
    plan,
    ticked,
    tick: (indexes: number[], on: boolean) => setTicks((m) => new Map([...m, ...indexes.map((i) => [i, on] as const)])),
    remove,
    setRemove,
    platforms,
    setPlatform: (indexes: number[], p: Platform | undefined) =>
      setPlatforms((cur) => {
        const next = { ...cur }
        for (const i of indexes) if (p) next[i] = p
        else delete next[i]
        return next
      }),
    picked,
    missing,
    adds,
    updates,
    removes,
    newFolders: pickedFolders,
    busy,
    error,
    replan,
    apply
  }
}
export type Review = ReturnType<typeof useReview>

function Check({ checked, indeterminate, onChange, label, disabled }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      disabled={disabled}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="size-3.5 shrink-0 accent-[var(--c-accent)]"
    />
  )
}

function PlatformCell({ r, review }: { r: SessionImportRow; review: Review }): React.JSX.Element {
  if (!r.platformPrompt) return <span className="truncate text-xs text-fg-subtle">{r.platform ? PLATFORM_LABELS[r.platform] : 'keeps current'}</span>
  const value = review.platforms[r.index] ?? (r.platformPrompt === 'guessed' ? (r.platform ?? 'auto') : 'auto')
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select
        aria-label={`Platform for ${r.name}`}
        value={value}
        onChange={(e) => review.setPlatform([r.index], (e.target.value || undefined) as Platform | undefined)}
        className={cn('h-6 min-w-0 flex-1 px-1.5 text-xs')}
      >
        {PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {PLATFORM_LABELS[p]}
          </option>
        ))}
      </Select>
      {r.platformPrompt === 'guessed' && !review.platforms[r.index] && (
        <span className="shrink-0 text-2xs text-fg-subtle" title="Guessed from the session name">
          guess
        </span>
      )}
    </div>
  )
}

const rowGrid = 'grid grid-cols-[14px_minmax(0,1.25fr)_minmax(0,1fr)_168px] items-start gap-x-3'

function RowView({ r, review }: { r: SessionImportRow; review: Review }): React.JSX.Element {
  const on = review.ticked(r)
  const selectable = writes(r)
  return (
    <div
      data-import-row={r.name}
      onClick={() => selectable && review.tick([r.index], !on)}
      className={cn(rowGrid, 'rounded-md px-2 py-1.5 transition-colors', selectable ? 'cursor-default hover:bg-hover' : 'text-fg-subtle', selectable && !on && 'text-fg-subtle')}
    >
      <div className="pt-0.5">{selectable && <Check checked={on} onChange={(v) => review.tick([r.index], v)} label={`Import ${r.name}`} />}</div>
      <div className="min-w-0">
        <div className="truncate text-sm text-fg">{r.name}</div>
        {r.folderPath.length > 0 && <div className="truncate text-2xs text-fg-subtle">{r.folderPath.join(' / ')}</div>}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs text-fg-muted">{target(r)}</span>
          {r.protocol !== 'ssh' && <span className="shrink-0 rounded-sm bg-active px-1 text-2xs text-fg-subtle">{r.protocol}</span>}
        </div>
        {r.jump.length > 0 && (
          <div className="flex min-w-0 items-center gap-1 text-2xs text-fg-subtle">
            <CornerDownRight className="size-3 shrink-0" />
            <span className="truncate">via {r.jump.join(' → ')}</span>
          </div>
        )}
      </div>
      <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
        <PlatformCell r={r} review={review} />
      </div>
      {r.changes && r.changes.length > 0 && (
        <ul className="col-start-2 col-end-5 mt-1 space-y-0.5" aria-label={`Changes to ${r.name}`}>
          {r.changes.map((c) => (
            <li key={c.field} className="flex min-w-0 items-baseline gap-2 text-2xs">
              <span className="w-14 shrink-0 text-fg-subtle">{c.field}</span>
              <span className="min-w-0 truncate font-mono text-fg-subtle line-through decoration-fg-subtle/50">{c.from}</span>
              <ArrowRight className="size-3 shrink-0 self-center text-fg-subtle" />
              <span className="min-w-0 truncate font-mono text-fg">{c.to}</span>
            </li>
          ))}
        </ul>
      )}
      {r.conflict && <p className="col-start-2 col-end-5 mt-0.5 text-2xs text-warn">{r.conflict.message}</p>}
      {r.existing && r.status === 'changed' && r.existing.name !== r.name && !r.changes?.some((c) => c.field === 'name') && (
        <p className="col-start-2 col-end-5 text-2xs text-fg-subtle">Updates “{r.existing.name}”</p>
      )}
    </div>
  )
}

function GoneView({ g, review }: { g: SessionImportGoneRow; review: Review }): React.JSX.Element {
  const on = review.remove.has(g.sessionId)
  const toggle = (v: boolean) => review.setRemove((s) => (v ? new Set(s).add(g.sessionId) : new Set([...s].filter((x) => x !== g.sessionId))))
  return (
    <div data-import-row={g.name} onClick={() => toggle(!on)} className={cn(rowGrid, 'cursor-default rounded-md px-2 py-1.5 hover:bg-hover', !on && 'text-fg-subtle')}>
      <div className="pt-0.5">
        <Check checked={on} onChange={toggle} label={`Remove ${g.name}`} />
      </div>
      <div className="min-w-0">
        <div className={cn('truncate text-sm', on ? 'text-danger line-through decoration-danger/50' : 'text-fg')}>{g.name}</div>
        {g.folderPath.length > 0 && <div className="truncate text-2xs text-fg-subtle">{g.folderPath.join(' / ')}</div>}
      </div>
      <div className="truncate font-mono text-xs text-fg-muted">{g.host}</div>
      <div className="text-2xs text-fg-subtle">{on ? 'will be deleted' : 'kept'}</div>
    </div>
  )
}

function GroupView({ g, review, collapsed, onCollapse }: { g: (typeof GROUPS)[number]; review: Review; collapsed: boolean; onCollapse: () => void }) {
  const plan = review.plan!
  const rows = g.id === 'gone' ? [] : plan.rows.filter((r) => r.status === g.id)
  const count = g.id === 'gone' ? plan.gone.length : rows.length
  if (!count) return null
  const selectable = g.id !== 'unchanged'
  const on = g.id === 'gone' ? plan.gone.filter((x) => review.remove.has(x.sessionId)).length : rows.filter(review.ticked).length
  const setAll = (v: boolean) => {
    if (g.id === 'gone') review.setRemove(v ? new Set(plan.gone.map((x) => x.sessionId)) : new Set())
    else review.tick(rows.map((r) => r.index), v)
  }
  return (
    <section role="group" aria-label={`${g.label} (${count})`} data-import-group={g.id} className="border-b border-line py-1 last:border-0">
      <div className="flex h-8 items-center gap-3 px-2">
        <div className="w-3.5">{selectable && <Check checked={on === count} indeterminate={on > 0 && on < count} onChange={setAll} label={`Select all ${g.label.toLowerCase()}`} />}</div>
        <button type="button" onClick={onCollapse} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn('size-1.5 shrink-0 rounded-full', g.dot)} />
          <span className="text-xs font-medium text-fg">{g.label}</span>
          <span className="text-xs tabular-nums text-fg-subtle" data-count>
            {count}
          </span>
          <span className="truncate text-2xs text-fg-subtle">· {g.hint}</span>
          <ChevronRight className={cn('ml-auto size-3.5 shrink-0 text-fg-subtle transition-transform duration-150', !collapsed && 'rotate-90')} />
        </button>
      </div>
      {!collapsed && (
        <div className="pb-1">
          {g.id === 'gone' ? plan.gone.map((x) => <GoneView key={x.sessionId} g={x} review={review} />) : rows.map((r) => <RowView key={r.index} r={r} review={review} />)}
        </div>
      )}
    </section>
  )
}

function CsvColumns({ review }: { review: Review }): React.JSX.Element | null {
  const csv = review.plan?.csv
  const [open, setOpen] = useState(!!csv?.needsMapping)
  const [mapping, setMapping] = useState<Partial<Record<CsvColumnField, number>>>(csv?.mapping ?? {})
  const [hasHeader, setHasHeader] = useState(csv?.hasHeader ?? true)
  useEffect(() => {
    if (csv?.needsMapping) setOpen(true)
  }, [csv?.needsMapping])
  if (!csv) return null
  const auto = hasHeader && !csv.needsMapping
  return (
    <div className={cn('rounded-md border', csv.needsMapping ? 'border-warn/40 bg-warn-soft/40' : 'border-line')}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <ChevronRight className={cn('size-3.5 text-fg-subtle transition-transform duration-150', open && 'rotate-90')} />
        <span className="font-medium text-fg">Columns</span>
        <span className="text-fg-subtle">{csv.needsMapping ? 'No host or IP column was recognised: choose one.' : `${csv.columns.length} columns, ${Object.keys(csv.mapping).length ? 'mapped by hand' : 'matched by header'}`}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <Toggle label="First row is a header" checked={hasHeader} onChange={setHasHeader} />
            First row is a header
          </label>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {CSV_FIELDS.map(([f, label]) => (
              <div key={f} className="space-y-1">
                <Label htmlFor={`csv-${f}`}>{label}</Label>
                <Select
                  id={`csv-${f}`}
                  value={mapping[f] === undefined ? '' : String(mapping[f])}
                  onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="h-6 text-xs"
                >
                  <option value="">{auto ? 'Auto' : '—'}</option>
                  {csv.columns.map((c) => (
                    <option key={c.index} value={c.index}>
                      {c.header === `Column ${c.index + 1}` ? c.header : `${c.index + 1} · ${c.header}`}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
          <Button size="sm" variant="primary" disabled={review.busy === 'plan' || (!auto && mapping.host === undefined)} onClick={() => void review.replan({ csv: { mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== undefined)), hasHeader } })}>
            {review.busy === 'plan' && <LoaderCircle className="animate-spin" />} Apply columns
          </Button>
        </div>
      )}
    </div>
  )
}

function Warnings({ review }: { review: Review }): React.JSX.Element | null {
  const list = review.plan?.warnings ?? []
  const [open, setOpen] = useState(false)
  if (!list.length) return null
  return (
    <div className="border-y border-line" data-import-warnings>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <TriangleAlert className="size-3.5 text-warn" />
        <span className="font-medium text-fg">{plural(list.length, 'warning')}</span>
        <span className="truncate text-fg-subtle">Skipped records, settings Hopline can't use, and notes on what changed</span>
        <ChevronRight className={cn('ml-auto size-3.5 shrink-0 text-fg-subtle transition-transform duration-150', open && 'rotate-90')} />
      </button>
      {open && (
        <ul className="max-h-48 space-y-1 overflow-auto border-t border-line px-3 py-2" aria-label="Import warnings">
          {list.map((w, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,180px)_1fr] gap-3 text-2xs">
              <span className="truncate font-mono text-fg-muted" title={w.item}>
                {w.item}
              </span>
              <span className="text-fg-subtle">{w.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ReviewBody({ review }: { review: Review }): React.JSX.Element {
  const plan = review.plan!
  const folders = useUi((s) => s.folders)
  const [collapsed, setCollapsed] = useState<ReadonlySet<Group>>(new Set(['unchanged']))
  const options = useMemo(
    () => folders.map((f) => ({ id: f.id, label: folderPath(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label)),
    [folders]
  )
  const prompts = review.picked.filter((r) => r.platformPrompt)
  const missingAll = review.picked.filter((r) => r.platformPrompt === 'missing').length
  const guessed = prompts.length - missingAll
  const allRows = plan.rows.filter(writes)
  const allOn = allRows.filter(review.ticked).length
  const empty = !plan.rows.length && !plan.gone.length

  return (
    <div className="space-y-3" aria-busy={review.busy === 'plan'}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          Into
          <Select
            aria-label="Target folder"
            value={plan.options.targetFolderId ?? ''}
            disabled={review.busy !== null}
            onChange={(e) => void review.replan({ targetFolderId: e.target.value || null })}
            className="h-7 w-56"
          >
            <option value="">Top level</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <Toggle label="Keep source folders" checked={plan.options.keepFolders} disabled={review.busy !== null} onChange={(v) => void review.replan({ keepFolders: v })} />
          Keep source folders
        </label>
        {review.busy === 'plan' && <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" aria-label="Updating preview" />}
        <dl className="ml-auto flex items-center gap-3 text-2xs text-fg-subtle" aria-label="Import summary">
          {GROUPS.map((g) => {
            const n = g.id === 'gone' ? plan.gone.length : plan.rows.filter((r) => r.status === g.id).length
            return n ? (
              <div key={g.id} className="flex items-center gap-1">
                <span className={cn('size-1.5 rounded-full', g.dot)} />
                <dt>{g.label}</dt>
                <dd className="tabular-nums text-fg-muted" data-summary={g.id}>
                  {n}
                </dd>
              </div>
            ) : null
          })}
        </dl>
      </div>

      <CsvColumns key={plan.token} review={review} />

      {prompts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-2 text-xs">
          <span className="text-fg-muted">
            {missingAll > 0 && <span>{plural(missingAll, 'session')} without a platform (auto-detected on first connect)</span>}
            {missingAll > 0 && guessed > 0 && ', '}
            {guessed > 0 && <span>{guessed} guessed from the name</span>}
            <span className="text-fg-subtle"> · the AI guard reads commands by platform</span>
          </span>
          <Select
            aria-label="Platform for all"
            value=""
            onChange={(e) => e.target.value && review.setPlatform(prompts.map((r) => r.index), e.target.value as Platform)}
            className="ml-auto h-6 w-44 text-xs"
          >
            <option value="">Set all to…</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </Select>
        </div>
      )}

      {empty ? (
        <EmptyState icon={<TriangleAlert />} title="Nothing to import" body="No session could be read from this source. The warnings say why." />
      ) : (
        <div role="group" aria-label="Sessions to import" className="rounded-lg border border-line">
          {allRows.length > 0 && (
            <div className={cn(rowGrid, 'items-center border-b border-line px-2 py-1.5 text-2xs text-fg-subtle')}>
              <Check checked={allOn === allRows.length} indeterminate={allOn > 0 && allOn < allRows.length} onChange={(v) => review.tick(allRows.map((r) => r.index), v)} label="Select all" />
              <span>Session</span>
              <span>Target</span>
              <span>Platform</span>
            </div>
          )}
          {GROUPS.map((g) => (
            <GroupView
              key={g.id}
              g={g}
              review={review}
              collapsed={collapsed.has(g.id)}
              onCollapse={() => setCollapsed((s) => (s.has(g.id) ? new Set([...s].filter((x) => x !== g.id)) : new Set(s).add(g.id)))}
            />
          ))}
        </div>
      )}

      <Warnings review={review} />

      {review.error && (
        <p role="alert" className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">
          {review.error}
        </p>
      )}
    </div>
  )
}

export function ReviewFooter({ review }: { review: Review }): React.JSX.Element {
  const { adds, updates, removes, busy, plan } = review
  const total = adds + updates + removes
  // NetBox with nothing to change still saves the source (a new filter or token) for re-sync.
  const saveOnly = plan?.source === 'netbox' && !total
  const label = saveOnly
    ? plan.resync ? 'Save and mark synced' : 'Save source'
    : plan?.resync
    ? `Apply ${plural(total, 'change')}`
    : adds + updates > 0
      ? `Import ${plural(adds + updates, 'session')}`
      : removes > 0
        ? `Remove ${plural(removes, 'session')}`
        : 'Import'
  const parts = [adds && `${adds} new`, updates && `${updates} updated`, removes && `${removes} removed`, review.newFolders.length && plural(review.newFolders.length, 'new folder')].filter(Boolean)
  return (
    <>
      <div className="mr-auto flex min-w-0 items-center gap-2 self-center text-xs" aria-live="polite">
        <span className="flex items-center gap-1.5 text-fg-subtle">
          {review.newFolders.length > 0 && <FolderPlus className="size-3.5" />}
          {parts.join(' · ') || 'Nothing selected'}
        </span>
      </div>
      <Button
        variant="ghost"
        disabled={busy === 'apply'}
        onClick={() => {
          if (plan) void window.hopline.importer.cancel(plan.token).catch(() => {})
          useImport.setState({ step: 'source', plan: null })
        }}
      >
        Back
      </Button>
      <Button variant={removes > 0 && adds + updates === 0 ? 'danger' : 'primary'} disabled={(!total && !saveOnly) || busy !== null} onClick={() => void review.apply()}>
        {busy === 'apply' && <LoaderCircle className="animate-spin" />}
        {label}
      </Button>
    </>
  )
}
