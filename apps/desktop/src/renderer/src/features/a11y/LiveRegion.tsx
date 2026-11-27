import { useEffect, useRef } from 'react'
import { toast } from '../../lib/notify'
import { useUi } from '../../store'

/**
 * The app's one polite live region for terminal output (screen reader mode). Mounted with the
 * shell, before any output, so assistive technology already watches it. xterm's own live region
 * (assertive, unthrottled) is silenced by TerminalView; announcements come only from here.
 */
let region: HTMLDivElement | null = null

/**
 * Speak `text`. Only the latest announcement is kept (the region's content): no history of
 * terminal output builds up in the renderer.
 */
export function announce(text: string): void {
  if (!region || !text) return
  // Replace the content: a polite region reads the new text when the reader is idle.
  region.textContent = text
}

/** Empty the region: terminal output does not stay in the DOM once the mode is off. */
export function clearAnnouncer(): void {
  if (region) region.textContent = ''
}

export function LiveRegion(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    region = ref.current
    // Turned off from anywhere (Settings' Save too): the last output read out leaves the DOM.
    const unsub = useUi.subscribe((st, prev) => {
      if (prev.settings?.termScreenReader && !st.settings?.termScreenReader) clearAnnouncer()
    })
    return () => {
      unsub()
      region = null
    }
  }, [])
  return <div ref={ref} data-testid="sr-announcer" aria-live="polite" aria-atomic="true" className="sr-only" />
}

/** Turn screen reader mode on or off (saved at once, like the theme). */
export async function setScreenReaderMode(on: boolean): Promise<void> {
  const next = await window.hopline.settings.update({ termScreenReader: on, a11yOfferAnswered: true })
  useUi.getState().setSettings(next)
  clearAnnouncer()
  announce(on ? 'Screen reader mode on' : 'Screen reader mode off')
}

/**
 * When the OS reports a screen reader and the mode is off, offer it once (never switched on
 * silently). The answer is remembered; Settings → Terminal changes it later.
 */
export function useScreenReaderOffer(): void {
  useEffect(() => {
    let offered = false
    const offer = (active: boolean) => {
      const s = useUi.getState().settings
      if (!active || offered || !s || s.termScreenReader || s.a11yOfferAnswered) return
      offered = true
      toast('Screen reader detected', {
        id: 'a11y-offer',
        description: 'Turn on screen reader mode? Terminal output is read out as it arrives, and Mod+Alt+B opens the output as plain text.',
        duration: Infinity,
        action: { label: 'Turn on', onClick: () => void setScreenReaderMode(true) },
        cancel: {
          label: 'Not now',
          onClick: () => void window.hopline.settings.update({ a11yOfferAnswered: true }).then((n) => useUi.getState().setSettings(n))
        }
      })
    }
    const check = () => void window.hopline.a11y.screenReader().then(offer).catch(() => {})
    // Settings arrive after the shell mounts: check once they are there.
    if (useUi.getState().settings) check()
    const unsub = useUi.subscribe((st, prev) => {
      if (st.settings && !prev.settings) check()
    })
    const off = window.hopline.a11y.onScreenReader(offer)
    return () => {
      unsub()
      off()
    }
  }, [])
}
