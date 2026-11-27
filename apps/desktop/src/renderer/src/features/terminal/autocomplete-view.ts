import type { ModeId, PlatformId } from '@hopline/cli-model'
import type { Terminal } from '@xterm/xterm'
import { LiveHarvest, reconcileLine, screenMode, suggest, type Suggestion } from '../../lib/autocomplete'

/**
 * Terminal autocomplete: ghost text after the cursor and a small hint list under the line, drawn as
 * DOM over the xterm canvas. Nothing is written into the terminal buffer, so ghost text never
 * reaches copy, scrollback, logs or find. Accepting (Tab, → or End) types only the remaining characters
 * through the normal input path. With no ghost on screen, Tab goes to the device (its own completion),
 * and Enter and everything else always go to the device.
 *
 * The typed line comes from the caller's local tracking (lib/aiprefix), so a suggestion is ready in
 * the keystroke handler without waiting for the device echo. The screen is the source of truth: once
 * output newer than the last key arrives at a prompt, its typed text replaces the local copy.
 */

export interface AutocompleteHost {
  platform: () => PlatformId | null
  enabled: () => boolean
  /** Input is locked (the assistant is typing) or an "@ai" question is being typed. */
  blocked: () => boolean
  /** The locally tracked line, or null when unknown. */
  line: () => string | null
  /** Replace the locally tracked line (re-sync from the screen). */
  setLine: (line: string) => void
  /** Type text as if the user had (the normal input path). */
  type: (text: string) => void
}

const HINT_ROWS = 6
const LAT_KEEP = 400

export class TermAutocomplete {
  private mode: ModeId | null = null
  /** Buffer column where the typed line starts (after the prompt), and its absolute row. */
  private anchor: { x: number; row: number } | null = null
  private ghostEl: HTMLDivElement
  private hintEl: HTMLDivElement
  private shown: Suggestion & { line: string } = { ghost: '', partial: '', candidates: [], line: '' }
  private keyAt = 0
  private lastKey = 0
  private lastOutput = 0
  readonly harvest: LiveHarvest
  /** keydown → ghost in the DOM, in ms: includes the echo round trip and any wait for the CPU. */
  readonly latencies: number[] = []
  /** The suggestion work itself (one render, ms), for the e2e budget: steady when the machine is busy. */
  readonly work: number[] = []

  constructor(
    private readonly term: Terminal,
    private readonly host: AutocompleteHost
  ) {
    this.harvest = new LiveHarvest(host.platform)
    this.ghostEl = document.createElement('div')
    this.ghostEl.className = 'hop-ghost'
    this.ghostEl.setAttribute('aria-hidden', 'true')
    this.hintEl = document.createElement('div')
    this.hintEl.className = 'hop-hints'
    this.hintEl.setAttribute('aria-hidden', 'true')
    term.element?.append(this.ghostEl, this.hintEl)
    this.hide()
  }

  dispose(): void {
    this.ghostEl.remove()
    this.hintEl.remove()
  }

  get ghost(): string {
    return this.ghostEl.style.display === 'none' ? '' : this.shown.ghost
  }

  /** keydown, before xterm handles it. Returns true when the key was used here (accept). */
  keydown(e: KeyboardEvent): boolean {
    this.keyAt = e.timeStamp || performance.now()
    if (!this.ghost) return false
    const accept = (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'End') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    if (!accept) return false
    // The DOM may be stale (scrolled back, setting turned off, assistant started): check again, and
    // let the key go to the device if the ghost should no longer be there.
    if (!this.canShow() || this.host.line() !== this.shown.line) {
      this.hide()
      return false
    }
    e.preventDefault()
    this.host.type(this.shown.ghost)
    return true
  }

  /** The user sent `data` (after the caller's line tracking ran); `before` is the line before it. */
  sent(data: string, before: string | null): void {
    this.lastKey = performance.now()
    if (data === '\r' && before !== null) this.harvest.ran(before, this.mode)
    if (data.endsWith('\r') || data.includes('\x03')) {
      // A new line: the mode comes from the next prompt.
      this.mode = null
      this.anchor = null
    }
    this.render()
  }

  /** Device output (raw). */
  output(data: string): void {
    this.lastOutput = performance.now()
    this.harvest.output(data)
  }

