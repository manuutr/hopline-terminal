import { createHmac, hkdfSync } from 'node:crypto'
import { redact, REDACT_RULESET_VERSION } from '@hopline/guard'
import type { AuditRow } from '@shared/types'
import type { DataKey } from '../vault/datakey'
import type { DB } from '.'

export type AuditEntry = Omit<AuditRow, 'id' | 'ts'> & { sessionId: string | null; ts?: number }

/** HKDF `info` for the command-correlation key. Changing it orphans every stored hash. */
const HMAC_INFO = 'hopline:audit-command-hmac:v1'

/**
 * Append-only audit log of every command the AI attempted, including blocked and refused ones.
 *
 * Phase 8 review M5 / D-M2: the table is unencrypted and rows can never be deleted, so a secret in
 * a command line (a snippet, a send-to-many line, an approved config change) would stay there in
 * clear for ever. `append` therefore stores `redact(command)` and `redact(reason)` (the reason can
 * quote a device error), whoever calls it, and adds the number of secrets removed to `redactions`.
 *
 * For correlation ("was this the same command?") each row also carries `command_hmac`, an
 * HMAC-SHA256 of the original, unredacted command. A plain hash would not do: a short secret line
 * like `enable secret X` is brute-forced from its hash in seconds. The key is derived from the
 * vault's data key (DEK) with HKDF-SHA256 (info `hopline:audit-command-hmac:v1`), so it needs no
 * storage of its own, never leaves main, and an attacker with the database but not the DEK cannot
 * test guesses against it.
 *
 * Decision, locked vault: `append` is synchronous and must never wait for an unlock or fail an
 * audit row, so the derived key is cached in memory while the vault is unlocked (`prime`, called at
 * startup and on every unlock) and dropped on lock (`forget`). A row written while the key is not
 * in memory (vault locked, keychain not loaded yet, or no DataKey at all) gets `command_hmac` NULL;
 * the redacted command is stored either way. Consequences, accepted: hashes only correlate within
 * one DEK (a session-only vault makes a new DEK every run), and rows written before this change, or
 * rewritten by `redactAuditLog`, have a NULL hash because their raw command is gone.
 */
export class AuditLog {
  private hmacKey: Buffer | null = null
  private keyGeneration = 0
  private priming: Promise<void> | null = null

  constructor(
    private readonly db: DB,
    private readonly key?: DataKey
  ) {}

  /** Derive and cache the correlation key if the vault is unlocked. Never throws. */
  prime(): Promise<void> {
    if (this.hmacKey || !this.key?.unlocked) return Promise.resolve()
    const generation = this.keyGeneration
    this.priming ??= (async () => {
      try {
        const dek = await this.key!.raw()
        try {
          if (generation === this.keyGeneration) this.hmacKey = Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), HMAC_INFO, 32))
        } finally {
          dek.fill(0)
        }
      } catch {
        // Locked or the keychain failed: rows keep a NULL hash until the next prime.
      } finally {
        if (generation === this.keyGeneration) this.priming = null
      }
    })()
    return this.priming
  }

  /** Drop the correlation key (vault locked). */
  forget(): void {
    this.keyGeneration++
    this.priming = null
    this.hmacKey?.fill(0)
    this.hmacKey = null
  }

  /** HMAC-SHA256 (hex) of a command under the cached key, or null while it is not in memory. */
  commandHmac(command: string): string | null {
    return this.hmacKey ? createHmac('sha256', this.hmacKey).update(command, 'utf8').digest('hex') : null
  }

  append(e: AuditEntry): void {
    const hmac = this.commandHmac(e.command)
    if (!hmac && this.key?.unlocked) void this.prime()
    const cmd = redact(e.command)
    const reason = redact(e.reason)
    const removed = cmd.count + reason.count
    this.db
      .prepare(
        `INSERT INTO audit (ts, session_id, session_name, host, source, command, kind, decision, reason, approver, duration_ms, bytes, redactions, run_id, lane, command_hmac)
         VALUES (@ts, @sessionId, @sessionName, @host, @source, @command, @kind, @decision, @reason, @approver, @durationMs, @bytes, @redactions, @runId, @lane, @commandHmac)`
      )
      .run({
        ...e,
        command: cmd.text,
        reason: reason.text,
        redactions: removed ? (e.redactions ?? 0) + removed : e.redactions,
        ts: e.ts ?? Date.now(),
        runId: e.runId ?? null,
        lane: e.lane ?? null,
        commandHmac: hmac
      })
  }

  list(limit = 500): AuditRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, session_name AS sessionName, host, source, command, kind, decision, reason, approver,
                duration_ms AS durationMs, bytes, redactions, run_id AS runId, lane
         FROM audit ORDER BY id DESC LIMIT ?`
      )
      .all(Math.min(Math.max(limit, 1), 5000)) as AuditRow[]
  }
}

/** Settings key: the redaction ruleset version the stored audit rows were last redacted with. */
export const AUDIT_REDACTION_SETTING = 'audit_redaction_v'
const UPDATE_TRIGGER = 'audit_no_update'
const UPDATE_TRIGGER_SQL = `CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END`

/**
 * Redact the command and reason of rows written before `append` redacted them (M5), or with an
 * older ruleset. Runs on startup (`openDb`) and does nothing once the stored version is current.
 *
 * The table is append-only: a trigger aborts every UPDATE. This is the one deliberate exception, in
 * a single transaction: drop the UPDATE trigger, rewrite only the rows whose redacted text differs,
 * record the ruleset version, recreate the trigger from its stored SQL. If anything throws, the
 * transaction rolls back and the trigger, the rows and the version are as they were. The DELETE
 * trigger is never touched. Returns the number of rows rewritten.
 */
export function redactAuditLog(db: DB, opts: { redactFn?: typeof redact } = {}): number {
  const red = opts.redactFn ?? redact
  const done = Number((db.prepare('SELECT value FROM settings WHERE key = ?').get(AUDIT_REDACTION_SETTING) as { value: string } | undefined)?.value ?? 0)
  if (done >= REDACT_RULESET_VERSION) return 0
  // An empty log has nothing to rewrite (new rows are redacted by `append`); no version is recorded.
  if (!db.prepare('SELECT 1 FROM audit LIMIT 1').get()) return 0
  return db.transaction(() => {
    const changes: { id: number; command: string; reason: string; n: number }[] = []
    for (const row of db.prepare('SELECT id, command, reason FROM audit').iterate() as Iterable<{ id: number; command: string; reason: string }>) {
      const c = red(row.command)
      const r = red(row.reason)
      if (c.text !== row.command || r.text !== row.reason) changes.push({ id: row.id, command: c.text, reason: r.text, n: c.count + r.count })
    }
    if (changes.length) {
      const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(UPDATE_TRIGGER) as { sql: string } | undefined)?.sql ?? UPDATE_TRIGGER_SQL
      db.exec(`DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER}`)
      const upd = db.prepare('UPDATE audit SET command = ?, reason = ?, redactions = COALESCE(redactions, 0) + ? WHERE id = ?')
      for (const c of changes) upd.run(c.command, c.reason, c.n, c.id)
      db.exec(sql)
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(AUDIT_REDACTION_SETTING, String(REDACT_RULESET_VERSION))
    return changes.length
  })()
}
