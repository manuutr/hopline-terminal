import { Popover } from 'radix-ui'
import { StatusDot } from '../../design'
import type { Tab } from '../../store'
import { elapsed, useSignals } from '../terminal/liveness'

function Details({ tab }: { tab: Tab }) {
  const vitals = useSignals((s) => s[tab.tabId]?.vitals)
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
    <dt>State</dt><dd>{tab.state}</dd>
    {vitals?.steps.map((step, i) => <div key={step + i} className="contents"><dt>Step {i + 1}</dt><dd>{step}</dd></div>)}
    {vitals?.connectedAt && <><dt>Connected</dt><dd>{new Date(vitals.connectedAt).toLocaleTimeString()}</dd></>}
    {vitals?.sampledAt && <><dt>Device echo</dt><dd>{vitals.echoRtt} ms · {elapsed(Date.now() - vitals.sampledAt)} ago</dd></>}
    <dt>Encoding</dt><dd>UTF-8</dd>
  </dl>
}
export function ConnectionDetails({ tab, name }: { tab: Tab; name: string }) {
  return <Popover.Root>
    <Popover.Trigger className="inline-flex shrink-0 items-center gap-1.5 text-fg-muted hover:text-fg" aria-label={'Connection details for ' + name}><StatusDot state={tab.state} />{name}</Popover.Trigger>
    <Popover.Portal><Popover.Content side="top" align="start" sideOffset={8} aria-label={'Connection details for ' + name}
      onCloseAutoFocus={(event) => {
        // A keyboard shortcut can open another dialog while this popover is unmounting.
        const active = document.activeElement
        if (active && active !== document.body && event.currentTarget instanceof HTMLElement && !event.currentTarget.contains(active)) {
          event.preventDefault()
        }
      }}
      className="z-50 max-w-sm rounded-md border border-line bg-overlay p-3 text-fg-muted shadow-overlay">
      <p className="mb-2 font-medium text-fg">{name}</p><Details tab={tab} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
