import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { BadPassphraseError, openFile, readHeader, sealFile } from '../src/main/backup/format'
import { FolderSync, SYNC_FILE } from '../src/main/backup/sync'
import { applyPayload, buildPayload, parsePayload, preview } from '../src/main/backup/transfer'
import { Vault } from '../src/main/vault/vault'

const FAST = { N: 2 ** 10, r: 8, p: 1 }
const dir = mkdtempSync(join(tmpdir(), 'backup-'))
const dbs: ReturnType<typeof openDb>[] = []
afterAll(() => {
  // Windows can't delete a file SQLite still holds open (EPERM), so close every profile first.
  for (const db of dbs) db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
let n = 0

/** A fresh profile: database, vault (fake keychain) and repo. */
async function profile() {
  const db = openDb(join(dir, `p${n++}.db`))
  dbs.push(db)
  const m = new Map<string, string>()
  const vault = new Vault({
    settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) },
    keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) },
    kdf: FAST
  })
  await vault.init()
  return { db, vault, repo: new Repo(db, vault.key) }
}

const base = { host: '10.0.0.1', port: 22, protocol: 'ssh' as const, platform: 'iosxe' as const, username: 'admin', logToFile: false, notes: '', options: {} }

async function seeded() {
  const p = await profile()
  const lab = p.repo.saveFolder({ name: 'Lab', parentId: null })
  const core = p.repo.saveFolder({ name: 'Core', parentId: lab.id })
  const cred = await p.repo.saveCredential({ name: 'Lab admin', username: 'admin', kind: 'password', secret: 'CANARY-PASSWORD' })
  const agent = await p.repo.saveCredential({ name: 'Agent', username: 'netops', kind: 'agent' })
  p.repo.saveSession({ ...base, name: 'sw1', folderId: core.id, credentialId: cred.id })
  p.repo.saveSession({ ...base, name: 'sw2', host: '10.0.0.2', folderId: lab.id, credentialId: agent.id, options: { ssh: { legacyAlgorithms: false } } })
  p.repo.addHostKey('10.0.0.1', 22, 'SHA256:aaa', 'tofu', 'ssh-ed25519')
  p.repo.setSetting('prefs', JSON.stringify({ termFontSize: 15, logDir: '/home/me/logs', aiModel: 'claude-x' }))
  return { ...p, cred, agent, lab, core }
}

