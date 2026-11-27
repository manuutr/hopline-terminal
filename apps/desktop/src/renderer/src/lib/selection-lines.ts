import type { Terminal } from '@xterm/xterm'
import { visibleText } from './announce'

/**
 * The selection widened to whole lines, for "Ask AI about the selection" (Phase 4 fix-round review
 * K2). Redaction in main recognises a secret by its keyword (`snmp-server community X`,
 * `password 7 X`); a selection that starts after the keyword (`nity SECRETCOMM RO`) would reach the
 * model with the secret intact. Whole lines keep the keyword with the value. Wrapped rows count as
 * one line. Pure over a minimal buffer shape, so it is unit-tested without xterm.
 */
export interface LineBuffer {
  length: number
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

/** Rows are 0-based buffer rows, as xterm's selection model reports them. */
export function wholeLines(buf: LineBuffer, startRow: number, endRow: number): string {
  let from = Math.max(0, Math.min(startRow, endRow))
  let to = Math.min(buf.length - 1, Math.max(startRow, endRow))
  while (from > 0 && buf.getLine(from)?.isWrapped) from--
  while (to + 1 < buf.length && buf.getLine(to + 1)?.isWrapped) to++
  const out: string[] = []
  for (let y = from; y <= to; y++) {
    const l = buf.getLine(y)
    if (!l) continue
    const text = l.translateToString(!buf.getLine(y + 1)?.isWrapped)
    if (l.isWrapped && out.length) out[out.length - 1] += text
    else out.push(text)
  }
  return out.join('\n')
}

/** The terminal's selection as whole lines, or its plain selection when xterm reports no range. */
export function selectionWholeLines(term: {
  getSelection(): string
  getSelectionPosition(): { start: { y: number }; end: { y: number } } | undefined
  buffer: { active: LineBuffer }
}): string {
  const pos = term.getSelectionPosition()
  const sel = term.getSelection()
  if (!pos || !sel) return sel
  return wholeLines(term.buffer.active, pos.start.y, pos.end.y)
}

/** Preserve complete logical lines for redaction, and omit characters the device concealed. */
export function visibleSelection(term: Terminal): string {
  const pos = term.getSelectionPosition()
  if (!pos) return ''
  const buf = term.buffer.active
  return wholeLines({
    length: buf.length,
    getLine: (y) => {
      const row = buf.getLine(y)
      return row && { isWrapped: row.isWrapped, translateToString: (trim) => visibleText(row, trim) }
    }
  }, pos.start.y, pos.end.y)
}
