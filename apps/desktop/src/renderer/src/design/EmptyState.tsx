import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export function EmptyState({
  icon = <Inbox />,
  title,
  body,
  action,
  className
}: {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-start gap-2 px-4 py-5 text-left animate-fade-in', className)}>
      <span aria-hidden className="text-fg-muted [&_svg]:size-4">{icon}</span>
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-fg">{title}</div>
        {body && <div className="max-w-sm text-xs leading-relaxed text-fg-muted">{body}</div>}
      </div>
      {action}
    </div>
  )
}
