import { ViewerGrip } from '../../design/ViewerGrip'
import { useMemo, useState } from 'react'
import { cn, DataTable } from '../../design'
import { diffTables } from '../../lib/table'
import { fmtTime } from '../../lib/when'
import type { BlockController } from './controller'
import { useBlocks } from './store'

/**
 * Parsed show output as a table, docked over the lower part of the terminal pane (design/DataTable:
 * sort, filter, columns, CSV/TSV), plus what changed since the previous run of the same command on
 * this session. Keyboard: / filters, Esc clears the filter, then closes back to the terminal.
 */
export function TableView({ ctl }: { ctl: BlockController }): React.JSX.Element | null {
  const tabId = ctl.tabId
  const blockId = useBlocks((s) => s.table[tabId] ?? null)
  const parsed = useBlocks((s) => (blockId == null ? undefined : s.parsed[tabId]?.[blockId]))
  const block = ctl.byId(blockId)
  const [showChanges, setShowChanges] = useState(true)
  const diff = useMemo(() => (parsed?.prev ? diffTables(parsed.prev.result, parsed.result) : undefined), [parsed])

  if (!parsed || !block) return null
  const { result } = parsed
  const close = () => {
    useBlocks.getState().openTable(tabId, null)
    ctl.term.focus()
  }
  const changes = diff?.comparable ? diff.status.filter((s) => s !== 'same').length + diff.removed.length : 0
  const since = parsed.prev ? fmtTime(parsed.prev.at, true) : ''
  const extra = diff?.comparable ? (
    <button
      type="button"
      aria-pressed={showChanges}
      aria-label={changes ? `${changes} change${changes === 1 ? '' : 's'} since ${since}` : `No changes since ${since}`}
      onClick={() => setShowChanges(!showChanges)}
      className={cn(
        'flex h-6 min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-2xs transition-colors duration-[var(--dur-fast)]',
        showChanges ? 'bg-warn-soft text-warn' : 'text-fg-subtle hover:bg-hover hover:text-fg'
      )}
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', changes ? 'bg-warn' : 'bg-ok')} />
      <span className="truncate">
        {changes ? `${changes} change${changes === 1 ? '' : 's'}` : 'No changes'}
        <span className="hidden @[480px]/table:inline"> since {since}</span>
      </span>
    </button>
  ) : (
    <span className="hidden min-w-0 truncate whitespace-nowrap text-2xs text-fg-subtle @[400px]/table:inline">
      First run<span className="hidden @[560px]/table:inline"> · changes show from the next one</span>
    </span>
  )

  return (
    <div data-table-drawer className="table-drawer absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col border-t border-line-strong bg-surface shadow-overlay animate-pop-in">
      <ViewerGrip onClose={close} />
      <DataTable
        label={`Table: ${block.command}`}
        testId="block-table"
        headers={result.headers}
        rows={result.rows}
        title={block.command}
        extra={extra}
        diff={showChanges ? diff : undefined}
        source={`TextFSM · ${result.template.replace(/\.textfsm$/, '')}`}
        onClose={close}
        autoFocusFilter
        resetKey={blockId}
        className="flex-1"
      />
    </div>
  )
}
