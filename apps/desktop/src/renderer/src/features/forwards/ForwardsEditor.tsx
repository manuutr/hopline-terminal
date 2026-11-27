import { Plus, X } from 'lucide-react'
import { useId } from 'react'
import type { ForwardSpec } from '@shared/files'
import { describeForward, isExposedBind } from '@shared/files'
import { Button, Toggle, Tooltip } from '../../design'
import { draftOf, forwardErrors, ForwardFields, type ForwardDraft } from './ForwardFields'

/** A draft back to a spec: ports stay numbers, an empty destination port stays unset. */
function specOf(f: ForwardSpec, d: ForwardDraft): ForwardSpec {
  return {
    ...f,
    kind: d.kind,
    bindHost: d.bindHost.trim(),
    bindPort: d.bindPort === '' ? 0 : Math.min(65535, Number(d.bindPort) || 0),
    destHost: (d.destHost ?? '').trim(),
    destPort: d.destPort === '' ? undefined : Math.min(65535, Number(d.destPort) || 0)
  }
}

/**
 * Saved port forwards for a session (SessionDialog → SSH). They start when the session connects.
 * Same fields and labels as the tab's Port forwarding dialog (ForwardFields); problems show under
 * the field once something was typed in it.
 */
export function ForwardsEditor({ value, onChange, strict }: { value: ForwardSpec[]; onChange: (v: ForwardSpec[]) => void; /** After a failed save: show every problem, not only in fields already typed in. */ strict?: boolean }): React.JSX.Element {
  const base = useId()
  const up = (i: number, patch: Partial<ForwardDraft>) => onChange(value.map((f, j) => (j === i ? specOf(f, { ...draftOf(f), ...patch }) : f)))
  const add = () => onChange([...value, { id: crypto.randomUUID(), kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '', destPort: undefined }])
  return (
    <div className="col-span-6">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-fg-muted">Port forwards</span>
        <Button size="sm" variant="ghost" onClick={add} disabled={value.length >= 32}>
          <Plus />
          Add forward
        </Button>
      </div>
      {value.length === 0 ? (
        <p className="mt-1 text-xs text-fg-subtle">None. Forwards saved here start on every connect; add one for a single tab from its menu → Port forwarding.</p>
      ) : (
        <ul aria-label="Saved port forwards" className="mt-1 space-y-3">
          {value.map((f, i) => {
            const d = draftOf(f)
            // A fresh row is not an error yet: only fields the user has filled, or a destination once a host is typed.
            const all = forwardErrors(d)
            const errors = strict ? all : { ...all, ...(f.destHost ? {} : { destHost: undefined, destPort: d.destPort ? all.destPort : undefined }) }
            return (
              <li key={f.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <div className="mb-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{describeForward({ ...f, destHost: f.destHost || '…', destPort: f.destPort })}</span>
                  <Toggle inline label="Start on connect" checked={f.autoStart !== false} onChange={(v) => onChange(value.map((x, j) => (j === i ? { ...x, autoStart: v } : x)))} />
                  <Tooltip label="Remove">
                    <Button variant="ghost" size="icon-sm" aria-label="Remove forward" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                      <X />
                    </Button>
                  </Tooltip>
                </div>
                <ForwardFields idPrefix={`${base}-${i}`} value={d} onChange={(p) => up(i, p)} errors={errors} compact />
                {isExposedBind(f.bindHost) && <p className="mt-1 text-2xs text-fg-subtle">A saved forward that listens beyond this computer never starts on its own; start it from the tab’s Port forwarding.</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Saved forwards that can't be saved as they are (blocks Save; the fields say which). */
export function forwardsProblem(list: ForwardSpec[] | undefined): string | null {
  for (const f of list ?? []) {
    const e = forwardErrors(draftOf(f))
    const first = e.bindHost ?? e.bindPort ?? e.destHost ?? e.destPort
    if (first) return `Port forward ${describeForward({ ...f, destHost: f.destHost || '…' })}: ${first}`
  }
  return null
}
