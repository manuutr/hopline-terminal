import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { VaultLockedError } from '../src/main/vault/datakey'
import { DEFAULT_SCRYPT, unwrapKey, wrapKey, WrongPasswordError, checkParams } from '../src/main/vault/kdf'
import { Vault, type Keychain } from '../src/main/vault/vault'
import { ScrollbackStore } from '../src/main/store/scrollback'

/** Fast scrypt for tests (the real default is exercised once below). */
const FAST = { N: 2 ** 10, r: 8, p: 1 }
const dir = mkdtempSync(join(tmpdir(), 'vault-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function settingsMap() {
  const m = new Map<string, string>()
  return { m, getSetting: (k: string) => m.get(k), setSetting: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)) }
}

/** XOR "keychain" so tests can see the DEK is never stored in clear. */
function fakeKeychain(available = true): Keychain & { up: boolean } {
  const k = {
    up: available,
    backend: () => 'fake',
    available: async () => k.up,
    seal: async (p: Buffer) => Buffer.from(p.map((x) => x ^ 0x5a)),
    unseal: async (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a))
  }
  return k
}

describe('scrypt key wrapping', () => {
  it('wraps and unwraps the data key; a wrong password is detected by the verifier', async () => {
    const dek = Buffer.alloc(32, 7)
    const w = await wrapKey(dek, 'correct horse', FAST)
    expect(w.params).toEqual(FAST)
    expect(JSON.stringify(w)).not.toContain(dek.toString('base64'))
    expect(await unwrapKey(w, 'correct horse')).toEqual(dek)
    await expect(unwrapKey(w, 'wrong horse')).rejects.toBeInstanceOf(WrongPasswordError)
    // Password right, record damaged: not reported as a wrong password.
    const bad = { ...w, wrapped: Buffer.from(Buffer.from(w.wrapped, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64') }
    await expect(unwrapKey(bad, 'correct horse')).rejects.toThrow(/damaged/)
  })

  it('uses N=2^17, r=8, p=1 by default and rejects hostile parameters', async () => {
    expect(DEFAULT_SCRYPT).toEqual({ N: 2 ** 17, r: 8, p: 1 })
    const t = Date.now()
    const w = await wrapKey(Buffer.alloc(32, 1), 'pw-default-params')
    expect(await unwrapKey(w, 'pw-default-params')).toEqual(Buffer.alloc(32, 1))
    expect(Date.now() - t).toBeLessThan(10_000)
    expect(() => checkParams({ N: 2 ** 24, r: 8, p: 1 })).toThrow()
    expect(() => checkParams({ N: 1000, r: 8, p: 1 })).toThrow()
    await expect(unwrapKey({ ...w, params: { N: 2 ** 30, r: 64, p: 9 } }, 'x')).rejects.toThrow(/parameters/)
  })
})

describe('Vault modes', () => {
  it('keychain mode: creates the DEK once, sealed, and reuses it after a restart', async () => {
    const s = settingsMap()
    const kc = fakeKeychain()
    const v = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await v.init()
    expect(v.info()).toMatchObject({ mode: 'keychain', locked: false, chosen: true, persistent: true })
    const blob = await v.key.encrypt(Buffer.from('secret'), 'a')
    const v2 = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await v2.init()
    expect((await v2.key.decrypt(blob, 'a')).toString()).toBe('secret')
  })

  it('master mode: locked at start, unlock with the password, wrong password refused, lock drops the key', async () => {
    const s = settingsMap()
    const kc = fakeKeychain()
    const v = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await v.init()
    const blob = await v.key.encrypt(Buffer.from('device-pw'), 'cred')
    // Keychain → master: the same DEK is re-wrapped, so existing blobs survive.
    await v.setMode('master', { password: 'hunter2-long' })
    expect(s.m.has('data_key_sealed')).toBe(false)
    expect(s.m.has('data_key_master')).toBe(true)

    const r = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await r.init()
    expect(r.info()).toMatchObject({ mode: 'master', locked: true })
    await expect(r.key.decrypt(blob, 'cred')).rejects.toBeInstanceOf(VaultLockedError)
    await expect(r.unlock('nope-nope')).rejects.toBeInstanceOf(WrongPasswordError)
    expect(r.info().locked).toBe(true)
    await r.unlock('hunter2-long')
    expect((await r.key.decrypt(blob, 'cred')).toString()).toBe('device-pw')
    r.lock()
    expect(r.info().locked).toBe(true)
    await expect(r.key.encrypt(Buffer.from('x'), 'y')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('change password re-wraps without losing data, and needs the current password', async () => {
    const s = settingsMap()
    const v = new Vault({ settings: s, keychain: fakeKeychain(false), kdf: FAST })
    await v.init()
    expect(v.info()).toMatchObject({ mode: 'session', chosen: false, persistent: false })
    await v.setMode('master', { password: 'first-password' })
    const blob = await v.key.encrypt(Buffer.from('kept'), 'k')
    await expect(v.changePassword('not-it-at-all', 'second-password')).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(v.changePassword('first-password', 'short')).rejects.toThrow(/at least/)
    await v.changePassword('first-password', 'second-password')
    const r = new Vault({ settings: s, keychain: fakeKeychain(false), kdf: FAST })
    await r.init()
    await expect(r.unlock('first-password')).rejects.toBeInstanceOf(WrongPasswordError)
    await r.unlock('second-password')
    expect((await r.key.decrypt(blob, 'k')).toString()).toBe('kept')
  })

  it('Restore history works with a master password and no OS keychain: the saved scrollback survives a restart', async () => {
    const s = settingsMap()
    const sb = mkdtempSync(join(dir, 'sb-'))
    const v = new Vault({ settings: s, keychain: fakeKeychain(false), kdf: FAST })
    await v.init()
    await v.setMode('master', { password: 'history-password' })
    // What scrollback:save checks before it writes (ipc/index.ts persistentStorage).
    expect(v.info()).toMatchObject({ mode: 'master', persistent: true, locked: false })
    await new ScrollbackStore(sb, v.key).save('sess-1', 'core-sw1#show clock')
    const r = new Vault({ settings: s, keychain: fakeKeychain(false), kdf: FAST })
    await r.init()
    await r.unlock('history-password')
    expect((await new ScrollbackStore(sb, r.key).load('sess-1'))?.data).toContain('core-sw1#show clock')
  })

  it('master → keychain and → session re-wrap; session mode never persists the key', async () => {
    const s = settingsMap()
    const kc = fakeKeychain()
    const v = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await v.init()
    await v.setMode('master', { password: 'master-password' })
    const blob = await v.key.encrypt(Buffer.from('x1'), 'a')
    v.lock()
    await expect(v.setMode('keychain')).rejects.toThrow(/current master password/)
    await v.setMode('keychain', { current: 'master-password' })
    expect(s.m.has('data_key_master')).toBe(false)
    const r = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await r.init()
    expect((await r.key.decrypt(blob, 'a')).toString()).toBe('x1')

    let ephemeral = 0
    await r.setMode('session')
    expect([...s.m.keys()].filter((k) => k.startsWith('data_key'))).toEqual([])
    const again = new Vault({ settings: s, keychain: kc, kdf: FAST })
    again.on('ephemeral', () => ephemeral++)
    await again.init()
    expect(again.info()).toMatchObject({ mode: 'session', chosen: true, locked: false })
    expect(ephemeral).toBe(1)
    await expect(again.key.decrypt(blob, 'a')).rejects.toThrow()
  })

  it('a keychain that stops answering keeps everything and never wipes', async () => {
    const s = settingsMap()
    const kc = fakeKeychain()
    const v = new Vault({ settings: s, keychain: kc, kdf: FAST })
    await v.init()
    kc.up = false
    const r = new Vault({ settings: s, keychain: kc, kdf: FAST })
    let ephemeral = 0
    r.on('ephemeral', () => ephemeral++)
    await r.init()
    expect(r.info()).toMatchObject({ mode: 'keychain', locked: true, keychainBroken: true })
    expect(ephemeral).toBe(0)
    expect(s.m.has('data_key_sealed')).toBe(true)
  })

  it('auto-locks after N idle minutes; activity pushes the deadline back', async () => {
    let now = 0
    const s = settingsMap()
    const v = new Vault({ settings: s, keychain: fakeKeychain(false), kdf: FAST, now: () => now })
    await v.init()
    await v.setMode('master', { password: 'idle-password' })
    await v.setAutoLock(5, { current: 'idle-password' })
    now = 4 * 60_000
    v.tick()
    expect(v.info().locked).toBe(false)
    v.touch()
    now = 8 * 60_000
    v.tick()
    expect(v.info().locked).toBe(false)
    now = 9 * 60_000 + 1
    v.tick()
    expect(v.info().locked).toBe(true)
    // 0 disables it.
    await v.unlock('idle-password')
    await v.setAutoLock(0, { current: 'idle-password' })
    now = 1e12
    v.tick()
    expect(v.info().locked).toBe(false)
  })
})

describe('credentials at rest', () => {
  it('upgrading a v4 database keeps every session linked to its profile and migrates legacy secrets', async () => {
    const file = join(dir, 'v4.db')
    const raw = new Database(file)
    for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m)
    raw.pragma('user_version = 4')
    raw.pragma('foreign_keys = ON')
    // A pre-DEK row: "sealed" by the OS keychain (XOR here).
    const legacySeal = (t: string) => Buffer.from(Buffer.from(t).map((x) => x ^ 0x33))
    raw.prepare(`INSERT INTO credentials (id, name, username, kind, secret_enc) VALUES ('c1', 'Lab', 'admin', 'password', ?)`).run(legacySeal('legacy-pw'))
    raw.prepare(`INSERT INTO sessions (id, name, host, port, protocol, platform, credential_id, created_at, updated_at) VALUES ('s1', 'sw1', '10.0.0.1', 22, 'ssh', 'iosxe', 'c1', 0, 0)`).run()
    raw.close()

    const db = openDb(file)
    expect(db.prepare(`SELECT credential_id FROM sessions WHERE id = 's1'`).get()).toEqual({ credential_id: 'c1' })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    const v = new Vault({ settings: settingsMap(), keychain: fakeKeychain(), kdf: FAST })
    await v.init()
    const repo = new Repo(db, v.key, async (b) => Buffer.from(b.map((x) => x ^ 0x33)).toString())
    expect(repo.legacySecretCount()).toBe(1)
    // Legacy rows still resolve before the migration runs.
    expect((await repo.resolveCredential('c1'))?.secret).toBe('legacy-pw')
    expect(await repo.migrateLegacySecrets()).toBe(1)
    expect(repo.legacySecretCount()).toBe(0)
    const row = db.prepare(`SELECT scheme, secret_enc FROM credentials WHERE id = 'c1'`).get() as { scheme: string; secret_enc: Buffer }
    expect(row.scheme).toBe('dek')
    expect(row.secret_enc.includes(Buffer.from('legacy-pw'))).toBe(false)
    expect((await repo.resolveCredential('c1'))?.secret).toBe('legacy-pw')
    expect(repo.listCredentials()[0]).toMatchObject({ id: 'c1', usedBy: 1, hasSecret: true })
    db.close()
  })

  it('a failed legacy migration leaves every row untouched', async () => {
    const db = openDb(join(dir, 'fail.db'))
    db.prepare(`INSERT INTO credentials (id, name, username, kind, secret_enc, scheme) VALUES ('a', 'A', 'u', 'password', x'01', 'os'), ('b', 'B', 'u', 'password', x'02', 'os')`).run()
    const v = new Vault({ settings: settingsMap(), keychain: fakeKeychain(), kdf: FAST })
    await v.init()
    const repo = new Repo(db, v.key, async (b) => (b[0] === 1 ? 'ok' : undefined))
    await expect(repo.migrateLegacySecrets()).rejects.toThrow()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM credentials WHERE scheme = 'os'`).get()).toEqual({ n: 2 })
    db.close()
  })

  it('secrets are encrypted under the DEK, bound to their row, and unreadable while locked', async () => {
    const db = openDb(join(dir, 'locked.db'))
    const s = settingsMap()
    const v = new Vault({ settings: s, keychain: fakeKeychain(false), kdf: FAST })
    await v.init()
    await v.setMode('master', { password: 'locked-password' })
    const repo = new Repo(db, v.key)
    const c = await repo.saveCredential({ name: 'P', username: 'admin', kind: 'password', secret: 'pw-123' })
    const blob = (db.prepare('SELECT secret_enc FROM credentials WHERE id = ?').get(c.id) as { secret_enc: Buffer }).secret_enc
    expect(blob.includes(Buffer.from('pw-123'))).toBe(false)
    // Copying a blob onto another row doesn't decrypt (AAD binds it to its id and field).
    const d = await repo.saveCredential({ name: 'Q', username: 'admin', kind: 'password' })
    db.prepare('UPDATE credentials SET secret_enc = ? WHERE id = ?').run(blob, d.id)
    await expect(repo.resolveCredential(d.id)).rejects.toThrow()
    v.lock()
    await expect(repo.resolveCredential(c.id)).rejects.toBeInstanceOf(VaultLockedError)
    await v.unlock('locked-password')
    expect((await repo.resolveCredential(c.id))?.secret).toBe('pw-123')
    db.close()
  })

  it('kinds: agent/prompt store no secret; changing kind never reuses the old secret', async () => {
    const db = openDb(join(dir, 'kinds.db'))
    const v = new Vault({ settings: settingsMap(), keychain: fakeKeychain(), kdf: FAST })
    await v.init()
    const repo = new Repo(db, v.key)
    const c = await repo.saveCredential({ name: 'X', username: 'u', kind: 'password', secret: 'pw' })
    expect((await repo.saveCredential({ id: c.id, name: 'X', username: 'u', kind: 'agent', secret: 'ignored' })).hasSecret).toBe(false)
    expect((await repo.saveCredential({ id: c.id, name: 'X', username: 'u', kind: 'password' })).hasSecret).toBe(false)
    const p = await repo.saveCredential({ name: 'Ask', username: 'u', kind: 'prompt' })
    expect(await repo.resolveCredential(p.id)).toEqual({ username: 'u', kind: 'prompt', secret: undefined, passphrase: undefined })
    // Omitting the secret keeps it; '' removes it.
    await repo.saveCredential({ id: c.id, name: 'X', username: 'u', kind: 'password', secret: 'pw2' })
    expect((await repo.saveCredential({ id: c.id, name: 'Renamed', username: 'u', kind: 'password' })).hasSecret).toBe(true)
    expect((await repo.resolveCredential(c.id))?.secret).toBe('pw2')
    expect((await repo.saveCredential({ id: c.id, name: 'Renamed', username: 'u', kind: 'password', secret: '' })).hasSecret).toBe(false)
    db.close()
  })

  it('session-only start drops secrets written under the lost key', async () => {
    const db = openDb(join(dir, 'eph.db'))
    const v = new Vault({ settings: settingsMap(), keychain: fakeKeychain(false), kdf: FAST })
    await v.init()
    const repo = new Repo(db, v.key)
    await repo.saveCredential({ name: 'E', username: 'u', kind: 'password', secret: 'pw' })
    db.prepare(`INSERT INTO credentials (id, name, username, kind, secret_enc, scheme) VALUES ('legacy', 'L', 'u', 'password', x'01', 'os')`).run()
    expect(repo.dropEphemeralSecrets()).toBe(1)
    // Legacy (keychain-sealed) rows are never dropped this way.
    expect(repo.listCredentials().map((c) => [c.name, c.hasSecret])).toEqual([
      ['E', false],
      ['L', true]
    ])
    db.close()
  })
})
