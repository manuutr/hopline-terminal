import { Loader2, ShieldOff } from 'lucide-react'
import type { Tab } from '../../store'
import { openSetPlatform, useTabPlatform } from './PlatformDetect'

/**
 * One line above the AI composer (and the terminal's status bar) while a device is unidentified:
 * the guard default-denies every AI command on it, so say so and offer the fix.
 */
export function PlatformNotice({ tab }: { tab: Pick<Tab, 'tabId' | 'sessionId' | 'state'> }): React.JSX.Element | null {
  const p = useTabPlatform(tab)
  if (p?.state === 'detecting')
    return (
      <div role="status" className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs text-fg-subtle">
        <Loader2 className="size-3.5 animate-spin" /> Identifying the device…
      </div>
    )
  if (p?.state !== 'unknown') return null
  return (
    <div role="status" className="flex items-center gap-2 border-t border-warn/25 bg-warn-soft px-3 py-1.5 text-xs text-warn">
      <ShieldOff className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Platform unknown — AI commands blocked</span>
      <button className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => openSetPlatform(tab.sessionId)}>
        Set platform
      </button>
    </div>
  )
}
