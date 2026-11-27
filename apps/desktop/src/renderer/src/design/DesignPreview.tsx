import { Check, Loader2, Moon, Server, ShieldAlert, Sun, Terminal, X } from 'lucide-react'
import { toast } from '../lib/notify'
import { Badge, Button, EmptyState, Input, Kbd, Label, PanelHeader, StatusDot, Tooltip } from '.'
import { toggleTheme } from './theme'

const swatches = [
  ['canvas', 'bg-canvas'],
  ['surface', 'bg-surface'],
  ['raised', 'bg-raised'],
  ['overlay', 'bg-overlay'],
  ['accent', 'bg-accent'],
  ['ok', 'bg-ok'],
  ['warn', 'bg-warn'],
  ['danger', 'bg-danger']
] as const

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium text-fg-subtle">{title}</h2>
      {children}
    </section>
  )
}

/** Living style guide. Open with #/design or "Design system" in the command palette. */
export function DesignPreview(): React.JSX.Element {
  return (
    <div className="h-full overflow-auto bg-canvas">
      <div className="mx-auto max-w-4xl space-y-10 p-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Hopline design system</h1>
            <p className="text-sm text-fg-muted">Tokens and primitives. Every screen is built from these.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
            <Sun className="hidden dark:block" />
            <Moon className="dark:hidden" />
          </Button>
        </header>

        <Section title="Color">
          <div className="grid grid-cols-8 gap-3">
            {swatches.map(([name, cls]) => (
              <div key={name} className="space-y-1.5">
                <div className={`h-12 rounded-md border border-line ${cls}`} />
                <div className="text-2xs text-fg-muted">{name}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type">
          <div className="space-y-2 rounded-lg border border-line bg-surface p-5">
            <div className="text-xl font-semibold tracking-tight">Why is BGP to 10.0.0.2 down?</div>
            <div className="text-base">Body text at 14px, used in the AI panel.</div>
            <div className="text-sm text-fg-muted">UI text at 13px, the default everywhere else.</div>
            <div className="text-2xs text-fg-subtle">Section label, 11px</div>
            <pre className="selectable rounded-md bg-term p-3 font-mono text-[13px] leading-5 text-fg">
              {`core-sw1#show ip bgp summary\nNeighbor     V   AS  MsgRcvd  State/PfxRcd\n10.0.0.2     4 65002      0  Idle`}
            </pre>
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Connect</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="ok"><Check />Approve</Button>
            <Button variant="danger"><X />Reject</Button>
            <Button size="sm">Small</Button>
            <Tooltip label="New tab" shortcut="Mod+T">
              <Button variant="ghost" size="icon" aria-label="New tab"><Terminal /></Button>
            </Tooltip>
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="Inputs">
          <div className="grid max-w-md grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Host</Label><Input placeholder="10.0.0.1" /></div>
            <div className="space-y-1"><Label>Port</Label><Input defaultValue="22" /></div>
          </div>
        </Section>

        <Section title="Status">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            {(['connected', 'connecting', 'reconnecting', 'down', 'idle'] as const).map((s) => (
              <span key={s} className="flex items-center gap-1.5"><StatusDot state={s} />{s}</span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge>IOS-XE</Badge>
            <Badge tone="accent">read-only</Badge>
            <Badge tone="ok">ok</Badge>
            <Badge tone="warn">config</Badge>
            <Badge tone="danger">blocked</Badge>
          </div>
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            Open palette <Kbd keys="Mod+K" /> · Switch session <Kbd keys="Mod+P" />
          </div>
        </Section>

        <Section title="Agent step">
          <div className="max-w-md space-y-1.5 rounded-lg border border-line bg-surface p-2">
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-xs">
              <Check className="size-3.5 text-ok" />
              <span className="flex-1">show ip bgp summary</span>
              <span className="text-fg-subtle">0.4s</span>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-hover px-2 py-1.5 font-mono text-xs">
              <Loader2 className="size-3.5 animate-spin text-accent" />
              <span className="flex-1">show ip bgp neighbors 10.0.0.2</span>
            </div>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-xs">
              <ShieldAlert className="size-3.5 text-danger" />
              <span className="flex-1 text-fg-muted line-through">reload</span>
              <Badge tone="danger">blocked</Badge>
            </div>
          </div>
        </Section>

        <Section title="Toasts">
          <div className="flex gap-2">
            <Button onClick={() => toast.success('Connected to core-sw1')}>Success</Button>
            <Button onClick={() => toast.error('Connection to edge-r2 lost', { description: 'Reconnecting in 5s' })}>
              Error
            </Button>
          </div>
        </Section>

        <Section title="Panel + empty state">
          <div className="max-w-sm overflow-hidden rounded-lg border border-line bg-surface">
            <PanelHeader title="Sessions" />
            <EmptyState
              icon={<Server />}
              title="No sessions yet"
              body="Add a device or import your saved sessions."
              action={<Button variant="primary" size="sm">New session</Button>}
            />
          </div>
        </Section>
      </div>
    </div>
  )
}
