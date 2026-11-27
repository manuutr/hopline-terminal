import { create } from 'zustand'
import { scrubTerminalText } from '../../lib/command-evidence'
import { selectionWholeLines } from '../../lib/selection-lines'
import { terminals } from '../../lib/terminals'
import { toast } from '../../lib/notify'
import { activeTab, useUi } from '../../store'

export const NOTE_LIMIT = 256 * 1024
export const useWorkspaceTools = create<{ panel: 'overview' | 'scratchpad' | null; note: string }>(() => ({ panel: null, note: '' }))
export const showOverview = () => useWorkspaceTools.setState({ panel: 'overview' })
export const showScratchpad = () => useWorkspaceTools.setState({ panel: 'scratchpad' })

export function appendTerminalSelection(tabId?: string): void {
  const ui = useUi.getState()
  const tab = tabId ? ui.tabs.find((t) => t.tabId === tabId) : activeTab(ui)
  const term = tab && terminals.get(tab.tabId)?.term
  if (!tab || !term?.hasSelection()) return
  const section = scrubTerminalText(tab.title + '\n' + selectionWholeLines(term)).trimEnd()
  const current = useWorkspaceTools.getState().note
  const note = current ? current + '\n\n' + section : section
  if (note.length > NOTE_LIMIT) {
    toast.error('The selection exceeds the remaining scratchpad space')
    return
  }
  useWorkspaceTools.setState({ panel: 'scratchpad', note })
}
