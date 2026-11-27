import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { FolderSync } from '../src/main/backup/sync'
import { applyPayload, buildPayload, parsePayload, payloadHash, preview, TOMBSTONE_TTL_MS } from '../src/main/backup/transfer'
import { Vault } from '../src/main/vault/vault'

/** Review findings #2 (hostile merge), #4 (sync convergence) and #7 (folder cycles). Inputs are the reviewer's repros. */
const FAST = { N: 2 ** 10, r: 8, p: 1 }
const dir = mkdtempSync(join(tmpdir(), 'mrgrev-'))
const closers: (() => void)[] = []
afterAll(() => {
  for (const c of closers) c()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
let n = 0

async function profile() {
  const db = openDb(join(dir, `p${n++}.db`))
  closers.push(() => db.close())
  const m = new Map<string, string>()
  const vault = new Vault({
    settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) },
    keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) },
    kdf: FAST
  })
  await vault.init()
  return { db, vault, repo: new Repo(db, vault.key) }
}
const base = { port: 22, protocol: 'ssh' as const, platform: 'iosxe' as const, username: 'admin', logToFile: false, notes: '', options: {}, folderId: null }
const prefs = (r: Repo) => JSON.parse(r.getSetting('prefs') ?? '{}') as Record<string, unknown>

