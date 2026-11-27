import { Folder as FolderIcon, Server, Tag } from 'lucide-react'
import type { MentionSuggestion } from '@shared/mentions'
export { mentionComplete, mentionKey } from '@shared/mentions'

import { cn } from '../../design'

/**
 * The @-mention suggestion list (F11), used by the panel composer and the terminal's "@ai" line.
 * Keyboard-first: the owner of the text field handles ↑↓, Tab/Enter and Esc and passes `index`;
 * a click picks too. Dense rows in the hint-list style (overlay surface, 24 px rows, name + host).
 */
export function MentionList({ id, items, index, onPick, className, style }: { id: string; items: MentionSuggestion[]; index: number; onPick: (i: number) => void; className?: string; style?: React.CSSProperties }): React.JSX.Element {
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Devices"
      data-testid="mention-list"
      style={style}
      className={cn('z-20 min-w-56 max-w-80 rounded-md bg-overlay p-[3px] text-xs shadow-overlay animate-fade-in', className)}
      onMouseDown={(e) => e.preventDefault() /* keep the focus in the field */}
    >
      {items.length === 0 ? (
        <div className="flex h-6 items-center px-1.5 text-fg-subtle">No saved session matches</div>
      ) : (
        items.map((s, i) => (
          <div
            key={`${s.kind}:${s.name}`}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === index}
            data-name={s.name}
            onClick={() => onPick(i)}
            className={cn('flex h-6 cursor-default items-center gap-1.5 rounded px-1.5 [&_svg]:size-3 [&_svg]:shrink-0', i === index ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-hover')}
          >
            <span aria-hidden className="text-fg-subtle">
              {s.kind === 'tag' ? <Tag /> : s.kind === 'folder' ? <FolderIcon /> : <Server />}
            </span>
            <span className="min-w-0 truncate text-fg">{s.kind === 'tag' ? `#${s.name}` : s.name}</span>
            <span className="ml-auto shrink-0 pl-3 font-mono text-2xs text-fg-subtle">{s.detail}</span>
          </div>
        ))
      )}
      <div aria-hidden className="flex h-5 items-center gap-2 border-t border-line px-1.5 pt-px text-2xs text-fg-subtle">
        <span>↑↓ choose</span>
        <span>Tab or Enter insert</span>
        <span>Esc close</span>
      </div>
    </div>
  )
}

