import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { DropdownMenu as DM } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from '../../lib/notify'
import type { FilesInfo, OverwritePolicy, RemoteEntry } from '@shared/files'
import { remoteJoin, remoteParent } from '@shared/files'
import { Badge, Button, cn, EmptyState, Input, SelectMenu, Tooltip } from '../../design'
import { askConfirm } from '../../lib/confirm'
import { askText } from '../../lib/prompt'
import { sessionById, useUi } from '../../store'
import { supportsScpDirectory } from '@shared/scp-directory'
import { ScpDirectory } from './ScpDirectory'
import { FilePreviewDialog } from './FilePreviewDialog'
import { ConflictHost } from './ConflictDialog'
import { cleanError, closeFiles, ensureInfo, focusTerminal, formatBytes, handleQueue, installSecondEsc, refreshers, subscribeTransfers, takeFocus, useFiles } from './store'
import { TransferQueue, useQueueItems } from './TransferQueue'

const menuItem =
  'flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-fg-muted outline-none data-[disabled]:text-fg-subtle data-[highlighted]:bg-hover data-[highlighted]:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0'
const menuLabel = 'px-2 pb-1 pt-1.5 text-2xs font-medium text-fg-subtle'

const POLICIES: { value: OverwritePolicy; label: string; short: string }[] = [
  { value: 'ask', label: 'If it exists: ask', short: 'Ask' },
  { value: 'rename', label: 'If it exists: keep both', short: 'Keep both' },
  { value: 'skip', label: 'If it exists: skip', short: 'Skip' },
  { value: 'overwrite', label: 'If it exists: replace', short: 'Replace' }
]

type SortKey = 'name' | 'size' | 'mtime'

