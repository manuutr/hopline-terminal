import { randomUUID } from 'node:crypto'
import { detectDelimiter, folderPathOf, parseCsv, planImport, sessionRef, toSessionInput, type CsvImportResult, type CsvMapping, type ImportedSession, type ImportResult } from '@hopline/importers'
import { isPlatform } from '@hopline/guard'
import type {
  Folder,
  SessionPlatform,
  Session,
  SessionImportApply,
  SessionImportGoneRow,
  SessionImportOptions,
  SessionImportOutcome,
  SessionImportPlan,
  SessionImportRow,
  SessionImportSource,
  SessionImportWarning,
  SessionInput
} from '@shared/types'
import type { Repo } from '../db/repo'
import type { PendingNetBox } from './netbox'
import { normalizeTags } from '../db/repo'
import { SessionFields as SessionInputSchema } from '../ipc/schemas'

/**
 * An import as main keeps it between preview and apply: the importer's result (never sent to the
 * renderer as such) plus what is needed to re-plan it. Passwords are not in it: the importers drop them.
 */
export interface StagedImport {
  source: SessionImportSource
  label: string
  /** CSV results may say `headerless` (row 1 read as data). */
  result: ImportResult | CsvImportResult
  /**
   * Why sessions missing from this fetch are not offered for removal (a different filter than the
   * saved source, so absence means nothing). Unset: the "gone" list is computed.
   */
  noGone?: string
  /** CSV: the decoded file and the mapping in use, so the user can re-map columns. */
  csvText?: string
  csv?: { mapping: CsvMapping; hasHeader: boolean }
  /** Records with a stable id (NetBox devices) are linked to sessions under this key, for re-sync. */
  linkSource?: string
  /** NetBox: the source to save once applied. */
  netbox?: PendingNetBox
  resync: boolean
}

type Change = { field: string; from: unknown; to: unknown }

/** One row as main plans it: the imported session at its effective folder path, and what it matches here. */
interface Item {
  index: number
  imp: ImportedSession
  status: SessionImportRow['status']
  existing?: Session
  changes?: Change[]
  conflict?: SessionImportRow['conflict']
}

export interface BuiltPlan {
  items: Item[]
  /** Per row: the row indexes of its jump hosts, first hop first (undefined: no jump, or not resolvable). */
  jumps: (number[] | undefined)[]
  gone: SessionImportGoneRow[]
  newFolders: string[][]
  options: SessionImportOptions
}

const lc = (s: string) => s.toLowerCase()
const pathKey = (p: string[]) => p.map(lc).join('\u0000')
const MAX_NAME = 120
const MAX_NOTES = 4000

/** Tags as the session schema accepts them: no spaces or commas, at most 40 characters, 32 of them. */
export function cleanTags(tags: readonly string[]): string[] {
  return normalizeTags(tags.map((t) => t.trim().replace(/[\s,]+/g, '-').slice(0, 40))).slice(0, 32)
}

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.join(' / ') : 'top level'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('baudRate' in o) return `${String(o['baudRate'])} baud`
    const on = Object.entries(o).filter(([, x]) => x !== undefined)
    return on.length ? on.map(([k, x]) => `${k} ${x === true ? 'on' : x === false ? 'off' : String(x)}`).join(', ') : '—'
  }
  return String(v)
}

/** Effective folder path of an imported session: under the target, keeping or flattening its source path. */
const placed = (target: string[], keep: boolean, path: string[]) => [...target, ...(keep ? path : [])]

