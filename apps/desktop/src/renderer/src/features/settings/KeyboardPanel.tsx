import { ChevronRight, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, cn, Kbd } from '../../design'
import { kbdLabel } from '../../design/Kbd'
import { allActions, bindingOwners, CATEGORY_ORDER, keysOf, setRecording, titleOf, useActionsVersion, useKeymap, type Action } from '../../lib/actions'
import { bindingProblem, comboFromEvent, findConflicts } from '../../lib/keymap'

/** Press keys to bind. Esc cancels. Reserved keys and keys already in use are refused with the reason. */
function Recorder({ action, onDone }: { action: Action; onDone: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [held, setHeld] = useState('')
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    ref.current?.focus()
    setRecording(true)
    // Window capture: before Radix's Escape handler (which would close Settings) and before any
    // app shortcut. Every key is swallowed while recording.
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement !== ref.current) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return done.current()
      const combo = comboFromEvent(e)
      if (!combo) {
        setHeld([e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean).join('+'))
        return
      }
      const problem = bindingProblem(combo, action.id, bindingOwners())
      if (problem) {
        setError(problem.includes(kbdLabel(combo)) ? problem : `${kbdLabel(combo)}: ${problem}`)
        setHeld('')
        return
      }
      // The row itself shows the new key (and "changed"): no toast.
      void useKeymap.getState().setKeys(action.id, [combo])
      done.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      setRecording(false)
    }
  }, [action])
  return (
    <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
      <div
        ref={ref}
        tabIndex={0}
        role="textbox"
        aria-label={`New shortcut for ${titleOf(action)}`}
        data-testid="key-recorder"
        onBlur={onDone}
        className="flex h-6 min-w-40 items-center justify-center rounded-md border border-accent/60 bg-accent/10 px-2 text-xs text-fg outline-none"
      >
        {held ? <Kbd keys={held} /> : 'Press the new keys… (Esc cancels)'}
      </div>
      {error && (
        <p role="alert" className="max-w-[360px] text-right text-2xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** Settings → Keyboard: every action with keys, rebindable; device keys can't be taken. */
export function KeyboardPanel(): React.JSX.Element {
  useActionsVersion()
  const overrides = useKeymap((s) => s.overrides)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const needle = q.trim().toLowerCase()
  const actions = allActions().filter((a) => !a.id.startsWith('tab.goto.') && (!needle || `${titleOf(a)} ${a.keywords ?? ''} ${keysOf(a, overrides).join(' ')}`.toLowerCase().includes(needle)))
  const conflicts = findConflicts(bindingOwners(overrides))
  return (
    <div className="space-y-3">
      {conflicts.length > 0 && (
        <div role="alert" data-testid="key-conflicts" className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-fg">
          <p className="font-medium">{conflicts.length === 1 ? 'One key does two things' : `${conflicts.length} keys do two things`}: the first action listed wins.</p>
          <ul className="mt-1 space-y-1">
            {conflicts.map((c) => (
              <li key={c.combo} className="flex items-center gap-2">
                <Kbd keys={c.combo} />
                <span className="min-w-0 flex-1 truncate text-fg-muted">{c.owners.map((o) => o.title).join(' · ')}</span>
                {c.owners.some((o) => overrides[o.id]) && (
                  <Button size="sm" variant="ghost" onClick={() => void Promise.all(c.owners.filter((o) => overrides[o.id]).map((o) => useKeymap.getState().setKeys(o.id, undefined)))}>
                    Reset mine
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-fg-muted">
        Select a shortcut to change its keys.
      </p>
      <div className="flex items-center gap-2">
        <label className="flex h-7 flex-1 items-center gap-2 rounded-md border border-line-input bg-surface px-2.5 focus-within:border-accent/60">
          <Search className="size-3.5 text-fg-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter actions or keys" aria-label="Filter actions" className="h-full flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none" />
        </label>
        <Button
          size="md"
          variant="ghost"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => void useKeymap.getState().reset()}
        >
          <RotateCcw /> Reset all
        </Button>
      </div>
      {needle && actions.length === 0 && <p className="px-1 py-2 text-xs text-fg-subtle">No action or key matches “{q.trim()}”.</p>}
      {CATEGORY_ORDER.map((cat) => {
        const list = actions.filter((a) => a.category === cat)
        if (!list.length) return null
        return (
          <details key={cat + (needle ? '-filtered' : '')} open={!!needle || list.some((action) => !!overrides[action.id])} className="group/shortcuts">
            <summary className="flex min-h-8 cursor-default list-none items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-hover">
              <ChevronRight aria-hidden className="size-3.5 text-fg-muted group-open/shortcuts:rotate-90" />{cat}
              <span className="ml-auto text-xs tabular-nums text-fg-muted">{list.length}</span>
            </summary>
            <div className="divide-y divide-line rounded-md border border-line">
              {list.map((a) => {
                const keys = keysOf(a, overrides)
                const changed = !!overrides[a.id]
                return (
                  <div key={a.id} className="flex min-h-9 items-center gap-2 px-3 py-1.5" data-action={a.id}>
                    <span className={cn('flex-1 truncate text-sm', changed ? 'text-fg' : 'text-fg-muted')}>{titleOf(a)}</span>
                    {editing === a.id ? (
                      <Recorder action={a} onDone={() => setEditing(null)} />
                    ) : (
                      <>
                        {changed && <span className="text-2xs text-accent">changed</span>}
                        <button
                          type="button"
                          disabled={a.fixed}
                          onClick={() => setEditing(a.id)}
                          aria-label={`Change shortcut for ${titleOf(a)}`}
                          title={a.fixed ? 'This shortcut belongs to the terminal or the connection list' : 'Change'}
                          className="flex h-6 min-w-16 items-center justify-end gap-1 rounded-md px-1 hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          {keys.length ? keys.slice(0, 2).map((k) => <Kbd key={k} keys={k} />) : <span className="text-2xs text-fg-subtle">Add shortcut</span>}
                        </button>
                        {changed ? (
                          <Button size="icon-sm" variant="ghost" aria-label={`Restore default for ${titleOf(a)}`} title="Restore default" onClick={() => void useKeymap.getState().setKeys(a.id, undefined)}>
                            <RotateCcw />
                          </Button>
                        ) : keys.length && !a.fixed ? (
                          <Button size="icon-sm" variant="ghost" aria-label={`Remove shortcut for ${titleOf(a)}`} title="Remove shortcut" onClick={() => void useKeymap.getState().setKeys(a.id, [])}>
                            <X />
                          </Button>
                        ) : (
                          <span className="size-6" />
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </details>
        )
      })}
    </div>
  )
}
