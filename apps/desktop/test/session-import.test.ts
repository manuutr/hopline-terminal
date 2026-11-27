import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { importSshConfig, type FetchLike } from '@hopline/importers'
import type { Session, SessionImportApply, SessionImportPlan } from '@shared/types'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { linkSourceOf, NetBoxStore } from '../src/main/importer/netbox'
import { applyImport, buildPlan, cleanTags, planView, type StagedImport } from '../src/main/importer/plan'
import { readSecureCrtTree, readSource } from '../src/main/importer/read'
import { Vault } from '../src/main/vault/vault'

const FIXTURES = join(__dirname, '../../../packages/importers/test/fixtures')
const dir = mkdtempSync(join(tmpdir(), 'import-'))
const dbs: ReturnType<typeof openDb>[] = []
afterAll(() => {
  // Windows can't delete a file SQLite still holds open (EPERM), so close every profile first.
  for (const db of dbs) db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
let n = 0

async function profile() {
  const db = openDb(join(dir, `p${n++}.db`))
  dbs.push(db)
  const m = new Map<string, string>()
  const vault = new Vault({
    settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) },
    keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) },
    kdf: { N: 2 ** 10, r: 8, p: 1 }
  })
  await vault.init()
  return { db, vault, repo: new Repo(db, vault.key) }
}

const sshStaged = (): StagedImport => ({ source: 'ssh-config', label: 'ssh_config', result: importSshConfig(readFileSync(join(FIXTURES, 'ssh_config'), 'utf8')), resync: false })
const plan = (repo: Repo, st: StagedImport, opts = { targetFolderId: null as string | null, keepFolders: true }): SessionImportPlan => planView(repo, st, buildPlan(repo, st, opts), 'tok')
/** Tick every row of the given statuses; rows without a platform get `ios`. */
function req(p: SessionImportPlan, statuses = ['new', 'changed'], extra: Partial<SessionImportApply> = {}): Omit<SessionImportApply, 'token'> {
  const rows = p.rows.filter((r) => statuses.includes(r.status))
  return {
    rows: rows.map((r) => r.index),
    remove: [],
    platforms: Object.fromEntries(rows.filter((r) => r.platformPrompt === 'missing').map((r) => [String(r.index), 'ios' as const])),
    targetFolderId: p.options.targetFolderId,
    keepFolders: p.options.keepFolders,
    ...extra
  }
}
const byName = (repo: Repo, name: string): Session => {
  const s = repo.listSessions().filter((x) => x.name === name)
  expect(s, name).toHaveLength(1)
  return s[0]!
}
const pathOf = (repo: Repo, s: Session): string => {
  const folders = repo.listFolders()
  const parts: string[] = []
  for (let id = s.folderId; id; ) {
    const f = folders.find((x) => x.id === id)!
    parts.unshift(f.name)
    id = f.parentId
  }
  return parts.join('/')
}

