import { resolve, tokenize, type Resolution } from './engine'
import { getPlatform } from './registry'
import type { ModeId, PlatformId } from './types'

/**
 * The one canonicaliser every argument rule uses (Phase 8 review H3). A rule never compares raw
 * tokens: the command head is the guard's own resolution (abbreviations expanded, `do`/`run`/
 * `do-exec` wrappers removed), and option words are resolved against a vocabulary with the same
 * prefix rule the device and the command trees use (an exact word wins, else a unique prefix;
 * several candidates are ambiguous and fail closed).
 */

export interface Canonical {
  /** Keyword path of the command, expanded, wrappers removed (`do pi 10.0.0.1` → `['ping']`). */
  head: string[]
  /** Tokens typed after `head`, as typed (parameters, unmodelled options, values). */
  rest: string[]
  /** The engine's resolution of the line (wrappers included). */
  resolution: Resolution
}

/** Keywords that run the rest of the line in exec mode. */
const WRAPPERS = new Set(['do', 'do-exec', 'run'])

/**
 * Canonical head and arguments of a line, as the guard resolves it in `mode`. Only the part before
 * the first pipe is considered.
 */
export function canonicalize(platform: PlatformId, mode: ModeId, raw: string): Canonical {
  let line = raw.trim()
  // Exec mode: the guard strips a leading `do`/`run` (any case, repeated) and classifies the rest.
  const prefix = getPlatform(platform).profile.execFromConfig
  if (mode === 'exec' && prefix)
    for (let m = /^(\S+)\s+(.*)$/.exec(line); m && m[1]!.toLowerCase() === prefix; m = /^(\S+)\s+(.*)$/.exec(line)) line = m[2]!
  const resolution = resolve(platform, mode, line, { probes: false })
  const { tokens } = tokenize(line, getPlatform(platform).profile.quotes)
  const pipe = tokens.findIndex((t) => t.text === '|' && !t.quoted)
  const base = pipe < 0 ? tokens : tokens.slice(0, pipe)
  const head: string[] = []
  let end = -1
  for (const t of resolution.tokens) {
    if (t.kind !== 'keyword') break
    if (!head.length && WRAPPERS.has(t.value) && t.end < (base.at(-1)?.end ?? 0)) {
      end = t.end
      continue
    }
    head.push(t.value)
    end = t.end
  }
  const rest = base.filter((t) => t.start >= end).map((t) => t.text)
  return { head, rest, resolution }
}

export { matchWord, abbreviates, type WordMatch } from './words'
