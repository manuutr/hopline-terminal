/**
 * Import preview / re-sync diff.
 *
 * Identity: an imported session matches an existing one by folder path + name
 * (case-insensitive) when `folders` is given, by name alone otherwise. Then:
 * - exactly one match → `changed` (with the fields) or `unchanged`;
 * - several matches, or a second import row with the same identity
 *   → `conflict`;
 * - with folders, a unique same-name session in another folder → `changed`
 *   with `folderPath` (moved, e.g. a NetBox device that changed site);
 * - no name match but an existing session reaches the same target
 *   (protocol + host + port) → `conflict` (probably renamed: the user decides);
 * - otherwise `new`.
 * Exact matches are settled before any fallback, and each existing session is
 * matched at most once, so the plan does not depend on row order.
 *
 * Only fields the source can know are compared: a blank imported username or
 * an undetermined platform never counts as a change, nor do credentialId and
 * logToFile. Tags and jump hosts are not part of `Session`, so they are not
 * diffed here.
 */
import { sessionRef } from './result'
import type { Folder, ImportedSession, ImportResult, Session, SessionInput, SessionOptions, SessionPlatform } from './types'

export type DiffField = 'folderPath' | 'host' | 'port' | 'protocol' | 'username' | 'platform' | 'notes' | 'serial' | 'ssh'

export interface FieldChange {
  field: DiffField
  from: unknown
  to: unknown
}

export interface PlanItem {
  imported: ImportedSession
  existing?: Session
}
export interface ChangedItem extends PlanItem {
  existing: Session
  changes: FieldChange[]
}
export interface ConflictItem extends PlanItem {
  reason: 'ambiguous' | 'duplicate-in-import' | 'same-target'
  /** Existing sessions involved. */
  candidates: Session[]
  message: string
}

export interface ImportPlan {
  new: PlanItem[]
  changed: ChangedItem[]
  unchanged: (PlanItem & { existing: Session })[]
  conflicts: ConflictItem[]
  /** Folder paths from the result that don't exist yet (only when `folders` was given). */
  newFolders: string[][]
}

export interface PlanOptions {
  /** Existing folders, to compare folder paths. Without them, sessions match by name only. */
  folders?: Folder[]
}

const lc = (s: string) => s.toLowerCase()

export function folderPathOf(folderId: string | null, folders: Folder[]): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const path: string[] = []
  const seen = new Set<string>()
  let cur = folderId ? byId.get(folderId) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

function diff(imp: ImportedSession, ex: Session, exPath: string[] | null): FieldChange[] {
  const out: FieldChange[] = []
  const push = (field: DiffField, from: unknown, to: unknown) => out.push({ field, from, to })
  if (exPath && stable(exPath.map(lc)) !== stable(imp.folderPath.map(lc))) push('folderPath', exPath, imp.folderPath)
  if (lc(imp.host) !== lc(ex.host)) push('host', ex.host, imp.host)
  if (imp.port !== ex.port) push('port', ex.port, imp.port)
  if (imp.protocol !== ex.protocol) push('protocol', ex.protocol, imp.protocol)
  if (imp.username && imp.username !== ex.username) push('username', ex.username, imp.username)
  if (imp.platform && imp.platform !== ex.platform) push('platform', ex.platform, imp.platform)
  if (imp.notes && imp.notes.trim() !== ex.notes.trim()) push('notes', ex.notes, imp.notes)
  if (imp.options.serial && stable(imp.options.serial) !== stable(ex.options.serial ?? null)) push('serial', ex.options.serial, imp.options.serial)
  const ish = imp.options.ssh
  if (ish) {
    // Compare only the SSH flags the import sets; jump ids are resolved by the caller.
    const keys = (Object.keys(ish) as (keyof NonNullable<SessionOptions['ssh']>)[]).filter((k) => k !== 'jump')
    const exSsh = ex.options.ssh ?? {}
    if (keys.some((k) => ish[k] !== exSsh[k])) {
      push('ssh', Object.fromEntries(keys.map((k) => [k, exSsh[k]])), Object.fromEntries(keys.map((k) => [k, ish[k]])))
    }
  }
  return out
}