describe('session import: plan and apply', () => {
  it('imports ssh_config, resolving ProxyJump to session ids (one hop and a chain)', async () => {
    const { repo } = await profile()
    const st = sshStaged()
    const p = plan(repo, st)
    expect(p.rows.every((r) => r.status === 'new')).toBe(true)
    expect(p.rows.find((r) => r.name === 'core-nxos-01')).toMatchObject({ jump: ['bastion'], platform: 'nxos', platformGuessed: true, platformPrompt: 'guessed' })
    expect(p.rows.find((r) => r.name === 'bastion')).toMatchObject({ platform: null, platformPrompt: 'missing' })
    // Without a platform, a new session imports as Auto-detect (identified on first connect).
    const repo2 = new Repo(openDb(':memory:'))
    applyImport(repo2, sshStaged(), { ...req(plan(repo2, sshStaged())), platforms: {} })
    expect(byName(repo2, 'bastion').platform).toBe('auto')
    expect(repo.listSessions()).toHaveLength(0)

    // A guessed platform can be overridden.
    const core = p.rows.find((r) => r.name === 'core-nxos-02')!
    const out = applyImport(repo, st, { ...req(p), platforms: { ...req(p).platforms, [String(core.index)]: 'eos' } })
    expect(out).toMatchObject({ created: p.rows.length, updated: 0, removed: 0, skippedJumps: 0 })
    expect(byName(repo, 'core-nxos-02').platform).toBe('eos')
    expect(byName(repo, 'core-nxos-01').platform).toBe('nxos')
    // Re-importing: the name-based guess does not count as a change against the choice made here.
    expect(plan(repo, st).rows.find((r) => r.name === 'core-nxos-02')!.status).toBe('unchanged')
    const bastion = byName(repo, 'bastion')
    expect(bastion.platform).toBe('ios')
    expect(byName(repo, 'core-nxos-01').options.ssh?.jump).toEqual([bastion.id])
    const edge = byName(repo, 'edge-eos')
    const synth = repo.listSessions().find((s) => s.host === '10.9.9.9')!
    expect(edge.options.ssh?.jump).toEqual([synth.id, bastion.id])
    expect(synth.tags).toEqual(['jump-host'])
    // Nothing secret-looking or unsupported came through.
    expect(JSON.stringify(repo.listSessions())).not.toMatch(/curl -s/)
  })

  it('places SecureCRT folders under the target folder, or flattens them when "keep source folders" is off', async () => {
    const { repo } = await profile()
    const read = await readSource('securecrt', join(FIXTURES, 'securecrt/Config/Sessions'), true)
    const st: StagedImport = { ...read, resync: false }
    const target = repo.saveFolder({ name: 'Imported', parentId: null })
    const p = plan(repo, st, { targetFolderId: target.id, keepFolders: true })
    expect(p.rows.find((r) => r.name === 'core-nxos-01')!.folderPath).toEqual(['Imported', 'Prod', 'Core'])
    expect(p.newFolders.map((f) => f.join('/'))).toEqual(expect.arrayContaining(['Imported/Prod', 'Imported/Prod/Core', 'Imported/jump', 'Imported/Lab']))
    expect(p.rows.find((r) => r.name === 'core-nxos-01')!.jump).toEqual(['Imported/jump/bastion'])

    const out = applyImport(repo, st, req(p))
    const core = byName(repo, 'core-nxos-01')
    expect(pathOf(repo, core)).toBe('Imported/Prod/Core')
    expect(core.options.ssh?.jump).toEqual([byName(repo, 'bastion').id])
    expect(out.folders).toBe(new Set(repo.listSessions().map((s) => s.folderId)).size)
    // Folders are created once, nested, and the target is reused rather than duplicated.
    expect(repo.listFolders().filter((f) => f.name === 'Imported')).toHaveLength(1)
    expect(repo.listFolders().filter((f) => f.name === 'Core')).toHaveLength(1)

    const { repo: flatRepo } = await profile()
    const flat = plan(flatRepo, st, { targetFolderId: null, keepFolders: false })
    expect(flat.rows.every((r) => r.folderPath.length === 0)).toBe(true)
    applyImport(flatRepo, st, req(flat))
    expect(flatRepo.listFolders()).toHaveLength(0)
    expect(byName(flatRepo, 'core-nxos-01').options.ssh?.jump).toEqual([byName(flatRepo, 'bastion').id])
  })

  it('the SecureCRT tree reader keeps paths relative to the Sessions folder whichever folder is picked', async () => {
    const fromSessions = await readSecureCrtTree(join(FIXTURES, 'securecrt/Config/Sessions'))
    const fromRoot = await readSecureCrtTree(join(FIXTURES, 'securecrt'))
    expect(fromSessions.find((f) => f.path.endsWith('bastion.ini'))!.path).toBe('Sessions/jump/bastion.ini')
    expect(fromRoot.find((f) => f.path.endsWith('bastion.ini'))!.path).toBe('Config/Sessions/jump/bastion.ini')
    const a = (await readSource('securecrt', join(FIXTURES, 'securecrt'), true)).result.sessions.map((s) => [...s.folderPath, s.name].join('/')).sort()
    const b = (await readSource('securecrt', join(FIXTURES, 'securecrt/Config/Sessions'), true)).result.sessions.map((s) => [...s.folderPath, s.name].join('/')).sort()
    expect(a).toEqual(b)
  })

  it('a changed session gets only the fields the source changed; credential, color and jump hosts set here stay', async () => {
    const { repo } = await profile()
    const st = sshStaged()
    applyImport(repo, st, req(plan(repo, st)))
    const cred = await repo.saveCredential({ name: 'ops', username: 'netops', kind: 'prompt' })
    const legacy = byName(repo, 'legacy-ios')
    repo.saveSession({ ...legacy, host: '192.0.2.99', credentialId: cred.id, color: 'red', logToFile: true, notes: legacy.notes })
    // core-nxos-01 now jumps through core-lab instead of bastion (set by hand here).
    const core = byName(repo, 'core-nxos-01')
    const lab = byName(repo, 'core-lab')
    repo.saveSession({ ...core, host: 'moved.example.net', options: { ...core.options, ssh: { ...core.options.ssh, jump: [lab.id] } } })

    const again = plan(repo, st)
    const row = again.rows.find((r) => r.name === 'legacy-ios')!
    expect(row.status).toBe('changed')
    expect(row.changes).toEqual([{ field: 'host', from: '192.0.2.99', to: '192.0.2.10' }])
    expect(again.rows.filter((r) => r.status === 'unchanged').length).toBe(again.rows.length - 2)
    const out = applyImport(repo, st, req(again, ['changed']))
    expect(out).toMatchObject({ created: 0, updated: 2 })
    expect(byName(repo, 'legacy-ios')).toMatchObject({ host: '192.0.2.10', credentialId: cred.id, color: 'red', logToFile: true })
    expect(byName(repo, 'core-nxos-01')).toMatchObject({ host: 'core-nxos-01.dc1.example.net', options: { ssh: { jump: [lab.id] } } })
    // A changed session without a jump host gets the source's.
    const two = byName(repo, 'core-nxos-02')
    repo.saveSession({ ...two, host: 'x.example.net', options: {} })
    applyImport(repo, st, req(plan(repo, st), ['changed']))
    expect(byName(repo, 'core-nxos-02').options.ssh?.jump).toEqual([byName(repo, 'bastion').id])
  })

  it('reads every file format from desktop: XML, MobaXterm, PuTTY (UTF-16) and CSV with a column mapping', async () => {
    const xml = await readSource('securecrt', join(FIXTURES, 'securecrt-export.xml'), false)
    expect(xml.result.sessions.length).toBeGreaterThan(0)
    const moba = await readSource('mobaxterm', join(FIXTURES, 'sessions.mxtsessions'), false)
    expect(moba.result.sessions.length).toBeGreaterThan(0)
    const putty = await readSource('putty', join(FIXTURES, 'putty-sessions.reg'), false)
    expect(putty.result.sessions.length).toBeGreaterThan(0)
    for (const r of [xml, moba, putty]) expect(JSON.stringify(r.result)).not.toMatch(/"password"/i)

    const csv = await readSource('csv', join(FIXTURES, 'devices.csv'), false)
    expect(csv.csvText).toBeDefined()
    expect(csv.result.sessions.length).toBeGreaterThan(0)
  })

  it('a jump host that is not imported is reported, never pointed at the wrong session; an existing one is used', async () => {
    const { repo } = await profile()
    const st = sshStaged()
    const p = plan(repo, st)
    const core = p.rows.find((r) => r.name === 'core-nxos-01')!
    const out = applyImport(repo, st, { ...req(p), rows: [core.index] })
    expect(out.skippedJumps).toBe(1)
    expect(out.warnings[0]!.message).toMatch(/bastion was not imported/)
    expect(byName(repo, 'core-nxos-01').options.ssh?.jump).toBeUndefined()

    // Once bastion exists here, a re-import links to it even when only core-nxos-02 is ticked.
    const bastion = p.rows.find((r) => r.name === 'bastion')!
    applyImport(repo, st, { ...req(plan(repo, st)), rows: [bastion.index] })
    const p2 = plan(repo, st)
    const core2 = p2.rows.find((r) => r.name === 'core-nxos-02')!
    applyImport(repo, st, { ...req(p2), rows: [core2.index] })
    expect(byName(repo, 'core-nxos-02').options.ssh?.jump).toEqual([byName(repo, 'bastion').id])
  })

  it('rolls back everything when one write fails', async () => {
    const { repo } = await profile()
    const keep = repo.saveFolder({ name: 'Keep', parentId: null })
    const read = await readSource('securecrt', join(FIXTURES, 'securecrt/Config/Sessions'), true)
    const st: StagedImport = { ...read, resync: false }
    const p = plan(repo, st)
    const real = repo.saveSession.bind(repo)
    let calls = 0
    const spy = vi.spyOn(repo, 'saveSession').mockImplementation((s) => {
      if (++calls === 3) throw new Error('disk full')
      return real(s)
    })
    expect(() => applyImport(repo, st, req(p))).toThrow('disk full')
    spy.mockRestore()
    expect(repo.listSessions()).toHaveLength(0)
    expect(repo.listFolders()).toEqual([keep])
  })

  it('validates every session before writing: odd tags are cleaned, long notes shortened', async () => {
    expect(cleanTags(['Data Center 1', 'a,b', 'PCI', 'pci', 'x'.repeat(60)])).toEqual(['data-center-1', 'a-b', 'pci', 'x'.repeat(40)])
    const { repo } = await profile()
    const st = sshStaged()
    st.result.sessions[0]!.notes = 'n'.repeat(5000)
    st.result.sessions[0]!.tags = ['Core Switch']
    const out = applyImport(repo, st, req(plan(repo, st)))
    const s = byName(repo, st.result.sessions[0]!.name)
    expect(s.notes.length).toBe(4000)
    expect(s.tags).toEqual(['core-switch'])
    expect(out.warnings.some((w) => /Notes shortened/.test(w.message))).toBe(true)
  })
})

