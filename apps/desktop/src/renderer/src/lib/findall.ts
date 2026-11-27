/** The parts of an xterm buffer the search reads (a fake one in unit tests). */
export interface SearchLine {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}
export interface SearchBuffer {
  readonly length: number
  getLine(y: number): SearchLine | undefined
}

export interface FindHit {
  tabId: string
  /** Buffer row where the (logical) line started when it was found. Scrollback trimming can shift it. */
  line: number
  /** The whole logical line: soft-wrapped rows joined. */
  text: string
  start: number
  end: number
  /** What was searched for, to find the match again if the line has moved. */
  query: string
}

/** Where to put the selection for a hit, resolved against the buffer as it is now. */
export interface HitPosition {
  row: number
  col: number
  length: number
}

interface Logical {
  /** First buffer row of the logical line. */
  start: number
  text: string
  /** Length of each row's part of `text`, in order. */
  parts: number[]
}

/**
 * The logical line that ends at row `end` (walking back over soft-wrapped rows). Rows that wrap
 * are full, so they are taken untrimmed; only the last row is right-trimmed. A match split across
 * a soft wrap is then found in the joined text.
 */
function logicalEndingAt(buf: SearchBuffer, end: number): Logical {
  let start = end
  while (start > 0 && buf.getLine(start)?.isWrapped) start--
  const parts: string[] = []
  for (let y = start; y <= end; y++) parts.push(buf.getLine(y)?.translateToString(y === end) ?? '')
  return { start, text: parts.join(''), parts: parts.map((p) => p.length) }
}

/** The logical line starting at row `start`, or undefined if `start` is a continuation row. */
function logicalStartingAt(buf: SearchBuffer, start: number): Logical | undefined {
  if (start < 0 || start >= buf.length || buf.getLine(start)?.isWrapped) return undefined
  let end = start
  while (end + 1 < buf.length && buf.getLine(end + 1)?.isWrapped) end++
  return logicalEndingAt(buf, end)
}

/** Logical lines from the bottom of the buffer up. */
function* logicalLines(buf: SearchBuffer, from = buf.length - 1): Generator<Logical> {
  let y = Math.min(from, buf.length - 1)
  // Start at the end of a logical line.
  while (y + 1 < buf.length && buf.getLine(y + 1)?.isWrapped) y++
  while (y >= 0) {
    const l = logicalEndingAt(buf, y)
    yield l
    y = l.start - 1
  }
}

/** Search every logical line of each terminal buffer (case-insensitive, plain text), newest first. */
export function findInBuffers(buffers: { tabId: string; term: { buffer: { active: SearchBuffer } } }[], query: string, limitPerTab = 200): FindHit[] {
  const q = query.toLowerCase()
  if (!q) return []
  const hits: FindHit[] = []
  for (const { tabId, term } of buffers) {
    let n = 0
    for (const l of logicalLines(term.buffer.active)) {
      if (n >= limitPerTab) break
      const at = l.text.toLowerCase().indexOf(q)
      if (at >= 0) {
        hits.push({ tabId, line: l.start, text: l.text, start: at, end: at + q.length, query })
        n++
      }
    }
  }
  return hits
}

function position(l: Logical, start: number, length: number): HitPosition {
  let row = l.start
  let col = start
  for (const len of l.parts.slice(0, -1)) {
    if (col < len) break
    col -= len
    row++
  }
  return { row, col, length }
}

/**
 * Find a hit again at jump time. Output that arrived since the search may have trimmed the top of
 * the scrollback, moving every line up: use the recorded row if it still holds the same text,
 * else the nearest line above it with that text, else the nearest line containing the query.
 */
export function resolveHit(buf: SearchBuffer, hit: FindHit): HitPosition | undefined {
  const length = hit.end - hit.start
  const here = logicalStartingAt(buf, hit.line)
  if (here && here.text === hit.text) return position(here, hit.start, length)
  // Trimming only moves lines up, so look from the recorded row upwards first.
  for (const l of logicalLines(buf, hit.line)) if (l.text === hit.text) return position(l, hit.start, length)
  const q = hit.query.toLowerCase()
  let best: { l: Logical; at: number } | undefined
  for (const l of logicalLines(buf)) {
    const at = l.text.toLowerCase().indexOf(q)
    if (at < 0) continue
    if (!best || Math.abs(l.start - hit.line) < Math.abs(best.l.start - hit.line)) best = { l, at }
  }
  return best ? position(best.l, best.at, length) : undefined
}
