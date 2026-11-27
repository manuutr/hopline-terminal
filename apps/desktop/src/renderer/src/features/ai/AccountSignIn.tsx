import { useEffect, useRef, useState } from 'react'
import { ACCOUNTS, type AccountAction, type AccountProvider, type AccountState } from '@shared/providers'
import { Button } from '../../design'

export function AccountSignIn({ provider, onUse }: { provider: AccountProvider; onUse?: () => void }) {
  const [state, setState] = useState<AccountState>({ phase: 'idle' })
  const [pending, setPending] = useState(false)
  const revision = useRef(0)
  const client = ACCOUNTS[provider]
  const waiting = state.phase === 'starting' || state.phase === 'authorize'
  useEffect(() => {
    let live = true
    const version = revision.current
    const poll = async () => {
      try {
        const next = await window.hopline.ai.account(provider, 'status')
        if (live && version === revision.current) setState(next)
      } catch {
        if (live && version === revision.current) setState({ phase: 'error', message: 'Could not read the sign-in status.' })
      }
    }
    void poll()
    const timer = waiting ? setInterval(() => void poll(), 1000) : undefined
    return () => { live = false; clearInterval(timer) }
  }, [provider, waiting])
  useEffect(() => () => { revision.current++ }, [])

  const act = async (action: AccountAction) => {
    const version = ++revision.current
    setPending(true)
    try {
      const next = await window.hopline.ai.account(provider, action)
      if (version === revision.current) setState(next)
    } catch {
      if (version === revision.current) setState({ phase: 'error', message: 'Could not update the provider connection.' })
    } finally {
      if (version === revision.current) setPending(false)
    }
  }

  return <div className="space-y-2 text-xs" aria-label={client.label + ' account'}>
    <p className="leading-snug text-fg-muted">Use your subscription through {client.client}. You choose which suggested device commands to run.</p>
    <div className="space-y-1" role="status">
      {state.phase === 'starting' && 'Waiting for the provider to start sign-in…'}
      {state.phase === 'error' && <span className="text-warn">{state.message}</span>}
      {state.phase === 'authorize' && <>Enter this code on the provider’s verification page. <strong className="select-all font-mono">{state.code}</strong></>}
      {state.phase === 'connected' && 'Account connected'}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {(state.phase === 'idle' || state.phase === 'error') && <>
        <Button variant="primary" disabled={pending} onClick={() => void act('start')}>Sign in with {client.label}</Button>
        <Button variant="ghost" onClick={() => void window.hopline.links.open(client.install)}>Install {client.client}</Button>
      </>}
      {state.phase === 'authorize' && <Button variant="primary" onClick={() => void window.hopline.links.open(state.verificationUrl)}>Open verification page</Button>}
      {(state.phase === 'starting' || state.phase === 'authorize') && <Button disabled={pending} onClick={() => void act('cancel')}>Cancel sign-in</Button>}
      {state.phase === 'connected' && <>
        {onUse && <Button variant="primary" onClick={onUse}>Use {client.label}</Button>}
        <Button variant="ghost" disabled={pending} onClick={() => void act('disconnect')}>Disconnect account</Button>
      </>}
    </div>
  </div>
}
