import type { FleetMentionCurrent, FleetMentionError, FleetScopeSpec } from '@shared/fleet'
import { parseMentions, plainOf, replaceMentions, type Mention } from '@shared/mentions'
import type { Folder, Session } from '@shared/types'
import type { ScopeRepo } from './scope'

/**
 * Device @-mentions (F11), resolved in main against saved sessions only. The renderer sends the raw
 * text it got from the user's keyboard; main parses it again and resolves every mention here:
 *
 * - a session by name: exact first, then a case-insensitive exact match, then a unique
 *   case-insensitive prefix ("@dist" for dist-eos1). Two or more matches are ambiguous and listed;
 * - never by host or address: "@10.0.0.5" is "no saved session" even when a session's host is that;
 * - `@#tag` and `@folder/Name` become the fleet scope's own tag and folder sources;
 * - the current tab's session is the first device when it is a saved session; a quick-connect tab
 *   is reported, never added.
 *
 * The result is a FleetScopeSpec that goes through FleetScope.resolve like any other scope, so the
 * exclusions (Telnet, sign-in, unknown platform), caps, preview and consent are unchanged.
 */

export interface MentionResolution {
  /** Plain question with canonical names (what the coordinator is asked). */
  question: string
  spec: FleetScopeSpec
  errors: FleetMentionError[]
  current: FleetMentionCurrent | null
  mentions: number
}

type Repo = Pick<ScopeRepo, 'listSessions' | 'getSession' | 'listFolders'>

const IPISH = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:]+)(\/\d+)?$/i

/** Exact, then case-insensitive, then a unique case-insensitive prefix. */
function pick<T>(items: readonly T[], keys: (t: T) => string[], ref: string, prefixKeys: (t: T) => string[] = keys): { one?: T; many: T[] } {
  const exact = items.filter((t) => keys(t).some((k) => k === ref))
  if (exact.length === 1) return { one: exact[0], many: exact }
  if (exact.length > 1) return { many: exact }
  const lower = ref.toLowerCase()
  const ci = items.filter((t) => keys(t).some((k) => k.toLowerCase() === lower))
  if (ci.length === 1) return { one: ci[0], many: ci }
  if (ci.length > 1) return { many: ci }
  const pre = items.filter((t) => prefixKeys(t).some((k) => k.toLowerCase().startsWith(lower)))
  if (pre.length === 1) return { one: pre[0], many: pre }
  return { many: pre }
}

type F = Pick<Folder, 'id' | 'parentId'> & { name?: string }

function path(f: F, folders: F[]): string {
  const parts = [f.name ?? '']
  const seen = new Set([f.id])
  for (let p = folders.find((x) => x.id === f.parentId); p && !seen.has(p.id); p = folders.find((x) => x.id === p!.parentId)) {
    seen.add(p.id)
    parts.unshift(p.name ?? '')
  }
  return parts.join('/')
}

export function resolveMentions(text: string, currentSessionId: string | null, repo: Repo): MentionResolution {
  const mentions = parseMentions(text)
  const sessions = repo.listSessions().filter((s) => !s.ephemeral)
  const folders = repo.listFolders().filter((f) => !!f.name)
  const errors: FleetMentionError[] = []
  const ids: string[] = []
  const folderIds: string[] = []
  const tags: string[] = []
  const names: string[] = []

  let current: FleetMentionCurrent | null = null
  if (currentSessionId) {
    const s = repo.getSession(currentSessionId)
    current = s && !s.ephemeral ? { sessionId: s.id, name: s.name } : { quick: true }
    if (s && !s.ephemeral) ids.push(s.id)
  }

  const fail = (m: Mention, message: string, candidates?: FleetMentionError['candidates']) => errors.push({ raw: m.raw, kind: m.kind, ref: m.ref, message, ...(candidates ? { candidates } : {}) })

  for (const m of mentions) {
    if (m.kind === 'session') {
      const r = pick(sessions, (s) => [s.name], m.ref)
      if (r.one) {
        if (!ids.includes(r.one.id)) ids.push(r.one.id)
        names.push(r.one.name)
      } else if (r.many.length) {
        fail(m, `${r.many.length} sessions match '${m.ref}' — pick one`, r.many.slice(0, 8).map((s: Session) => ({ name: s.name, detail: s.host })))
        names.push(m.ref)
      } else {
        fail(m, IPISH.test(m.ref) ? `no saved session '${m.ref}' (mention a saved session by name, not an address)` : `no saved session '${m.ref}'`)
        names.push(m.ref)
      }
    } else if (m.kind === 'tag') {
      const all = [...new Set(sessions.flatMap((s) => s.tags))]
      const r = pick(all, (t) => [t], m.ref)
      if (r.one !== undefined) {
        if (!tags.includes(r.one)) tags.push(r.one)
        names.push(`#${r.one}`)
      } else if (r.many.length) {
        fail(m, `${r.many.length} tags match '#${m.ref}' — pick one`, r.many.slice(0, 8).map((t) => ({ name: t, detail: 'tag' })))
        names.push(`#${m.ref}`)
      } else {
        fail(m, `no saved session has the tag '#${m.ref}'`)
        names.push(`#${m.ref}`)
      }
    } else {
      const r = pick(folders, (f) => [f.name ?? '', path(f, folders)], m.ref, (f) => [f.name ?? ''])
      if (r.one) {
        if (!folderIds.includes(r.one.id)) folderIds.push(r.one.id)
        names.push(r.one.name ?? m.ref)
      } else if (r.many.length) {
        fail(m, `${r.many.length} folders match '${m.ref}' — pick one`, r.many.slice(0, 8).map((f) => ({ name: path(f, folders), detail: 'folder' })))
        names.push(plainOf(m))
      } else {
        fail(m, `no folder '${m.ref}'`)
        names.push(plainOf(m))
      }
    }
  }

  let question = replaceMentions(text, (_m, i) => names[i] ?? '').replace(/^\s*@ai\s+/i, '').trim()
  // "here" means the tab the question was typed in: say which device that is (the coordinator only knows names).
  if (current && 'sessionId' in current && !question.toLowerCase().includes(current.name.toLowerCase())) question += ` (this device: ${current.name})`
  return { question, spec: { sessions: ids, folders: folderIds, tags }, errors, current, mentions: mentions.length }
}
