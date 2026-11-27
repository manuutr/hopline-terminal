/**
 * Snippet bodies: `{{variable}}` placeholders, filling them, and which sessions a snippet applies
 * to (scope and platform). Pure; used by the renderer (form, button bar) and by main (which fills
 * the body itself before the guard sees it).
 */
import type { Snippet, SnippetVar } from './productivity'
import type { Folder, Session } from './types'

const VAR = /\{\{\s*([A-Za-z_][\w-]{0,31})\s*\}\}/g
export const MAX_VALUE = 128

/** Where autocomplete values for a variable come from, by its name. */
export function varSource(name: string): SnippetVar['source'] {
  const n = name.toLowerCase()
  if (/^(if|int|intf|interface|iface|port)s?(\d|_|$)|interface/.test(n)) return 'interfaces'
  if (/vlan/.test(n)) return 'vlans'
  if (/vrf/.test(n)) return 'vrfs'
  if (/ospf/.test(n)) return 'ospf-neighbors'
  if (/neighbou?r|peer|bgp/.test(n)) return 'bgp-neighbors'
  return undefined
}

/** The variables of a body, in order of first use. */
export function snippetVars(body: string): SnippetVar[] {
  const seen = new Set<string>()
  const out: SnippetVar[] = []
  for (const m of body.matchAll(VAR)) {
    const name = m[1]!
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, source: varSource(name) })
  }
  return out
}

/** Why a value can't go into a command, or null. Values are typed by the user, but end up on a device. */
export function valueProblem(v: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) return 'one line, no control characters'
  if (!v.trim()) return 'required'
  if (v.length > MAX_VALUE) return `at most ${MAX_VALUE} characters`
  return null
}

/** Fill the placeholders. Every variable needs a valid value. */
export function fillSnippet(body: string, values: Readonly<Record<string, string>>): { text: string } | { error: string } {
  // Own properties only: `{{toString}}` or `{{constructor}}` must not find Object.prototype's (P8 C-L5).
  const own = (name: string): string | undefined => (Object.hasOwn(values, name) && typeof values[name] === 'string' ? values[name] : undefined)
  for (const { name } of snippetVars(body)) {
    const v = own(name)
    if (v === undefined) return { error: `{{${name}}} has no value` }
    const p = valueProblem(v)
    if (p) return { error: `{{${name}}}: ${p}` }
  }
  return { text: body.replace(VAR, (_, name: string) => own(name)!.trim()) }
}

/** Folder ids from a session's folder up to the root. */
function ancestry(folderId: string | null, folders: readonly Pick<Folder, 'id' | 'parentId'>[]): Set<string> {
  const out = new Set<string>()
  const by = new Map(folders.map((f) => [f.id, f.parentId]))
  for (let id = folderId; id && !out.has(id); id = by.get(id) ?? null) out.add(id)
  return out
}

/** The snippet applies to this session: its scope covers it, and the platform is one it is for. */
export function snippetApplies(s: Pick<Snippet, 'scope' | 'platforms'>, session: Pick<Session, 'id' | 'folderId' | 'platform'>, folders: readonly Pick<Folder, 'id' | 'parentId'>[]): boolean {
  if (s.platforms.length && !s.platforms.includes(session.platform)) return false
  if (s.scope.kind === 'global') return true
  if (s.scope.kind === 'session') return s.scope.id === session.id
  return ancestry(session.folderId, folders).has(s.scope.id)
}

/** Closest scope first: session, then folder, then global (for listing). */
export const scopeRank = (s: Pick<Snippet, 'scope'>): number => (s.scope.kind === 'session' ? 0 : s.scope.kind === 'folder' ? 1 : 2)
