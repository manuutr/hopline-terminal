import { ArrowDown, ArrowRight, ArrowUp, CalendarClock, ChevronDown, Columns2, Download, FileClock, History, ListTree, Plus, Radio, Rows2, ShieldCheck, Trash2 } from 'lucide-react'
import { DropdownMenu as DM } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../lib/notify'
import type { BackupRetention, BackupSchedule, BackupText, BackupVersion } from '@shared/backups'
import { nextSlot } from '@shared/backup-schedule'
import { stanzaStyle, stripNoise } from '@shared/config-text'
import { Badge, Button, cn, Dialog, EmptyState, Input, LoadError, Segmented, SelectMenu, Toggle, Tooltip, useRovingList } from '../../design'
import { fmtWhen } from '../../lib/when'
import { useUi } from '../../store'
import { summarizeChanges, type ChangeSummary, type LineChange } from './changes'
import { DiffView, type DiffHandle } from './DiffView'
import { backupNow, useBackups } from './store'

const LIVE = '__live__'
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const menuItem = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-fg-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg [&_svg]:size-3.5'
/** One wording for the noise filter everywhere (backups and the multi-device compare view). */
const NOISE_HINT = 'Clocks, uptimes, counters and timestamps'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
const stamp = (ts: number) => fmtWhen(ts, { seconds: true, cap: true })

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/** Config backups: history and diff per session, schedules and retention. Restore is not offered. */
export function BackupsDialog(): React.JSX.Element {
  const { open, view, set } = useBackups()
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && set({ open: false })}
      title="Config backups"
      description="Running configs captured read-only through the guard, stored encrypted. Shown with secrets redacted."
      className="top-[6vh] h-[88vh] w-[min(1320px,96vw)]"
      fill
    >
      <div className="mb-3 flex shrink-0 items-center gap-1" role="tablist" aria-label="Backups view">
        {(
          [
            ['history', 'History', <History key="h" />],
            ['schedules', 'Schedules & retention', <CalendarClock key="c" />]
          ] as const
        ).map(([v, label, icon]) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => set({ view: v })}
            className={cn(
              'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm transition-colors duration-[var(--dur-fast)] [&_svg]:size-3.5',
              view === v ? 'bg-active text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      {view === 'history' ? <HistoryView /> : <SchedulesView />}
    </Dialog>
  )
}

// ------------------------------------------------------------------ history

/** "Base · Today 05:40:37" over one side of the diff. */
function SideLabel({ role, text, tone }: { role: string; text: string; tone?: 'accent' }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate px-3 text-2xs">
      <span className={cn('shrink-0 font-medium', tone === 'accent' ? 'text-accent' : 'text-fg-subtle')}>{role}</span>
      <span className="truncate tabular-nums text-fg-muted">{text}</span>
    </span>
  )
}

