import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, FolderSearch, RotateCcw, X } from 'lucide-react'
import { toast } from '../../lib/notify'
import type { TransferItem } from '@shared/files'
import { useShallow } from 'zustand/react/shallow'
import { Button, cn, Toggle, Tooltip } from '../../design'
import { isCaptureName } from '@shared/packets'
import { openTrace } from '../packets/store'
import { useUi } from '../../store'
import { writeClipboard } from '../../lib/clipboard'
import { cleanError, formatBytes, formatDuration, useFiles } from './store'

const STATE_LABEL: Record<TransferItem['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped'
}

function copy(text: string, what: string): void {
  void writeClipboard(text).then(
    () => toast(`${what} copied`),
    () => toast.error(`Could not copy the ${what.toLowerCase()}`)
  )
}

function Row({ it }: { it: TransferItem }): React.JSX.Element {
  const api = window.hopline.transfer
  const pct = it.size > 0 ? Math.min(100, (it.done / it.size) * 100) : it.state === 'done' ? 100 : 0
  const eta = it.state === 'running' && it.speed > 0 && it.size > 0 ? formatDuration((it.size - it.done) / it.speed) : ''
  const Dir = it.direction === 'upload' ? ArrowUpFromLine : ArrowDownToLine
  const tone = it.state === 'error' ? 'text-danger' : it.state === 'done' ? 'text-ok' : 'text-fg-subtle'
  return (
    <li
      aria-label={`${it.direction === 'upload' ? 'Upload' : 'Download'} ${it.localName}: ${STATE_LABEL[it.state]}`}
      draggable={it.draggable}
      onDragStart={(e) => {
        if (!it.draggable) return
        // Electron starts the OS drag of the finished file from main.
        e.preventDefault()
        api.dragOut(it.id)
      }}
      className={cn('group border-b border-line px-3 py-2', it.draggable && 'cursor-grab')}
    >
      <div className="flex items-center gap-2">
        <Dir aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-fg" title={it.localName}>
            {it.localName}
          </div>
          <div className="truncate font-mono text-2xs text-fg-subtle" title={it.remotePath}>
            {it.direction === 'upload' ? '→ ' : '← '}
            {it.remotePath}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {(it.state === 'running' || it.state === 'queued') && (
            <Tooltip label="Cancel">
              <Button variant="ghost" size="icon-sm" aria-label={`Cancel ${it.localName}`} onClick={() => void api.cancel(it.id)}>
                <X />
              </Button>
            </Tooltip>
          )}
          {(it.state === 'error' || it.state === 'cancelled') && (
            <Tooltip label={it.protocol === 'sftp' ? 'Retry (resumes where it stopped)' : 'Retry (SCP starts over)'}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Retry ${it.localName}`}
                onClick={() => void api.retry(it.id).catch((e: unknown) => toast.error('Could not retry', { description: cleanError(e) }))}
              >
                <RotateCcw />
              </Button>
            </Tooltip>
          )}
          {it.state === 'done' && it.direction === 'download' && isCaptureName(it.localName) && (
            <Button size="sm" onClick={() => void openTrace({ kind: 'download', transferId: it.id })}>Analyze capture</Button>
          )}
          {it.state === 'done' && it.direction === 'download' && (
            <Tooltip label="Show in folder">
              <Button variant="ghost" size="icon-sm" aria-label={`Show ${it.localName} in folder`} onClick={() => void api.reveal(it.id)}>
                <FolderSearch />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {(it.state === 'running' || it.state === 'queued') && (
        <div className="mt-1.5">
          <div
            role="progressbar"
            aria-label={`${it.localName} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            className="h-1 overflow-hidden rounded-full bg-active"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-base)] ease-[var(--ease-std)]" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-2xs tabular-nums text-fg-subtle">
            <span>
              {formatBytes(it.done)}
              {it.size ? ` of ${formatBytes(it.size)}` : ''}
              {it.resumedFrom ? ' · resumed' : ''}
            </span>
            <span>{it.state === 'queued' ? 'Queued' : `${formatBytes(it.speed)}/s${eta ? ` · ${eta} left` : ''}`}</span>
          </div>
        </div>
      )}
      {it.state !== 'running' && it.state !== 'queued' && (
        <div className={cn('mt-1 flex items-center gap-1 text-2xs', tone)}>
          {it.state === 'done' && <Check aria-hidden className="size-3" />}
          <span className="truncate" title={it.error}>
            {STATE_LABEL[it.state]}
            {it.state === 'done' && ` · ${formatBytes(it.size)}${it.resumedFrom ? ' · resumed' : ''}`}
            {it.error && ` · ${it.error}`}
          </span>
        </div>
      )}
      {it.state === 'done' && it.md5 && (
        <div className="mt-1.5 space-y-1.5 rounded-md bg-term px-2 py-1.5 font-mono text-2xs text-fg-muted">
          <HashLine label="MD5" value={it.md5} />
          <HashLine label="SHA-256" value={it.sha256!} />
          {it.verify && (
            <div className="border-t border-line pt-1.5">
              <div className="flex items-center justify-between gap-2 font-sans text-fg-subtle">
                <span>Verify on the device</span>
                <CopyButton label="Copy the verify command" onClick={() => copy(it.verify!, 'Verify command')} />
              </div>
              <div className="selectable mt-0.5 select-text break-all text-fg">{it.verify}</div>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function CopyButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className="shrink-0 rounded-sm p-0.5 text-fg-subtle hover:bg-hover hover:text-fg">
        <Copy className="size-3" />
      </button>
    </Tooltip>
  )
}

/** A checksum: label and copy on one line, the full value below it, selectable and wrapping. */
function HashLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 font-sans text-fg-subtle">
        <span>{label}</span>
        <CopyButton label={`Copy ${label}`} onClick={() => copy(value, label)} />
      </div>
      <div className="selectable mt-0.5 select-text break-all leading-snug">{value}</div>
    </div>
  )
}

