/**
 * A small, safe Markdown parser for assistant answers. It produces a block tree that the React
 * renderer turns into elements; nothing is ever passed to innerHTML, so model output (which can
 * echo device output an attacker controls) cannot inject markup.
 *
 * Supported: fenced code, headings, bullet / numbered lists, GFM tables (with alignment),
 * blockquotes, horizontal rules, paragraphs; inline code, bold, italic, strikethrough.
 * Built to tolerate streaming: a half-received table or fence renders sensibly.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { t: 'code'; lang: string; v: string }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][]; start?: number }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'p'; lines: Inline[][] }

const BULLET = /^\s*[-*+]\s+/
const NUMBER = /^\s*(\d+)[.)]\s+/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?/
/** A GFM delimiter row: | --- | :-: | --: | (outer pipes optional). */
const DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Split a table row on unescaped pipes outside inline code. */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let inCode = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '`') {
      inCode = !inCode
      cur += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

const isTableRow = (line: string | undefined): boolean => !!line && line.includes('|') && line.trim() !== ''

function alignOf(cell: string): Align {
  const c = cell.trim()
  const l = c.startsWith(':')
  const r = c.endsWith(':')
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null
}

/** Inline spans: `code`, **bold** / __bold__, *em* / _em_, ~~del~~. Unclosed markers stay literal. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length && /[\\`*_~|]/.test(text[i + 1]!)) {
      buf += text[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ t: 'code', v: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    const two = text.slice(i, i + 2)
    if (two === '**' || two === '__' || two === '~~') {
      const end = text.indexOf(two, i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: two === '~~' ? 'del' : 'strong', c: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      // Emphasis needs a non-space right after the opener and before the closer; `_` must not be
      // inside a word (interface_name, snake_case), which network output is full of.
      const prev = text[i - 1]
      const opensOk = text[i + 1] !== undefined && text[i + 1] !== ' ' && text[i + 1] !== ch && !(ch === '_' && prev && /\w/.test(prev))
      if (opensOk) {
        let end = text.indexOf(ch, i + 1)
        while (end > i && (text[end - 1] === ' ' || (ch === '_' && /\w/.test(text[end + 1] ?? '')))) end = text.indexOf(ch, end + 1)
        if (end > i + 1) {
          flush()
          out.push({ t: 'em', c: parseInline(text.slice(i + 1, end)) })
          i = end + 1
          continue
        }
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return parseLines(lines)
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!)
      i++ // closing fence (or end of a still-streaming block)
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      blocks.push({ t: 'h', level: h[1]!.length, c: parseInline(h[2]!) })
      i++
      continue
    }
    // Table: a header row followed by a delimiter row with the same (or compatible) column count.
    if (isTableRow(line) && DELIM.test(lines[i + 1] ?? '') && lines[i + 1]!.includes('-')) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]!).map(alignOf)
      const width = Math.max(head.length, align.length)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && isTableRow(lines[i]) && !FENCE.test(lines[i]!)) {
        const cells = splitRow(lines[i++]!)
        rows.push(Array.from({ length: width }, (_, c) => parseInline(cells[c] ?? '')))
      }
      blocks.push({
        t: 'table',
        align: Array.from({ length: width }, (_, c) => align[c] ?? null),
        head: Array.from({ length: width }, (_, c) => parseInline(head[c] ?? '')),
        rows
      })
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(QUOTE, ''))
      blocks.push({ t: 'quote', c: parseLines(inner) })
      continue
    }
    if (BULLET.test(line)) {
      const items: Inline[][] = []
      while (i < lines.length && BULLET.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(BULLET, '')))
      blocks.push({ t: 'ul', items })
      continue
    }
    const n = NUMBER.exec(line)
    if (n) {
      const items: Inline[][] = []
      while (i < lines.length && NUMBER.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(NUMBER, '')))
      blocks.push({ t: 'ol', items, start: Number(n[1]) })
      continue
    }
    const para: Inline[][] = []
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim() || FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || NUMBER.test(l) || QUOTE.test(l) || HR.test(l)) break
      if (isTableRow(l) && DELIM.test(lines[i + 1] ?? '') && lines[i + 1]!.includes('-')) break
      para.push(parseInline(l))
      i++
    }
    blocks.push({ t: 'p', lines: para })
  }
  return blocks
}
