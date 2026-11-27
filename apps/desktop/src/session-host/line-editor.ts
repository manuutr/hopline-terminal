/**
 * A small line-editor emulator over the bytes a device echoes while a guarded command is typed
 * (Phase 4 fix-round review E1–E6). Pure: no timers, no I/O.
 *
 * It follows what a terminal would show in the input area after the prompt, one *frame* at a time:
 * a frame starts whenever the device writes at the first input column again (an IOS `$` scroll
 * window, a redraw after `\r` + the prompt, a redraw after a log line). Every cell of every frame
 * must match the command at its own offset, and Enter is allowed only when every index of the
 * command was displayed and matched (no prefix shortcut).
 *
 * Understood:
 *  - printable characters overwrite at the cursor; `\b` and `CSI n D` move left, `CSI n C` right,
 *    `CSI n G` to a column;
 *  - `CSI K` / `CSI J` erase (to the end, to the start, the whole line); SGR and private modes are dropped;
 *  - `\r` + the prompt text: a redraw from the start of the input;
 *  - ` \r` with the space at the wrap column: the readline/libedit wrap (the space is dropped);
 *  - `\r\n` / `\n`: device output (a log line) interjected; it is skipped until the prompt is drawn
 *    again at the start of a line, and the input that follows is a new frame;
 *  - `$` in the first input column: an IOS scroll window, aligned to the command at the smallest
 *    offset at or after the previous window (the last window at the command's end).
 * Anything else that moves the cursor (an unknown escape, `\b` into the prompt, a `\r` that does
 * not redraw the prompt) makes the echo unverifiable: a mismatch, so Enter is never pressed.
 */

export interface EchoOptions {
  /** The prompt text the input follows (exactly as shown, e.g. `core-sw1#`, `admin@fw1> `). */
  prompt?: string
  /** Terminal width in columns, for the readline wrap (` \r` at the wrap column). */
  cols?: number
  /** Junos / PAN-OS complete a word on space (`sh` echoes `show`): a shown token may extend the typed one. */
  completeOnSpace?: boolean
  /**
   * The guard's expansion of the command (`show system storage` for `sh sys sto`). With
   * `completeOnSpace`, a word the device completed must be the expansion's word at that position,
   * not just any word that starts with what was typed (Phase 8 review A-L2). Used only when it has
   * as many words as the command; otherwise the prefix rule alone applies.
   */
  expanded?: string
}

export type EchoVerdict =
  | { state: 'ok' }
  /** `empty`: nothing shown yet; `partial`: a consistent prefix; `interrupted`: device output broke in and the line was not redrawn. */
  | { state: 'pending'; why: 'empty' | 'partial' | 'interrupted' }
  /** `wrong`: a character differs; `extra`: more than the command; `unsupported`: a redraw Hopline cannot follow. */
  | { state: 'mismatch'; why: 'wrong' | 'extra' | 'unsupported'; shown: string; detail?: string }

interface Frame {
  cells: Map<number, string>
}

const PRINTABLE = (c: string) => c >= ' ' && c !== '\x7f' && !(c >= '\x80' && c <= '\x9f')

export class LineEditor {
  private frames: Frame[] = [{ cells: new Map() }]
  private cur = 0
  private mode: 'input' | 'cr' | 'outside' = 'input'
  private acc = ''
  private esc = ''
  private last: { col: number; ch: string } | null = null
  /** Why the echo can no longer be followed (set once). */
  unsupported: string | null = null
  /** Something was ever displayed in the input area. */
  everShown = false

  constructor(private readonly o: EchoOptions = {}) {}

  private get frame(): Frame {
    return this.frames.at(-1)!
  }

  private fail(why: string): void {
    this.unsupported ??= why
  }

  feed(data: string): this {
    for (const c of data) this.char(c)
    return this
  }

