import { resolve as resolveCommand, PROFILES, type PlatformId } from '@hopline/cli-model'
import type { Terminal } from '@xterm/xterm'
import { toast } from '../../lib/notify'
import type { AnyPlatform } from '@shared/cli'
import { blockOutput, BlockTracker, type Block } from '../../lib/blocks'
import { writeClipboard } from '../../lib/clipboard'
import { copyTicketReport, outputExcerpt, scrubTerminalText } from '../../lib/command-evidence'
import { platformLabel } from '../../lib/platforms'
import { notifyError } from '../../lib/connect'
import { hasTemplate, parseInWorker } from '../../lib/parse-client'
import { parseHistory, ParseHistory } from '../../lib/table'
import { sessionById, useUi } from '../../store'
import { useBlocks } from './store'

/** Under the IPC limit (200k): main redacts the whole text first, then keeps the first line and the tail for the model. */
const ASK_MAX_CHARS = 190_000

/** History key: the command in its canonical form where cli-model resolves it (sh ip int br = show ip interface brief). */
function canonical(platform: AnyPlatform, command: string): string {
  if (platform === 'auto' || !(platform in PROFILES)) return command
  try {
    const r = resolveCommand(platform as PlatformId, 'exec', command)
    return r.status === 'ok' && r.expanded ? r.expanded : command
  } catch {
    return command
  }
}

/**
 * One terminal's command blocks: detection (lib/blocks), parsing finished blocks in the worker,
 * and the block actions. Lives as long as the xterm instance; the React layer only renders.
 */
export class BlockController {
  readonly tracker: BlockTracker
  /** Off while restored scrollback is written, so old history makes no blocks. */
  live = false
  private listeners = new Set<() => void>()

  constructor(
    readonly term: Terminal,
    readonly tabId: string,
    readonly sessionId: string,
    readonly platform: () => AnyPlatform
  ) {
    this.tracker = new BlockTracker(term, { platform, onBlock: (b) => this.closed(b), afterParsed: (fn) => term.write('', fn) })
  }

  /** Call on every parsed write (O(1)). */
  written(): void {
    if (this.live) this.tracker.written()
  }

  /** Call before anything typed in this terminal goes to the device (keys, pastes, inserts). */
  sent(data: string): void {
    if (this.live) this.tracker.sent(data)
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const f of this.listeners) f()
  }

  private closed(b: Block): void {
    this.emit()
    const platform = b.platform
    // Index lookup first: the end of a show tech costs nothing when no template knows the command.
    if (platform === 'auto' || !hasTemplate(platform, b.command)) return
    const text = this.output(b)
    void parseInWorker(platform, b.command, text).then((result) => {
      if (!result || !result.rows.length) return
      const key = ParseHistory.key(this.sessionId, canonical(platform, b.command), result.template)
      const prev = parseHistory.push(key, result)
      useBlocks.getState().setParsed(this.tabId, b.id, { result, at: Date.now(), prev })
    })
  }

  get blocks(): readonly Block[] {
    return this.tracker.blocks
  }

  byId(id: number | null | undefined): Block | undefined {
    return id == null ? undefined : this.tracker.blocks.find((b) => b.id === id && !b.start.isDisposed)
  }

  output(b: Block): string {
    return blockOutput(this.term.buffer.active, b, b.platform)
  }

  /** The block actions act on: the one picked with the keyboard, else the latest. */
  current(): Block | undefined {
    return this.byId(useBlocks.getState().selected[this.tabId]) ?? [...this.tracker.blocks].reverse().find((b) => !b.start.isDisposed)
  }

  /** Jump to the previous/next prompt and select its block. */
  navigate(dir: -1 | 1): void {
    const b = this.term.buffer.active
    const sel = this.byId(useBlocks.getState().selected[this.tabId])
    const from = sel ? sel.start.line : dir < 0 ? b.baseY + b.cursorY : b.viewportY - 1
    const next = this.tracker.step(from, dir)
    if (!next) {
      // Past the last block going down: back to the live prompt.
      if (dir > 0) {
        useBlocks.getState().select(this.tabId, null)
        this.term.scrollToBottom()
      }
      return
    }
    useBlocks.getState().select(this.tabId, next.id)
    this.reveal(next)
  }

  reveal(b: Block): void {
    const buf = this.term.buffer.active
    const top = b.start.line
    if (top < buf.viewportY || top >= buf.viewportY + this.term.rows - 1) this.term.scrollToLine(Math.max(0, top - 1))
    this.emit()
  }

  async copyOutput(b: Block): Promise<void> {
    await writeClipboard(this.output(b))
    toast('Output copied', { description: b.command })
  }

  async copyCommand(b: Block): Promise<void> {
    await writeClipboard(b.command)
    toast('Command copied', { description: b.command })
  }

  async copyForTicket(b: Block): Promise<void> {
    const session = sessionById(useUi.getState(), this.sessionId)
    try {
      await copyTicketReport('block', [{
        device: b.hostname || session?.name || this.sessionId,
        session: session?.name,
        host: session?.host,
        platform: platformLabel(b.platform),
        recordedAt: b.closedAt,
        command: b.command,
        output: this.output(b)
      }])
      toast('Command report copied')
    } catch (e) {
      notifyError('Could not copy the command report', e)
    }
  }

  /** Re-run through main's guard: a read runs (executor, audited); anything else is typed without Enter. */
  async rerun(b: Block): Promise<void> {
    // The new run lands at the live prompt: that is where the user is now.
    useBlocks.getState().select(this.tabId, null)
    try {
      const r = await window.hopline.blocks.rerun(this.tabId, b.command)
      if (r.action === 'insert') {
        this.sent(r.command)
        window.hopline.term.write(this.tabId, r.command)
        this.term.focus()
        toast('Inserted at the prompt, not run', { description: `${r.reason}. Review it and press Enter yourself.` })
      } else if (r.status !== 'ok') toast.error('Re-run did not complete', { description: r.error ?? r.status })
      else this.term.focus()
    } catch (e) {
      notifyError('Could not re-run', e)
    }
  }

  attachment(b: Block): { label: string; selection: string } {
    const label = scrubTerminalText(b.command)
    return { label, selection: `${label}\n${outputExcerpt(this.output(b))}` }
  }

  /** Send the block to the assistant as context (redacted in main before any provider sees it). */
  ask(b: Block): void {
    // Main redacts the whole selection before it cuts it to what the model sees (never cut a key here).
    let out = scrubTerminalText(this.output(b))
    if (out.length > ASK_MAX_CHARS) out = `[… first ${(out.length - ASK_MAX_CHARS).toLocaleString('en-US')} characters of output omitted]\n` + out.slice(-ASK_MAX_CHARS)
    useUi.getState().set({ aiOpen: true })
    window.dispatchEvent(new CustomEvent('hopline:explain', { detail: { tabId: this.tabId, text: `${scrubTerminalText(b.prompt) + scrubTerminalText(b.command)}\n${out}` } }))
  }

  openTable(b: Block): void {
    if (!useBlocks.getState().parsed[this.tabId]?.[b.id]) {
      toast('No table for this output', { description: 'No bundled TextFSM template parses this command on this platform.' })
      return
    }
    useBlocks.getState().openTable(this.tabId, b.id)
  }

  dispose(): void {
    this.tracker.dispose()
    this.listeners.clear()
    useBlocks.getState().dropTab(this.tabId)
  }
}
