import { useEffect, useState } from 'react'
import { FileKey2 } from 'lucide-react'
import type { CredentialInfo, CredentialInput, CredentialKind, KeyImportInfo } from '@shared/types'
import { Badge, Button, Dialog, Input, Label, PasswordInput, Select } from '../../design'
import { useUi } from '../../store'
import { errorText } from '../settings/parts'

export const KIND_LABEL: Record<CredentialKind, string> = {
  password: 'Password',
  key: 'Private key',
  agent: 'SSH agent',
  prompt: 'Ask every time'
}

const KIND_HINT: Record<CredentialKind, string> = {
  password: 'Saved encrypted. Leave it empty to be asked on connect.',
  key: 'OpenSSH, PEM or PuTTY (.ppk v2/v3). Hopline reads the file itself; it is stored encrypted.',
  agent: 'Keys stay in your SSH agent (OpenSSH, Pageant, 1Password). Nothing is stored here.',
  prompt: 'Only the username is saved. The password is asked for on every connection.'
}

function Field({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label className="block" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
    </div>
  )
}

/** Add or edit a credential profile. Secrets are write-only: the dialog never shows a stored one. */
export function CredentialDialog({ open, editing, onClose }: { open: boolean; editing: CredentialInfo | null; onClose: (saved?: CredentialInfo) => void }): React.JSX.Element {
  const vault = useUi((s) => s.vault)
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [kind, setKind] = useState<CredentialKind>('password')
  const [secret, setSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [clear, setClear] = useState(false)
  const [picked, setPicked] = useState<KeyImportInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setUsername(editing?.username ?? '')
    setKind(editing?.kind ?? 'password')
    setSecret('')
    setPassphrase('')
    setClear(false)
    setPicked(null)
    setError(null)
  }, [open, editing])

  const sameKind = editing?.kind === kind
  const storedKey = sameKind && kind === 'key' && editing?.hasSecret
  const pick = async () => {
    setError(null)
    try {
      const k = await window.hopline.credentials.importKey()
      if (k) {
        setPicked(k)
        if (!name) setName(k.comment || k.file)
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const input: CredentialInput = { id: editing?.id, name: name.trim(), username: username.trim(), kind }
      if (kind === 'password') {
        if (secret) input.secret = secret
        else if (clear) input.secret = ''
      }
      if (kind === 'key') {
        if (picked) input.keyToken = picked.token
        if (passphrase) input.passphrase = passphrase
        else if (clear) input.passphrase = ''
      }
      const saved = await window.hopline.credentials.save(input)
      setSecret('')
      setPassphrase('')
      onClose(saved)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const keyInfo = picked ?? (storedKey ? { keyType: editing!.keyType ?? '', fingerprint: editing!.keyFingerprint, encrypted: editing!.keyEncrypted, file: '' } : null)
  const needsKey = kind === 'key' && !picked && !storedKey
  const valid = name.trim().length > 0 && !needsKey
  const locked = vault?.locked && (kind === 'password' || kind === 'key')

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? `Edit ${editing.name}` : 'New credential profile'}
      className="w-[min(560px,94vw)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy || !!locked} onClick={() => void save()}>
            {editing ? 'Save' : 'Add profile'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void save()
        }}
      >
        <div className="col-span-2">
          <Field label="Profile name" htmlFor="cred-name">
            <Input id="cred-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Lab admin" />
          </Field>
        </div>
        <Field label="Username" htmlFor="cred-user">
          <Input id="cred-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
        </Field>
        <Field label="Authentication" htmlFor="cred-kind">
          <Select id="cred-kind" value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)}>
            {(Object.keys(KIND_LABEL) as CredentialKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        {kind !== 'password' && <p className="col-span-2 -mt-1 text-xs text-fg-subtle">{KIND_HINT[kind]}</p>}

        {kind === 'password' && (
          <div className="col-span-2">
            <Field label="Password" htmlFor="cred-secret">
              <PasswordInput
                id="cred-secret"
                aria-describedby="cred-secret-hint"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={sameKind && editing?.hasSecret ? 'Saved. Type to replace it.' : 'Empty: ask on connect'}
              />
            </Field>
            <p id="cred-secret-hint" className="mt-1 text-xs text-fg-subtle">
              {KIND_HINT.password}
            </p>
            {sameKind && editing?.hasSecret && !secret && (
              <label className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
                <input type="checkbox" className="accent-[var(--c-accent)]" checked={clear} onChange={(e) => setClear(e.target.checked)} />
                Forget the saved password (ask on connect)
              </label>
            )}
          </div>
        )}

        {kind === 'key' && (
          <div className="col-span-2 space-y-3 rounded-lg border border-line bg-surface p-3">
            <div className="flex items-center gap-2">
              <Button onClick={() => void pick()}>
                <FileKey2 /> {keyInfo ? 'Choose another key file…' : 'Choose key file…'}
              </Button>
              {picked && <span className="truncate font-mono text-xs text-fg-muted">{picked.file}</span>}
            </div>
            {keyInfo && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" aria-label="Key details">
                <dt className="text-fg-subtle">Type</dt>
                <dd className="font-mono">
                  {keyInfo.keyType}
                  {'format' in keyInfo && <span className="ml-2 text-fg-subtle">{(keyInfo as KeyImportInfo).format.toUpperCase()}</span>}
                </dd>
                <dt className="text-fg-subtle">Fingerprint</dt>
                <dd className="break-all font-mono" data-testid="key-fingerprint">
                  {keyInfo.fingerprint ?? <span className="text-fg-subtle">shown once the passphrase is known</span>}
                </dd>
                <dt className="text-fg-subtle">Protection</dt>
                <dd>{keyInfo.encrypted ? <Badge tone="accent">passphrase-protected</Badge> : <Badge tone="warn">no passphrase on the file</Badge>}</dd>
              </dl>
            )}
            {keyInfo?.encrypted && (
              <Field label="Key passphrase" htmlFor="cred-pass">
                <PasswordInput
                  id="cred-pass"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={sameKind && editing?.hasPassphrase && !picked ? 'Saved. Type to replace it.' : 'Empty: ask on connect'}
                />
                {sameKind && editing?.hasPassphrase && !picked && !passphrase && (
                  <label className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
                    <input type="checkbox" className="accent-[var(--c-accent)]" checked={clear} onChange={(e) => setClear(e.target.checked)} />
                    Forget the saved passphrase (ask on connect)
                  </label>
                )}
              </Field>
            )}
          </div>
        )}

        {locked && <p className="col-span-2 text-xs text-warn">Unlock the vault to save passwords or keys.</p>}
        {vault?.mode === 'session' && (kind === 'password' || kind === 'key') && (
          <p className="col-span-2 text-xs text-warn">Session-only vault: this secret is forgotten when Hopline quits.</p>
        )}
        {error && (
          <p role="alert" className="col-span-2 text-xs text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
