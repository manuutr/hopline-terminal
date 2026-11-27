import { useFieldLabel } from '../../design/useFieldLabel'
import { useEffect, useState } from 'react'
import { Folder, RefreshCw } from 'lucide-react'
import { SERIAL_DEFAULTS, SESSION_COLORS, type SerialPortInfo, type SerialSettings, type SessionInput } from '@shared/types'
import { Button, cn, Dialog, Input, Label, Select } from '../../design'
import { SelectMenu } from '../../design/SelectMenu'
import { platformGroups } from '../../lib/platforms'
import { COLOR_CLASS } from './colors'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { KIND_LABEL } from '../credentials/CredentialDialog'
import { ForwardsEditor, forwardsProblem } from '../forwards/ForwardsEditor'

const empty: SessionInput = {
  name: '',
  folderId: null,
  host: '',
  port: 22,
  protocol: 'ssh',
  platform: 'auto',
  username: '',
  credentialId: null,
  logToFile: false,
  notes: '',
  options: {}
}

const DEFAULT_PORT: Record<SessionInput['protocol'], number> = { ssh: 22, telnet: 23, raw: 23, serial: 0 }
/** Vendor groups for the Platform menu, each with a neutral monogram (never a vendor logo). */
const PLATFORM_GROUPS = platformGroups(true)

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  const { ref, labelId } = useFieldLabel<HTMLDivElement>()
  return (
    <div ref={ref} className={className}>
      <Label id={labelId} className="mb-1 block">{label}</Label>
      {children}
    </div>
  )
}

