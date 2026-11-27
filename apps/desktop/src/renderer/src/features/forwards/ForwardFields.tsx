import { AlertTriangle } from 'lucide-react'
import type { ForwardKind, ForwardSpec } from '@shared/files'
import { isExposedBind } from '@shared/files'
import { cn, Input, Label, SelectMenu } from '../../design'

/**
 * One layout and one set of labels for a port forward (round 2): the tab's Port forwarding dialog
 * and the session editor's saved forwards both render this. Errors show under the field they are
 * about (aria-invalid + text), never as a toast.
 */
export const FORWARD_KINDS: { value: ForwardKind; label: string; hint: string }[] = [
  { value: 'L', label: 'Local (-L)', hint: 'A port here reaches a host through the device.' },
  { value: 'R', label: 'Remote (-R)', hint: 'A port on the device reaches a host here. The device must allow remote forwarding.' },
  { value: 'D', label: 'SOCKS (-D)', hint: 'A SOCKS5 proxy here; connections leave through the device.' }
]

export type ForwardDraft = Pick<ForwardSpec, 'kind' | 'bindHost' | 'destHost'> & { bindPort: string; destPort: string }
export type ForwardErrors = Partial<Record<'bindHost' | 'bindPort' | 'destHost' | 'destPort', string>>

export const draftOf = (f: ForwardSpec): ForwardDraft => ({
  kind: f.kind,
  bindHost: f.bindHost,
  bindPort: String(f.bindPort ?? ''),
  destHost: f.destHost ?? '',
  destPort: f.destPort === undefined ? '' : String(f.destPort)
})

const port = (v: string): number => (v.trim() === '' ? NaN : Number(v))

/** Field-level problems for a forward. An empty listen port means any free one (1080 for SOCKS). */
export function forwardErrors(d: ForwardDraft): ForwardErrors {
  const e: ForwardErrors = {}
  const bp = port(d.bindPort || (d.kind === 'D' ? '1080' : '0'))
  if (/\s/.test(d.bindHost)) e.bindHost = 'No spaces in an address.'
  if (!Number.isInteger(bp) || bp < 0 || bp > 65535) e.bindPort = 'A port from 0 to 65535 (0 picks a free one).'
  if (d.kind !== 'D') {
    if (!(d.destHost ?? '').trim()) e.destHost = 'Enter the host to reach.'
    else if (/\s/.test(d.destHost ?? '')) e.destHost = 'No spaces in an address.'
    const dp = port(d.destPort)
    if (!Number.isInteger(dp) || dp < 1 || dp > 65535) e.destPort = 'A port from 1 to 65535.'
  }
  return e
}

const FieldError = ({ id, text }: { id: string; text?: string }) => (text ? <span id={id} className="mt-1 block text-2xs text-danger">{text}</span> : null)

export function ForwardFields({
  idPrefix,
  value,
  onChange,
  errors = {},
  compact
}: {
  /** Field ids: `${idPrefix}-kind`, `-bind`, `-bport`, `-dest`, `-dport`. */
  idPrefix: string
  value: ForwardDraft
  onChange: (patch: Partial<ForwardDraft>) => void
  errors?: ForwardErrors
  /** Smaller text for lists of several forwards. */
  compact?: boolean
}): React.JSX.Element {
  const k = value.kind
  const id = (s: string) => `${idPrefix}-${s}`
  const text = compact ? 'text-xs' : ''
  const err = (f: keyof ForwardErrors) => ({ 'aria-invalid': !!errors[f], 'aria-describedby': errors[f] ? id(`${f}-err`) : undefined })
  const hint = FORWARD_KINDS.find((x) => x.value === k)!.hint
  return (
    <div>
      <div className="grid grid-cols-6 gap-2">
        <div className="col-span-6 sm:col-span-2">
          <Label htmlFor={id('kind')}>Type</Label>
          <SelectMenu id={id('kind')} aria-label="Forward type" value={k} onValueChange={(kind) => onChange({ kind })} options={FORWARD_KINDS.map((x) => ({ value: x.value, label: x.label }))} className={cn('mt-1', text)} />
        </div>
        <div className="col-span-4 sm:col-span-2">
          <Label htmlFor={id('bind')}>{k === 'R' ? 'Listen on (device)' : 'Listen on'}</Label>
          <Input id={id('bind')} value={value.bindHost} onChange={(e) => onChange({ bindHost: e.target.value })} className={cn('mt-1 font-mono', text)} {...err('bindHost')} />
          <FieldError id={id('bindHost-err')} text={errors.bindHost} />
        </div>
        <div className="col-span-2 sm:col-span-2">
          <Label htmlFor={id('bport')}>Port</Label>
          <Input
            id={id('bport')}
            inputMode="numeric"
            value={value.bindPort}
            onChange={(e) => onChange({ bindPort: e.target.value.replace(/\D/g, '').slice(0, 5) })}
            placeholder={k === 'D' ? '1080' : 'any'}
            className={cn('mt-1 font-mono', text)}
            {...err('bindPort')}
          />
          <FieldError id={id('bindPort-err')} text={errors.bindPort} />
        </div>
        {k !== 'D' && (
          <>
            <div className="col-span-4">
              <Label htmlFor={id('dest')}>{k === 'L' ? 'To host (as the device sees it)' : 'To host (from this computer)'}</Label>
              <Input id={id('dest')} value={value.destHost ?? ''} onChange={(e) => onChange({ destHost: e.target.value })} placeholder={k === 'L' ? '10.0.0.1' : '127.0.0.1'} className={cn('mt-1 font-mono', text)} {...err('destHost')} />
              <FieldError id={id('destHost-err')} text={errors.destHost} />
            </div>
            <div className="col-span-2">
              <Label htmlFor={id('dport')}>Port</Label>
              <Input
                id={id('dport')}
                inputMode="numeric"
                value={value.destPort}
                onChange={(e) => onChange({ destPort: e.target.value.replace(/\D/g, '').slice(0, 5) })}
                placeholder="443"
                className={cn('mt-1 font-mono', text)}
                {...err('destPort')}
              />
              <FieldError id={id('destPort-err')} text={errors.destPort} />
            </div>
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-fg-subtle">{hint}</p>
      {isExposedBind(value.bindHost.trim()) && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-warn">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {k === 'R' ? 'The device will listen on all of its interfaces' : 'Anyone on your network can reach this port'}. Use 127.0.0.1 unless you mean to share it.
        </p>
      )}
    </div>
  )
}
