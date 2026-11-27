import type { ParsedTable } from '@shared/productivity'
/**
 * The TextFSM hook for multi-device results. main/index.ts registers `parseSafe` (the bundled
 * ntc-templates, run in a vm with a time budget, because device output is untrusted); tests register
 * fakes. Without a parser the Table tab is disabled. This module calls whatever is registered,
 * guards it with a try/catch, and drops results that are not table-shaped. The types match
 * `@hopline/parsers`' `parseOutput`, so this module needs no import of it.
 */
export type Cell = string | string[]
export interface ParseResult {
  template: string
  ntcPlatform: string
  headers: string[]
  rows: Cell[][]
}
/** B's `parseOutput(platform, command, text, opts)`; may be made async by a worker wrapper. */
/** A time budget shared by the parses of one run (parse/safe.ts spends it). */
export interface ParseBudget {
  remainingMs: number
}
/** The total parse time one multi-device run may spend in main (Phase 4 review M7): about six worst-case devices. */
export const RUN_PARSE_BUDGET_MS = 1_500
export type ParseOutput = (platform: string, command: string, text: string, opts?: { budgetMs?: number; budget?: ParseBudget }) => ParseResult | null | Promise<ParseResult | null>

let parser: ParseOutput | null = null

export function registerParser(p: ParseOutput | null): void {
  parser = p
}

export function parserAvailable(): boolean {
  return parser !== null
}

const MAX_ROWS = 2000

/** A table for one device's output, or null (no parser, no template for the command, or a failure). */
export async function parseTable(platform: string, command: string, text: string, budget?: ParseBudget): Promise<ParsedTable | null> {
  if (!parser) return null
  // The run's budget is spent: the raw text stays, without a table.
  if (budget && budget.remainingMs <= 0) return null
  try {
    const r = await parser(platform, command, text, { budgetMs: 250, ...(budget ? { budget } : {}) })
    if (!r || !Array.isArray(r.headers) || !Array.isArray(r.rows)) return null
    return { template: String(r.template), headers: r.headers.map(String), rows: r.rows.slice(0, MAX_ROWS), ...(r.rows.length > MAX_ROWS ? { totalRows: r.rows.length } : {}) }
  } catch {
    return null
  }
}
