import { create } from 'zustand'
import type { SerialLines } from '@shared/types'
import { toast } from '../../lib/notify'
import { activeTab, sessionById, useUi } from '../../store'

/**
 * Serial tabs' modem-control lines (DTR, RTS, BREAK) as the session host reports them after a
 * connect, a change or a BREAK. The status bar shows them; the palette toggles them. The state is
 * the port's, never assumed: a change the port refused leaves the old value and says why.
 */
export const useSerialLines = create<{ byTab: Record<string, SerialLines> }>(() => ({ byTab: {} }))

let wired = false
export function wireSerialLines(): void {
  if (wired) return
  wired = true
  window.hopline.term.onSignals((tabId, lines) => {
    if (lines.error) toast.error(lines.error)
    useSerialLines.setState((s) => ({ byTab: { ...s.byTab, [tabId]: lines } }))
  })
}

/** The focused tab when it is a connected serial console, with its lines. */
export function activeSerial(): { tabId: string; lines: SerialLines } | null {
  const s = useUi.getState()
  const tab = activeTab(s)
  if (!tab || tab.state !== 'connected') return null
  if (sessionById(s, tab.sessionId)?.protocol !== 'serial') return null
  const lines = useSerialLines.getState().byTab[tab.tabId]
  return lines ? { tabId: tab.tabId, lines } : null
}

export function toggleLine(tabId: string, line: 'dtr' | 'rts'): void {
  const cur = useSerialLines.getState().byTab[tabId]
  if (!cur || cur.brk) return
  window.hopline.term.setSignals(tabId, { [line]: !cur[line] })
}
