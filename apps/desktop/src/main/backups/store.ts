import { createHash, createHmac, randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'
import { DEFAULT_RETENTION, type BackupRetention, type BackupSchedule, type BackupScheduleInput, type BackupTrigger, type BackupVersion } from '@shared/backups'
import { normalizeConfig } from '@shared/config-text'
import type { DB } from '../db'
import type { AuditLog } from '../db/audit'
import { isLocked, type DataKey } from '../vault/datakey'

const DAY = 24 * 60 * 60 * 1000
const RETENTION_KEY = 'backup_retention'

export const Retention = z.object({ keepLast: z.number().int().min(1).max(10_000), maxAgeDays: z.number().int().min(0).max(36_500) }).strict()

type Row = {
  id: string
  session_id: string
  session_name: string
  platform: string
  ts: number
  digest: string
  size: number
  lines: number
  trigger: BackupTrigger
  command: string
  hostname: string | null
}

/** Settings key set once every row uses the v2 AAD: from then on a v1 row is refused, not decrypted. */
const AAD_V2_DONE = 'backup_aad_v2_done'

/** The AAD of a version's ciphertext: v2 binds the session id and the version id (a row moved to another session no longer decrypts). */
export const backupAad = (v: 1 | 2, sessionId: string, id: string): string => (v === 2 ? `backup:v2:${sessionId}:${id}` : `backup:${id}`)

const toVersion = (r: Row): BackupVersion => ({
  id: r.id,
  sessionId: r.session_id,
  sessionName: r.session_name,
  platform: r.platform,
  ts: r.ts,
  size: r.size,
  lines: r.lines,
  trigger: r.trigger,
  command: r.command
})

type ScheduleRow = {
  id: string
  kind: 'folder' | 'tag'
  target: string
  cadence: 'daily' | 'weekly'
  weekday: number
  time: string
  enabled: number
  created_at: number
  last_run_at: number | null
  last_summary: string | null
}
const toSchedule = (r: ScheduleRow): BackupSchedule => ({
  id: r.id,
  kind: r.kind,
  target: r.target,
  cadence: r.cadence,
  weekday: r.weekday,
  time: r.time,
  enabled: !!r.enabled,
  createdAt: r.created_at,
  lastRunAt: r.last_run_at,
  lastSummary: r.last_summary
})

/**
 * Config history, encrypted at rest: AES-256-GCM under the vault's data key with the AAD bound to
 * the session and the row (`backup:v2:<session id>:<id>`; older rows used `backup:<id>` and are
 * re-encrypted by `migrateAad`). Versions are deduplicated by a keyed digest of the noise-normalised text,
 * so neither timestamps nor a guessable plain hash sit in the database.
 */
export class BackupStore {
  private hmacKey: Buffer | null = null

  constructor(
    private readonly db: DB,
    private readonly key: DataKey,
    private readonly now: () => number = Date.now,
    /** Re-encryptions of old-format rows found after the migration are audited (review B5). */
    private readonly audit?: Pick<AuditLog, 'append'>
  ) {}

  private async digest(text: string): Promise<string> {
    if (!this.hmacKey) this.hmacKey = createHash('sha256').update('hopline:backup-digest:v1').update(await this.key.raw()).digest()
    return createHmac('sha256', this.hmacKey).update(normalizeConfig(text)).digest('hex')
  }

  /** Drop the derived digest key (vault locked). */
  forget(): void {
    this.hmacKey?.fill(0)
    this.hmacKey = null
  }

  /**
   * Store a capture unless it equals the session's newest version (after the noise filter).
   * Throws VaultLockedError while the vault is locked.
   */
  async add(v: { sessionId: string; sessionName: string; platform: string; text: string; trigger: BackupTrigger; command: string; hostname?: string }): Promise<{ version: BackupVersion; unchanged: boolean }> {
    const digest = await this.digest(v.text)
    const newest = this.db.prepare('SELECT * FROM config_backups WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(v.sessionId) as Row | undefined
    // Unchanged only against a newest version that still decrypts (review B4): one that does not
    // (damaged, or not readable any more) must not stop a readable copy from being stored.
    if (newest && newest.digest === digest && (await this.readable(newest.id))) {
      // A version from before hostnames were recorded learns the one it was just seen with.
      if (!newest.hostname && v.hostname?.trim()) this.db.prepare('UPDATE config_backups SET hostname = ? WHERE id = ?').run(v.hostname.trim(), newest.id)
      return { version: toVersion(newest), unchanged: true }
    }
    const id = randomUUID()
    const enc = await this.key.encrypt(gzipSync(Buffer.from(v.text, 'utf8')), backupAad(2, v.sessionId, id))
    const row: Row = {
      id,
      session_id: v.sessionId,
      session_name: v.sessionName,
      platform: v.platform,
      ts: this.now(),
      digest,
      size: Buffer.byteLength(v.text),
      lines: v.text.split('\n').length,
      trigger: v.trigger,
      command: v.command,
      hostname: v.hostname?.trim() || null
    }
    this.db
      .prepare(
        `INSERT INTO config_backups (id, session_id, session_name, platform, ts, digest, size, lines, trigger, command, hostname, aad_v, content_enc)
         VALUES (@id, @session_id, @session_name, @platform, @ts, @digest, @size, @lines, @trigger, @command, @hostname, 2, @enc)`
      )
      .run({ ...row, enc })
    this.prune(v.sessionId)
    return { version: toVersion(row), unchanged: false }
  }

  list(sessionId?: string, limit = 500): BackupVersion[] {
    const rows = sessionId
      ? this.db.prepare('SELECT * FROM config_backups WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(sessionId, limit)
      : this.db.prepare('SELECT * FROM config_backups ORDER BY ts DESC, rowid DESC LIMIT ?').all(limit)
    return (rows as Row[]).map(toVersion)
  }

  meta(id: string): BackupVersion | undefined {
    const r = this.db.prepare('SELECT * FROM config_backups WHERE id = ?').get(id) as Row | undefined
    return r && toVersion(r)
  }

  /**
   * The prompt hostname of the session's newest version that recorded one, or null (no versions
   * yet, or only versions from before hostnames were recorded).
   */
  lastHostname(sessionId: string): string | null {
    const r = this.db.prepare("SELECT hostname FROM config_backups WHERE session_id = ? AND hostname IS NOT NULL AND hostname <> '' ORDER BY ts DESC, rowid DESC LIMIT 1").get(sessionId) as { hostname: string } | undefined
    return r?.hostname ?? null
  }

  /**
   * The stored (unredacted) text. Main only. A v1 row is re-encrypted under the v2 AAD on the way
   * (review B4: also one written after the sweep, by an older Hopline after a downgrade; that late
   * migration is audited, B5). A failed re-encryption never fails the read (B6).
   */
  async text(id: string): Promise<string> {
    const r = this.db.prepare('SELECT session_id, session_name, aad_v, content_enc FROM config_backups WHERE id = ?').get(id) as
      | { session_id: string; session_name: string; aad_v: number; content_enc: Buffer }
      | undefined
    if (!r) throw new Error('No such backup version')
    if (r.aad_v !== 2) {
      const plain = await this.key.decrypt(r.content_enc, backupAad(1, r.session_id, id))
      try {
        if (await this.reseal(id, r.session_id, plain)) this.lateMigration(id, r.session_id, r.session_name)
      } catch (e) {
        if (!isLocked(e)) console.error('[hopline] backup re-encryption:', e)
      }
      return gunzipSync(plain).toString('utf8')
    }
    return gunzipSync(await this.key.decrypt(r.content_enc, backupAad(2, r.session_id, id))).toString('utf8')
  }

  /** The version decrypts (a locked vault still throws). */
  private async readable(id: string): Promise<boolean> {
    try {
      await this.text(id)
      return true
    } catch (e) {
      if (isLocked(e)) throw e
      return false
    }
  }

  private aadV2Done(): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(AAD_V2_DONE)
  }

  /** Re-encrypt one v1 row under the v2 AAD; true when this call moved it. */
  private async reseal(id: string, sessionId: string, plain: Buffer): Promise<boolean> {
    const enc = await this.key.encrypt(plain, backupAad(2, sessionId, id))
    return this.db.prepare('UPDATE config_backups SET content_enc = ?, aad_v = 2 WHERE id = ? AND aad_v = 1').run(enc, id).changes > 0
  }

  /**
   * A v1 row re-encrypted after every row had been migrated once: it was written later (an older
   * Hopline after a downgrade) or put there by someone with write access to the database. It is
   * bound to the session it sits in now, which is recorded (review B5).
   */
  private lateMigration(id: string, sessionId: string, sessionName: string): void {
    if (!this.aadV2Done()) return
    this.audit?.append({
      sessionId,
      sessionName,
      host: '',
      source: 'backup',
      command: `re-encrypt config version ${id.slice(0, 8)}`,
      kind: 'migration',
      decision: 'executed',
      reason: 'a version without a session binding (old format) appeared after the migration; it was bound to the session it is stored under now',
      approver: null,
      durationMs: null,
      bytes: null,
      redactions: null
    })
  }

  /**
   * Re-encrypt every v1 row (AAD `backup:<id>`) under the v2 AAD that also binds the session.
   * Needs the unlocked data key; a row that does not decrypt is left as it is (and counted). Once
   * no v1 row is left, v1 decryption is switched off for good. Returns how many rows moved.
   */
  async migrateAad(): Promise<{ migrated: number; failed: number }> {
    const rows = this.db.prepare('SELECT id, session_id, session_name, content_enc FROM config_backups WHERE aad_v = 1').all() as { id: string; session_id: string; session_name: string; content_enc: Buffer }[]
    let migrated = 0
    let failed = 0
    for (const r of rows) {
      try {
        if (await this.reseal(r.id, r.session_id, await this.key.decrypt(r.content_enc, backupAad(1, r.session_id, r.id)))) this.lateMigration(r.id, r.session_id, r.session_name)
        migrated++
      } catch (e) {
        if (isLocked(e)) throw e
        failed++
      }
    }
    if (!failed) this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(AAD_V2_DONE, '1')
    return { migrated, failed }
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM config_backups WHERE id = ?').run(id)
  }

  // ---------------------------------------------------------------- retention

  retention(): BackupRetention {
    const raw = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(RETENTION_KEY) as { value: string } | undefined
    if (!raw) return DEFAULT_RETENTION
    const p = Retention.safeParse(JSON.parse(raw.value))
    return p.success ? p.data : DEFAULT_RETENTION
  }

  setRetention(r: BackupRetention): BackupRetention {
    const v = Retention.parse(r)
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RETENTION_KEY, JSON.stringify(v))
    for (const { session_id } of this.db.prepare('SELECT DISTINCT session_id FROM config_backups').all() as { session_id: string }[]) this.prune(session_id)
    return v
  }

  /** Apply retention to one session. The newest version is always kept. Returns how many went. */
  prune(sessionId: string): number {
    const { keepLast, maxAgeDays } = this.retention()
    const ids = (this.db.prepare('SELECT id, ts FROM config_backups WHERE session_id = ? ORDER BY ts DESC, rowid DESC').all(sessionId) as { id: string; ts: number }[])
    const cutoff = maxAgeDays > 0 ? this.now() - maxAgeDays * DAY : -Infinity
    const drop = ids.filter((r, i) => i > 0 && (i >= keepLast || r.ts < cutoff)).map((r) => r.id)
    const del = this.db.prepare('DELETE FROM config_backups WHERE id = ?')
    this.db.transaction(() => drop.forEach((id) => del.run(id)))()
    return drop.length
  }

  // ---------------------------------------------------------------- schedules

  schedules(): BackupSchedule[] {
    return (this.db.prepare('SELECT * FROM backup_schedules ORDER BY created_at').all() as ScheduleRow[]).map(toSchedule)
  }

  saveSchedule(s: BackupScheduleInput): BackupSchedule {
    const existing = s.id ? (this.db.prepare('SELECT * FROM backup_schedules WHERE id = ?').get(s.id) as ScheduleRow | undefined) : undefined
    if (s.id && !existing) throw new Error('No such schedule')
    const id = existing?.id ?? randomUUID()
    const row = {
      id,
      kind: s.kind,
      target: s.target,
      cadence: s.cadence,
      weekday: s.weekday,
      time: s.time,
      enabled: s.enabled ? 1 : 0,
      // Changing when it runs starts it afresh: a time moved into the past runs next time, not now.
      created_at: existing && existing.time === s.time && existing.cadence === s.cadence && existing.weekday === s.weekday ? existing.created_at : this.now(),
      last_run_at: existing?.last_run_at ?? null,
      last_summary: existing?.last_summary ?? null
    }
    this.db
      .prepare(
        `INSERT INTO backup_schedules (id, kind, target, cadence, weekday, time, enabled, created_at, last_run_at, last_summary)
         VALUES (@id, @kind, @target, @cadence, @weekday, @time, @enabled, @created_at, @last_run_at, @last_summary)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, target = excluded.target, cadence = excluded.cadence, weekday = excluded.weekday,
           time = excluded.time, enabled = excluded.enabled, created_at = excluded.created_at`
      )
      .run(row)
    return toSchedule(row)
  }

  removeSchedule(id: string): void {
    this.db.prepare('DELETE FROM backup_schedules WHERE id = ?').run(id)
  }

  markRun(id: string, at: number, summary: string): void {
    this.db.prepare('UPDATE backup_schedules SET last_run_at = ?, last_summary = ? WHERE id = ?').run(at, summary, id)
  }
}