const fmtDate = (s: number) => {
  if (!s) return '—'
  const d = new Date(s * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * The bottom panel: browse the device over SFTP (or copy single files over SCP) and watch transfers.
 *
 * Layout follows the panel's own width (container queries on `@container/files`), not the window's,
 * because the AI panel and the session tree eat into it (round 2, P0-1):
 * - ≥ 760 px: the transfer queue is a column on the right and the overwrite policy is a select;
 * - < 760 px: the queue is an overlay behind a "Transfers (n)" toggle, the policy and the folder
 *   tools move into the … menu, Modified and Permissions columns drop out below 560 px.
 * Short panels (< 240 px) also drop the column header.
 *
 * Keyboard: opening the panel focuses the list; Esc gives focus back to the terminal, and a second
 * Esc within 1.5 s closes the panel without reaching the device (`installSecondEsc`).
 */
export function FilesPanel(): React.JSX.Element {
  useEffect(() => subscribeTransfers(), [])
  useEffect(() => installSecondEsc(), [])
  const tabId = useUi((s) => s.activeTabId)
  const tab = useUi((s) => s.tabs.find((t) => t.tabId === s.activeTabId))
  const session = useUi((s) => sessionById(s, tab?.sessionId))
  const open = useFiles((s) => s.open)
  const queueOpen = useFiles((s) => s.queueOpen)
  const entry = useFiles((s) => (tabId ? s.byTab[tabId] : undefined))
  const connected = tab?.state === 'connected'
  const ssh = session?.protocol === 'ssh'
  const section = useRef<HTMLElement>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const compact = useCompact(section, 240)

  useEffect(() => {
    if (open && tabId && ssh && connected && !entry?.info && !entry?.error) void ensureInfo(tabId)
  }, [open, tabId, ssh, connected, entry?.info, entry?.error])
  // A reconnect opens a new channel: ask again.
  useEffect(() => {
    if (!connected && tabId && entry?.info) useFiles.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { cwd: s.byTab[tabId]?.cwd } } }))
  }, [connected, tabId, entry?.info])

  const info = entry?.info
  const browsing = !!(tab && session && ssh && connected && !entry?.error && info?.mode === 'sftp')

  // States without a list still take the focus the panel asked for: the SCP form its first field,
  // the rest the panel itself, so Esc works and focus never sits on <body>.
  useEffect(() => {
    if (browsing) return
    if (info?.mode === 'scp' && connected) takeFocus(section.current?.querySelector<HTMLElement>('#scp-to'))
    else if (!info && connected && !entry?.error) takeFocus(section.current, true)
    else if (!info || !connected || entry?.error) takeFocus(section.current)
  })

  // The title cluster and the trailing controls. The SFTP browser puts its tools between them in
  // one row; every other state shows them alone. One header row instead of two (round 2, P2).
  const lead = (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      <FolderOpen aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
      <span className={cn('text-xs font-medium text-fg-muted', browsing && 'hidden @[620px]/files:inline')}>Files</span>
      {session && <span className={cn('max-w-[12rem] truncate text-xs text-fg-subtle', browsing && 'hidden @[960px]/files:inline')}>{session.name}</span>}
      {info && (
        <Tooltip label={info.mode === 'sftp' ? 'Browsing over SFTP on this connection' : (info.reason ?? 'SCP: copy single files')}>
          <Badge tone={info.mode === 'sftp' ? 'accent' : 'neutral'}>{info.mode === 'sftp' ? 'SFTP' : 'SCP'}</Badge>
        </Tooltip>
      )}
      {info?.side && (
        <Tooltip label="The device refused a second channel on the terminal's connection, so files use a second login">
          <Badge tone="neutral" className={cn(browsing && 'hidden @[960px]/files:inline-flex')}>
            second login
          </Badge>
        </Tooltip>
      )}
    </div>
  )
  const trail = (
    <div className="flex shrink-0 items-center gap-0.5">
      <QueueToggle />
      <Tooltip label="Close files" shortcut="Mod+J">
        <Button variant="ghost" size="icon-sm" aria-label="Close files" onClick={closeFiles}>
          <X />
        </Button>
      </Tooltip>
    </div>
  )

  let body: React.ReactNode
  if (!tab || !session) body = <EmptyState icon={<HardDrive />} title="No session" body="Open an SSH session to browse its files." className="h-full" />
  else if (!ssh) body = <EmptyState icon={<HardDrive />} title="Files need SSH" body={`${session.name} uses ${session.protocol === 'serial' ? 'a serial line' : session.protocol.toUpperCase()}. File transfer works over SSH (SFTP or SCP).`} className="h-full" />
  else if (!connected) body = <EmptyState icon={<HardDrive />} title="Not connected" body={`Files for ${session.name} are available once the session is connected.`} className="h-full" />
  else if (entry?.error)
    body = (
      <EmptyState
        icon={<HardDrive />}
        title="Files are not available"
        body={entry.error}
        className="h-full"
        action={
          <Button size="sm" onClick={() => void ensureInfo(tabId!, true)}>
            Try again
          </Button>
        }
      />
    )
  else if (!info) body = <div className="flex h-full items-center justify-center text-sm text-fg-subtle">Opening a file channel…</div>
  else if (info.mode === 'sftp') body = <RemoteBrowser key={tabId} tabId={tabId!} info={info} compact={compact} toolbar={toolbar} />
  else body = <ScpCopy key={tabId} tabId={tabId!} info={info} platform={session.platform} />

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
    // Menus and dialogs are portalled (their events still bubble through React): their Esc is theirs.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    if (useFiles.getState().queueOpen) return useFiles.getState().set({ queueOpen: false })
    useFiles.setState({ escAt: Date.now() })
    focusTerminal()
  }

  return (
    <section
      ref={section}
      aria-label="Files"
      data-files-panel
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="@container/files relative flex h-full min-h-0 flex-col border-t border-line bg-surface outline-none"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-3 pr-1">
        {lead}
        {browsing ? <div ref={setToolbar} className="flex min-w-0 flex-1 items-center gap-1" /> : <div className="flex-1" />}
        {trail}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{body}</div>
        <TransferQueue open={queueOpen} compact={compact} />
      </div>
      <ConflictHost />
    </section>
  )
}

/** True while the element is shorter than `px`. */
function useCompact(ref: React.RefObject<HTMLElement | null>, px: number): boolean {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setCompact((e?.contentRect.height ?? px) < px))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, px])
  return compact
}

