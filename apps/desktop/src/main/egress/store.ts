import { gunzipSync, gzipSync } from 'node:zlib'
import type { EgressDetail, EgressQuery, EgressRow, EgressSearch, EgressStats, EgressStatus } from '@shared/egress'
import type { DB } from '../db'
import { isLocked, type DataKey } from '../vault/datakey'

/**
 * "What left this machine": every model request as it was sent, stored locally.
 *
 * - The payload is the request body the provider adapter built (redacted by llm/safe.ts before it
 *   got there), gzipped and encrypted with AES-256-GCM under the vault's data key, the AAD bound to
 *   the row (`egress:v1:<id>`). Headers and the API key are never part of it.
 * - Metadata (provider, model, destination, tokens, time, session, run id) is in the clear, like
 *   the audit log, so the list works while the vault is locked.
 * - Size cap and rotation: at most `maxRows` rows and `maxBytes` of stored payload; the oldest rows
 *   are deleted first. Unlike the audit table, this one is not append-only.
 * - The table is created here (`IF NOT EXISTS`), not in db/index.ts MIGRATIONS: it is owned by this
 *   store alone and never joined, and that keeps the shared migration list free of conflicts.
 */

export const EGRESS_MAX_BYTES = 64 * 1024 * 1024
export const EGRESS_MAX_ROWS = 5_000
/** One request body larger than this is stored cut (the metadata still has its real size). */
export const EGRESS_MAX_PAYLOAD = 4 * 1024 * 1024
const SEARCH_SCAN = 2_000

const aad = (id: number) => `egress:v1:${id}`

type Row = {
  id: number
  ts: number
  provider: string
  model: string
  destination: string
  source: string
  session_name: string | null
  run_id: string | null
  lane: string | null
  input_tokens: number | null
  output_tokens: number | null
  bytes: number
  status: EgressStatus
  payload: Buffer | null
  stored: number
  duration_ms: number | null
  attempts: number | null
}

const toRow = (r: Row): EgressRow => ({
  id: r.id,
  ts: r.ts,
  provider: r.provider,
  model: r.model,
  destination: r.destination,
  source: r.source,
  sessionName: r.session_name,
  runId: r.run_id,
  lane: r.lane,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  bytes: r.bytes,
  status: r.status,
  hasPayload: !!r.payload,
  durationMs: r.duration_ms,
  attempts: r.attempts ?? null
})

export interface EgressRecord {
  provider: string
  model: string
  destination: string
  source: string
  sessionName?: string | null
  runId?: string | null
  lane?: string | null
  /** Bytes that went on the wire, when the body below is only a description of them (crash reports). */
  bytes?: number
  /** The request body exactly as the adapter sends it (serialised here). */
  body: unknown
}

