import { Command } from 'cmdk'
import { Import, MessageSquare, PanelsTopLeft, Plus, Search, SquareTerminal, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { Button, cn, EmptyState, Loading, commandGroup, commandRow, Kbd } from '../../design'
import { createQuickSession, folderPath } from '../../lib/connect'
import { parseQuickConnect } from '../../lib/quickconnect'
import { describeTarget } from '../palette/QuickConnect'
import { useUi } from '../../store'
import { openImport } from '../import/store'
import { showWorkspaceChat } from '../ai/workspace-chat'
import { showOverview } from '../workspace/store'
import { useShortcutMap } from '../../lib/actions'
import { FirstRun, usePrivacyFirst } from '../onboarding/FirstRun'

function endpoint(s: Session): string {
  if (s.protocol === 'serial') return s.host
  const host = s.host.includes(':') && !s.host.startsWith('[') ? `[${s.host}]` : s.host
  return `${s.username ? s.username + '@' : ''}${host}:${s.port}`
}

/**
 * "Connect to…": the searchable session list shown in an empty split pane and when no tab is
 * open. Choosing a session calls `onPick`; Esc calls `onDismiss` (closes an empty pane).
 */
export function Launcher({
  onPick,
  onDismiss,
  focused = true,
  compact = false
}: {
  onPick: (s: Session) => void
  onDismiss?: () => void
  focused?: boolean
  compact?: boolean
}): React.JSX.Element {
  const sc = useShortcutMap()
  const sessions = useUi((s) => s.sessions)
  const loaded = useUi((s) => s.loaded)
  const loadError = useUi((s) => s.loadError)
  const folders = useUi((s) => s.folders)
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focused) requestAnimationFrame(() => input.current?.focus())
  }, [focused])

  // The first-run privacy step waits: it goes first, so its decision is on screen (review P1).
  // Latched: once the steps lead, they stay on top (no jump, no remount) after Continue.
  const pendingPrivacy = usePrivacyFirst() && !compact && !onDismiss
  const [led, setLed] = useState(false)
  if (pendingPrivacy && !led) setLed(true)
  const privacyFirst = pendingPrivacy || led
  const parsed = parseQuickConnect(q)
  // A clear target (not a bare word that is probably a search): connect now, or save it first.
  const quick = parsed?.ok && !parsed.target.bare ? parsed.target : null
  // Drawn like the terminal it stands in for: top-left, on the terminal's own background, no card.
  return (
    <div className="@container/launcher flex h-full w-full overflow-auto bg-term" data-launcher="">
      <div className={cn('w-full max-w-[680px] animate-workspace-in', compact ? 'px-3 pt-3' : privacyFirst ? 'px-6 py-6' : 'px-6 pt-[clamp(24px,7vh,60px)] pb-4')}>
        {privacyFirst && <FirstRun lead />}
        {!compact && (
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <SquareTerminal aria-hidden className="size-5 shrink-0 text-accent" />
              <h2 className="mr-auto text-lg font-semibold tracking-tight text-fg">Connect to a session</h2>
              <Button size="sm" variant="secondary" onClick={showWorkspaceChat}><MessageSquare />Ask assistant</Button>
              <Button size="sm" variant="ghost" onClick={showOverview}><PanelsTopLeft />Session overview</Button>
            </div>
            {loadError && <p role="alert" className="mt-1 text-xs text-danger">Could not read your sessions. Quick connect still works.</p>}
          </div>
        )}
        <Command
          loop
          onKeyDown={(e) => {
            if (e.key === 'Escape' && (q || onDismiss)) {
              e.preventDefault()
              e.stopPropagation()
              if (q) setQ('')
              else onDismiss?.()
            }
          }}
        >
          <div className="flex items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 focus-within:border-accent">
            <Search className="size-3.5 shrink-0 text-fg-subtle" />
            <Command.Input
              ref={input}
              value={q}
              onValueChange={setQ}
              aria-label="Connect to session"
              placeholder="Search sessions or enter user@host"
              className="h-9 min-w-0 flex-1 bg-transparent font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-subtle focus:outline-none"
            />
            {q && (
              <Button variant="ghost" size="icon-sm" aria-label="Clear session search"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
                onClick={() => {
                  setQ('')
                  input.current?.focus()
                }}
              >
                <X />
              </Button>
            )}
          </div>
          <Command.List className="-mx-1 mt-1 max-h-[min(360px,50vh)] overflow-auto py-1">
            <Command.Empty className="px-2 py-2 text-sm text-fg-subtle">
              {!loaded && !loadError ? <Loading what="sessions" /> : <EmptyState icon={<Search />} title="No matching sessions." body="Try a device name or address." action={<Button size="sm" onClick={() => setQ('')}>Clear search</Button>} />}
            </Command.Empty>
            {sessions.length > 0 && (
              <Command.Group heading="Saved sessions" className={commandGroup}>
                {sessions.map((s) => {
                  const path = folderPath(folders, s.folderId)
                  const address = endpoint(s)
                  return (
                    <Command.Item
                      key={s.id}
                      value={s.id}
                      keywords={[s.name, address, s.platform, s.protocol, path, ...(s.tags ?? [])]}
                      onSelect={() => onPick(s)}
                      className={cn(commandRow, 'grid h-auto min-h-10 grid-cols-1 @[400px]/launcher:grid-cols-[minmax(0,1fr)_minmax(0,32%)] gap-x-3 gap-y-0 py-1')}
                    >
                      <span className="truncate font-medium text-fg" title={s.name}>{s.name}</span>
                      {path && <span className="hidden @[400px]/launcher:block col-start-2 row-span-2 row-start-1 truncate text-right text-2xs text-fg-subtle" title={path}>{path}</span>}
                      <span className="col-start-1 row-start-2 truncate font-mono text-2xs text-fg-muted" title={address}>{address}</span>
                    </Command.Item>
                  )
                })}
              </Command.Group>
            )}
            {(quick || (!q && (loaded || loadError))) && (
              <Command.Group heading="Connection actions" className={commandGroup}>
                {quick && (
                  <Command.Item
                    value={`quick connect ${q}`}
                    onSelect={() => void createQuickSession(quick).then((s) => s && onPick(s))}
                    className={commandRow}
                  >
                    <Zap />
                    <span className="truncate">
                      Connect to <span className="font-mono text-xs text-fg-subtle">{describeTarget(quick)}</span>
                    </span>
                  </Command.Item>
                )}
                <Command.Item
                  value={`new host ${q}`}
                  onSelect={() =>
                    useUi.getState().set({
                      editing: {
                        open: true,
                        session: quick
                          ? { name: quick.host, host: quick.host, username: quick.username, port: quick.port, protocol: quick.protocol, platform: quick.platform, options: quick.serial ? { serial: quick.serial } : {} }
                          : undefined
                      }
                    })
                  }
                  className={commandRow}
                >
                  <Plus />
                  <span className="truncate">{quick ? `Add host ${q.trim()}…` : 'New host…'}</span>
                </Command.Item>
                {!q && (
                  <Command.Item value="import sessions" onSelect={() => openImport()} className={commandRow}>
                    <Import />
                    <span className="truncate">Import sessions…</span>
                    <span className="ml-auto truncate pl-2 text-2xs text-fg-subtle">SecureCRT, MobaXterm, PuTTY, ssh_config, CSV, NetBox</span>
                  </Command.Item>
                )}
              </Command.Group>
            )}
          </Command.List>
        </Command>
        <div className="mt-1 flex flex-wrap border-t border-line pt-2 items-center gap-x-4 gap-y-1.5 text-2xs text-fg-subtle">
          <span className="flex items-center gap-1.5">
            <Kbd keys="Enter" /> select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd keys={sc('session.switcher') ?? 'Mod+P'} /> go to session
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd keys={sc('palette.open') ?? 'Mod+K'} /> commands
          </span>
          {(onDismiss || q) && (
            <span className="flex items-center gap-1.5">
              <Kbd keys="Esc" /> {q ? 'clear search' : 'close pane'}
            </span>
          )}
        </div>
        {!compact && !onDismiss && !privacyFirst && <FirstRun />}
      </div>
    </div>
  )
}
