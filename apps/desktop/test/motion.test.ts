import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')

describe('motion tokens (VISUAL-DIRECTION.md, Motion)', () => {
  it('reduced motion turns every animation and transition off, not just short', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? ''
    expect(block).toMatch(/animation:\s*none !important/)
    expect(block).toMatch(/transition:\s*none !important/)
    expect(block).not.toMatch(/0\.01ms/)
  })

  it('surface transitions use the micro, standard and large durations', () => {
    const durs = [...css.matchAll(/--dur-[a-z]+:\s*(\d+)ms/g)].map((m) => Number(m[1]))
    expect(durs.length).toBeGreaterThanOrEqual(4)
    expect(new Set(durs)).toEqual(new Set([120, 200, 320]))
    // Chrome animations use the tokens, never a literal outside the range.
    for (const m of css.matchAll(/(?:fade|pop)-(?:in|out) (\d+)ms/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(120)
      expect(Number(m[1])).toBeLessThanOrEqual(320)
    }
  })
})
