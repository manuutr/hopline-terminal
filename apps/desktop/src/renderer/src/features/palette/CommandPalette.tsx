import { SETTINGS, SETTINGS_SECTIONS } from '@shared/settings-registry'
import { openSettings } from '../../lib/settings-nav'
import { scrubTerminalText } from '../../lib/command-evidence'
import { terminals } from '../../lib/terminals'
import { Command, defaultFilter } from 'cmdk'
import { ArrowLeft, ChevronRight, CircleHelp, Folder as FolderIcon, Hash, Keyboard, Server, Tag, TriangleAlert, Zap } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@shared/types'
import { CommandFooter, CommandInputRow, CommandSurface, commandGroup, commandInput, commandRow, Button, EmptyState, Kbd } from '../../design'
import { SessionStatus } from '../layout/StatusGlyph'
import { openSession, quickConnect } from '../../lib/connect'
import { parseQuickConnect } from '../../lib/quickconnect'
import { allActions, inPalette, keysOf, titleOf, useActionsVersion, useKeymap, CATEGORY_ORDER } from '../../lib/actions'
import { parsePalette, PLACEHOLDER, PREFIXES, takePaletteStart } from '../../lib/palette-mode'
import { describeTarget } from './QuickConnect'
import { useUi } from '../../store'
import { PaletteSnippets, PaletteGroupActions } from './palette-extras'

function Item({ onSelect, icon, children, shortcut, value, keywords }: { onSelect: () => void; icon: ReactNode; children: ReactNode; shortcut?: string; value: string; keywords?: string[] }): React.JSX.Element {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} className={commandRow}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Kbd keys={shortcut} />}
    </Command.Item>
  )
}

const group = commandGroup

const QUICK = '__quick-connect__'

/**
 * The quick-connect row always survives filtering. A clear target (user@, :port, a scheme, an IP or
 * a dotted name) ranks first so Enter connects; a bare word ranks below matching saved sessions.
 * A prefix (`>`, `@`, …) is not part of the query.
 */
const filter = (bare: boolean) => (value: string, search: string, keywords?: string[]) => {
  if (value === QUICK) return bare ? 0.05 : 2
  if (value.startsWith('__help')) return 1
  const q = parsePalette(search).query
  if (!q) return 1
  const score = defaultFilter(value, q, keywords)
  // Keep shortcuts to existing actions ahead of incidental matches in settings keywords.
  return value.startsWith('setting ') ? score * .45 : score
}

export type PaletteGroup = { kind: 'tag' | 'folder'; id: string; name: string; sessions: Session[] }

/** Sessions in a folder or any folder below it. */
export function sessionsInFolder(folderId: string, folders: { id: string; parentId: string | null }[], sessions: Session[]): Session[] {
  const ids = new Set([folderId])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
  }
  return sessions.filter((s) => s.folderId && ids.has(s.folderId))
}

type FolderLike = { id: string; name: string; parentId: string | null }

/** "Core", or "DC1 Frankfurt / Core" when another folder has the same name. */
export function folderLabel(f: FolderLike, folders: readonly FolderLike[]): string {
  if (folders.filter((x) => x.name === f.name).length < 2) return f.name
  const parts = [f.name]
  const seen = new Set([f.id])
  for (let p = folders.find((x) => x.id === f.parentId); p && !seen.has(p.id); p = folders.find((x) => x.id === p!.parentId)) {
    seen.add(p.id)
    parts.unshift(p.name)
  }
  return parts.length > 1 ? parts.join(' / ') : `${f.name} (top level)`
}

/**
 * Mod+K: actions, sessions and quick connect; prefixes narrow it (`>` commands, `@` sessions,
 * `#` tags and folders, `!` snippets, `?` help). Actions come from the registry (lib/actions).
 */