/** The queue's items: the active tab's by default, every tab's with "All tabs" on. */
export function useQueueItems(): TransferItem[] {
  const tabId = useUi((s) => s.activeTabId)
  return useFiles(useShallow((s) => (s.allTabs ? s.items : s.items.filter((i) => i.tabId === tabId))))
}

/**
 * The transfer queue beside the browser: progress, speed, cancel and retry, hashes when done.
 * From 760 px of panel width it is a column; below that an overlay the header's "Transfers (n)"
 * toggle opens (`open`). Short panels drop the download-folder footer into the header.
 */
export function TransferQueue({ open, compact }: { open: boolean; compact: boolean }): React.JSX.Element {
  const allItems = useFiles((s) => s.items)
  const allTabs = useFiles((s) => s.allTabs)
  const items = useQueueItems()
  const dir = useFiles((s) => s.downloadDir)
  const finished = items.filter((i) => i.state !== 'running' && i.state !== 'queued').length
  const active = items.length - finished
  const elsewhere = allItems.length - allItems.filter((i) => items.includes(i)).length
  const api = window.hopline.transfer
  const chooseDir = () =>
    void api
      .chooseDownloadDir()
      .then((d) => d && useFiles.setState({ downloadDir: d }))
      .catch((e: unknown) => toast.error('Could not use that folder', { description: cleanError(e) }))
  return (
    <section
      id="files-transfers"
      aria-label="Transfers"
      className={cn(
        'w-80 shrink-0 flex-col border-l border-line bg-surface',
        open ? 'absolute inset-y-0 right-0 z-20 flex w-[min(20rem,100%)] shadow-overlay @[760px]/files:static @[760px]/files:w-80 @[760px]/files:shadow-none' : 'hidden @[760px]/files:flex'
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-3 pr-1">
        <span className="whitespace-nowrap text-xs font-medium text-fg-muted">Transfers</span>
        {active > 0 && <span className="whitespace-nowrap text-2xs tabular-nums text-fg-subtle">{active} active</span>}
        <div className="flex-1" />
        {(allTabs || elsewhere > 0) && <Toggle inline label="All tabs" hint={allTabs ? 'Showing every tab' : `${elsewhere} more in other tabs`} checked={allTabs} onChange={(v) => useFiles.getState().set({ allTabs: v })} />}
        {finished > 0 && (
          <Tooltip label="Clear finished transfers">
            <Button variant="ghost" size="sm" aria-label="Clear finished" onClick={() => void api.clear()}>
              Clear
            </Button>
          </Tooltip>
        )}
        {compact && (
          <Tooltip label={dir ? `Downloads go to ${dir}` : 'Choose the download folder'}>
            <Button variant="ghost" size="icon-sm" aria-label="Download folder" onClick={chooseDir}>
              <FolderSearch />
            </Button>
          </Tooltip>
        )}
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-4 text-sm text-fg-subtle">
          {elsewhere > 0 ? 'No transfers for this tab.' : 'Uploads and downloads show here.'} Drop files on the list to upload them.
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {[...items].reverse().map((it) => (
            <Row key={it.id} it={it} />
          ))}
        </ul>
      )}
      {!compact && (
        <div className="mt-auto flex h-8 shrink-0 items-center gap-1 border-t border-line pl-3 pr-1 text-2xs text-fg-subtle">
          <span className="min-w-0 flex-1 truncate" title={dir ?? undefined}>
            {dir ? `Downloads go to ${dir}` : 'You pick a download folder on the first download'}
          </span>
          <Button variant="ghost" size="sm" onClick={chooseDir}>
            {dir ? 'Change' : 'Choose'}
          </Button>
        </div>
      )}
    </section>
  )
}
