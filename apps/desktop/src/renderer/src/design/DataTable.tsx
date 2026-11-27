import { ArrowDown, ArrowUp, Check, Columns3, Copy, MoreHorizontal, Search, X } from 'lucide-react'
import { DropdownMenu as DM } from 'radix-ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../lib/notify'
import type { Cell } from '@hopline/parsers'
import { writeClipboard } from '../lib/clipboard'
import { cellText, compareCells, toDelimited, type TableDiff } from '../lib/table'
import { Button } from './Button'
import { cn } from './cn'
import { Input } from './Input'
import { Kbd } from './Kbd'
import { Tooltip } from './Tooltip'

const menuItem = 'flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-fg-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg [&_svg]:size-3.5'
const menuContent = 'z-50 max-h-[50vh] min-w-48 overflow-auto rounded-md bg-overlay p-1 shadow-overlay animate-pop-in'

/** Words that stay upper case in a humanized header. */
const KEEP = new Set(['ip', 'mac', 'vlan', 'vrf', 'id', 'mtu', 'bgp', 'ospf', 'as', 'cpu', 'ipv4', 'ipv6', 'lldp', 'cdp', 'nat', 'acl', 'sn', 'pid', 'vid', 'stp', 'ntp', 'os', 'ios', 'rx', 'tx', 'crc', 'poe', 'uptime_s'])

