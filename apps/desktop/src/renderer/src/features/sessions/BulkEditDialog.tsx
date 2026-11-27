import { SESSION_PLATFORM_LABELS, SESSION_PLATFORMS } from '@hopline/guard'
import { useEffect, useMemo, useState } from 'react'
import { toast } from '../../lib/notify'
import { SESSION_COLORS, type SessionColor, type SessionPlatform, type SessionPatch } from '@shared/types'
import { Button, cn, Dialog, Input, Label, Select } from '../../design'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { COLOR_CLASS } from './colors'
import { TagChip } from './SessionTree'

type Field = 'folder' | 'platform' | 'username' | 'credential' | 'color' | 'tags'

/** "Mixed" when the sessions disagree, the common value otherwise. */
function common<T>(values: T[]): T | undefined {
  return values.length && values.every((v) => v === values[0]) ? values[0] : undefined
}

/**
 * Edit N sessions at once. Only ticked fields change; everything else keeps each session's value.
 * Credentials: only which profile a session uses (credentialId), never the secret itself.
 */
export function BulkEditDialog(): React.JSX.Element {
  const ids = useUi((s) => s.bulkEdit)
  const { sessions, folders, credentials } = useUi()
  const list = useMemo(() => sessions.filter((s) => ids?.includes(s.id)), [sessions, ids])
  const [on, setOn] = useState<ReadonlySet<Field>>(new Set())
  const [folderId, setFolderId] = useState<string>('')
  const [platform, setPlatform] = useState<SessionPlatform>('auto')
  const [username, setUsername] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [color, setColor] = useState<SessionColor | null>(null)
  const [addTags, setAddTags] = useState('')
  const [removeTags, setRemoveTags] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!ids) return
    setOn(new Set())
    setFolderId(common(list.map((s) => s.folderId ?? '')) ?? '')
    setPlatform(common(list.map((s) => s.platform)) ?? 'auto')
    setUsername(common(list.map((s) => s.username)) ?? '')
    setCredentialId(common(list.map((s) => s.credentialId ?? '')) ?? '')
    setColor(common(list.map((s) => s.color)) ?? null)
    setAddTags('')
    setRemoveTags(new Set())
    // Reset when the dialog opens for a new set, not on every store refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  const close = () => useUi.getState().set({ bulkEdit: null })
  const tick = (f: Field, v = true) => setOn((s) => (v ? new Set(s).add(f) : new Set([...s].filter((x) => x !== f))))
  const present = useMemo(() => [...new Set(list.flatMap((s) => s.tags))].sort(), [list])
  const parsedAdd = addTags.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)

  const patch = (): SessionPatch => {
    const p: SessionPatch = {}
    if (on.has('folder')) p.folderId = folderId || null
    if (on.has('platform')) p.platform = platform
    if (on.has('username')) p.username = username.trim()
    if (on.has('credential')) p.credentialId = credentialId || null
    if (on.has('color')) p.color = color
    if (parsedAdd.length) p.addTags = parsedAdd
    if (removeTags.size) p.removeTags = [...removeTags]
    return p
  }
  const changes = Object.keys(patch()).length

  const apply = async () => {
    setSaving(true)
    try {
      await window.hopline.sessions.bulkUpdate(
        list.map((s) => s.id),
        patch()
      )
      await useUi.getState().load()
      toast.success(`Updated ${list.length} sessions`)
      close()
    } catch (e) {
      notifyError('Bulk edit failed', e)
    } finally {
      setSaving(false)
    }
  }

  const row = (f: Field, label: string, control: React.ReactNode, mixed: boolean) => (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3">
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <input type="checkbox" className="accent-[var(--c-accent)]" checked={on.has(f)} onChange={(e) => tick(f, e.target.checked)} aria-label={`Change ${label.toLowerCase()}`} />
        {label}
      </label>
      <div className={cn('flex items-center gap-2 transition-opacity duration-[var(--dur-fast)]', !on.has(f) && 'text-fg-subtle')} onFocusCapture={() => tick(f)} onPointerDownCapture={() => tick(f)}>
        {control}
        {mixed && !on.has(f) && <span className="shrink-0 text-2xs text-fg-subtle">Mixed</span>}
      </div>
    </div>
  )

  return (
    <Dialog
      open={!!ids}
      onOpenChange={(o) => !o && close()}
      title={`Edit ${list.length} sessions`}
      description="Only the fields you tick change. Every other value stays as it is on each session."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changes || saving || !list.length} onClick={() => void apply()}>
            Apply to {list.length} sessions
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (changes) void apply()
        }}
      >
        {row(
          'folder',
          'Folder',
          <Select aria-label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">None (top level)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>,
          common(list.map((s) => s.folderId)) === undefined
        )}
        {row(
          'platform',
          'Platform',
          <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value as SessionPlatform)}>
            {SESSION_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {SESSION_PLATFORM_LABELS[p]}
              </option>
            ))}
          </Select>,
          common(list.map((s) => s.platform)) === undefined
        )}
        {row('username', 'Username', <Input aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />, common(list.map((s) => s.username)) === undefined)}
        {row(
          'credential',
          'Credential',
          <Select aria-label="Credential" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
            <option value="">Ask for password on connect</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.username})
              </option>
            ))}
          </Select>,
          common(list.map((s) => s.credentialId)) === undefined
        )}
        {row(
          'color',
          'Color',
          <div role="radiogroup" aria-label="Color" className="flex items-center gap-1.5">
            {[null, ...SESSION_COLORS].map((c) => (
              <button
                key={c ?? 'none'}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c ? COLOR_CLASS[c].label : 'No color'}
                onClick={() => setColor(c)}
                className={cn(
                  'size-5 rounded-full ring-offset-2 ring-offset-overlay transition-shadow duration-[var(--dur-fast)]',
                  c ? COLOR_CLASS[c].bar : 'border border-dashed border-line-strong',
                  color === c && 'ring-2 ring-fg-muted'
                )}
              />
            ))}
          </div>,
          common(list.map((s) => s.color)) === undefined
        )}
        <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3">
          <Label className="pt-1.5 text-sm font-normal">Tags</Label>
          <div className="flex flex-col gap-2">
            <Input aria-label="Add tags" value={addTags} onChange={(e) => setAddTags(e.target.value)} placeholder="Add: core, prod" />
            {present.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-2xs text-fg-subtle">Remove:</span>
                {present.map((t) => (
                  <span key={t} className={cn(removeTags.has(t) && 'text-fg-subtle line-through')}>
                    <TagChip
                      tag={t}
                      active={removeTags.has(t)}
                      onClick={() => setRemoveTags((s) => (s.has(t) ? new Set([...s].filter((x) => x !== t)) : new Set(s).add(t)))}
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
