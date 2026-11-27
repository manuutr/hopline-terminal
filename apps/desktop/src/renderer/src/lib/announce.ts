/**
 * Screen reader announcements of terminal output (docs/ACCESSIBILITY.md). Output is batched and
 * spoken at most once per interval through one polite live region; a burst too long to listen to
 * (a `show running-config`) becomes a one-line summary instead of a flood. Pure logic: the live
 * region itself is features/a11y/LiveRegion.
 */
export const ANNOUNCE = {
  /** At most one announcement per this many ms. */
  intervalMs: 1000,
  /** A batch longer than this is summarised. */
  maxLines: 8,
  maxChars: 500,
  /** Lines kept while waiting (the rest is only counted). */
  keep: 50
} as const

/** The cells of one xterm buffer row, as much of IBufferLine as `visibleText` needs. */
export interface CellRow {
  length: number
  getCell(x: number): { getChars(): string; getWidth(): number; isInvisible(): number | boolean } | undefined
}

/**
 * A row's text as the terminal shows it: cells drawn concealed (SGR 8, "invisible") are spoken as
 * spaces, the way they look. xterm's `translateToString` returns them, so a device or a script that
 * writes a secret concealed would have been read aloud (Phase 6–8 review, addendum: the live region
 * must say nothing the screen does not show). Trailing blanks are trimmed.
 */
export function visibleText(row: CellRow | undefined, trimRight = true): string {
  if (!row) return ''
  let out = ''
  for (let x = 0; x < row.length; x++) {
    const c = row.getCell(x)
    if (!c) continue
    const w = c.getWidth()
    // The right half of a wide character: its text is in the left cell.
    if (w === 0) continue
    const chars = c.getChars() || ' '
    out += c.isInvisible() ? ' '.repeat(Math.max(1, w)) : chars
  }
  return trimRight ? out.replace(/\s+$/, '') : out
}

export class AnnounceQueue {
  private lines: string[] = []
  private dropped = 0
  private partial = ''

  /** Complete lines of new output. Blank lines are skipped. */
  push(lines: string[]): void {
    for (const l of lines) {
      const t = l.replace(/\s+$/, '')
      if (!t.trim()) continue
      this.lines.push(t)
      if (this.lines.length > ANNOUNCE.keep) {
        this.lines.shift()
        this.dropped++
      }
    }
  }

  /** The line the cursor is on (usually the prompt). Spoken only along with new output, so typing is never echoed. */
  setPartial(text: string): void {
    this.partial = text.replace(/\s+$/, '')
  }

  get pending(): boolean {
    return this.lines.length > 0 || this.dropped > 0
  }

  /** The text to speak now, or null; empties the queue. */
  take(): string | null {
    if (!this.pending) return null
    const lines = [...this.lines]
    // A new answer can end at exactly the same device prompt as the previous answer.
    if (this.partial.trim() && this.partial !== lines.at(-1)) lines.push(this.partial)
    const total = lines.length + this.dropped
    const joined = lines.join('\n')
    this.lines = []
    this.dropped = 0
    if (total <= ANNOUNCE.maxLines && joined.length <= ANNOUNCE.maxChars) return joined
    const tail = lines.slice(-2).join(' ').slice(-200)
    return `${total} lines of output. Last: ${tail}`
  }

  clear(): void {
    this.lines = []
    this.dropped = 0
  }
}

/** Calls `say` with the queue's text at most once per interval (leading edge after a quiet spell). */
export class AnnounceScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private last = -Infinity

  constructor(
    private readonly queue: AnnounceQueue,
    private readonly say: (text: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly interval = ANNOUNCE.intervalMs,
    /**
     * Checked when the batch is due, not only when output arrived: output queued just before the
     * user switched tabs or turned screen reader mode off is dropped, never read out late.
     */
    private readonly allowed: () => boolean = () => true
  ) {}

  /** New output was queued. Waits a short settle so a command's whole answer is one announcement. */
  kick(): void {
    if (this.timer) return
    const wait = Math.max(150, this.last + this.interval - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.allowed()) return this.queue.clear()
      const text = this.queue.take()
      if (!text) return
      this.last = this.now()
      this.say(text)
      // More arrived while speaking: the next batch waits its turn.
      if (this.queue.pending) this.kick()
    }, wait)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