describe('#2 a hostile .hopline cannot retarget a known session', () => {
  it('detaches the credential, lists it, withholds the host key and ignores security settings', async () => {
    const a = await profile()
    const cred = await a.repo.saveCredential({ name: 'prod', username: 'admin', kind: 'password', secret: 'pw' })
    const s = a.repo.saveSession({ ...base, name: 'core1', host: '10.0.0.1', credentialId: cred.id })
    a.repo.setSetting('prefs', JSON.stringify({ aiReadOnly: true, outputCapBytes: 524288 }))
    // The reviewer's file: same session id, the attacker's host, agent forwarding, a pre-trusted key.
    const p = await buildPayload(a.repo, false)
    const hostile = parsePayload({
      ...p,
      sessions: [{ ...p.sessions[0], host: 'evil.example', options: { ssh: { agentForward: true } } }],
      knownHosts: [{ host: 'evil.example', port: 22, fingerprint: 'SHA256:attacker', keyType: 'ssh-ed25519', source: 'import', addedAt: 0 }],
      settings: { aiReadOnly: false, outputCapBytes: 16777216, commandTimeoutMs: 300000, logDir: '/tmp/x', logTemplate: '../../x', theme: 'light' }
    })
    const pv = preview(a.repo, hostile, { token: 't', file: 'f', createdAt: 0 })
    expect(pv.retargeted).toEqual(['core1 (10.0.0.1:22 → evil.example:22)'])
    expect(pv.hostKeysWithheld).toBe(1)
    expect(pv.settingsApplied).toEqual(['theme'])
    expect(pv.settingsIgnored.sort()).toEqual(['aiReadOnly', 'commandTimeoutMs', 'logDir', 'logTemplate', 'outputCapBytes'])

    expect(pv.credentialAttached).toEqual([])
    const r = await applyPayload(a.repo, hostile, 'merge')
    expect(r).toMatchObject({ retargeted: 1, hostKeysWithheld: 1, knownHosts: 0 })
    // The same file a second time is no longer a retarget, but the preview names the re-attached credential.
    const again = preview(a.repo, hostile, { token: 't', file: 'f', createdAt: 0 })
    expect(again.retargeted).toEqual([])
    expect(again.credentialAttached).toEqual(['core1 (evil.example:22) uses "prod"'])
    // …and applying it again still never links the stored credential to the attacker's host.
    await applyPayload(a.repo, hostile, 'merge')
    const after = a.repo.getSession(s.id)!
    expect(after.host).toBe('evil.example')
    expect(after.credentialId).toBeNull()
    expect(a.repo.hostKeys('evil.example', 22)).toEqual([])
    expect(prefs(a.repo)).toEqual({ aiReadOnly: true, outputCapBytes: 524288, theme: 'light' })
  })

  it('a merge never newly links a credential that was already stored here (new sessions included)', async () => {
    const a = await profile()
    const cred = await a.repo.saveCredential({ name: 'prod', username: 'admin', kind: 'password', secret: 'pw' })
    const kept = a.repo.saveSession({ ...base, name: 'core1', host: '10.0.0.1', credentialId: cred.id })
    const p = await buildPayload(a.repo, false)
    const file = parsePayload({ ...p, sessions: [...p.sessions, { ...p.sessions[0]!, id: 'new-from-file', name: 'planted', host: 'evil.example' }] })
    await applyPayload(a.repo, file, 'merge')
    expect(a.repo.getSession(kept.id)!.credentialId).toBe(cred.id) // an existing link is kept
    expect(a.repo.getSession('new-from-file')!.credentialId).toBeNull() // a new one is not made
  })

  it('port, protocol, jump or agent forwarding changes count as retargeting; a rename does not', async () => {
    const a = await profile()
    const cred = await a.repo.saveCredential({ name: 'prod', username: 'admin', kind: 'password', secret: 'pw' })
    const jump = a.repo.saveSession({ ...base, name: 'bastion', host: '10.0.0.254', credentialId: null })
    const ids = ['port', 'protocol', 'jump', 'fwd', 'rename'].map((k) => a.repo.saveSession({ ...base, name: k, host: `10.1.0.${k.length}`, credentialId: cred.id }).id)
    const p = await buildPayload(a.repo, false)
    const edit: Record<string, (s: (typeof p.sessions)[number]) => object> = {
      port: (s) => ({ ...s, port: 2222 }),
      protocol: (s) => ({ ...s, protocol: 'telnet' }),
      jump: (s) => ({ ...s, options: { ssh: { jump: [jump.id] } } }),
      fwd: (s) => ({ ...s, options: { ssh: { agentForward: true } } }),
      rename: (s) => ({ ...s, name: 'renamed', notes: 'x' })
    }
    const file = parsePayload({ ...p, sessions: p.sessions.map((s) => (edit[s.name] ? edit[s.name]!(s) : s)) })
    await applyPayload(a.repo, file, 'merge')
    expect(ids.map((id) => a.repo.getSession(id)!.credentialId === null)).toEqual([true, true, true, true, false])
  })

  it('a file that adds or changes port forwards retargets the session; a hand-picked merge never imports them onto it (review M5)', async () => {
    const a = await profile()
    const cred = await a.repo.saveCredential({ name: 'prod', username: 'admin', kind: 'password', secret: 'pw' })
    const own = { id: 'f1', kind: 'L' as const, bindHost: '127.0.0.1', bindPort: 8443, destHost: '10.0.0.5', destPort: 443 }
    const ids = ['addR', 'change', 'same', 'relabel'].map((k) => a.repo.saveSession({ ...base, name: k, host: `10.3.0.${k.length}`, credentialId: cred.id, options: { ssh: { forwards: [own] } } }).id)
    const p = await buildPayload(a.repo, false)
    const reverse = { id: 'r1', kind: 'R' as const, bindHost: '0.0.0.0', bindPort: 2222, destHost: '127.0.0.1', destPort: 22 }
    const edit: Record<string, (s: (typeof p.sessions)[number]) => object> = {
      addR: (s) => ({ ...s, options: { ssh: { forwards: [own, reverse] } } }),
      change: (s) => ({ ...s, options: { ssh: { forwards: [{ ...own, destHost: 'evil.example' }] } } }),
      relabel: (s) => ({ ...s, options: { ssh: { forwards: [{ ...own, label: 'web' }] } } })
    }
    const file = parsePayload({ ...p, sessions: p.sessions.map((s) => (edit[s.name] ? edit[s.name]!(s) : s)) })
    const pv = preview(a.repo, file, { token: 't', file: 'f', createdAt: 0 })
    expect(pv.retargeted.sort()).toEqual(['addR (10.3.0.4:22 → 10.3.0.4:22, port forwards added or changed)', 'change (10.3.0.6:22 → 10.3.0.6:22, port forwards added or changed)'])
    await applyPayload(a.repo, file, 'merge')
    // Added or changed forwards detach the stored credential; the same or a relabelled one does not.
    expect(ids.map((id) => a.repo.getSession(id)!.credentialId === null)).toEqual([true, true, false, false])
    // …and a hand-picked merge keeps the forwards this machine had: no -R, no new destination.
    for (const id of ids) expect(a.repo.getSession(id)!.options.ssh?.forwards).toEqual([own])
  })

  it('a hand-picked merge imports a new session\'s forwards switched off; sync keeps them as they are (review M5)', async () => {
    const a = await profile()
    const b = await profile()
    const fwds = [
      { id: 'f1', kind: 'D' as const, bindHost: '127.0.0.1', bindPort: 1080 },
      { id: 'f2', kind: 'R' as const, bindHost: '127.0.0.1', bindPort: 2222, destHost: '127.0.0.1', destPort: 22, autoStart: true }
    ]
    const s = a.repo.saveSession({ ...base, name: 'fresh', host: '10.4.0.1', credentialId: null, options: { ssh: { forwards: fwds } } })
    const file = await buildPayload(a.repo, false)
    await applyPayload(b.repo, file, 'merge')
    expect(b.repo.getSession(s.id)!.options.ssh?.forwards?.map((f) => f.autoStart)).toEqual([false, false])
    const c = await profile()
    await applyPayload(c.repo, file, 'merge', { sync: true })
    expect(c.repo.getSession(s.id)!.options.ssh?.forwards).toEqual(fwds)
  })

  it('a session the file adds keeps its credential; a file picked by hand never adds host keys', async () => {
    const a = await profile()
    const b = await profile()
    const cred = await a.repo.saveCredential({ name: 'lab', username: 'admin', kind: 'password', secret: 'pw' })
    const s = a.repo.saveSession({ ...base, name: 'new-sw', host: '10.2.0.1', credentialId: cred.id })
    a.repo.addHostKey('10.2.0.1', 22, 'SHA256:real')
    const file = await buildPayload(a.repo, true)
    await applyPayload(b.repo, file, 'merge')
    expect(b.repo.getSession(s.id)!.credentialId).toBe(cred.id)
    expect(b.repo.hostKeys('10.2.0.1', 22)).toEqual([])
    // Importing the same file again must not pre-trust its keys either: the first connect asks.
    await applyPayload(b.repo, file, 'merge')
    expect(b.repo.hostKeys('10.2.0.1', 22)).toEqual([])
    // A full restore (replace) does bring the keys.
    await applyPayload(b.repo, file, 'replace')
    expect(b.repo.hostKeys('10.2.0.1', 22)).toEqual(['SHA256:real'])
  })
})