export function SessionDialog(): React.JSX.Element {
  const { editing, folders, credentials, vault } = useUi()
  const [form, setForm] = useState<SessionInput>(empty)
  const [newCred, setNewCred] = useState<{ name: string; username: string; password: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [tagText, setTagText] = useState('')

  useEffect(() => {
    if (editing.open) {
      setForm({ ...empty, ...editing.session } as SessionInput)
      setNewCred(null)
      setTagText((editing.session?.tags ?? []).join(', '))
    }
  }, [editing])

  const up = <K extends keyof SessionInput>(k: K, v: SessionInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const serial: SerialSettings = { ...SERIAL_DEFAULTS, ...form.options.serial }
  const upSerial = <K extends keyof SerialSettings>(k: K, v: SerialSettings[K]) =>
    setForm((f) => ({ ...f, options: { ...f.options, serial: { ...SERIAL_DEFAULTS, ...f.options.serial, [k]: v } } }))
  const isSerial = form.protocol === 'serial'
  const ssh = form.options.ssh ?? {}
  const upSsh = <K extends keyof NonNullable<SessionInput['options']['ssh']>>(k: K, v: NonNullable<SessionInput['options']['ssh']>[K]) =>
    setForm((f) => ({ ...f, options: { ...f.options, ssh: { ...f.options.ssh, [k]: v } } }))
  const jumpCandidates = useUi((s) => s.sessions).filter((x) => x.protocol === 'ssh' && x.id !== form.id)
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null)
  const scan = () => {
    setPorts(null)
    window.hopline.serial.list().then(setPorts, (e) => {
      setPorts([])
      notifyError('Could not list serial ports', e)
    })
  }
  useEffect(() => {
    if (editing.open && isSerial && ports === null) scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing.open, isSerial])
  const setProtocol = (p: SessionInput['protocol']) =>
    setForm((f) => ({
      ...f,
      protocol: p,
      // Keep a custom port; swap only the well-known defaults.
      port: Object.values(DEFAULT_PORT).includes(f.port) ? DEFAULT_PORT[p] : f.port,
      host: f.protocol === 'serial' || p === 'serial' ? '' : f.host,
      options: p === 'serial' ? { ...f.options, serial: { ...SERIAL_DEFAULTS, ...f.options.serial } } : f.options
    }))
  const close = () => useUi.getState().set({ editing: { open: false } })
  const [fwdStrict, setFwdStrict] = useState(false)

  const save = async () => {
    const fwdProblem = form.protocol === 'ssh' ? forwardsProblem(form.options.ssh?.forwards) : null
    if (fwdProblem) {
      // Inline, not a toast: every forward field shows its problem and the first one gets focus.
      setFwdStrict(true)
      requestAnimationFrame(() => {
        const bad = document.querySelector<HTMLElement>('[aria-label="Saved port forwards"] [aria-invalid="true"]')
        bad?.scrollIntoView({ block: 'center' })
        bad?.focus()
      })
      return
    }
    setSaving(true)
    try {
      let credentialId = form.credentialId
      if (newCred) {
        const c = await window.hopline.credentials.save({
          name: newCred.name || `${newCred.username}@${form.host}`,
          username: newCred.username,
          kind: 'password',
          secret: newCred.password
        })
        credentialId = c.id
      }
      await window.hopline.sessions.save({ ...form, name: form.name || form.host, credentialId })
      await useUi.getState().load()
      close()
    } catch (e) {
      notifyError('Could not save session', e)
    } finally {
      setSaving(false)
    }
  }

  const valid = form.host.trim() && (isSerial || (form.port > 0 && form.port < 65536))

  return (
    <Dialog
      open={editing.open}
      onOpenChange={(o) => !o && close()}
      title={form.id ? `Edit ${form.name}` : 'New session'}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || saving} onClick={() => void save()}>
            {form.id ? 'Save' : 'Add session'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-6 gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void save()
        }}
      >
        <Field label="Name" className="col-span-6">
          <Input autoFocus value={form.name} onChange={(e) => up('name', e.target.value)} placeholder="core-sw1" />
        </Field>
        <Field label="Protocol" className="col-span-2">
          <SelectMenu
            aria-label="Protocol"
            value={form.protocol}
            onValueChange={setProtocol}
            options={[
              { value: 'ssh', label: 'SSH' },
              { value: 'telnet', label: 'Telnet' },
              { value: 'raw', label: 'Raw TCP' },
              { value: 'serial', label: 'Serial console' }
            ]}
          />
        </Field>
        {isSerial ? (
          <Field label="Serial port" className="col-span-4">
            <div className="flex gap-1.5">
              <Input
                list="serial-ports"
                value={form.host}
                onChange={(e) => up('host', e.target.value)}
                placeholder={ports === null ? 'Scanning…' : ports.length ? 'Pick a port' : 'No ports found: type a path (COM3, /dev/ttyUSB0)'}
                className="font-mono"
              />
              <datalist id="serial-ports">
                {ports?.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.label}
                  </option>
                ))}
              </datalist>
              <Button size="icon" aria-label="Rescan serial ports" onClick={scan}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            {ports && ports.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {ports.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => up('host', p.path)}
                    className={`rounded-md border px-1.5 py-0.5 text-2xs ${form.host === p.path ? 'border-accent text-fg' : 'border-line text-fg-muted hover:text-fg'}`}
                  >
                    <span className="font-mono">{p.path}</span> · {p.label}
                  </button>
                ))}
              </div>
            )}
          </Field>
        ) : (
          <>
            <Field label="Host" className="col-span-3">
              <Input value={form.host} onChange={(e) => up('host', e.target.value)} placeholder="10.0.0.1 or hostname" />
            </Field>
            <Field label="Port" className="col-span-1">
              <Input type="number" value={form.port} onChange={(e) => up('port', Number(e.target.value))} />
            </Field>
          </>
        )}
        {isSerial && (
          <div className="col-span-6 grid grid-cols-6 gap-3 border-t border-line pt-3">
            <Field label="Baud rate" className="col-span-3">
              <SelectMenu
                aria-label="Baud rate"
                value={String(serial.baudRate)}
                onValueChange={(v) => upSerial('baudRate', Number(v))}
                options={BAUDS.map((b) => ({ value: String(b), label: b.toLocaleString('en-US').replace(/,/g, '\u2009') }))}
                className="tabular-nums"
              />
            </Field>
            <Field label="Data bits" className="col-span-3">
              <SelectMenu
                aria-label="Data bits"
                value={String(serial.dataBits)}
                onValueChange={(v) => upSerial('dataBits', Number(v) as SerialSettings['dataBits'])}
                options={['8', '7', '6', '5'].map((b) => ({ value: b, label: b }))}
              />
            </Field>
            <Field label="Parity" className="col-span-2">
              <SelectMenu
                aria-label="Parity"
                value={serial.parity}
                onValueChange={(v) => upSerial('parity', v)}
                options={(['none', 'even', 'odd', 'mark', 'space'] as const).map((b) => ({ value: b, label: b[0]!.toUpperCase() + b.slice(1) }))}
              />
            </Field>
            <Field label="Stop bits" className="col-span-2">
              <SelectMenu
                aria-label="Stop bits"
                value={String(serial.stopBits)}
                onValueChange={(v) => upSerial('stopBits', Number(v) as SerialSettings['stopBits'])}
                options={['1', '1.5', '2'].map((b) => ({ value: b, label: b }))}
              />
            </Field>
            <Field label="Flow" className="col-span-2">
              <SelectMenu
                aria-label="Flow control"
                value={serial.flow}
                onValueChange={(v) => upSerial('flow', v)}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'rtscts', label: 'RTS/CTS' },
                  { value: 'xonxoff', label: 'XON/XOFF' }
                ]}
              />
            </Field>
            <p className="col-span-6 text-xs text-fg-subtle">Cisco, Arista and Juniper consoles default to 9600 8N1, no flow control. Send break, Toggle DTR and Toggle RTS are in the command palette.</p>
          </div>
        )}
        <Field label="Tags" className="col-span-3">
          <Input
            value={tagText}
            onChange={(e) => {
              setTagText(e.target.value)
              up('tags', e.target.value.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))
            }}
            placeholder="core, prod, dc1"
          />
        </Field>
        <Field label="Color" className="col-span-3">
          <div role="radiogroup" aria-label="Color" className="flex h-7 flex-nowrap items-center">
            {[null, ...SESSION_COLORS].map((c) => (
              <button
                key={c ?? 'none'}
                type="button"
                role="radio"
                aria-checked={(form.color ?? null) === c}
                aria-label={c ? COLOR_CLASS[c].label : 'No color'}
                onClick={() => up('color', c)}
                // 24 px target (WCAG 2.5.8), a 16 px swatch drawn inside it.
                className="group flex size-6 shrink-0 items-center justify-center rounded-full"
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-4 rounded-full ring-offset-2 ring-offset-overlay',
                    c ? COLOR_CLASS[c].bar : 'border border-dashed border-line-strong',
                    (form.color ?? null) === c && 'ring-2 ring-fg-muted'
                  )}
                />
              </button>
            ))}
          </div>
        </Field>
        <Field label="Platform" className="col-span-3">
          {/* Auto-detect on top (identified on first connect), then each vendor. */}
          <SelectMenu
            aria-label="Platform"
            value={form.platform}
            onValueChange={(v) => up('platform', v as SessionInput['platform'])}
            groups={PLATFORM_GROUPS}
          />
        </Field>
        <Field label="Folder" className="col-span-3">
          <SelectMenu
            aria-label="Folder"
            value={form.folderId ?? ''}
            onValueChange={(v) => up('folderId', v || null)}
            options={[
              { value: '', label: 'None', icon: <Folder className="size-3.5 text-fg-subtle" /> },
              ...folders.map((f) => ({ value: f.id, label: f.name, icon: <Folder className="size-3.5 text-fg-subtle" /> }))
            ]}
          />
        </Field>

        {!isSerial && (
        <Field label="Credentials" className="col-span-6">
          <Select
            value={newCred ? '__new' : (form.credentialId ?? '')}
            onChange={(e) => {
              if (e.target.value === '__new') setNewCred({ name: '', username: form.username, password: '' })
              else {
                setNewCred(null)
                up('credentialId', e.target.value || null)
              }
            }}
          >
            <option value="">Ask for password on connect</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.username || 'no user'} · {KIND_LABEL[c.kind].toLowerCase()})
              </option>
            ))}
            <option value="__new" disabled={!!vault?.locked}>
              + New credential profile…
            </option>
          </Select>
        </Field>
        )}
        {!isSerial && !form.credentialId && !newCred && (
          <Field label="Username" className="col-span-6">
            <Input value={form.username} onChange={(e) => up('username', e.target.value)} placeholder="admin" />
          </Field>
        )}
        {!isSerial && newCred && (
          <div className="col-span-6 grid grid-cols-6 gap-3 border-t border-line pt-3">
            <Field label="Profile name" className="col-span-6">
              <Input value={newCred.name} onChange={(e) => setNewCred({ ...newCred, name: e.target.value })} placeholder="Lab admin" />
            </Field>
            <Field label="Username" className="col-span-3">
              <Input value={newCred.username} onChange={(e) => setNewCred({ ...newCred, username: e.target.value })} />
            </Field>
            <Field label="Password" className="col-span-3">
              <Input type="password" value={newCred.password} onChange={(e) => setNewCred({ ...newCred, password: e.target.value })} />
            </Field>
            <p className="col-span-6 text-xs text-fg-subtle">
              {vault?.mode === 'session' ? 'Kept in memory until Hopline Terminal quits (session-only vault).' : 'Encrypted in your vault.'} It never leaves the main process. Keys, agent and
              other profiles: Settings → Credentials.
            </p>
          </div>
        )}

        {form.protocol === 'ssh' && (
          <div className="col-span-6 grid grid-cols-6 gap-3 border-t border-line pt-3">
            <Field label="Jump host" className="col-span-6">
              <Select value={ssh.jump?.[0] ?? ''} onChange={(e) => upSsh('jump', e.target.value ? [e.target.value] : undefined)}>
                <option value="">None: connect directly</option>
                {jumpCandidates.map((j) => (
                  <option key={j.id} value={j.id}>
                    via {j.name} ({j.host}:{j.port})
                  </option>
                ))}
              </Select>
            </Field>
            {(
              [
                ['useAgent', 'Use my SSH agent', 'OpenSSH agent, Pageant or 1Password; tried before passwords.'],
                ['agentForward', 'Forward my agent to this device', 'Only to the target, never to jump hosts.'],
                ['legacyAlgorithms', 'Allow legacy algorithms', 'diffie-hellman-group1, ssh-dss, CBC ciphers, offered after modern ones. Needed by old IOS images.']
              ] as const
            ).map(([k, label, hint]) => (
              <label key={k} className="col-span-6 flex items-start gap-2 text-sm text-fg-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--c-accent)]"
                  checked={k === 'legacyAlgorithms' ? ssh.legacyAlgorithms !== false : !!ssh[k]}
                  onChange={(e) => upSsh(k, e.target.checked)}
                />
                <span>
                  {label}
                  <span className="block text-xs text-fg-subtle">{hint}</span>
                </span>
              </label>
            ))}
            <ForwardsEditor strict={fwdStrict} value={ssh.forwards ?? []} onChange={(v) => upSsh('forwards', v.length ? v : undefined)} />
          </div>
        )}
        <label className="col-span-6 flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" className="accent-[var(--c-accent)]" checked={form.logToFile} onChange={(e) => up('logToFile', e.target.checked)} />
          Log session output to a file
        </label>
        <Field label="Notes" className="col-span-6">
          <textarea
            value={form.notes}
            onChange={(e) => up('notes', e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-fg focus:border-accent/60 focus:outline-none"
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