export function buildPlan(repo: Repo, staged: StagedImport, opts: SessionImportOptions): BuiltPlan {
  const folders = repo.listFolders()
  const existing = repo.listSessions()
  // A target folder deleted since the preview opened: fall back to the top level.
  const targetFolderId = opts.targetFolderId && folders.some((f) => f.id === opts.targetFolderId) ? opts.targetFolderId : null
  const target = targetFolderId ? folderPathOf(targetFolderId, folders) : []
  const options = { targetFolderId, keepFolders: opts.keepFolders }
  const src = staged.result.sessions

  // Jump references name sessions by their source path: resolve them to rows before paths move.
  const refIdx = new Map<string, number>()
  src.forEach((s, i) => {
    const k = lc(sessionRef(s))
    if (!refIdx.has(k)) refIdx.set(k, i)
  })
  const jumps = src.map((s) => {
    const refs = s.jumpChain ?? (s.jumpRef ? [s.jumpRef] : [])
    const idx = refs.map((r) => refIdx.get(lc(r)))
    return idx.length && idx.every((x) => x !== undefined) ? (idx as number[]) : undefined
  })

  const sessions = src.map((s) => ({ ...s, folderPath: placed(target, opts.keepFolders, s.folderPath) }))
  const folderSet = new Map<string, string[]>()
  for (const s of sessions) for (let i = 1; i <= s.folderPath.length; i++) folderSet.set(pathKey(s.folderPath.slice(0, i)), s.folderPath.slice(0, i))
  const result: ImportResult = { folders: [...folderSet.values()].map((path) => ({ path })), sessions, warnings: [] }

  // Re-sync: records already linked to a session match it by id, whatever its name or folder now.
  const byId = new Map(existing.map((s) => [s.id, s]))
  const linkOf = new Map((staged.linkSource ? repo.importLinks(staged.linkSource) : []).map((l) => [l.extId, l.sessionId]))
  const linked = new Map<number, Session>()
  const claimed = new Set<string>()
  sessions.forEach((s, i) => {
    const sid = s.source.id !== undefined ? linkOf.get(s.source.id) : undefined
    const ex = sid ? byId.get(sid) : undefined
    if (ex && !claimed.has(ex.id)) {
      linked.set(i, ex)
      claimed.add(ex.id)
    }
  })

  const items: Item[] = new Array(sessions.length)
  const indexOf = new Map(sessions.map((s, i) => [s as ImportedSession, i]))
  const rest = sessions.filter((_, i) => !linked.has(i))
  const plan = planImport(
    existing.filter((s) => !claimed.has(s.id)),
    { ...result, sessions: rest },
    { folders }
  )
  const put = (imp: ImportedSession, it: Omit<Item, 'index' | 'imp'>) => {
    const index = indexOf.get(imp)!
    items[index] = { index, imp, ...it }
  }
  for (const p of plan.new) put(p.imported, { status: 'new' })
  for (const p of plan.changed) put(p.imported, { status: 'changed', existing: byId.get(p.existing.id), changes: p.changes })
  for (const p of plan.unchanged) put(p.imported, { status: 'unchanged', existing: byId.get(p.existing.id) })
  for (const p of plan.conflicts) {
    const cand = p.candidates[0] ? byId.get(p.candidates[0].id) : undefined
    put(p.imported, { status: 'conflict', existing: p.candidates.length === 1 ? cand : undefined, conflict: { reason: p.reason, message: p.message } })
  }
  for (const [i, ex] of linked) {
    const imp = sessions[i]!
    // Diff against the linked session as if it had the imported name, then report a rename.
    const one = planImport([{ ...ex, name: imp.name }], { folders: result.folders, sessions: [imp], warnings: [] }, { folders })
    const changes: Change[] = [...(one.changed[0]?.changes ?? [])]
    if (ex.name !== imp.name) changes.unshift({ field: 'name', from: ex.name, to: imp.name })
    items[i] = changes.length ? { index: i, imp, status: 'changed', existing: ex, changes } : { index: i, imp, status: 'unchanged', existing: ex }
  }

  // Linked sessions whose record is gone from the source. Only from a complete fetch with the same
  // filter: a partial pull (the importer throws, or older ones warned) or another filter's devices
  // being absent says nothing about deletions.
  const seen = new Set(sessions.flatMap((s) => (s.source.id !== undefined ? [s.source.id] : [])))
  const gone: SessionImportGoneRow[] = []
  const trustGone = !staged.noGone && !incompleteFetch(staged.result)
  for (const [extId, sid] of trustGone ? linkOf : []) {
    const s = byId.get(sid)
    if (s && !seen.has(extId) && !claimed.has(sid)) gone.push({ sessionId: s.id, name: s.name, folderPath: folderPathOf(s.folderId, folders), host: s.host })
  }

  // A platform guessed from the name never overrides one already chosen here (it is only a guess).
  for (const it of items) {
    if (it.status !== 'changed' || !it.imp.platformGuessed) continue
    it.changes = it.changes!.filter((c) => c.field !== 'platform')
    if (!it.changes.length) {
      it.status = 'unchanged'
      delete it.changes
    }
  }

  const have = new Set(folders.map((f) => pathKey(folderPathOf(f.id, folders))))
  const newFolders = [...folderSet.values()].filter((p) => !have.has(pathKey(p)))
  return { items, jumps, gone, newFolders, options }
}

