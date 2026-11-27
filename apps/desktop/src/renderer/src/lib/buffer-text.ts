/**
 * A terminal buffer as plain text for the accessible buffer view: soft-wrapped rows are joined into
 * their logical line, and each buffer row maps to the character offset of its line, so a command
 * block's prompt row can be found in the text.
 */
export interface BufferRows {
  length: number
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

export interface BufferText {
  text: string
  /** Character offset in `text` of the logical line holding buffer row y. */
  offsetOfRow: (y: number) => number
  /** The buffer row whose line holds character offset `o`. */
  rowAt: (o: number) => number
}

export function bufferText(buf: BufferRows): BufferText {
  const parts: string[] = []
  const rowStart: number[] = new Array(buf.length)
  let offset = 0
  let current = ''
  let currentStart = 0
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    const s = line?.translateToString(!buf.getLine(y + 1)?.isWrapped) ?? ''
    if (y > 0 && line?.isWrapped) current += s
    else {
      if (y > 0) {
        parts.push(current)
        offset += current.length + 1
      }
      current = s
      currentStart = offset
    }
    rowStart[y] = currentStart
  }
  if (buf.length) parts.push(current)
  // Trailing empty rows (an unused screen below the prompt) are not text.
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const text = parts.join('\n')
  return {
    text,
    offsetOfRow: (y) => Math.min(text.length, rowStart[Math.max(0, Math.min(y, buf.length - 1))] ?? 0),
    rowAt: (o) => {
      // Last row whose line starts at or before o (rows are in order).
      let lo = 0
      let hi = buf.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if ((rowStart[mid] ?? 0) <= o) lo = mid
        else hi = mid - 1
      }
      return lo
    }
  }
}

/** Every match of `q` in `text` (case-insensitive unless `caseSensitive`), as start offsets. */
export function findAll(text: string, q: string, caseSensitive = false): number[] {
  if (!q) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? q : q.toLowerCase()
  const out: number[] = []
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 10_000; i = hay.indexOf(needle, i + needle.length)) out.push(i)
  return out
}
