import { SESSION_PLATFORMS } from '@hopline/guard'
import Database from 'better-sqlite3'
import { redactAuditLog } from './audit'

export type DB = Database.Database

/** The note on the bundled lab's sessions (seeded on first run, or re-created by lab.ts). */
export const LAB_NOTE = 'The bundled simulator lab. Password: admin.'
/** The note seeded before the lab was bundled (0.5 and earlier). */
const OLD_LAB_NOTE = 'Run `npm run sim` first.'

const ADD_AUDIT_HMAC = `ALTER TABLE audit ADD COLUMN command_hmac TEXT;`
const UPDATE_LAB_NOTE = `UPDATE sessions SET notes = '${LAB_NOTE}' WHERE notes = '${OLD_LAB_NOTE}';`

/** Applied in order; `user_version` is the number applied so far. Append only, never edit a shipped entry. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE folders (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
     sort INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE credentials (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     username TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('password','key')),
     secret_enc BLOB,
     passphrase_enc BLOB
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
     host TEXT NOT NULL,
     port INTEGER NOT NULL,
     protocol TEXT NOT NULL,
     platform TEXT NOT NULL,
     username TEXT NOT NULL DEFAULT '',
     credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
     log_to_file INTEGER NOT NULL DEFAULT 0,
     notes TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     session_id TEXT,
     session_name TEXT NOT NULL,
     host TEXT NOT NULL,
     source TEXT NOT NULL,
     command TEXT NOT NULL,
     kind TEXT NOT NULL,
     decision TEXT NOT NULL,
     reason TEXT NOT NULL,
     approver TEXT,
     duration_ms INTEGER,
     bytes INTEGER,
     redactions INTEGER
   );
   CREATE INDEX audit_ts ON audit(ts);
   -- The audit log is append-only.
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;`,
  `CREATE TABLE known_hosts (
     host TEXT NOT NULL,
     port INTEGER NOT NULL,
     fingerprint TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (host, port)
   );`,
  `ALTER TABLE sessions ADD COLUMN options TEXT NOT NULL DEFAULT '{}';`,
  // A host can have several keys (ed25519, rsa, ecdsa): keep each one.
  `CREATE TABLE host_keys (
     host TEXT NOT NULL,
     port INTEGER NOT NULL,
     fingerprint TEXT NOT NULL,
     key_type TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT 'tofu',
     added_at INTEGER NOT NULL,
     PRIMARY KEY (host, port, fingerprint)
   );
   INSERT INTO host_keys (host, port, fingerprint, added_at) SELECT host, port, fingerprint, added_at FROM known_hosts;
   DROP TABLE known_hosts;`,
  // 5: session tree. Tags are a JSON array of lowercase strings; color is a SESSION_COLORS name.
  `ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE sessions ADD COLUMN color TEXT;
   ALTER TABLE sessions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN last_connected_at INTEGER;
   CREATE INDEX sessions_last_connected ON sessions(last_connected_at);`,
  // 6: credential profiles v2: agent and prompt kinds, key metadata, and the encryption scheme of each
  // row ('os' = sealed directly by safeStorage, the pre-DEK format; 'dek' = AES-GCM under the data key).
  // A CHECK can't be altered in SQLite: rebuild the table. Foreign keys are off during migrations, so
  // dropping the old table doesn't null every sessions.credential_id.
  `CREATE TABLE credentials_v2 (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     username TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('password','key','agent','prompt')),
     secret_enc BLOB,
     passphrase_enc BLOB,
     scheme TEXT NOT NULL DEFAULT 'dek' CHECK (scheme IN ('os','dek')),
     key_type TEXT,
     key_fingerprint TEXT,
     key_encrypted INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO credentials_v2 (id, name, username, kind, secret_enc, passphrase_enc, scheme)
     SELECT id, name, username, kind, secret_enc, passphrase_enc, 'os' FROM credentials;
   DROP TABLE credentials;
   ALTER TABLE credentials_v2 RENAME TO credentials;`,
  // 7: which session a record of an import source (a NetBox device id) became, for re-sync. Main only:
  // not part of Session, the export file or the sync hash.
  `CREATE TABLE import_links (
     source TEXT NOT NULL,
     ext_id TEXT NOT NULL,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     PRIMARY KEY (source, ext_id)
   );
   CREATE INDEX import_links_session ON import_links(session_id);`,
  // 8: folder sync. Deletions travel as tombstones so they don't come back from another machine;
  // folders get an updated_at like sessions and credentials, to compare against them.
  `CREATE TABLE tombstones (
     type TEXT NOT NULL CHECK (type IN ('session','folder','credential')),
     id TEXT NOT NULL,
     deleted_at INTEGER NOT NULL,
     PRIMARY KEY (type, id)
   );
   ALTER TABLE folders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;`,
  // Phase 3: what auto-detect learned (JSON), and Auto-detect for any platform the app no longer
  // (or never) modelled, so the guard default-denies it instead of guessing a lookalike.
  `ALTER TABLE sessions ADD COLUMN detected TEXT;
   UPDATE sessions SET platform = 'auto' WHERE platform NOT IN (${SESSION_PLATFORMS.map((p) => `'${p}'`).join(', ')});`,
  // Phase 4: config backups. content_enc is AES-GCM under the data key (AAD `backup:<id>`);
  // digest is an HMAC of the noise-normalised text (dedupe), keyed from the data key.
  `CREATE TABLE config_backups (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     session_name TEXT NOT NULL,
     platform TEXT NOT NULL,
     ts INTEGER NOT NULL,
     digest TEXT NOT NULL,
     size INTEGER NOT NULL,
     lines INTEGER NOT NULL,
     trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
     command TEXT NOT NULL,
     content_enc BLOB NOT NULL
   );
   CREATE INDEX config_backups_session ON config_backups(session_id, ts);
   CREATE TABLE backup_schedules (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('folder','tag')),
     target TEXT NOT NULL,
     cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly')),
     weekday INTEGER NOT NULL DEFAULT 1,
     time TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     last_run_at INTEGER,
     last_summary TEXT
   );`,
  // Phase 4 review: the prompt hostname each version was captured from (a capture from another
  // device is refused, M3), and the AAD scheme of content_enc: 1 = `backup:<id>`, 2 =
  // `backup:v2:<session id>:<id>` (L6; version 1 rows are re-encrypted when the vault is unlocked).
  `ALTER TABLE config_backups ADD COLUMN hostname TEXT;
   ALTER TABLE config_backups ADD COLUMN aad_v INTEGER NOT NULL DEFAULT 1;`,
  // F10 fleet agent: every row of a fleet run is attributable to the run and the lane (device name).
  `ALTER TABLE audit ADD COLUMN run_id TEXT;
   ALTER TABLE audit ADD COLUMN lane TEXT;`,
  // 0.8: the lab is bundled, so the seeded lab sessions' old note ("Run `npm run sim` first.") is
  // wrong. Only that exact note is replaced: a note the user wrote is never touched.
  UPDATE_LAB_NOTE,
  // Phase 8 review M5: commands are stored redacted; this keyed hash (HMAC-SHA256 under a key derived
  // from the data key) of the original line lets rows be correlated without keeping the secret.
  // NULL while the vault is locked and for rows written before this column (see db/audit.ts).
  ADD_AUDIT_HMAC
]

export function openDb(file: string): DB {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  migrate(db)
  // Rows from before the audit log redacted its input (or from an older ruleset): redact them now.
  redactAuditLog(db)
  return db
}

/**
 * Bring the schema up to `target` (default: latest). Each step is its own transaction. Table
 * rebuilds must not fire ON DELETE actions, so foreign keys are enforced only after migrating (the
 * pragma is a no-op inside a transaction, so it is set around the loop).
 */
export function migrate(db: DB, target = MIGRATIONS.length): void {
  db.pragma('foreign_keys = OFF')
  const version = db.pragma('user_version', { simple: true }) as number
  for (let v = version; v < target; v++) {
    db.transaction(() => {
      const step = MIGRATIONS[v]!
      // The security preview used the lab-note migration number for the HMAC column.
      // A profile from that branch still needs the note update at this step.
      if (step === ADD_AUDIT_HMAC && db.prepare("SELECT 1 FROM pragma_table_info('audit') WHERE name = 'command_hmac'").get()) db.exec(UPDATE_LAB_NOTE)
      else db.exec(step)
      const broken = db.pragma('foreign_key_check') as unknown[]
      // Report, don't brick startup over rows that were already dangling before this migration.
      if (broken.length) console.warn(`[hopline] ${broken.length} dangling foreign key(s) after migration ${v + 1}`)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  db.pragma('foreign_keys = ON')
}
