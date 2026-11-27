import { Bell, CircleSlash, CircleX, Hand, Loader2, RefreshCw, ShieldOff } from 'lucide-react'
import { SessionSignal } from '../terminal/ConnectionStrip'
import { cn, Tooltip } from '../../design'
import { findPane, panes, topGlyph, type Glyph } from '../../lib/layout'
import { useUi, type Tab, type Workspace } from '../../store'
import { useAi } from '../ai/store'
import { useUnknownPlatform } from '../sessions/PlatformDetect'

export const GLYPH_LABEL: Record<Glyph, string> = {
  approval: 'Assistant needs your approval',
  auth: 'Authentication failed',
  down: 'Disconnected',
  reconnecting: 'Reconnecting…',
  config: 'Configuration mode',
  unknown: 'Platform unknown — AI commands blocked',
  bell: 'Bell',
  unread: 'New output',
  connecting: 'Connecting…'
}

/**
 * One 16 px status glyph. Every state has its own shape (never colour alone) plus a tooltip and
 * an accessible label.
 */
export function StatusGlyph({ glyph, className, tooltip = true }: { glyph: Glyph; className?: string; tooltip?: boolean }): React.JSX.Element {
  const label = GLYPH_LABEL[glyph]
  const body = (() => {
    switch (glyph) {
      case 'approval':
        return (
          <span className="flex size-3.5 animate-attention items-center justify-center rounded-full bg-accent text-accent-fg">
            <Hand className="size-2.5" strokeWidth={2.5} />
          </span>
        )
      case 'auth':
        return <CircleX className="size-3.5 text-danger" />
      case 'down':
        return <CircleSlash className="size-3.5 text-fg-subtle" />
      case 'reconnecting':
        return <RefreshCw className="size-3.5 animate-spin text-warn [animation-duration:1.6s] motion-reduce:animate-none" />
      case 'config':
        return <span className="rounded-sm bg-warn-soft px-1 text-[10px] font-semibold leading-[14px] tracking-wide text-warn">CFG</span>
      case 'unknown':
        return <ShieldOff className="size-3.5 text-warn" />
      case 'bell':
        return <Bell className="size-3.5 text-fg" />
      case 'unread':
        return <span className="size-1.5 rounded-full bg-accent" />
      case 'connecting':
        return <Loader2 className="size-3.5 animate-spin text-fg-subtle motion-reduce:animate-none" />
    }
  })()
  const el = (
    <span role="img" aria-label={label} data-glyph={glyph} className={cn('flex h-4 min-w-4 shrink-0 items-center justify-center', className)}>
      {body}
    </span>
  )
  return tooltip ? <Tooltip label={label}>{el}</Tooltip> : el
}

const pendingApproval = (byTab: ReturnType<typeof useAi.getState>['byTab'], tabId: string) =>
  !!byTab[tabId]?.entries.some((e) => e.kind === 'proposal' && e.state === 'pending')

/** The tab-bar view of a workspace: its title (focused pane's session) and its most urgent glyph. */
export function useWorkspaceSummary(ws: Workspace): { title: string; glyph: Glyph | undefined; tabs: Tab[]; focused: Tab | undefined } {
  const allTabs = useUi((s) => s.tabs)
  const byTab = useAi((s) => s.byTab)
  const ids = panes(ws.root).flatMap((p) => (p.tabId ? [p.tabId] : []))
  const tabs = ids.map((id) => allTabs.find((t) => t.tabId === id)).filter((t): t is Tab => !!t)
  const focusedId = findPane(ws.root, ws.focusedPaneId)?.tabId
  const focused = tabs.find((t) => t.tabId === focusedId)
  const title = focused?.title ?? tabs[0]?.title ?? 'Connect to…'
  const unknown = useUnknownPlatform()
  const glyph = topGlyph(tabs.map((t) => ({ ...t, needsApproval: pendingApproval(byTab, t.tabId) || undefined, platformUnknown: unknown(t) })))
  return { title, glyph, tabs, focused }
}

/**
 * A saved session's live state in lists (tree, switcher): the same glyph its tab shows, or a small
 * green dot for a quiet, connected session (tabs need no mark for that; lists do). Nothing when it
 * has no open tab.
 */
export function SessionStatus({ tabs, className }: { tabs: Tab[]; className?: string }): React.JSX.Element | null {
  const byTab = useAi((s) => s.byTab)
  const unknown = useUnknownPlatform()
  if (!tabs.length) return <SessionSignal />
  const glyph = topGlyph(tabs.map((t) => ({ ...t, needsApproval: pendingApproval(byTab, t.tabId) || undefined, platformUnknown: unknown(t) })))
  const tab = tabs.find((t) => t.state === 'connected') ?? tabs[0]
  if (glyph && !['connecting', 'down', 'reconnecting', 'unread'].includes(glyph)) return <StatusGlyph glyph={glyph} className={className} />
  return <SessionSignal tab={tab} />
}

export function useTabGlyph(tab: Tab): Glyph | undefined {
  const approval = useAi((s) => pendingApproval(s.byTab, tab.tabId))
  return topGlyph([{ ...tab, needsApproval: approval }])
}