/** A fetch that may have missed records: flagged by the importer, or reported in a warning (older importers). */
export function incompleteFetch(r: ImportResult): boolean {
  const flags = r as unknown as { incomplete?: unknown; complete?: unknown; partial?: unknown }
  if (flags.incomplete === true || flags.partial === true || flags.complete === false) return true
  return r.warnings.some((w) => /\b(incomplete|partial)\b|reported \d+ devices but returned/i.test(w.message))
}

function platformPrompt(it: Item): SessionImportRow['platformPrompt'] {
  if (it.status === 'new' || it.status === 'conflict') return !it.imp.platform ? 'missing' : it.imp.platformGuessed ? 'guessed' : null
  return null
}

/** The renderer's view of a plan: display fields only. */
export function planView(repo: Repo, staged: StagedImport, built: BuiltPlan, token: string): SessionImportPlan {
  const folders = repo.listFolders()
  const rows: SessionImportRow[] = built.items.map((it) => ({
    index: it.index,
    status: it.status,
    name: it.imp.name,
    folderPath: it.imp.folderPath,
    host: it.imp.host,
    port: it.imp.port,
    protocol: it.imp.protocol,
    username: it.imp.username,
    platform: it.imp.platform ?? null,
    platformGuessed: !!it.imp.platformGuessed,
    platformPrompt: platformPrompt(it),
    tags: cleanTags(it.imp.tags),
    jump: (built.jumps[it.index] ?? []).map((j) => sessionRef(built.items[j]!.imp)),
    ...(it.existing ? { existing: { id: it.existing.id, name: it.existing.name, folderPath: folderPathOf(it.existing.folderId, folders) } } : {}),
    ...(it.changes ? { changes: it.changes.map((c) => ({ field: c.field === 'folderPath' ? 'folder' : c.field, from: show(c.from), to: show(c.to) })) } : {}),
    ...(it.conflict ? { conflict: it.conflict } : {})
  }))
  return {
    token,
    source: staged.source,
    label: staged.label,
    resync: staged.resync,
    rows,
    gone: built.gone,
    newFolders: built.newFolders,
    warnings: [
      ...staged.result.warnings.map((w) => ({ item: w.item, message: w.message })),
      ...((staged.result as CsvImportResult).headerless
        ? [{ item: 'CSV', message: 'Row 1 is read as data, so password columns cannot be recognised by their title. Make sure no mapped column holds passwords or other secrets.' }]
        : []),
      ...(staged.linkSource && (staged.noGone || incompleteFetch(staged.result)) ? [{ item: 'NetBox', message: staged.noGone ?? 'The device list may be incomplete: sessions missing from it are not offered for removal.' }] : [])
    ],
    options: built.options
  }
}

/** Overlay only the fields the source changed: credential, logging, color, favorite and the rest stay. */
function updateInput(ex: Session, imp: ImportedSession, changes: Change[], folderId: () => string | null): SessionInput {
  const has = (f: string) => changes.some((c) => c.field === f)
  const options = { ...ex.options }
  if (has('serial') && imp.options.serial) options.serial = { ...imp.options.serial }
  if (has('ssh') && imp.options.ssh) {
    const { jump: _j, ...flags } = imp.options.ssh
    void _j
    options.ssh = { ...ex.options.ssh, ...flags }
  }
  return {
    id: ex.id,
    name: has('name') ? imp.name.slice(0, MAX_NAME) : ex.name,
    folderId: has('folderPath') ? folderId() : ex.folderId,
    host: has('host') ? imp.host : ex.host,
    port: has('port') ? imp.port : ex.port,
    protocol: has('protocol') ? imp.protocol : ex.protocol,
    platform: has('platform') && imp.platform ? imp.platform : ex.platform,
    username: has('username') ? imp.username : ex.username,
    credentialId: ex.credentialId,
    logToFile: ex.logToFile,
    notes: has('notes') ? imp.notes : ex.notes,
    options,
    tags: cleanTags([...ex.tags, ...imp.tags])
  }
}

/**
 * Write the ticked rows. The plan is rebuilt from the current database first (the renderer sends only
 * row indexes and choices), every session is built and validated before anything is written, and the
 * writes happen in one transaction: all or nothing.
 */
