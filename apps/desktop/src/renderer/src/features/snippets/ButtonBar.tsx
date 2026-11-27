import { ContextMenu } from 'radix-ui'
import { Pencil, Play, Plus, SlidersHorizontal, TextCursorInput, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, cn, Tooltip } from '../../design'
import { useUi } from '../../store'
import { applySnippet, guardHint, sessionOfTab, snippetsFor, useSnippets, type GuardHint } from './store'

const menuItem = 'flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-fg-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg [&_svg]:size-3.5'

const HINT: Partial<Record<GuardHint, { dot: string; text: string }>> = {
  config: { dot: 'bg-warn', text: 'Configuration change: asks you first' },
  disruptive: { dot: 'bg-danger', text: 'Disruptive: needs the hostname typed' },
  blocked: { dot: 'bg-danger', text: 'Blocked by the guard: it will not run' }
}

/** The empty end of the bar, as a drop target ("place last"). */
const END = '\0end'

/**
 * The button bar: a slim row under the tabs with the snippets marked "on the button bar" that
 * apply to the focused session (scope and platform). Click runs or inserts; drag to reorder (drop
 * on the empty end to place a button last); right-click to edit or remove. A dot marks what the
 * guard will ask for: amber for configuration, red for disruptive. Shown or hidden with the palette
 * action "Show/Hide the button bar"; it appears on its own once a snippet is on the bar.
 */
export function ButtonBar(): React.JSX.Element | null {
  const { list, barVisible, loaded } = useSnippets()
  const activeTabId = useUi((s) => s.activeTabId)
  useUi((s) => s.tabs)
  useUi((s) => s.folders)
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null)
  useEffect(() => {
    if (!loaded) void useSnippets.getState().load().catch(() => {})
  }, [loaded])
  const onBar = list.filter((s) => s.onBar)
  // Optional: shown once there is a button, unless the user turned it off (or on, to set it up).
  if (!(barVisible ?? onBar.length > 0)) return null
  const usable = new Set(snippetsFor(activeTabId, onBar).map((s) => s.id))
  // Buttons for the focused session; with no session, all of them (inactive) so the bar can be arranged.
  const shown = activeTabId ? onBar.filter((s) => usable.has(s.id)) : onBar
  const platform = sessionOfTab(activeTabId)?.platform
  /** Drop the dragged button before `target`, or last for END. */
  const drop = (target: string) => {
    if (!drag || drag.id === target) return setDrag(null)
    const ids = onBar.map((s) => s.id).filter((id) => id !== drag.id)
    const at = target === END ? -1 : ids.indexOf(target)
    ids.splice(at < 0 ? ids.length : at, 0, drag.id)
    setDrag(null)
    void useSnippets.getState().reorder([...ids, ...list.filter((s) => !s.onBar).map((s) => s.id)])
  }
  const over = (id: string) => (e: React.DragEvent) => {
    if (!drag) return
    e.preventDefault()
    if (drag.over !== id) setDrag({ ...drag, over: id })
  }
  const onDrop = (id: string) => (e: React.DragEvent) => {
    e.preventDefault()
    drop(id)
  }
  return (
    <div role="toolbar" aria-label="Button bar" className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface px-2">
      {shown.length === 0 && (
        <span className="px-1 text-2xs text-fg-subtle">{onBar.length ? 'No buttons for this session’s scope or platform.' : 'Button bar: snippets you run often, one click away.'}</span>
      )}
      {shown.map((s) => {
        const kind = guardHint(s, platform)
        const hint = kind ? HINT[kind] : undefined
        const what = `${s.mode === 'run' ? 'Run' : 'Insert'}: ${s.body.split('\n')[0]}${s.body.includes('\n') ? ' …' : ''}`
        return (
          <ContextMenu.Root key={s.id}>
            <Tooltip label={!activeTabId ? 'Open a session to use it' : hint ? `${what} · ${hint.text}` : what}>
              <ContextMenu.Trigger asChild>
                <button
                  type="button"
                  draggable
                  data-snippet={s.id}
                  data-guard={kind ?? undefined}
                  // aria-disabled, not disabled: a disabled button can be neither dragged nor right-clicked.
                  aria-disabled={!activeTabId || undefined}
                  onClick={() => {
                    if (activeTabId) void applySnippet(s)
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/x-hopline-snippet', s.id)
                    setDrag({ id: s.id, over: null })
                  }}
                  onDragOver={over(s.id)}
                  onDragEnd={() => setDrag(null)}
                  onDrop={onDrop(s.id)}
                  className={cn(
                    'relative flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-fg-muted transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:bg-hover hover:text-fg active:translate-y-px aria-disabled:text-fg-subtle [&_svg]:size-3',
                    drag?.id === s.id && 'opacity-50',
                    drag?.over === s.id && drag.id !== s.id && 'before:absolute before:-left-[3px] before:inset-y-0.5 before:w-0.5 before:rounded-full before:bg-accent'
                  )}
                >
                  {s.mode === 'run' ? <Play className="text-accent" /> : <TextCursorInput className="text-fg-subtle" />}
                  {s.name}
                  {hint && <span role="img" aria-label={hint.text} className={cn('size-1.5 shrink-0 rounded-full', hint.dot)} />}
                </button>
              </ContextMenu.Trigger>
            </Tooltip>
            <ContextMenu.Portal>
              <ContextMenu.Content className="z-50 min-w-40 rounded-md bg-overlay p-1 shadow-overlay animate-fade-in">
                <ContextMenu.Item className={menuItem} onSelect={() => useSnippets.setState({ editor: { open: true, id: s.id } })}>
                  <Pencil /> Edit…
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItem} onSelect={() => void useSnippets.getState().save({ id: s.id, name: s.name, body: s.body, mode: s.mode, scope: s.scope, platforms: s.platforms, onBar: false })}>
                  <EyeOff /> Remove from bar
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )
      })}
      {shown.length > 0 && (
        <div
          data-testid="bar-end"
          aria-hidden
          onDragOver={over(END)}
          onDrop={onDrop(END)}
          className={cn('relative h-6 min-w-6 flex-1', drag?.over === END && 'before:absolute before:left-0 before:inset-y-0.5 before:w-0.5 before:rounded-full before:bg-accent')}
        />
      )}
      <div className={cn('flex shrink-0 items-center gap-0.5 pl-2', shown.length === 0 && 'ml-auto')}>
        <Tooltip label="New button">
          <Button variant="ghost" size="icon-sm" aria-label="New button" onClick={() => useSnippets.setState({ editor: { open: true, id: 'new', draft: { onBar: true } } })}>
            <Plus />
          </Button>
        </Tooltip>
        <Tooltip label="Snippets…">
          <Button variant="ghost" size="icon-sm" aria-label="Manage snippets" onClick={() => useSnippets.setState({ editor: { open: true, id: list[0]?.id ?? 'new' } })}>
            <SlidersHorizontal />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}