describe('.hopline export format', () => {
  it('round-trips folders, sessions, profiles, settings and known hosts into a fresh profile', async () => {
    const a = await seeded()
    const file = await sealFile(await buildPayload(a.repo, true), 'export-passphrase', FAST)
    // Plaintext never appears in the file.
    expect(file.includes(Buffer.from('CANARY-PASSWORD'))).toBe(false)
    expect(file.includes(Buffer.from('sw1'))).toBe(false)
    const { header } = readHeader(file)
    expect(header).toMatchObject({ format: 'hopline-export', version: 1, kdf: { name: 'scrypt', ...FAST } })

    const b = await profile()
    const payload = parsePayload((await openFile(file, 'export-passphrase')).payload)
    const pv = preview(b.repo, payload, { token: 't', file: 'f', createdAt: 0 })
    expect(pv.counts).toEqual({ folders: 2, sessions: 2, credentials: 2, secrets: 1, knownHosts: 1, settings: true })
    await applyPayload(b.repo, payload, 'merge')

    expect(b.repo.listFolders()).toEqual(a.repo.listFolders())
    expect(b.repo.listSessions()).toEqual(a.repo.listSessions())
    expect(b.repo.listCredentials()).toEqual(a.repo.listCredentials())
    expect((await b.repo.resolveCredential(a.cred.id))?.secret).toBe('CANARY-PASSWORD')
    // Every host in the file is new here: its keys are withheld (asked on first connect, #2).
    expect(pv.hostKeysWithheld).toBe(1)
    expect(b.repo.hostKeys('10.0.0.1', 22)).toEqual([])
    // Only appearance preferences travel (#2): the log folder and the AI model stay behind.
    expect(JSON.parse(b.repo.getSetting('prefs')!)).toEqual({ termFontSize: 15 })
  })

  it('detects a wrong passphrase and any tampering, header included', async () => {
    const a = await seeded()
    const file = await sealFile(await buildPayload(a.repo, false), 'export-passphrase', FAST)
    await expect(openFile(file, 'not-the-passphrase')).rejects.toBeInstanceOf(BadPassphraseError)
    const body = Buffer.from(file)
    body[body.length - 20]! ^= 1
    await expect(openFile(body, 'export-passphrase')).rejects.toBeInstanceOf(BadPassphraseError)
    const nl = file.indexOf(0x0a)
    const h = JSON.parse(file.subarray(0, nl).toString()) as { createdAt: number }
    const reheaded = Buffer.concat([Buffer.from(JSON.stringify({ ...h, createdAt: h.createdAt + 1 })), file.subarray(nl)])
    await expect(openFile(reheaded, 'export-passphrase')).rejects.toBeInstanceOf(BadPassphraseError)
    // A header asking for absurd KDF memory is refused before any work is done.
    const hostile = Buffer.concat([Buffer.from(JSON.stringify({ ...h, kdf: { name: 'scrypt', N: 2 ** 30, r: 8, p: 1 } })), file.subarray(nl)])
    expect(() => readHeader(hostile)).toThrow(/parameters/)
    expect(() => readHeader(Buffer.from('PK\x03\x04 zip file'))).toThrow(/Not a Hopline/)
    await expect(sealFile({}, 'short', FAST)).rejects.toThrow(/at least 8/)
  })

  it('leaves secrets out unless asked', async () => {
    const a = await seeded()
    const p = await buildPayload(a.repo, false)
    expect(p.includesSecrets).toBe(false)
    expect(JSON.stringify(p)).not.toContain('CANARY-PASSWORD')
    for (const c of p.credentials) expect(Object.keys(c).sort()).toEqual(['id', 'keyEncrypted', 'keyFingerprint', 'keyType', 'kind', 'name', 'updatedAt', 'username'])
    // Never the vault, the sync config or the API key.
    a.repo.setSetting('anthropic_api_key_dek', 'CANARY-API')
    a.repo.setSetting('sync_config', '{"dir":"CANARY-DIR"}')
    expect(JSON.stringify(await buildPayload(a.repo, true))).not.toMatch(/CANARY-API|CANARY-DIR|data_key/)
  })

  it('merge keeps local secrets and trusted host keys; replace makes the profile match the file', async () => {
    const a = await seeded()
    const exported = await buildPayload(a.repo, false)
    const b = await seeded()
    // Same profile id, secret only on this machine.
    const local = await b.repo.saveCredential({ id: a.cred.id, name: 'Local name', username: 'admin', kind: 'password', secret: 'LOCAL-SECRET' })
    b.repo.addHostKey('10.0.0.1', 22, 'SHA256:different')
    b.repo.removeHostKeys('10.0.0.1', 22)
    b.repo.addHostKey('10.0.0.1', 22, 'SHA256:local-key')
    const pv = preview(b.repo, exported, { token: 't', file: 'f', createdAt: 0 })
    expect(pv.updates.credentials).toBe(1)
    expect(pv.hostKeyConflicts).toEqual([{ host: '10.0.0.1', port: 22 }])
    const r = await applyPayload(b.repo, exported, 'merge')
    expect(r.hostKeyConflicts).toBe(1)
    expect(b.repo.getCredential(local.id)?.name).toBe('Lab admin')
    expect((await b.repo.resolveCredential(local.id))?.secret).toBe('LOCAL-SECRET')
    expect(b.repo.hostKeys('10.0.0.1', 22)).toEqual(['SHA256:local-key'])
    // b's own seeded sessions (different ids) are still there after a merge.
    expect(b.repo.listSessions()).toHaveLength(4)

    const replaced = await applyPayload(b.repo, exported, 'replace')
    expect(replaced.mode).toBe('replace')
    expect(b.repo.listSessions().map((s) => s.id).sort()).toEqual(a.repo.listSessions().map((s) => s.id).sort())
    expect(b.repo.hostKeys('10.0.0.1', 22)).toEqual(['SHA256:aaa'])
  })

  it('validates untrusted payloads: bad records, dangling references, folder cycles', async () => {
    const a = await seeded()
    const p = await buildPayload(a.repo, false)
    expect(() => parsePayload({ ...p, sessions: [{ ...p.sessions[0], port: 99999 }] })).toThrow(/not valid/)
    expect(() => parsePayload({ ...p, credentials: [{ ...p.credentials[0], kind: 'telepathy' }] })).toThrow(/not valid/)
    const hostile = parsePayload({
      ...p,
      folders: [
        { id: 'f1', name: 'A', parentId: 'f2', sort: 0 },
        { id: 'f2', name: 'B', parentId: 'f1', sort: 0 },
        { id: 'f3', name: 'C', parentId: 'nowhere', sort: 0 }
      ],
      sessions: [{ ...p.sessions[0]!, id: 's-x', folderId: 'gone', credentialId: 'gone' }],
      settings: { termFontSize: 999, theme: 'light', evil: '<script>' }
    })
    const b = await profile()
    await applyPayload(b.repo, hostile, 'merge')
    const folders = b.repo.listFolders()
    // The cycle is cut, the missing parent becomes the root.
    expect(folders.filter((f) => f.parentId === null).map((f) => f.name).sort()).toEqual(['B', 'C'])
    expect(b.repo.getSession('s-x')).toMatchObject({ folderId: null, credentialId: null })
    // Only known, valid preferences are imported.
    expect(JSON.parse(b.repo.getSetting('prefs')!)).toEqual({ theme: 'light' })
  })
})

