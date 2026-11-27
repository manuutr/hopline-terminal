import { randomUUID } from 'node:crypto'
import { SESSION_COLORS, type CredentialInfo, type CredentialKind, type Folder, type KnownHost, type Platform, type PlatformDetection, type Session, type SessionColor, type SessionInput, type SessionPatch } from '@shared/types'
import { inspectKey, type KeyInspection } from '../vault/keys'
import type { DB } from '.'

/** Encrypts secrets at rest: the vault's data key (AES-256-GCM). */
export interface SecretCipher {
  encrypt(plain: Buffer, aad: string): Promise<Buffer>
  decrypt(blob: Buffer, aad: string): Promise<Buffer>
}

/** What main stores for a profile. `secret`/`passphrase`: undefined keeps, '' or null removes. */
export interface CredentialSave {
  id?: string
  name: string
  username: string
  kind: CredentialKind
  secret?: string | null
  passphrase?: string | null
  /** Key profiles: already inspected (main read the file). Inspected here when omitted. */
  key?: KeyInspection
}

/** Main-process only. Never expose through IPC. */
export interface ResolvedCredential {
  username: string
  kind: CredentialKind
  secret?: string
  passphrase?: string
}

/** A credential as export writes it (main only): metadata plus, when asked for, the secrets. */
export type ExportedCredential = CredentialInfo & { secret?: string; passphrase?: string }

interface CredRow {
  id: string
  name: string
  username: string
  kind: CredentialKind
  secret_enc: Buffer | null
  passphrase_enc: Buffer | null
  scheme: 'os' | 'dek'
  key_type: string | null
  key_fingerprint: string | null
  key_encrypted: number
}

const aad = (id: string, field: 'secret' | 'passphrase') => `cred:${id}:${field}`

export type TombstoneType = 'session' | 'folder' | 'credential'
/** A deletion, kept so folder sync can carry it to other machines (pruned after 90 days). */
export interface Tombstone {
  type: TombstoneType
  id: string
  deletedAt: number
}

/** The only shape credentials leave this class in (besides resolveCredential): no secret fields. */
const toInfo = (r: CredRow, usedBy: number): CredentialInfo => ({
  id: r.id,
  name: r.name,
  username: r.username,
  kind: r.kind,
  hasSecret: !!r.secret_enc,
  hasPassphrase: !!r.passphrase_enc,
  keyType: r.key_type,
  keyFingerprint: r.key_fingerprint,
  keyEncrypted: !!r.key_encrypted,
  usedBy
})

interface SessionRow {
  id: string
  name: string
  folder_id: string | null
  host: string
  port: number
  protocol: Session['protocol']
  platform: Session['platform']
  username: string
  credential_id: string | null
  log_to_file: number
  notes: string
  options: string
  tags: string
  color: string | null
  favorite: number
  last_connected_at: number | null
  detected: string | null
}

function parseDetected(raw: string | null): PlatformDetection | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as PlatformDetection
    return v && typeof v === 'object' && typeof v.confidence === 'number' ? v : null
  } catch {
    return null
  }
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  name: r.name,
  folderId: r.folder_id,
  host: r.host,
  port: r.port,
  protocol: r.protocol,
  platform: r.platform,
  username: r.username,
  credentialId: r.credential_id,
  logToFile: !!r.log_to_file,
  notes: r.notes,
  options: parseOptions(r.options),
  tags: parseTags(r.tags),
  color: (SESSION_COLORS as readonly string[]).includes(r.color ?? '') ? (r.color as SessionColor) : null,
  favorite: !!r.favorite,
  lastConnectedAt: r.last_connected_at,
  detected: parseDetected(r.detected)
})

