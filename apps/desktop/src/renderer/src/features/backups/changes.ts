import { stanzaPaths, type StanzaStyle } from '@shared/config-text'

/** Monaco's ILineChange, 1-based; an end of 0 means nothing on that side (a pure insert or delete). */
export interface LineChange {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

export interface ChangeSummary {
  /** Lines added and removed in this hunk. */
  added: number
  removed: number
  /** The stanza the hunk sits in ("interface Gi1/0/1", "protocols bgp group EBGP"); "" at top level. */
  context: string
  /** The first changed line's text (trimmed), for the list. */
  preview: string
  /** 1-based line to reveal on the modified side (or the original side for a pure deletion). */
  line: number
  side: 'modified' | 'original'
}

/**
 * One entry per hunk, with the stanza header it belongs to. A changed line that is itself a stanza
 * header (`interface Gi1/0/2` added) is labelled with its own text, so the list reads naturally.
 */
export function summarizeChanges(changes: readonly LineChange[], original: readonly string[], modified: readonly string[], style: StanzaStyle): ChangeSummary[] {
  const pOrig = stanzaPaths(original, style)
  const pMod = stanzaPaths(modified, style)
  return changes.map((c) => {
    const added = c.modifiedEndLineNumber === 0 ? 0 : c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
    const removed = c.originalEndLineNumber === 0 ? 0 : c.originalEndLineNumber - c.originalStartLineNumber + 1
    const side: 'modified' | 'original' = added > 0 ? 'modified' : 'original'
    const line = side === 'modified' ? c.modifiedStartLineNumber : c.originalStartLineNumber
    const lines = side === 'modified' ? modified : original
    const paths = side === 'modified' ? pMod : pOrig
    const path = paths[line - 1] ?? []
    const text = (lines[line - 1] ?? '').trim()
    return { added, removed, context: path.join(' › '), preview: text, line: Math.max(1, line), side }
  })
}
