/**
 * Golden transcript harness: fixtures are fenced blocks lifted verbatim from docs/research/cli-*.md
 * (see manifest.ts). A fixture is replayed against an in-memory Terminal and the transcript is
 * compared after normalising only time/date tokens.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Shell } from '../../src/shell.ts'
import { makeDevice } from '../../src/devices/index.ts'
import { ManualClock, setClock } from '../../src/core/runtime.ts'
import type { Device, SimPlatform } from '../../src/state.ts'
import { unifiedDiff } from '../../src/core/text.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = join(here, '..', '..', '..', '..')
export const fixturesDir = here

/** The lab clock all docs are written against: Tue Nov 24 2026 11:02:11 UTC (core-sw1 samples). */
export const LAB_TIME = Date.UTC(2026, 10, 24, 11, 2, 11, 418)

export type Mode = 'exact' | 'elided' | 'excerpt'

export interface Delta {
  /** Text in the doc fixture. */
  doc: string
  /** What the simulator prints instead. */
  sim: string
  why: string
}

export interface GoldenEntry {
  id: string
  platform: SimPlatform
  doc: string
  /** Substring of the heading line the block follows. */
  heading: string
  /** Which fenced block after the heading (0-based). */
  block?: number
  /**
   * exact: whole transcript. elided: `...` lines in the fixture match any run of lines.
   * excerpt: fixture lines must appear in order (a real device prints more).
   */
  mode: Mode
  /** Keystroke chunks to send; default: the text after each prompt line, plus Enter. */
  inputs?: string[]
  /** Commands run first (output discarded). */
  setup?: string[]
  /** Explicit, reported differences between the doc and the simulator. */
  deltas?: Delta[]
  /** Compare with trailing whitespace removed (prompts that echo a typed answer). */
  trimEnd?: boolean
  /** Device tweak before the replay (e.g. a scenario). */
  prepare?: (d: Device) => void
  /** Terminal rows (default: huge, so nothing pages). */
  rows?: number
  /** ssh login user (affects some prompts). */
  user?: string
}

