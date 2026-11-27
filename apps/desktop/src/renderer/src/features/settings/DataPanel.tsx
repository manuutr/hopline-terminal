import { useEffect, useState } from 'react'
import { Download, FolderSync, History, Import, Network, RefreshCw, Upload } from 'lucide-react'
import { toast } from '../../lib/notify'
import type { ImportFile, ImportPreview, SyncStatus } from '@shared/types'
import { Badge, Button, Dialog, Input, Label } from '../../design'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { askConfirm } from '../../lib/confirm'
import { fmtWhen } from '../../lib/when'
import { openBackups } from '../backups/store'
import { openImport, refreshNetBoxSource, resyncNetBox, useImport } from '../import/store'
import { errorText, Row, Section, Toggle } from './parts'

const when = (t: number | null) => (t ? fmtWhen(t) : 'never')
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Show the import summary (manual import or a newer folder-sync file). */
export const reviewImport = (p: ImportPreview): void => void window.dispatchEvent(new CustomEvent('hopline:import-review', { detail: p }))

/** Settings → Sync & export (D3): encrypted export/import, folder sync, and the way to device config backups. */
export function DataPanel(): React.JSX.Element {
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [secrets, setSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<ImportFile | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  useEffect(() => {
    void window.hopline.sync.status().then(setSync)
    return window.hopline.sync.onStatus(setSync)
  }, [])

  const exportNow = async () => {
    setBusy(true)
    try {
      const r = await window.hopline.data.exportFile({ passphrase: pass, includeSecrets: secrets })
      if (!r) return
      setPass('')
      setPass2('')
      toast.success('Exported', { description: `${plural(r.counts.sessions, 'session')}, ${plural(r.counts.credentials, 'profile')}${r.counts.secrets ? ` (${r.counts.secrets} with secrets)` : ''} → ${r.file}` })
    } catch (e) {
      notifyError('Export failed', e)
    } finally {
      setBusy(false)
    }
  }

  const pick = async () => {
    try {
      const f = await window.hopline.data.pickImport()
      if (f) setFile(f)
    } catch (e) {
      notifyError('Cannot import that file', e)
    }
  }

  const passOk = pass.length >= 8 && pass === pass2
  return (
    <div>
      <Section title="Device configs">
        <Row k="configBackups" label="Config backups" hint="Running-config history per device, diffs and schedules. Not part of this export.">
          <Button
            onClick={() => {
              useUi.getState().set({ settingsOpen: false })
              openBackups(undefined, 'history')
            }}
          >
            <History /> Config backups…
          </Button>
        </Row>
      </Section>
      <Section title="Export">
        <Row k="exportFile" essential label="Passphrase" hint="Keep this passphrase. You need it to open the export.">
          <div className="grid grid-cols-2 gap-2">
            <Input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" aria-label="Export passphrase" />
            <Input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="Repeat" aria-label="Repeat export passphrase" />
          </div>
          {pass2.length > 0 && pass !== pass2 && <div className="mt-1 text-2xs text-danger">The passphrases don't match.</div>}
        </Row>
        <Row essential label="Include secrets" hint="Includes saved passwords and keys in the encrypted file. API keys stay on this machine.">
          <Toggle label="Include secrets" checked={secrets} onChange={setSecrets} />
        </Row>
        <Row label="File" hint="Folders, sessions, credential profiles, settings and known hosts.">
          <Button disabled={!passOk || busy} onClick={() => void exportNow()}>
            <Download /> Export…
          </Button>
        </Row>
      </Section>
      <Section title="Import">
        <Row k="importFile" label="From a file" hint="Shows what will change before anything is written.">
          <Button onClick={() => void pick()}>
            <Upload /> Import…
          </Button>
        </Row>
      </Section>
      <Section title="Folder sync">
        <SyncSection sync={sync} />
      </Section>
      <Section title="Sessions from other tools">
        <Row k="importSessions" label="Other tools" hint="SecureCRT, MobaXterm, PuTTY, ssh_config or a CSV. You review every session first; passwords are never imported.">
          <Button onClick={() => openImport()}>
            <Import /> Import sessions…
          </Button>
        </Row>
        <NetBoxRow />
      </Section>
      <ImportPassphraseDialog file={file} onClose={() => setFile(null)} />
    </div>
  )
}

function NetBoxRow(): React.JSX.Element {
  const nb = useImport((s) => s.netbox)
  const busy = useImport((s) => s.resyncing)
  useEffect(() => void refreshNetBoxSource(), [])
  const forget = async () => {
    if (!(await askConfirm('Forget the NetBox source?', 'The saved URL, filter and API token are deleted. Imported sessions stay; a later import from NetBox starts fresh.', 'Forget'))) return
    try {
      await window.hopline.importer.forgetNetBox()
      await refreshNetBoxSource()
    } catch (e) {
      notifyError('Could not forget the NetBox source', e)
    }
  }
  if (!nb)
    return (
      <Row k="netbox" label="NetBox / Nautobot" hint="Pull devices from your source of truth, then re-sync whenever it changes.">
        <Button onClick={() => openImport({ source: 'netbox' })}>
          <Network /> Connect…
        </Button>
      </Row>
    )
  return (
    <Row k="netbox" label={nb.flavor === 'nautobot' ? 'Nautobot' : 'NetBox'} hint={nb.hasToken ? 'Token saved in your vault.' : 'No token saved: enter one to re-sync.'}>
      <div className="break-all font-mono text-xs text-fg-muted" data-netbox-source>
        {nb.url}
        {nb.filter ? `?${nb.filter}` : ''}
      </div>
      <div className="mt-1 text-2xs text-fg-subtle">Last synced {when(nb.lastSyncAt)}</div>
      <div className="mt-2 flex gap-2">
        <Button disabled={busy || !nb.hasToken} onClick={() => void resyncNetBox()}>
          <RefreshCw /> Re-sync from {nb.flavor === 'nautobot' ? 'Nautobot' : 'NetBox'}
        </Button>
        <Button variant="ghost" onClick={() => openImport({ source: 'netbox' })}>
          Edit…
        </Button>
        <Button variant="ghost" onClick={() => void forget()}>
          Forget
        </Button>
      </div>
    </Row>
  )
}

function SyncSection({ sync }: { sync: SyncStatus | null }): React.JSX.Element {
  const [dir, setDir] = useState<{ dirToken: string; dir: string } | null>(null)
  const [pass, setPass] = useState('')
  const [secrets, setSecrets] = useState(false)
  if (!sync) return <></>
  const enable = async () => {
    if (!dir) return
    try {
      const s = await window.hopline.sync.enable({ dirToken: dir.dirToken, passphrase: pass, includeSecrets: secrets })
      setPass('')
      if (s.enabled) {
        setDir(null)
        toast.success('Folder sync on', { description: s.incoming ? 'A sync file is already there: review it to import.' : s.file ?? '' })
      }
    } catch (e) {
      notifyError('Could not turn on folder sync', e)
    }
  }
  const review = async () => {
    try {
      reviewImport(await window.hopline.sync.previewIncoming())
    } catch (e) {
      notifyError('Cannot read the sync file', e)
    }
  }
  if (!sync.enabled)
    return (
      <>
        <p className="py-2 text-xs text-fg-subtle">
          Pick a folder that another tool syncs (Dropbox, OneDrive, a Git checkout). Hopline Terminal writes an encrypted export there after every change and offers to import a newer one
          written by another machine. There is no Hopline Terminal cloud.
        </p>
        <Row k="folderSync" label="Folder">
          <div className="flex items-center gap-2">
            <Button onClick={() => void window.hopline.sync.pickDir().then((d) => d && setDir(d))}>
              <FolderSync /> Choose folder…
            </Button>
            {dir && (
              <span className="min-w-0 truncate font-mono text-xs text-fg-muted" title={dir.dir}>
                {dir.dir}
              </span>
            )}
          </div>
        </Row>
        {dir && (
          <>
            <Row label="Sync passphrase" hint="Use the same one on every machine. Stored in your vault so writes happen unattended.">
              <Input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" aria-label="Sync passphrase" />
            </Row>
            <Row essential label="Include secrets">
              <Toggle label="Sync secrets" checked={secrets} onChange={setSecrets} />
            </Row>
            <Row label="">
              <Button variant="primary" disabled={pass.length < 8} onClick={() => void enable()}>
                Turn on folder sync
              </Button>
            </Row>
          </>
        )}
      </>
    )
  return (
    <>
      <Row k="folderSync" label="Sync file" hint={sync.includeSecrets ? 'Secrets included.' : 'Without secrets.'}>
        <div className="break-all font-mono text-xs text-fg-muted">{sync.file}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
          <span>Written {when(sync.lastWriteAt)}</span>
          <span>· Imported {when(sync.lastImportAt)}</span>
          {sync.paused && <Badge tone="warn">waiting for unlock</Badge>}
          {sync.error && <Badge tone="danger">{sync.error}</Badge>}
        </div>
      </Row>
      {sync.incoming && (
        <Row essential label="Newer file" hint={`Written elsewhere ${fmtWhen(sync.incoming.mtime)}. It is not overwritten until you import it.`}>
          <Button variant="primary" onClick={() => void review()}>
            Review and import…
          </Button>
        </Row>
      )}
      <Row label="">
        <div className="flex gap-2">
          <Button onClick={() => void window.hopline.sync.syncNow().catch((e) => notifyError('Sync failed', e))}>
            <RefreshCw /> {sync.incoming ? 'Overwrite with this machine' : 'Write now'}
          </Button>
          <Button variant="ghost" onClick={() => void window.hopline.sync.disable()}>
            Turn off
          </Button>
        </div>
      </Row>
    </>
  )
}

function ImportPassphraseDialog({ file, onClose }: { file: ImportFile | null; onClose: () => void }): React.JSX.Element {
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPass('')
    setError(null)
  }, [file])
  const cancel = () => {
    if (file) void window.hopline.data.cancelImport(file.token)
    onClose()
  }
  const open = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const p = await window.hopline.data.previewImport(file.token, pass)
      setPass('')
      onClose()
      reviewImport(p)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!file}
      onOpenChange={(o) => !o && cancel()}
      title="Import Hopline Terminal data"
      description={file ? `${file.file} · exported ${fmtWhen(file.createdAt)}` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!pass || busy} onClick={() => void open()}>
            {busy ? 'Decrypting…' : 'Continue'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault()
          void open()
        }}
      >
        <Label htmlFor="import-pass">Passphrase</Label>
        <Input id="import-pass" type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
        {error && (
          <p role="alert" className="pt-1 text-xs text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Summary before an import writes anything: counts, conflicts, merge or replace. */
export function ImportReviewDialog(): React.JSX.Element {
  const [p, setP] = useState<ImportPreview | null>(null)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const on = (e: Event) => {
      setMode('merge')
      setP((e as CustomEvent<ImportPreview>).detail)
    }
    window.addEventListener('hopline:import-review', on)
    return () => window.removeEventListener('hopline:import-review', on)
  }, [])
  const cancel = () => {
    if (p) void window.hopline.data.cancelImport(p.token)
    setP(null)
  }
  const apply = async () => {
    if (!p) return
    setBusy(true)
    try {
      const r = await window.hopline.data.applyImport(p.token, mode)
      setP(null)
      await useUi.getState().load()
      toast.success(mode === 'merge' ? 'Imported (merged)' : 'Imported (replaced)', {
        description: `${plural(r.sessions, 'session')}, ${plural(r.credentials, 'profile')}, ${plural(r.knownHosts, 'host key')} added${r.hostKeyConflicts ? `; ${r.hostKeyConflicts} differing host key(s) left unchanged` : ''}${r.retargeted ? `; credentials removed from ${plural(r.retargeted, 'retargeted session')}` : ''}${r.deleted ? `; ${r.deleted} deleted elsewhere` : ''}`
      })
    } catch (e) {
      notifyError('Import failed', e)
    } finally {
      setBusy(false)
    }
  }
  const c = p?.counts
  return (
    <Dialog
      open={!!p}
      onOpenChange={(o) => !o && cancel()}
      title="Review import"
      description={p ? `${p.file} · exported ${fmtWhen(p.exportedAt)}` : ''}
      className="w-[min(600px,94vw)]"
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant={mode === 'replace' ? 'danger' : 'primary'} disabled={busy} onClick={() => void apply()}>
            {mode === 'merge' ? 'Merge' : 'Replace everything'}
          </Button>
        </>
      }
    >
      {p && c && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs" aria-label="Import summary">
            <dt className="text-fg-subtle">Folders</dt>
            <dd>{c.folders}</dd>
            <dt className="text-fg-subtle">Sessions</dt>
            <dd>{c.sessions}</dd>
            <dt className="text-fg-subtle">Credential profiles</dt>
            <dd>
              {c.credentials} {p.includesSecrets ? <Badge tone="warn">{c.secrets} with secrets</Badge> : <Badge>no secrets</Badge>}
            </dd>
            <dt className="text-fg-subtle">Known hosts</dt>
            <dd>{c.knownHosts}</dd>
            <dt className="text-fg-subtle">Settings</dt>
            <dd>
              {p.settingsApplied.length ? `appearance: ${p.settingsApplied.join(', ')}` : 'none'}
              {p.settingsIgnored.length > 0 && <span className="block text-fg-subtle">Not imported (security or machine settings): {p.settingsIgnored.slice(0, 8).join(', ')}</span>}
            </dd>
          </dl>
          {(p.retargeted.length > 0 || p.credentialAttached.length > 0 || p.hostKeysWithheld > 0 || p.deletions.length > 0) && (
            <div className="space-y-1 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs" aria-label="Security review">
              {p.retargeted.length > 0 && (
                <div>
                  <p className="font-medium text-warn">Retargeted (credentials removed)</p>
                  <ul className="list-disc pl-4">
                    {p.retargeted.slice(0, 10).map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  {p.retargeted.length > 10 && <p>…and {p.retargeted.length - 10} more.</p>}
                  <p className="text-fg-subtle">The file points these sessions somewhere else. Their saved credential is detached; attach it again if you trust the change.</p>
                </div>
              )}
              {p.credentialAttached.length > 0 && (
                <p>
                  Not linked to a credential saved here: {p.credentialAttached.slice(0, 5).join('; ')}
                  {p.credentialAttached.length > 5 ? '…' : ''}. An imported file can't attach your stored passwords; check the host, then pick the credential in the session.
                </p>
              )}
              {p.hostKeysWithheld > 0 && (
                <p>
                  {plural(p.hostKeysWithheld, 'host key')} for hosts this file adds or retargets {p.hostKeysWithheld === 1 ? 'is' : 'are'} not imported: you will be asked to check
                  {p.hostKeysWithheld === 1 ? ' it' : ' them'} on first connect.
                </p>
              )}
              {p.deletions.length > 0 && (
                <p>
                  Deleted on the other machine, removed here too: {p.deletions.slice(0, 5).join(', ')}
                  {p.deletions.length > 5 ? '…' : ''}
                </p>
              )}
            </div>
          )}
          {(p.updates.sessions > 0 || p.updates.credentials > 0 || p.updates.folders > 0 || p.duplicates.length > 0 || p.hostKeyConflicts.length > 0) && (
            <div className="space-y-1 rounded-lg border border-line bg-surface p-3 text-xs" aria-label="Conflicts">
              {p.updates.sessions + p.updates.credentials + p.updates.folders > 0 && (
                <p>
                  Already here (same id): {plural(p.updates.sessions, 'session')}, {plural(p.updates.credentials, 'profile')}, {plural(p.updates.folders, 'folder')}. Merge updates them from the file.
                </p>
              )}
              {p.duplicates.length > 0 && (
                <p>
                  Same name and host as a local session: {p.duplicates.slice(0, 5).join(', ')}
                  {p.duplicates.length > 5 ? '…' : ''}. Merge adds them as separate sessions.
                </p>
              )}
              {p.hostKeyConflicts.length > 0 && (
                <p className="text-warn">
                  Different host key than the one trusted here: {p.hostKeyConflicts.slice(0, 5).map((h) => `${h.host}:${h.port}`).join(', ')}
                  {p.hostKeyConflicts.length > 5 ? '…' : ''}. Merge keeps the local key.
                </p>
              )}
            </div>
          )}
          <div className="space-y-2" role="radiogroup" aria-label="Import mode">
            <label className="flex items-start gap-2">
              <input type="radio" name="import-mode" className="mt-1 accent-[var(--c-accent)]" checked={mode === 'merge'} onChange={() => setMode('merge')} />
              <span>
                Merge
                <span className="block text-xs text-fg-subtle">Add what is new and update matching items. Nothing here is deleted; saved secrets are kept when the file has none.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="import-mode" className="mt-1 accent-[var(--c-accent)]" checked={mode === 'replace'} onChange={() => setMode('replace')} />
              <span>
                Replace
                <span className="block text-xs text-fg-subtle">
                  Make this machine match the file. Deletes {plural(p.localOnly.sessions, 'session')}, {plural(p.localOnly.credentials, 'profile')}, {plural(p.localOnly.folders, 'folder')} and{' '}
                  {plural(p.localOnly.knownHosts, 'host key')} that are not in it.
                </span>
              </span>
            </label>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** A newer folder-sync file appeared: offer it (once per file). */
export function wireSync(): () => void {
  let shown: number | null = null
  return window.hopline.sync.onStatus((s) => {
    if (!s.incoming || s.incoming.mtime === shown) return
    shown = s.incoming.mtime
    toast('A newer Hopline Terminal sync file is available', {
      description: s.file ?? undefined,
      duration: 30_000,
      action: {
        label: 'Review',
        onClick: () => void window.hopline.sync.previewIncoming().then(reviewImport, (e) => notifyError('Cannot read the sync file', e))
      }
    })
  })
}
