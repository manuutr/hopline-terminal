/**
 * Parsed show-output tables: "changed since last run" diffing, per session+command history, and
 * CSV/TSV export. Pure; the TextFSM parse itself runs in a worker (lib/parse-client).
 */
import type { Cell, ParseResult } from '@hopline/parsers'

export const cellText = (c: Cell | undefined): string => (Array.isArray(c) ? c.join(', ') : (c ?? ''))

export type RowStatus = 'same' | 'new' | 'changed'
export interface TableDiff {
  /** Per current row. */
  status: RowStatus[]
  /** Per current row: column indexes whose value changed (only for `changed`). */
  cells: Set<number>[]
  /** Per current row: the matching row of the previous run (undefined for a new row). */
  before: (Cell[] | undefined)[]
  /** Rows of the previous run that are gone. */
  removed: Cell[][]
  /** The previous run exists and had the same columns. */
  comparable: boolean
}

/**
 * Columns that identify a row: the template's Key values; otherwise the first column whose
 * values are unique (and non-empty) in both runs; otherwise the first two columns together.
 */
export function identity(prev: ParseResult, cur: ParseResult): number[] {
  const keyIdx = (cur.keys ?? []).map((k) => cur.headers.indexOf(k)).filter((i) => i >= 0)
  if (keyIdx.length) return keyIdx
  const unique = (r: ParseResult, i: number) => {
    const v = r.rows.map((row) => cellText(row[i]))
    return v.every(Boolean) && new Set(v).size === v.length
  }
  for (let i = 0; i < cur.headers.length; i++) if (unique(cur, i) && unique(prev, i)) return [i]
  return cur.headers.length > 1 ? [0, 1] : [0]
}

export function diffTables(prev: ParseResult | undefined, cur: ParseResult): TableDiff {
  const none: TableDiff = { status: cur.rows.map(() => 'same'), cells: cur.rows.map(() => new Set()), before: cur.rows.map(() => undefined), removed: [], comparable: false }
  if (!prev || prev.template !== cur.template || prev.headers.join('\0') !== cur.headers.join('\0')) return none
  const id = identity(prev, cur)
  const key = (row: Cell[]) => id.map((i) => cellText(row[i])).join('\0')
  const before = new Map<string, Cell[][]>()
  for (const row of prev.rows) {
    const k = key(row)
    before.set(k, [...(before.get(k) ?? []), row])
  }
  const status: RowStatus[] = []
  const cells: Set<number>[] = []
  const matched: (Cell[] | undefined)[] = []
  for (const row of cur.rows) {
    const k = key(row)
    const list = before.get(k)
    const old = list?.shift()
    matched.push(old)
    if (!old) {
      status.push('new')
      cells.push(new Set())
      continue
    }
    const changed = new Set<number>()
    row.forEach((c, i) => {
      if (cellText(c) !== cellText(old[i])) changed.add(i)
    })
    status.push(changed.size ? 'changed' : 'same')
    cells.push(changed)
  }
  const removed = [...before.values()].flat()
  return { status, cells, before: matched, removed, comparable: true }
}

/** Last N parsed results per session + canonical command, in memory only (never persisted). */
export const HISTORY_PER_COMMAND = 5
const MAX_KEYS = 200

export class ParseHistory {
  private map = new Map<string, { at: number; result: ParseResult }[]>()

  static key(sessionId: string, command: string, template: string): string {
    return `${sessionId}\0${template}\0${command.trim().replace(/\s+/g, ' ').toLowerCase()}`
  }

  /** Record a run; returns the previous run of the same command on the same session, if any. */
  push(key: string, result: ParseResult, at = Date.now()): { at: number; result: ParseResult } | undefined {
    const list = this.map.get(key) ?? []
    const prev = list.at(-1)
    list.push({ at, result })
    while (list.length > HISTORY_PER_COMMAND) list.shift()
    this.map.delete(key)
    this.map.set(key, list)
    while (this.map.size > MAX_KEYS) this.map.delete(this.map.keys().next().value!)
    return prev
  }

  runs(key: string): readonly { at: number; result: ParseResult }[] {
    return this.map.get(key) ?? []
  }

  clear(sessionId?: string): void {
    if (!sessionId) return this.map.clear()
    for (const k of [...this.map.keys()]) if (k.startsWith(`${sessionId}\0`)) this.map.delete(k)
  }
}

export const parseHistory = new ParseHistory()

/** Spreadsheet-safe CSV (RFC 4180 quoting; a leading = + - @ (other than a plain number or dashes) is prefixed with ' so a device value can't become a formula). */
export function toDelimited(headers: string[], rows: Cell[][], sep: ',' | '\t'): string {
  const esc = (v: string) => {
    let s = /^[=+\-@\t\r]/.test(v) && !/^[+-]?\d[\d.,:]*$|^-+$/.test(v) ? `'${v}` : v
    if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ')
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
    return s
  }
  return [headers, ...rows.map((r) => r.map(cellText))].map((r) => r.map(esc).join(sep)).join('\n')
}

/** Sort comparator: numbers numerically, interface names naturally (Gi1/0/2 before Gi1/0/10), else text. */
export function compareCells(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
