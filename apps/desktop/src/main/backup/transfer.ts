import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { ExportCounts, ImportPreview, ImportResult, Session } from '@shared/types'
import type { Repo, Tombstone, TombstoneType } from '../db/repo'
import { ImportPayload, SettingsPatch } from '../ipc/schemas'

/**
 * What a .hopline file carries: folders, sessions, credential profiles (secrets only on request),
 * appearance preferences, trusted host keys and (for folder sync) deletions. Never the vault
 * itself (data key, master-password record), the sync configuration, the audit log or the API key.
 */
export type Payload = z.infer<typeof ImportPayload>

/**
 * The only preferences a file carries or applies: appearance. Everything else is security-relevant
 * (AI read-only, output caps, command timeouts, log folder and template, keep-alive/reconnect,
 * keeping terminal history on disk, the AI model) or machine-specific, and a file must never be able
 * to change it. One list for export, import, preview and the sync hash, so sync converges.
 */
export const PORTABLE_PREFS = ['theme', 'reduceMotion', 'termLigatures', 'termFontFamily', 'termFontSize', 'termLineHeight', 'termCursorStyle', 'termCursorBlink', 'termScrollback', 'termTheme', 'termHighlight', 'termAutocomplete'] as const

/** Tombstones older than this are dropped (by then every machine syncing has seen them). */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60_000

/** Known, valid appearance preferences only; anything else is dropped. */
export function portablePrefs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PORTABLE_PREFS) {
    if (!Object.hasOwn(raw, k)) continue
    const one = SettingsPatch.safeParse({ [k]: raw[k] })
    if (one.success) Object.assign(out, one.data)
  }
  return out
}

const readPrefs = (repo: Repo): Record<string, unknown> => {
  const raw = repo.getSetting('prefs')
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function buildPayload(repo: Repo, includeSecrets: boolean): Promise<Payload> {
  repo.pruneTombstones(Date.now() - TOMBSTONE_TTL_MS)
  const stamp = { session: repo.updatedAt('session'), folder: repo.updatedAt('folder'), credential: repo.updatedAt('credential') }
  const credentials = (await repo.exportCredentials(includeSecrets)).map((c) => ({
    id: c.id,
    name: c.name,
    username: c.username,
    kind: c.kind,
    keyType: c.keyType,
    keyFingerprint: c.keyFingerprint,
    keyEncrypted: c.keyEncrypted,
    ...(includeSecrets && c.secret !== undefined ? { secret: c.secret } : {}),
    ...(includeSecrets && c.passphrase !== undefined ? { passphrase: c.passphrase } : {}),
    updatedAt: stamp.credential.get(c.id) ?? 0
  }))
  return {
    format: 'hopline-data',
    version: 1,
    exportedAt: Date.now(),
    includesSecrets: includeSecrets,
    folders: repo.listFolders().map((f) => ({ ...f, updatedAt: stamp.folder.get(f.id) ?? 0 })),
    // When a session was last used is per machine: it would churn the sync file on every connect.
    // Favorites do travel: they are the user's choice, like a name or a color.
    sessions: repo.listSessions().map(({ lastConnectedAt: _l, ephemeral: _e, detected: _d, ...s }) => ({ ...s, updatedAt: stamp.session.get(s.id) ?? 0 })),
    credentials,
    settings: portablePrefs(readPrefs(repo)),
    knownHosts: repo.listHostKeys(),
    tombstones: repo.listTombstones()
  }
}

/** JSON with object keys sorted, so equal content hashes equal whatever order it was built in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

const byId = <T extends { id: string }>(a: readonly T[]): T[] => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))

/**
 * Content hash for folder sync: equal on two machines holding the same data, so they stop writing.
 * It covers only what a merge adopts exactly. Left out: the export time, `includesSecrets` and the
 * secrets themselves (machines may sync with and without them), and host keys (a merge never
 * replaces a differing trusted key and withholds keys for hosts a file introduces, so they can
 * legitimately differ forever; a new host key goes out with the next content change). Machine-specific
 * fields (last connected) are not in the payload at all. The payload is normalized by the import
 * schema first, so a file and the profile that imported it hash alike.
 */
export function payloadHash(p: Payload): string {
  const n = ImportPayload.safeParse(p)
  const d = n.success ? n.data : p
  const content = {
    format: d.format,
    version: d.version,
    folders: byId(d.folders),
    sessions: byId(d.sessions),
    credentials: byId(d.credentials.map(({ secret: _s, passphrase: _p, ...c }) => c)),
    settings: portablePrefs(d.settings),
    tombstones: d.tombstones.map((t) => `${t.type}:${t.id}:${t.deletedAt}`).sort()
  }
  return createHash('sha256').update(canonical(content)).digest('hex')
}

export function counts(p: Payload): ExportCounts {
  return {
    folders: p.folders.length,
    sessions: p.sessions.length,
    credentials: p.credentials.length,
    secrets: p.credentials.filter((c) => c.secret !== undefined || c.passphrase !== undefined).length,
    knownHosts: p.knownHosts.length,
    settings: Object.keys(portablePrefs(p.settings)).length > 0
  }
}

/** Validate an untrusted decrypted payload. Throws a readable error. */
export function parsePayload(raw: unknown): Payload {
  const r = ImportPayload.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new Error(`The export file is not valid (${i?.path.join('.') || 'root'}: ${i?.message ?? 'invalid'})`)
  }
  return r.data
}