export function applyImport(repo: Repo, staged: StagedImport, req: Omit<SessionImportApply, 'token'>): SessionImportOutcome & { removedIds: string[] } {
  const built = buildPlan(repo, staged, { targetFolderId: req.targetFolderId, keepFolders: req.keepFolders })
  const picked = new Set(req.rows)
  const warnings: SessionImportWarning[] = []

  // Folders: reuse a folder at the same path (any case), create the rest with ids chosen up front.
  const folders = repo.listFolders()
  const known = new Map<string, string>()
  for (const f of folders) {
    const k = pathKey(folderPathOf(f.id, folders))
    if (!known.has(k)) known.set(k, f.id)
  }
  const create: Folder[] = []
  const folderFor = (path: string[]): string | null => {
    let parent: string | null = null
    for (let i = 1; i <= path.length; i++) {
      const k = pathKey(path.slice(0, i))
      let id = known.get(k)
      if (!id) {
        id = randomUUID()
        create.push({ id, name: path[i - 1]!.slice(0, MAX_NAME), parentId: parent, sort: 0 })
        known.set(k, id)
      }
      parent = id
    }
    return parent
  }

  // Session ids are known before the transaction, so jump hosts resolve in one pass.
  const idOf = new Map<number, string>()
  for (const it of built.items) {
    if (picked.has(it.index) && (it.status === 'new' || it.status === 'conflict')) idOf.set(it.index, randomUUID())
    else if ((it.status === 'changed' || it.status === 'unchanged') && it.existing) idOf.set(it.index, it.existing.id)
  }

  const writes: { input: SessionInput; created: boolean }[] = []
  let skippedJumps = 0
  for (const it of built.items) {
    if (!picked.has(it.index) || it.status === 'unchanged') continue
    const imp = it.imp
    const chosen = req.platforms[String(it.index)] as SessionPlatform | undefined
    let jumpIds: string[] | undefined
    const hops = built.jumps[it.index]
    if (hops) {
      const ids = hops.map((j) => idOf.get(j))
      if (ids.every((x): x is string => !!x) && !ids.includes(idOf.get(it.index)!)) jumpIds = ids
      else {
        skippedJumps++
        warnings.push({ item: imp.name, message: `Jump host ${hops.map((j) => sessionRef(built.items[j]!.imp)).join(' → ')} was not imported, so it was not set` })
      }
    }
    let input: SessionInput
    if (it.status === 'changed' && it.existing) {
      input = updateInput(it.existing, imp, it.changes ?? [], () => folderFor(imp.folderPath))
      if (chosen) input.platform = chosen
      // Jump hosts are not diffed: one already set here stays; the source's fills an empty one.
      if (jumpIds && !it.existing.options.ssh?.jump?.length) input.options = { ...input.options, ssh: { ...input.options.ssh, jump: jumpIds } }
    } else {
      // No platform from the source and none chosen: Auto-detect identifies it on first connect.
      const platform: SessionPlatform = chosen ?? imp.platform ?? 'auto'
      // toSessionInput prefers the imported platform: pass the user's choice as the session's own.
      input = {
        ...toSessionInput({ ...imp, platform: isPlatform(platform) ? platform : undefined }, { folderId: folderFor(imp.folderPath), platform, jumpIds }),
        id: idOf.get(it.index)!,
        tags: cleanTags(imp.tags)
      }
    }
    if (input.name.length > MAX_NAME) input.name = input.name.slice(0, MAX_NAME)
    if (input.notes.length > MAX_NOTES) {
      input.notes = input.notes.slice(0, MAX_NOTES - 1) + '…'
      warnings.push({ item: imp.name, message: `Notes shortened to ${MAX_NOTES} characters` })
    }
    const ok = SessionInputSchema.safeParse(input)
    if (!ok.success) {
      const i = ok.error.issues[0]
      throw new Error(`"${imp.name}" can't be imported (${i?.path.join('.') || 'session'}: ${i?.message ?? 'invalid'})`)
    }
    writes.push({ input, created: it.status !== 'changed' })
  }

  const links: [string, string][] = []
  if (staged.linkSource)
    for (const it of built.items) {
      const extId = it.imp.source.id
      const sid = idOf.get(it.index)
      if (extId !== undefined && sid && (picked.has(it.index) || it.status === 'unchanged')) links.push([extId, sid])
    }
  const goneIds = new Set(built.gone.map((g) => g.sessionId))
  const remove = req.remove.filter((id) => goneIds.has(id))

  repo.batch(() => {
    for (const f of create) repo.putFolder(f)
    for (const w of writes) repo.saveSession(w.input)
    for (const [extId, sid] of links) repo.linkImport(staged.linkSource!, extId, sid)
    for (const id of remove) repo.removeSession(id)
  })

  const inFolders = new Set(writes.map((w) => w.input.folderId).filter((x): x is string => !!x))
  return {
    created: writes.filter((w) => w.created).length,
    updated: writes.filter((w) => !w.created).length,
    removed: remove.length,
    folders: inFolders.size,
    newFolders: create.length,
    skippedJumps,
    warnings,
    removedIds: remove
  }
}

