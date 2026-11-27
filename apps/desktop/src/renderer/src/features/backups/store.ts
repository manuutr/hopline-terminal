import { toast } from '../../lib/notify'
import { create } from 'zustand'
import type { BackupResult } from '@shared/backups'
import { sentence } from '../../lib/sentence'

type View = 'history' | 'schedules'

interface BackupsUi {
  open: boolean
  view: View
  sessionId: string | null
  /** Bumped by `backups:changed` (a version saved, a schedule ran): lists reload. */
  rev: number
  /** "Schedule backups…" from a folder: the schedules view adds or shows a schedule for this target. */
  scheduleFor: { kind: 'folder' | 'tag'; target: string } | null
  set: (p: Partial<Omit<BackupsUi, 'set'>>) => void
}

/** The backups dialog has its own small store, so it stays out of the app-wide one. */
export const useBackups = create<BackupsUi>((set) => ({ open: false, view: 'history', sessionId: null, rev: 0, scheduleFor: null, set: (p) => set(p) }))

export function openBackups(sessionId?: string | null, view: View = 'history', scheduleFor: BackupsUi['scheduleFor'] = null): void {
  useBackups.getState().set({ open: true, view, scheduleFor, ...(sessionId !== undefined && sessionId !== null ? { sessionId } : {}) })
}

let wired = false
export function wireBackups(): void {
  if (wired) return
  wired = true
  window.hopline.backups.onChanged(() => useBackups.setState((s) => ({ rev: s.rev + 1 })))
}

/** One toast for a run over one or many sessions. */
export function reportBackups(results: BackupResult[]): void {
  const n = (o: BackupResult['outcome']) => results.filter((r) => r.outcome === o).length
  const failed = results.filter((r) => r.outcome === 'failed' || r.outcome === 'skipped')
  if (results.length === 1) {
    const r = results[0]!
    if (r.outcome === 'saved') toast.success(`Backed up ${r.sessionName}`, { description: 'New version saved (encrypted)' })
    else if (r.outcome === 'unchanged') toast.success(`${r.sessionName}: no changes`, { description: 'Same as the last version, nothing new stored' })
    else
      toast.error(`${r.sessionName}: backup ${r.outcome === 'skipped' ? 'skipped' : 'failed'}`, {
        description: sentence(r.reason),
        // Only the user can say the device was renamed (rather than the tab showing another device).
        ...(r.renamed ? { duration: 20_000, action: { label: `Device renamed: accept ${r.renamed.to}`, onClick: () => void acceptRename(r.sessionId, r.renamed!.to) } } : {})
      })
    return
  }
  const parts = [`${n('saved')} saved`, `${n('unchanged')} unchanged`, failed.length ? `${failed.length} not backed up` : ''].filter(Boolean).join(' · ')
  ;(failed.length ? toast.warning : toast.success)(`Backed up ${results.length} sessions`, {
    description: parts + (failed.length ? `\n${failed.slice(0, 4).map((r) => `${r.sessionName}: ${r.reason ?? ''}`).join('\n')}` : '')
  })
}

/** The user confirmed the device was renamed: back it up accepting the new name (main audits it). */
export async function acceptRename(sessionId: string, hostname: string): Promise<BackupResult | undefined> {
  try {
    const r = await window.hopline.backups.acceptRename(sessionId, hostname)
    reportBackups([r])
    return r
  } catch (e) {
    toast.error('Backup failed', { description: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e) })
    return undefined
  }
}

/** Back up sessions now (from the tree, the palette or the dialog). */
export async function backupNow(sessionIds: string[]): Promise<BackupResult[]> {
  if (!sessionIds.length) return []
  const id = toast.loading(sessionIds.length === 1 ? 'Backing up the running config…' : `Backing up ${sessionIds.length} sessions…`)
  try {
    const r = await window.hopline.backups.take(sessionIds)
    toast.dismiss(id)
    reportBackups(r)
    return r
  } catch (e) {
    toast.dismiss(id)
    toast.error('Backup failed', { description: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e) })
    return []
  }
}
