import { useState } from 'react'
import { Button, Dialog, Input } from '../../design'
import { errorText } from '../../lib/errors'
import { toast } from '../../lib/notify'
import { useUi } from '../../store'

export function ReplacePasswordsDialog({ close }: { close(): void }): React.JSX.Element {
  const profiles = useUi((s) => s.credentials).filter((c) => c.kind === 'password')
  const vault = useUi((s) => s.vault)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = profiles.filter((p) => selected.has(p.id))
  const sessions = chosen.reduce((sum, p) => sum + p.usedBy, 0)
  const mismatch = !!confirm && confirm !== password
  const valid = chosen.length > 0 && chosen.length <= 200 && !!password && password === confirm && !vault?.locked
  const apply = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError('')
    try {
      const count = await window.hopline.credentials.replacePasswords(chosen.map((p) => p.id), password)
      setPassword('')
      setConfirm('')
      toast(`Updated ${count} saved password ${count === 1 ? 'profile' : 'profiles'}`)
      close()
      void useUi.getState().load()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) close() }} title="Update saved passwords"
      description="After a password changes on a device or identity provider, update the profiles Hopline Terminal uses for its next sign-in."
      footer={<><Button onClick={close} disabled={busy}>Cancel</Button><Button variant="primary" disabled={!valid || busy} onClick={() => void apply()}>Update {chosen.length} {chosen.length === 1 ? 'profile' : 'profiles'}</Button></>}>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span>Password profiles</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(selected.size ? new Set() : new Set(profiles.slice(0, 200).map((p) => p.id)))}>{selected.size ? 'Clear selection' : profiles.length > 200 ? 'Select first 200' : 'Select all'}</Button>
        </div>
        <div className="max-h-40 overflow-y-auto rounded border border-line">
          {profiles.map((p) => <label key={p.id} className="flex min-h-8 items-center gap-2 px-2 text-sm hover:bg-hover">
            <input className="accent-[var(--c-accent)]" type="checkbox" checked={selected.has(p.id)} onChange={(e) => {
              const next = new Set(selected)
              if (e.target.checked) next.add(p.id)
              else next.delete(p.id)
              setSelected(next)
            }} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span><span className="truncate text-xs text-fg-muted">{p.username}</span>
          </label>)}
        </div>
        <p className="text-xs text-fg-muted">{chosen.length} profiles selected · {sessions} linked {sessions === 1 ? 'session' : 'sessions'}</p>
        <label className="block text-xs text-fg-muted">New password<Input className="mt-1" type="password" autoComplete="new-password" value={password} maxLength={65536} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="block text-xs text-fg-muted">Confirm new password<Input className="mt-1" type="password" autoComplete="new-password" value={confirm} aria-invalid={mismatch || undefined} onChange={(e) => setConfirm(e.target.value)} /></label>
        {mismatch && <p className="text-xs text-warn">The passwords do not match.</p>}
        {chosen.length > 200 && <p className="text-xs text-warn">Choose up to 200 profiles at a time.</p>}
        {vault?.locked && <p className="text-xs text-warn">Unlock the vault to update passwords.</p>}
        {vault?.mode === 'session' && <p className="text-xs text-warn">This vault keeps passwords until Hopline Terminal exits.</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </fieldset>
    </Dialog>
  )
}