/** Lowercase, trimmed, unique, in first-seen order. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    const v = t.trim().toLowerCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

function parseTags(raw: string): string[] {
  try {
    const t = JSON.parse(raw) as unknown
    return Array.isArray(t) ? normalizeTags(t.filter((x): x is string => typeof x === 'string')) : []
  } catch {
    return []
  }
}

function parseOptions(raw: string): Session['options'] {
  try {
    const o = JSON.parse(raw) as unknown
    return o && typeof o === 'object' ? (o as Session['options']) : {}
  } catch {
    return {}
  }
}

export class Repo {
  /** Called after any change to sessions, folders, credentials, known hosts or preferences (folder sync). */
  onChange: (() => void) | null = null

  constructor(
    private readonly db: DB,
    private readonly cipher?: SecretCipher,
    /** Reads pre-DEK rows that were sealed directly by safeStorage. */
    private readonly legacyUnseal?: (blob: Buffer) => Promise<string | undefined>
  ) {}

  private changed(): void {
    this.onChange?.()
  }

  /** Run `fn` in one transaction with change notifications held back, then notify once. */
  batch<T>(fn: () => T): T {
    const prev = this.onChange
    let hit = false
    this.onChange = () => void (hit = true)
    try {
      return this.db.transaction(fn)()
    } finally {
      this.onChange = prev
      if (hit) this.changed()
    }
  }

  // ---------------------------------------------------------------- sessions
  listFolders(): Folder[] {
    return this.db
      .prepare('SELECT id, name, parent_id AS parentId, sort FROM folders ORDER BY sort, name')
      .all() as Folder[]
  }

  listSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY name COLLATE NOCASE').all() as SessionRow[]).map(toSession)
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r && toSession(r)
  }

  /** `opts.updatedAt`: import keeps the time the item was last changed on the machine that wrote it. */
  saveSession(s: SessionInput, opts: { updatedAt?: number } = {}): Session {
    const now = opts.updatedAt ?? Date.now()
    const id = s.id ?? randomUUID()
    // Tree fields left out keep what is stored: the session dialog and older callers don't send them.
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, folder_id, host, port, protocol, platform, username, credential_id, log_to_file, notes, options, tags, color, favorite, created_at, updated_at)
         VALUES (@id, @name, @folderId, @host, @port, @protocol, @platform, @username, @credentialId, @logToFile, @notes, @options,
           COALESCE(@tags, '[]'), @color, COALESCE(@favorite, 0), @now, @now)
         ON CONFLICT(id) DO UPDATE SET name=@name, folder_id=@folderId, host=@host, port=@port, protocol=@protocol,
           detected=CASE WHEN platform = @platform THEN detected ELSE NULL END, platform=@platform, username=@username, credential_id=@credentialId, log_to_file=@logToFile, notes=@notes, options=@options,
           tags=COALESCE(@tags, tags), color=CASE WHEN @colorSet THEN @color ELSE color END, favorite=COALESCE(@favorite, favorite), updated_at=@now`
      )
      .run({
        id,
        name: s.name,
        folderId: s.folderId,
        host: s.host,
        port: s.port,
        protocol: s.protocol,
        platform: s.platform,
        username: s.username,
        credentialId: s.credentialId,
        logToFile: s.logToFile ? 1 : 0,
        notes: s.notes,
        options: JSON.stringify(s.options ?? {}),
        tags: s.tags ? JSON.stringify(normalizeTags(s.tags)) : null,
        colorSet: s.color !== undefined ? 1 : 0,
        color: s.color ?? null,
        favorite: s.favorite === undefined ? null : s.favorite ? 1 : 0,
        now
      })
    this.untomb('session', id)
    this.changed()
    return this.getSession(id)!
  }

  removeSession(id: string): void {
    this.removeSessions([id])
  }

  /** Delete sessions in one transaction, leaving a tombstone for each (folder sync). */
  removeSessions(ids: string[]): void {
    const del = this.db.prepare('DELETE FROM sessions WHERE id = ?')
    this.db.transaction(() => {
      const now = Date.now()
      for (const id of ids) if (del.run(id).changes) this.tomb('session', id, now)
    })()
    this.changed()
  }

  /** Multi-delete from the tree: sessions and folders, all in one transaction. */
  removeMany(items: { sessionIds: string[]; folderIds: string[] }): void {
    const prev = this.onChange
    this.onChange = null
    try {
      this.db.transaction(() => {
        this.removeSessions(items.sessionIds)
        for (const id of items.folderIds) this.removeFolder(id)
      })()
    } finally {
      this.onChange = prev
    }
    this.changed()
  }

  moveSession(id: string, folderId: string | null): void {
    this.db.prepare('UPDATE sessions SET folder_id = ?, updated_at = ? WHERE id = ?').run(folderId, Date.now(), id)
    this.changed()
  }

  /**
   * True when `folderId` is `ancestorId` or sits somewhere below it, at any depth. A chain that loops
   * (a cycle already in the data) also counts as "within": never build on top of one.
   */
  private isWithin(folderId: string | null, ancestorId: string): boolean {
    const parent = this.db.prepare('SELECT parent_id AS p FROM folders WHERE id = ?')
    const seen = new Set<string>()
    for (let id = folderId; id; id = (parent.get(id) as { p: string | null } | undefined)?.p ?? null) {
      if (id === ancestorId || seen.has(id)) return true
      seen.add(id)
    }
    return false
  }

  /**
   * Defense in depth (run at startup and after imports): any folder cycle is cut by moving the
   * folder that closes it to the top level. Returns how many were moved.
   */
  repairFolderCycles(): number {
    const parent = new Map(this.listFolders().map((f) => [f.id, f.parentId]))
    const done = new Set<string>()
    const cut: string[] = []
    for (const start of parent.keys()) {
      const path = new Set<string>()
      for (let id: string | null = start; id && !done.has(id); ) {
        path.add(id)
        const next: string | null = parent.get(id) ?? null
        if (next && path.has(next)) {
          cut.push(id)
          parent.set(id, null)
          break
        }
        id = next && parent.has(next) ? next : null
      }
      for (const id of path) done.add(id)
    }
    if (!cut.length) return 0
    const upd = this.db.prepare('UPDATE folders SET parent_id = NULL, updated_at = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const id of cut) upd.run(Date.now(), id)
    })()
    this.changed()
    return cut.length
  }

  /** Drag and drop: move sessions and folders into `folderId` (null: top level), all or nothing. */
  moveMany(items: { sessionIds: string[]; folderIds: string[] }, folderId: string | null): void {
    this.db.transaction(() => {
      if (folderId !== null && !this.db.prepare('SELECT 1 FROM folders WHERE id = ?').get(folderId)) throw new Error('unknown folder')
      for (const f of items.folderIds) {
        if (this.isWithin(folderId, f)) throw new Error('A folder cannot move into itself')
      }
      const now = Date.now()
      const ms = this.db.prepare('UPDATE sessions SET folder_id = ?, updated_at = ? WHERE id = ?')
      for (const id of items.sessionIds) ms.run(folderId, now, id)
      const mf = this.db.prepare('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?')
      for (const id of items.folderIds) mf.run(folderId, now, id)
    })()
    this.changed()
  }

  /** Bulk edit: apply `patch` to every session in `ids` in one transaction. */
  bulkUpdate(ids: string[], patch: SessionPatch): Session[] {
    const out = this.db.transaction(() => {
      if (patch.folderId && !this.db.prepare('SELECT 1 FROM folders WHERE id = ?').get(patch.folderId)) throw new Error('unknown folder')
      if (patch.credentialId && !this.db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(patch.credentialId)) throw new Error('unknown credential')
      const now = Date.now()
      const add = normalizeTags(patch.addTags ?? [])
      const remove = new Set(normalizeTags(patch.removeTags ?? []))
      const update = this.db.prepare(
        `UPDATE sessions SET folder_id=@folderId, detected=CASE WHEN platform = @platform THEN detected ELSE NULL END, platform=@platform, username=@username, credential_id=@credentialId,
           color=@color, favorite=@favorite, tags=@tags, updated_at=@now WHERE id=@id`
      )
      const out: Session[] = []
      for (const id of ids) {
        const cur = this.getSession(id)
        if (!cur) continue
        const tags = patch.addTags || patch.removeTags ? normalizeTags([...cur.tags, ...add]).filter((t) => !remove.has(t)) : cur.tags
        update.run({
          id,
          folderId: patch.folderId !== undefined ? patch.folderId : cur.folderId,
          platform: patch.platform ?? cur.platform,
          username: patch.username ?? cur.username,
          credentialId: patch.credentialId !== undefined ? patch.credentialId : cur.credentialId,
          color: patch.color !== undefined ? patch.color : cur.color,
          favorite: (patch.favorite ?? cur.favorite) ? 1 : 0,
          tags: JSON.stringify(tags),
          now
        })
        out.push(this.getSession(id)!)
      }
      return out
    })()
    this.changed()
    return out
  }

  /** A tab for this session connected: it becomes the most recent. Unknown ids (quick connect) are ignored. */
  /** Auto-detect identified the device: store the platform and what was learned (main only). */
  setDetectedPlatform(id: string, platform: Platform, detection: PlatformDetection): Session | undefined {
    this.db.prepare("UPDATE sessions SET platform = ?, detected = ?, updated_at = ? WHERE id = ? AND platform = 'auto'").run(platform, JSON.stringify(detection), Date.now(), id)
    return this.getSession(id)
  }

  /** Keep what auto-detect learned when a quick-connect session is saved (main only). */
  keepDetection(id: string, detection: PlatformDetection): void {
    this.db.prepare('UPDATE sessions SET detected = ? WHERE id = ?').run(JSON.stringify(detection), id)
  }

  touchConnected(id: string, at = Date.now()): void {
    this.db.prepare('UPDATE sessions SET last_connected_at = ? WHERE id = ?').run(at, id)
  }

  saveFolder(f: { id?: string; name: string; parentId: string | null }): Folder {
    const id = f.id ?? randomUUID()
    if (f.id && this.isWithin(f.parentId, f.id)) throw new Error('A folder cannot move into itself')
    this.db
      .prepare(
        `INSERT INTO folders (id, name, parent_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, updated_at = excluded.updated_at`
      )
      .run(id, f.name, f.parentId, Date.now())
    this.untomb('folder', id)
    this.changed()
    return this.db.prepare('SELECT id, name, parent_id AS parentId, sort FROM folders WHERE id = ?').get(id) as Folder
  }

  removeFolder(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET folder_id = (SELECT parent_id FROM folders WHERE id = ?) WHERE folder_id = ?').run(id, id)
      this.db.prepare('UPDATE folders SET parent_id = (SELECT parent_id FROM folders WHERE id = ?) WHERE parent_id = ?').run(id, id)
      if (this.db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes) this.tomb('folder', id, Date.now())
    })()
    this.changed()
  }

  // ---------------------------------------------------------------- credentials
  listCredentials(): CredentialInfo[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM sessions s WHERE s.credential_id = c.id) AS used_by
         FROM credentials c ORDER BY c.name COLLATE NOCASE`
      )
      .all() as (CredRow & { used_by: number })[]
    return rows.map((r) => toInfo(r, r.used_by))
  }

  getCredential(id: string): CredentialInfo | undefined {
    return this.listCredentials().find((c) => c.id === id)
  }

  private cipherOrThrow(): SecretCipher {
    if (!this.cipher) throw new Error('No vault: secrets cannot be stored')
    return this.cipher
  }

  private enc(id: string, v: string, field: 'secret' | 'passphrase'): Promise<Buffer> {
    return this.cipherOrThrow().encrypt(Buffer.from(v, 'utf8'), aad(id, field))
  }

  async saveCredential(c: CredentialSave): Promise<CredentialInfo> {
    const id = c.id ?? randomUUID()
    const old = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredRow | undefined
    // A secret never changes meaning: a stored password is not reused as a key, or the reverse.
    const same = !!old && old.kind === c.kind
    let secret: Buffer | null = null
    let passphrase: Buffer | null = null
    let key: KeyInspection | null = null
    if (c.kind === 'password' || c.kind === 'key') {
      // Everything is encrypted before the row is written. A legacy ('os') row that is edited moves
      // to the data key as a whole, so one row never mixes schemes.
      const legacy = same && old.scheme === 'os' ? await this.resolveCredential(id) : undefined
      const carry = async (field: 'secret' | 'passphrase', col: 'secret_enc' | 'passphrase_enc'): Promise<Buffer | null> => {
        if (!same || !old[col]) return null
        if (old.scheme === 'dek') return old[col]
        const v = legacy?.[field]
        return v === undefined ? null : this.enc(id, v, field)
      }
      secret = c.secret === undefined ? await carry('secret', 'secret_enc') : c.secret ? await this.enc(id, c.secret, 'secret') : null
      if (c.kind === 'key') {
        passphrase = c.passphrase === undefined ? await carry('passphrase', 'passphrase_enc') : c.passphrase ? await this.enc(id, c.passphrase, 'passphrase') : null
        if (c.secret) key = c.key ?? inspectKey(c.secret, c.passphrase ?? undefined)
        else if (secret && old?.key_type) key = { format: 'openssh', keyType: old.key_type, fingerprint: old.key_fingerprint, encrypted: !!old.key_encrypted, comment: '' }
        // A new passphrase for a stored key: check it while we can still say so.
        if (!c.secret && c.passphrase && secret) {
          const stored = (await this.cipherOrThrow().decrypt(secret, aad(id, 'secret'))).toString('utf8')
          key = inspectKey(stored, c.passphrase)
        }
      }
    }
    this.db
      .prepare(
        `INSERT INTO credentials (id, name, username, kind, secret_enc, passphrase_enc, scheme, key_type, key_fingerprint, key_encrypted, updated_at)
         VALUES (@id, @name, @username, @kind, @secret, @passphrase, 'dek', @keyType, @fingerprint, @encrypted, @now)
         ON CONFLICT(id) DO UPDATE SET name=@name, username=@username, kind=@kind, secret_enc=@secret, passphrase_enc=@passphrase,
           scheme='dek', key_type=@keyType, key_fingerprint=@fingerprint, key_encrypted=@encrypted, updated_at=@now`
      )
      .run({
        id,
        name: c.name,
        username: c.username,
        kind: c.kind,
        secret,
        passphrase,
        keyType: key?.keyType ?? null,
        fingerprint: key?.fingerprint ?? null,
        encrypted: key?.encrypted ? 1 : 0,
        now: Date.now()
      })
    this.untomb('credential', id)
    this.changed()
    return this.getCredential(id)!
  }

  /** Replace only saved password fields, or leave every selected profile untouched. */
  async replacePasswords(ids: string[], password: string): Promise<number> {
    const unique = [...new Set(ids)]
    if (!password.length || !unique.length || unique.length > 200) throw new Error('Select up to 200 password profiles and enter a password')
    const select = this.db.prepare("SELECT secret_enc FROM credentials WHERE id = ? AND kind = 'password'")
    const rows = unique.map((id) => {
      const row = select.get(id) as { secret_enc: Buffer | null } | undefined
      if (!row) throw new Error('A selected profile is no longer a password profile. Refresh and try again.')
      return { id, old: row.secret_enc }
    })
    const encrypted = await Promise.all(rows.map((row) => this.enc(row.id, password, 'secret')))
    const update = this.db.prepare("UPDATE credentials SET secret_enc = ?, passphrase_enc = NULL, scheme = 'dek', updated_at = ? WHERE id = ? AND kind = 'password' AND secret_enc IS ?")
    const now = Date.now()
    this.db.transaction(() => {
      rows.forEach(({ id, old }, i) => {
        if (update.run(encrypted[i], now, id, old).changes !== 1) throw new Error('A selected profile changed. Refresh and try again.')
      })
    })()
    this.changed()
    return rows.length
  }

  removeCredential(id: string): void {
    this.db.transaction(() => {
      if (this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes) this.tomb('credential', id, Date.now())
    })()
    this.changed()
  }

  /**
   * Main-process only. Never expose through IPC.
   * Throws VaultLockedError while a master-password vault is locked.
   */
  async resolveCredential(id: string): Promise<ResolvedCredential | undefined> {
    const r = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredRow | undefined
    if (!r) return undefined
    const open = async (blob: Buffer | null, field: 'secret' | 'passphrase'): Promise<string | undefined> => {
      if (!blob) return undefined
      if (r.scheme === 'os') return this.legacyUnseal?.(blob)
      return (await this.cipherOrThrow().decrypt(blob, aad(id, field))).toString('utf8')
    }
    return { username: r.username, kind: r.kind, secret: await open(r.secret_enc, 'secret'), passphrase: await open(r.passphrase_enc, 'passphrase') }
  }

  /** Rows still sealed directly by safeStorage (before the DEK scheme). */
  legacySecretCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM credentials WHERE scheme = 'os' AND (secret_enc IS NOT NULL OR passphrase_enc IS NOT NULL)`).get() as { n: number }).n
  }

  /**
   * Pre-DEK rows were sealed one by one with safeStorage. Re-encrypt them under the data key:
   * decrypt everything first, then write all rows in one transaction. Any failure leaves every
   * legacy row untouched (it is retried on the next start). Returns the number of rows moved.
   */
  async migrateLegacySecrets(): Promise<number> {
    const rows = this.db.prepare(`SELECT * FROM credentials WHERE scheme = 'os'`).all() as CredRow[]
    if (!rows.length) return 0
    const out: { id: string; secret: Buffer | null; passphrase: Buffer | null; key: KeyInspection | null }[] = []
    for (const r of rows) {
      const c = await this.resolveCredential(r.id)
      if ((r.secret_enc && c?.secret === undefined) || (r.passphrase_enc && c?.passphrase === undefined)) throw new Error('a legacy secret could not be decrypted')
      let key: KeyInspection | null = null
      if (r.kind === 'key' && c?.secret) {
        try {
          key = inspectKey(c.secret, c.passphrase)
        } catch {
          /* metadata only */
        }
      }
      out.push({
        id: r.id,
        secret: c?.secret === undefined ? null : await this.enc(r.id, c.secret, 'secret'),
        passphrase: c?.passphrase === undefined ? null : await this.enc(r.id, c.passphrase, 'passphrase'),
        key
      })
    }
    const upd = this.db.prepare(
      `UPDATE credentials SET secret_enc = ?, passphrase_enc = ?, scheme = 'dek',
         key_type = COALESCE(?, key_type), key_fingerprint = COALESCE(?, key_fingerprint), key_encrypted = COALESCE(?, key_encrypted)
       WHERE id = ? AND scheme = 'os'`
    )
    this.db.transaction(() => {
      for (const o of out) upd.run(o.secret, o.passphrase, o.key?.keyType ?? null, o.key?.fingerprint ?? null, o.key ? (o.key.encrypted ? 1 : 0) : null, o.id)
    })()
    return out.length
  }

  /** Session-only vault start: secrets written last run are under a key that no longer exists. */
  dropEphemeralSecrets(): number {
    return this.db
      .prepare(`UPDATE credentials SET secret_enc = NULL, passphrase_enc = NULL WHERE scheme = 'dek' AND (secret_enc IS NOT NULL OR passphrase_enc IS NOT NULL)`)
      .run().changes
  }

  /** Credentials for an export file (main only). Secrets are decrypted only when asked for. */
  async exportCredentials(withSecrets: boolean): Promise<ExportedCredential[]> {
    const out: ExportedCredential[] = []
    for (const info of this.listCredentials()) {
      if (!withSecrets) {
        out.push(info)
        continue
      }
      const c = await this.resolveCredential(info.id)
      out.push({ ...info, ...(c?.secret !== undefined ? { secret: c.secret } : {}), ...(c?.passphrase !== undefined ? { passphrase: c.passphrase } : {}) })
    }
    return out
  }

  /** Raw upsert of an imported, already-encrypted credential row (import runs this inside batch()). */
  putCredentialRow(
    r: { id: string; name: string; username: string; kind: CredentialKind; secret: Buffer | null; passphrase: Buffer | null; keyType: string | null; keyFingerprint: string | null; keyEncrypted: boolean },
    keepSecrets: boolean,
    updatedAt = Date.now()
  ): void {
    this.db
      .prepare(
        `INSERT INTO credentials (id, name, username, kind, secret_enc, passphrase_enc, scheme, key_type, key_fingerprint, key_encrypted, updated_at)
         VALUES (@id, @name, @username, @kind, @secret, @passphrase, 'dek', @keyType, @keyFingerprint, @keyEncrypted, @now)
         ON CONFLICT(id) DO UPDATE SET name=@name, username=@username, kind=@kind,
           secret_enc = CASE WHEN @keep AND @secret IS NULL AND kind = @kind THEN secret_enc ELSE @secret END,
           passphrase_enc = CASE WHEN @keep AND @passphrase IS NULL AND kind = @kind THEN passphrase_enc ELSE @passphrase END,
           scheme = CASE WHEN @keep AND @secret IS NULL AND kind = @kind THEN scheme ELSE 'dek' END,
           key_type=@keyType, key_fingerprint=@keyFingerprint, key_encrypted=@keyEncrypted, updated_at=@now`
      )
      .run({ ...r, keyEncrypted: r.keyEncrypted ? 1 : 0, keep: keepSecrets ? 1 : 0, now: updatedAt })
    this.untomb('credential', r.id)
    this.changed()
  }

  /** Encrypt a secret for `putCredentialRow` (before the import transaction opens). */
  encryptFor(id: string, field: 'secret' | 'passphrase', v: string | undefined): Promise<Buffer | null> {
    return v ? this.enc(id, v, field) : Promise.resolve(null)
  }

  /** Replace-mode import: everything the export file describes is dropped first (audit is untouched). */
  clearForReplace(): void {
    // Tombstones too: after a replace, the file's are the only ones (applyPayload puts them back).
    this.db.exec('DELETE FROM sessions; DELETE FROM folders; DELETE FROM credentials; DELETE FROM host_keys; DELETE FROM tombstones;')
    this.changed()
  }

  /** Insert or update a folder keeping its id and parent (import). Parents must exist or be null. */
  putFolder(f: Folder, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO folders (id, name, parent_id, sort, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, sort = excluded.sort, updated_at = excluded.updated_at`
      )
      .run(f.id, f.name, f.parentId, f.sort, updatedAt)
    this.untomb('folder', f.id)
    this.changed()
  }

  // ---------------------------------------------------------------- tombstones (folder sync)
  private tomb(type: TombstoneType, id: string, at: number): void {
    this.db
      .prepare('INSERT INTO tombstones (type, id, deleted_at) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)')
      .run(type, id, at)
  }

  private untomb(type: TombstoneType, id: string): void {
    this.db.prepare('DELETE FROM tombstones WHERE type = ? AND id = ?').run(type, id)
  }

  /**
   * Record a deletion learned from another machine (import), keeping the later time; `exact` sets
   * it to `t.deletedAt` (the item was just deleted here on that machine's behalf).
   */
  putTombstone(t: Tombstone, opts: { exact?: boolean } = {}): void {
    if (opts.exact) this.db.prepare('INSERT OR REPLACE INTO tombstones (type, id, deleted_at) VALUES (?, ?, ?)').run(t.type, t.id, t.deletedAt)
    else this.tomb(t.type, t.id, t.deletedAt)
  }

  listTombstones(): Tombstone[] {
    return this.db.prepare('SELECT type, id, deleted_at AS deletedAt FROM tombstones ORDER BY type, id').all() as Tombstone[]
  }

  /** Tombstones older than `before` (ms) are dropped: by then every machine has seen them. */
  pruneTombstones(before: number): number {
    return this.db.prepare('DELETE FROM tombstones WHERE deleted_at < ?').run(before).changes
  }

  /** When each item was last changed (ms), by id: what sync compares tombstones with. */
  updatedAt(type: TombstoneType): Map<string, number> {
    const table = type === 'session' ? 'sessions' : type === 'folder' ? 'folders' : 'credentials'
    return new Map((this.db.prepare(`SELECT id, updated_at AS t FROM ${table}`).all() as { id: string; t: number }[]).map((r) => [r.id, r.t]))
  }

  // ---------------------------------------------------------------- import links (re-sync)
  /** Sessions created or matched from records of `source` (e.g. "netbox:https://nb.example.com"), by record id. */
  importLinks(source: string): { extId: string; sessionId: string }[] {
    return this.db.prepare('SELECT ext_id AS extId, session_id AS sessionId FROM import_links WHERE source = ?').all(source) as { extId: string; sessionId: string }[]
  }

  /** Record that `extId` of `source` is `sessionId` (a session is linked to one record per source). */
  linkImport(source: string, extId: string, sessionId: string): void {
    this.db.prepare('DELETE FROM import_links WHERE source = ? AND session_id = ? AND ext_id <> ?').run(source, sessionId, extId)
    this.db
      .prepare('INSERT INTO import_links (source, ext_id, session_id) VALUES (?, ?, ?) ON CONFLICT(source, ext_id) DO UPDATE SET session_id = excluded.session_id')
      .run(source, extId, sessionId)
  }

  clearImportLinks(source: string): void {
    this.db.prepare('DELETE FROM import_links WHERE source = ?').run(source)
  }

  // ---------------------------------------------------------------- settings (raw)
  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
    if (key === 'prefs') this.changed()
  }

  // ---------------------------------------------------------------- known hosts (TOFU)
  /** Fingerprints trusted for host:port (empty: never seen). */
  hostKeys(host: string, port: number): string[] {
    return (this.db.prepare('SELECT fingerprint FROM host_keys WHERE host = ? AND port = ?').all(host.toLowerCase(), port) as { fingerprint: string }[]).map((r) => r.fingerprint)
  }

  /** Trust one more key for a host (first use, import). */
  addHostKey(host: string, port: number, fingerprint: string, source: 'tofu' | 'import' | 'user' = 'tofu', keyType = ''): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO host_keys (host, port, fingerprint, key_type, source, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(host.toLowerCase(), port, fingerprint, keyType, source, Date.now())
    if (r.changes > 0) this.changed()
    return r.changes > 0
  }

  /** The user approved a changed key: it replaces every key stored for the host. */
  replaceHostKeys(host: string, port: number, fingerprint: string): void {
    this.db.transaction(() => {
      this.removeHostKeys(host, port)
      this.addHostKey(host, port, fingerprint, 'user')
    })()
  }

  removeHostKeys(host: string, port: number): void {
    this.db.prepare('DELETE FROM host_keys WHERE host = ? AND port = ?').run(host.toLowerCase(), port)
    this.changed()
  }

  listHostKeys(): KnownHost[] {
    return this.db
      .prepare('SELECT host, port, fingerprint, key_type AS keyType, source, added_at AS addedAt FROM host_keys ORDER BY host, port')
      .all() as KnownHost[]
  }
}
