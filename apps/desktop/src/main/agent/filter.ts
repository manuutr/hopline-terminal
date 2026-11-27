import { createContext, runInContext } from 'node:vm'
import { z } from 'zod'

/**
 * Client-side output filters (F5b). The device gets the plain command; Hopline filters what came
 * back, the same way on every vendor (IOS has no `| tail`, many platforms have no `| count`).
 *
 * Order: grep (with before/after context, invert, ignoreCase) → count or head → tail.
 * Runs on output that is already redacted, so a pattern can never probe for a secret.
 */

export const MAX_PATTERN_LENGTH = 200
const MAX_LINES = 1_000_000
/** Wall-clock budget for one grep over the whole output. */
export const GREP_TIMEOUT_MS = 250

const lineCount = z.number().int().min(1).max(10_000)
const context = z.number().int().min(0).max(50)

export const OutputFilter = z
  .object({
    tail: lineCount.optional(),
    head: lineCount.optional(),
    grep: z.string().min(1).max(MAX_PATTERN_LENGTH).optional(),
    ignoreCase: z.boolean().optional(),
    invert: z.boolean().optional(),
    before: context.optional(),
    after: context.optional(),
    count: z.boolean().optional()
  })
  .strict()
export type OutputFilter = z.infer<typeof OutputFilter>

/** JSON Schema for the tool input. No numeric bounds here: strict tool schemas reject them; zod checks them. */
export const FILTER_SCHEMA = {
  type: 'object',
  description:
    'Optional. Filter the captured output locally in Hopline Terminal before you see it, on any vendor. The device receives only the plain command.',
  properties: {
    tail: { type: 'integer', description: 'Keep only the last N lines (after grep). 1 to 10000.' },
    head: { type: 'integer', description: 'Keep only the first N lines (after grep). 1 to 10000.' },
    grep: { type: 'string', description: `Keep lines matching this JavaScript regular expression (max ${MAX_PATTERN_LENGTH} characters). "a|b" is alternation here.` },
    ignoreCase: { type: 'boolean', description: 'grep ignores case' },
    invert: { type: 'boolean', description: 'Keep lines that do NOT match grep' },
    before: { type: 'integer', description: 'Lines of context before each grep match (0 to 50)' },
    after: { type: 'integer', description: 'Lines of context after each grep match (0 to 50)' },
    count: { type: 'boolean', description: 'Return only the number of matching lines' }
  },
  additionalProperties: false
} as const

/** One reusable, empty context: the matcher loop runs here so V8 can interrupt it on timeout. */
const sandbox = createContext(Object.create(null) as object)
const MATCH = 'var out = []; for (var i = 0; i < lines.length; i++) { if (re.test(lines[i]) !== invert) out.push(i) } out'

export class FilterError extends Error {}

function matchLines(lines: string[], f: OutputFilter): number[] {
  let re: RegExp
  try {
    re = new RegExp(f.grep!, f.ignoreCase ? 'i' : '')
  } catch (e) {
    throw new FilterError(`invalid grep pattern: ${(e as Error).message}`)
  }
  const s = sandbox as Record<string, unknown>
  s['lines'] = lines
  s['re'] = re
  s['invert'] = !!f.invert
  try {
    // A pattern with catastrophic backtracking is stopped, not allowed to hang the main process.
    return runInContext(MATCH, sandbox, { timeout: GREP_TIMEOUT_MS }) as number[]
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
      throw new FilterError(`grep pattern took longer than ${GREP_TIMEOUT_MS} ms (catastrophic backtracking?); use a simpler pattern`)
    throw e
  } finally {
    s['lines'] = s['re'] = undefined
  }
}

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`

/** Short label for the panel's command card and the audit reason: "grep /down/i · last 30 lines". */
export function describeFilter(f: OutputFilter): string {
  const bits: string[] = []
  if (f.grep !== undefined) {
    const ctx = [f.before ? `-B${f.before}` : '', f.after ? `-A${f.after}` : ''].filter(Boolean).join(' ')
    bits.push(`${f.invert ? 'grep -v' : 'grep'} /${f.grep}/${f.ignoreCase ? 'i' : ''}${ctx ? ' ' + ctx : ''}`)
  }
  if (f.count) bits.push('count')
  if (f.head) bits.push(`first ${plural(f.head, 'line')}`)
  if (f.tail) bits.push(`last ${plural(f.tail, 'line')}`)
  return bits.join(' · ')
}

export const isEmptyFilter = (f: OutputFilter): boolean => describeFilter(f) === ''

export interface Filtered {
  text: string
  /** For the model: "showing last 30 of 2,410 lines". */
  note: string
}

/** Apply a validated filter. Throws FilterError for a bad or too-slow pattern. */
export function applyFilter(output: string, f: OutputFilter): Filtered {
  const all = output.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').slice(0, MAX_LINES)
  const total = output.length ? all.length : 0
  let lines = all
  let matched: number | undefined

  if (f.grep !== undefined) {
    const hits = matchLines(all, f)
    matched = hits.length
    if (f.count) return { text: String(matched), note: `${plural(matched, 'line')} of ${plural(total, 'line')} ${f.invert ? 'do not match' : 'match'} /${f.grep}/${f.ignoreCase ? 'i' : ''}` }
    const before = f.before ?? 0
    const after = f.after ?? 0
    if (before || after) {
      // grep -B/-A: context lines around each hit, "--" between separate groups.
      const keep: string[] = []
      let lastEnd = -1
      for (const h of hits) {
        const start = Math.max(0, h - before, lastEnd + 1)
        const end = Math.min(all.length - 1, h + after)
        if (lastEnd >= 0 && start > lastEnd + 1) keep.push('--')
        for (let i = start; i <= end; i++) keep.push(all[i]!)
        lastEnd = Math.max(lastEnd, end)
      }
      lines = keep
    } else lines = hits.map((i) => all[i]!)
  } else if (f.count) return { text: String(total), note: `${plural(total, 'line')} in total` }

  const pool = lines.length
  if (f.head) lines = lines.slice(0, f.head)
  if (f.tail) lines = lines.slice(-f.tail)

  const of = matched !== undefined ? `${plural(matched, 'matching line')} (of ${plural(total, 'line')})` : plural(total, 'line')
  let note: string
  if (f.tail && pool > lines.length) note = `showing last ${lines.length.toLocaleString('en-US')} of ${of}`
  else if (f.head && pool > lines.length) note = `showing first ${lines.length.toLocaleString('en-US')} of ${of}`
  else note = matched !== undefined ? `showing ${of}` : `showing all ${of}`
  return { text: lines.join('\n'), note }
}
