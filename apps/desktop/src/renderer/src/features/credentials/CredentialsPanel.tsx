import { useState } from 'react'
import { Bot, FileKey2, KeyRound, MessageSquareMore, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CredentialInfo, CredentialKind } from '@shared/types'
import { Badge, Button, EmptyState } from '../../design'
import { askConfirm } from '../../lib/confirm'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { ReplacePasswordsDialog } from './ReplacePasswordsDialog'
import { CredentialDialog, KIND_LABEL } from './CredentialDialog'

const ICON: Record<CredentialKind, React.ReactNode> = {
  password: <KeyRound className="size-3.5" aria-hidden />,
  key: <FileKey2 className="size-3.5" aria-hidden />,
  agent: <Bot className="size-3.5" aria-hidden />,
  prompt: <MessageSquareMore className="size-3.5" aria-hidden />
}

function detail(c: CredentialInfo): string {
  if (c.kind === 'key') return c.hasSecret ? `${(c.keyType ?? '').replace(/^ssh-/, '')} ${c.keyFingerprint?.replace(/^SHA256:/, '').slice(0, 16) ?? ''}${c.keyEncrypted && !c.hasPassphrase ? ' · passphrase asked' : ''}` : 'no key file'
  if (c.kind === 'password') return c.hasSecret ? 'password saved' : 'asked on connect'
  return KIND_LABEL[c.kind]
}

/** Settings → Credentials: the profiles sessions use. Only metadata is ever shown. */
export function CredentialsPanel(): React.JSX.Element {
  const credentials = useUi((s) => s.credentials)
  const [editing, setEditing] = useState<CredentialInfo | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [open, setOpen] = useState(false)
  const reload = () => useUi.getState().load()

  const remove = async (c: CredentialInfo) => {
    const used = c.usedBy ? `Used by ${c.usedBy} session${c.usedBy === 1 ? '' : 's'}: they will ask for a password on connect instead.` : 'No session uses it.'
    if (!(await askConfirm(`Delete ${c.name}?`, `${used} Its saved secret is deleted.`, 'Delete profile'))) return
    try {
      await window.hopline.credentials.remove(c.id)
      await reload()
    } catch (e) {
      notifyError('Could not delete the profile', e)
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">Reusable sign-in details. Passwords and keys stay in the main process; this window only sees their names.</p>
        <Button
          onClick={() => {
            setEditing(null)
            setOpen(true)
          }}
        >
          <Plus /> Add profile
        </Button>
      </div>
      {credentials.length === 0 ? (
        <EmptyState icon={<KeyRound />} title="No credential profiles" body="Add one to sign in to many devices with the same account or key." />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Credential profiles">
          {credentials.map((c) => (
            <li key={c.id} className="group flex items-center gap-3 px-3 py-2" data-credential={c.name}>
              <span className="text-fg-muted">{ICON[c.kind]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="truncate font-mono text-xs text-fg-subtle">{c.username || '(no username)'}</span>
                </div>
                <div className="truncate font-mono text-2xs text-fg-subtle">{detail(c)}</div>
              </div>
              <Badge>{c.usedBy ? `${c.usedBy} session${c.usedBy === 1 ? '' : 's'}` : 'unused'}</Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Edit ${c.name}`}
                onClick={() => {
                  setEditing(c)
                  setOpen(true)
                }}
              >
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {credentials.some((c) => c.kind === 'password') && <Button className="mt-3" onClick={() => setReplacing(true)}><KeyRound /> Update saved passwords…</Button>}
      {replacing && <ReplacePasswordsDialog close={() => setReplacing(false)} />}
      <CredentialDialog
        open={open}
        editing={editing}
        onClose={(saved) => {
          setOpen(false)
          if (saved) void reload()
        }}
      />
    </div>
  )
}
