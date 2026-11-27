import { ArrowUpRight, ChevronRight, Folder, NotebookPen, Search, X } from 'lucide-react'
import { useState } from 'react'
import { Button, cn, Dialog, EmptyState, Input, Segmented, StatusDot } from '../../design'
import { focusOrOpen, folderPath, notifyError } from '../../lib/connect'
import { toast } from '../../lib/notify'
import { useUi } from '../../store'
import { NOTE_LIMIT, showScratchpad, useWorkspaceTools } from './store'

const close = () => useWorkspaceTools.setState({ panel: null })
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }] as const
const STATE_LABEL = { idle: 'Idle', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', down: 'Disconnected' } as const

function SessionOverview(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all')
  const tabs = useUi((s) => s.tabs)
  const saved = useUi((s) => s.sessions)
  const folders = useUi((s) => s.folders)
  const quick = useUi((s) => s.quick)
  const activeId = useUi((s) => s.activeTabId)
  const opened = new Set(tabs.map((t) => t.sessionId))
  const sessions = new Map([...saved, ...quick].map((s) => [s.id, s]))
  const rows = [
    ...tabs.flatMap((tab) => {
      const session = sessions.get(tab.sessionId)
      return session ? [{ session, tab }] : []
    }),
    ...saved.filter((s) => !opened.has(s.id)).map((session) => ({ session, tab: null }))
  ]
  const needle = query.trim().toLowerCase()
  const shown = rows.filter(({ session, tab }) => (filter === 'all' || (filter === 'open') === !!tab) &&
    (!needle || [session.name, tab?.title, session.host, session.protocol, folderPath(folders, session.folderId)].some((s) => s?.toLowerCase().includes(needle))))
  return <Dialog open onOpenChange={(v) => { if (!v) close() }} title="Session overview" className="w-[min(50rem,94vw)]"
    footer={<><span className="mr-auto text-xs tabular-nums text-fg-muted">{tabs.length} open · {tabs.filter((t) => t.state === 'connected').length} connected</span><Button onClick={showScratchpad}><NotebookPen />Scratchpad</Button></>}>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1">
        <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted" />
        <Input aria-label="Search sessions in overview" placeholder="Search name, host or folder" type="search" className="w-full pl-7 pr-7 [&::-webkit-search-cancel-button]:hidden" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button type="button" aria-label="Clear overview search" className="absolute inset-y-0 right-0 grid w-7 place-items-center rounded text-fg-muted hover:text-fg" onClick={(e) => {
          setQuery('')
          e.currentTarget.parentElement?.querySelector('input')?.focus()
        }}><X aria-hidden className="size-3.5" /></button>}
      </div>
      <Segmented label="Filter sessions" value={filter} items={FILTERS} onChange={setFilter} />
    </div>
    <div role="status" className="sr-only">
      {shown.length ? `${shown.length} ${shown.length === 1 ? 'session' : 'sessions'} shown` : rows.length ? 'No sessions match' : 'No sessions yet'}
    </div>
    <ul key={filter} aria-label="Session overview results" className="@container animate-workspace-in max-h-[min(53vh,30rem)] overflow-auto rounded-md border border-line bg-surface">
      {shown.map(({ session, tab }) => {
        const current = !!tab && tab.tabId === activeId
        const folder = folderPath(folders, session.folderId)
        return <li key={tab?.tabId ?? session.id} className="border-b border-line last:border-0">
          <button aria-current={current ? 'true' : undefined} className={cn('group relative flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover', current && 'bg-accent-soft before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r before:bg-accent')} onClick={() => {
            close()
            if (tab) useUi.getState().activate(tab.tabId)
            else focusOrOpen(session)
          }}>
            <span className="w-12 shrink-0 rounded border border-line-strong py-0.5 text-center font-mono text-2xs uppercase text-fg-muted">{session.protocol}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-fg">{tab?.title ?? session.name}</span>
              <span className="block truncate font-mono text-2xs text-fg-muted">{session.host}{session.protocol !== 'serial' && ' · ' + session.port}</span></span>
            {folder && <span title={folder} className="hidden w-[24%] min-w-0 items-center gap-1.5 text-xs text-fg-muted @[570px]:flex"><Folder aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{folder}</span></span>}
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">{tab && <StatusDot state={tab.state} />}{tab ? STATE_LABEL[tab.state] : 'Closed'}</span>
            {tab ? <ChevronRight aria-hidden className="size-3.5 text-fg-muted" /> : <ArrowUpRight aria-hidden className="size-3.5 text-fg-muted" />}
          </button>
        </li>
      })}
    </ul>
    {!shown.length && <EmptyState icon={<Search />} title={rows.length ? 'No sessions match this search and filter.' : 'No sessions yet'} body={rows.length ? 'Try another host or connection state.' : 'Save a device to see it in the overview.'} action={<Button size="sm" onClick={() => {
      if (rows.length) { setQuery(''); setFilter('all') }
      else { close(); useUi.getState().set({ editing: { open: true } }) }
    }}>{rows.length ? 'Clear filters' : 'Add a device'}</Button>} />}
  </Dialog>
}

function Scratchpad(): React.JSX.Element {
  const note = useWorkspaceTools((s) => s.note)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      if (await window.hopline.app.saveOutput('hopline-notes.txt', note)) toast.success('Scratchpad saved')
    } catch (e) { notifyError('Could not save the scratchpad', e) }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={(v) => { if (!v) close() }} title="Scratchpad" className="w-[min(48rem,94vw)]"
    description="Notes stay in this window until it closes. Save a text file to keep them."
    footer={<><Button onClick={close}>Close</Button><Button variant="primary" onClick={() => void save()} disabled={!note.trim() || saving}>Save as text…</Button></>}>
    <textarea aria-label="Scratchpad notes" spellCheck={false} value={note} maxLength={NOTE_LIMIT}
      placeholder="Write an observation, or add selected lines from the terminal."
      className="min-h-40 h-[36vh] w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm leading-relaxed text-fg"
      onChange={(e) => useWorkspaceTools.setState({ note: e.target.value })} />
  </Dialog>
}

export function WorkspaceTools(): React.JSX.Element | null {
  const panel = useWorkspaceTools((s) => s.panel)
  if (panel === 'overview') return <SessionOverview />
  if (panel === 'scratchpad') return <Scratchpad />
  return null
}
