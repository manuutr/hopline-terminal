import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect } from 'vitest'
import { sessionRef, type ImportResult } from '../src'

export const FIXTURES = join(__dirname, 'fixtures')
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

/** Every file under a fixture directory, with paths relative to `fixtures/`. */
export function fixtureTree(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else out.push({ path: relative(FIXTURES, p).split('\\').join('/'), text: readFileSync(p, 'utf8') })
    }
  }
  walk(join(FIXTURES, dir))
  return out
}

/**
 * "0 lost sessions": every record the test counted independently of the importer
 * shows up as a session or as a warning item.
 */
export function expectNoneLost(result: ImportResult, records: string[]) {
  const sessions = new Set(result.sessions.flatMap((s) => [sessionRef(s), s.name]))
  const warned = new Set(result.warnings.map((w) => w.item))
  const lost = records.filter((r) => !sessions.has(r) && !warned.has(r))
  expect(lost, 'records neither imported nor warned about').toEqual([])
}

export const byName = (r: ImportResult, name: string) => {
  const s = r.sessions.filter((x) => x.name === name)
  expect(s, `session "${name}"`).toHaveLength(1)
  return s[0]!
}

export const warningsFor = (r: ImportResult, item: string) => r.warnings.filter((w) => w.item === item).map((w) => w.message)

/** No secret from the fixture may appear anywhere in the result. */
export function expectNoSecrets(result: ImportResult, secrets: string[]) {
  const json = JSON.stringify(result)
  for (const s of secrets) expect(json).not.toContain(s)
}
