import { parseOutput, type Cell, type ParseResult } from '@hopline/parsers'
import { createContext, runInContext } from 'node:vm'

/** Main-process TextFSM: device output is untrusted, so a runaway template regex is stopped, never allowed to hang main. */
export const PARSE_TIMEOUT_MS = 250
/** Bigger outputs are not parsed for the model (the raw text is truncated far below this anyway). */
const MAX_PARSE_CHARS = 512 * 1024

/** Lines longer than this are cut before parsing: no template row is that wide, and a long line is where a hostile regex backtracks. */
export const MAX_PARSE_LINE = 512

/** A time budget shared by several parses (one multi-device run): once spent, the rest are not parsed. */
export interface ParseBudget {
  remainingMs: number
}

const sandbox = createContext(Object.create(null) as object)

/** Cut every line to `MAX_PARSE_LINE` characters. */
export function clampLines(text: string): string {
  if (!text.split('\n').some((l) => l.length > MAX_PARSE_LINE)) return text
  return text
    .split('\n')
    .map((l) => (l.length > MAX_PARSE_LINE ? l.slice(0, MAX_PARSE_LINE) : l))
    .join('\n')
}

/**
 * `parseOutput` in a vm context with a timeout: V8 interrupts the whole call (including a regex in
 * catastrophic backtracking) once the budget is spent. Lines are cut to `MAX_PARSE_LINE` first. With
 * a shared `budget`, the timeout is also capped by what is left of it, and the time spent is taken
 * off it; an empty budget parses nothing. Returns null on no template, too-big input, a template
 * error, a timeout or a spent budget.
 */
export function parseSafe(platform: string, command: string, text: string, timeoutMs = PARSE_TIMEOUT_MS, budget?: ParseBudget): ParseResult | null {
  if (!text || text.length > MAX_PARSE_CHARS) return null
  const limit = Math.floor(Math.min(timeoutMs, budget ? budget.remainingMs : timeoutMs))
  if (limit < 1) return null
  const input = clampLines(text)
  const s = sandbox as Record<string, unknown>
  s['run'] = () => parseOutput(platform, command, input, { budgetMs: limit })
  const started = performance.now()
  try {
    return runInContext('run()', sandbox, { timeout: limit }) as ParseResult | null
  } catch {
    return null
  } finally {
    s['run'] = undefined
    if (budget) budget.remainingMs -= performance.now() - started
  }
}

/** At most this many rows and characters of parsed rows go to the model, next to the raw output. */
export const MAX_MODEL_ROWS = 150
export const MAX_MODEL_CHARS = 8_000

const cellText = (c: Cell | undefined): string => (Array.isArray(c) ? c.join(',') : (c ?? '')).replace(/[\t\n\r]/g, ' ')

/**
 * The parsed table as compact TSV for the model: header line, then one line per row, capped by
 * rows and characters. Empty columns (no row has a value) are dropped to keep it small.
 */
export function compactRows(r: ParseResult): { text: string; shown: number; total: number } {
  const keep = r.headers.map((_, i) => r.rows.some((row) => cellText(row[i]) !== '')).map((k, i) => (k ? i : -1)).filter((i) => i >= 0)
  const lines = [keep.map((i) => r.headers[i]).join('\t')]
  let size = lines[0]!.length
  let shown = 0
  for (const row of r.rows) {
    if (shown >= MAX_MODEL_ROWS) break
    const line = keep.map((i) => cellText(row[i])).join('\t')
    if (size + line.length + 1 > MAX_MODEL_CHARS) break
    lines.push(line)
    size += line.length + 1
    shown++
  }
  return { text: lines.join('\n'), shown, total: r.rows.length }
}