describe('#7 folder cycles', () => {
  it('a merge cannot close a cycle through local folders (reviewer repro)', async () => {
    const a = await profile()
    const A = a.repo.saveFolder({ name: 'A', parentId: null })
    const B = a.repo.saveFolder({ name: 'B', parentId: A.id })
    a.repo.saveSession({ ...base, name: 's', folderId: B.id, host: 'h', credentialId: null })
    const payload = await buildPayload(a.repo, false)
    // The other machine moved A under B; the file only lists A.
    payload.folders = [{ id: A.id, name: 'A', parentId: B.id, sort: 0 }]
    await applyPayload(a.repo, parsePayload(payload), 'merge')
    const fs = a.repo.listFolders()
    expect(fs.map((f) => [f.name, fs.find((g) => g.id === f.parentId)?.name ?? null]).sort()).toEqual([
      ['A', null],
      ['B', 'A']
    ])
  })

  it('moveMany refuses a cycle at any depth (reviewer repro: 70 levels)', async () => {
    const { repo } = await profile()
    let parent: string | null = null
    const ids: string[] = []
    for (let i = 0; i < 70; i++) {
      const f = repo.saveFolder({ name: 'f' + i, parentId: parent })
      ids.push(f.id)
      parent = f.id
    }
    expect(() => repo.moveMany({ sessionIds: [], folderIds: [ids[0]!] }, ids[69]!)).toThrow(/into itself/)
    expect(() => repo.saveFolder({ id: ids[0]!, name: 'f0', parentId: ids[69]! })).toThrow(/into itself/)
    expect(repo.listFolders().find((f) => f.id === ids[0])!.parentId).toBeNull()
  })

  it('an existing cycle is repaired on load: the folder closing it moves to the top level', async () => {
    const { db, repo } = await profile()
    db.prepare("INSERT INTO folders (id, name, parent_id) VALUES ('A', 'A', 'C'), ('B', 'B', 'A'), ('C', 'C', 'B'), ('D', 'D', 'C')").run()
    expect(repo.repairFolderCycles()).toBe(1)
    const parent = new Map(repo.listFolders().map((f) => [f.id, f.parentId]))
    const roots = [...parent.keys()].map((id) => {
      const seen = new Set<string>()
      let x: string | null = id
      while (x && !seen.has(x)) (seen.add(x), (x = parent.get(x) ?? null))
      return x
    })
    expect(roots.every((r) => r === null)).toBe(true)
    expect(repo.repairFolderCycles()).toBe(0)
  })
})

