import { useEffect, useRef, useState } from 'react'
import { CircleAlert, ShieldAlert } from 'lucide-react'
import type { PromptAnswer, PromptRequest } from '@shared/types'
import { Button, Dialog, Input, Label } from '@/design'

/**
 * Shows connection prompts (changed host key, MFA rounds, passphrases) one at a time.
 * Prompts queue: a reconnect storm can't stack dialogs on top of each other.
 */
export function PromptDialog(): React.JSX.Element | null {
  const [queue, setQueue] = useState<PromptRequest[]>([])
  useEffect(() => {
    const offAsk = window.hopline.prompts.onAsk((r) => setQueue((q) => [...q, r]))
    const offDone = window.hopline.prompts.onDone((id) => setQueue((q) => q.filter((r) => r.id !== id)))
    return () => {
      offAsk()
      offDone()
    }
  }, [])
  const current = queue[0]
  if (!current) return null
  const reply = (v: PromptAnswer) => {
    // By id: a prompt may have been answered elsewhere (onDone) or queued meanwhile.
    setQueue((q) => q.filter((r) => r.id !== current.id))
    void window.hopline.prompts.answer(current.id, v)
  }
  return <PromptBody key={current.id} req={current} reply={reply} />
}

function PromptBody({ req, reply }: { req: PromptRequest; reply: (v: PromptAnswer) => void }): React.JSX.Element {
  const p = req.prompt
  const where = req.sessionName ? `${req.sessionName} (${'host' in p ? p.host : ''})` : 'host' in p ? p.host : ''
  const [values, setValues] = useState<string[]>(() => (p.kind === 'keyboard-interactive' ? p.prompts.map(() => '') : ['']))
  const first = useRef<HTMLInputElement>(null)
  const safe = useRef<HTMLButtonElement>(null)
  // Radix focuses the first focusable element (the header's close button) once the portal has
  // mounted, which is after our effects run; Enter would then cancel. Pick the target here instead.
  const focusOnOpen = (target: React.RefObject<HTMLElement | null>) => (e: Event) => {
    if (!target.current) return
    e.preventDefault()
    target.current.focus()
  }

  if (p.kind === 'host-key-changed') {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && reply(false)}
        onOpenAutoFocus={focusOnOpen(safe)}
        title="Host key changed"
        description={`${where}:${p.port} presented a different key than the one you trusted before.`}
        footer={
          <>
            <Button ref={safe} variant="secondary" autoFocus onClick={() => reply(false)}>
              Don't connect
            </Button>
            <Button variant="danger" onClick={() => reply(true)}>
              Replace key and connect
            </Button>
          </>
        }
      >
        <div className="flex gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p>
            This happens after a device is replaced, re-imaged or its keys are regenerated. It can also mean someone is intercepting the connection. Replace the key
            only if you know why it changed.
          </p>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-fg-subtle">Trusted</dt>
          <dd className="break-all font-mono">{p.known}</dd>
          <dt className="text-fg-subtle">Offered now</dt>
          <dd className="break-all font-mono text-warn">{p.offered}</dd>
        </dl>
      </Dialog>
    )
  }

  const fields = p.kind === 'keyboard-interactive' ? p.prompts : [{ prompt: p.label, echo: false }]
  const title = p.kind === 'keyboard-interactive' ? p.name || 'Authentication' : p.secret === 'passphrase' ? 'Key passphrase' : 'Password'
  // An empty k-i instructions line used to read "<host> asks:" with nothing after it (P2-6).
  const host = 'host' in p ? p.host : ''
  const description =
    p.kind === 'keyboard-interactive'
      ? p.instructions || [req.sessionName && req.sessionName !== host ? `${req.sessionName} (${host})` : host, 'keyboard-interactive'].filter(Boolean).join(' · ')
      : `${where} needs your ${p.secret}. It is used for this connection only.`
  const errorId = `prompt-error-${req.id}`
  const submit = () => reply(p.kind === 'keyboard-interactive' ? values : values[0] ?? '')
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && reply(null)}
      onOpenAutoFocus={focusOnOpen(first)}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => reply(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Continue
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {fields.map((f, i) => (
          <div key={i} className="space-y-1">
            <Label htmlFor={`prompt-${i}`}>{f.prompt.replace(/:\s*$/, '')}</Label>
            <Input
              id={`prompt-${i}`}
              ref={i === 0 ? first : undefined}
              autoFocus={i === 0}
              aria-invalid={i === 0 && !!req.error ? true : undefined}
              aria-describedby={i === 0 && req.error ? errorId : undefined}
              type={f.echo ? 'text' : 'password'}
              autoComplete={f.echo ? 'one-time-code' : 'off'}
              value={values[i] ?? ''}
              onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </div>
        ))}
        {req.error && (
          <p id={errorId} role="alert" className="flex items-start gap-1.5 text-xs text-danger">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {req.error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
