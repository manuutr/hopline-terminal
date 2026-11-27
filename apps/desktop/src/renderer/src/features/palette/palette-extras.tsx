import { Command } from 'cmdk'
import { Archive, Braces, Network, Play, Plus, Send, TextCursorInput, Waypoints } from 'lucide-react'
import { useEffect } from 'react'
import { commandGroup, commandRow } from '../../design'
import { useUi } from '../../store'
import { applySnippet, snippetsFor, useSnippets } from '../snippets/store'
import { useMulti } from '../multi/store'
import { useFleet } from '../fleet/store'
import { backupNow } from '../backups/store'
import type { PaletteGroup } from './CommandPalette'

/** `!` snippets in the palette: the ones that apply to the focused session. */
export function PaletteSnippets({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { list, loaded } = useSnippets()
  const tabId = useUi((s) => s.activeTabId)
  useEffect(() => {
    if (!loaded) void useSnippets.getState().load().catch(() => {})
  }, [loaded])
  const usable = snippetsFor(tabId, list)
  return (
    <Command.Group heading={tabId ? 'Snippets for this session' : 'Snippets'} className={commandGroup}>
      {!tabId && (
        <Command.Item value="__help snippets need a tab" disabled className={commandRow}>
          <Braces /> Open a session to run a snippet on it
        </Command.Item>
      )}
      {usable.map((s) => (
        <Command.Item
          key={s.id}
          value={`snippet ${s.name} ${s.body} ${s.id}`}
          onSelect={() => {
            onDone()
            void applySnippet(s, tabId)
          }}
          className={commandRow}
        >
          {s.mode === 'run' ? <Play /> : <TextCursorInput />}
          <span className="flex-1 truncate">{s.name}</span>
          <span className="max-w-[45%] truncate font-mono text-2xs text-fg-subtle">{s.body.split('\n')[0]}</span>
        </Command.Item>
      ))}
      <Command.Item
        value="__help new snippet"
        onSelect={() => {
          onDone()
          useSnippets.setState({ editor: { open: true, id: 'new' } })
        }}
        className={commandRow}
      >
        <Plus /> <span className="flex-1">New snippet…</span>
      </Command.Item>
    </Command.Group>
  )
}

/** What a picked tag or folder offers besides its sessions. */
export function PaletteGroupActions({ group, onDone }: { group: PaletteGroup; onDone: () => void }): React.JSX.Element | null {
  if (!group.sessions.length) return null
  const targets = group.kind === 'tag' ? { tags: [group.id] } : { folders: [group.id] }
  const go = (mode: 'run' | 'send') => () => {
    onDone()
    useMulti.getState().show(mode, targets)
  }
  return (
    <Command.Group heading={group.name} className={commandGroup}>
      <Command.Item value={`__help run on ${group.name}`} onSelect={go('run')} className={commandRow}>
        <Network /> <span className="flex-1">Run a show command on these {group.sessions.length}…</span>
      </Command.Item>
      <Command.Item value={`__help send to ${group.name}`} onSelect={go('send')} className={commandRow}>
        <Send /> <span className="flex-1">Send commands to these {group.sessions.length}…</span>
      </Command.Item>
      <Command.Item
        value={`__help investigate ${group.name}`}
        onSelect={() => {
          onDone()
          useFleet.getState().show(group.kind === 'tag' ? { tags: [group.id] } : { folders: [group.id] })
        }}
        className={commandRow}
      >
        <Waypoints /> <span className="flex-1">Investigate across these {group.sessions.length}…</span>
      </Command.Item>
      <Command.Item
        value={`__help back up ${group.name}`}
        onSelect={() => {
          onDone()
          void backupNow(group.sessions.map((s) => s.id))
        }}
        className={commandRow}
      >
        <Archive /> <span className="flex-1">Back up these {group.sessions.length}</span>
      </Command.Item>
    </Command.Group>
  )
}
