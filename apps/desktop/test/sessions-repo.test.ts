import { seedDevelopmentSessions } from '../src/main/lab'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { LAB_NOTE, migrate, MIGRATIONS, openDb } from '../src/main/db'
import { DataKey } from '../src/main/vault/datakey'
import { Repo } from '../src/main/db/repo'
import { EphemeralSessions } from '../src/main/ephemeral'
import { BulkUpdate, SessionInput as SessionInputSchema } from '../src/main/ipc/schemas'
import type { SessionInput } from '@shared/types'

const base: SessionInput = {
  name: 'r1',
  folderId: null,
  host: '10.0.0.1',
  port: 22,
  protocol: 'ssh',
  platform: 'iosxe',
  username: 'admin',
  credentialId: null,
  logToFile: false,
  notes: '',
  options: {}
}

describe('migration 5: session tree columns', () => {
  it('adds tags, color, favorite and last_connected_at with defaults to existing rows', () => {
    const db = new Database(':memory:')
    migrate(db, 4)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    db.prepare(
      `INSERT INTO sessions (id, name, folder_id, host, port, protocol, platform, username, credential_id, log_to_file, notes, created_at, updated_at)
       VALUES ('old', 'old-router', NULL, '10.9.9.9', 22, 'ssh', 'ios', 'cisco', NULL, 0, '', 1, 1)`
    ).run()
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['tags', 'color', 'favorite', 'last_connected_at']))
    const s = new Repo(db).getSession('old')!
    expect(s).toMatchObject({ name: 'old-router', tags: [], color: null, favorite: false, lastConnectedAt: null })
  })

  it('is idempotent on an up-to-date database', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
  })
})

