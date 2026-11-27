import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { toast } from '../../lib/notify'
import { Button, Dialog, Input, Label } from '@/design'
import { useUi } from '@/store'

const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e))

/**
 * The OS keychain sealed the data key but won't unseal it now (keyring locked or reset, daemon
 * gone). Nothing was deleted: the user can try again, or start over with a master password, which
 * loses every stored secret. Shown once per broken state; closing it leaves the vault locked.
 */
export function KeychainBrokenDialog(): React.JSX.Element | null {
  const vault = useUi((s) => s.vault)
  const [open, setOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = useRef(false)
  const broken = !!vault?.keychainBroken
  useEffect(() => {
    if (broken && !shown.current) setOpen(true)
    shown.current = broken
    if (!broken) setOpen(false)
  }, [broken])
  if (!vault || !broken) return null

  const close = () => {
    setOpen(false)
    setResetting(false)
    setPw('')
    setAgain('')
    setError(null)
  }
  const run = async (fn: () => Promise<Awaited<ReturnType<typeof window.hopline.vault.status>>>, ok: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const info = await fn()
      useUi.getState().set({ vault: info })
      if (!info.keychainBroken) {
        toast.success(ok)
        close()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const valid = pw.length >= 8 && pw === again
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="The OS keychain is not answering"
      className="w-[min(560px,94vw)]"
      footer={
        resetting ? (
          <>
            <Button variant="ghost" onClick={() => setResetting(false)}>
              Back
            </Button>
            <Button variant="danger" disabled={!valid || busy} onClick={() => void run(() => window.hopline.vault.resetToMaster(pw), 'Master password set')}>
              Start over with this password
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setResetting(true)}>
              Switch to master password…
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void run(() => window.hopline.vault.retryKeychain(), 'Keychain unlocked')}>
              {busy ? 'Trying…' : 'Try again'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p>
            Your saved passwords and keys are sealed by the OS keychain ({vault.backend}), which can't unseal them right now. Nothing has been deleted: sessions
            still work and ask for passwords. Unlock your keyring (or log in again), then try again.
          </p>
        </div>
        {resetting && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid) void run(() => window.hopline.vault.resetToMaster(pw), 'Master password set')
            }}
          >
            <p className="text-danger">
              Starting over loses everything the keychain protects: saved passwords, private keys and passphrases, the API key, the NetBox token, the sync
              passphrase and saved terminal history. Sessions, folders, settings and known hosts are kept.
            </p>
            <div className="space-y-1">
              <Label htmlFor="kb-new">New master password</Label>
              <Input id="kb-new" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
              {pw.length > 0 && pw.length < 8 && <p className="text-2xs text-fg-subtle">At least 8 characters.</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="kb-again">Repeat it</Label>
              <Input id="kb-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </div>
            <button type="submit" hidden />
          </form>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
