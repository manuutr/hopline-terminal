import { toast } from '../../lib/notify'
import { create } from 'zustand'
import type { NetBoxSource, SessionImportOutcome, SessionImportPlan, SessionImportSource } from '@shared/types'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'

interface ImportState {
  open: boolean
  step: 'source' | 'preview'
  source: SessionImportSource
  plan: SessionImportPlan | null
  /** Target folder to preselect when the wizard was opened from a folder. */
  initialTarget: string | null
  /** The saved NetBox source (re-sync), or null. */
  netbox: NetBoxSource | null
  /** A NetBox re-sync is being fetched outside the wizard (palette command). */
  resyncing: boolean
}

export const useImport = create<ImportState>(() => ({
  open: false,
  step: 'source',
  source: 'securecrt',
  plan: null,
  initialTarget: null,
  netbox: null,
  resyncing: false
}))

export async function refreshNetBoxSource(): Promise<void> {
  try {
    useImport.setState({ netbox: await window.hopline.importer.netBoxSource() })
  } catch {
    /* not fatal: re-sync just isn't offered */
  }
}

/** "Import sessions…": open the wizard at the source step, optionally into a folder. */
export function openImport(opts: { source?: SessionImportSource; targetFolderId?: string | null } = {}): void {
  // Settings is a dialog too: never stack two.
  useUi.getState().set({ settingsOpen: false, paletteOpen: false })
  const s = useImport.getState()
  useImport.setState({ open: true, step: 'source', plan: null, source: opts.source ?? s.source, initialTarget: opts.targetFolderId ?? null })
  void refreshNetBoxSource()
}

/** Show a plan in the wizard's review step. A folder chosen up front is applied by re-planning. */
export async function showPlan(plan: SessionImportPlan): Promise<void> {
  const target = useImport.getState().initialTarget
  let p = plan
  if (target && !plan.resync && plan.options.targetFolderId !== target) {
    p = await window.hopline.importer.plan(plan.token, { targetFolderId: target, keepFolders: plan.options.keepFolders })
  }
  useImport.setState({ open: true, step: 'preview', plan: p, source: p.source })
}

export function closeImport(): void {
  const { plan } = useImport.getState()
  if (plan) void window.hopline.importer.cancel(plan.token).catch(() => {})
  useImport.setState({ open: false, plan: null, step: 'source', initialTarget: null })
}

/** "Re-sync from NetBox": fetch with the saved source and open the review step on the diff. */
export async function resyncNetBox(): Promise<void> {
  useUi.getState().set({ settingsOpen: false, paletteOpen: false })
  if (useImport.getState().resyncing) return
  useImport.setState({ resyncing: true })
  const t = toast.loading('Fetching devices from NetBox…')
  try {
    const plan = await window.hopline.importer.resyncNetBox()
    toast.dismiss(t)
    useImport.setState({ initialTarget: null })
    await showPlan(plan)
  } catch (e) {
    toast.dismiss(t)
    notifyError('Re-sync failed', e)
  } finally {
    useImport.setState({ resyncing: false })
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The result toast: "Imported 42 sessions into 7 folders". */
export function announce(out: SessionImportOutcome, source?: SessionImportPlan['source']): void {
  const parts: string[] = []
  let title: string
  if (out.created > 0) {
    title = `Imported ${plural(out.created, 'session')}${out.folders ? ` into ${plural(out.folders, 'folder')}` : ''}`
    if (out.updated) parts.push(`${out.updated} updated`)
  } else if (out.updated > 0) title = `Updated ${plural(out.updated, 'session')}`
  else if (out.removed > 0) title = `Removed ${plural(out.removed, 'session')}`
  else title = source === 'netbox' ? 'NetBox source saved: everything is in sync' : 'Nothing to import'
  if (out.removed && (out.created || out.updated)) parts.push(`${out.removed} removed`)
  if (out.newFolders) parts.push(`${plural(out.newFolders, 'new folder')}`)
  if (out.skippedJumps) parts.push(`${plural(out.skippedJumps, 'jump host')} not set`)
  toast.success(title, { description: parts.join(' · ') || undefined })
}
