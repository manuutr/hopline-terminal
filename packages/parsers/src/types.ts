/**
 * Public API of @hopline/parsers. STABLE: workstream A (multi-device runs) and the desktop app
 * consume these shapes. Add fields; never rename or change the meaning of existing ones.
 */

/** One parsed value: a string, or a list of strings for a TextFSM `List` value. */
export type Cell = string | string[]

export interface ParseResult {
  /** The ntc-templates file that parsed the output, e.g. `cisco_ios_show_ip_interface_brief.textfsm`. */
  template: string
  /** The ntc platform the template belongs to (`cisco_ios`, `arista_eos`, ...). */
  ntcPlatform: string
  /** Column names, in template order (TextFSM Value names, e.g. `INTERFACE`, `STATUS`). */
  headers: string[]
  /** One row per record; each row is aligned with `headers`. */
  rows: Cell[][]
  /** Header names of the Values with the `Key` option, in header order (absent when none). */
  keys?: string[]
}

export interface ParseOptions {
  /** Abort (throw ParseTimeoutError) once this many ms have passed, checked between lines. */
  budgetMs?: number
}

export class ParseTimeoutError extends Error {
  constructor() {
    super('TextFSM parse exceeded its time budget')
    this.name = 'ParseTimeoutError'
  }
}
