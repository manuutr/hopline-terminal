import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from '../../lib/notify'
import { Button, EmptyState, cn, CommandFooter, CommandInputRow, CommandSurface, commandInput, commandRow } from '../../design'
import { findInBuffers, resolveHit, type FindHit } from '../../lib/findall'
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'

export const openFindAll = (): void => void window.dispatchEvent(new Event('hopline:find-all'))

/** Search the scrollback of every open terminal; Enter or click jumps to the line. */
export function FindAll(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sel, setSel] = useState(0)
  const tabs = useUi((s) => s.tabs)
  useEffect(() => {
    const on = () => setOpen(true)
    window.addEventListener('hopline:find-all', on)
    return () => window.removeEventListener('hopline:find-all', on)
  }, [])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 120)
    return () => clearTimeout(t)
  }, [q])
  const hits = useMemo(
    () => (open ? findInBuffers([...terminals].map(([tabId, h]) => ({ tabId, term: h.term })), debounced.trim()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debounced, open]
  )
  useEffect(() => setSel(0), [debounced])
  const title = (id: string) => tabs.find((t) => t.tabId === id)?.title ?? 'tab'

  const go = (h: FindHit) => {
    setOpen(false)
    useUi.getState().activate(h.tabId)
    const handle = terminals.get(h.tabId)
    if (!handle) return
    setTimeout(() => {
      // Resolve now, not at search time: new output may have trimmed the scrollback since.
      const at = resolveHit(handle.term.buffer.active, h)
      if (at) {
        handle.term.scrollToLine(Math.max(0, at.row - Math.floor(handle.term.rows / 2)))
        handle.term.select(at.col, at.row, at.length)
      } else toast('That match is no longer in the scrollback')
      handle.focus()
    }, 30)
  }

  const groups = useMemo(() => {
    const m = new Map<string, FindHit[]>()
    for (const h of hits) m.set(h.tabId, [...(m.get(h.tabId) ?? []), h])
    return [...m]
  }, [hits])

  return (
    <CommandSurface open={open} onOpenChange={setOpen} title="Find in all tabs" description="Search the scrollback of every open terminal">
      <CommandInputRow icon={<Search />}>
        <input
          autoFocus
          spellCheck={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(hits.length - 1, s + 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)))
            else if (e.key === 'Enter' && hits[sel]) go(hits[sel]!)
          }}
          placeholder="Text to find in every open terminal (an IP, a MAC, %LINEPROTO)"
          className={cn(commandInput, 'font-mono placeholder:font-sans')}
          aria-label="Find in all tabs"
          aria-controls="find-all-results"
        />
      </CommandInputRow>
      {debounced.trim() && hits.length === 0 && <EmptyState icon={<Search />} title={'No matches in ' + terminals.size + ' open terminal' + (terminals.size === 1 ? '.' : 's.')} body="Try a shorter phrase from the output." action={<Button size="sm" onClick={() => setQ('')}>Clear search</Button>} />}
      {!debounced.trim() && (
        <p className="px-3.5 py-3 text-sm text-fg-subtle">
          {terminals.size ? `Type to search ${terminals.size} open terminal${terminals.size === 1 ? '' : 's'}.` : 'No terminals open. Connect to a session first, then search them all from here.'}
        </p>
      )}
      <div id="find-all-results" className="min-h-0 flex-1 overflow-auto p-1 empty:hidden" role="listbox" aria-label="Matches">
        {groups.map(([tabId, list]) => (
          <div key={tabId} role="group" aria-label={title(tabId)} className="px-1 py-1">
            <div className="flex items-baseline gap-1.5 px-2 pb-1 pt-2 text-2xs font-medium text-fg-subtle">
              {title(tabId)} <span className="normal-case tracking-normal tabular-nums">· {list.length}{list.length >= 200 ? '+' : ''}</span>
            </div>
            {list.map((h) => {
              const i = hits.indexOf(h)
              return (
                <button
                  key={`${h.line}`}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => go(h)}
                  className={cn(commandRow, 'w-full text-left font-mono text-xs')}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {h.text.slice(0, h.start)}
                    <mark className="rounded-sm bg-accent-soft text-fg ring-1 ring-accent/40">{h.text.slice(h.start, h.end)}</mark>
                    {h.text.slice(h.end)}
                  </span>
                  {/* P2-13: where the match is. */}
                  <span className="shrink-0 pl-2 font-sans text-2xs tabular-nums text-fg-subtle">line {(h.line + 1).toLocaleString()}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <CommandFooter hints={[['Enter', 'jump to line'], ['↑', 'previous'], ['↓', 'next'], ['Esc', 'close']]} />
    </CommandSurface>
  )
}
