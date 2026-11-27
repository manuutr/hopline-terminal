/**
 * Python `re` pattern syntax → JavaScript RegExp source.
 *
 * TextFSM templates are written for Python's `re`. The two dialects agree on almost everything
 * that ntc-templates use; this rewrites the differences:
 * - `(?P<name>…)` → `(?<name>…)`, `(?P=name)` → `\k<name>`
 * - `\Z` → `$`, `\A` → `^` (patterns run on single lines without a trailing newline, and JS `$`
 *   without the `m` flag only matches at the very end, like Python's `\Z`)
 * - a `]` right after `[` or `[^` is a literal in Python: `[]a]` → `[\]a]`
 * - `{,n}` → `{0,n}`
 * - `(?#comment)` is dropped
 * - leading global flags `(?i)`, `(?s)`, `(?m)` become RegExp flags; `(?x)` (verbose) is refused
 *
 * Patterns compile WITHOUT the `u`/`v` flag: templates are full of identity escapes like `\-`
 * and `\/` that unicode mode rejects. Scoped modifiers `(?i:…)` pass through (V8 supports them).
 */

export interface ConvertedRegex {
  source: string
  flags: string
}

export class PyRegexError extends Error {
  constructor(message: string, readonly pattern: string) {
    super(`${message} in /${pattern}/`)
    this.name = 'PyRegexError'
  }
}

const GLOBAL_FLAG = /^\(\?([aiLmsux]+)\)/

export function convertPyRegex(py: string): ConvertedRegex {
  const flags = new Set<string>()
  let out = ''
  let i = 0
  const n = py.length
  let inClass = false
  /** Open groups: where each starts in `out`, and whether it is a lookbehind. */
  const groups: { start: number; lookbehind: boolean }[] = []
  while (i < n) {
    const c = py[i]!
    if (c === '\\') {
      const next = py[i + 1]
      if (next === undefined) throw new PyRegexError('trailing backslash', py)
      if (!inClass && next === 'Z') out += '$'
      else if (!inClass && next === 'A') out += '^'
      else out += c + next
      i += 2
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      out += c
      i++
      continue
    }
    if (c === '[') {
      inClass = true
      out += c
      i++
      if (py[i] === '^') {
        out += '^'
        i++
      }
      // A `]` first in the class is a literal in Python; JS would read `[]` as an empty class.
      if (py[i] === ']') {
        out += '\\]'
        i++
      }
      continue
    }
    if (c === '(' && py[i + 1] === '?') {
      const rest = py.slice(i)
      if (rest.startsWith('(?P<')) {
        groups.push({ start: out.length, lookbehind: false })
        out += '(?<'
        i += 4
        continue
      }
      if (rest.startsWith('(?P=')) {
        const end = py.indexOf(')', i)
        if (end < 0) throw new PyRegexError('unterminated (?P=', py)
        out += `\\k<${py.slice(i + 4, end)}>`
        i = end + 1
        continue
      }
      if (rest.startsWith('(?#')) {
        const end = py.indexOf(')', i)
        if (end < 0) throw new PyRegexError('unterminated comment', py)
        i = end + 1
        continue
      }
      const g = GLOBAL_FLAG.exec(rest)
      if (g) {
        for (const f of g[1]!) {
          if (f === 'x') throw new PyRegexError('verbose (?x) patterns are not supported', py)
          if (f === 'i' || f === 'm' || f === 's') flags.add(f)
          // a, L, u: ASCII/locale/unicode matching. JS is ASCII-ish for \w\d\b without `u`: ignore.
        }
        i += g[0].length
        continue
      }
    }
    if (c === '(') {
      groups.push({ start: out.length, lookbehind: py.startsWith('(?<=', i) || py.startsWith('(?<!', i) })
      out += c
      i++
      continue
    }
    if (c === ')') {
      const g = groups.pop()
      out += c
      i++
      // Python lets a lookbehind take a quantifier (it repeats a zero-width test); JS refuses it.
      // Minimum 0 always matches: drop the assertion. Minimum ≥ 1 is the assertion once.
      const q = g?.lookbehind ? /^(?:[*?+]|\{(\d*)(?:,\d*)?\})[?+]?/.exec(py.slice(i)) : null
      if (g && q) {
        const min = q[0][0] === '{' ? Number(q[1] || 0) : q[0][0] === '+' ? 1 : 0
        if (min === 0) out = out.slice(0, g.start)
        i += q[0].length
      }
      continue
    }
    if (c === '{' && py[i + 1] === ',') {
      const m = /^\{,(\d+)\}/.exec(py.slice(i))
      if (m) {
        out += `{0,${m[1]}}`
        i += m[0].length
        continue
      }
    }
    out += c
    i++
  }
  if (inClass) throw new PyRegexError('unterminated character class', py)
  return { source: out, flags: [...flags].sort().join('') }
}

/** Compile a Python pattern. `sticky` makes `exec` anchor at lastIndex like Python's `re.match`. */
export function compilePyRegex(py: string, opts: { sticky?: boolean } = {}): RegExp {
  const { source, flags } = convertPyRegex(py)
  try {
    return new RegExp(source, flags + (opts.sticky ? 'y' : ''))
  } catch (e) {
    throw new PyRegexError(e instanceof Error ? e.message : String(e), py)
  }
}

/** Python `re.match`: anchored at the start, not the end. */
export function pyMatch(re: RegExp, s: string): RegExpExecArray | null {
  re.lastIndex = 0
  return re.exec(s)
}

/** Number of capturing groups (named and unnamed), like Python's `pattern.groups`. */
export function groupCount(re: RegExp): number {
  return new RegExp(`${re.source}|`, re.flags.replace('y', '')).exec('')!.length - 1
}
