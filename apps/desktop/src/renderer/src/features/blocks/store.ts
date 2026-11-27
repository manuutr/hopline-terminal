import type { ParseResult } from '@hopline/parsers'
import { create } from 'zustand'

/** A block's parsed table, and the previous run of the same command on the same session. */
export interface ParsedBlock {
  result: ParseResult
  at: number
  prev?: { at: number; result: ParseResult }
}

interface BlocksState {
  /** tabId → blockId → parsed table (only blocks whose output a bundled template parsed). */
  parsed: Record<string, Record<number, ParsedBlock>>
  /** tabId → the block picked with the keyboard (prompt navigation), if any. */
  selected: Record<string, number | null>
  /** The block whose table is open, per tab. */
  table: Record<string, number | null>
  setParsed(tabId: string, blockId: number, p: ParsedBlock): void
  select(tabId: string, blockId: number | null): void
  openTable(tabId: string, blockId: number | null): void
  dropTab(tabId: string): void
}

const MAX_PARSED_PER_TAB = 100

export const useBlocks = create<BlocksState>((set) => ({
  parsed: {},
  selected: {},
  table: {},
  setParsed: (tabId, blockId, p) =>
    set((s) => {
      const cur = { ...(s.parsed[tabId] ?? {}), [blockId]: p }
      const ids = Object.keys(cur).map(Number).sort((a, b) => a - b)
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PARSED_PER_TAB))) delete cur[id]
      return { parsed: { ...s.parsed, [tabId]: cur } }
    }),
  select: (tabId, blockId) => set((s) => (s.selected[tabId] === blockId ? s : { selected: { ...s.selected, [tabId]: blockId } })),
  openTable: (tabId, blockId) => set((s) => ({ table: { ...s.table, [tabId]: blockId } })),
  dropTab: (tabId) =>
    set((s) => {
      const { [tabId]: _p, ...parsed } = s.parsed
      const { [tabId]: _s, ...selected } = s.selected
      const { [tabId]: _t, ...table } = s.table
      return { parsed, selected, table }
    })
}))
