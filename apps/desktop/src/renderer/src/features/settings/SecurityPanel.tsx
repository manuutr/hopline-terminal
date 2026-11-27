import { useState } from 'react'
import { Lock } from 'lucide-react'
import type { VaultMode } from '@shared/types'
import { Badge, Button, Input } from '../../design'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { MasterPasswordForm, openUnlock } from '../vault/UnlockDialog'
import { Row, Section } from './parts'

const MODE: Record<VaultMode, { label: string; hint: string }> = {
  keychain: { label: 'OS keychain', hint: 'Unlocked with your login (DPAPI, macOS Keychain, libsecret/kwallet).' },
  master: { label: 'Master password', hint: 'Asked at startup and after the auto-lock delay. Works without a keyring.' },
  session: { label: 'Session only', hint: 'Secrets live in memory and are forgotten when Hopline quits.' }
}

/** Settings → Security: how saved secrets are protected (D5). */
export function SecurityPanel(): React.JSX.Element {
  const vault = useUi((s) => s.vault)
  const [form, setForm] = useState<null | 'set' | 'change'>(null)
  const [current, setCurrent] = useState('')
  if (!vault) return <></>
  const apply = (info: Awaited<ReturnType<typeof window.hopline.vault.status>>) => useUi.getState().set({ vault: info })

  const switchTo = async (mode: VaultMode) => {
    if (mode === vault.mode) return
    if (mode === 'master') return setForm('set')
    // Main verifies the current master password and confirms session-only in a native dialog.
    try {
      const info = await window.hopline.vault.setMode({ mode, ...(vault.mode === 'master' ? { current } : {}) })
      apply(info)
      if (info.mode !== mode) return
      setCurrent('')
    } catch (e) {
      notifyError('Could not change how secrets are protected', e)
    }
  }

  return (
    <div>
      <Section title="Vault">
        <Row k="vaultMode" label="Protection" hint={MODE[vault.mode].hint}>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Vault mode">
            {(Object.keys(MODE) as VaultMode[]).map((m) => (
              <Button
                key={m}
                size="sm"
                role="radio"
                aria-checked={vault.mode === m}
                variant={vault.mode === m ? 'primary' : 'secondary'}
                disabled={m === 'keychain' && !vault.keychainAvailable}
                title={m === 'keychain' && !vault.keychainAvailable ? `No secure keychain on this system (${vault.backend})` : undefined}
                onClick={() => void switchTo(m)}
              >
                {MODE[m].label}
              </Button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            {vault.mode === 'master' && <Badge tone={vault.locked ? 'warn' : 'ok'}>{vault.locked ? 'locked' : 'unlocked'}</Badge>}
            {vault.mode === 'keychain' && <Badge tone={vault.keychainBroken ? 'danger' : 'ok'}>{vault.keychainBroken ? 'keychain not answering' : vault.backend}</Badge>}
            {vault.mode === 'session' && <Badge tone="warn">not saved to disk</Badge>}
            {!vault.keychainAvailable && <span className="text-fg-subtle">No secure OS keychain here ({vault.backend}).</span>}
          </div>
          {vault.mode === 'master' && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="Current master password (to switch mode or change auto-lock)"
                aria-label="Current master password"
              />
              {vault.locked && <Button onClick={openUnlock}>Unlock…</Button>}
            </div>
          )}
        </Row>
        {vault.mode === 'master' && (
          <>
            <Row k="masterPassword" label="Master password" hint="Re-wraps the data key; nothing else is re-encrypted.">
              <div className="flex gap-2">
                <Button onClick={() => setForm('change')}>Change master password…</Button>
                <Button variant="ghost" disabled={vault.locked} onClick={() => void window.hopline.vault.lock().then(apply)}>
                  <Lock /> Lock now
                </Button>
              </div>
            </Row>
            <Row
              k="autoLock"
              label="Auto-lock"
              hint="Lock after this many minutes without keyboard or mouse activity in Hopline. 0 never locks. Open sessions keep running. Changing it needs the current master password. Hopline also locks when the machine sleeps or the screen locks; on Linux the screen lock is only seen where the desktop reports it, so rely on sleep and this timer there."
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={1440}
                  defaultValue={vault.autoLockMin}
                  key={vault.autoLockMin}
                  aria-label="Auto-lock minutes"
                  className="w-24"
                  onBlur={(e) => {
                    const v = Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0)))
                    if (v === vault.autoLockMin) return
                    void window.hopline.vault.setAutoLock(v, current || undefined).then(
                      (info) => {
                        apply(info)
                        if (info.autoLockMin === v) setCurrent('')
                      },
                      (err) => {
                        e.target.value = String(vault.autoLockMin)
                        notifyError('Could not save auto-lock', err)
                      }
                    )
                  }}
                />
                <span className="text-xs text-fg-subtle">minutes</span>
              </div>
            </Row>
          </>
        )}
      </Section>
      <div data-settings-extra><Section title="What is protected">
        <p className="py-2 text-xs leading-relaxed text-fg-muted">
          Saved passwords, private keys, key passphrases, the API key, the folder-sync passphrase and terminal history are encrypted with one random data key (AES-256-GCM).
          That key is sealed by the mode above. Secrets are decrypted only in the main process and are never sent to this window or to the assistant.
        </p>
      </Section></div>
      <MasterPasswordForm open={form !== null} change={form === 'change'} title={form === 'change' ? 'Change master password' : 'Set a master password'} onDone={() => setForm(null)} />
    </div>
  )
}
