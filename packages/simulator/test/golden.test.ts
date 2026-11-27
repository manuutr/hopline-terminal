import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractBlock, readFixture, repoRoot, replay } from './golden/harness.ts'
import { manifest } from './golden/manifest.ts'

describe('golden transcripts from docs/research', () => {
  for (const e of manifest) {
    describe(`${e.platform}/${e.id}`, () => {
      it('fixture matches the doc', () => {
        const doc = extractBlock(readFileSync(join(repoRoot, e.doc), 'utf8'), e.heading, e.block)
        expect(readFixture(e), 'stale fixture: run scripts/extract-goldens.ts').toBe(doc)
      })
      it(`simulator reproduces it (${e.mode}${e.deltas?.length ? `, ${e.deltas.length} delta(s)` : ''})`, async () => {
        const r = await replay(e)
        if (!r.ok) throw new Error(`transcript differs:\n${r.diff}\n\n--- full simulator output ---\n${r.actual}`)
      })
    })
  }
})