/** Narrow panel (< 760 px): the queue is an overlay behind this "Transfers (n)" toggle. */
function QueueToggle(): React.JSX.Element {
  const open = useFiles((s) => s.queueOpen)
  const items = useQueueItems()
  const active = items.filter((i) => i.state === 'running' || i.state === 'queued').length
  const failed = items.some((i) => i.state === 'error')
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={open}
      aria-controls="files-transfers"
      aria-label={`Transfers (${items.length}${active ? `, ${active} active` : ''})`}
      onClick={() => useFiles.getState().set({ queueOpen: !open })}
      className={cn('@[760px]/files:hidden', open && 'bg-active text-fg')}
    >
      <ArrowLeftRight />
      <span className="hidden @[620px]/files:inline">Transfers</span>
      <span className={cn('tabular-nums', failed ? 'text-danger' : active ? 'text-accent' : 'text-fg-subtle')}>{active ? `${active}/${items.length}` : items.length}</span>
    </Button>
  )
}

type Crumb = { label: string; path: string; title?: string }

function Breadcrumbs({ path, onGo }: { path: string; onGo: (p: string) => void }): React.JSX.Element {
  const parts = useMemo(() => {
    const out: Crumb[] = []
    const dev = /^([A-Za-z0-9-]+:)(.*)$/.exec(path)
    let rest = path
    let acc = ''
    if (dev) {
      out.push({ label: dev[1]!, path: dev[1]! })
      acc = dev[1]!
      rest = dev[2]!
    } else if (path.startsWith('/')) {
      out.push({ label: '/', path: '/' })
      acc = ''
    }
    for (const seg of rest.split('/').filter(Boolean)) {
      acc = acc.endsWith(':') || acc === '' ? `${acc}${acc === '' ? '/' : ''}${seg}` : `${acc}/${seg}`
      out.push({ label: seg, path: acc })
    }
    // Deep paths keep the root and the last two folders; "…" goes up to the one before them.
    if (out.length > 4) return [out[0]!, { label: '…', path: out[out.length - 3]!.path, title: out.slice(1, -2).map((p) => p.label).join('/') }, ...out.slice(-2)]
    return out
  }, [path])
  return (
    <nav aria-label="Folder" className="flex min-w-0 items-center gap-0.5 overflow-hidden text-xs">
      {parts.map((p, i) => {
        const last = i === parts.length - 1
        return (
          <span
            key={`${p.path}:${p.label}`}
            // A narrow panel shows only the current folder (the Up button and the tooltip carry the rest).
            className={cn('min-w-0 items-center gap-0.5', last ? 'flex shrink' : 'hidden shrink-[4] @[620px]/files:flex', p.label.length > 2 && !last && 'min-w-[2.5rem]')}
          >
            {i > 0 && parts[i - 1]!.label !== '/' && <ChevronRight aria-hidden className={cn('size-3 shrink-0 text-fg-subtle', last && 'hidden @[620px]/files:block')} />}
            <button
              type="button"
              onClick={() => onGo(p.path)}
              title={p.title ?? (last ? path : p.label.length > 14 ? p.label : undefined)}
              aria-label={p.title ? `Up to ${p.path}` : undefined}
              aria-current={last ? 'location' : undefined}
              className={cn('min-w-0 truncate whitespace-nowrap rounded-sm px-1 py-0.5 hover:bg-hover', last ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg')}
            >
              {p.label}
            </button>
          </span>
        )
      })}
    </nav>
  )
}

function RemoteBrowser({ tabId, info, compact, toolbar }: { tabId: string; info: FilesInfo; compact: boolean; toolbar: HTMLElement | null }): React.JSX.Element {
  const cwd = useFiles((s) => s.byTab[tabId]?.cwd ?? info.home)
  const showHidden = useFiles((s) => s.showHidden)
  const policy = useFiles((s) => s.policy)
  const shell = useFiles((s) => s.byTab[tabId])
  const latestRequest = useRef(0)
  const toggleFollow = () => useFiles.setState((s) => {
    const current = s.byTab[tabId]
    if (!current?.shellDir) return s
    return { byTab: { ...s.byTab, [tabId]: { ...current, followShell: !current.followShell, cwd: current.followShell ? current.cwd : current.shellDir } } }
  })
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [focus, setFocus] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const api = window.hopline.transfer

  const go = (path: string) => {
    useFiles.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId], cwd: path, followShell: false } } }))
    setFocus(0)
    setSelected(new Set())
  }

  const load = useCallback(async () => {
    const request = ++latestRequest.current
    try {
      const r = (await api.op(tabId, { op: 'list', path: cwd })) as RemoteEntry[]
      if (request !== latestRequest.current) return
      setEntries(r)
      setError(null)
    } catch (e) {
      if (request !== latestRequest.current) return
      setEntries([])
      setError(cleanError(e))
    }
  }, [api, tabId, cwd])
  useEffect(() => {
    setEntries(null)
    setError(null)
    setFocus(0)
    setSelected(new Set())
    void load()
    return () => { latestRequest.current++ }
  }, [load])
  useEffect(() => {
    refreshers.set(tabId, () => void load())
    return () => void refreshers.delete(tabId)
  }, [tabId, load])
  // Opening the panel focuses the list (round 2): keyboard-first, never focus on <body>.
  const wantFocus = useFiles((s) => s.wantFocus)
  useEffect(() => {
    if (wantFocus && entries !== null) takeFocus(list.current)
  }, [wantFocus, entries])

  const shown = useMemo(() => {
    const vis = (entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'))
    const k = sort.key
    return vis.sort((a, b) => {
      const da = a.type === 'dir' ? 0 : 1
      const db = b.type === 'dir' ? 0 : 1
      if (da !== db) return da - db
      const v = k === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : k === 'size' ? a.size - b.size : a.mtime - b.mtime
      return v * sort.dir
    })
  }, [entries, showHidden, sort])
  const hiddenCount = (entries ?? []).filter((e) => e.name.startsWith('.')).length
  const cur = shown[Math.min(focus, shown.length - 1)]
  const pathOf = (e: RemoteEntry) => remoteJoin(cwd, e.name)
  const targets = () => (selected.size ? shown.filter((e) => selected.has(e.name)) : cur ? [cur] : [])

  const download = async (items = targets()) => {
    const files = items.filter((e) => e.type === 'file' || e.type === 'link')
    if (!files.length) return void toast('Pick a file to download', { description: 'Folders are not downloaded; open one to pick files inside it.' })
    try {
      handleQueue(await api.download({ tabId, items: files.map((e) => ({ path: pathOf(e), size: e.size })), policy }))
      useFiles.setState({ downloadDir: await api.downloadDir() })
    } catch (e) {
      toast.error('Download failed', { description: cleanError(e) })
    }
  }
  const upload = async () => {
    try {
      handleQueue(await api.pickUpload({ tabId, remoteDir: cwd, policy }))
    } catch (e) {
      toast.error('Upload failed', { description: cleanError(e) })
    }
  }
  const mkdir = async () => {
    const name = (await askText('New folder', '', { description: `In ${cwd}` }))?.trim()
    if (!name) return
    if (/[/\\]/.test(name)) return void toast.error('A folder name cannot contain / or \\')
    try {
      await api.op(tabId, { op: 'mkdir', path: remoteJoin(cwd, name) })
      await load()
    } catch (e) {
      toast.error('Could not create the folder', { description: cleanError(e) })
    }
  }
  const rename = async (e = cur) => {
    if (!e) return
    const name = (await askText(`Rename ${e.name}`, e.name))?.trim()
    if (!name || name === e.name) return
    if (/[/\\]/.test(name)) return void toast.error('A name cannot contain / or \\')
    try {
      await api.op(tabId, { op: 'rename', from: pathOf(e), to: remoteJoin(cwd, name) })
      await load()
    } catch (err) {
      toast.error('Could not rename', { description: cleanError(err) })
    }
  }
  const remove = async () => {
    const items = targets()
    if (!items.length) return
    const what = items.length === 1 ? items[0]!.name : `${items.length} items`
    const ok = await askConfirm(`Delete ${what}?`, `This deletes ${items.length === 1 ? `${items[0]!.type === 'dir' ? 'the folder' : 'the file'} on the device` : 'them on the device'}. It cannot be undone.`, 'Delete')
    if (!ok) return
    for (const e of items) {
      try {
        await api.op(tabId, { op: 'remove', path: pathOf(e), dir: e.type === 'dir' })
      } catch (err) {
        toast.error(`Could not delete ${e.name}`, { description: cleanError(err) })
      }
    }
    setSelected(new Set())
    await load()
  }
  const activate = (e: RemoteEntry | undefined) => {
    if (!e) return
    if (e.type === 'dir') go(pathOf(e))
    else void download([e])
  }

  const onKey = (ev: React.KeyboardEvent) => {
    const n = shown.length
    const k = ev.key
    if (k === 'ArrowDown') setFocus((f) => Math.min(n - 1, f + 1))
    else if (k === 'ArrowUp') setFocus((f) => Math.max(0, f - 1))
    else if (k === 'Home') setFocus(0)
    else if (k === 'End') setFocus(n - 1)
    else if (k === 'F3' && cur && cur.type !== 'dir') setPreview(pathOf(cur))
    else if (k === 'Enter') activate(cur)
    else if (k === 'Backspace' && remoteParent(cwd) && remoteParent(cwd) !== cwd) go(remoteParent(cwd))
    else if (k === 'Delete') void remove()
    else if (k === 'F2') void rename()
    else if (k === ' ' && cur) {
      const next = new Set(selected)
      if (next.has(cur.name)) next.delete(cur.name)
      else next.add(cur.name)
      setSelected(next)
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') setSelected(new Set(shown.map((e) => e.name)))
    else return
    ev.preventDefault()
    ev.stopPropagation()
  }
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${focus}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    try {
      handleQueue(await api.uploadDropped({ tabId, remoteDir: cwd, policy }, files))
    } catch (err) {
      toast.error('Upload failed', { description: cleanError(err) })
    }
  }

  const header = (key: SortKey, label: string, className: string) => (
    <button
      type="button"
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      className={cn('flex items-center gap-1 whitespace-nowrap hover:text-fg', className, sort.key === key && 'text-fg')}
    >
      {label}
      {sort.key === key && (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  )
  const up = remoteParent(cwd)
  // Name always keeps at least 8rem; Modified and Permissions only when the list itself is 520 px
  // wide (its own container: a docked transfer queue takes 320 px of the panel).
  const cols = 'grid-cols-[minmax(8rem,1fr)_4.5rem] @[520px]/list:grid-cols-[minmax(8rem,1fr)_5.5rem_8.5rem_6.5rem]'
  const policyLabel = POLICIES.find((p) => p.value === policy)?.short ?? 'Ask'

  const tools = (
    <>
      <Tooltip label="Parent folder" shortcut="Backspace">
        <Button variant="ghost" size="icon-sm" aria-label="Parent folder" disabled={!up || up === cwd} onClick={() => go(up)}>
          <ArrowUp />
        </Button>
      </Tooltip>
      <div className="min-w-[4rem] flex-1">
        <Breadcrumbs path={cwd} onGo={go} />
      </div>
      {/* Folder tools: icons from 760 px, the … menu below that. */}
      <div className="hidden shrink-0 items-center gap-0.5 @[760px]/files:flex">
        <Tooltip label={showHidden ? 'Hide hidden files' : `Show hidden files${hiddenCount ? ` (${hiddenCount})` : ''}`}>
          <Button variant="ghost" size="icon-sm" aria-label="Show hidden files" aria-pressed={showHidden} onClick={() => useFiles.getState().set({ showHidden: !showHidden })}>
            {showHidden ? <Eye /> : <EyeOff />}
          </Button>
        </Tooltip>
        <Tooltip label="Refresh">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void load()}>
            <RotateCw />
          </Button>
        </Tooltip>
        <Tooltip label="New folder">
          <Button variant="ghost" size="icon-sm" aria-label="New folder" onClick={() => void mkdir()}>
            <FolderPlus />
          </Button>
        </Tooltip>
        <Tooltip label="Rename" shortcut="F2">
          <Button variant="ghost" size="icon-sm" aria-label="Rename" disabled={!cur} onClick={() => void rename()}>
            <Pencil />
          </Button>
        </Tooltip>
        <Tooltip label="Delete" shortcut="Delete">
          <Button variant="ghost" size="icon-sm" aria-label="Delete" disabled={!cur} onClick={() => void remove()}>
            <Trash2 />
          </Button>
        </Tooltip>
        <span aria-hidden className="mx-1 h-4 w-px bg-line" />
        <SelectMenu aria-label="If a file exists" value={policy} onValueChange={(v) => useFiles.getState().set({ policy: v })} options={POLICIES} className="h-6 w-40 shrink-0 text-xs" />
      </div>
      <DM.Root>
        <Tooltip label={`More: folder tools, if a file exists (${policyLabel.toLowerCase()})`}>
          <DM.Trigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More file actions" className="@[760px]/files:hidden">
              <MoreHorizontal />
            </Button>
          </DM.Trigger>
        </Tooltip>
        <DM.Portal>
          <DM.Content align="end" sideOffset={4} className="z-50 min-w-52 rounded-md bg-overlay p-1 shadow-overlay animate-pop-in">
            <DM.CheckboxItem className={menuItem} checked={showHidden} onCheckedChange={(v) => useFiles.getState().set({ showHidden: v === true })}>
              <span className="flex size-3.5 items-center justify-center">
                <DM.ItemIndicator>
                  <Check />
                </DM.ItemIndicator>
              </span>
              Show hidden files{hiddenCount ? ` (${hiddenCount})` : ''}
            </DM.CheckboxItem>
            <DM.Item className={menuItem} onSelect={() => void load()}>
              <RotateCw />
              Refresh
            </DM.Item>
            <DM.Item className={menuItem} onSelect={() => void mkdir()}>
              <FolderPlus />
              New folder…
            </DM.Item>
            <DM.Item className={menuItem} disabled={!cur} onSelect={() => void rename()}>
              <Pencil />
              <span className="flex-1">Rename…</span>
              <span className="text-2xs text-fg-subtle">F2</span>
            </DM.Item>
            <DM.Item className={menuItem} disabled={!cur} onSelect={() => void remove()}>
              <Trash2 />
              <span className="flex-1">Delete…</span>
              <span className="text-2xs text-fg-subtle">Del</span>
            </DM.Item>
            <DM.Separator className="my-1 h-px bg-line" />
            <DM.Label className={menuLabel}>If a file exists</DM.Label>
            <DM.RadioGroup value={policy} onValueChange={(v) => useFiles.getState().set({ policy: v as OverwritePolicy })}>
              {POLICIES.map((p) => (
                <DM.RadioItem key={p.value} value={p.value} className={menuItem}>
                  <span className="flex size-3.5 items-center justify-center">
                    <DM.ItemIndicator>
                      <Check />
                    </DM.ItemIndicator>
                  </span>
                  {p.short}
                </DM.RadioItem>
              ))}
            </DM.RadioGroup>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      {shell?.shellDir && <Tooltip label={shell.followShell ? 'Stop following the terminal folder' : 'Follow the folder reported by the terminal'}>
        <Button size="sm" variant="ghost" aria-label="Follow terminal folder" aria-pressed={!!shell.followShell} className="shrink-0 aria-pressed:text-accent" onClick={toggleFollow}>
          <Link2 /><span className="hidden @[1000px]/files:inline">Follow folder</span>
        </Button>
      </Tooltip>}
      <Tooltip label="Preview file" shortcut="F3">
        <Button size="sm" variant="ghost" aria-label="Preview file" onClick={() => cur && setPreview(pathOf(cur))} disabled={!cur || cur.type === 'dir'} className="shrink-0">
          <Eye /><span className="hidden @[760px]/files:inline">Preview</span>
        </Button>
      </Tooltip>
      <Tooltip label="Download the selection" shortcut="Enter">
        <Button size="sm" variant="ghost" aria-label="Download" onClick={() => void download()} disabled={!cur || cur.type === 'dir'} className="shrink-0">
          <Download />
          <span className="hidden @[620px]/files:inline">Download</span>
        </Button>
      </Tooltip>
      <Button size="sm" onClick={() => void upload()} className="shrink-0">
        <Upload />
        Upload…
      </Button>
    </>
  )

  return (
    <div className="@container/list flex h-full min-h-0 flex-col">
      {preview && <FilePreviewDialog key={preview} tabId={tabId} path={preview} close={() => setPreview(null)} />}
      {/* The tools render into the panel's header row: one row for title, path and tools. */}
      {toolbar && createPortal(tools, toolbar)}
      {!compact && (
        <div className={cn('grid h-7 shrink-0 items-center gap-3 border-b border-line px-3 text-2xs font-medium text-fg-subtle', cols)}>
          {header('name', 'Name', '')}
          {header('size', 'Size', 'justify-end')}
          {header('mtime', 'Modified', 'hidden @[520px]/list:flex')}
          <span className="hidden @[520px]/list:inline">Permissions</span>
        </div>
      )}
      <div
        ref={list}
        role="listbox"
        aria-label={`Files in ${cwd}`}
        aria-multiselectable
        aria-activedescendant={cur ? `file-row-${focus}` : undefined}
        tabIndex={0}
        onKeyDown={onKey}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
        }}
        onDrop={(e) => void onDrop(e)}
        // No ring around the whole list (too heavy): the focused row carries an accent edge while
        // the list has focus (round 2, P2).
        className={cn('group/list relative min-h-0 flex-1 overflow-auto outline-none', dragOver && 'bg-accent-soft')}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border border-dashed border-accent/60 text-sm font-medium text-accent">
            Drop to upload to {cwd}
          </div>
        )}
        {entries === null && <div className="px-3 py-2 text-sm text-fg-subtle">Loading…</div>}
        {error && <div className="px-3 py-2 text-sm text-danger">{error}</div>}
        {entries && !error && shown.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-fg-subtle">
            {hiddenCount ? `Only hidden files here (${hiddenCount}).` : 'This folder is empty.'} Drop files here to upload.
          </div>
        )}
        {shown.map((e, i) => {
          const Icon = e.type === 'dir' ? Folder : e.type === 'link' ? FileSymlink : File
          const isSel = selected.has(e.name)
          return (
            <div
              key={e.name}
              id={`file-row-${i}`}
              data-index={i}
              role="option"
              aria-selected={isSel || i === focus}
              onClick={(ev) => {
                setFocus(i)
                if (ev.ctrlKey || ev.metaKey) {
                  const next = new Set(selected)
                  if (next.has(e.name)) next.delete(e.name)
                  else next.add(e.name)
                  setSelected(next)
                } else setSelected(new Set())
              }}
              onDoubleClick={() => activate(e)}
              className={cn(
                'grid h-7 cursor-default items-center gap-3 px-3 text-sm',
                cols,
                i === focus
                  ? 'bg-active text-fg group-focus-visible/list:shadow-[inset_2px_0_0_var(--c-accent)]'
                  : isSel
                    ? 'bg-accent-soft text-fg'
                    : 'text-fg-muted hover:bg-hover hover:text-fg'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon aria-hidden className={cn('size-3.5 shrink-0', e.type === 'dir' ? 'text-accent' : 'text-fg-subtle')} />
                <span className="min-w-0 truncate">{e.name}</span>
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-fg-subtle">{e.type === 'dir' ? '—' : formatBytes(e.size)}</span>
              <span className="hidden whitespace-nowrap tabular-nums text-fg-subtle @[520px]/list:inline">{fmtDate(e.mtime)}</span>
              <Tooltip label={`${e.mode.toString(8).padStart(4, '0')}${e.uid !== undefined ? ` · uid ${e.uid} gid ${e.gid}` : ''}`}>
                <span className="hidden whitespace-nowrap font-mono text-xs text-fg-subtle @[520px]/list:inline">{e.perms}</span>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** SCP transfers use full paths. Supported devices can supply a directory listing over SSH. */
function ScpCopy({ tabId, info, platform }: { tabId: string; info: FilesInfo; platform: string }): React.JSX.Element {
  const policy = useFiles((s) => s.policy)
  const root = info.roots[0] ?? ''
  const [to, setTo] = useState(root)
  const [from, setFrom] = useState(root)
  const [preview, setPreview] = useState<string | null>(null)
  const api = window.hopline.transfer
  const send = async () => {
    const path = to.trim()
    if (!path || /[:/]$/.test(path)) return void toast.error('Type the full destination path', { description: `For example ${root || 'flash:'}c2900-universalk9-mz.SPA.157-3.M8.bin` })
    try {
      handleQueue(await api.pickUpload({ tabId, remotePath: path, policy }))
    } catch (e) {
      toast.error('Upload failed', { description: cleanError(e) })
    }
  }
  const fetch = async () => {
    const path = from.trim()
    if (!path || /[:/]$/.test(path)) return void toast.error('Type the path of a file on the device', { description: `For example ${root || 'flash:'}tech-support.txt` })
    try {
      handleQueue(await api.download({ tabId, items: [{ path }], policy }))
      useFiles.setState({ downloadDir: await api.downloadDir() })
    } catch (e) {
      toast.error('Download failed', { description: cleanError(e) })
    }
  }
  const roots = (set: (v: string) => void, v: string) =>
    info.roots.length > 0 && (
      <div className="flex flex-wrap gap-1">
        {info.roots.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => set(r + v.replace(/^[A-Za-z0-9-]+:\/?|^\/[^ ]*\//, ''))}
            className="rounded-sm bg-active px-1.5 py-0.5 font-mono text-2xs text-fg-muted hover:text-fg"
          >
            {r}
          </button>
        ))}
      </div>
    )
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <p className="max-w-[68ch] text-sm text-fg-muted">
        {supportsScpDirectory(platform) ? 'Browse the directory with a read-only SSH command, or enter a file path to use SCP.' : 'Use a full file path to preview or copy a file over SCP.'}{' '}
        <span className="text-fg-subtle">SCP transfers can’t resume; a retry starts over.</span>
      </p>
      {supportsScpDirectory(platform) && <ScpDirectory tabId={tabId} roots={info.roots} pick={(path) => { setFrom(path); setPreview(path) }} />}
      <div className="mt-3 grid max-w-3xl gap-3 @[640px]/files:grid-cols-2">
        <form
          className="min-w-0 space-y-2 rounded-lg border border-line bg-raised p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <Upload aria-hidden className="size-3.5 text-fg-subtle" />
            Copy a file to the device
          </div>
          <label className="block text-xs text-fg-muted" htmlFor="scp-to">
            Destination path
          </label>
          <Input id="scp-to" value={to} onChange={(e) => setTo(e.target.value)} className="font-mono" placeholder={`${root || 'flash:'}image.bin`} />
          {roots(setTo, to)}
          <div className="flex justify-end pt-1">
            <Button type="submit" variant="primary" size="sm">
              Choose file and copy…
            </Button>
          </div>
        </form>
        <form
          className="min-w-0 space-y-2 rounded-lg border border-line bg-raised p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void fetch()
          }}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <Download aria-hidden className="size-3.5 text-fg-subtle" />
            Copy a file from the device
          </div>
          <label className="block text-xs text-fg-muted" htmlFor="scp-from">
            Source path
          </label>
          <Input id="scp-from" value={from} onChange={(e) => setFrom(e.target.value)} className="font-mono" placeholder={`${root || 'flash:'}tech-support.txt`} />
          {roots(setFrom, from)}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" disabled={!from.trim() || /[:/]$/.test(from.trim())} onClick={() => setPreview(from.trim())}><Eye /> Preview</Button>
            <Button type="submit" size="sm">
              Download
            </Button>
          </div>
        </form>
      </div>
      {preview && <FilePreviewDialog key={preview} tabId={tabId} path={preview} close={() => setPreview(null)} />}
      {platform === 'auto' && <p className="mt-3 text-xs text-fg-subtle">Set the platform to get filesystem suggestions and the verify command after an upload.</p>}
    </div>
  )
}