describe('folder sync', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('writes on change, offers a file from another machine, and never clobbers it', async () => {
    const syncDir = mkdtempSync(join(dir, 'sync-'))
    const a = await seeded()
    const sa = new FolderSync(a.repo, a.vault.key, { debounceMs: 20, kdf: FAST })
    a.repo.onChange = () => sa.markDirty()
    await sa.enable(syncDir, 'sync-passphrase', false)
    const first = readFileSync(join(syncDir, SYNC_FILE))
    expect(first.includes(Buffer.from('sw1'))).toBe(false)
    expect(sa.status()).toMatchObject({ enabled: true, incoming: null, includeSecrets: false })

    // Machine B joins the same folder: it is offered A's data.
    const b = await profile()
    const sb = new FolderSync(b.repo, b.vault.key, { debounceMs: 20, kdf: FAST })
    await expect(sb.enable(syncDir, 'wrong-passphrase', false)).rejects.toBeInstanceOf(BadPassphraseError)
    await sb.enable(syncDir, 'sync-passphrase', false)
    expect(sb.status().incoming).not.toBeNull()
    const inc = await sb.readIncoming()
    await applyPayload(b.repo, inc.payload, 'merge')
    sb.imported(inc.hash, inc.payload)
    expect(sb.status().incoming).toBeNull()
    expect(b.repo.listSessions().map((s) => s.name)).toEqual(['sw1', 'sw2'])
    // Same content after the merge: B doesn't rewrite the file.
    await sb.write()
    expect(readFileSync(join(syncDir, SYNC_FILE))).toEqual(first)

    // A changes something: the file is rewritten after the debounce, and B sees it as incoming.
    a.repo.saveSession({ ...base, name: 'sw3', host: '10.0.0.3', folderId: null, credentialId: null })
    await wait(300)
    expect(readFileSync(join(syncDir, SYNC_FILE))).not.toEqual(first)
    await sb.check()
    expect(sb.status().incoming).not.toBeNull()
    // B has a local change too, but must not overwrite A's newer file.
    const aFile = readFileSync(join(syncDir, SYNC_FILE))
    b.repo.saveSession({ ...base, name: 'b-only', host: '10.9.9.9', folderId: null, credentialId: null })
    await sb.write()
    expect(readFileSync(join(syncDir, SYNC_FILE))).toEqual(aFile)
    sa.stop()
    sb.stop()
  })

  it('pauses while the vault is locked and resumes after unlock', async () => {
    const syncDir = mkdtempSync(join(dir, 'sync-'))
    const a = await seeded()
    await a.vault.setMode('master', { password: 'master-password' })
    const s = new FolderSync(a.repo, a.vault.key, { debounceMs: 20, kdf: FAST })
    await s.enable(syncDir, 'sync-passphrase', false)
    const before = readFileSync(join(syncDir, SYNC_FILE))
    a.vault.lock()
    a.repo.saveSession({ ...base, name: 'while-locked', folderId: null, credentialId: null })
    await s.write()
    expect(s.status().paused).toBe(true)
    expect(readFileSync(join(syncDir, SYNC_FILE))).toEqual(before)
    await a.vault.unlock('master-password')
    await s.write()
    expect(s.status().paused).toBe(false)
    expect(readFileSync(join(syncDir, SYNC_FILE))).not.toEqual(before)
    s.stop()
  })

  it('a corrupt file in the folder is reported, not imported', async () => {
    const syncDir = mkdtempSync(join(dir, 'sync-'))
    const a = await seeded()
    const s = new FolderSync(a.repo, a.vault.key, { debounceMs: 20, kdf: FAST })
    await s.enable(syncDir, 'sync-passphrase', false)
    writeFileSync(join(syncDir, SYNC_FILE), 'garbage')
    await s.check()
    expect(s.status().incoming).not.toBeNull()
    await expect(s.readIncoming()).rejects.toThrow(/Not a Hopline/)
    s.stop()
  })
})