  private char(c: string): void {
    if (this.unsupported) return
    if (this.esc) {
      this.esc += c
      return this.escape()
    }
    if (c === '\x1b') return void (this.esc = c)
    if (c === '\x9b') return void (this.esc = '\x1b[')
    if (c === '\x07' || c === '\x00' || c === '\x7f') return
    if (this.mode === 'outside') return this.outside(c)
    if (this.mode === 'cr') return this.afterCr(c)
    if (PRINTABLE(c)) return this.put(c)
    if (c === '\b') {
      if (this.cur === 0) return this.fail('the device moved the cursor into the prompt')
      this.cur--
      return
    }
    if (c === '\r') {
      // readline/libedit wrap: a space written at the wrap column, then `\r` on the new row.
      const cols = this.o.cols ?? 0
      const p = this.last
      if (cols > 0 && p && p.ch === ' ' && p.col === this.cur - 1 && ((this.o.prompt?.length ?? 0) + p.col) % cols === 0 && this.frame.cells.get(p.col) === ' ') {
        this.frame.cells.delete(p.col)
        this.cur = p.col
        this.last = null
        return
      }
      this.mode = 'cr'
      this.acc = ''
      return
    }
    if (c === '\n') {
      this.mode = 'outside'
      this.acc = ''
      return
    }
    this.fail(`the device sent control character 0x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  }

  private put(c: string): void {
    // Writing at the first input column again starts a new frame (a scroll window or a redraw).
    if (this.cur === 0 && this.frame.cells.size) this.frames.push({ cells: new Map() })
    this.frame.cells.set(this.cur, c)
    this.last = { col: this.cur, ch: c }
    this.cur++
    this.everShown = true
  }

  /** After `\r`: the prompt drawn again (a redraw), or `\n` (device output). */
  private afterCr(c: string): void {
    if (c === '\n') {
      this.mode = 'outside'
      this.acc = ''
      return
    }
    if (c === '\r') return void (this.acc = '')
    const prompt = this.o.prompt ?? ''
    if (!PRINTABLE(c) || !prompt) return this.fail('the device returned to the start of the line without drawing the prompt')
    this.acc += c
    if (!prompt.startsWith(this.acc)) return this.fail('the device returned to the start of the line and drew something other than the prompt')
    if (this.acc === prompt) this.resume()
  }

  /** Device output on its own line: skipped until the prompt is drawn at the start of a line. */
  private outside(c: string): void {
    if (c === '\r' || c === '\n') return void (this.acc = '')
    if (!PRINTABLE(c)) return
    this.acc += c
    const prompt = this.o.prompt ?? ''
    if (prompt && this.acc === prompt) this.resume()
  }

  private resume(): void {
    this.mode = 'input'
    this.acc = ''
    this.cur = 0
    this.last = null
    // A new frame starts at the next character written; the old one stays until it is erased.
    if (this.frame.cells.size) this.frames.push({ cells: new Map() })
  }

  private escape(): void {
    const s = this.esc
    if (s.length > 64) return (this.esc = ''), this.fail('an overlong escape sequence')
    if (s.length < 2) return
    const kind = s[1]!
    if (kind === '[') {
      const m = /^\x1b\[([0-?]*)([ -/]*)([@-~])$/.exec(s)
      if (!m) {
        if (!/^\x1b\[[0-?]*[ -/]*$/.test(s)) (this.esc = ''), this.fail('a malformed escape sequence')
        return
      }
      this.esc = ''
      return this.csi(m[1]!, m[3]!)
    }
    if (kind === ']') {
      // OSC (window title): no effect on the line.
      if (s.endsWith('\x07') || s.endsWith('\x1b\\')) this.esc = ''
      return
    }
    if (kind === '(' || kind === ')') {
      if (s.length === 3) this.esc = ''
      return
    }
    this.esc = ''
    if ('=>'.includes(kind)) return
    this.fail(`the device sent an escape sequence Hopline Terminal does not follow (ESC ${kind})`)
  }

  private csi(params: string, final: string): void {
    if (final === 'm' || params.startsWith('?') || params.startsWith('>')) return
    const n = params === '' ? NaN : Number(params)
    if (this.mode !== 'input') {
      // Erasing before the prompt is drawn again (`\r\x1b[K` + prompt) changes nothing we follow.
      if (final === 'K' || final === 'J') return
      return this.fail(`the device moved the cursor (CSI ${params}${final}) outside the input`)
    }
    const cells = this.frame.cells
    switch (final) {
      case 'K':
      case 'J': {
        const mode = Number.isNaN(n) ? 0 : n
        for (const col of [...cells.keys()]) if (mode === 2 || (mode === 0 && col >= this.cur) || (mode === 1 && col <= this.cur)) cells.delete(col)
        return
      }
      case 'D': {
        const k = Number.isNaN(n) ? 1 : n
        if (k > this.cur) return this.fail('the device moved the cursor into the prompt')
        this.cur -= k
        return
      }
      case 'C':
        this.cur += Number.isNaN(n) ? 1 : n
        return
      case 'G': {
        const col = (Number.isNaN(n) ? 1 : n) - 1 - (this.o.prompt?.length ?? 0)
        if (col < 0) return this.fail('the device moved the cursor into the prompt')
        this.cur = col
        return
      }
    }
    this.fail(`the device sent an escape sequence Hopline Terminal does not follow (CSI ${params}${final})`)
  }

  /** The input line as the current frame shows it (gaps as spaces). */
  text(): string {
    const cells = this.frame.cells
    if (!cells.size) return ''
    const max = Math.max(...cells.keys())
    let s = ''
    for (let i = 0; i <= max; i++) s += cells.get(i) ?? ' '
    return s
  }

  /** The line is empty again (after an abandon): nothing but blanks left, cursor at the start, at the prompt. */
  blank(): boolean {
    return !this.unsupported && this.mode === 'input' && this.text().trim() === '' && this.cur === 0
  }

  /** Was the echo interrupted by device output that never redrew the line? */
  get interrupted(): boolean {
    return this.mode !== 'input'
  }

  /** The frames in order, for the verdict: each as column → character. */
  framesForVerdict(): ReadonlyArray<ReadonlyMap<number, string>> {
    return this.frames.map((f) => f.cells).filter((c) => c.size)
  }

  get cursor(): number {
    return this.cur
  }
}

const shownText = (cells: ReadonlyMap<number, string>): string => {
  if (!cells.size) return ''
  const max = Math.max(...cells.keys())
  let s = ''
  for (let i = 0; i <= max; i++) s += cells.get(i) ?? ' '
  return s
}

/** Highest column of a frame that is not a trailing blank (erase padding), or -1. */
const lastInk = (cells: ReadonlyMap<number, string>): number => {
  let max = -1
  for (const [col, ch] of cells) if (ch !== ' ' && col > max) max = col
  return max
}

/**
 * Compare what the device echoed with the command typed, before Enter is pressed.
 * `ok` only when every character of the command was displayed at its own offset and matched, the
 * last frame ends at the command's end and the cursor is there.
 */
export function echoVerdict(command: string, echoed: string, o: EchoOptions = {}): EchoVerdict {
  const ed = new LineEditor(o).feed(echoed)
  return verdictOf(command, ed, o)
}

export function verdictOf(command: string, ed: LineEditor, o: EchoOptions = {}): EchoVerdict {
  const cmd = command.trim()
  const frames = ed.framesForVerdict()
  const lastShown = () => shownText(frames.at(-1) ?? new Map()).trim().slice(0, 80)
  if (ed.unsupported) return { state: 'mismatch', why: 'unsupported', shown: lastShown(), detail: ed.unsupported }
  if (!frames.length) return { state: 'pending', why: ed.interrupted ? 'interrupted' : 'empty' }
  const n = cmd.length
  const scrolls = (cells: ReadonlyMap<number, string>) => cells.get(0) === '$' && cmd[0] !== '$'
  if (o.completeOnSpace && !frames.some(scrolls)) return tokenVerdict(cmd, frames, ed, o.expanded)

  const covered = new Array<boolean>(n).fill(false)
  let prevW = 0
  for (const [i, cells] of frames.entries()) {
    const isLast = i === frames.length - 1
    const ink = lastInk(cells)
    const shown = shownText(cells).trim().slice(0, 80)
    if (ink < 0) continue
    if (!scrolls(cells)) {
      for (const [col, ch] of cells) {
        // Blanks after the last character may be erase padding (a shorter redraw): never a
        // mismatch, but they show a space of the command where it has one.
        if (col > ink) {
          if (cmd[col] === ' ') covered[col] = true
          continue
        }
        if (col >= n) return { state: 'mismatch', why: 'extra', shown }
        if (cmd[col] !== ch) return { state: 'mismatch', why: 'wrong', shown }
        covered[col] = true
      }
      prevW = 0
      continue
    }
    // A `$` window: find where it sits in the command.
    if (ink === 0) continue
    const fits = (w: number) => {
      for (const [col, ch] of cells) {
        if (col === 0 || col > ink) continue
        if (w + col >= n) return false
        if (cmd[w + col] !== ch) return false
      }
      return true
    }
    let w = -1
    const endW = n - 1 - ink
    if (isLast && endW >= prevW && fits(endW)) w = endW
    else for (let k = prevW; k < n; k++) if (fits(k)) {
      w = k
      break
    }
    if (w < 0) return { state: 'mismatch', why: ink + prevW >= n ? 'extra' : 'wrong', shown }
    for (const [col, ch] of cells) if (col > 0 && w + col < n && (col <= ink || cmd[w + col] === ch)) covered[w + col] = true
    prevW = w
  }
  const last = frames.at(-1)!
  const ink = lastInk(last)
  const w = scrolls(last) ? prevW : 0
  if (ed.interrupted) return { state: 'pending', why: 'interrupted' }
  if (covered.every(Boolean) && w + ink === n - 1 && ed.cursor === ink + 1) return { state: 'ok' }
  return { state: 'pending', why: 'partial' }
}

/** Junos / PAN-OS: tokens may be completed by the device (`sh` → `show`); the last frame shows the whole line. */
function tokenVerdict(cmd: string, frames: ReadonlyArray<ReadonlyMap<number, string>>, ed: LineEditor, expanded?: string): EchoVerdict {
  const typed = cmd.split(/\s+/)
  const exp = expanded?.trim().split(/\s+/)
  const aligned = exp && exp.length === typed.length ? exp : undefined
  /** A shown word that extends the typed one: the device completed it, so it must be the guard's word. */
  const completedOk = (k: number, e: string) => e === typed[k] || !aligned || e.toLowerCase() === aligned[k]!.toLowerCase()
  for (const [i, cells] of frames.entries()) {
    const text = shownText(cells)
    const visible = text.replace(/\s+$/, '')
    const shown = visible.trim().slice(0, 80)
    if (!visible) continue
    if (/^\s/.test(visible)) return { state: 'mismatch', why: 'wrong', shown }
    const words = visible.split(/\s+/)
    const open = !/\s$/.test(text.slice(0, ed.cursor)) || i < frames.length - 1
    for (const [k, e] of words.entries()) {
      const t = typed[k]
      if (t === undefined) return { state: 'mismatch', why: 'extra', shown }
      if (e.startsWith(t)) {
        // Still being completed (the last word, the line open): a prefix of the guard's word is fine.
        if (completedOk(k, e) || (k === words.length - 1 && open && aligned?.[k]!.toLowerCase().startsWith(e.toLowerCase()))) continue
        return { state: 'mismatch', why: 'wrong', shown }
      }
      if (k === words.length - 1 && open && t.startsWith(e)) continue
      return { state: 'mismatch', why: 'wrong', shown }
    }
  }
  if (ed.interrupted) return { state: 'pending', why: 'interrupted' }
  const last = frames.at(-1)!
  const visible = shownText(last).replace(/\s+$/, '')
  const words = visible.split(/\s+/)
  const complete = words.length === typed.length && words.at(-1)!.startsWith(typed.at(-1)!) && completedOk(words.length - 1, words.at(-1)!) && ed.cursor >= visible.length
  return complete ? { state: 'ok' } : { state: 'pending', why: 'partial' }
}

/**
 * The clear phase's output (E4): only erasing is allowed (`\b`, spaces, `CSI K`/`J`, cursor moves,
 * colour, a bell, `\r` + the same prompt). Anything else printable (an IOS-style device that shows
 * `^U`) means the clear key reached the line as text. Returns the unexpected text, or null.
 */
export function clearOutputProblem(output: string, prompt: string): string | null {
  // eslint-disable-next-line no-control-regex
  let s = output.replace(/\x1b\[[0-9;?]*[mKJDCGhl]/g, '').replace(/[\x07\x00\b\x7f]/g, '')
  if (prompt) s = s.split(`\r${prompt}`).join('\r').split(`\r\n${prompt}`).join('\r')
  s = s.replace(/[ \r]/g, '')
  if (!s) return null
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f]/g, (c) => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`).slice(0, 40)
}
