import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { FetchLike } from '@hopline/importers'
import type { SessionImportPlan } from '@shared/types'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { FolderSync } from '../src/main/backup/sync'
import { coreHandlers, type Pickers } from '../src/main/ipc'
import { csvMapping, incompleteFetch } from '../src/main/importer/plan'
import { SettingsService } from '../src/main/settings'
import { ScrollbackStore } from '../src/main/store/scrollback'
import { UnlockBroker } from '../src/main/vault/unlock'
import { Vault } from '../src/main/vault/vault'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} } }))

/** Review findings #8 (NetBox "gone") and #10 (CSV columns holding secrets). */
const FAST = { N: 2 ** 10, r: 8, p: 1 }
const dir = mkdtempSync(join(tmpdir(), 'imprev-'))
const closers: (() => void)[] = []
afterAll(() => {
  for (const c of closers) c()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
let n = 0

const device = (id: number, name: string) => ({ id, name, primary_ip: { address: `10.7.0.${id}/32` }, site: { name: 'AMS1' }, platform: { slug: 'eos' } })

async function setup(csvFile?: string) {
  const db = openDb(join(dir, `p${n++}.db`))
  const m = new Map<string, string>()
  const vault = new Vault({
    settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) },
    keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) },
    kdf: FAST
  })
  await vault.init()
  const repo = new Repo(db, vault.key)
  const state = { short: false }
  // Filter "role=core" only returns device 1; "short" claims 2 devices and returns 1.
  const fetch: FetchLike = async (url) => {
    const all = [device(1, 'nb-sw1'), device(2, 'nb-sw2')]
    const results = state.short || url.includes('role=core') ? all.slice(0, 1) : all
    return { ok: true, status: 200, json: async () => ({ count: state.short ? 2 : results.length, next: null, results }) }
  }
  const pickers: Pickers = {
    openKeyFile: async () => null,
    saveExport: async () => null,
    openExport: async () => null,
    pickDir: async () => null,
    confirm: async () => true,
    openImport: async () => csvFile ?? null,
    sshConfigPath: () => join(dir, 'none')
  }
  const sync = new FolderSync(repo, vault.key, { kdf: FAST })
  const handlers = coreHandlers({
    repo,
    settings: new SettingsService(repo, vault.key),
    audit: new AuditLog(db),
    scrollback: new ScrollbackStore(join(dir, `sb${n}`), vault.key),
    vault,
    unlock: new UnlockBroker(vault, () => {}),
    sync,
    pickers,
    kdf: FAST,
    fetch
  })
  closers.push(() => {
    sync.stop()
    db.close()
  })
  const call = async <T>(ch: string, arg?: unknown): Promise<T> => (await handlers[ch]!.fn(handlers[ch]!.schema.parse(arg) as never, {} as IpcMainInvokeEvent)) as T
  return { repo, call, state }
}

describe('#8 NetBox re-sync never reads filtered-out or missing devices as gone', () => {
  it('a narrower filter offers nothing for removal and says why; the same filter still does', async () => {
    const { call } = await setup()
    const first = await call<SessionImportPlan>('importer:fetchNetBox', { url: 'https://nb.example.com', flavor: 'netbox', filter: 'site=ams1', token: 'T0KEN' })
    expect(first.rows).toHaveLength(2)
    await call('importer:apply', { token: first.token, targetFolderId: null, keepFolders: true, rows: [0, 1], remove: [], platforms: {} })

    const narrow = await call<SessionImportPlan>('importer:fetchNetBox', { url: 'https://nb.example.com', flavor: 'netbox', filter: 'site=ams1&role=core' })
    expect(narrow.gone).toEqual([])
    expect(narrow.warnings.map((w) => w.message).join('\n')).toMatch(/filter differs/)
    await call('importer:cancel', narrow.token)

    // Cancelled, so the saved filter is still site=ams1: a re-sync compares in that scope and finds nothing gone.
    const again = await call<SessionImportPlan>('importer:resyncNetBox')
    expect(again.gone).toEqual([])
    await call('importer:cancel', again.token)
  })

  it('an incomplete fetch fails with a clear error and changes nothing', async () => {
    const { call, state, repo } = await setup()
    const first = await call<SessionImportPlan>('importer:fetchNetBox', { url: 'https://nb.example.com', flavor: 'netbox', filter: '', token: 'T0KEN' })
    await call('importer:apply', { token: first.token, targetFolderId: null, keepFolders: true, rows: [0, 1], remove: [], platforms: {} })
    state.short = true
    await expect(call('importer:resyncNetBox')).rejects.toThrow(/Incomplete device list.*Nothing was changed/)
    expect(repo.listSessions()).toHaveLength(2)
  })

  it('a result flagged or warned as incomplete (older or newer importers) suppresses "gone"', () => {
    expect(incompleteFetch({ folders: [], sessions: [], warnings: [{ item: 'NetBox', message: 'The API reported 5 devices but returned 3' }] })).toBe(true)
    expect(incompleteFetch({ folders: [], sessions: [], warnings: [], incomplete: true } as never)).toBe(true)
    expect(incompleteFetch({ folders: [], sessions: [], warnings: [] })).toBe(false)
  })
})

describe('#10 a CSV column that holds secrets is never mapped', () => {
  it('refuses the reviewer repro mapping (name → the password column), whatever hasHeader says', async () => {
    const text = 'host,name,password\n10.0.0.1,sw1,S3cr3t!\n'
    expect(() => csvMapping({ name: 2 }, text)).toThrow(/Column 3 looks like it holds passwords/)
    expect(() => csvMapping({ notes: 2, host: 0 }, text)).toThrow(/passwords/)
    expect(csvMapping({ name: 1, host: 0 }, text)).toEqual({ name: 1, host: 0 })
    for (const t of ['Enable Secret', 'SNMP community', 'api_token', 'PWD']) expect(() => csvMapping({ name: 0 }, `${t},host\nx,10.0.0.1\n`), t).toThrow()
    // Hostnames that merely contain the letters are fine.
    expect(csvMapping({ name: 0, host: 1 }, 'bypass-gw,10.0.0.1\n')).toEqual({ name: 0, host: 1 })

    const file = join(dir, 'pw.csv')
    writeFileSync(file, text)
    const { call } = await setup(file)
    const p = await call<SessionImportPlan>('importer:pick', { source: 'csv' })
    for (const hasHeader of [true, false])
      await expect(call('importer:plan', { token: p.token, targetFolderId: null, keepFolders: true, csv: { mapping: { name: 2, host: 0 }, hasHeader } })).rejects.toThrow(/passwords/)
    const ok = await call<SessionImportPlan>('importer:plan', { token: p.token, targetFolderId: null, keepFolders: true, csv: { mapping: { name: 1, host: 0 }, hasHeader: true } })
    expect(JSON.stringify(ok)).not.toContain('S3cr3t!')
  })

  it('a headerless file gets a warning that secrets cannot be recognised', async () => {
    const file = join(dir, 'nohead.csv')
    writeFileSync(file, 'edge-1,10.9.0.1,whatever\n')
    const { call } = await setup(file)
    const p = await call<SessionImportPlan>('importer:pick', { source: 'csv' })
    const mapped = await call<SessionImportPlan>('importer:plan', { token: p.token, targetFolderId: null, keepFolders: true, csv: { mapping: { name: 0, host: 1 }, hasHeader: false } })
    expect(mapped.rows).toHaveLength(1)
    expect(mapped.warnings.map((w) => w.message).join('\n')).toMatch(/Row 1 is read as data/)
  })
})