type FileSession = Payload['sessions'][number]
const target = (host: string, port: number) => `${host.toLowerCase()}:${port}`

type AnyForward = NonNullable<NonNullable<Session['options']['ssh']>['forwards']>[number]
/** A forward as the listener and channel see it (label and id don't change where traffic goes). */
const forwardKey = (f: AnyForward) => JSON.stringify([f.kind, (f.bindHost ?? '').trim().toLowerCase(), f.bindPort, (f.destHost ?? '').trim().toLowerCase(), f.destPort ?? null, f.autoStart !== false])

/** The file adds a port forward the local session doesn't have, or changes one (by what it does). */
export function forwardsChanged(local: Session, f: FileSession): boolean {
  const mine = new Set((local.options?.ssh?.forwards ?? []).map(forwardKey))
  return (f.options?.ssh?.forwards ?? []).some((x) => !mine.has(forwardKey(x)))
}

/**
 * True when a file's version of a session sends it somewhere else, or with more reach, than the
 * local one: another host, port, protocol or jump chain, agent forwarding switched on/off, or a
 * port forward added or changed (a `-R` opens a port on the device that reaches back here). A
 * stored credential must never follow such a change silently (a hostile file could otherwise
 * point a known session id at its own host and collect the password).
 */
export function retargets(local: Session, f: FileSession): boolean {
  const a = local.options?.ssh ?? {}
  const b = f.options?.ssh ?? {}
  return (
    local.host.toLowerCase() !== f.host.toLowerCase() ||
    local.port !== f.port ||
    local.protocol !== f.protocol ||
    JSON.stringify(a.jump ?? []) !== JSON.stringify(b.jump ?? []) ||
    !!a.agentForward !== !!b.agentForward ||
    forwardsChanged(local, f)
  )
}

/**
 * Port forwards a hand-picked merge writes: an existing session keeps its own (a file never adds
 * or changes forwards on it), a new one gets the file's switched off (started by hand).
 */
function mergedForwards(local: Session | undefined, f: FileSession): AnyForward[] | undefined {
  if (local) return local.options?.ssh?.forwards
  const list = f.options?.ssh?.forwards
  return list?.map((x) => ({ ...x, autoStart: false }))
}

interface MergePlan {
  /** File items not applied: deleted here more recently than the file's version (sync). */
  skip: Record<TombstoneType, Set<string>>
  /** Local items to delete: the file's tombstone is at least as new (sync). */
  remove: Tombstone[]
  /** File tombstones to record here (sync), or the whole set (replace). */
  tombstones: Tombstone[]
  /** Existing session ids the file retargets. */
  retargeted: Set<string>
  /** host:port targets the file introduces or retargets: no host keys imported for them. */
  withheld: Set<string>
}