  /** xterm parsed output: re-read the prompt and the typed text when the screen is current. */
  parsed(): void {
    if (this.lastOutput <= this.lastKey) return this.render()
    const p = this.host.platform()
    const b = this.term.buffer.active
    if (!p || b.type === 'alternate') {
      this.mode = null
      return this.render()
    }
    const row = b.baseY + b.cursorY
    const lines: string[] = []
    for (let i = Math.max(0, row - 2); i < row; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
    lines.push(b.getLine(row)?.translateToString(true, 0, b.cursorX) ?? '')
    // Text right of the cursor (after ← or Ctrl+A) means the cursor is mid-line: no suggestion there.
    const rest = b.getLine(row)?.translateToString(true, b.cursorX) ?? ''
    const st = rest.trim() ? null : screenMode(p, lines.join('\n'))
    this.mode = st?.mode ?? null
    if (st) {
      this.anchor = { x: b.cursorX - [...st.pending].length, row }
      // The screen wins, except while the echo of keys already sent is still on its way (what the
      // screen shows is then a prefix of the local line). A `?` never stays on the line: the device
      // printed help and redrew the line without it.
      const next = reconcileLine(this.host.line(), st.pending, this.host.blocked())
      if (next !== undefined) this.host.setLine(next)
    } else this.anchor = null
    this.render()
  }

  hide(): void {
    this.ghostEl.style.display = 'none'
    this.hintEl.style.display = 'none'
  }

  /** Every condition under which nothing may be suggested (or accepted). */
  private canShow(): boolean {
    const b = this.term.buffer.active
    return this.host.enabled() && !!this.host.platform() && !!this.mode && !!this.anchor && this.host.line() !== null && !this.host.blocked() && b.type !== 'alternate' && b.viewportY === b.baseY
  }

  /** Re-check after something other than a key or output changed (scroll, resize, settings, assistant). */
  refresh(): void {
    this.render()
  }

  /**
   * The device has echoed `line`: the cursor sits right after it on the anchor row and the screen
   * shows exactly it. Until then the ghost would be drawn ahead of text that is not there yet.
   */
  private echoed(line: string): boolean {
    const b = this.term.buffer.active
    if (!this.anchor || b.baseY + b.cursorY !== this.anchor.row || b.cursorX !== this.anchor.x + line.length) return false
    return (b.getLine(this.anchor.row)?.translateToString(false, this.anchor.x, b.cursorX) ?? '') === line
  }

  private render(): void {
    const t0 = this.keyAt
    this.keyAt = 0
    const start = performance.now()
    const line = this.host.line()
    const p = this.host.platform()
    const b = this.term.buffer.active
    if (!this.canShow() || !p || line === null || !this.mode || !this.anchor) return this.hide()
    const s = { ...suggest(p, this.mode, line, this.harvest.live), line }
    this.shown = s
    const cell = cellSize(this.term)
    const col = this.anchor.x + line.length
    const vrow = this.anchor.row - b.viewportY
    if (!cell || vrow < 0 || vrow >= this.term.rows) return this.hide()
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen')
    const ox = screen?.offsetLeft ?? 0
    const oy = screen?.offsetTop ?? 0
    // Ghost text waits for the echo: drawn from the local line alone, it would flash ahead of the
    // typed characters for one round trip. The keystroke's latency is counted when it is drawn.
    const echoed = this.echoed(line)
    if (s.ghost && !echoed && t0) this.keyAt = t0

    if (s.ghost && echoed && col + s.ghost.length <= this.term.cols) {
      this.ghostEl.textContent = s.ghost
      this.ghostEl.style.fontFamily = this.term.options.fontFamily ?? ''
      this.ghostEl.style.fontSize = `${this.term.options.fontSize ?? 13}px`
      Object.assign(this.ghostEl.style, { display: 'block', left: `${ox + col * cell.w}px`, top: `${oy + vrow * cell.h}px`, height: `${cell.h}px`, lineHeight: `${cell.h}px` })
    } else this.ghostEl.style.display = 'none'

    const rows = s.candidates.filter((c) => c.kind !== 'cr' || s.candidates.length > 1).slice(0, HINT_ROWS)
    if (rows.length && line.trim()) {
      this.hintEl.replaceChildren(
        ...rows.map((c) => {
          const r = document.createElement('div')
          r.className = 'hop-hint'
          r.dataset['kind'] = c.kind
          const w = document.createElement('span')
          w.className = 'hop-hint-word'
          w.textContent = c.text
          const h = document.createElement('span')
          h.className = 'hop-hint-help'
          h.textContent = c.kind === 'value' && c.label ? `${c.label} · learned` : c.help
          r.append(w, h)
          return r
        })
      )
      const x = ox + Math.max(0, this.anchor.x + line.length - s.partial.length) * cell.w
      // Under the line, or above it near the bottom of the screen.
      const below = vrow + 1 + rows.length <= this.term.rows
      Object.assign(this.hintEl.style, {
        display: 'block',
        left: `${Math.min(x, Math.max(0, (this.term.cols - 40) * cell.w))}px`,
        top: below ? `${oy + (vrow + 1) * cell.h + 2}px` : '',
        bottom: below ? '' : `${(this.term.element?.clientHeight ?? 0) - (oy + vrow * cell.h) + 2}px`
      })
    } else this.hintEl.style.display = 'none'

    if (t0 && !this.keyAt) {
      const end = performance.now()
      this.latencies.push(end - t0)
      this.work.push(end - start)
      if (this.latencies.length > LAT_KEEP) this.latencies.shift()
      if (this.work.length > LAT_KEEP) this.work.shift()
    }
  }
}

/** The rendered cell size (xterm's own measurement; private API, with a fallback). */
function cellSize(term: Terminal): { w: number; h: number } | null {
  const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell
  if (dims?.width && dims.height) return { w: dims.width, h: dims.height }
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || !term.cols || !term.rows) return null
  return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows }
}
