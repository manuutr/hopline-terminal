import { createHmac, hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redact, REDACT_RULESET_VERSION } from '@hopline/guard'
import { openDb, type DB } from '../src/main/db'
import { AUDIT_REDACTION_SETTING, AuditLog, redactAuditLog, type AuditEntry } from '../src/main/db/audit'
import { DataKey, memoryKeyStore } from '../src/main/vault/datakey'

/** Phase 8 security review M5 / D-M2: the audit log never stores a secret in clear. */

const entry = (command: string, reason = 'ok', over: Partial<AuditEntry> = {}): AuditEntry => ({
  sessionId: null,
  sessionName: 'core-sw1',
  host: '10.0.0.1',
  source: 'snippet',
  command,
  kind: 'config',
  decision: 'executed',
  reason,
  approver: 'user',
  durationMs: 5,
  bytes: 10,
  redactions: 0,
  ...over
})

const rawRows = (db: DB) => db.prepare('SELECT id, command, reason, redactions, command_hmac AS hmac FROM audit ORDER BY id').all() as { id: number; command: string; reason: string; redactions: number | null; hmac: string | null }[]
const triggers = (db: DB) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)

/** A row written the old way (raw INSERT, as `append` did before M5). */
function plantOld(db: DB, command: string, reason = 'ok'): void {
  db.prepare(
    `INSERT INTO audit (ts, session_id, session_name, host, source, command, kind, decision, reason, approver, duration_ms, bytes, redactions)
     VALUES (1, NULL, 'core-sw1', '10.0.0.1', 'snippet', ?, 'config', 'executed', ?, 'user', 1, 1, NULL)`
  ).run(command, reason)
}

describe('M5: AuditLog.append redacts whatever the caller passes', () => {
  it('stores redact(command) and redact(reason), and counts what was removed', () => {
    const audit = new AuditLog(openDb(':memory:'))
    audit.append(entry('snmp-server community N3wC0mm RO', 'device said: % Invalid input near "username ops secret 0 S3cr3t!"', { redactions: 2 }))
    const [row] = audit.list()
    expect(row!.command).toBe('snmp-server community <redacted> RO')
    expect(row!.reason).not.toContain('S3cr3t!')
    expect(row!.reason).toContain('device said')
    expect(row!.redactions).toBe(4)
  })
  it('the D-M1 corpus never reaches the table in clear', () => {
    const db = openDb(':memory:')
    const audit = new AuditLog(db)
    const lines: [string, string][] = [
      ['username ops secret 0 S3cr3t!', 'S3cr3t!'],
      ['  pre-shared-key address 203.0.113.5 key Kr1ngPsk', 'Kr1ngPsk'],
      ['tacacs-server host 10.1.1.2 key TacKey99', 'TacKey99'],
      [' standby 1 authentication HsrpTxt1', 'HsrpTxt1'],
      ['copy running-config ftp://admin:FtpUrl2@10.0.0.9/', 'FtpUrl2'],
      ['vtp password VtpCfg1', 'VtpCfg1'],
      ['    set key FortiTacPlain', 'FortiTacPlain'],
      ['/user add name=admin password=MtPw1 group=full', 'MtPw1'],
      ['curl -u admin:CurlPw1 https://10.0.0.1/api', 'CurlPw1']
    ]
    for (const [l] of lines) audit.append(entry(l))
    const dump = JSON.stringify(rawRows(db))
    for (const [, secret] of lines) expect(dump).not.toContain(secret)
  })
  it('a command with no secret is stored as given and keeps its redactions value', () => {
    const audit = new AuditLog(openDb(':memory:'))
    audit.append(entry('show ip interface brief', 'ok', { redactions: null }))
    expect(audit.list()[0]).toMatchObject({ command: 'show ip interface brief', reason: 'ok', redactions: null })
  })
})

describe('M5: keyed hash of the original command', () => {
  it('HMAC-SHA256 under an HKDF key from the DEK, once primed; the same command gives the same hash', async () => {
    const key = new DataKey(memoryKeyStore())
    const db = openDb(':memory:')
    const audit = new AuditLog(db, key)
    await audit.prime()
    audit.append(entry('username ops secret 0 S3cr3t!'))
    audit.append(entry('username ops secret 0 S3cr3t!'))
    audit.append(entry('username ops secret 0 Other1'))
    const [a, b, c] = rawRows(db)
    const dek = await key.raw()
    const want = createHmac('sha256', Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), 'hopline:audit-command-hmac:v1', 32))).update('username ops secret 0 S3cr3t!').digest('hex')
    expect(a!.hmac).toBe(want)
    expect(b!.hmac).toBe(want)
    expect(c!.hmac).not.toBe(want)
    // Not a plain hash of the line.
    expect(a!.hmac).not.toBe(createHmac('sha256', '').update('username ops secret 0 S3cr3t!').digest('hex'))
  })
  it('vault locked (or no data key): the row is written, redacted, with a NULL hash', async () => {
    const locked = new DataKey() // master-password mode, not unlocked
    const db = openDb(':memory:')
    const audit = new AuditLog(db, locked)
    await audit.prime()
    audit.append(entry('enable secret Cleartext9'))
    new AuditLog(db).append(entry('enable secret Cleartext9'))
    expect(rawRows(db).map((r) => [r.command, r.hmac])).toEqual([
      ['enable secret <redacted>', null],
      ['enable secret <redacted>', null]
    ])
  })
  it('locking during key derivation leaves the audit key cleared', async () => {
    const key = new DataKey()
    key.setKey(Buffer.alloc(32, 7))
    const audit = new AuditLog(openDb(':memory:'), key)
    const pending = audit.prime()
    key.lock()
    audit.forget()
    await pending
    expect(audit.commandHmac('test')).toBeNull()
  })

  it('lock drops the key, unlock primes it again', async () => {
    const key = new DataKey()
    key.setKey(Buffer.alloc(32, 7))
    const db = openDb(':memory:')
    const audit = new AuditLog(db, key)
    await audit.prime()
    audit.append(entry('x'))
    key.lock()
    audit.forget()
    audit.append(entry('x'))
    key.setKey(Buffer.alloc(32, 7))
    await audit.prime()
    audit.append(entry('x'))
    const [a, b, c] = rawRows(db)
    expect(a!.hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(b!.hmac).toBeNull()
    expect(c!.hmac).toBe(a!.hmac)
  })
})