export const PROMPTS: Record<SimPlatform, RegExp> = {
  ios: /^([A-Za-z][\w.-]*(?:\([\w-]+\))?[#>])(.*)$/,
  nxos: /^([A-Za-z][\w.-]*(?:\([\w-]+\))?#)(.*)$/,
  eos: /^([A-Za-z][\w.-]*(?:\([\w-]+\))?[#>])(.*)$/,
  junos: /^((?:\{[\w:]+\}\s*)?[\w.-]+@[\w.-]+[#>] ?)(.*)$/,
  panos: /^([\w.-]+@[\w.-]+(?:\([\w-]+\))?[#>] ?)(.*)$/,
  fortios: /^([\w.-]+(?: \([\w.-]+\))? [#$] ?)(.*)$/,
  iosxr: /^((?:RP\/\d+\/\w+\/CPU\d+:)[\w.-]+(?:\([\w-]+\))?#)(.*)$/,
  asa: /^([A-Za-z][\w.-]*(?:\/[\w-]+)?(?:\([\w-]+\))?[#>] ?)(.*)$/,
  aireos: /^(\([^)]+\) (?:[\w-]+)?[>#] ?)(.*)$/,
  c9800: /^([A-Za-z][\w.-]*(?:\([\w-]+\))?[#>])(.*)$/,
  aoscx: /^([A-Za-z][\w.-]*(?:\([\w-]+\))?[#>] ?)(.*)$/,
  vrp: /^([<\[][~*]?[\w.~-]+(?:-[\w\-/.]+)?[>\]])(.*)$/,
  routeros: /^(\[[\w.-]+@[\w.-]+\] (?:\/[\w\s/-]*)?> ?)(.*)$/
}

/** Pull the Nth fenced block that follows a heading. */
export function extractBlock(docText: string, heading: string, block = 0): string {
  const lines = docText.split('\n')
  const h = lines.findIndex((l) => /^#+\s/.test(l) && l.includes(heading))
  if (h < 0) throw new Error(`heading not found: ${heading}`)
  let n = -1
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#+\s/.test(lines[i]!) && i > h) {
      // Next heading of the same or higher level ends the search.
      const lvl = /^#+/.exec(lines[i]!)![0].length
      const hl = /^#+/.exec(lines[h]!)![0].length
      if (lvl <= hl) break
    }
    if (/^```/.test(lines[i]!)) {
      const end = lines.findIndex((l, k) => k > i && /^```\s*$/.test(l))
      if (++n === block) return lines.slice(i + 1, end).join('\n') + '\n'
      i = end
    }
  }
  throw new Error(`block ${block} not found after heading: ${heading}`)
}

export function fixturePath(e: GoldenEntry): string {
  return join(fixturesDir, e.platform, `${e.id}.txt`)
}

export function readFixture(e: GoldenEntry): string {
  return readFileSync(fixturePath(e), 'utf8')
}

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
const DAYS = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun'

/** Zero the digits of time/date/uptime tokens and blank month/day names, keeping widths. */
export function normalise(text: string): string {
  const zero = (s: string): string => s.replace(/\d/g, '0')
  return text
    .replace(/\b\d{1,4}[:-]\d{2}[:-]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:\.\d+)?\b/g, zero)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, zero)
    .replace(/\b\d+[ywdh]\d+[wdhm]\b/g, zero)
    .replace(/\b\d+[ywdhms](?:\d+[wdhms]){0,3}\b(?=\s|,|$)/g, zero)
    .replace(/\b\d+ (weeks?|days?|hours?|minutes?|seconds?)\b/g, (m) => zero(m))
    .replace(new RegExp(`\\b(${MONTHS})\\b`, 'g'), 'Mmm')
    .replace(new RegExp(`\\b(${DAYS})\\b`, 'g'), 'Ddd')
    .replace(/\b(19|20)\d{2}\b/g, '0000')
    .replace(/(Mmm[ -]+)\d{1,2}\b/g, (_m, a: string) => a + '00')
    .replace(/\b\d{1,2}([ -]+Mmm)/g, (_m, a: string) => '00' + a)
}

/** Default keystrokes: what follows each prompt in the fixture. */
export function deriveInputs(e: GoldenEntry, fixture: string): string[] {
  const re = PROMPTS[e.platform]
  const out: string[] = []
  let pending = ''
  for (const l of fixture.replace(/\n$/, '').split('\n')) {
    const m = re.exec(l)
    if (!m) continue
    const text = m[2]!
    if (pending && text.trimEnd() === pending.trimEnd()) continue // redisplay after `?`
    if (pending && text.startsWith(pending)) {
      out.push(text.slice(pending.length) + (text.endsWith('?') ? '' : '\r'))
      pending = text.endsWith('?') ? text.slice(0, -1) : ''
      continue
    }
    if (text === '' && out.length === 0) continue
    if (text.endsWith('?')) {
      out.push(text)
      pending = text.slice(0, -1)
    } else {
      out.push(text + '\r')
      pending = ''
    }
  }
  // A trailing bare prompt in the fixture is just the final prompt.
  if (out.at(-1) === '\r') out.pop()
  return out
}

export interface Replay {
  actual: string
  expected: string
  ok: boolean
  diff: string
}

/** Run the fixture's inputs and compare. */
export async function replay(e: GoldenEntry, fixture = readFixture(e)): Promise<Replay> {
  const clock = new ManualClock(LAB_TIME)
  const d = makeDevice(e.platform, LAB_TIME)
  setClock(d, clock)
  e.prepare?.(d)
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, e.rows ?? 100000, { user: e.user, from: '10.10.10.50' })
  sh.start()
  for (const c of e.setup ?? []) {
    sh.input(c + '\r')
    await sh.idle()
  }
  const re = PROMPTS[e.platform]
  const firstPrompt = re.exec(fixture.split('\n').find((l) => re.test(l)) ?? '')?.[1]
  const start = firstPrompt ? out.replace(/\r/g, '').lastIndexOf(firstPrompt.trimEnd()) : 0
  const pre = out.replace(/\r\n/g, '\n').slice(0, Math.max(0, start))
  out = out.replace(/\r\n/g, '\n').slice(Math.max(0, start))
  for (const chunk of e.inputs ?? deriveInputs(e, fixture)) {
    sh.input(chunk)
    await sh.idle()
    await new Promise((r) => setTimeout(r, 2))
  }
  void pre
  let actual = out.replace(/\r\n/g, '\n').replace(/\r/g, '')
  // Drop the trailing prompt unless the fixture ends on one.
  const fxLines = fixture.replace(/\n$/, '').split('\n')
  const lastFx = fxLines.at(-1) ?? ''
  const aLines = actual.split('\n')
  if (!(re.test(lastFx) && re.exec(lastFx)![2] === '' ) && re.test(aLines.at(-1) ?? '') && re.exec(aLines.at(-1)!)![2] === '') aLines.pop()
  actual = aLines.join('\n').replace(/\n$/, '')
  let expected = fixture.replace(/\n$/, '')
  for (const delta of e.deltas ?? []) {
    if (!expected.includes(delta.doc)) throw new Error(`${e.id}: delta text not in fixture: ${delta.doc}`)
    expected = expected.replace(delta.doc, delta.sim)
  }
  const prep = (s: string): string[] => normalise(s).split('\n').map((l) => (e.trimEnd ? l.trimEnd() : l))
  const A = prep(actual)
  const E = prep(expected)
  const ok = compare(e.mode, E, A)
  return { actual, expected, ok, diff: ok ? '' : unifiedDiff(E, A, `doc:${e.id}`, 'simulator', 2).join('\n') }
}

function compare(mode: Mode, E: string[], A: string[]): boolean {
  if (mode === 'exact') return E.length === A.length && E.every((l, i) => l === A[i])
  if (mode === 'excerpt') {
    let k = 0
    for (const l of E) {
      if (l.trim() === '...') continue
      while (k < A.length && A[k] !== l) k++
      if (k === A.length) return false
      k++
    }
    return true
  }
  // elided: `...` matches any run of lines (including none).
  const memo = new Map<string, boolean>()
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`
    if (memo.has(key)) return memo.get(key)!
    let r: boolean
    if (i === E.length) r = j === A.length
    else if (E[i]!.trim() === '...') r = go(i + 1, j) || (j < A.length && go(i, j + 1))
    else r = j < A.length && E[i] === A[j] && go(i + 1, j + 1)
    memo.set(key, r)
    return r
  }
  return go(0, 0)
}