function HistoryView(): React.JSX.Element {
  const { sessionId, rev, set } = useBackups()
  const sessions = useUi((s) => s.sessions)
  const tabs = useUi((s) => s.tabs)
  const [versions, setVersions] = useState<BackupVersion[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [base, setBase] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, BackupText>>({})
  // A version that failed to open: shown in the diff pane, not left on "Loading…".
  const [textErr, setTextErr] = useState<Record<string, string>>({})
  const [live, setLive] = useState<BackupText | null>(null)
  const [busy, setBusy] = useState<'backup' | 'live' | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [hideNoise, setHideNoise] = useState(true)
  const [collapse, setCollapse] = useState(true)
  /** null = automatic: the change list shows when the diff area is wide enough. */
  const [changesOpen, setChangesOpen] = useState<boolean | null>(null)
  const [changes, setChanges] = useState<LineChange[]>([])
  const diff = useRef<DiffHandle>(null)
  // A context-menu item opens this dialog on pointer-up; the click that follows must not pick a row.
  const openedAt = useRef(performance.now())

  const sorted = useMemo(() => [...sessions].sort((a, b) => a.name.localeCompare(b.name)), [sessions])
  const sid = sessionId ?? sorted[0]?.id ?? null
  const session = sessions.find((s) => s.id === sid)
  const connected = tabs.some((t) => t.sessionId === sid && t.state === 'connected')

  const [listErr, setListErr] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!sid) return setVersions([])
    try {
      const v = await window.hopline.backups.list(sid)
      setListErr(null)
      setVersions(v)
      setSelected((cur) => (cur && v.some((x) => x.id === cur) ? cur : (v[0]?.id ?? null)))
    } catch (e) {
      setListErr(errText(e))
    }
  }, [sid])
  useEffect(() => {
    void load()
  }, [load, rev])
  useEffect(() => {
    setLive(null)
    setBase(null)
  }, [sid])

  // The base defaults to the version before the selected one.
  const idx = versions.findIndex((v) => v.id === selected)
  const baseId = base ?? versions[idx + 1]?.id ?? null
  useEffect(() => {
    for (const id of [selected, baseId === LIVE ? null : baseId])
      if (id && !texts[id] && !textErr[id])
        void window.hopline.backups
          .get(id)
          .then((t) => setTexts((m) => ({ ...m, [id]: t })))
          .catch((e) => setTextErr((m) => ({ ...m, [id]: errText(e) })))
  }, [selected, baseId, texts, textErr])

  const pick = (i: number) => {
    const v = versions[i]
    if (!v || v.id === selected) return
    setSelected(v.id)
    setBase(null)
  }
  const roving = useRovingList({ count: versions.length, active: Math.max(0, idx), onActiveChange: pick })

  const takeNow = async () => {
    if (!sid) return
    setBusy('backup')
    const [r] = await backupNow([sid])
    setBusy(null)
    await load()
    if (r?.outcome === 'saved' && r.versionId) {
      setSelected(r.versionId)
      setBase(null)
    }
  }
  const compareLive = async () => {
    if (!sid) return
    setBusy('live')
    try {
      setLive(await window.hopline.backups.live(sid))
      setBase(LIVE)
    } catch (e) {
      toast.error('Could not read the running config', { description: errText(e) })
    } finally {
      setBusy(null)
    }
  }
  const exportVersion = async (includeSecrets: boolean) => {
    if (!selected) return
    try {
      const r = await window.hopline.backups.exportVersion(selected, includeSecrets)
      if (r.file) toast.success('Exported', { description: r.file })
    } catch (e) {
      toast.error('Export failed', { description: errText(e) })
    }
  }

  const sel = selected ? texts[selected] : undefined
  const baseText = baseId === LIVE ? live : baseId ? texts[baseId] : undefined
  // Live is "newer" than any stored version: it goes on the right.
  const [left, right] = baseId === LIVE ? [sel, baseText] : [baseText, sel]
  const prep = (t: string) => (hideNoise ? stripNoise(t) : t)
  const leftText = left ? prep(left.text) : ''
  const rightText = right ? prep(right.text) : ''
  const platform = session?.platform ?? ''
  const style = stanzaStyle(rightText || leftText, platform)
  const summary: ChangeSummary[] = useMemo(() => summarizeChanges(changes, leftText.split('\n'), rightText.split('\n'), style), [changes, leftText, rightText, style])
  const redactions = Math.max(left?.redactions ?? 0, right?.redactions ?? 0)

  // Side labels: which version is on which side, and when it was taken.
  const selLabel = sel ? `${stamp(sel.ts)}${idx === 0 ? ' (latest)' : ''}` : ''
  const [leftLabel, rightLabel] =
    baseId === LIVE
      ? [{ role: 'Selected', text: selLabel }, { role: 'Live', text: live ? `read ${fmtWhen(live.ts, { seconds: true })}` : '' }]
      : [{ role: 'Base', text: baseText ? stamp(baseText.ts) : '' }, { role: 'Selected', text: selLabel }]

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'F7' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
      e.preventDefault()
      diff.current?.go(e.shiftKey || e.key === 'ArrowUp' ? 'previous' : 'next')
    }
  }

  const baseOptions = [
    ...versions.filter((v) => v.id !== selected).map((v) => ({ value: v.id, label: stamp(v.ts), text: stamp(v.ts), hint: v.trigger === 'scheduled' ? 'scheduled' : undefined })),
    { value: LIVE, label: 'Live running config', text: 'Live running config', icon: <Radio className="size-3.5" />, disabled: !connected }
  ]
  const both = Boolean(left && right)

  return (
    <div className="@container/hist flex min-h-0 flex-1 gap-3" onKeyDown={onKey}>
      {/* Versions */}
      <div className="flex w-52 shrink-0 flex-col gap-2 @min-[1100px]/hist:w-60">
        <SelectMenu
          aria-label="Session"
          value={sid ?? ''}
          onValueChange={(v) => set({ sessionId: v })}
          options={sorted.map((s) => ({ value: s.id, label: s.name, text: s.name, hint: tabs.some((t) => t.sessionId === s.id && t.state === 'connected') ? 'connected' : undefined }))}
          placeholder="Choose a session"
          className="w-full"
        />
        <Tooltip label={connected ? 'Capture the running config now (read-only, audited)' : 'Open a connected tab to this session first'}>
          <span className="block">
            <Button className="w-full" disabled={!connected || busy !== null} onClick={() => void takeNow()}>
              <FileClock /> {busy === 'backup' ? 'Backing up…' : 'Back up now'}
            </Button>
          </span>
        </Tooltip>
        {/* An empty listbox is invalid ARIA (axe aria-required-children): error and empty states stand on their own. */}
        {listErr || !sid || versions.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {listErr ? (
              <LoadError what={`backups for ${session?.name ?? 'this session'}`} error={listErr} onRetry={() => void load()} />
            ) : !sid ? (
              <EmptyState title="No sessions yet" body="Save a device to start its backup history." action={<Button size="sm" onClick={() => { set({ open: false }); useUi.getState().set({ editing: { open: true } }) }}>Add a device</Button>} />
            ) : (
              <EmptyState icon={<FileClock />} title="No backups yet" body={connected ? 'Back up now to save the first version.' : 'Connect to the device, then back it up from here or the session menu.'} />
            )}
          </div>
        ) : (
        <div {...roving.listProps} aria-label="Versions" className="min-h-0 flex-1 overflow-auto">
          {(
            versions.map((v, i) => (
              <div
                key={v.id}
                {...roving.optionProps(i)}
                data-id={v.id}
                aria-selected={v.id === selected}
                onMouseDown={(e) => {
                  // The pointer-up that opened the dialog must not pick (and focus) a row.
                  if (performance.now() - openedAt.current < 400) e.preventDefault()
                }}
                onClick={(e) => {
                  if (e.detail > 0 && performance.now() - openedAt.current < 400) return
                  pick(i)
                }}
                className={cn(
                  'flex w-full cursor-default flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none transition-colors duration-[var(--dur-fast)] focus-visible:bg-hover focus-visible:shadow-[inset_2px_0_0_var(--c-accent)]',
                  v.id === selected ? 'bg-active' : 'hover:bg-hover'
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5 text-sm text-fg">
                  <span className="min-w-0 truncate tabular-nums">{stamp(v.ts)}</span>
                  {i === 0 && <Badge tone="accent">latest</Badge>}
                  {v.trigger === 'scheduled' && <Badge tone="neutral">scheduled</Badge>}
                  {v.id === baseId && (
                    <Badge tone="neutral" className="ml-auto">
                      base
                    </Badge>
                  )}
                </span>
                <span className="text-2xs tabular-nums text-fg-subtle">
                  {v.lines.toLocaleString()} lines · {fmtSize(v.size)}
                </span>
              </div>
            ))
          )}
        </div>
        )}
      </div>

      {/* Diff */}
      <div className="@container/diff relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-line">
        {/* Row 1: what is compared */}
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line bg-surface px-2 py-1.5">
          <span className="whitespace-nowrap pl-1 text-xs text-fg-subtle">Base</span>
          <SelectMenu
            aria-label="Compare with"
            value={baseId ?? ''}
            onValueChange={(v) => (v === LIVE ? void compareLive() : setBase(v))}
            options={baseOptions}
            placeholder="Pick a version"
            className="h-7 w-48 min-w-[10rem] shrink-0"
          />
          {/* Narrow: the side labels under the toolbar already say which side is which. */}
          <ArrowRight aria-hidden className="size-3.5 shrink-0 text-fg-subtle @max-[719px]/diff:hidden" />
          <span className="whitespace-nowrap text-xs text-fg-subtle @max-[719px]/diff:hidden">{baseId === LIVE ? 'the selected version against the live config' : 'the selected version'}</span>
          {baseId !== LIVE && (
            <Button size="sm" variant="ghost" disabled={!connected || busy !== null} onClick={() => void compareLive()}>
              <Radio /> {busy === 'live' ? 'Reading…' : 'Compare with live'}
            </Button>
          )}
          <span className="flex-1" />
          <DM.Root>
            <DM.Trigger asChild>
              <Button size="sm" variant="secondary" disabled={!selected}>
                <Download /> Export <ChevronDown />
              </Button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content align="end" sideOffset={4} className="z-50 min-w-60 rounded-md bg-overlay p-1 shadow-overlay animate-pop-in data-[state=closed]:animate-fade-out">
                <DM.Item className={menuItem} onSelect={() => void exportVersion(false)}>
                  <ShieldCheck /> Export (secrets redacted)
                </DM.Item>
                <DM.Item className={menuItem} onSelect={() => void exportVersion(true)}>
                  <Download /> Export with secrets…
                </DM.Item>
              </DM.Content>
            </DM.Portal>
          </DM.Root>
        </div>
        {/* Row 2: how it is shown */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-line bg-surface px-2 py-1">
          <Segmented
            label="Layout"
            size="sm"
            iconOnly
            value={sideBySide ? 'side' : 'inline'}
            onChange={(v) => setSideBySide(v === 'side')}
            items={[
              { value: 'side', label: 'Side by side', icon: <Columns2 /> },
              { value: 'inline', label: 'Inline', icon: <Rows2 /> }
            ]}
          />
          <Toggle inline label="Hide noise" hint={NOISE_HINT} checked={hideNoise} onChange={setHideNoise} />
          <Toggle inline label="Collapse unchanged" checked={collapse} onChange={setCollapse} />
          <span className="flex-1" />
          <Tooltip label="Previous change" shortcut="Shift+F7">
            <Button size="icon-sm" variant="ghost" aria-label="Previous change" disabled={!both} onClick={() => diff.current?.go('previous')}>
              <ArrowUp />
            </Button>
          </Tooltip>
          <Tooltip label="Next change" shortcut="F7">
            <Button size="icon-sm" variant="ghost" aria-label="Next change" disabled={!both} onClick={() => diff.current?.go('next')}>
              <ArrowDown />
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={changesOpen ?? undefined}
            aria-label="Change list"
            disabled={!both}
            onClick={() => setChangesOpen((o) => !(o ?? false))}
            className={cn(changesOpen && 'bg-active text-fg')}
          >
            <ListTree /> Changes
            <span className="tabular-nums text-fg-subtle" data-testid="change-count">
              {both ? summary.length : 0}
            </span>
          </Button>
        </div>
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {both && (
              <div className={cn('grid h-7 shrink-0 items-center border-b border-line bg-surface/60', sideBySide ? 'grid-cols-2' : 'grid-cols-[auto_auto_1fr]')} data-testid="diff-sides">
                <SideLabel role={leftLabel.role} text={leftLabel.text} />
                {!sideBySide && <ArrowRight aria-hidden className="size-3 text-fg-subtle" />}
                <SideLabel role={rightLabel.role} text={rightLabel.text} tone="accent" />
              </div>
            )}
            <div className="min-h-0 flex-1">
              {selected && textErr[selected] ? (
                <LoadError what="this version" error={textErr[selected]!} onRetry={() => setTextErr(({ [selected]: _, ...rest }) => rest)} />
              ) : !sel ? (
                <EmptyState icon={<History />} title={versions.length ? 'Loading…' : 'Nothing to compare'} body={versions.length ? undefined : 'Back up this session to start its history.'} />
              ) : !both ? (
                <EmptyState
                  icon={<History />}
                  title="Only one version"
                  body={connected ? 'Compare it with the live running config, or back up again after a change.' : 'Take another backup after a change, or connect to compare with the live config.'}
                  action={
                    connected && (
                      <Button variant="secondary" onClick={() => void compareLive()}>
                        <Radio /> Compare with live
                      </Button>
                    )
                  }
                />
              ) : (
                <DiffView ref={diff} original={{ text: leftText, platform }} modified={{ text: rightText, platform }} sideBySide={sideBySide} collapseUnchanged={collapse} onChanges={setChanges} />
              )}
            </div>
          </div>
          {both && (
            <div
              aria-label="Changes"
              className={cn(
                'w-60 shrink-0 flex-col border-l border-line bg-surface',
                changesOpen === null ? 'hidden @min-[780px]/diff:flex' : changesOpen ? 'flex' : 'hidden',
                // Narrow: the list floats over the diff instead of squeezing it.
                changesOpen && '@max-[779px]/diff:absolute @max-[779px]/diff:inset-y-0 @max-[779px]/diff:right-0 @max-[779px]/diff:z-10 @max-[779px]/diff:shadow-overlay'
              )}
            >
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2.5 text-2xs font-medium text-fg-subtle">
                <span>Changes</span>
                <span className="tabular-nums">{summary.length}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {summary.length === 0 ? (
                  <p className="p-3 text-xs text-fg-subtle">{hideNoise ? 'No changes (noise hidden).' : 'No changes.'}</p>
                ) : (
                  summary.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => diff.current?.reveal(c.line, c.side)}
                      className="flex w-full flex-col items-start gap-0.5 border-b border-line px-2.5 py-1.5 text-left outline-none hover:bg-hover focus-visible:bg-hover"
                    >
                      <span className="w-full truncate font-mono text-2xs text-accent" title={c.context || 'top level'}>
                        {c.context || 'top level'}
                      </span>
                      <span className="w-full truncate font-mono text-xs text-fg">{c.preview || '(blank)'}</span>
                      <span className="text-2xs tabular-nums">
                        {c.added > 0 && <span className="text-ok">+{c.added} </span>}
                        {c.removed > 0 && <span className="text-danger">−{c.removed}</span>}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="shrink-0 border-t border-line px-2.5 py-2 text-2xs leading-relaxed text-fg-subtle">
                <ShieldCheck className="mr-1 inline size-3 align-[-2px] text-ok" />
                Secrets redacted{redactions ? ` (${redactions})` : ''}. A change inside a secret shows as unchanged. Hopline Terminal never pushes a config back to a device.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ schedules

type ScheduleRow = BackupSchedule & { sessions: number }

function SchedulesView(): React.JSX.Element {
  const rev = useBackups((s) => s.rev)
  const folders = useUi((s) => s.folders)
  const sessions = useUi((s) => s.sessions)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [ret, setRet] = useState<BackupRetention | null>(null)
  const tags = useMemo(() => [...new Set(sessions.flatMap((s) => s.tags))].sort(), [sessions])

  const load = useCallback(async () => {
    setRows(await window.hopline.backups.schedules())
    setRet(await window.hopline.backups.retention())
  }, [])
  useEffect(() => {
    void load()
  }, [load, rev])

  const targets = [
    ...folders.map((f) => ({ value: `folder:${f.id}`, label: f.name, text: f.name, hint: 'folder' })),
    ...tags.map((t) => ({ value: `tag:${t}`, label: `#${t}`, text: t, hint: 'tag' }))
  ]
  const save = async (s: Omit<BackupSchedule, 'createdAt' | 'lastRunAt' | 'lastSummary'> | (Omit<BackupSchedule, 'id' | 'createdAt' | 'lastRunAt' | 'lastSummary'> & { id?: string })) => {
    try {
      await window.hopline.backups.saveSchedule({ id: s.id, kind: s.kind, target: s.target, cadence: s.cadence, weekday: s.weekday, time: s.time, enabled: s.enabled })
      await load()
    } catch (e) {
      toast.error('Could not save the schedule', { description: errText(e) })
    }
  }
  const add = () => {
    const first = targets[0]
    if (!first) return void toast.info('Create a folder or tag a session first', { description: 'Schedules back up every session in a folder (with its subfolders) or with a tag.' })
    const [kind, ...rest] = first.value.split(':')
    void save({ kind: kind as 'folder' | 'tag', target: rest.join(':'), cadence: 'daily', weekday: 1, time: '02:00', enabled: true })
  }
  // "Schedule backups…" from a folder: show its schedule, or add one (off) to adjust and turn on here.
  const scheduleFor = useBackups((s) => s.scheduleFor)
  useEffect(() => {
    if (!scheduleFor) return
    useBackups.getState().set({ scheduleFor: null })
    void (async () => {
      const existing = (await window.hopline.backups.schedules()).find((x) => x.kind === scheduleFor.kind && x.target === scheduleFor.target)
      if (existing) return
      // Added switched off: an unattended sign-in to every device in the folder needs an explicit "on".
      await save({ ...scheduleFor, cadence: 'daily', weekday: 1, time: '02:00', enabled: false })
      const name = scheduleFor.kind === 'folder' ? folders.find((f) => f.id === scheduleFor.target)?.name : `#${scheduleFor.target}`
      toast.info(`Schedule added for ${name ?? 'the folder'}, switched off`, { description: 'Set the time and cadence, then turn it on.' })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleFor])
  const saveRet = async (r: BackupRetention) => {
    try {
      setRet(await window.hopline.backups.setRetention(r))
    } catch (e) {
      toast.error('Could not save retention', { description: errText(e) })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto">
      <section>
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Schedules</h3>
            <p className="text-xs text-fg-muted">Run while Hopline Terminal is open. A session without an open tab is reached over a background connection with its stored credentials; one that needs a typed sign-in is backed up when it next connects. A run missed while the app was closed runs once at the next start.</p>
          </div>
          <Button variant="secondary" onClick={add}>
            <Plus /> Add schedule
          </Button>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<CalendarClock />} title="No schedules" body="Back up a folder or a tag every day or week." />
        ) : (
          <div className="divide-y divide-line border-y border-line">
            {rows.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 last:border-b-0">
                <SelectMenu
                  aria-label="Folder or tag"
                  className="w-56 min-w-[10rem]"
                  value={`${s.kind}:${s.target}`}
                  onValueChange={(v) => {
                    const [kind, ...rest] = v.split(':')
                    void save({ ...s, kind: kind as 'folder' | 'tag', target: rest.join(':') })
                  }}
                  options={targets.some((t) => t.value === `${s.kind}:${s.target}`) ? targets : [...targets, { value: `${s.kind}:${s.target}`, label: `${s.target} (gone)`, text: s.target, hint: s.kind }]}
                />
                <SelectMenu aria-label="Cadence" className="w-28" value={s.cadence} onValueChange={(v) => void save({ ...s, cadence: v })} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} />
                {s.cadence === 'weekly' && (
                  <SelectMenu aria-label="Weekday" className="w-32" value={String(s.weekday)} onValueChange={(v) => void save({ ...s, weekday: Number(v) })} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
                )}
                <span className="text-xs text-fg-subtle">at</span>
                {/* A 24-hour HH:MM field: the native time input follows the OS locale (02:30 AM). */}
                <Input
                  aria-label="Time"
                  inputMode="numeric"
                  placeholder="HH:MM"
                  maxLength={5}
                  className="w-20 tabular-nums"
                  defaultValue={s.time}
                  onBlur={(e) => {
                    const m = /^(\d{1,2}):?(\d{2})$/.exec(e.target.value.trim())
                    const t = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null
                    if (!t) {
                      e.target.value = s.time
                      return void toast.error('Use a 24-hour time such as 02:30')
                    }
                    e.target.value = t
                    if (t !== s.time) void save({ ...s, time: t })
                  }}
                />
                <Toggle inline label="Enabled" checked={s.enabled} onChange={(v) => void save({ ...s, enabled: v })} />
                <span className="flex-1" />
                <Tooltip label="Delete schedule">
                  <Button size="icon-sm" variant="ghost" aria-label="Delete schedule" onClick={() => void window.hopline.backups.removeSchedule(s.id).then(load)}>
                    <Trash2 />
                  </Button>
                </Tooltip>
                <p className="w-full text-2xs tabular-nums text-fg-subtle">
                  {s.sessions} session{s.sessions === 1 ? '' : 's'}
                  {s.enabled ? ` · Next: ${fmtWhen(nextSlot(s, Date.now()))}` : ' · Paused'}
                  {s.lastRunAt && ` · Last run: ${fmtWhen(s.lastRunAt)}${s.lastSummary ? `, ${s.lastSummary}` : ''}`}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
      {ret && (
        <section>
          <h3 className="text-sm font-semibold">Retention</h3>
          <p className="mb-2 text-xs text-fg-muted">Applies to every session. The newest version is always kept; identical configs are never stored twice.</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <span>Keep the last</span>
            <Input aria-label="Versions to keep" type="number" min={1} max={10000} className="w-20" defaultValue={ret.keepLast} onBlur={(e) => Number(e.target.value) >= 1 && void saveRet({ ...ret, keepLast: Math.round(Number(e.target.value)) })} />
            <span>versions per session, and delete versions older than</span>
            <Input aria-label="Maximum age in days" type="number" min={0} max={36500} className="w-20" defaultValue={ret.maxAgeDays} onBlur={(e) => Number(e.target.value) >= 0 && void saveRet({ ...ret, maxAgeDays: Math.round(Number(e.target.value)) })} />
            <span>days (0 = never).</span>
          </div>
        </section>
      )}
    </div>
  )
}
