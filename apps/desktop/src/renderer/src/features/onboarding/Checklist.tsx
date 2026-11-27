import { useEffect, useRef } from 'react'
import { Check, X } from 'lucide-react'
import type { ChecklistItem } from '@shared/ux'
import { Button, cn, Kbd } from '../../design'
import { useShortcutMap } from '../../lib/actions'
import { Row } from '../settings/parts'
import { checklistProgress, useOnboarding } from './store'

const ITEMS: { id: ChecklistItem; label: string; how: (sc: (id: string) => string | undefined) => React.ReactNode }[] = [
  { id: 'connect', label: 'Connect to a device', how: () => 'Double-click a saved session to connect' },
  { id: 'palette', label: 'Try the command palette', how: (sc) => <Kbd keys={sc('palette.open') ?? 'Mod+K'} /> },
  { id: 'assistant', label: 'Ask the assistant', how: (sc) => <>Type <span className="font-mono">@ai</span> at a prompt, or <Kbd keys={sc('ai.toggle') ?? 'Mod+I'} /></> },
  { id: 'multi', label: 'Run on many devices', how: () => 'Select sessions, then Run on many devices… from the palette' }
]

/**
 * "Getting started": four things worth knowing, at the foot of the session sidebar. One quiet line
 * until opened; ticks itself as the user does each thing; closes for good with ×, and comes back only
 * from the palette ("Show getting started") or Settings → Appearance. It never pops up by itself.
 */
export function Checklist(): React.JSX.Element | null {
  const { state, loaded, expanded, dismiss } = useOnboarding()
  const sc = useShortcutMap()
  const { done, total } = checklistProgress(state)
  const previous = useRef(done)
  useEffect(() => {
    const completed = loaded && previous.current < total && done === total
    previous.current = done
    if (completed) {
      const timer = setTimeout(dismiss, 1200)
      return () => clearTimeout(timer)
    }
  }, [done, total, loaded, dismiss])
  if (!loaded || !state.stepsDone || state.checklistDismissed) return null
  return (
    <section aria-label="Getting started" data-checklist className={cn('@container/checklist m-2 shrink-0 rounded-lg border border-line bg-raised px-1.5 py-1.5', done === total && 'animate-evidence-in')}>
      <div className="flex h-6 items-center gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => useOnboarding.setState({ expanded: !expanded })}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-xs text-fg-muted hover:text-fg"
        >
          <svg aria-hidden className="hidden size-5 shrink-0 @min-[175px]/checklist:block" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--c-line-strong)" strokeWidth="2" /><circle cx="12" cy="12" r="9" fill="none" stroke="var(--c-accent)" strokeWidth="2" strokeLinecap="round" pathLength="100" strokeDasharray={done / total * 100 + ' 100'} transform="rotate(-90 12 12)" /></svg>
          {/* Fits whole at the narrowest sidebar (180 px; review P2: "Getting start…"). */}
          <span className="truncate">Getting started</span>
          <span className="ml-1 shrink-0 text-2xs tabular-nums text-fg-subtle">
            {done}/{total}
          </span>
        </button>
        <button type="button" aria-label="Close getting started" title="Close (reopen from the palette)" onClick={dismiss} className="flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg">
          <X className="size-3.5" />
        </button>
      </div>
      {expanded && (
        <ul className="mt-0.5 flex flex-col pb-1">
          {ITEMS.map((it) => {
            const ok = !!state.done[it.id]
            return (
              <li key={it.id} data-item={it.id} data-done={ok || undefined} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-1.5 px-1 py-1">
                <span className={cn('mt-0.5 flex size-3.5 items-center justify-center rounded-full border', ok ? 'border-transparent bg-accent text-accent-fg' : 'border-line-input')} aria-hidden>
                  {ok && <Check className="size-2.5" />}
                </span>
                <div className="min-w-0">
                  <div className={cn('text-xs', ok ? 'text-fg-subtle line-through decoration-fg-subtle/50' : 'text-fg')}>
                    {it.label}
                    <span className="sr-only">{ok ? ' (done)' : ''}</span>
                  </div>
                  {!ok && <div className="text-2xs text-fg-subtle">{it.how(sc)}</div>}
                </div>
              </li>
            )
          })}
          {done === total && <li className="px-1 pt-1 text-2xs text-fg-subtle">Getting started complete.</li>}
        </ul>
      )}
    </section>
  )
}

/** Settings → Appearance: bring the checklist back. */
export function GettingStartedRow(): React.JSX.Element {
  const { state } = useOnboarding()
  return (
    <Row k="gettingStarted" label="Sidebar checklist" hint="Review the getting started checklist in the session sidebar.">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => useOnboarding.getState().reopen()} disabled={!state.checklistDismissed && state.stepsDone}>
          Show checklist
        </Button>
        {!state.checklistDismissed && state.stepsDone && <span className="text-2xs text-fg-subtle">Shown</span>}
      </div>
    </Row>
  )
}