/**
 * Column titles the mapping step may show. Anything else in row 1 could be data (a headerless file
 * has a password in row 1 as often as a title), so it stays in main and shows as "Column N".
 */
const KNOWN_HEADERS = new Set(
  (
    'ip ipaddress mgmtip managementip primaryip primaryipv4 primaryip4 ipv4 ipv6 address host hostname fqdn target name session sessionname ' +
    'label displayname device devicename title port tcpport protocol proto connectiontype username user login loginname folder path group ' +
    'folderpath site location platform os platformslug networkdriver tags tag labels notes note description comments comment baud baudrate ' +
    'speed password pass secret role devicerole status model devicetype vendor manufacturer serial tenant rack region id type'
  ).split(' ')
)

/**
 * A row 1 that reads as titles, not a device: no digits, no dots or @ (addresses, hosts, users),
 * short words. A headerless file's first row has an IP or host name in it, so it never passes.
 */
const looksLikeTitles = (row: string[]): boolean =>
  row.some((c) => c.trim()) && row.every((c) => { const t = c.trim(); return t.length <= 40 && !/[0-9.@:/\\]/.test(t) })

/** CSV columns for the mapping step: positions and column titles only, never cell values. */
export function csvInfo(st: StagedImport): NonNullable<SessionImportPlan['csv']> {
  const text = st.csvText ?? ''
  const rows = parseCsv(text, detectDelimiter(text)).filter((r) => r.some((c) => c.trim()))
  const hasHeader = st.csv?.hasHeader ?? true
  const head = rows[0] ?? []
  const width = Math.min(500, Math.max(0, ...rows.slice(0, 50).map((r) => r.length)))
  const titles = looksLikeTitles(head)
  const title = (i: number) => {
    const h = (head[i] ?? '').trim()
    return hasHeader && (titles || KNOWN_HEADERS.has(h.toLowerCase().replace(/[^a-z0-9]/g, ''))) && h ? h : `Column ${i + 1}`
  }
  return {
    columns: Array.from({ length: width }, (_, i) => ({ index: i, header: title(i) })),
    hasHeader,
    needsMapping: st.result.warnings.some((w) => w.item === 'header' && /No host\/IP column/.test(w.message)),
    mapping: (st.csv?.mapping ?? {}) as NonNullable<SessionImportPlan['csv']>['mapping']
  }
}

/** A row-1 cell that names a secret column (after lowercasing and dropping non-alphanumerics). */
const SECRET_TITLE = /^(?:.*(?:password|passwd|passphrase|secret|token|apikey|community|privatekey).*|pass|pwd|psk|key|enable)$/
export const looksSecretTitle = (cell: string): boolean => SECRET_TITLE.test(cell.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))

/**
 * Mapping in CSV terms (column indexes) from what the renderer sent. The renderer is untrusted and
 * whatever a column is mapped to is shown in it, so a column whose row 1 names a secret is refused
 * outright (whatever "has a header" says), on top of the importer dropping such mappings.
 */
export function csvMapping(m: Record<string, number | undefined>, csvText?: string): CsvMapping {
  const out = Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'number' && v >= 0)) as Record<string, number>
  if (csvText !== undefined) {
    const head = parseCsv(csvText, detectDelimiter(csvText)).find((r) => r.some((c) => c.trim())) ?? []
    for (const [field, col] of Object.entries(out))
      if (field !== 'password' && looksSecretTitle(head[col] ?? '')) throw new Error(`Column ${col + 1} looks like it holds passwords or secrets: it can't be mapped to ${field}`)
  }
  return out as CsvMapping
}