/** TextFSM value names read as sentence case: `SOFTWARE_IMAGE` → "Software image", `IP_ADDRESS` → "IP address". */
export function humanizeHeader(h: string): string {
  if (!/^[A-Z0-9_]+$/.test(h)) return h
  const words = h.toLowerCase().split('_').filter(Boolean)
  return words.map((w, i) => (KEEP.has(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ')
}

export interface DataTableProps {
  /** Accessible name of the region and the table. */
  label: string
  headers: string[]
  rows: Cell[][]
  /** Left of the header: what the table is (a command, a device). */
  title?: React.ReactNode
  /** Extra header controls (a "changes since" pill, a per-device / all-devices switch). */
  extra?: React.ReactNode
  /** "Changed since last run" marks: row status, changed cells, removed rows. */
  diff?: TableDiff
  /** Left of the footer (the template name). */
  source?: React.ReactNode
  /** Shown: Esc closes (once the filter is empty) and the header gets a close button. */
  onClose?: () => void
  /** Focus the filter on mount and whenever `resetKey` changes (without scrolling anything). */
  autoFocusFilter?: boolean
  /** Changing it clears filter, sort and hidden columns (a different block or device). */
  resetKey?: unknown
  className?: string
  testId?: string
  emptyMessage?: string
}

/**
 * The one table (round 2): block tables in a terminal pane and the multi-device Table tab. Sort by
 * any column, filter, choose columns, copy as CSV or TSV, humanized headers. The header wraps under
 * 480 px of its own width (container query): copy, columns and close fold into one menu and the
 * filter takes the row, so it works in a 230 px split pane. Keyboard: / filters, Esc clears the
 * filter, then closes.
 */
export function DataTable({ label, headers, rows, title, extra, diff, source, onClose, autoFocusFilter, resetKey, className, testId, emptyMessage }: DataTableProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setFilter('')
    setSort(null)
    setHidden(new Set())
  }, [resetKey])
  useLayoutEffect(() => {
    if (!autoFocusFilter) return
    // Synchronously, so a key pressed right after opening lands in the table; preventScroll: focusing
    // must never drag the pane (or xterm's scroller) sideways. Again next frame, after a click's own focus.
    filterRef.current?.focus({ preventScroll: true })
    const raf = requestAnimationFrame(() => {
      if (!filterRef.current?.closest('[role=region]')?.contains(document.activeElement)) filterRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [autoFocusFilter, resetKey])

  const view = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    let idx = rows.map((_, i) => i)
    if (needle) idx = idx.filter((i) => rows[i]!.some((c) => cellText(c).toLowerCase().includes(needle)))
    if (sort) idx.sort((a, b) => sort.dir * compareCells(cellText(rows[a]![sort.col]), cellText(rows[b]![sort.col])))
    return idx
  }, [rows, filter, sort])

  const cols = headers.map((_, i) => i).filter((i) => !hidden.has(i))
  const marks = !!diff?.comparable
  const copy = async (sep: ',' | '\t') => {
    const text = toDelimited(
      // The template's own value names: stable for scripts that read the export.
      cols.map((i) => headers[i]!),
      view.map((r) => cols.map((i) => rows[r]![i]!)),
      sep
    )
    await writeClipboard(text)
    toast(`Copied ${view.length} row${view.length === 1 ? '' : 's'} as ${sep === ',' ? 'CSV' : 'TSV'}`)
  }
  const toggleCol = (i: number, on: boolean) => {
    const next = new Set(hidden)
    if (on) next.delete(i)
    else if (cols.length > 1) next.add(i)
    setHidden(next)
  }
  const columnItems = (Item: typeof DM.CheckboxItem) =>
    headers.map((h, i) => (
      <Item key={`${h}-${i}`} checked={!hidden.has(i)} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => toggleCol(i, on === true)} className={menuItem}>
        <span className="flex size-3.5 items-center justify-center">
          <DM.ItemIndicator>
            <Check className="size-3.5 text-accent" />
          </DM.ItemIndicator>
        </span>
        {humanizeHeader(h)}
      </Item>
    ))
  const count = view.length === rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : `${view.length} of ${rows.length}`

  return (
    <div
      role="region"
      aria-label={label}
      data-testid={testId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (filter && document.activeElement === filterRef.current) {
            e.stopPropagation()
            setFilter('')
          } else if (onClose) {
            e.stopPropagation()
            onClose()
          }
        } else if (e.key === '/' && document.activeElement !== filterRef.current && !(e.target as HTMLElement).closest('input,textarea')) {
          e.preventDefault()
          filterRef.current?.focus({ preventScroll: true })
        }
      }}
      className={cn('@container/table flex min-h-0 min-w-0 flex-col overflow-hidden outline-none', className)}
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-1.5 @[480px]/table:h-10 @[480px]/table:flex-row @[480px]/table:items-center @[480px]/table:gap-2 @[480px]/table:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {title && <span className="min-w-[3rem] truncate font-mono text-xs text-fg">{title}</span>}
          <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-fg-subtle">{count}</span>
          {extra}
          <div className="ml-auto @[480px]/table:hidden">
            <DM.Root>
              <DM.Trigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Table actions">
                  <MoreHorizontal />
                </Button>
              </DM.Trigger>
              <DM.Portal>
                <DM.Content align="end" sideOffset={4} className={menuContent}>
                  <DM.Item className={menuItem} onSelect={() => void copy(',')}>
                    <Copy /> Copy as CSV
                  </DM.Item>
                  <DM.Item className={menuItem} onSelect={() => void copy('\t')}>
                    <Copy /> Copy as TSV
                  </DM.Item>
                  <DM.Sub>
                    <DM.SubTrigger className={menuItem}>
                      <Columns3 /> Columns
                    </DM.SubTrigger>
                    <DM.Portal>
                      <DM.SubContent sideOffset={4} className={menuContent}>
                        {columnItems(DM.CheckboxItem)}
                      </DM.SubContent>
                    </DM.Portal>
                  </DM.Sub>
                  {onClose && (
                    <>
                      <DM.Separator className="my-1 h-px bg-line" />
                      <DM.Item className={menuItem} onSelect={onClose}>
                        <X /> Close table <Kbd keys="Esc" className="ml-auto" />
                      </DM.Item>
                    </>
                  )}
                </DM.Content>
              </DM.Portal>
            </DM.Root>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-1 @[480px]/table:shrink-0">
          <div className="relative min-w-0 flex-1 @[480px]/table:w-44 @[480px]/table:flex-none">
            <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows" aria-label="Filter rows" className="h-6 w-full min-w-0 pl-7" />
          </div>
          <div className="hidden items-center gap-px @[480px]/table:flex">
            <DM.Root>
              <Tooltip label="Columns">
                <DM.Trigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Choose columns">
                    <Columns3 />
                  </Button>
                </DM.Trigger>
              </Tooltip>
              <DM.Portal>
                <DM.Content align="end" sideOffset={4} className={menuContent}>
                  {columnItems(DM.CheckboxItem)}
                </DM.Content>
              </DM.Portal>
            </DM.Root>
            <Tooltip label="Copy as CSV">
              <Button variant="ghost" size="sm" onClick={() => void copy(',')}>
                <Copy /> CSV
              </Button>
            </Tooltip>
            <Tooltip label="Copy as TSV (pastes into a spreadsheet)">
              <Button variant="ghost" size="sm" onClick={() => void copy('\t')}>
                TSV
              </Button>
            </Tooltip>
            {onClose && (
              <Tooltip label="Close" shortcut="Esc">
                <Button variant="ghost" size="icon-sm" aria-label="Close table" onClick={onClose}>
                  <X />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto [&::-webkit-scrollbar-corner]:bg-transparent">
        <table aria-label={label} className="w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-[1] bg-surface">
            <tr>
              {marks && <th aria-label="Change" className="w-1 border-b border-line" />}
              {cols.map((i) => {
                const on = sort?.col === i
                return (
                  <th key={i} scope="col" aria-sort={on ? (sort!.dir > 0 ? 'ascending' : 'descending') : 'none'} className="border-b border-line p-0 text-left font-medium">
                    <button
                      type="button"
                      onClick={() => setSort(!on ? { col: i, dir: 1 } : sort!.dir > 0 ? { col: i, dir: -1 } : null)}
                      className={cn('flex h-7 w-full items-center gap-1 whitespace-nowrap px-2 @[720px]/table:px-3 text-2xs hover:text-fg', on ? 'text-fg' : 'text-fg-subtle')}
                    >
                      {humanizeHeader(headers[i]!)}
                      {on && (sort!.dir > 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="font-mono">
            {view.map((r) => {
              const st = marks ? diff!.status[r] : 'same'
              return (
                <tr key={r} data-change={st} className={cn('hover:bg-hover', st === 'new' && 'bg-ok-soft')}>
                  {marks && (
                    <td className="w-1 border-b border-line/60 p-0">
                      <span aria-label={st === 'same' ? undefined : st} className={cn('block h-7 w-[3px]', st === 'new' ? 'bg-ok' : st === 'changed' ? 'bg-warn' : '')} />
                    </td>
                  )}
                  {cols.map((i) => {
                    const hot = marks && diff!.cells[r]!.has(i)
                    const was = hot ? diff!.before[r]?.[i] : undefined
                    return (
                      <td key={i} data-changed={hot || undefined} title={hot ? `was: ${cellText(was) || '(empty)'}` : undefined} className={cn('selectable h-7 whitespace-nowrap border-b border-line/60 px-2 @[720px]/table:px-3 text-fg', hot && 'bg-warn-soft text-warn')}>
                        {cellText(rows[r]![i])}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {marks &&
              diff!.removed.map((row, k) => (
                <tr key={`gone-${k}`} data-change="removed" className="text-fg-subtle line-through decoration-danger/60">
                  <td className="w-1 border-b border-line/60 p-0">
                    <span aria-label="removed" className="block h-7 w-[3px] bg-danger" />
                  </td>
                  {cols.map((i) => (
                    <td key={i} className="h-7 whitespace-nowrap border-b border-line/60 px-2 @[720px]/table:px-3">
                      {cellText(row[i])}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {!view.length && <div className="px-3 py-3 text-left text-sm text-fg-subtle">{filter ? `No rows match “${filter}”.` : (emptyMessage ?? 'The template matched, but it parsed no rows from this output.')}</div>}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-line px-3 text-2xs text-fg-subtle">
        <span className="min-w-0 truncate">{source}</span>
        <div className="flex-1" />
        <span className="hidden shrink-0 items-center gap-1 @[480px]/table:flex">
          <Kbd keys="/" /> filter
        </span>
        <span className="hidden shrink-0 items-center gap-1 @[480px]/table:flex">
          <Kbd keys="Esc" /> {onClose ? 'close' : 'clear'}
        </span>
      </div>
    </div>
  )
}