// ------------------------------------------------------------------ NetBox

const TOKEN = 'CANARY-NETBOX-TOKEN-6a1f0000000000000000'
const dev = (id: number, name: string, site: string, ip: string, slug = 'cisco-ios-xe') => ({
  id,
  name,
  site: { id: 1, name: site },
  platform: { slug },
  primary_ip: { address: `${ip}/32` },
  tags: [{ name: 'Data Center' }]
})

function mockFetch(devices: () => unknown[]) {
  const calls: { url: string; auth: string }[] = []
  const f: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization ?? '' })
    if (init.headers.Authorization !== `Token ${TOKEN}`) return { ok: false, status: 403, json: async () => ({}) }
    const list = devices()
    return { ok: true, status: 200, json: async () => ({ count: list.length, next: null, results: list }) }
  }
  return { f, calls }
}

describe('NetBox import and re-sync', () => {
  it('stores the token encrypted, re-syncs by device id, and removes gone devices only when ticked', async () => {
    const { repo, vault } = await profile()
    let devices = [dev(1, 'ams1-sw1', 'AMS1', '10.0.0.1'), dev(2, 'ams1-sw2', 'AMS1', '10.0.0.2'), dev(3, 'fra1-sw1', 'FRA1', '10.1.0.1', 'something')]
    const { f, calls } = mockFetch(() => devices)
    const store = new NetBoxStore(repo, vault.key, f)
    const url = 'https://netbox.example.com/api/'

    const first = await store.fetch({ url, flavor: 'netbox', filter: 'status=active', token: TOKEN })
    expect(calls[0]!.url).toBe('https://netbox.example.com/api/dcim/devices/?limit=250&status=active')
    // Nothing is saved by a preview: only an applied import keeps the source and its token.
    expect(store.source()).toBeNull()
    expect(first.pending).toEqual({ url: 'https://netbox.example.com', flavor: 'netbox', filter: 'status=active', token: TOKEN })

    const st: StagedImport = { source: 'netbox', label: first.url, result: first.result, linkSource: linkSourceOf(first.url), netbox: first.pending, resync: false }
    const p1 = plan(repo, st)
    expect(p1.rows.map((r) => [r.name, r.status, r.folderPath.join('/')])).toEqual([
      ['ams1-sw1', 'new', 'AMS1'],
      ['ams1-sw2', 'new', 'AMS1'],
      ['fra1-sw1', 'new', 'FRA1']
    ])
    expect(p1.rows[2]).toMatchObject({ platformPrompt: 'missing', tags: ['data-center', 'platform:something'] })
    applyImport(repo, st, req(p1))
    store.commit(first.pending, await store.seal(TOKEN), { targetFolderId: null, keepFolders: true })
    expect(store.source()).toMatchObject({ url: 'https://netbox.example.com', filter: 'status=active', hasToken: true })
    // The token is never stored in the clear.
    expect(repo.getSetting('import_netbox_token_dek')).not.toContain(TOKEN)
    expect(repo.getSetting('import_netbox')).not.toContain(TOKEN)
    await expect(store.token()).resolves.toBe(TOKEN)
    const sw2 = byName(repo, 'ams1-sw2')

    // Device 1 renamed and moved to FRA1, device 2 deleted from NetBox, device 4 added.
    devices = [dev(1, 'fra1-sw9', 'FRA1', '10.0.0.1'), dev(3, 'fra1-sw1', 'FRA1', '10.1.0.1', 'something'), dev(4, 'fra1-sw2', 'FRA1', '10.1.0.2')]
    const again = await store.fetch({ url: 'https://netbox.example.com', flavor: 'netbox', filter: 'status=active' })
    expect(calls.at(-1)!.auth).toBe(`Token ${TOKEN}`)
    expect(again.pending.token).toBeUndefined()
    const st2: StagedImport = { ...st, result: again.result, resync: true }
    const p2 = plan(repo, st2)
    const renamed = p2.rows.find((r) => r.name === 'fra1-sw9')!
    expect(renamed.status).toBe('changed')
    expect(renamed.existing?.name).toBe('ams1-sw1')
    expect(renamed.changes?.map((c) => c.field)).toEqual(['name', 'folder'])
    expect(p2.rows.find((r) => r.name === 'fra1-sw1')!.status).toBe('unchanged')
    expect(p2.rows.find((r) => r.name === 'fra1-sw2')!.status).toBe('new')
    expect(p2.gone).toEqual([{ sessionId: sw2.id, name: 'ams1-sw2', folderPath: ['AMS1'], host: '10.0.0.2' }])

    // Not ticked: the gone session stays.
    applyImport(repo, st2, req(p2))
    expect(repo.getSession(sw2.id)).toBeDefined()
    expect(byName(repo, 'fra1-sw9').host).toBe('10.0.0.1')
    expect(repo.listSessions().some((s) => s.name === 'ams1-sw1')).toBe(false)

    // Ticked: removed. A forged id that is not in `gone` is ignored.
    const p3 = plan(repo, st2)
    const keepMe = byName(repo, 'fra1-sw1')
    const out = applyImport(repo, st2, req(p3, [], { remove: [sw2.id, keepMe.id] }))
    expect(out.removed).toBe(1)
    expect(repo.getSession(sw2.id)).toBeUndefined()
    expect(repo.getSession(keepMe.id)).toBeDefined()
  })

  it('refuses a saved token for another server, and forgets everything on request', async () => {
    const { repo, vault } = await profile()
    const { f, calls } = mockFetch(() => [dev(1, 'sw1', 'AMS1', '10.0.0.1')])
    const store = new NetBoxStore(repo, vault.key, f)
    const ok = await store.fetch({ url: 'https://nb.example.com', flavor: 'netbox', filter: '', token: TOKEN })
    store.commit(ok.pending, await store.seal(TOKEN), { targetFolderId: null, keepFolders: true })
    const n = calls.length
    await expect(store.fetch({ url: 'https://evil.example.com', flavor: 'netbox', filter: '' })).rejects.toThrow(/Enter an API token/)
    expect(calls.length).toBe(n)
    await expect(store.fetch({ url: 'file:///etc/passwd', flavor: 'netbox', filter: '', token: TOKEN })).rejects.toThrow(/http/)
    // A wrong token is not saved over the good one.
    await expect(store.fetch({ url: 'https://nb.example.com', flavor: 'netbox', filter: '', token: 'wrong' })).rejects.toThrow(/Authentication failed/)
    await expect(store.token()).resolves.toBe(TOKEN)
    // Another server, previewed and abandoned: the saved source and its links are untouched.
    repo.linkImport(linkSourceOf('https://nb.example.com'), '1', repo.saveSession({ name: 'sw1', folderId: null, host: '10.0.0.1', port: 22, protocol: 'ssh', platform: 'ios', username: '', credentialId: null, logToFile: false, notes: '', options: {} }).id)
    const other = await store.fetch({ url: 'https://nb2.example.com', flavor: 'netbox', filter: '', token: TOKEN })
    expect(store.source()?.url).toBe('https://nb.example.com')
    expect(repo.importLinks(linkSourceOf('https://nb.example.com'))).toHaveLength(1)
    // Applied: the new server replaces it and the old links go.
    store.commit(other.pending, undefined, { targetFolderId: null, keepFolders: true })
    expect(store.source()?.url).toBe('https://nb2.example.com')
    expect(repo.importLinks(linkSourceOf('https://nb.example.com'))).toHaveLength(0)
    store.forget()
    expect(store.source()).toBeNull()
    await expect(store.token()).resolves.toBeUndefined()
  })
})
