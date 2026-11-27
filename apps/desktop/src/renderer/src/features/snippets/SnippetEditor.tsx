import { PLATFORMS, PLATFORM_LABELS, type SessionPlatform } from '@hopline/guard'
import { Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../lib/notify'
import type { SnippetInput, SnippetScope } from '@shared/productivity'
import { snippetVars } from '@shared/snippets'
import { Badge, Button, cn, Dialog, Input, Label, Segmented, SelectMenu, Toggle, Tooltip, useRovingList } from '../../design'
import { askConfirm } from '../../lib/confirm'
import { notifyError } from '../../lib/connect'
import { PLATFORM_SHORT } from '../../lib/platforms'
import { useUi } from '../../store'
import { sessionOfTab, useSnippets } from './store'

const blank = (): SnippetInput => ({ name: '', body: '', mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: true })

const scopeKey = (s: SnippetScope) => (s.kind === 'global' ? 'global' : `${s.kind}:${s.id}`)
const scopeOf = (k: string): SnippetScope => (k === 'global' ? { kind: 'global' } : k.startsWith('folder:') ? { kind: 'folder', id: k.slice(7) } : { kind: 'session', id: k.slice(8) })

/** Snippets: name, body with {{variables}}, insert or run, scope (global / folder / session), platforms, button bar. */
export function SnippetEditor(): React.JSX.Element {
  const { list, editor } = useSnippets()
  const folders = useUi((s) => s.folders)
  const sessions = useUi((s) => s.sessions)
  const [form, setForm] = useState<SnippetInput>(blank())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = editor.id === 'new' ? undefined : list.find((s) => s.id === editor.id)
  // What the form was loaded from: unsaved edits are anything that differs from it.
  const base = useRef<string>('')

  useEffect(() => {
    if (!editor.open) return
    const f = selected ? { id: selected.id, name: selected.name, body: selected.body, mode: selected.mode, scope: selected.scope, platforms: selected.platforms, onBar: selected.onBar } : { ...blank(), ...editor.draft }
    base.current = JSON.stringify(f)
    setForm(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.open, editor.id])

  const dirty = editor.open && JSON.stringify(form) !== base.current && !!(form.name.trim() || form.body.trim())
  /** Leave the current form (another snippet, New, Close) only after asking when it has unsaved edits. */
  const asking = useRef(false)
  const cancelledAt = useRef(0)
  const leave = async (then: () => void) => {
    // The Esc that cancels the question also reaches this dialog a moment later (its layer is on top
    // again by then): a close right after "Cancel" is that same key, not a new request.
    if (asking.current || Date.now() - cancelledAt.current < 250) return
    if (dirty) {
      asking.current = true
      const ok = await askConfirm(`Discard changes to “${form.name.trim() || 'the new snippet'}”?`, 'Your edits are not saved.', 'Discard')
      asking.current = false
      if (!ok) {
        cancelledAt.current = Date.now()
        return
      }
    }
    then()
  }
  const close = () => void leave(() => useSnippets.setState({ editor: { open: false } }))
  const pick = (id: string) => {
    if (id === editor.id) return
    void leave(() => useSnippets.setState({ editor: { open: true, id } }))
  }

  const scopes = useMemo(() => {
    const active = sessionOfTab(useUi.getState().activeTabId)
    const keep = form.scope.kind !== 'global' ? scopeKey(form.scope) : null
    return [
      { options: [{ value: 'global', label: 'Every session', text: 'Every session' }] },
      { label: 'Folder (and its subfolders)', options: folders.map((f) => ({ value: `folder:${f.id}`, label: f.name, text: f.name })) },
      {
        label: 'One session',
        options: sessions
          .filter((s) => s.id === active?.id || `session:${s.id}` === keep || sessions.length <= 50)
          .map((s) => ({ value: `session:${s.id}`, label: s.name, text: s.name, hint: s.id === active?.id ? 'This tab' : undefined }))
      }
    ]
  }, [folders, sessions, form.scope])

  const shown = list.filter((s) => !q.trim() || `${s.name} ${s.body}`.toLowerCase().includes(q.trim().toLowerCase()))
  const roving = useRovingList({
    count: shown.length,
    active: Math.max(0, shown.findIndex((s) => s.id === editor.id)),
    onActiveChange: (i) => shown[i] && pick(shown[i].id),
    onEnter: () => document.querySelector<HTMLInputElement>('input[aria-label="Snippet name"]')?.focus()
  })
  const vars = snippetVars(form.body)
  const lines = form.body.split('\n').filter((l) => l.trim()).length
  const insertProblem = form.mode === 'insert' && lines > 1 ? 'Insert types one line at the prompt. Use Run for several lines.' : null
  const valid = !!form.name.trim() && !!form.body.trim() && !insertProblem

  const save = async () => {
    if (!valid) return
    setBusy(true)
    try {
      const s = await useSnippets.getState().save({ ...form, name: form.name.trim() })
      base.current = JSON.stringify({ ...form, name: form.name.trim(), id: s.id })
      useSnippets.setState({ editor: { open: true, id: s.id } })
      toast.success(`Saved “${s.name}”`)
    } catch (e) {
      notifyError('Could not save the snippet', e)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!selected) return
    if (!(await askConfirm(`Delete “${selected.name}”?`, 'The snippet and its button go away.', 'Delete'))) return
    await useSnippets.getState().remove(selected.id)
    useSnippets.setState({ editor: { open: true, id: 'new' } })
  }
  const togglePlatform = (p: SessionPlatform) => setForm((f) => ({ ...f, platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p] }))

  return (
    <Dialog
      open={editor.open}
      onOpenChange={(o) => !o && close()}
      title="Snippets"
      description="Commands you reuse, with {{variables}}. Run snippets go through the guard like the assistant's commands."
      className="w-[min(880px,96vw)]"
      footer={
        <>
          {selected && (
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" onClick={() => void remove()}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button variant="ghost" onClick={close}>Close</Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
            {selected ? 'Save' : 'Add snippet'}
          </Button>
        </>
      }
    >
      <div className="grid min-h-[420px] grid-cols-[240px_1fr] gap-5">
        <div className="flex min-h-0 flex-col gap-2 border-r border-line pr-4">
          <div className="flex gap-1.5">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-input bg-surface px-2 focus-within:border-accent/60">
              <Search className="size-3.5 text-fg-subtle" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter snippets" className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none" />
            </label>
            <Tooltip label="New snippet">
              <Button size="icon" variant="secondary" className="shrink-0" aria-label="New snippet" onClick={() => pick('new')}>
                <Plus />
              </Button>
            </Tooltip>
          </div>
          <div {...roving.listProps} aria-label="Snippets" className="-mx-1 flex-1 overflow-auto p-0.5">
            {shown.length === 0 && <p className="px-2 py-6 text-center text-xs text-fg-subtle">{list.length ? 'No match.' : 'No snippets yet. Write one on the right.'}</p>}
            {shown.map((s, i) => (
              <div
                key={s.id}
                {...roving.optionProps(i)}
                aria-selected={s.id === editor.id}
                onClick={() => pick(s.id)}
                className={cn('flex w-full cursor-default flex-col rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60', s.id === editor.id ? 'bg-active text-fg' : 'text-fg-muted hover:bg-hover')}
              >
                <span className="flex w-full items-center gap-1.5">
                  <span className="flex-1 truncate text-sm">{s.name}</span>
                  <Badge tone={s.mode === 'run' ? 'accent' : 'neutral'}>{s.mode}</Badge>
                </span>
                <span className="w-full truncate font-mono text-2xs text-fg-subtle">{s.body.split('\n')[0]}</span>
              </div>
            ))}
          </div>
        </div>
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <label className="block">
              <Label>Name</Label>
              <Input autoFocus aria-label="Snippet name" value={form.name} placeholder="Show interface" maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1" />
            </label>
            <Segmented
              label="Mode"
              value={form.mode}
              onChange={(mode) => setForm({ ...form, mode })}
              items={[
                { value: 'insert', label: 'Insert' },
                { value: 'run', label: 'Run' }
              ]}
            />
          </div>
          <p className="-mt-1 text-2xs text-fg-subtle">
            {form.mode === 'insert' ? 'Insert types the line at the prompt without Enter; you review it and press Enter.' : 'Run checks every line with the guard: show commands run at once, config asks you first, disruptive needs the hostname typed, blocked never runs.'}
          </p>
          <label className="block">
            <Label>Commands</Label>
            <textarea
              aria-label="Snippet commands"
              value={form.body}
              spellCheck={false}
              maxLength={4000}
              rows={6}
              placeholder={'interface {{interface}}\n description {{text}}'}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              className="mt-1 w-full resize-y rounded-md border border-line-input bg-term px-2.5 py-2 font-mono text-[12px] leading-[1.55] text-fg placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none"
            />
            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
              {insertProblem ? (
                <span className="text-danger">{insertProblem}</span>
              ) : vars.length ? (
                <>
                  Variables:
                  {vars.map((v) => (
                    <code key={v.name} className="rounded-sm bg-active px-1 font-mono text-fg-muted">
                      {v.name}
                      {v.source && <span className="text-fg-subtle"> · {v.source}</span>}
                    </code>
                  ))}
                </>
              ) : (
                'Write {{name}} for a value you fill in each time. {{interface}}, {{vlan}}, {{vrf}} and {{neighbor}} suggest what the device listed.'
              )}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <Label>Applies to</Label>
              <SelectMenu aria-label="Applies to" className="mt-1" value={scopeKey(form.scope)} onValueChange={(v) => setForm({ ...form, scope: scopeOf(v) })} groups={scopes} />
            </label>
            <div className="flex items-end justify-between gap-2">
              <span>
                <Label>On the button bar</Label>
                <span className="block text-2xs text-fg-subtle">A button under the tabs</span>
              </span>
              <Toggle label="On the button bar" checked={form.onBar} onChange={(v) => setForm({ ...form, onBar: v })} />
            </div>
          </div>
          <div>
            <Label>Platforms</Label>
            <span className="ml-2 text-2xs text-fg-subtle">{form.platforms.length ? `${form.platforms.length} selected` : 'every platform'}</span>
            <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Platforms">
              {PLATFORMS.map((p) => (
                <Tooltip key={p} label={PLATFORM_LABELS[p]}>
                <button
                  type="button"
                  aria-pressed={form.platforms.includes(p)}
                  aria-label={PLATFORM_LABELS[p]}
                  onClick={() => togglePlatform(p)}
                  className={cn(
                    'h-6 rounded-sm border px-1.5 font-mono text-2xs transition-colors duration-[var(--dur-fast)]',
                    form.platforms.includes(p) ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line text-fg-subtle hover:border-line-strong hover:text-fg-muted'
                  )}
                >
                  {PLATFORM_SHORT[p]}
                </button>
                </Tooltip>
              ))}
            </div>
          </div>
          <button type="submit" hidden />
        </form>
      </div>
    </Dialog>
  )
}