const key = (type: TombstoneType, id: string) => `${type}\0${id}`

/**
 * Decide what a merge/replace does, against the database as it is now.
 * Tombstones are used for folder sync only (`sync`): a file the user picked by hand is applied as
 * is, and a replace makes the file's tombstones the only ones. The rule is symmetric, and a
 * tombstone wins a tie: an item comes back only if it changed after it was deleted.
 */
function plan(repo: Repo, p: Payload, mode: 'merge' | 'replace', sync: boolean, now = Date.now()): MergePlan {
  const cutoff = now - TOMBSTONE_TTL_MS
  const fileTombs = p.tombstones.filter((t) => t.deletedAt >= cutoff)
  const skip: MergePlan['skip'] = { session: new Set(), folder: new Set(), credential: new Set() }
  const remove: Tombstone[] = []
  let tombstones: Tombstone[] = []
  const items: Record<TombstoneType, { id: string; updatedAt?: number }[]> = { session: p.sessions, folder: p.folders, credential: p.credentials }
  if (mode === 'replace') tombstones = fileTombs
  else if (sync) {
    const local = new Map(repo.listTombstones().map((t) => [key(t.type, t.id), t.deletedAt]))
    const inFile = new Map(fileTombs.map((t) => [key(t.type, t.id), t.deletedAt]))
    for (const type of ['session', 'folder', 'credential'] as const)
      for (const it of items[type]) {
        // Deleted here, or deleted by the file itself (a hostile file may carry both): stays deleted
        // unless this version is newer than the deletion.
        const del = Math.max(local.get(key(type, it.id)) ?? -1, inFile.get(key(type, it.id)) ?? -1)
        if (del >= 0 && (it.updatedAt ?? 0) <= del) skip[type].add(it.id)
      }
    const stamps = { session: repo.updatedAt('session'), folder: repo.updatedAt('folder'), credential: repo.updatedAt('credential') }
    for (const t of fileTombs) {
      const fileItem = items[t.type].find((x) => x.id === t.id)
      if (fileItem && !skip[t.type].has(t.id)) continue // the file's own newer version wins
      const mine = stamps[t.type].get(t.id)
      if (mine !== undefined && mine > t.deletedAt) continue // changed here after it was deleted there
      if (mine !== undefined) remove.push(t)
      tombstones.push(t)
    }
  }

  // Retargeting and host-key trust are judged against the sessions here before the import.
  const sessions = repo.listSessions()
  const fileById = new Map(p.sessions.map((s) => [s.id, s]))
  const localById = new Map(sessions.map((s) => [s.id, s]))
  const retargeted = new Set<string>()
  const kept = new Set<string>()
  for (const s of sessions) {
    const f = fileById.get(s.id)
    if (f && !skip.session.has(s.id) && retargets(s, f)) retargeted.add(s.id)
    else kept.add(target(s.host, s.port))
  }
  const withheld = new Set<string>()
  for (const f of p.sessions) {
    if (skip.session.has(f.id)) continue
    const l = localById.get(f.id)
    if ((!l || retargeted.has(f.id)) && !kept.has(target(f.host, f.port))) withheld.add(target(f.host, f.port))
  }
  return { skip, remove, tombstones, retargeted, withheld }
}

/** Hosts for which the file trusts a key this machine doesn't (while trusting another one). */
function knownHostConflicts(repo: Repo, p: Payload): { host: string; port: number }[] {
  const seen = new Set<string>()
  const out: { host: string; port: number }[] = []
  for (const h of p.knownHosts) {
    const local = repo.hostKeys(h.host, h.port)
    const id = target(h.host, h.port)
    if (local.length && !local.includes(h.fingerprint) && !seen.has(id)) {
      seen.add(id)
      out.push({ host: h.host.toLowerCase(), port: h.port })
    }
  }
  return out
}

function withheldKeys(p: Payload, m: MergePlan): number {
  return new Set(p.knownHosts.filter((h) => m.withheld.has(target(h.host, h.port))).map((h) => `${target(h.host, h.port)}:${h.fingerprint}`)).size
}

