import { FileClock, Network, Send } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { activeWorkspace, useUi } from '../../store'
import { panes } from '../../lib/layout'
import { isMac } from '../../lib/keys'
import { useMulti } from './store'

/**
 * Run on many devices: Ctrl+Shift+M on Windows/Linux, ⌘⇧M on macOS, where ⌘M stays the
 * standard Window → Minimize (the app menu's role).
 */
export const multiRunKeys = (mac = isMac): string[] => [mac ? 'Mod+Shift+M' : 'Mod+M']

/** The tabs shown in the active workspace (its split panes), else the active tab: the "selection". */
function selectedTabs(): string[] {
  const ui = useUi.getState()
  const ws = activeWorkspace(ui)
  const ids = ws ? panes(ws.root).flatMap((p) => (p.tabId ? [p.tabId] : [])) : []
  return ids.length ? ids : ui.activeTabId ? [ui.activeTabId] : []
}

let installed = false
export function installMultiActions(): void {
  if (installed) return
  installed = true
  registerActions([
    {
      id: 'multi.run',
      title: 'Run on many devices…',
      category: 'Automation',
      icon: Network,
      keywords: 'multi device parallel show compare diff fleet',
      keys: multiRunKeys(),
      run: () => useMulti.getState().show('run', selectedTabs().length ? { tabs: selectedTabs() } : undefined)
    },
    {
      id: 'multi.lastResults',
      title: 'Reopen last multi-device results',
      category: 'Automation',
      icon: FileClock,
      keywords: 'previous last run report incident ticket evidence',
      when: () => !useMulti.getState().open && useMulti.getState().step === 'results',
      run: () => useMulti.setState({ open: true })
    },
    {
      id: 'multi.send',
      title: 'Send to many devices…',
      category: 'Automation',
      icon: Send,
      keywords: 'send to all broadcast multi config several',
      run: () => useMulti.getState().show('send', selectedTabs().length ? { tabs: selectedTabs() } : undefined)
    }
  ])
}
