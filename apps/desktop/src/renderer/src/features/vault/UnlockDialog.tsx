import { useEffect, useRef, useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { toast } from '../../lib/notify'
import type { VaultInfo } from '@shared/types'
import { Button, Dialog, Label, PasswordInput } from '@/design'
import { notifyError } from '@/lib/connect'
import { useUi } from '@/store'

/** Open the unlock dialog (status bar, settings, or main asking for a stored secret). */
export const openUnlock = (): void => void window.dispatchEvent(new Event('hopline:unlock'))

const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e))

/**
 * Master-password unlock. The password goes to main once per attempt and is never kept here:
 * the field is cleared on every attempt and when the dialog closes.
 */
export function UnlockDialog(): React.JSX.Element | null {
  const vault = useUi((s) => s.vault)
  const [open, setOpen] = useState(false)
  // Opened because main is waiting (a connect needs a stored secret): closing means "skip".
  const [requested, setRequested] = useState(false)
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('hopline:unlock', show)
    const off = window.hopline.vault.onUnlockRequest(() => {
      setRequested(true)
      setOpen(true)
    })
    return () => {
      window.removeEventListener('hopline:unlock', show)
      off()
    }
  }, [])
  // Locked at startup (the first state we see): ask right away. A later lock (auto-lock, "Lock
  // now") waits until something needs a secret.
  const seen = useRef(false)
  useEffect(() => {
    if (!vault) return
    if (!seen.current && vault.mode === 'master' && vault.locked) setOpen(true)
    seen.current = true
    if (!vault.locked) setOpen(false)
  }, [vault])

  if (!vault || vault.mode !== 'master') return null
  const close = () => {
    setOpen(false)
    setPw('')
    setError(null)
    if (requested) void window.hopline.vault.skipUnlock()
    setRequested(false)
  }
  const submit = async () => {
    if (!pw || busy) return
    setBusy(true)
    setError(null)
    const attempt = pw
    setPw('')
    try {
      const info = await window.hopline.vault.unlock(attempt)
      useUi.getState().set({ vault: info })
      setRequested(false)
      setOpen(false)
    } catch (e) {
      setError(errorText(e))
      setTimeout(() => input.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open && vault.locked}
      onOpenChange={(o) => !o && close()}
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        input.current?.focus()
      }}
      title="Unlock Hopline Terminal"
      description={requested ? 'A connection needs a stored password or key.' : 'Your saved passwords and keys are protected by your master password.'}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {requested ? 'Continue without' : 'Not now'}
          </Button>
          <Button variant="primary" disabled={!pw || busy} onClick={() => void submit()}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Label htmlFor="vault-unlock">Master password</Label>
        <PasswordInput id="vault-unlock" ref={input} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={!!error} />
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

/**
 * First run without an OS keyring (Linux without gnome-keyring/kwallet): choose a master password
 * or keep secrets for this session only.
 */
export function VaultSetupDialog(): React.JSX.Element | null {
  const vault = useUi((s) => s.vault)
  const [dismissed, setDismissed] = useState(false)
  if (!vault || vault.chosen || dismissed) return null
  return <MasterPasswordForm open onDone={() => setDismissed(true)} title="Protect your saved passwords" intro />
}

/** Set (or, with `change`, change) the master password. Shared by first-run setup and Settings → Security. */
export function MasterPasswordForm({ open, onDone, title, intro, change }: { open: boolean; onDone: () => void; title: string; intro?: boolean; change?: boolean }): React.JSX.Element {
  const vault = useUi((s) => s.vault)
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = () => {
    setCurrent('')
    setPw('')
    setAgain('')
    setError(null)
  }
  const done = (info?: VaultInfo) => {
    if (info) useUi.getState().set({ vault: info })
    reset()
    onDone()
  }
  const short = pw.length > 0 && pw.length < 8
  const mismatch = again.length > 0 && pw !== again
  const ok = pw.length >= 8 && pw === again && (!change || current.length > 0)
  const submit = async () => {
    if (!ok || busy) return
    setBusy(true)
    setError(null)
    try {
      const info = change
        ? await window.hopline.vault.changePassword(current, pw)
        : await window.hopline.vault.setMode({ mode: 'master', password: pw, ...(vault?.mode === 'master' ? { current } : {}) })
      toast.success(change ? 'Master password changed' : 'Master password set', { description: 'Saved passwords and keys are now protected by it.' })
      done(info)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const sessionOnly = async () => {
    try {
      done(await window.hopline.vault.setMode({ mode: 'session' }))
      toast('Session-only', { description: 'Passwords you save are kept in memory and forgotten when Hopline Terminal quits.' })
    } catch (e) {
      notifyError('Could not change the vault', e)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && done()}
      title={title}
      className="w-[min(520px,94vw)]"
      footer={
        <>
          {intro ? (
            <Button variant="ghost" onClick={() => void sessionOnly()}>
              Session only
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => done()}>
              Cancel
            </Button>
          )}
          <Button variant="primary" disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : change ? 'Change password' : 'Set master password'}
          </Button>
        </>
      }
    >
      {intro && (
        <div className="mb-4 flex gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p>
            This system has no secure keychain ({vault?.backend || 'none'}). Set a master password to keep saved passwords and keys encrypted on disk, or choose
            session only to keep them in memory until Hopline Terminal quits.
          </p>
        </div>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {(change || vault?.mode === 'master') && (
          <div className="space-y-1">
            <Label htmlFor="mp-current">Current master password</Label>
            <PasswordInput id="mp-current" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="mp-new">{change ? 'New master password' : 'Master password'}</Label>
          <PasswordInput id="mp-new" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus={!change && vault?.mode !== 'master'} />
          {short && <p className="text-2xs text-fg-subtle">At least 8 characters.</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="mp-again">Repeat it</Label>
          <PasswordInput id="mp-again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {mismatch && <p className="text-2xs text-danger">The passwords don't match.</p>}
        </div>
        <p className="flex items-start gap-1.5 text-xs text-fg-subtle">
          <KeyRound className="mt-0.5 size-3 shrink-0" aria-hidden />
          There is no recovery: if you forget it, saved secrets are lost (sessions and settings are not).
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Keep the renderer's vault state current, and report activity for auto-lock (throttled). */
export function wireVault(): () => void {
  const offChange = window.hopline.vault.onChange((info) => useUi.getState().set({ vault: info }))
  let last = 0
  const activity = () => {
    const now = Date.now()
    if (now - last < 15_000) return
    last = now
    window.hopline.vault.touch()
  }
  const opts = { capture: true, passive: true } as const
  window.addEventListener('keydown', activity, opts)
  window.addEventListener('pointerdown', activity, opts)
  return () => {
    offChange()
    window.removeEventListener('keydown', activity, opts)
    window.removeEventListener('pointerdown', activity, opts)
  }
}
