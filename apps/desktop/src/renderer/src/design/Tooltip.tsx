import { Tooltip as T } from 'radix-ui'
import type { ReactNode } from 'react'
import { Kbd } from './Kbd'

export const TooltipProvider = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <T.Provider delayDuration={400} skipDelayDuration={150}>
    {children}
  </T.Provider>
)

export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  children
}: {
  label: string
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}): React.JSX.Element {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          className="z-50 animate-fade-in data-[side=bottom]:pt-1.5 data-[side=top]:pb-1.5 data-[side=left]:pr-1.5 data-[side=right]:pl-1.5"
        >
          {/* Keep the visual gap inside the hit area, including after Popper flips sides. */}
          <div className="flex items-center gap-2 rounded-md bg-overlay px-2 py-1 text-xs text-fg shadow-overlay">
            {label}
            {shortcut && <Kbd keys={shortcut} />}
          </div>
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