export function planImport(existing: Session[], result: ImportResult, options: PlanOptions = {}): ImportPlan {
  const folders = options.folders
  const pathOf = new Map<string, string[]>()
  if (folders) for (const s of existing) pathOf.set(s.id, folderPathOf(s.folderId, folders))
  const keyOf = (path: string[], name: string) => (folders ? [...path, name].map(lc).join('\u0000') : lc(name))

  const byKey = new Map<string, Session[]>()
  const byName = new Map<string, Session[]>()
  const byTarget = new Map<string, Session[]>()
  const add = (m: Map<string, Session[]>, k: string, s: Session) => m.set(k, [...(m.get(k) ?? []), s])
  const target = (s: { protocol: string; host: string; port: number }) => `${s.protocol}\u0000${lc(s.host)}\u0000${s.port}`
  for (const s of existing) {
    add(byKey, keyOf(pathOf.get(s.id) ?? [], s.name), s)
    add(byName, lc(s.name), s)
    add(byTarget, target(s), s)
  }

  const plan: ImportPlan = { new: [], changed: [], unchanged: [], conflicts: [], newFolders: [] }
  const claimed = new Set<string>()
  // One outcome per import row, decided in two passes and emitted in import order.
  type Outcome = { conflict: ConflictItem } | { match: Session } | { isNew: true }
  const outcome: (Outcome | undefined)[] = new Array(result.sessions.length)

  // Pass 1: exact identity matches claim their existing session first, so an
  // earlier row's "moved" fallback can never take a later row's exact match.
  const seenImport = new Set<string>()
  result.sessions.forEach((imp, i) => {
    const key = keyOf(imp.folderPath, imp.name)
    if (seenImport.has(key)) {
      outcome[i] = { conflict: { imported: imp, reason: 'duplicate-in-import', candidates: byKey.get(key) ?? [], message: `"${sessionRef(imp)}" appears more than once in the import` } }
      return
    }
    seenImport.add(key)
    const exact = byKey.get(key) ?? []
    if (exact.length === 1) {
      claimed.add(exact[0]!.id)
      outcome[i] = { match: exact[0]! }
    } else if (exact.length > 1) {
      outcome[i] = { conflict: { imported: imp, reason: 'ambiguous', candidates: exact, message: `${exact.length} existing sessions are named "${sessionRef(imp)}"` } }
    }
  })

  // Pass 2: the rest are moved sessions (same name, other folder), likely renames, or new.
  result.sessions.forEach((imp, i) => {
    if (outcome[i]) return
    if (folders) {
      const moved = (byName.get(lc(imp.name)) ?? []).filter((s) => !claimed.has(s.id))
      if (moved.length === 1) {
        claimed.add(moved[0]!.id)
        outcome[i] = { match: moved[0]! }
        return
      }
      if (moved.length > 1) {
        outcome[i] = { conflict: { imported: imp, reason: 'ambiguous', candidates: moved, message: `${moved.length} existing sessions in other folders are named "${imp.name}"` } }
        return
      }
    }
    const same = byTarget.get(target(imp)) ?? []
    if (same.length) {
      const message = `"${same[0]!.name}" already connects to ${imp.protocol}://${imp.host}${imp.port ? `:${imp.port}` : ''}`
      outcome[i] = { conflict: { imported: imp, reason: 'same-target', candidates: same, message } }
      return
    }
    outcome[i] = { isNew: true }
  })

  result.sessions.forEach((imp, i) => {
    const o = outcome[i]!
    if ('conflict' in o) plan.conflicts.push(o.conflict)
    else if ('match' in o) {
      const changes = diff(imp, o.match, folders ? pathOf.get(o.match.id)! : null)
      if (changes.length) plan.changed.push({ imported: imp, existing: o.match, changes })
      else plan.unchanged.push({ imported: imp, existing: o.match })
    } else plan.new.push({ imported: imp })
  })

  if (folders) {
    const have = new Set(folders.map((f) => folderPathOf(f.id, folders).map(lc).join('\u0000')))
    plan.newFolders = result.folders.map((f) => f.path).filter((p) => !have.has(p.map(lc).join('\u0000')))
  }
  return plan
}

/**
 * Turn an imported session into a `SessionInput` for `sessions.save`. The caller
 * supplies the folder id, the platform to use when none was determined (ask the
 * user; there is no "unknown"), and the jump-host session ids it resolved.
 */
export function toSessionInput(
  imp: ImportedSession,
  ctx: { folderId: string | null; platform: SessionPlatform; jumpIds?: string[]; credentialId?: string | null }
): SessionInput {
  const options: SessionOptions = {}
  if (imp.options.serial) options.serial = { ...imp.options.serial }
  if (imp.options.ssh || ctx.jumpIds?.length) {
    options.ssh = { ...imp.options.ssh, ...(ctx.jumpIds?.length ? { jump: [...ctx.jumpIds] } : {}) }
  }
  return {
    name: imp.name,
    folderId: ctx.folderId,
    host: imp.host,
    port: imp.port,
    protocol: imp.protocol,
    platform: imp.platform ?? ctx.platform,
    username: imp.username,
    credentialId: ctx.credentialId ?? null,
    logToFile: imp.logToFile ?? false,
    notes: imp.notes,
    options
  }
}
