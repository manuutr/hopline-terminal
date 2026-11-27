/**
 * CI corpus (ROADMAP D4): every bundled template must parse its ntc-templates test fixtures to
 * exactly the expected `parsed_sample`, the way ntc's own test does it: the command comes from the
 * fixture directory name and goes through the index, keys are lowercased, rows are order-sensitive.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error js-yaml ships no types (dev-only)
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { lookup, parseWithTemplate, toNtcCell } from '../src'
import { BUNDLED } from '../src/index.generated'
import { PLATFORM_MAP } from '../src/platforms'

const FIX = join(__dirname, 'fixtures')

/** ntc platform → a Hopline platform that maps to it first (for the index lookup). */
const viaHopline = (ntc: string): string => Object.entries(PLATFORM_MAP).find(([, v]) => v[0] === ntc)?.[0] ?? Object.entries(PLATFORM_MAP).find(([, v]) => v.includes(ntc))![0]

interface Case {
  ntc: string
  dir: string
  raw: string
}
const cases: Case[] = []
for (const ntc of readdirSync(FIX))
  for (const dir of readdirSync(join(FIX, ntc)))
    for (const f of readdirSync(join(FIX, ntc, dir))) if (f.endsWith('.raw')) cases.push({ ntc, dir, raw: f })

describe('ntc-templates corpus', () => {
  it('has fixtures for the bundled templates', () => {
    expect(BUNDLED.size).toBeGreaterThan(100)
    expect(cases.length).toBeGreaterThan(300)
  })

  it.each(cases.map((c) => [`${c.ntc}/${c.dir}/${c.raw}`, c] as const))('%s', (_name, c) => {
    const command = c.dir.split('_').join(' ')
    const entry = lookup(viaHopline(c.ntc), command)
    expect(entry?.template, `index routes "${command}"`).toBe(`${c.ntc}_${c.dir}.textfsm`)
    const raw = readFileSync(join(FIX, c.ntc, c.dir, c.raw), 'utf8')
    const expected = (yaml.load(readFileSync(join(FIX, c.ntc, c.dir, c.raw.replace(/\.raw$/, '.yml')), 'utf8')) as { parsed_sample: Record<string, unknown>[] | null }).parsed_sample ?? []
    const { headers, rows } = parseWithTemplate(entry!.template, raw)
    const got = rows.map((r) => Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), toNtcCell(r[i]!)])))
    expect(got.length).toBe(expected.length)
    // ntc compares the keys of each reference entry; yml values are strings or lists.
    for (const [i, ref] of expected.entries()) {
      expect(new Set(Object.keys(got[i]!))).toEqual(new Set(Object.keys(ref)))
      for (const k of Object.keys(ref)) expect(got[i]![k], `entry #${i}, key: ${k}`).toEqual(ref[k])
    }
  })
})
