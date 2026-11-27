import { create } from 'zustand'
import type { CrashStatus, UpdateStatus } from '@shared/privacy'
import { useUi } from '../../store'

/** Update and crash-report status from main (Phase 7). */
interface PrivacyState {
  update: UpdateStatus | null
  crash: CrashStatus | null
  load: () => Promise<void>
  refreshCrash: () => Promise<void>
}

export const usePrivacy = create<PrivacyState>((set) => ({
  update: null,
  crash: null,
  load: async () => {
    const [update, crash] = await Promise.all([window.hopline.updates.status(), window.hopline.crash.status()])
    set({ update, crash })
  },
  refreshCrash: async () => set({ crash: await window.hopline.crash.status() })
}))

/** Subscribe to main's update status and forward renderer errors (only while the user opted in). */
export function wirePrivacy(): () => void {
  const off = window.hopline.updates.onStatus((update) => usePrivacy.setState({ update }))
  void usePrivacy.getState().load()
  const optedIn = () => !!useUi.getState().settings?.crashReports
  const onError = (e: ErrorEvent) => {
    if (!optedIn()) return
    const err = e.error instanceof Error ? e.error : null
    void window.hopline.crash.report({ name: err?.name ?? 'Error', message: String(err?.message ?? e.message ?? '').slice(0, 4000), stack: String(err?.stack ?? '').slice(0, 16_000), kind: 'exception' }).catch(() => {})
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!optedIn()) return
    const r = e.reason
    const err = r instanceof Error ? r : null
    void window.hopline.crash.report({ name: err?.name ?? 'UnhandledRejection', message: String(err?.message ?? r ?? '').slice(0, 4000), stack: String(err?.stack ?? '').slice(0, 16_000), kind: 'rejection' }).catch(() => {})
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    off()
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

/** A render error caught by the ErrorBoundary. */
export function reportRenderError(error: Error): void {
  if (!useUi.getState().settings?.crashReports) return
  void window.hopline.crash.report({ name: error.name, message: error.message.slice(0, 4000), stack: String(error.stack ?? '').slice(0, 16_000), kind: 'render' }).catch(() => {})
}