describe('migration: auto-detect', () => {
  it('moves unmodelled platforms to auto, keeps modelled ones, and adds the detected column', () => {
    const db = new Database(':memory:')
    // Up to (not including) the migration that adds the detected column.
    migrate(db, MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN detected')))
    const ins = db.prepare(
      `INSERT INTO sessions (id, name, folder_id, host, port, protocol, platform, username, credential_id, log_to_file, notes, created_at, updated_at)
       VALUES (?, ?, NULL, '10.9.9.9', 22, 'ssh', ?, 'cisco', NULL, 0, '', 1, 1)`
    )
    ins.run('a', 'vyos-box', 'vyos')
    ins.run('b', 'mx', 'junos')
    ins.run('c', 'garbage', '')
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('detected')
    const repo = new Repo(db)
    expect(['a', 'b', 'c'].map((id) => repo.getSession(id)!.platform)).toEqual(['auto', 'junos', 'auto'])
    expect(repo.getSession('a')!.detected).toBeNull()
  })

  it.each([false, true])('migrates seeded lab notes and audit hashes (security preview: %s)', (preview) => {
    const db = new Database(':memory:')
    migrate(db, MIGRATIONS.findIndex((m) => m.includes('npm run sim')))
    const ins = db.prepare(
      `INSERT INTO sessions (id, name, folder_id, host, port, protocol, platform, username, credential_id, log_to_file, notes, created_at, updated_at)
       VALUES (?, ?, NULL, '127.0.0.1', 2201, 'ssh', 'iosxe', 'admin', NULL, 0, ?, 1, 1)`
    )
    ins.run('lab', 'core-sw1', 'Run `npm run sim` first.')
    ins.run('mine', 'edge-r1', 'Run `npm run sim` first. Then check the uplink.')
    if (preview) {
      db.exec('ALTER TABLE audit ADD COLUMN command_hmac TEXT')
      db.pragma(`user_version = ${MIGRATIONS.findIndex((m) => m.includes('npm run sim')) + 1}`)
    }
    migrate(db)
    expect(db.prepare("SELECT name FROM pragma_table_info('audit') WHERE name = 'command_hmac'").all()).toHaveLength(1)
    const repo = new Repo(db)
    expect(repo.getSession('lab')!.notes).toBe(LAB_NOTE)
    expect(repo.getSession('mine')!.notes).toBe('Run `npm run sim` first. Then check the uplink.')
  })

  it('a first-run seed writes the current lab note', async () => {
    const repo = new Repo(openDb(':memory:'))
    await seedDevelopmentSessions(repo)
    expect(repo.listSessions().map((s) => s.notes)).toEqual(Array(3).fill(LAB_NOTE))
  })

  it('a detection is stored only on an Auto-detect session; changing the platform clears it, save-as keeps it', () => {
    const repo = new Repo(openDb(':memory:'))
    const d = { version: '17.9', confidence: 0.95, at: 1 }
    const auto = repo.saveSession({ ...base, name: 'a', platform: 'auto' })
    expect(repo.setDetectedPlatform(auto.id, 'iosxe', d)).toMatchObject({ platform: 'iosxe', detected: d })
    // Not auto any more: a second detection does not overwrite the platform.
    expect(repo.setDetectedPlatform(auto.id, 'eos', d)).toMatchObject({ platform: 'iosxe' })
    // A save with the same platform keeps it; a different one (dialog or bulk edit) clears it.
    expect(repo.saveSession({ ...base, id: auto.id, name: 'a2', platform: 'iosxe' }).detected).toEqual(d)
    expect(repo.saveSession({ ...base, id: auto.id, name: 'a2', platform: 'ios' }).detected).toBeNull()
    repo.keepDetection(auto.id, d)
    repo.bulkUpdate([auto.id], { platform: 'nxos' })
    expect(repo.getSession(auto.id)!.detected).toBeNull()
  })
})

describe('Repo: tree fields', () => {
  it('saves tags normalized, and keeps tree fields an update leaves out', () => {
    const repo = new Repo(openDb(':memory:'))
    const s = repo.saveSession({ ...base, tags: ['Core', 'core', ' prod '], color: 'blue', favorite: true })
    expect(s).toMatchObject({ tags: ['core', 'prod'], color: 'blue', favorite: true })
    // The session dialog saves without tree fields: they stay.
    const u = repo.saveSession({ ...base, id: s.id, name: 'r1-renamed' })
    expect(u).toMatchObject({ name: 'r1-renamed', tags: ['core', 'prod'], color: 'blue', favorite: true })
    // An explicit null clears the color.
    expect(repo.saveSession({ ...base, id: s.id, color: null }).color).toBeNull()
  })

  it('records the last connect time', () => {
    const repo = new Repo(openDb(':memory:'))
    const s = repo.saveSession(base)
    repo.touchConnected(s.id, 1234)
    expect(repo.getSession(s.id)!.lastConnectedAt).toBe(1234)
    repo.touchConnected('quick-unknown', 5)
  })

  it('bulk-updates only the fields in the patch, in one go', () => {
    const repo = new Repo(openDb(':memory:'))
    const f = repo.saveFolder({ name: 'DC1', parentId: null })
    const a = repo.saveSession({ ...base, name: 'a', tags: ['core', 'old'] })
    const b = repo.saveSession({ ...base, name: 'b', platform: 'eos', username: 'ops' })
    const out = repo.bulkUpdate([a.id, b.id], { folderId: f.id, addTags: ['dc1'], removeTags: ['old'], username: 'netops' })
    expect(out.map((s) => [s.folderId, s.tags, s.username, s.platform])).toEqual([
      [f.id, ['core', 'dc1'], 'netops', 'iosxe'],
      [f.id, ['dc1'], 'netops', 'eos']
    ])
    expect(() => repo.bulkUpdate([a.id], { folderId: 'nope' })).toThrow(/unknown folder/)
    expect(() => repo.bulkUpdate([a.id], { credentialId: 'nope' })).toThrow(/unknown credential/)
  })

  it('moves sessions and folders together, refusing a folder into its own subtree', () => {
    const repo = new Repo(openDb(':memory:'))
    const top = repo.saveFolder({ name: 'top', parentId: null })
    const sub = repo.saveFolder({ name: 'sub', parentId: top.id })
    const other = repo.saveFolder({ name: 'other', parentId: null })
    const s = repo.saveSession(base)
    repo.moveMany({ sessionIds: [s.id], folderIds: [top.id] }, other.id)
    expect(repo.getSession(s.id)!.folderId).toBe(other.id)
    expect(repo.listFolders().find((f) => f.id === top.id)!.parentId).toBe(other.id)
    expect(() => repo.moveMany({ sessionIds: [s.id], folderIds: [top.id] }, sub.id)).toThrow(/into itself/)
    // All or nothing: the session did not move either.
    expect(repo.getSession(s.id)!.folderId).toBe(other.id)
    expect(() => repo.saveFolder({ id: top.id, name: 'top', parentId: sub.id })).toThrow(/into itself/)
  })
})

describe('IPC schemas for the tree', () => {
  it('rejects bad tags, colors and unknown patch keys', () => {
    expect(() => SessionInputSchema.parse({ ...base, tags: ['has space'] })).toThrow()
    expect(() => SessionInputSchema.parse({ ...base, color: 'magenta' })).toThrow()
    expect(SessionInputSchema.parse({ ...base, lastConnectedAt: 9 })).not.toHaveProperty('lastConnectedAt')
    expect(() => BulkUpdate.parse({ ids: ['a'], patch: { host: 'x' } })).toThrow()
    expect(() => BulkUpdate.parse({ ids: [], patch: {} })).toThrow()
    expect(BulkUpdate.parse({ ids: ['a'], patch: { credentialId: null } }).patch).toEqual({ credentialId: null })
  })
})

describe('EphemeralSessions', () => {
  it('creates unsaved records and prunes only ones no tab uses', () => {
    const inUse = new Set<string>()
    const reg = new EphemeralSessions((id) => inUse.has(id))
    const first = reg.create(base)
    expect(first.id.startsWith('quick-')).toBe(true)
    expect(first).toMatchObject({ ephemeral: true, tags: [], favorite: false })
    inUse.add(first.id)
    for (let i = 0; i < 150; i++) reg.create(base)
    expect(reg.get(first.id)).toBeDefined()
    expect(reg.size).toBeLessThanOrEqual(101)
  })
})

describe('bulk password replacement', () => {
  it('commits only the requested password fields and leaves all profiles intact on an invalid target', async () => {
    const db = openDb(':memory:')
    const key = new DataKey()
    key.setKey(Buffer.alloc(32, 5))
    const repo = new Repo(db, key)
    const profiles = await Promise.all(['edge', 'leaf', 'other'].map((name) => repo.saveCredential({ name, username: 'op', kind: 'password', secret: 'fixture-before' })))
    const [edge, leaf, other] = profiles.map((p) => p.id) as [string, string, string]
    const agent = await repo.saveCredential({ name: 'agent', username: 'u', kind: 'agent' })
    const saved = async (id: string) => (await repo.resolveCredential(id))?.secret
    await expect(repo.replacePasswords([edge, agent.id], 'fixture-new')).rejects.toThrow(/password profile/)
    expect(await saved(edge)).toBe('fixture-before')
    expect(await repo.replacePasswords([edge, edge, leaf], 'fixture-new')).toBe(2)
    expect(await Promise.all([edge, leaf, other].map(saved))).toEqual(['fixture-new', 'fixture-new', 'fixture-before'])
    const rows = db.prepare("SELECT hex(secret_enc) AS ciphertext FROM credentials WHERE name IN ('edge','leaf')").all() as { ciphertext: string }[]
    expect(new Set(rows.map((r) => r.ciphertext)).size).toBe(2)
    expect(JSON.stringify(repo.listCredentials())).not.toContain('fixture-new')
    db.close()
  })
})
