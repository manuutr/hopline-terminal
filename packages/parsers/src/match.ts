/**
 * Command → template matching over the ntc index (`@hopline/parsers/match`). Light: it imports the
 * index rows only, never the template texts, so a UI thread can ask "is there a parser for this
 * command?" and leave parsing to a worker.
 */
export { PLATFORM_MAP } from './platforms'
export { NTC_COMMIT } from './index.generated'
import { BUNDLED, INDEX_ROWS } from './index.generated'
import { PLATFORM_MAP } from './platforms'
import { compilePyRegex, pyMatch } from './pyre'

export interface IndexEntry {
  /** One template, or several joined by ':' (merged tables in clitable; not supported here). */
  template: string
  /** The ntc platform this entry matched for. */
  ntcPlatform: string
  /** The Command column as written in the index (before [[ ]] expansion). */
  commandSpec: string
}

interface CompiledEntry extends IndexEntry {
  platform: RegExp
  command: RegExp
}

/** clitable `_Completion`: `sh[[ow]]` → `sh(o(w)?)?`. */
export function expandCompletion(spec: string): string {
  return spec.replace(/(\[\[.+?\]\])/g, (m) => {
    const word = m.slice(2, -2)
    return '(' + [...word].join('(') + ')?'.repeat(word.length)
  })
}

let index: CompiledEntry[] | null = null
function getIndex(): CompiledEntry[] {
  if (!index)
    index = INDEX_ROWS.map(([template, , platform, command]) => ({
      template,
      platform: compilePyRegex(platform, { sticky: true }),
      command: compilePyRegex(expandCompletion(command), { sticky: true }),
      commandSpec: command,
      ntcPlatform: platform
    }))
  return index
}

/** Collapse whitespace; null when the command filters its output through a pipe. */
export function normalizeCommand(command: string): string | null {
  const c = command.trim().replace(/\s+/g, ' ')
  if (!c || c.includes('|')) return null
  return c
}

/**
 * The index row ntc would pick for this command (first match wins, anchored at the start, like
 * clitable), bundled or not. Null for an unmapped platform, an empty command or a pipe.
 */
export function lookup(platform: string, command: string): IndexEntry | null {
  const c = normalizeCommand(command)
  const ntc = PLATFORM_MAP[platform]
  if (!c || !ntc) return null
  for (const p of ntc) {
    for (const e of getIndex()) {
      if (!pyMatch(e.platform, p)) continue
      if (pyMatch(e.command, c)) return { template: e.template, ntcPlatform: p, commandSpec: e.commandSpec }
    }
  }
  return null
}

/** The bundled template that parses `command` on `platform`, or null (no template, not bundled, a pipe). */
export function findTemplate(platform: string, command: string): string | null {
  const e = lookup(platform, command)
  return e && BUNDLED.has(e.template) ? e.template : null
}

export interface TemplateInfo {
  template: string
  ntcPlatform: string
  /** The index Command pattern (ntc syntax, e.g. `sh[[ow]] ip int[[erface]] br[[ief]]`). */
  command: string
}

/** Bundled templates, optionally for one Hopline platform, in index order. */
export function listTemplates(platform?: string): TemplateInfo[] {
  const ntc = platform === undefined ? null : PLATFORM_MAP[platform]
  if (platform !== undefined && !ntc) return []
  const out: TemplateInfo[] = []
  const seen = new Set<string>()
  for (const p of ntc ?? [...new Set(Object.values(PLATFORM_MAP).flat())]) {
    for (const e of getIndex()) {
      if (!pyMatch(e.platform, p) || !BUNDLED.has(e.template)) continue
      const key = `${e.template}\0${e.commandSpec}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ template: e.template, ntcPlatform: p, command: e.commandSpec })
    }
  }
  return out
}
