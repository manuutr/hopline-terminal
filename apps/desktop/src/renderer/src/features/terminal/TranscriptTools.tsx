import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { Button, Dialog, EmptyState } from '../../design'
import { writeClipboard } from '../../lib/clipboard'
import type { NetworkTarget } from '../../lib/highlight'
import { fmtWhen } from '../../lib/when'
import { useUi } from '../../store'
import { useDrafts } from '../ai/drafts'
import type { BlockController } from '../blocks/controller'
import { useBlocks } from '../blocks/store'

export function TargetDialog({ target, term, close, ask }: { target: NetworkTarget; term: Terminal; close(): void; ask(text: string): void }) {
  const command = target.kind === 'address' ? 'ping ' + target.text.split('/')[0] : 'show running-config interface ' + target.text
  return <Dialog open title={target.text} onOpenChange={(open) => { if (!open) close() }}>
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => { term.paste(command); close() }}>Insert {command}</Button>
      <Button variant="secondary" onClick={() => { void writeClipboard(target.text); close() }}>Copy</Button>
      <Button variant="secondary" onClick={() => { ask(target.text); close() }}>Ask AI</Button>
    </div>
  </Dialog>
}

export function CommandHistory({ ctl, close }: { ctl: BlockController; close(): void }) {
  const [, refresh] = useState(0)
  useEffect(() => ctl.onChange(() => refresh((n) => n + 1)), [ctl])
  const blocks = ctl.blocks.filter((b) => !b.start.isDisposed && !b.end.isDisposed).slice().reverse()
  return <Dialog open title="Command blocks" description="Commands and their output from this connection." onOpenChange={(v) => { if (!v) close() }} className="w-[min(840px,92vw)]">
    {!blocks.length && <EmptyState title="No command history" body="Run a command in this terminal to see its output here." action={<Button size="sm" onClick={close}>Return to terminal</Button>} />}
    {blocks.map((b) => <HistoryBlock key={b.id} ctl={ctl} id={b.id} close={close} />)}
  </Dialog>
}

function HistoryBlock({ ctl, id, close }: { ctl: BlockController; id: number; close(): void }) {
  const [open, setOpen] = useState(false)
  const b = ctl.byId(id)
  if (!b) return null
  const output = open ? ctl.output(b) : ''
  const error = /^\s*%\s*(Invalid|Incomplete|Ambiguous|Error|Unknown)/im.test(output)
  const attach = () => {
    useDrafts.getState().edit(ctl.tabId, { attachment: ctl.attachment(b) })
    useUi.getState().set({ aiOpen: true })
    close()
  }
  return <details className="border-b border-line py-2" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer rounded px-1 py-1 font-mono text-fg">
      {b.command} <time title={new Date(b.closedAt).toLocaleString()} className="ml-2 text-2xs text-fg-subtle">{fmtWhen(b.closedAt)}</time>
    </summary>
    {open && <div className={error ? 'border-l-2 border-danger pl-3' : 'pl-3'}>
      <pre className="selectable max-h-80 overflow-auto py-2 text-xs">{output}</pre>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => void ctl.copyOutput(b)}>Copy output</Button>
        <Button size="sm" onClick={() => { close(); void ctl.rerun(b) }}>Re-run</Button>
        <Button size="sm" onClick={attach}>Attach to AI</Button>
        {error && <Button size="sm" onClick={() => { close(); ctl.ask(b) }}>Ask AI why</Button>}
        <Button size="sm" variant="ghost" onClick={() => { ctl.term.scrollToLine(b.start.line); useBlocks.getState().select(ctl.tabId, id); close() }}>Show in terminal</Button>
      </div>
    </div>}
  </details>
}