export function CommandPalette(): React.JSX.Element | null {
  const { paletteOpen, sessions, tabs, folders } = useUi()
  const overrides = useKeymap((s) => s.overrides)
  useActionsVersion()
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<PaletteGroup | null>(null)
  const [commandChosen, setCommandChosen] = useState(false)
  useEffect(() => {
    if (paletteOpen) {
      setCommandChosen(false)
      setSearch(takePaletteStart())
      setPicked(null)
    }
  }, [paletteOpen])
  // Esc inside a picked tag or folder goes back to the `#` list first; a second Esc closes. A window
  // capture listener runs before the dialog's own Esc handler (document, capture) and stops it.
  useEffect(() => {
    if (!paletteOpen || !picked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setPicked(null)
      setSearch('#')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [paletteOpen, picked])
  const { mode } = parsePalette(search)
  const quick = mode === 'all' || mode === 'sessions' ? parseQuickConnect(mode === 'sessions' ? search.slice(1).trim() : search) : null
  // Errors only once it clearly is a target; a bare word is offered, never forced.
  const bare = !!quick?.ok && quick.target.bare
  // Typed targets connect as typed (no stored credential); say so when a saved session is the same device.
  const saved =
    quick?.ok && !bare
      ? sessions.find((s) => s.host.toLowerCase() === quick.target.host.toLowerCase() && s.port === quick.target.port && (!quick.target.username || s.username === quick.target.username))
      : undefined
  const close = () => {
    setCommandChosen(true)
    useUi.getState().set({ paletteOpen: false })
  }
  const run = (f: () => void) => () => {
    close()
    f()
  }
  const set = useUi.getState().set
  const show = { quick: mode === 'all' || mode === 'sessions', sessions: mode === 'all' || mode === 'sessions', actions: mode === 'all' || mode === 'commands' }

  const history = paletteOpen && mode === 'all' ? tabs.flatMap((tab) => {
    const ctl = terminals.get(tab.tabId)?.blocks
    return (ctl?.blocks ?? []).slice(-24).filter((b) => !b.start.isDisposed && b.command === scrubTerminalText(b.command))
      .map((b) => ({ id: tab.tabId, name: tab.title, command: b.command, at: b.closedAt }))
  }).sort((a, b) => b.at - a.at).slice(0, 20) : []
  const actions = allActions().filter(inPalette)
  actions.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))

  const browsing = mode === 'all' && !search.trim()
  const shownActions = browsing ? actions.slice(0, 12) : actions
  const normalized = (label: string) => label.replace(/[…&]/g, '').trim().toLowerCase()
  const matchingAction = actions.some((a) => normalized(titleOf(a)) === normalized(search))
  const settingRows = matchingAction ? SETTINGS.filter((def) => normalized(def.label) !== normalized(search)) : SETTINGS
  const tags = [...new Set(sessions.flatMap((s) => s.tags))].sort((a, b) => a.localeCompare(b))
  const sessionRows = (list: Session[]) =>
    list.map((s) => (
      <Item key={s.id} value={`connect ${s.name} ${s.host} ${s.platform} ${s.tags.join(' ')}`} icon={<Server />} onSelect={run(() => openSession(s))}>
        {s.name} <span className="ml-1 font-mono text-xs text-fg-subtle">{s.host}:{s.port}</span>
      </Item>
    ))

  const pick = (g: PaletteGroup) => {
    setPicked(g)
    setSearch('')
  }

  // A selected command can open another dialog in the same render. Release the palette's
  // keyboard handlers immediately so its exit animation cannot consume the next Escape.
  if (!paletteOpen && commandChosen) return null
  return (
    <CommandSurface open={paletteOpen} onOpenChange={(o) => set({ paletteOpen: o })} title="Command palette" description="Search sessions and actions">
      <Command loop filter={filter(bare)} className="flex min-h-0 flex-col">
        <CommandInputRow icon={picked ? (picked.kind === 'tag' ? <Hash /> : <FolderIcon />) : <ChevronRight />}>
          {picked && (
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="flex h-5 shrink-0 items-center gap-1 rounded bg-active px-1.5 text-xs text-fg"
              aria-label={`Leave ${picked.name}`}
            >
              <ArrowLeft className="size-3" /> {picked.name}
            </button>
          )}
          <Command.Input
            value={search}
            onValueChange={setSearch}
            autoFocus
            onKeyDown={(e) => {
              // Backspace on an empty input leaves the picked group.
              if (picked && e.key === 'Backspace' && !search) setPicked(null)
            }}
            placeholder={picked ? `Sessions in ${picked.name}…` : PLACEHOLDER[mode]}
            aria-label="Command palette"
            className={commandInput}
          />
        </CommandInputRow>
        <Command.List className="max-h-[min(440px,56vh)] overflow-auto p-1">
          <Command.Empty><EmptyState title="Nothing found." body="Try a command, device name or setting." action={<Button size="sm" onClick={() => setSearch('')}>Clear search</Button>} /></Command.Empty>
          {picked ? (
            <>
              <PaletteGroupActions group={picked} onDone={close} />
              <Command.Group heading={`${picked.sessions.length} session${picked.sessions.length === 1 ? '' : 's'}`} className={group}>
                {sessionRows(picked.sessions)}
              </Command.Group>
            </>
          ) : (
            <>
              {mode === 'help' && (
                <Command.Group heading="Prefixes" className={group}>
                  {PREFIXES.filter((p) => p.mode !== 'help').map((p) => (
                    <Item key={p.prefix} value={`__help ${p.prefix}`} icon={<span className="flex w-4 justify-center font-mono text-sm text-fg">{p.prefix}</span>} onSelect={() => setSearch(p.prefix)}>
                      {p.label} <span className="ml-1 text-xs text-fg-subtle">{p.hint}</span>
                    </Item>
                  ))}
                  <Item value="__help shortcuts" icon={<Keyboard />} shortcut={(() => {
                    const a = allActions().find((x) => x.id === 'app.shortcuts')
                    return a ? keysOf(a, overrides)[0] : undefined
                  })()} onSelect={run(() => set({ shortcutsOpen: true }))}>
                    Keyboard shortcuts
                  </Item>
                </Command.Group>
              )}
              {/* A clear target goes first; a bare word (maybe a search) goes last, under real matches. */}
              {show.quick && quick && !bare && (
                <Command.Group heading="Quick connect" className={group}>
                  {quick.ok ? (
                    <Item value={QUICK} icon={<Zap />} onSelect={run(() => void quickConnect(quick.target))}>
                      Connect to <span className="ml-1 font-mono text-xs text-fg-subtle">{describeTarget(quick.target)}</span>
                      {saved && <span className="ml-2 text-2xs text-fg-subtle">· also saved as {saved.name}</span>}
                    </Item>
                  ) : (
                    <Command.Item value={QUICK} disabled className="flex h-7 items-center gap-2.5 rounded px-2 text-sm text-danger [&_svg]:size-3.5">
                      <TriangleAlert />
                      <span className="truncate">{quick.error}</span>
                    </Command.Item>
                  )}
                </Command.Group>
              )}
              {show.sessions && tabs.length > 0 && (
                <Command.Group heading="Open tabs" className={group}>
                  {tabs.map((t) => (
                    <Item key={t.tabId} value={`tab ${t.title} ${t.tabId}`} icon={<span className="flex w-4 justify-center"><SessionStatus tabs={[t]} /></span>} onSelect={run(() => useUi.getState().activate(t.tabId))}>
                      {t.title}
                    </Item>
                  ))}
                </Command.Group>
              )}
              {show.sessions && (
                <Command.Group heading="Connect" className={group}>
                  {sessionRows(sessions)}
                </Command.Group>
              )}
              {mode === 'groups' && (
                <>
                  {tags.length > 0 && (
                    <Command.Group heading="Tags" className={group}>
                      {tags.map((t) => {
                        const list = sessions.filter((s) => s.tags.includes(t))
                        return (
                          <Item key={t} value={`tag ${t}`} icon={<Tag />} onSelect={() => pick({ kind: 'tag', id: t, name: `#${t}`, sessions: list })}>
                            #{t} <span className="ml-1 text-xs text-fg-subtle">{list.length}</span>
                          </Item>
                        )
                      })}
                    </Command.Group>
                  )}
                  <Command.Group heading="Folders" className={group}>
                    {folders.map((f) => {
                      const list = sessionsInFolder(f.id, folders, sessions)
                      // Two folders with one name ("Core" under two sites) show where they live.
                      const path = folderLabel(f, folders)
                      return (
                        <Item key={f.id} value={`folder ${path} ${f.id}`} icon={<FolderIcon />} onSelect={() => pick({ kind: 'folder', id: f.id, name: path, sessions: list })}>
                          {path} <span className="ml-1 text-xs text-fg-subtle">{list.length}</span>
                        </Item>
                      )
                    })}
                  </Command.Group>
                </>
              )}
              {mode === 'snippets' && <PaletteSnippets onDone={close} />}
              {mode === 'all' && history.length > 0 && <Command.Group heading="Recent device commands" className={group}>
                {history.map((h, i) => <Item key={h.id + i} value={`device command ${h.command} ${h.name} ${i}`} icon={<ChevronRight />} onSelect={run(() => {
                  useUi.getState().activate(h.id)
                  terminals.get(h.id)?.term.paste(h.command)
                })}><span className="font-mono">{h.command}</span> <span className="ml-2 text-xs text-fg-subtle">{h.name} · Insert</span></Item>)}
              </Command.Group>}
              {show.actions && (
                <Command.Group heading="Actions" className={group}>
                  {shownActions.map((a) => {
                    const Icon = a.icon ?? CircleHelp
                    const t = titleOf(a)
                    return (
                      <Item key={a.id} value={`${t} ${a.id}`} keywords={a.keywords?.split(' ')} icon={<Icon />} shortcut={keysOf(a, overrides)[0]} onSelect={run(() => a.run())}>
                        {t}
                      </Item>
                    )
                  })}
                  {browsing && shownActions.length < actions.length && <Item value="browse all commands" icon={<ChevronRight />} onSelect={() => setSearch('>')}>Browse all commands</Item>}
                </Command.Group>
              )}
              {mode === 'all' && !!search.trim() && <Command.Group heading="Settings" className={group}>
                {settingRows.map((def) => <Item key={def.key} value={`setting ${def.label} ${def.key}`} keywords={def.keywords?.split(' ')} icon={<Keyboard />} onSelect={run(() => openSettings(def.key))}>
                  {def.label} <span className="ml-2 text-xs text-fg-subtle">{SETTINGS_SECTIONS[def.section].title}</span>
                </Item>)}
              </Command.Group>}
              {show.quick && quick?.ok && bare && (
                <Command.Group heading="Quick connect" className={group}>
                  <Item value={QUICK} icon={<Zap />} onSelect={run(() => void quickConnect(quick.target))}>
                    Connect to <span className="ml-1 font-mono text-xs text-fg-subtle">{describeTarget(quick.target)}</span>
                  </Item>
                </Command.Group>
              )}
            </>
          )}
        </Command.List>
        <CommandFooter hints={picked ? [['Enter', 'run'], ['Backspace', 'back'], ['Esc', 'back to #']] : [['Enter', 'run'], ['?', 'prefixes'], ['Mod+P', 'go to session'], ['Esc', 'close']]} />
      </Command>
    </CommandSurface>
  )
}
