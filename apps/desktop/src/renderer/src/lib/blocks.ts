/**
 * Command blocks: prompt + command + output until the next prompt, inferred from the session
 * platform's prompt grammar (cli-model, via shared/cli promptState). Nothing is written into the
 * buffer: blocks are xterm markers on the prompt lines, and the view draws one overlay.
 *
 * Detection is event-driven and cheap on floods: every parsed write only stamps a time; once the
 * output has been quiet for QUIET_MS, the cursor line is checked once. A prompt on a new line closes
 * the block that started at the previous prompt line (if a command was typed there, by anyone:
 * the user, a re-run, the assistant). Block text is device-controlled (a banner can fake a prompt
 * and a command), so everything that acts on it goes through the guard in main.
 *
 * A prompt that shows up with text after it is either a redraw of the line being typed (`?` help,
 * a syslog message breaking in: the command was never entered) or a new prompt the user already
 * typed into (typeahead, or a key pressed inside the quiet window). Timing can't tell them apart;
 * what was sent can: `sent()` counts the line endings that went to the device, and only a prompt
 * with no line ending sent since the previous one is a redraw. A key pressed while the quiet timer
 * is armed also checks the screen as it was before that key, so a fresh prompt is never missed, and
 * a line ending checks the line it enters, so a prompt that was never quiet still starts a block.
 */
import { pagerPattern, promptState, type AnyPlatform } from '@shared/cli'

export const QUIET_MS = 60
export const MAX_BLOCKS = 1000

/** What the tracker needs of xterm (Terminal satisfies it; tests use a fake). */
export interface BufferLike {
  readonly length: number
  readonly baseY: number
  readonly cursorY: number
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}
export interface MarkerLike {
  readonly line: number
  readonly isDisposed: boolean
  dispose(): void
}
export interface TermLike {
  readonly buffer: { readonly active: BufferLike }
  registerMarker(cursorYOffset?: number): MarkerLike | undefined
}

/** The prompt line the tracker is on, and how many line endings had been sent when it was seen. */
interface Current {
  platform: AnyPlatform
  marker: MarkerLike
  sent: number
}

export interface Block {
  id: number
  /** Marker on the (first) prompt line. */
  start: MarkerLike
  /** Marker on the next prompt line: the block ends just above it. */
  end: MarkerLike
  prompt: string
  command: string
  /** The prompt's mode when the command was entered (`exec`, `user`, `config`). */
  mode: string
  hostname: string
  platform: AnyPlatform
  closedAt: number
}

/** First line of the wrapped group that `y` belongs to. */
export function groupStart(buf: BufferLike, y: number): number {
  while (y > 0 && buf.getLine(y)?.isWrapped) y--
  return y
}

/** The logical line starting at `y` (soft-wrapped rows joined), and the last row it covers. */
export function logicalLine(buf: BufferLike, y: number): { text: string; last: number } {
  let text = ''
  let i = y
  for (;;) {
    const line = buf.getLine(i)
    if (!line) break
    const next = buf.getLine(i + 1)
    const wraps = !!next?.isWrapped
    text += line.translateToString(!wraps)
    if (!wraps) break
    i++
  }
  return { text, last: i }
}

const PAGER_RESIDUE = /^\s*(?:-+\s*More\s*-+|<-+ More -+>|---\(more(?: \d+%)?\)---|--More or \(q\)uit--)\s*/i

/** Output lines of a block, wrapped rows joined, pager residue and the Junos/PAN-OS banner above the next prompt dropped. */
export function blockOutput(buf: BufferLike, b: Pick<Block, 'start' | 'end'>, platform: AnyPlatform): string {
  if (b.start.isDisposed || b.end.isDisposed || b.start.line < 0) return ''
  const first = logicalLine(buf, b.start.line).last + 1
  const lines: string[] = []
  const pager = pagerPattern(platform)
  for (let y = first; y < b.end.line; ) {
    const l = logicalLine(buf, y)
    let text = l.text.replace(PAGER_RESIDUE, '')
    if (pager.test(text)) text = text.replace(pager, '')
    lines.push(text)
    y = l.last + 1
  }
  // Junos/PAN-OS print "[edit …]" and "{master:0}" above the prompt; they belong to the prompt, not the output.
  while (lines.length && (/^\s*$/.test(lines.at(-1)!) || /^(?:\{[^}]+\}|\[edit(?: [^\]]*)?\])\s*$/.test(lines.at(-1)!))) lines.pop()
  return lines.join('\n')
}

export class BlockTracker {
  readonly blocks: Block[] = []
  private current: Current | null = null
  /** Line endings sent to the device from this terminal (see sent()). */
  private linesSent = 0
  private lastWrite = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private disposed = false

  constructor(
    private readonly term: TermLike,
    private readonly opts: {
      platform: () => AnyPlatform
      onBlock: (b: Block) => void
      now?: () => number
      /** Defer the check (tests drive it by hand). */
      schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
      /**
       * Run `fn` once everything received so far is parsed (xterm: `term.write('', fn)`). Writes are
       * parsed in order, so `fn` sees the screen before the echo of anything sent after this call.
       */
      afterParsed?: (fn: () => void) => void
    }
  ) {}