export class EgressLog {
  constructor(
    private readonly db: DB,
    private readonly key: Pick<DataKey, 'encrypt' | 'decrypt'>,
    private readonly limits: { maxBytes?: number; maxRows?: number } = {},
    private readonly now: () => number = Date.now
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS egress_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      destination TEXT NOT NULL,
      source TEXT NOT NULL,
      session_name TEXT,
      run_id TEXT,
      lane TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload BLOB,
      stored INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS egress_ts ON egress_log(ts);`)
    // How many times the request went on the wire (the SDK retries): added after 0.6.0-dev.
    const cols = db.prepare('PRAGMA table_info(egress_log)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'attempts')) db.exec('ALTER TABLE egress_log ADD COLUMN attempts INTEGER')
    // A row still "sending" was left by a crash or a quit mid-request (review L5): whether it left
    // the machine is not known, so it says so instead of "sending" forever.
    db.prepare("UPDATE egress_log SET status = 'unknown' WHERE status = 'sending'").run()
  }

  private get maxBytes() {
    return this.limits.maxBytes ?? EGRESS_MAX_BYTES
  }
  private get maxRows() {
    return this.limits.maxRows ?? EGRESS_MAX_ROWS
  }

  /**
   * Record a request before it is sent. When the payload cannot be encrypted (vault locked) the
   * row is still written, without its payload, and `error` says why: the caller decides whether
   * that stops the request (`requireEgressLog`).
   */
  async record(r: EgressRecord): Promise<{ id: number; error?: Error }> {
    const text = JSON.stringify(r.body)
    const bytes = r.bytes ?? Buffer.byteLength(text)
    const ins = this.db
      .prepare(
        `INSERT INTO egress_log (ts, provider, model, destination, source, session_name, run_id, lane, bytes, status, payload, stored)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', NULL, 0)`
      )
      .run(this.now(), r.provider, r.model.slice(0, 200), r.destination.slice(0, 300), r.source, r.sessionName ?? null, r.runId ?? null, r.lane ?? null, bytes)
    const id = Number(ins.lastInsertRowid)
    const plain = bytes > EGRESS_MAX_PAYLOAD ? JSON.stringify({ truncated: true, bytes, head: text.slice(0, EGRESS_MAX_PAYLOAD) }) : text
    try {
      const enc = await this.key.encrypt(gzipSync(Buffer.from(plain, 'utf8')), aad(id))
      this.db.prepare('UPDATE egress_log SET payload = ?, stored = ? WHERE id = ?').run(enc, enc.length, id)
      return { id }
    } catch (e) {
      return { id, error: e instanceof Error ? e : new Error(String(e)) }
    } finally {
      this.rotate()
    }
  }

  /** After the answer (or the failure): tokens, status and time. */
  finish(id: number, f: { status: EgressStatus; inputTokens?: number; outputTokens?: number; durationMs?: number; attempts?: number }): void {
    this.db
      .prepare('UPDATE egress_log SET status = ?, input_tokens = ?, output_tokens = ?, duration_ms = ?, attempts = ? WHERE id = ?')
      .run(f.status, f.inputTokens ?? null, f.outputTokens ?? null, f.durationMs ?? null, f.attempts ?? null, id)
  }

  private rotate(): void {
    const { n, total } = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stored), 0) AS total FROM egress_log').get() as { n: number; total: number }
    if (n <= this.maxRows && total <= this.maxBytes) return
    let drop = Math.max(0, n - this.maxRows)
    let left = total
    // Drop the oldest until both the row and the byte cap hold (the newest row is always kept).
    const rows = this.db.prepare('SELECT id, stored FROM egress_log ORDER BY id ASC').all() as { id: number; stored: number }[]
    const ids: number[] = []
    for (const r of rows.slice(0, -1)) {
      if (drop <= 0 && left <= this.maxBytes) break
      ids.push(r.id)
      left -= r.stored
      drop--
    }
    const del = this.db.prepare('DELETE FROM egress_log WHERE id = ?')
    this.db.transaction(() => ids.forEach((id) => del.run(id)))()
  }

  list(limit = 500): EgressRow[] {
    return (this.db.prepare('SELECT * FROM egress_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 5000)) as Row[]).map(toRow)
  }

  stats(): EgressStats {
    const { n, total } = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stored), 0) AS total FROM egress_log').get() as { n: number; total: number }
    return { rows: n, bytes: total, maxBytes: this.maxBytes, maxRows: this.maxRows }
  }

  private async payloadOf(r: Row): Promise<string | null> {
    if (!r.payload) return null
    return gunzipSync(await this.key.decrypt(r.payload, aad(r.id))).toString('utf8')
  }

  /** One row with its payload, pretty-printed. Throws VaultLockedError while the vault is locked. */
  async get(id: number): Promise<EgressDetail | null> {
    const r = this.db.prepare('SELECT * FROM egress_log WHERE id = ?').get(id) as Row | undefined
    if (!r) return null
    const p = await this.payloadOf(r)
    return { ...toRow(r), payload: p === null ? null : pretty(p) }
  }

  /**
   * Newest first; with `search`, rows whose payload or metadata contain it (decrypted here, in main).
   * While the vault is locked the payloads cannot be read: the search covers the metadata only and
   * `payloadsSearched` is false, so the window can say "Unlock to search payloads" (review M3).
   */
  async query(q: EgressQuery = {}): Promise<EgressRow[]> {
    return (await this.search(q)).rows
  }

  async search(q: EgressQuery = {}): Promise<EgressSearch> {
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 2000)
    const needle = q.search?.trim().toLowerCase()
    if (!needle) return { rows: this.list(limit), payloadsSearched: true }
    const rows = this.db.prepare('SELECT * FROM egress_log ORDER BY id DESC LIMIT ?').all(SEARCH_SCAN) as Row[]
    const out: EgressRow[] = []
    let payloads = true
    for (const r of rows) {
      const meta = [r.provider, r.model, r.destination, r.source, r.session_name ?? '', r.run_id ?? '', r.lane ?? ''].join(' ').toLowerCase()
      let hit = meta.includes(needle)
      if (!hit && payloads) {
        try {
          hit = ((await this.payloadOf(r)) ?? '').toLowerCase().includes(needle)
        } catch (e) {
          if (!isLocked(e)) throw e
          payloads = false
        }
      }
      if (hit) out.push(toRow(r))
      if (out.length >= limit) break
    }
    return { rows: out, payloadsSearched: payloads }
  }

  /** JSON Lines for an export: metadata plus the payload as sent (parsed back to JSON). */
  async exportLines(ids?: number[]): Promise<string> {
    const rows = ids?.length
      ? (ids.map((id) => this.db.prepare('SELECT * FROM egress_log WHERE id = ?').get(id)).filter(Boolean) as Row[])
      : (this.db.prepare('SELECT * FROM egress_log ORDER BY id ASC').all() as Row[])
    const lines: string[] = []
    for (const r of rows) {
      const p = await this.payloadOf(r)
      let payload: unknown = null
      try {
        payload = p === null ? null : JSON.parse(p)
      } catch {
        payload = p
      }
      lines.push(JSON.stringify({ ...toRow(r), payload }))
    }
    return lines.join('\n') + (lines.length ? '\n' : '')
  }

  /** Session-only vault: rows from the last run are under a key that no longer exists. */
  dropAll(): void {
    this.db.prepare('DELETE FROM egress_log').run()
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
