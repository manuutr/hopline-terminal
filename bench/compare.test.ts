import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'hopline-bench-compare-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function resultFile(name: string, value: number): string {
  const path = join(dir, name)
  const metrics = { example: { unit: 'ms', better: 'lower', value } }
  writeFileSync(path, JSON.stringify({ metrics }))
  return path
}

const current = resultFile('current.json', 125)
const baseline = resultFile('baseline.json', 100)
const compare = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, 'compare.mjs'), ...args], { encoding: 'utf8' })

describe('benchmark comparison CLI', () => {
  it('compares the requested files using the default threshold', () => {
    const result = compare(current, baseline)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('1 regression(s) over 15%')
    expect(compare(baseline, current).status).toBe(0)
  })

  it('uses the requested current file with the default baseline', () => {
    const result = compare(current)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`current:  ${current}\n`)
    expect(result.stdout).toContain(`baseline: ${join(__dirname, 'baseline.json')}\n`)
  })

  it('accepts a threshold between the paths and rejects an invalid value', () => {
    expect(compare(current, '--threshold', '30', baseline).status).toBe(0)
    const invalid = compare(current, baseline, '--threshold', 'invalid')
    expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain('Usage:')
  })
})
