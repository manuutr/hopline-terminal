import { Waypoints } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { activeWorkspace, useUi } from '../../store'
import { panes } from '../../lib/layout'
import { isRunning, useFleet } from './store'

/** The saved sessions shown in the active workspace (its split panes), else the active tab's. */
function selectedSessions(): string[] {
  const ui = useUi.getState()
  const ws = activeWorkspace(ui)
  const tabIds = ws ? panes(ws.root).flatMap((p) => (p.tabId ? [p.tabId] : [])) : ui.activeTabId ? [ui.activeTabId] : []
  const ids = tabIds.map((id) => ui.tabs.find((t) => t.tabId === id)?.sessionId).filter((x): x is string => !!x && ui.sessions.some((s) => s.id === x))
  return [...new Set(ids)]
}

let installed = false
export function installFleetActions(): void {
  if (installed) return
  installed = true
  registerActions([
    {
      id: 'fleet.investigate',
      title: () => (isRunning(useFleet.getState()) ? 'Fleet run in progress…' : 'Investigate across devices…'),
      category: 'Assistant',
      icon: Waypoints,
      keywords: 'fleet agent global multi device debug investigate coordinator workers lanes bgp ospf',
      run: () => {
        const picked = selectedSessions()
        useFleet.getState().show(picked.length ? { sessions: picked } : undefined)
      }
    }
  ])
}