export function preview(repo: Repo, p: Payload, meta: { token: string; file: string; createdAt: number }, opts: { sync?: boolean } = {}): ImportPreview {
  const m = plan(repo, p, 'merge', !!opts.sync)
  const folders = new Set(repo.listFolders().map((f) => f.id))
  const sessions = repo.listSessions()
  const sessionIds = new Set(sessions.map((s) => s.id))
  const creds = new Set(repo.listCredentials().map((c) => c.id))
  const byNameHost = new Map(sessions.map((s) => [`${s.name}\0${s.host}`, s.id]))
  const duplicates = p.sessions.filter((s) => !sessionIds.has(s.id) && byNameHost.has(`${s.name}\0${s.host}`)).map((s) => `${s.name} (${s.host})`)
  const hostKeyConflicts = knownHostConflicts(repo, p)
  const fileFolders = new Set(p.folders.map((f) => f.id))
  const fileSessions = new Set(p.sessions.map((s) => s.id))
  const fileCreds = new Set(p.credentials.map((c) => c.id))
  const fileHosts = new Set(p.knownHosts.map((h) => `${h.host.toLowerCase()}:${h.port}:${h.fingerprint}`))
  const localSession = new Map(sessions.map((s) => [s.id, s]))
  const fileSession = new Map(p.sessions.map((s) => [s.id, s]))
  const retargeted = [...m.retargeted].map((id) => {
    const l = localSession.get(id)!
    const f = fileSession.get(id)!
    const where = `${l.host}:${l.port} → ${f.host}:${f.port}`
    return `${l.name} (${where}${forwardsChanged(l, f) ? ', port forwards added or changed' : ''})`
  })
  // A file that would attach a credential already stored here to a session that doesn't use it yet
  // (a new session, or a second import of a retargeting file): the link is NOT made (see
  // applyPayload `mayLink`); the preview names these so the user can link them by hand.
  const credName = new Map(repo.listCredentials().map((c) => [c.id, c.name]))
  const credentialAttached = p.sessions
    .filter((f) => f.credentialId && credName.has(f.credentialId) && !m.skip.session.has(f.id) && !m.retargeted.has(f.id))
    .filter((f) => localSession.get(f.id)?.credentialId !== f.credentialId)
    .map((f) => `${f.name} (${f.host}:${f.port}) uses "${credName.get(f.credentialId!)}"`)
  const applied = portablePrefs(p.settings)
  const names = { session: new Map(sessions.map((s) => [s.id, s.name])), folder: new Map(repo.listFolders().map((f) => [f.id, f.name])), credential: new Map(repo.listCredentials().map((c) => [c.id, c.name])) }
  const label = { session: 'session', folder: 'folder', credential: 'profile' }
  return {
    ...meta,
    exportedAt: p.exportedAt,
    includesSecrets: p.includesSecrets,
    counts: counts(p),
    updates: {
      folders: p.folders.filter((f) => folders.has(f.id) && !m.skip.folder.has(f.id)).length,
      sessions: p.sessions.filter((s) => sessionIds.has(s.id) && !m.skip.session.has(s.id)).length,
      credentials: p.credentials.filter((c) => creds.has(c.id) && !m.skip.credential.has(c.id)).length
    },
    duplicates: duplicates.slice(0, 50),
    hostKeyConflicts: hostKeyConflicts.slice(0, 50),
    localOnly: {
      folders: [...folders].filter((id) => !fileFolders.has(id)).length,
      sessions: [...sessionIds].filter((id) => !fileSessions.has(id)).length,
      credentials: [...creds].filter((id) => !fileCreds.has(id)).length,
      knownHosts: repo.listHostKeys().filter((h) => !fileHosts.has(`${h.host}:${h.port}:${h.fingerprint}`)).length
    },
    retargeted: retargeted.slice(0, 50),
    credentialAttached: credentialAttached.slice(0, 50),
    hostKeysWithheld: withheldKeys(p, m),
    settingsApplied: Object.keys(applied),
    settingsIgnored: Object.keys(p.settings)
      .filter((k) => !Object.hasOwn(applied, k))
      .slice(0, 50),
    deletions: m.remove.map((t) => `${label[t.type]} "${names[t.type].get(t.id) ?? t.id}"`).slice(0, 50)
  }
}

