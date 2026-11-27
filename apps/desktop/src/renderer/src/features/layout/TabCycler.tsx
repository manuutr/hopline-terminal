import { useEffect, useRef, useState } from 'react'
import { cn } from '../../design'
import { modalOpen } from '../../lib/keys'
import { sessionById, useUi, type Workspace } from '../../store'
import { StatusGlyph, useWorkspaceSummary } from './StatusGlyph'

/** The overlay only appears if Ctrl is held this long; a quick tap just flips to the previous tab. */
const SHOW_AFTER_MS = 150

function Row({ ws, selected }: { ws: Workspace; selected: boolean }): React.JSX.Element {
  const { title, glyph, focused } = useWorkspaceSummary(ws)
  const session = useUi((s) => sessionById(s, focused?.sessionId))
  return (
    <div
      role="option"
      aria-selected={selected}
      className={cn('flex h-7 items-center gap-2.5 rounded px-2 text-sm', selected ? 'bg-active text-fg' : 'text-fg-muted')}
    >
      <span className="flex w-7 shrink-0 justify-center">{glyph && <StatusGlyph glyph={glyph} tooltip={false} />}</span>
      <span className="truncate">{title}</span>
      {session && (
        <span className="ml-auto truncate font-mono text-2xs text-fg-subtle">
          {session.username ? `${session.username}@` : ''}
          {session.host}
        </span>
      )}
    </div>
  )
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab: hold Ctrl and press Tab to walk the tabs in most-recently-used order;
 * releasing Ctrl commits. Ctrl+Tab is not a device key, so it is captured even in the terminal.
 */
export function TabCycler(): React.JSX.Element | null {
  const [view, setView] = useState<{ list: string[]; index: number; shown: boolean } | null>(null)
  const cyc = useRef<{ list: string[]; index: number; shown: boolean; timer: number } | null>(null)

  useEffect(() => {
    const sync = () => setView(cyc.current ? { list: cyc.current.list, index: cyc.current.index, shown: cyc.current.shown } : null)
    const end = (commit: boolean) => {
      const c = cyc.current
      if (!c) return
      clearTimeout(c.timer)
      cyc.current = null
      if (commit) useUi.getState().activateWs(c.list[c.index]!)
      sync()
    }
    const down = (e: KeyboardEvent) => {
      if (cyc.current && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return end(false)
      }
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return
      // Never switch tabs behind a modal dialog (host-key prompt, confirmation, palette).
      if (!cyc.current && modalOpen()) return
      e.preventDefault()
      e.stopPropagation()
      const step = e.shiftKey ? -1 : 1
      const c = cyc.current
      if (c) {
        c.index = (c.index + step + c.list.length) % c.list.length
        c.shown = true
        clearTimeout(c.timer)
        return sync()
      }
      const s = useUi.getState()
      const ids = s.workspaces.map((w) => w.id)
      const list = [...s.mru.filter((id) => ids.includes(id)), ...ids.filter((id) => !s.mru.includes(id))]
      if (list.length < 2) return
      const next = { list, index: (step + list.length) % list.length, shown: false, timer: 0 }
      next.timer = window.setTimeout(() => {
        if (cyc.current !== next) return
        next.shown = true
        sync()
      }, SHOW_AFTER_MS)
      cyc.current = next
      sync()
    }
    const up = (e: KeyboardEvent) => {
      if (cyc.current && (e.key === 'Control' || !e.ctrlKey)) end(true)
    }
    const blur = () => end(false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const workspaces = useUi((s) => s.workspaces)
  if (!view?.shown) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex justify-center pt-[12vh]">
      <div
        role="listbox"
        aria-label="Switch tab"
        className="h-fit w-[360px] max-w-[calc(100vw-32px)] animate-pop-in data-[state=closed]:animate-fade-out rounded-lg bg-overlay p-1 shadow-overlay"
        data-tab-cycler=""
      >
        <div className="px-2 pb-1 pt-1.5 text-2xs font-medium text-fg-subtle">Recent tabs</div>
        <div className="max-h-[18rem] overflow-hidden">
          {view.list.map((id, i) => {
            const ws = workspaces.find((w) => w.id === id)
            return ws ? <Row key={id} ws={ws} selected={i === view.index} /> : null
          })}
        </div>
      </div>
    </div>
  )
}
