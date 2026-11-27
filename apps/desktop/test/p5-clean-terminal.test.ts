import { describe, expect, it } from 'vitest'
import { cleanTerminalText } from '@shared/cli'

/** Phase 5 safety review M1: hostile device output must not freeze the session host. */
const K = 256 * 1024
const BUDGET_MS = 1500

function timed(s: string): { ms: number; out: string } {
  const t = performance.now()
  const out = cleanTerminalText(s)
  return { ms: performance.now() - t, out }
}

describe('cleanTerminalText stays linear on hostile input (M1)', () => {
  it('a long run of text, then as many backspaces', () => {
    const r = timed('a'.repeat(K) + '\b'.repeat(K))
    expect(r.ms).toBeLessThan(BUDGET_MS)
    expect(r.out).toBe('')
  })
  it('an unterminated run of 8-bit DCS introducers (U+0090)', () => {
    const r = timed('\u0090'.repeat(K))
    expect(r.ms).toBeLessThan(BUDGET_MS)
    expect(r.out).toBe('')
  })
  it('an unterminated run of 8-bit OSC introducers (U+009D)', () => {
    const r = timed('\u009d'.repeat(K))
    expect(r.ms).toBeLessThan(BUDGET_MS)
    expect(r.out).toBe('')
  })
  it('mixed introducers, text and backspaces', () => {
    const r = timed('\u009dx\u0090y\u009e\u009fz\bq\b\b'.repeat(K / 12))
    expect(r.ms).toBeLessThan(BUDGET_MS)
  })
  it('keeps the backspace semantics: a character is erased, a newline and a backspace are not', () => {
    expect(cleanTerminalText('ab\b\bc')).toBe('c')
    expect(cleanTerminalText('a\n\bb')).toBe('a\nb')
    expect(cleanTerminalText('abc\b\b\b\bd')).toBe('d')
    expect(cleanTerminalText('--More--\b\b\b\b\b\b\b\b        \b\b\b\b\b\b\b\bline')).toBe('line')
  })
  it('still strips terminated 8-bit and 7-bit strings', () => {
    expect(cleanTerminalText('a\u009d0;title\u009cb')).toBe('ab')
    expect(cleanTerminalText('a\u0090payload\u009cb')).toBe('ab')
    expect(cleanTerminalText('a\u001b]52;c;aGk=\u0007b')).toBe('ab')
  })
  it('a string cut short by another introducer does not leak its payload as text', () => {
    expect(cleanTerminalText('a\u0090hidden-payload\u0090x\u009cb')).toBe('ab')
    expect(cleanTerminalText('a\u009dhidden\u009d0;title\u0007b')).toBe('ab')
    expect(cleanTerminalText('a\u009ehidden\u009fmore\u009cb')).toBe('ab')
    const r = timed(('\u0090' + 'x'.repeat(1000)).repeat(K / 1000))
    expect(r.ms).toBeLessThan(BUDGET_MS)
  })
})
