import type { ILink, Terminal } from '@xterm/xterm'
import { networkTargets, type NetworkTarget } from '../../lib/highlight'
import { isLinkClick } from '../../lib/links'

/** Inspect rendered rows only. Rejoin soft wraps before measuring aligned, fixed-width columns. */
export function tableWidth(term: Terminal, start: number, end: number, known = 0): number {
  const buf = term.buffer.active
  if (buf.type !== 'normal') return 0
  const top = buf.viewportY
  let y = top + start
  while (y > 0 && buf.getLine(y)?.isWrapped && y > top + start - 32) y--
  let width = known
  while (y <= top + end) {
    // A grid row cannot contain a wider table unless it continues on the next row.
    if (width >= term.cols && !buf.getLine(y + 1)?.isWrapped) { y++; continue }
    let text = ''
    let columns = 0
    do {
      const row = buf.getLine(y++)
      if (!row) return width
      const wraps = buf.getLine(y)?.isWrapped
      const part = row.translateToString(!wraps)
      text += part
      if (wraps) columns += term.cols
      else if (/^[\x00-\x7f]*$/.test(part)) columns += part.length
      else {
        // A wide glyph occupies two cells, while combining marks share their base cell.
        let endCell = row.length
        while (endCell && !row.getCell(endCell - 1)?.getChars()) endCell--
        columns += endCell ? endCell - 1 + (row.getCell(endCell - 1)?.getWidth() ?? 1) : 0
      }
    } while (buf.getLine(y)?.isWrapped && columns < 4096)
    if (columns > width && /\S {2,}\S.*? {2,}\S/.test(text)) width = columns
  }
  return width
}

export function installTargetLinks(term: Terminal, pick: (target: NetworkTarget) => void): void {
  term.registerLinkProvider({
    provideLinks(y, done) {
      const row = term.buffer.active.getLine(y - 1)
      if (!row) return done(undefined)
      const targets = networkTargets(row.translateToString(true))
      if (!targets.length) return done(undefined)
      // Text indexes are UTF-16. Terminal coordinates are cells (wide and combining glyphs differ).
      const column: number[] = []
      for (let x = 0; x < row.length; x++) {
        const cell = row.getCell(x)
        if (!cell?.getWidth()) continue
        for (let i = 0; i < (cell.getChars().length || 1); i++) column.push(x + 1)
      }
      done(targets.map((t): ILink => ({
        text: t.text,
        range: { start: { x: column[t.start]!, y }, end: { x: column[t.start + t.text.length - 1]!, y } },
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => { if (isLinkClick(event)) pick(t) }
      })))
    }
  })
}

/** Use header positions so blank cells and values with embedded spaces keep their column. */
export function selectionAsTable(text: string): string {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n')
  const header = lines[0] ?? ''
  const starts = Array.from(header.matchAll(/(?:^|\s{2,})(\S(?:.*?\S)?)(?=\s{2,}|$)/g),
    (m) => m.index + m[0].length - m[1]!.length)
  if (starts.length < 2) return lines.join('\n')
  return lines.map((line) => starts.map((at, i) => line.slice(at, starts[i + 1]).trim()).join('\t')).join('\n')
}

/** Keep copies literal even when the device printed Markdown fences or markup. */
export const selectionAsMarkdown = (text: string): string => text.replace(/\r/g, '').split('\n').map((line) => '    ' + line).join('\n')