describe('#4 folder sync converges', () => {
  const pull = async (s: FolderSync, r: Repo) => {
    await s.check()
    if (!s.status().incoming) return false
    const inc = await s.readIncoming()
    await applyPayload(r, inc.payload, 'merge', { sync: true })
    s.imported(inc.hash, inc.payload)
    return true
  }
  /** Both machines take turns: import what is incoming, then write. */
  const rounds = async (k: number, ...sides: [FolderSync, Repo][]) => {
    for (let i = 0; i < k; i++)
      for (const [s, r] of sides) {
        await pull(s, r)
        await s.write()
      }
  }
  const same = async (a: Repo, b: Repo) => payloadHash(await buildPayload(a, false)) === payloadHash(await buildPayload(b, false))

  it('deletions stick, secrets/settings/host-key differences settle, and nothing stays incoming', async () => {
    const folder = join(dir, 'conv')
    mkdirSync(folder)
    const A = await profile()
    const B = await profile()
    const sa = new FolderSync(A.repo, A.vault.key, { kdf: FAST, debounceMs: 1e9 })
    const sb = new FolderSync(B.repo, B.vault.key, { kdf: FAST, debounceMs: 1e9 })
    closers.unshift(() => (sa.stop(), sb.stop()))
    const cred = await A.repo.saveCredential({ name: 'c', username: 'u', kind: 'password', secret: 'pw' })
    const x = A.repo.saveSession({ ...base, name: 'x', host: '10.0.0.9', credentialId: null })
    const y = A.repo.saveSession({ ...base, name: 'y', host: '10.0.0.10', credentialId: cred.id })
    const doomed = A.repo.saveFolder({ name: 'doomed', parentId: null })
    // Machine-local differences that must not ping-pong: security prefs, a differently trusted key.
    A.repo.setSetting('prefs', JSON.stringify({ aiReadOnly: true, termFontSize: 14 }))
    B.repo.setSetting('prefs', JSON.stringify({ aiReadOnly: false }))
    A.repo.addHostKey('10.0.0.10', 22, 'SHA256:a-key')
    B.repo.addHostKey('10.0.0.10', 22, 'SHA256:b-key')
    // A syncs with secrets, B without (the reviewer's endless "incoming" loop).
    await sa.enable(folder, 'sync-passphrase', true)
    await sb.enable(folder, 'sync-passphrase', false)
    await rounds(3, [sb, B.repo], [sa, A.repo])
    expect(B.repo.getSession(x.id)).toBeDefined()
    expect(B.repo.getSession(y.id)!.credentialId).toBe(cred.id)

    // A deletes x and a folder; B adds a session; then a legitimate host edit on A.
    A.repo.removeSession(x.id)
    A.repo.removeFolder(doomed.id)
    const z = B.repo.saveSession({ ...base, name: 'z', host: '10.0.0.11', credentialId: null })
    await rounds(3, [sa, A.repo], [sb, B.repo])
    expect(A.repo.getSession(x.id)).toBeUndefined()
    expect(B.repo.getSession(x.id)).toBeUndefined()
    expect(B.repo.listFolders().some((f) => f.id === doomed.id)).toBe(false)
    expect(A.repo.getSession(z.id)).toBeDefined()

    A.repo.saveSession({ ...A.repo.getSession(y.id)!, host: '10.0.0.20' })
    await rounds(4, [sa, A.repo], [sb, B.repo])
    // Retargeted on B: the credential is detached there, and that converges back to A.
    expect(B.repo.getSession(y.id)).toMatchObject({ host: '10.0.0.20', credentialId: null })
    expect(A.repo.getSession(y.id)!.credentialId).toBeNull()

    // Converged: same content, nothing incoming on either side after another check, no further writes.
    expect(await same(A.repo, B.repo)).toBe(true)
    await sa.check()
    await sb.check()
    expect(sa.status().incoming).toBeNull()
    expect(sb.status().incoming).toBeNull()
    const before = sa.status().lastWriteAt
    await rounds(2, [sa, A.repo], [sb, B.repo])
    expect(sa.status().lastWriteAt).toBe(before)
    // Local-only things stayed local.
    expect(prefs(A.repo)['aiReadOnly']).toBe(true)
    expect(prefs(B.repo)['aiReadOnly']).toBe(false)
    expect(prefs(B.repo)['termFontSize']).toBe(14)
    expect(B.repo.hostKeys('10.0.0.10', 22)).toEqual(['SHA256:b-key'])
    // A re-attaches the credential once; it syncs (no host change now).
    A.repo.saveSession({ ...A.repo.getSession(y.id)!, credentialId: cred.id })
    await rounds(3, [sa, A.repo], [sb, B.repo])
    expect(B.repo.getSession(y.id)!.credentialId).toBe(cred.id)
  })

  it('an item edited after it was deleted elsewhere comes back; a tie keeps it deleted; old tombstones are pruned', async () => {
    const A = await profile()
    const B = await profile()
    const s = A.repo.saveSession({ ...base, name: 'e', host: '10.3.0.1', credentialId: null }, { updatedAt: 1_000 })
    await applyPayload(B.repo, await buildPayload(A.repo, false), 'merge', { sync: true })
    A.repo.removeSession(s.id)
    const del = A.repo.listTombstones()[0]!.deletedAt
    // B edited it later than A deleted it: the merge on A brings it back, and B keeps it.
    B.repo.saveSession({ ...B.repo.getSession(s.id)!, notes: 'edited' }, { updatedAt: del + 1 })
    await applyPayload(A.repo, await buildPayload(B.repo, false), 'merge', { sync: true })
    expect(A.repo.getSession(s.id)?.notes).toBe('edited')
    expect(A.repo.listTombstones()).toEqual([])
    // Tie: same millisecond → the deletion wins.
    A.repo.removeSession(s.id)
    const t = A.repo.listTombstones()[0]!.deletedAt
    B.repo.saveSession({ ...B.repo.getSession(s.id)!, notes: 'tie' }, { updatedAt: t })
    await applyPayload(A.repo, await buildPayload(B.repo, false), 'merge', { sync: true })
    expect(A.repo.getSession(s.id)).toBeUndefined()
    await applyPayload(B.repo, await buildPayload(A.repo, false), 'merge', { sync: true })
    expect(B.repo.getSession(s.id)).toBeUndefined()
    // A file picked by hand restores it (tombstones are a sync thing), and drops the tombstone.
    const old = parsePayload({ ...(await buildPayload(A.repo, false)), sessions: [{ ...base, id: s.id, name: 'e', host: '10.3.0.1', credentialId: null, updatedAt: 1 }] })
    await applyPayload(A.repo, old, 'merge')
    expect(A.repo.getSession(s.id)).toBeDefined()
    expect(A.repo.listTombstones()).toEqual([])
    // Pruned after 90 days.
    A.repo.putTombstone({ type: 'folder', id: 'ancient', deletedAt: Date.now() - TOMBSTONE_TTL_MS - 1 })
    expect((await buildPayload(A.repo, false)).tombstones).toEqual([])
  })

  it('the hash ignores secrets and includesSecrets, so the same content hashes the same', async () => {
    const A = await profile()
    await A.repo.saveCredential({ name: 'c', username: 'u', kind: 'password', secret: 'pw' })
    expect(payloadHash(await buildPayload(A.repo, true))).toBe(payloadHash(await buildPayload(A.repo, false)))
  })

  it('migration 8 adds tombstones and folder stamps to a v7 database', () => {
    const db = new Database(join(dir, 'v7.db'))
    closers.push(() => db.close())
    for (const m of MIGRATIONS.slice(0, 7)) db.exec(m)
    db.pragma('user_version = 7')
    db.prepare("INSERT INTO folders (id, name) VALUES ('f', 'F')").run()
    db.close()
    const up = openDb(join(dir, 'v7.db'))
    closers.push(() => up.close())
    expect(up.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(new Repo(up).updatedAt('folder').get('f')).toBe(0)
  })
})
