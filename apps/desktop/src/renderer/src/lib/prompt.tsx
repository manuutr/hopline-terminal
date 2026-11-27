import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Button, Dialog, Input } from '../design'

interface PromptState {
  req: { title: string; value: string; secret?: boolean; description?: string; resolve: (v: string | null) => void } | null
}
const usePrompt = create<PromptState>(() => ({ req: null }))

/** Electron has no window.prompt(); this is the in-app replacement. */
export function askText(title: string, value = '', opts: { secret?: boolean; description?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ req: { title, value, ...opts, resolve } }))
}

export function PromptHost(): React.JSX.Element {
  const req = usePrompt((s) => s.req)
  const [v, setV] = useState('')
  const input = useRef<HTMLInputElement>(null)
  // Read the DOM value on submit: state can lag a frame behind fast input.
  const current = () => input.current?.value ?? v
  useEffect(() => setV(req?.value ?? ''), [req])
  const done = (val: string | null) => {
    req?.resolve(val)
    usePrompt.setState({ req: null })
  }
  return (
    <Dialog
      open={!!req}
      onOpenChange={(o) => !o && done(null)}
      title={req?.title ?? ''}
      description={req?.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => done(current())}>OK</Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), done(current()))}>
        <Input ref={input} autoFocus type={req?.secret ? 'password' : 'text'} value={v} onChange={(e) => setV(e.target.value)} />
      </form>
    </Dialog>
  )
}
