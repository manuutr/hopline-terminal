import { Command } from 'cmdk'
import { Search, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Session } from '@shared/types'
import { Button, EmptyState, CommandFooter, CommandInputRow, CommandSurface, commandGroup, commandInput, commandRow } from '../../design'
import { focusOrOpen, folderPath, openInSplit } from '../../lib/connect'
import { terminals } from '../../lib/terminals'
import { sessionById, useUi, type Tab } from '../../store'
import { lastOutput } from '../terminal/TerminalHost'
import { SessionStatus } from './StatusGlyph'

const row = commandRow
const group = commandGroup

function ago(t: number | undefined): string {
  if (!t) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function Secondary({ s }: { s: Session | undefined }): React.JSX.Element | null {
  const folders = useUi((x) => x.folders)
  if (!s) return null
  const path = folderPath(folders, s.folderId)
  return (
    <>
      <span className="truncate font-mono text-xs text-fg-subtle">
        {s.username ? `${s.username}@` : ''}
        {s.host}
      </span>
      {path && <span className="truncate text-2xs text-fg-subtle">{path}</span>}
    </>
  )
}

function OpenRow({ tab, session, onPick }: { tab: Tab; session: Session | undefined; onPick: (v: string) => void }): React.JSX.Element {
  const value = `open:${tab.tabId}`
  return (
    <Command.Item value={value} keywords={[tab.title, session?.host ?? '', session?.username ?? '']} onSelect={() => onPick(value)} className={row}>
      {/* P2-11: one fixed 16 px status/icon column for open sessions and hosts alike. */}
      <span className="flex w-4 shrink-0 justify-center">
        <SessionStatus tabs={[tab]} />
      </span>
      <span className="truncate text-fg">{tab.title}</span>
      <Secondary s={session} />
      <span className="ml-auto shrink-0 pl-2 text-2xs tabular-nums text-fg-subtle">{ago(lastOutput.get(tab.tabId))}</span>
    </Command.Item>
  )
}

/**
 * Mod+P: "Go to session or host". Fuzzy over open sessions first, then saved hosts. Enter focuses
 * an open session (or connects a host); Alt+Enter opens it in a split to the right.
 */
export function SessionSwitcher(): React.JSX.Element {
  const open = useUi((s) => s.switcherOpen)
  const tabs = useUi((s) => s.tabs)
  const sessions = useUi((s) => s.sessions)
  const quick = useUi((s) => s.quick)
  const [value, setValue] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => { if (open) setQuery('') }, [open])
  const set = useUi.getState().set

  const pick = (v: string, split: boolean) => {
    set({ switcherOpen: false })
    const [kind, id] = v.split(':') as [string, string]
    if (kind === 'open') {
      const tab = useUi.getState().tabs.find((t) => t.tabId === id)
      const s = tab && sessionById(useUi.getState(), tab.sessionId)
      if (split && s) openInSplit(s)
      else if (tab) useUi.getState().activate(tab.tabId)
    } else {
      const s = useUi.getState().sessions.find((x) => x.id === id)
      if (s) (split ? openInSplit : focusOrOpen)(s)
    }
  }

  return (
    <CommandSurface
      open={open}
      onOpenChange={(o) => set({ switcherOpen: o })}
      title="Go to session or host"
      description="Search open sessions and saved hosts"
      onCloseAutoFocus={(e) => {
        // Focus goes to the terminal we switched to, not back to the one we came from.
        e.preventDefault()
        requestAnimationFrame(() => {
          const id = useUi.getState().activeTabId
          if (id) terminals.get(id)?.focus()
        })
      }}
    >
          <Command
            loop
            value={value}
            onValueChange={setValue}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.altKey && value) {
                e.preventDefault()
                pick(value, true)
              }
            }}
          >
            <CommandInputRow icon={<Search />}>
              <Command.Input value={query} onValueChange={setQuery} autoFocus placeholder="Go to session or host…" className={commandInput} />
            </CommandInputRow>
            <Command.List className="max-h-[min(440px,60vh)] overflow-auto p-1">
              <Command.Empty><EmptyState icon={<Search />} title="No session or host matches." body={query ? 'Try a device name or address.' : 'Save a device to open it here.'} action={<Button size="sm" onClick={() => query ? setQuery('') : set({ switcherOpen: false, editing: { open: true } })}>{query ? 'Clear search' : 'Add a device'}</Button>} /></Command.Empty>
              {tabs.length > 0 && (
                <Command.Group heading="Open sessions" className={group}>
                  {tabs.map((t) => (
                    <OpenRow key={t.tabId} tab={t} session={sessionById({ sessions, quick }, t.sessionId)} onPick={(v) => pick(v, false)} />
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Hosts" className={group}>
                {sessions.map((s) => (
                  <Command.Item
                    key={s.id}
                    value={`host:${s.id}`}
                    keywords={[s.name, s.host, s.username, s.platform]}
                    onSelect={() => pick(`host:${s.id}`, false)}
                    className={row}
                  >
                    <Server />
                    <span className="truncate text-fg">{s.name}</span>
                    <Secondary s={s} />
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
            <CommandFooter hints={[['Enter', 'go to'], ['Alt+Enter', 'open in split'], ['Ctrl+Tab', 'recent tabs']]} />
          </Command>
    </CommandSurface>
  )
}
