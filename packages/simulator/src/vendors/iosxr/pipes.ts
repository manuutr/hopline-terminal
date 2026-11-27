/**
 * Output filters shared by the IOS XR, ASA and AOS-CX personalities: each passes the filter names
 * it knows and its own error strings. Patterns are regexes (as on the real devices).
 */
import { safeRegex, section, unquote } from '../../core/text.ts'
import type { PipeOutcome } from '../cisco/base.ts'

export interface PipeErrors {
  /** Unknown filter word; `at` is the character offset of the bad word in the raw line. */
  invalid: (at: number) => string
  ambiguous: () => string
  incomplete: () => string
}

/** Filters that need no pattern. */
const NO_ARG = new Set(['no-more', 'count'])

export function applyPipes(out: string, pipes: string[], raw: string, names: string[], err: PipeErrors): PipeOutcome | { error: string } {
  let lines = out.replace(/\n$/, '').split('\n')
  let noMore = false
  let from = raw.indexOf('|')
  for (const p of pipes) {
    const [word = '', ...rest] = p.split(/\s+/)
    const at = raw.indexOf(p, from)
    from = at + 1
    const w = word.toLowerCase()
    const exact = names.find((n) => n === w)
    const hits = exact ? [exact] : names.filter((n) => n.startsWith(w))
    if (!word || !hits.length) return { error: err.invalid(at < 0 ? raw.length : at) }
    if (hits.length > 1) return { error: err.ambiguous() }
    const name = hits[0]!
    let pattern = unquote(rest.join(' '))
    let invert = false
    if (name === 'grep' && /^-v\s+/.test(pattern)) {
      invert = true
      pattern = pattern.replace(/^-v\s+/, '')
    }
    if (!pattern && !NO_ARG.has(name)) return { error: err.incomplete() }
    const re = safeRegex(pattern || '.')
    if (!re) return { error: err.invalid(at + word.length + 1) }
    switch (name) {
      case 'include':
        lines = lines.filter((l) => re.test(l))
        break
      case 'exclude':
        lines = lines.filter((l) => !re.test(l))
        break
      case 'grep':
        lines = lines.filter((l) => re.test(l) !== invert)
        break
      case 'begin': {
        const i = lines.findIndex((l) => re.test(l))
        lines = i < 0 ? [] : lines.slice(i)
        break
      }
      case 'section':
        lines = section(lines, re)
        break
      case 'count':
        lines = [`Number of lines which match regexp = ${pattern ? lines.filter((l) => re.test(l)).length : lines.length}`]
        break
      case 'no-more':
        noMore = true
        break
      default:
        return { error: `% Filter "${name}" is not supported on the simulator` }
    }
  }
  return { out: lines.join('\n'), noMore }
}