describe('M5: old rows are redacted on startup, deliberately and once', () => {
  it('a secret planted in an old row is gone; the triggers are back; UPDATE and DELETE still abort', () => {
    const db = openDb(':memory:')
    plantOld(db, 'snmp-server community OldC0mm RO', 'failed near "enable secret OldEn4ble"')
    plantOld(db, 'show version')
    db.prepare('DELETE FROM settings WHERE key = ?').run(AUDIT_REDACTION_SETTING)
    expect(redactAuditLog(db)).toBe(1)
    const rows = rawRows(db)
    expect(JSON.stringify(rows)).not.toMatch(/OldC0mm|OldEn4ble/)
    expect(rows[0]).toMatchObject({ command: 'snmp-server community <redacted> RO', redactions: 2 })
    expect(rows[1]).toMatchObject({ command: 'show version', redactions: null })
    expect(triggers(db)).toEqual(['audit_no_delete', 'audit_no_update'])
    expect(() => db.prepare('UPDATE audit SET command = ? WHERE id = 1').run('x')).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM audit WHERE id = 1').run()).toThrow(/append-only/)
    expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(AUDIT_REDACTION_SETTING) as { value: string }).value).toBe(String(REDACT_RULESET_VERSION))
  })
  it('is idempotent: a second run rewrites nothing, even with the version forgotten', () => {
    const db = openDb(':memory:')
    plantOld(db, 'username ops secret 0 S3cr3t!')
    expect(redactAuditLog(db)).toBe(1)
    const after = rawRows(db)
    expect(redactAuditLog(db)).toBe(0)
    db.prepare('DELETE FROM settings WHERE key = ?').run(AUDIT_REDACTION_SETTING)
    expect(redactAuditLog(db)).toBe(0)
    expect(rawRows(db)).toEqual(after)
    expect(triggers(db)).toEqual(['audit_no_delete', 'audit_no_update'])
  })
  it('runs from openDb on a database file written by an older version', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'hopline-audit-'))
    try {
      const file = join(dir, 'h.db')
      const old = openDb(file)
      plantOld(old, 'tacacs-server host 10.1.1.2 key TacKey99')
      old.prepare('DELETE FROM settings WHERE key = ?').run(AUDIT_REDACTION_SETTING)
      old.close()
      const db = openDb(file)
      expect(rawRows(db)[0]!.command).toBe('tacacs-server host 10.1.1.2 key <redacted>')
      expect(triggers(db)).toEqual(['audit_no_delete', 'audit_no_update'])
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a failure mid-migration rolls back: rows, trigger and version unchanged', () => {
    const db = openDb(':memory:')
    plantOld(db, 'snmp-server community A1 RO')
    plantOld(db, 'snmp-server community B2 RO')
    let calls = 0
    const boom = (s: string) => {
      if (++calls > 3) throw new Error('boom')
      return redact(s)
    }
    const before = rawRows(db)
    expect(() => redactAuditLog(db, { redactFn: boom })).toThrow('boom')
    expect(rawRows(db)).toEqual(before)
    expect(triggers(db)).toEqual(['audit_no_delete', 'audit_no_update'])
    expect(db.prepare('SELECT 1 FROM settings WHERE key = ?').get(AUDIT_REDACTION_SETTING)).toBeUndefined()
    expect(() => db.prepare('UPDATE audit SET command = ? WHERE id = 1').run('x')).toThrow(/append-only/)
  })
  it('an older recorded ruleset version runs it again', () => {
    const db = openDb(':memory:')
    plantOld(db, 'failover key AsaFoKey1')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(AUDIT_REDACTION_SETTING, String(REDACT_RULESET_VERSION - 1))
    expect(redactAuditLog(db)).toBe(1)
    expect(rawRows(db)[0]!.command).toBe('failover key <redacted>')
  })
  it('re-scrubs mixed-case RouterOS community fields in a version 2 log', () => {
    const db = openDb(':memory:')
    plantOld(db, '/snmp community\nadd NAME=example')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(AUDIT_REDACTION_SETTING, '2')
    expect(redactAuditLog(db)).toBe(1)
    expect(rawRows(db)[0]!.command).toBe('/snmp community\nadd NAME=<redacted>')
  })
})
