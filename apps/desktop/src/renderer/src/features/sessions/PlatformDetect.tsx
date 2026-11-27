import { PLATFORM_LABELS } from '@hopline/guard'
import { useEffect, useState } from 'react'
import { toast } from '../../lib/notify'
import { create } from 'zustand'
import type { PlatformEvent, Session, SessionPlatform } from '@shared/types'
import { Button, Dialog, SelectMenu } from '../../design'
import { notifyError } from '../../lib/connect'
import { platformGroups } from '../../lib/platforms'
import { sessionById, useUi, type Tab } from '../../store'

/**
 * F8 auto-detect in the window: progress per tab, the "Detected … · Change" toast, and the
 * "Set platform" dialog used by the toast, the status bar and the AI panel. Main does the
 * detecting (main/detect.ts); this only shows it and lets the user correct it.
 */

interface DetectState {
  /** Tabs whose device is being identified right now. */
  detecting: Record<string, true>
  /** Session whose platform the dialog is setting. */
  target: string | null
}

export const useDetect = create<DetectState>(() => ({ detecting: {}, target: null }))

export const openSetPlatform = (sessionId: string): void => useDetect.setState({ target: sessionId })

/** Replace a session in the store (saved or quick connect). */
function putSession(s: Session): void {
  const ui = useUi.getState()
  if (ui.sessions.some((x) => x.id === s.id)) useUi.setState({ sessions: ui.sessions.map((x) => (x.id === s.id ? s : x)) })
  else useUi.setState({ quick: ui.quick.map((x) => (x.id === s.id ? s : x)) })
}

export function detectedText(platform: keyof typeof PLATFORM_LABELS, version?: string): string {
  return `${PLATFORM_LABELS[platform]}${version ? ` ${version}` : ''}`
}

let wired = false
export function wirePlatformEvents(): void {
  if (wired) return
  wired = true
  window.hopline.term.onPlatform((e: PlatformEvent) => {
    useDetect.setState((s) => {
      const detecting = { ...s.detecting }
      if (e.state === 'detecting') detecting[e.tabId] = true
      else delete detecting[e.tabId]
      return { detecting }
    })
    if (e.state !== 'detected' || !e.platform) return
    const ui = useUi.getState()
    const s = sessionById(ui, e.sessionId)
    if (!s || s.platform === e.platform) return
    putSession({ ...s, platform: e.platform, detected: { version: e.version, model: e.model, confidence: 1, at: Date.now() } })
    // One toast per session, even when the session is open in several panes.
    toast.success(`Detected ${detectedText(e.platform, e.version)}`, {
      id: `detected-${e.sessionId}`,
      description: s.name,
      action: { label: 'Change', onClick: () => openSetPlatform(e.sessionId) }
    })
  })
}

/** What the window knows about a tab's platform. */
export type TabPlatform = { state: 'known'; platform: Exclude<SessionPlatform, 'auto'>; version?: string } | { state: 'detecting' } | { state: 'unknown' } | { state: 'pending' }

export function useTabPlatform(tab: Pick<Tab, 'tabId' | 'sessionId' | 'state'> | undefined): TabPlatform | undefined {
  const session = useUi((s) => (tab ? sessionById(s, tab.sessionId) : undefined))
  const detecting = useDetect((s) => (tab ? !!s.detecting[tab.tabId] : false))
  if (!tab || !session) return undefined
  if (session.platform !== 'auto') return { state: 'known', platform: session.platform, version: session.detected?.version }
  if (detecting) return { state: 'detecting' }
  // Not connected yet: detection runs on connect, so nothing is wrong (yet).
  return tab.state === 'connected' ? { state: 'unknown' } : { state: 'pending' }
}

/** For glyphs over many tabs: is this connected tab's device unidentified (and not being identified)? */
export function useUnknownPlatform(): (t: Pick<Tab, 'tabId' | 'sessionId'>) => boolean {
  const sessions = useUi((s) => s.sessions)
  const quick = useUi((s) => s.quick)
  const detecting = useDetect((s) => s.detecting)
  return (t) => !detecting[t.tabId] && sessionById({ sessions, quick }, t.sessionId)?.platform === 'auto'
}

const GROUPS = platformGroups(true)

export function SetPlatformDialog(): React.JSX.Element {
  const target = useDetect((s) => s.target)
  const session = useUi((s) => (target ? sessionById(s, target) : undefined))
  const [value, setValue] = useState<SessionPlatform>('auto')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (session) setValue(session.platform)
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => useDetect.setState({ target: null })
  const save = async () => {
    if (!session) return
    setBusy(true)
    try {
      putSession(await window.hopline.sessions.setPlatform(session.id, value))
      close()
    } catch (e) {
      notifyError('Could not set the platform', e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!session}
      onOpenChange={(o) => !o && close()}
      title="Set platform"
      description={session ? `How Hopline Terminal reads ${session.name}: prompts, the guard's command model and autocomplete. AI commands stay blocked while it is unknown.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !session || value === session.platform} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <SelectMenu aria-label="Platform" value={value} onValueChange={(v) => setValue(v as SessionPlatform)} groups={GROUPS} />
      {value === 'auto' && <p className="mt-2 text-xs text-fg-subtle">Identified the next time it connects.</p>}
    </Dialog>
  )
}
