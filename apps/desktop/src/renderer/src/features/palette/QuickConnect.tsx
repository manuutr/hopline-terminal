import { SESSION_PLATFORM_LABELS as PLATFORM_LABELS } from '@hopline/guard'
import { Check, CornerDownLeft, Loader2, TriangleAlert, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn, CommandFooter, CommandInputRow, CommandSurface, commandInput } from '../../design'
import { recentEndpoints } from '../../lib/quick-history'
import { quickConnect } from '../../lib/connect'
import { parseQuickConnect, type QuickTarget } from '../../lib/quickconnect'
import { useUi } from '../../store'

const PROTO_LABEL: Record<QuickTarget['protocol'], string> = { ssh: 'SSH', telnet: 'Telnet', raw: 'Raw TCP', serial: 'Serial' }

/** One line describing what Enter will do: "SSH · admin@10.0.0.1:2222 · Cisco IOS-XE". */
export function describeTarget(t: QuickTarget): string {
  const s = t.serial
  const extra = s ? `${s.dataBits}${s.parity[0]!.toUpperCase()}${s.stopBits}${s.flow !== 'none' ? ' ' + s.flow : ''}` : PLATFORM_LABELS[t.platform]
  return [PROTO_LABEL[t.protocol], t.label, extra].join(' · ')
}

const EXAMPLES = ['admin@10.0.0.1:2222', 'ssh://admin@core-sw1', 'telnet://ts1:2003', 'serial:///dev/ttyUSB0?baud=115200']

/** Mod+O: connect to a host without saving it first. */
export function QuickConnect(): React.JSX.Element {
  const open = useUi((s) => s.quickOpen)
  const [pending, setPending] = useState<string | null>(null)
  const state = useUi((s) => pending ? s.tabs.find((tab) => tab.sessionId === pending)?.state : undefined)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const acceptHistory = (endpoint: string) => {
    setText(endpoint)
    input.current?.focus()
  }
  useEffect(() => {
    if (open) { setText(''); setPending(null) }
  }, [open])
  useEffect(() => {
    if (!open || state !== 'connected') return
    const timer = setTimeout(() => useUi.getState().set({ quickOpen: false }), 200)
    return () => clearTimeout(timer)
  }, [open, state])
  const suggestions = open ? recentEndpoints().filter((v) => v !== text && v.toLowerCase().includes(text.toLowerCase())).slice(0, 4) : []
  const parsed = parseQuickConnect(text)
  const close = () => useUi.getState().set({ quickOpen: false })
  const go = async () => {
    if (!parsed?.ok || pending) return
    setPending('opening')
    const session = await quickConnect(parsed.target)
    setPending(session?.id ?? null)
  }

  return (
    <CommandSurface
      open={open}
      onOpenChange={(o) => useUi.getState().set({ quickOpen: o })}
      title="Quick connect"
      description="Connect to a host without saving it"
      aria-describedby="quick-connect-hint"
    >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              go()
            }}
          >
            <CommandInputRow icon={<Zap />}>
              <input
                autoFocus
                ref={input}
                aria-autocomplete="list"
                aria-controls={suggestions.length && !pending ? 'quick-endpoints' : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && !pending && suggestions.length) {
                    e.preventDefault()
                    history.current?.querySelector('button')?.focus()
                  }
                }}
                spellCheck={false}
                aria-label="Quick connect"
                value={text}
                readOnly={!!pending}
                onChange={(e) => setText(e.target.value)}
                placeholder="user@host:port, telnet://host, serial:///dev/ttyUSB0"
                className={cn(commandInput, 'font-mono placeholder:font-sans')}
              />
            </CommandInputRow>
          </form>
          <div id="quick-connect-hint" className="px-4 py-3 text-sm" aria-live="polite">
            {parsed?.ok ? (
              <button type="button" disabled={!!pending} onClick={() => void go()} className="flex w-full cursor-default items-center gap-2.5 rounded-md bg-hover px-2 py-1.5 text-left text-fg">
                <span className="flex-1 truncate">
                  {state === 'connected' ? 'Connected: ' : state === 'down' ? 'Connection failed: ' : pending ? 'Connecting: ' : 'Connect: '}<span className="font-mono text-xs text-fg-muted">{describeTarget(parsed.target)}</span>
                </span>
                {state === 'connected' ? <Check className="animate-evidence-in text-ok" /> : pending && state !== 'down' ? <Loader2 className="animate-spin text-warn" /> : <CornerDownLeft className="size-3.5 text-fg-subtle" />}
              </button>
            ) : parsed && !parsed.ok ? (
              <p className="flex items-center gap-2 px-2 py-1.5 text-danger">
                <TriangleAlert className="size-3.5 shrink-0" />
                {parsed.error}
              </p>
            ) : (
              <div className="flex flex-col gap-1 px-2 py-1 text-xs text-fg-subtle">
                <span>Not saved: use “Save as session” on the tab to keep it.</span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono">
                  {EXAMPLES.map((x) => (
                    <button key={x} type="button" className="cursor-default hover:text-fg" onClick={() => setText(x)}>
                      {x}
                    </button>
                  ))}
                </span>
              </div>
            )}
            {state === 'down' && <button className="rounded px-2 py-1 text-accent" onClick={close}>Show connection details</button>}
            {!pending && suggestions.length > 0 && <div id="quick-endpoints" role="group" aria-label="Recent endpoints" ref={history} onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              const button = (e.target as HTMLElement).closest('button')
              if (!button) return
              e.preventDefault()
              const next = e.key === 'ArrowDown' ? button.nextElementSibling : button.previousElementSibling
              if (next instanceof HTMLButtonElement) next.focus()
              else input.current?.focus()
            }} className="mt-2 border-t border-line pt-2">
              <p className="mb-1 px-2 text-2xs text-fg-subtle">Recent endpoints</p>
              {suggestions.map((endpoint) => <button key={endpoint} type="button" className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-hover" onClick={() => acceptHistory(endpoint)}>{endpoint}</button>)}
            </div>}
          </div>
          <CommandFooter hints={[['Enter', 'connect'], ['Esc', 'close']]} />
    </CommandSurface>
  )
}
