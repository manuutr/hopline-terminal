import { create } from 'zustand'
import { useUi } from '../../store'

export const tourStops = [
  { selector: '#session-search', title: 'Find a device', text: 'Search your saved sessions here. Double-click a device to connect. Open connections stay above the list.' },
  { selector: '[data-terminal-area]', title: 'Work in the terminal', text: 'Type commands here once connected. Select lines of output and choose Explain this output to ask about what you see.' },
  { selector: '#ai aside', title: 'Ask the assistant', text: 'Start in Workspace, even before connecting. Try “Which device should I check for a failing VPN?”' },
  { selector: '#ai [aria-label="Attach packet capture"]', title: 'Analyze a packet capture', text: 'Drop a PCAP or PCAPNG into the assistant, or choose the paperclip. Ask which frames explain the failure.' }
] as const

interface TourState {
  step: number | null
  opener: HTMLElement | null
  previous: { sidebarOpen: boolean; aiOpen: boolean } | null
}

export const useTour = create<TourState>(() => ({ step: null, previous: null, opener: null }))

export function startTour() {
  if (useTour.getState().step !== null) return
  const { sidebarOpen, aiOpen } = useUi.getState()
  useTour.setState({ step: 0, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null, previous: { sidebarOpen, aiOpen } })
  useUi.getState().set({ sidebarOpen: true, paletteOpen: false })
}

export function tourStep(step: number) {
  if (step < 0 || step >= tourStops.length) return
  if (step >= 2) useUi.getState().set({ aiOpen: true })
  useTour.setState({ step })
}

export function endTour() {
  const { previous } = useTour.getState()
  if (previous) useUi.getState().set(previous)
  useTour.setState({ step: null, previous: null })
}
