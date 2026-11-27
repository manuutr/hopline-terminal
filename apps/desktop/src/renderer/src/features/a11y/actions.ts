import { Accessibility, FileText, PanelsTopLeft } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'
import { openBufferView } from './BufferView'
import { setScreenReaderMode } from './LiveRegion'

let installed = false

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The window's regions in F6 order, each with where the keyboard lands in it. The terminal keeps
 * Tab for the device (command completion), so F6 / Shift+F6 is how the keyboard leaves it and
 * comes back, as in VS Code and browsers.
 */
const REGIONS: { name: string; root: () => Element | null; target: (root: Element) => HTMLElement | null }[] = [
  { name: 'Window toolbar', root: () => document.querySelector('[data-titlebar]'), target: (r) => r.querySelector<HTMLElement>('button[aria-controls=sidebar]') },
  { name: 'Open connections', root: () => document.querySelector('#sidebar aside:not([inert]) [data-open-connections]'), target: (r) => r.querySelector<HTMLElement>('[role=tab][aria-selected=true]') },
  { name: 'Sessions', root: () => document.querySelector('#sidebar aside:not([inert]) [data-saved-sessions]'), target: (r) => r.querySelector<HTMLElement>('#session-search') ?? r.querySelector<HTMLElement>(FOCUSABLE) },
  {
    name: 'Terminals',
    root: () => document.querySelector('[data-terminal-area]'),
    target: (r) =>
      r.querySelector<HTMLElement>('[data-pane-id][data-focused] .xterm-helper-textarea') ??
      r.querySelector<HTMLElement>('[data-pane-id][data-focused] [data-launcher] input') ??
      r.querySelector<HTMLElement>('.xterm-helper-textarea') ??
      r.querySelector<HTMLElement>('[data-launcher] input')
  },
  { name: 'Files', root: () => document.querySelector('[role=region][aria-label=Files]'), target: (r) => r.querySelector<HTMLElement>('[role=listbox]') ?? r.querySelector<HTMLElement>(FOCUSABLE) },
  { name: 'Assistant', root: () => document.querySelector('aside[aria-label=Assistant]:not([inert])'), target: (r) => r.querySelector<HTMLElement>('textarea') ?? r.querySelector<HTMLElement>(FOCUSABLE) }
]

/** Move the keyboard to the next (or previous) region that is open. Exported for tests. */
export function focusRegion(dir: 1 | -1): string | null {
  const live = REGIONS.map((r) => ({ ...r, el: r.root() })).filter((r): r is typeof r & { el: Element } => !!r.el && (r.el as HTMLElement).offsetWidth > 0)
  if (!live.length) return null
  const at = live.findIndex((r) => r.el.contains(document.activeElement))
  for (let k = 1; k <= live.length; k++) {
    const r = live[(((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * k) % live.length + live.length) % live.length]!
    const t = r.target(r.el)
    if (t) {
      t.focus()
      return r.name
    }
  }
  return null
}

/** Accessibility actions: the buffer view (Mod+Alt+B) and the screen reader mode switch. */
export function installA11yActions(): void {
  if (installed) return
  installed = true
  registerActions([
    {
      id: 'a11y.bufferView',
      title: 'Open terminal text (accessible buffer view)',
      category: 'Terminal',
      icon: FileText,
      keywords: 'accessibility screen reader scrollback plain text buffer read copy range',
      keys: ['Mod+Alt+B'],
      when: () => {
        const id = useUi.getState().activeTabId
        return !!id && terminals.has(id)
      },
      run: () => void openBufferView()
    },
    {
      id: 'a11y.nextRegion',
      title: 'Focus the next area (toolbar, connections, sessions, terminal, files, assistant)',
      category: 'View',
      icon: PanelsTopLeft,
      keywords: 'accessibility keyboard focus region pane sidebar move',
      keys: ['F6'],
      run: () => void focusRegion(1)
    },
    {
      id: 'a11y.prevRegion',
      title: 'Focus the previous area',
      category: 'View',
      icon: PanelsTopLeft,
      keywords: 'accessibility keyboard focus region pane sidebar move back',
      keys: ['Shift+F6'],
      run: () => void focusRegion(-1)
    },
    {
      id: 'a11y.screenReader',
      title: () => (useUi.getState().settings?.termScreenReader ? 'Turn off screen reader mode' : 'Turn on screen reader mode'),
      category: 'View',
      icon: Accessibility,
      keywords: 'accessibility screen reader nvda jaws voiceover orca announce output',
      run: () => void setScreenReaderMode(!useUi.getState().settings?.termScreenReader)
    }
  ])
}