/**
 * Folders to write, parents before children, with each parent resolved against the merged tree
 * (folders here, overridden by the file's): a parent that is neither placed from the file nor here
 * becomes the root, and a folder whose new parent chain would loop back to it (at any depth, through
 * local folders too) goes to the root instead.
 */
function orderFolders(p: Payload, skip: Set<string>, existing: Map<string, string | null>): Payload['folders'] {
  const list = p.folders.filter((f) => !skip.has(f.id))
  const byId = new Map(list.map((f) => [f.id, f]))
  const placed = new Set<string>()
  const visiting = new Set<string>()
  const out: Payload['folders'] = []
  const parent = new Map(existing)
  const loops = (id: string, from: string | null): boolean => {
    const seen = new Set<string>()
    for (let x = from; x; x = parent.get(x) ?? null) {
      if (x === id || seen.has(x)) return true
      seen.add(x)
    }
    return false
  }
  const visit = (f: Payload['folders'][number]) => {
    if (placed.has(f.id) || visiting.has(f.id)) return
    visiting.add(f.id)
    let parentId = f.parentId
    if (parentId && byId.has(parentId)) visit(byId.get(parentId)!)
    // A parent from the file must already be placed (a cycle inside the file is cut here); one that
    // isn't in the file must exist locally.
    if (parentId && !placed.has(parentId) && (byId.has(parentId) || !existing.has(parentId))) parentId = null
    if (parentId && loops(f.id, parentId)) parentId = null
    parent.set(f.id, parentId)
    visiting.delete(f.id)
    out.push({ ...f, parentId })
    placed.add(f.id)
  }
  for (const f of list) visit(f)
  return out
}

/**
 * Apply a validated payload.
 * - merge: items with the same id are updated, everything else is added; local-only items stay.
 *   A credential without secrets in the file keeps the secrets stored here. Host keys are only
 *   added for hosts this machine doesn't know and that the file doesn't introduce or retarget; a
 *   different key is reported, never trusted. A session the file retargets loses its credential.
 *   With `sync`, tombstones apply both ways (see plan()).
 * - replace: folders, sessions, credentials, known hosts and tombstones are replaced by the file's.
 * Only appearance preferences are applied. Secrets are encrypted before the transaction opens;
 * the transaction is all-or-nothing.
 */
