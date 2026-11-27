import { create } from 'zustand'
import type { SessionVitals } from '@shared/types'
import type { IMarker, Terminal } from '@xterm/xterm'

interface SessionSignal { vitals?: SessionVitals; alert?: { count: number; marker: IMarker; label: string } }
export const useSignals = create<Record<string, SessionSignal>>(() => ({}))
export function wireVitals() {
  return window.hopline.term.onVitals((id, vitals) => useSignals.setState((s) => ({ [id]: { ...s[id], vitals } })))
}

export function dropSignals(id: string) {
  useSignals.setState((s) => {
    const { [id]: closed, ...remaining } = s
    closed?.alert?.marker.dispose()
    return remaining
  }, true)
}

const urgent = /%[A-Z][A-Z0-9_]*(?:-[A-Z][A-Z0-9_]*)?-[0-3]-[A-Z0-9_]+/

/** Write through xterm so the marker follows scrollback trimming, wraps and reflow. */
export function writeWithAlerts(term: Terminal, id: string, data: string) {
  if (!urgent.test(data)) return term.write(data)
  let start = 0
  for (const match of data.matchAll(new RegExp(urgent.source, 'g'))) {
    if (match.index < start) continue
    const newline = data.indexOf('\n', match.index)
    const end = newline < 0 ? data.length : newline + 1
    term.write(data.slice(start, end), () => {
      if (term.buffer.active.type !== 'normal' || !term.element?.isConnected) return
      const marker = term.registerMarker(newline < 0 ? 0 : -1)
      if (!marker) return
      const decoration = term.registerDecoration({ marker, width: term.cols, layer: 'top' })
      decoration?.onRender((el) => el.classList.add('syslog-sweep'))
      const previous = useSignals.getState()[id]?.alert
      useSignals.setState((s) => ({ [id]: { ...s[id], alert: { marker, count: (previous?.count ?? 0) + 1, label: match[0] } } }))
      // Retain only the newest jump target and its decoration.
      previous?.marker.dispose()
    })
    start = end
  }
  if (start < data.length) term.write(data.slice(start))
}

export function elapsed(ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return sec < 60 ? sec + 's' : sec < 3600 ? Math.floor(sec / 60) + 'm' : Math.floor(sec / 3600) + 'h ' + Math.floor(sec % 3600 / 60) + 'm'
}
