import { Check, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { snippetVars, valueProblem } from '@shared/snippets'
import type { SnippetVar } from '@shared/productivity'
import { Button, canConfirm, cn, ConfigConfirm, Dialog, Input } from '../../design'
import { platformLabel } from '../../lib/platforms'
import { sentence } from '../../lib/sentence'
import { applySnippet, finish, learnedValues, useSnippets } from './store'

/** One variable: a text field with the values the terminal learned (interfaces, VLANs…) as suggestions. */
function VarField({ v, tabId, value, onChange, autoFocus, onSubmit }: { v: SnippetVar; tabId: string; value: string; onChange: (s: string) => void; autoFocus: boolean; onSubmit: () => void }): React.JSX.Element {
  const known = learnedValues(tabId, v.source)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const q = value.trim().toLowerCase()
  const matches = useMemo(() => known.filter((k) => k.toLowerCase().includes(q) && k !== value).slice(0, 8), [known, q, value])
  const problem = value ? valueProblem(value) : null
  const listId = `var-${v.name}-list`
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs font-medium text-fg-muted">
        <code className="font-mono text-fg">{`{{${v.name}}}`}</code>
        {v.source && <span className="text-2xs font-normal text-fg-subtle">{known.length ? `${known.length} learned from this device` : `Run a ${v.source} listing to learn values`}</span>}
      </span>
      <div>
        <Input
          autoFocus={autoFocus}
          role="combobox"
          aria-label={v.name}
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-invalid={!!problem}
          value={value}
          className="font-mono text-xs"
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
            setHi(0)
          }}
          onKeyDown={(e) => {
            if (open && matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
            } else if (e.key === 'Enter' && open && matches.length && hi >= 0 && matches[hi] && matches[hi] !== value && !(e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onChange(matches[hi]!)
              setOpen(false)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            } else if (e.key === 'Escape' && open && matches.length) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
        />
        {open && matches.length > 0 && (
          <ul id={listId} role="listbox" className="mt-1 max-h-40 overflow-auto rounded-md border border-line bg-surface p-1">
            {matches.map((m, i) => (
              <li
                key={m}
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(m)
                  setOpen(false)
                }}
                className={cn('flex h-7 cursor-default items-center rounded-sm px-2 font-mono text-xs text-fg-muted', i === hi && 'bg-hover text-fg')}
              >
                {m}
              </li>
            ))}
          </ul>
        )}
      </div>
      {problem && <span className="mt-1 block text-2xs text-danger">{problem}</span>}
    </label>
  )
}

/** Fill a snippet's {{variables}} before it is inserted or run. */
export function SnippetVarsDialog(): React.JSX.Element {
  const req = useSnippets((s) => s.vars)
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => setValues({}), [req])
  const vars = req ? snippetVars(req.snippet.body) : []
  const ok = vars.every((v) => !valueProblem(values[v.name] ?? ''))
  const close = () => useSnippets.setState({ vars: null })
  const submit = () => {
    if (!req || !ok) return
    close()
    void applySnippet(req.snippet, req.tabId, values)
  }
  const preview = req ? req.snippet.body.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (m, n: string) => values[n]?.trim() || m) : ''
  return (
    <Dialog
      open={!!req}
      onOpenChange={(o) => !o && close()}
      title={req ? req.snippet.name : ''}
      description={req?.snippet.mode === 'insert' ? 'Typed at the prompt without Enter.' : 'Checked by the guard before it runs.'}
      className="w-[min(520px,92vw)]"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={submit}>
            {req?.snippet.mode === 'insert' ? 'Insert' : 'Continue'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {req && vars.map((v, i) => <VarField key={v.name} v={v} tabId={req.tabId} value={values[v.name] ?? ''} onChange={(s) => setValues((x) => ({ ...x, [v.name]: s }))} autoFocus={i === 0} onSubmit={submit} />)}
        <pre className="selectable overflow-x-auto rounded-md bg-term p-2 font-mono text-[12px] leading-[1.55] text-fg-muted" aria-label="Preview">
          {preview}
        </pre>
      </div>
    </Dialog>
  )
}

/** Confirm a config or disruptive snippet run: the exact lines, the platform wrapper, and the typed hostname. */
export function SnippetConfirmDialog(): React.JSX.Element {
  const req = useSnippets((s) => s.confirm)
  const [typed, setTyped] = useState('')
  const approve = useRef<HTMLButtonElement>(null)
  useEffect(() => setTyped(''), [req])
  const plan = req?.plan
  const disruptive = plan?.kind === 'disruptive'
  const confirmed = canConfirm(disruptive ? 'disruptive' : 'config', plan?.confirm, typed)
  const decide = (yes: boolean) => {
    if (!req) return
    useSnippets.setState({ confirm: null })
    void finish(req.snippet, req.tabId, req.plan.planId, yes, yes && disruptive ? typed : undefined)
  }
  return (
    <Dialog
      open={!!req}
      onOpenChange={(o) => !o && decide(false)}
      title={req ? `Run “${req.snippet.name}” on ${plan!.sessionName}?` : ''}
      description={disruptive ? 'Disruptive: this can take traffic or access down.' : 'A configuration change. It runs exactly these lines.'}
      className="w-[min(560px,92vw)]"
      onOpenAutoFocus={(e) => {
        if (!disruptive) {
          e.preventDefault()
          approve.current?.focus()
        }
      }}
      footer={
        <>
          <span className="mr-auto self-center text-2xs text-fg-subtle">Logged in the audit log with your name.</span>
          <Button variant="ghost" onClick={() => decide(false)}>
            <X /> Cancel
          </Button>
          <Button ref={approve} variant={disruptive ? 'danger' : 'primary'} disabled={!confirmed || (disruptive && !plan?.confirm)} onClick={() => decide(true)}>
            <Check /> {disruptive ? 'Run disruptive' : 'Apply'}
          </Button>
        </>
      }
    >
      {plan && (
        <ConfigConfirm
          testId="snippet-confirm"
          kind={disruptive ? 'disruptive' : 'config'}
          target={
            <>
              {plan.sessionName} · {platformLabel(plan.platform)}
              {plan.hostname && <> · prompt <code className="font-mono text-fg">{plan.hostname}</code></>}
            </>
          }
          reasons={[sentence(plan.reason)]}
          before={plan.wrapper?.before}
          lines={plan.lines}
          after={plan.wrapper?.after}
          hostname={plan.confirm}
          typed={typed}
          onTyped={setTyped}
          onSubmit={() => decide(true)}
        />
      )}
    </Dialog>
  )
}
