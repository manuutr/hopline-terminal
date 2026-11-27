import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { physicalId, reservedReason } from '../src/renderer/src/lib/keymap'

/**
 * Round 2: every default shortcut declared in the renderer (`keys: ['…']` literals in action lists)
 * passes the same rules as Settings → Keyboard, on both platforms: no device-reserved key and no
 * two actions on one physical key. Scans the source, so new actions are covered without importing
 * the whole UI.
 */
const ROOT = join(__dirname, '../src/renderer/src')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })

type Decl = { file: string; id: string; keys: string[]; fixed: boolean }
const decls: Decl[] = []
for (const f of files(ROOT)) {
  const src = readFileSync(f, 'utf8')
  // An action object: an id, then its keys within the same object literal (no nested braces between).
  for (const m of src.matchAll(/id:\s*'([^']+)'[^{}]*?keys:\s*\[([^\]]*)\]([^{}]*)/g)) {
    const keys = [...m[2]!.matchAll(/'([^']+)'/g)].map((k) => k[1]!)
    if (keys.length) decls.push({ file: f.slice(ROOT.length + 1), id: m[1]!, keys, fixed: /fixed:\s*true/.test(m[3]!) })
  }
}

describe('default shortcuts', () => {
  it('finds the declared defaults, including Files (Mod+J)', () => {
    expect(decls.length).toBeGreaterThan(10)
    expect(decls.find((d) => d.id === 'files.toggle')?.keys).toEqual(['Mod+J'])
  })

  for (const mac of [false, true]) {
    const os = mac ? 'macOS' : 'Windows/Linux'
    it(`no default takes a key the device needs (${os})`, () => {
      const bad = decls.filter((d) => !d.fixed).flatMap((d) => d.keys.map((k) => ({ id: d.id, k, why: reservedReason(k, mac) }))).filter((x) => x.why)
      expect(bad).toEqual([])
    })
    it(`no two defaults share a physical key (${os})`, () => {
      const seen = new Map<string, string>()
      const clashes: string[] = []
      for (const d of decls)
        for (const k of d.keys) {
          const id = physicalId(k, mac)
          const other = seen.get(id)
          if (other && other !== d.id) clashes.push(`${k}: ${other} and ${d.id}`)
          seen.set(id, d.id)
        }
      expect(clashes).toEqual([])
    })
  }
})
