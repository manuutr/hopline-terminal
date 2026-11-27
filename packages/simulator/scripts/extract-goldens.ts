/**
 * Copy the golden transcripts listed in test/golden/manifest.ts out of docs/research into
 * test/golden/<platform>/<id>.txt. Run after editing the docs:
 *   node packages/simulator/scripts/extract-goldens.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extractBlock, fixturePath, repoRoot } from '../test/golden/harness.ts'
import { manifest } from '../test/golden/manifest.ts'

let n = 0
for (const e of manifest) {
  const text = extractBlock(readFileSync(join(repoRoot, e.doc), 'utf8'), e.heading, e.block)
  const p = fixturePath(e)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  n++
}
console.log(`wrote ${n} golden fixtures`)