export async function applyPayload(repo: Repo, p: Payload, mode: 'merge' | 'replace', opts: { sync?: boolean } = {}): Promise<ImportResult> {
  const now = Date.now()
  repo.pruneTombstones(now - TOMBSTONE_TTL_MS)
  const m = plan(repo, p, mode, !!opts.sync, now)
  const creds = p.credentials.filter((c) => !m.skip.credential.has(c.id))
  const enc = new Map<string, { secret: Buffer | null; passphrase: Buffer | null }>()
  for (const c of creds) enc.set(c.id, { secret: await repo.encryptFor(c.id, 'secret', c.secret), passphrase: await repo.encryptFor(c.id, 'passphrase', c.passphrase) })
  const prefs = portablePrefs(p.settings)
  const conflicts = mode === 'merge' ? knownHostConflicts(repo, p) : []
  // A merge may keep a credential link a session already has here, or link a profile that arrives
  // new in this same file, but never newly attach a profile that was already stored on this machine:
  // otherwise a file (even imported twice) could point a stored password at a host it chose.
  const credsBefore = new Set(repo.listCredentials().map((c) => c.id))
  const sessionsBefore = new Map(repo.listSessions().map((s) => [s.id, s]))
  const linkBefore = new Map([...sessionsBefore].map(([id, s]) => [id, s.credentialId]))
  // Sync between the user's own machines (passphrase-protected folder) may link shared profiles;
  // a file picked by hand may not, and doesn't add host keys either (first connect asks as usual).
  const manualMerge = mode === 'merge' && !opts.sync
  const mayLink = (sessionId: string, credId: string): boolean => !manualMerge || linkBefore.get(sessionId) === credId || !credsBefore.has(credId)
  let hosts = 0
  repo.batch(() => {
    if (mode === 'replace') repo.clearForReplace()
    const existing = new Map(repo.listFolders().map((f) => [f.id, f.parentId]))
    for (const f of orderFolders(p, m.skip.folder, existing)) {
      const { updatedAt, ...folder } = f
      repo.putFolder(folder, updatedAt ?? now)
    }
    for (const c of creds) {
      const e = enc.get(c.id)!
      const secretsFit = c.kind === 'password' || c.kind === 'key'
      repo.putCredentialRow(
        {
          id: c.id,
          name: c.name,
          username: c.username,
          kind: c.kind,
          secret: secretsFit ? e.secret : null,
          passphrase: c.kind === 'key' ? e.passphrase : null,
          keyType: c.kind === 'key' ? c.keyType : null,
          keyFingerprint: c.kind === 'key' ? c.keyFingerprint : null,
          keyEncrypted: c.kind === 'key' && c.keyEncrypted
        },
        mode === 'merge' && secretsFit,
        c.updatedAt ?? now
      )
    }
    const folderIds = new Set(repo.listFolders().map((f) => f.id))
    const credIds = new Set(repo.listCredentials().map((c) => c.id))
    // A session in a folder this machine deleted goes where that folder was in the file.
    const fileParent = new Map(p.folders.map((f) => [f.id, f.parentId]))
    const folderFor = (id: string | null): string | null => {
      const seen = new Set<string>()
      for (let x = id; x && !seen.has(x); x = fileParent.get(x) ?? null) {
        if (folderIds.has(x)) return x
        seen.add(x)
      }
      return null
    }
    for (const s of p.sessions) {
      if (m.skip.session.has(s.id)) continue
      const { updatedAt, ...input } = s
      // A hand-picked file never brings forwards onto an existing session, and a new session's
      // forwards arrive switched off.
      if (manualMerge && (input.options?.ssh?.forwards || sessionsBefore.get(s.id)?.options?.ssh?.forwards)) {
        const forwards = mergedForwards(sessionsBefore.get(s.id), s)
        const { forwards: _drop, ...ssh } = input.options?.ssh ?? {}
        input.options = { ...input.options, ssh: { ...ssh, ...(forwards ? { forwards } : {}) } }
      }
      repo.saveSession(
        {
          ...input,
          folderId: folderFor(s.folderId),
          credentialId: !m.retargeted.has(s.id) && s.credentialId && credIds.has(s.credentialId) && mayLink(s.id, s.credentialId) ? s.credentialId : null
        },
        { updatedAt: updatedAt ?? now }
      )
    }
    for (const h of p.knownHosts) {
      if (m.withheld.has(target(h.host, h.port))) continue
      const local = repo.hostKeys(h.host, h.port)
      // Merge never adds a second key next to a different trusted one: that is the conflict case.
      if (manualMerge) continue
      if (mode === 'merge' && local.length && !local.includes(h.fingerprint)) continue
      if (repo.addHostKey(h.host, h.port, h.fingerprint, 'import', h.keyType)) hosts++
    }
    // Deletions from the other machine, then the tombstones themselves at their original time.
    for (const t of m.remove) {
      if (t.type === 'session') repo.removeSession(t.id)
      else if (t.type === 'folder') repo.removeFolder(t.id)
      else repo.removeCredential(t.id)
    }
    for (const t of m.tombstones) repo.putTombstone(t, { exact: m.remove.includes(t) })
    if (Object.keys(prefs).length) repo.setSetting('prefs', JSON.stringify({ ...readPrefs(repo), ...prefs }))
    repo.repairFolderCycles()
  })
  return {
    mode,
    folders: p.folders.length - m.skip.folder.size,
    sessions: p.sessions.length - m.skip.session.size,
    credentials: creds.length,
    knownHosts: hosts,
    hostKeyConflicts: conflicts.length,
    settings: Object.keys(prefs).length > 0,
    retargeted: m.retargeted.size,
    hostKeysWithheld: withheldKeys(p, m),
    deleted: m.remove.length
  }
}
