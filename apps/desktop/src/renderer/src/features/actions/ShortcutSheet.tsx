import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, Dialog, Kbd } from '../../design'
import { allActions, CATEGORY_ORDER, keysOf, titleOf, useActionsVersion, useKeymap, type Action } from '../../lib/actions'
import { useUi } from '../../store'
import { openSettings } from '../../lib/settings-nav'

/** Keys Hopline never takes: they always reach the device. Shown so users trust the terminal. */
export const DEVICE_KEYS: [keys: string, what: string][] = [
  ['Ctrl+C', 'Interrupt'],
  ['Ctrl+Z', 'End configuration mode'],
  ['Ctrl+D', 'Delete / end of input'],
  ['Ctrl+R', 'Redisplay line / history search'],
  ['Ctrl+A', 'Start of line'],
  ['Ctrl+E', 'End of line'],
  ['Ctrl+P', 'Previous command'],
  ['Ctrl+N', 'Next command'],
  ['Ctrl+U', 'Clear line'],
  ['Ctrl+W', 'Delete word'],
  ['Tab', 'Complete the command'],
  ['?', 'Context help'],
  ['Ctrl+Shift+6', 'Cisco break (Ctrl+^)'],
  ['Ctrl+]', 'Telnet escape'],
  ['Alt+B', 'Word back (Esc-B)'],
  ['Alt+F', 'Word forward (Esc-F)']
]

function group(actions: Action[], q: string): [string, Action[]][] {
  const needle = q.trim().toLowerCase()
  const hit = (a: Action) => !needle || `${titleOf(a)} ${a.keywords ?? ''} ${a.category}`.toLowerCase().includes(needle)
  return CATEGORY_ORDER.map((c) => [c, actions.filter((a) => a.category === c && hit(a))] as [string, Action[]]).filter(([, l]) => l.length > 0)
}

/** Mod+/: every shortcut, from the action registry, plus the device keys Hopline leaves alone. */
export function ShortcutSheet(): React.JSX.Element {
  const open = useUi((s) => s.shortcutsOpen)
  const overrides = useKeymap((s) => s.overrides)
  useActionsVersion()
  const [q, setQ] = useState('')
  const close = () => useUi.getState().set({ shortcutsOpen: false })
  const withKeys = useMemo(() => allActions().filter((a) => keysOf(a, overrides).length > 0 && !a.id.startsWith('tab.goto.')), [overrides, open])
  const groups = group(withKeys, q)
  const needle = q.trim().toLowerCase()
  const device = DEVICE_KEYS.filter(([k, w]) => !needle || `${k} ${w}`.toLowerCase().includes(needle))
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
        setQ('')
      }}
      title="Keyboard shortcuts"
      description="Every app shortcut. Keys for the device always go to the device."
      className="w-[min(760px,94vw)]"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              close()
              openSettings('keymap')
            }}
          >
            Edit shortcuts…
          </Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <label className="mb-3 flex h-8 items-center gap-2 rounded-md border border-line-input bg-surface px-2.5 focus-within:border-accent/60">
        <Search className="size-3.5 text-fg-subtle" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter shortcuts" aria-label="Filter shortcuts" className="h-full flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none" />
      </label>
      <div className="columns-1 gap-8 sm:columns-2" data-testid="shortcut-sheet">
        {groups.map(([cat, list]) => (
          <section key={cat} className="mb-4 break-inside-avoid">
            <h3 className="mb-1 text-2xs font-medium text-fg-subtle">{cat}</h3>
            {list.map((a) => (
              // One binding per row (the first; Settings → Keyboard lists them all) and a title that
              // wraps rather than truncates: two caps beside a long title left "Show the butt…".
              <div key={a.id} className="flex min-h-7 items-center gap-3 py-1 text-sm leading-snug text-fg-muted">
                <span className="min-w-0 flex-1">{titleOf(a)}</span>
                <Kbd keys={keysOf(a, overrides)[0]!} className="shrink-0" />
              </div>
            ))}
            {cat === 'Tabs and panes' && (!needle || 'go to tab 1 9 digit'.includes(needle)) && (
              <div className="flex min-h-7 items-center gap-2 py-1 text-sm leading-snug text-fg-muted">
                <span className="min-w-0 flex-1">Go to tab 1–8, last tab</span>
                <Kbd keys="Alt+1" />
                <span className="text-2xs text-fg-subtle">…</span>
                <Kbd keys="Alt+9" />
              </div>
            )}
          </section>
        ))}
        {device.length > 0 && (
          <section className="mb-4 break-inside-avoid">
            <h3 className="mb-1 text-2xs font-medium text-fg-subtle">Always sent to the device</h3>
            {device.map(([k, w]) => (
              <div key={k} className="flex min-h-7 items-center gap-3 py-1 text-sm leading-snug text-fg-muted">
                <span className="min-w-0 flex-1">{w}</span>
                <Kbd keys={k} className="shrink-0" />
              </div>
            ))}
          </section>
        )}
      </div>
    </Dialog>
  )
}
