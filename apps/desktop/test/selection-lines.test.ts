import { describe, expect, it } from 'vitest'
import { selectionWholeLines, wholeLines, type LineBuffer } from '../src/renderer/src/lib/selection-lines'
import { selectionForModel } from '../src/main/agent/agent'

/** A terminal buffer from rows; a row starting with `\t` continues the row above (wrapped). */
function buffer(rows: string[]): LineBuffer {
  return {
    length: rows.length,
    getLine: (y) => {
      const row = rows[y]
      if (row === undefined) return undefined
      const text = row.replace(/^\t/, '')
      return { isWrapped: row.startsWith('\t'), translateToString: (trim) => trim ? text.trimEnd() : text }
    }
  }
}

// Phase 4 fix-round review K2: a selection starting after the secret's keyword leaked the secret.
describe('K2: Ask AI selections widen to whole lines before redaction', () => {
  const rows = ['core-sw1#show run | i snmp|key', 'snmp-server community SECRETCOMM RO', ' key 7 0822455D0A16544541', 'core-sw1#']
  it('mid-line selections after the keyword are redacted once widened', () => {
    // What xterm hands over for a drag starting inside "community" / after "key".
    const fragment = 'nity SECRETCOMM RO\n key 7 0822455D0A16544541'
    expect(selectionForModel(fragment)).toContain('SECRETCOMM') // the gap the review found
    const term = { getSelection: () => fragment, getSelectionPosition: () => ({ start: { x: 18, y: 1 }, end: { x: 20, y: 2 } }), buffer: { active: buffer(rows) } }
    const widened = selectionWholeLines(term)
    expect(widened).toBe('snmp-server community SECRETCOMM RO\n key 7 0822455D0A16544541')
    const out = selectionForModel(widened)
    expect(out).not.toContain('SECRETCOMM')
    expect(out).not.toContain('0822455D0A16544541')
  })
  it('wrapped rows join into their logical line, from whichever row the selection starts', () => {
    const b = buffer(['x', 'username admin secret 9 $9$abcdefghij', '\tSECRETTAILOFHASH', 'y'])
    expect(wholeLines(b, 2, 2)).toBe('username admin secret 9 $9$abcdefghijSECRETTAILOFHASH')
    expect(selectionForModel(wholeLines(b, 2, 2))).not.toContain('SECRETTAIL')
  })
  it('preserves a word separator at the right edge of a soft-wrapped line', () => {
    expect(wholeLines(buffer(['Branch return ', '\troute present   ']), 1, 1)).toBe('Branch return route present')
  })
  it('no range from xterm: the plain selection', () => {
    expect(selectionWholeLines({ getSelection: () => 'abc', getSelectionPosition: () => undefined, buffer: { active: buffer([]) } })).toBe('abc')
  })
})
