import type { ReactNode } from 'react'
import { cn } from './cn'

/** The 36px header strip used by every collapsible panel. */
export function PanelHeader({
  title,
  children,
  className,
  titleClassName
}: {
  title: ReactNode
  children?: ReactNode
  className?: string
  /** `flex-none`: the title keeps its width and the controls give way instead. */
  titleClassName?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex h-9 shrink-0 items-center gap-1 border-b border-line px-3', className)}>
      <div data-panel-title className={cn('min-w-0 flex-1 truncate text-xs font-medium text-fg-muted', titleClassName)}>{title}</div>
      {children}
    </div>
  )
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }): React.JSX.Element {
  return <div className={cn(vertical ? 'w-px self-stretch' : 'h-px w-full', 'bg-line', className)} />
}
