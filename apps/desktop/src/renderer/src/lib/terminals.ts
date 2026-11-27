import { testClipboard } from './clipboard'
import type { Terminal } from '@xterm/xterm'
import type { BlockController } from '../features/blocks/controller'

export interface TermHandle {
  term: Terminal
  focus: () => void
  openFind: () => void
  /** Edit › Find next / previous: step through the find bar's matches (opens the bar when it has none). */
  findStep?: (dir: 'next' | 'prev') => void
  /** Clear the scrollback (and what is saved of it). */
  clear?: () => void
  /** Paste through the terminal's own path: several lines ask first; `confirm` always asks. */
  paste?: (text: string, o?: { confirm?: boolean }) => void
  /** Device output goes through here (highlighting), not straight to term.write. */
  write: (data: string) => void
  /** Autocomplete state for e2e: the ghost text shown, keydown→ghost latencies and render work (ms), learned live values. */
  ghost?: () => { text: string; latencies: number[]; work: number[]; live: Record<string, readonly string[] | undefined> }
  /** Command blocks of this terminal (prompt navigation, block actions). */
  blocks?: BlockController
  /** The renderer xterm is really using (WebGL can be unavailable or lost). */
  renderer?: () => 'webgl' | 'dom'
}

/** tabId → live xterm instance. Main-process data is routed here. */
export const terminals = new Map<string, TermHandle>()

let wired = false
export function wireTerminalEvents(onState: Parameters<typeof window.hopline.term.onState>[0]): void {
  if (wired) return
  wired = true
  window.hopline.term.onData((tabId, data) => {
    const h = terminals.get(tabId)
    if (!h) return window.hopline.term.ack(tabId, data.length)
    h.write(data)
    // Ack once xterm has parsed it (writes are processed in order), so a flood pauses the device
    // instead of piling up in renderer memory.
    h.term.write('', () => window.hopline.term.ack(tabId, data.length))
  })
  window.hopline.term.onState(onState)
}

/**
 * Read-only test hook: the visible buffer of a tab as plain text. WebGL rendering leaves no DOM
 * text, so e2e tests read it here. Exposes nothing the renderer doesn't already hold.
 */
;(window as unknown as { __hoplineTest: unknown }).__hoplineTest = {
  /** The in-memory clipboard of an e2e run (see lib/clipboard). */
  clipboard: testClipboard,
  text(tabId?: string): string {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    if (!h) return ''
    const buf = h.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n').trimEnd()
  },
  /** The terminal's live font, cursor and theme background (per-host overrides, themes). */
  options(tabId?: string) {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    if (!h) return null
    const o = h.term.options
    return { fontSize: o.fontSize, fontFamily: o.fontFamily, lineHeight: o.lineHeight, cursorStyle: o.cursorStyle, cursorBlink: o.cursorBlink, background: o.theme?.background }
  },
  /** Autocomplete: the ghost text after the cursor (drawn over the canvas, so not in `text()`), its latencies and learned values. */
  ghost(tabId?: string) {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    return h?.ghost?.() ?? { text: '', latencies: [], work: [], live: {} }
  },
  /** Command blocks of a tab: command, output and (once parsed) the TextFSM table size. Read-only. */
  blocks(tabId?: string): { id: number; command: string; output: string; prompt: string }[] {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    const c = h?.blocks
    return c ? c.blocks.filter((b) => !b.start.isDisposed).map((b) => ({ id: b.id, command: b.command, prompt: b.prompt, output: c.output(b) })) : []
  },
  /** Which renderer a tab's xterm really uses (benchmarks label runs by this, never by intent). */
  renderer(tabId?: string): 'webgl' | 'dom' | null {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    return h?.renderer?.() ?? null
  },
  /** The xterm instance itself, for benchmarks (e2e builds only: `hopline.testMode`). */
  raw(tabId?: string): Terminal | null {
    if (!window.hopline?.testMode) return null
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    return h?.term ?? null
  },
  /** Open tab ids, in creation order (benchmarks drive several tabs). */
  tabs(): string[] {
    return [...terminals.keys()]
  },
  /** Selected text in the focused tab's terminal. */
  /** Scroll the view (negative: back into scrollback; 0: to the bottom). View only, sends nothing. */
  scroll(lines: number, tabId?: string): void {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    if (lines === 0) h?.term.scrollToBottom()
    else h?.term.scrollLines(lines)
  },
  selection(): string {
    const id = (window as unknown as { __hoplineActiveTab?: () => string | null }).__hoplineActiveTab?.()
    return (id ? terminals.get(id)?.term.getSelection() : '') ?? ''
  },
  /** The last `n` non-empty lines only: cheap enough to poll while output is streaming. */
  tail(n = 3, tabId?: string): string {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    if (!h) return ''
    const buf = h.term.buffer.active
    const out: string[] = []
    for (let i = buf.length - 1; i >= 0 && out.length < n; i--) {
      const l = buf.getLine(i)?.translateToString(true) ?? ''
      if (l.trim() || out.length) out.unshift(l)
    }
    return out.join('\n').trimEnd()
  },
  /**
   * Throughput benchmark: push `mb` megabytes of device-like output through the same path as
   * real data (highlighter → xterm) and resolve with MB/s once xterm has parsed all of it.
   */
  async bench(mb = 16, raw = false, tabId?: string): Promise<{ mb: number; ms: number; mbps: number }> {
    const h = tabId ? terminals.get(tabId) : [...terminals.values()].at(-1)
    if (!h) throw new Error('no terminal')
    const line = (i: number) =>
      `GigabitEthernet1/0/${i % 48}   10.${(i >> 8) & 255}.${i & 255}.1   YES manual ${i % 7 ? 'up' : 'administratively down'}   up   aabb.cc00.${(i % 9999).toString().padStart(4, '0')}\r\n`
    let chunk = ''
    for (let i = 0; chunk.length < 64 * 1024; i++) chunk += line(i)
    const n = Math.ceil((mb * 1024 * 1024) / chunk.length)
    const t0 = performance.now()
    for (let i = 0; i < n; i++) (raw ? h.term.write(chunk) : h.write(chunk))
    await new Promise<void>((resolve) => h.term.write('', resolve))
    const ms = performance.now() - t0
    const total = (n * chunk.length) / 1024 / 1024
    return { mb: total, ms, mbps: total / (ms / 1000) }
  }
}