  private now(): number {
    return this.opts.now?.() ?? performance.now()
  }

  /** Call on every parsed write: O(1), the real work waits for the output to go quiet. */
  written(): void {
    this.lastWrite = this.now()
    if (this.timer !== undefined || this.disposed) return
    this.arm(QUIET_MS)
  }

  /**
   * Something went to the device from this terminal (keys, a paste, a re-run): call before it is
   * sent. Counts line endings; and a key inside the quiet window first checks the screen as it was
   * (a fresh prompt that the echo of this key would otherwise turn into "prompt + text").
   */
  sent(data: string): void {
    if (this.disposed) return
    const enter = /[\r\n]/.test(data)
    const at = this.linesSent
    if (this.opts.afterParsed && (this.timer !== undefined || enter)) {
      // A line ending enters the line the cursor is on: check it in full first, typeahead included.
      // If the keys kept coming faster than the quiet window (a busy renderer, a fast typist), the
      // quiet check never saw this prompt, and the block before it would swallow this command.
      this.opts.afterParsed(() => {
        if (!this.disposed) this.check({ sent: at, freshOnly: !enter })
      })
    }
    if (enter) this.linesSent++
  }

  private arm(ms: number): void {
    const schedule = this.opts.schedule ?? ((fn, t) => setTimeout(fn, t))
    this.timer = schedule(() => {
      this.timer = undefined
      if (this.disposed) return
      const idle = this.now() - this.lastWrite
      if (idle < QUIET_MS) return this.arm(QUIET_MS - idle)
      this.check()
    }, ms)
  }

  /**
   * The output went quiet (or a key is about to be sent): is the cursor on a prompt, and is it a new
   * one? `sent`: the line-ending count the screen reflects (default: now). `freshOnly`: only take an
   * empty prompt (the pre-key check; anything else waits for the quiet check).
   */
  check(o: { sent?: number; freshOnly?: boolean } = {}): void {
    const buf = this.term.buffer.active
    const y = groupStart(buf, buf.baseY + buf.cursorY)
    const platform = this.opts.platform()
    const here = promptState(logicalLine(buf, y).text, platform)
    if (here.mode === 'unknown') return
    const prev = this.current
    const cur = prev?.marker
    const sent = o.sent ?? this.linesSent
    // The pre-key check takes an empty prompt, or a redraw (text after the prompt, nothing entered
    // since the last one: `show ip ?` then Ctrl+U at once). Text after a prompt with a line entered
    // since may be the echo of typeahead: that waits for the quiet check.
    if (o.freshOnly && here.pending.trim() !== '' && !!prev && sent > prev.sent) return
    if (cur && !cur.isDisposed && cur.line === y) return
    const marker = this.term.registerMarker(y - (buf.baseY + buf.cursorY))
    if (!marker) return
    // A prompt that arrives with text already after it is a redraw of the line being typed (`?`
    // help, a syslog message breaking in, `show ip ?`): the command above was never entered.
    // Unless a line ending went to the device since that prompt: then the command above was entered
    // and this is typeahead (or a fast key) on a new prompt.
    const entered = !!prev && sent > prev.sent
    const redraw = here.pending.trim() !== '' && !entered
    if (!redraw && cur && !cur.isDisposed && cur.line >= 0 && cur.line < y) {
      const sourcePlatform = prev.platform === 'auto' ? platform : prev.platform
      const p = promptState(logicalLine(buf, cur.line).text, sourcePlatform)
      const command = p.pending.trim()
      if (p.mode !== 'unknown' && command) this.add({ id: ++this.seq, start: cur, end: marker, prompt: p.prompt, command, mode: p.mode, hostname: p.hostname, platform: sourcePlatform, closedAt: Date.now() })
      else if (!this.blocks.some((b) => b.end === cur)) cur.dispose()
    } else if (cur && !this.blocks.some((b) => b.end === cur)) cur.dispose()
    this.current = { marker, sent, platform }
  }

  private add(b: Block): void {
    this.blocks.push(b)
    // Markers of blocks scrolled out of the buffer dispose themselves; keep the list bounded too.
    while (this.blocks.length > MAX_BLOCKS || (this.blocks[0] && this.blocks[0].start.isDisposed)) {
      const old = this.blocks.shift()!
      old.start.dispose()
    }
    this.opts.onBlock(b)
  }

  /** The block that covers buffer line `y` (its prompt line through its last output line). */
  blockAt(y: number): Block | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!
      if (b.start.isDisposed) break
      if (y >= b.start.line && y < b.end.line) return b
      if (b.end.line <= y) return undefined
    }
    return undefined
  }

  /** The nearest block whose prompt is above (dir -1) or below (dir 1) line `y`. */
  step(y: number, dir: -1 | 1): Block | undefined {
    const live = this.blocks.filter((b) => !b.start.isDisposed && b.start.line >= 0)
    if (dir < 0) return [...live].reverse().find((b) => b.start.line < y)
    return live.find((b) => b.start.line > y)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    for (const b of this.blocks) b.start.dispose()
    this.current?.marker.dispose()
  }
}
