import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { MAX_FILE_BYTES } from '../src/main/backup/format'
import { FolderSync, readSyncFile, SYNC_FILE } from '../src/main/backup/sync'
import { Vault } from '../src/main/vault/vault'

/** Review findings #3, #6 and #13: the sync folder is shared, so nothing planted there is followed. */
const FAST = { N: 2 ** 10, r: 8, p: 1 }
const dir = mkdtempSync(join(tmpdir(), 'syncf-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const posix = process.platform !== 'win32'
let n = 0

async function profile() {
  const m = new Map<string, string>()
  const db = openDb(join(dir, `p${n++}.db`))
  const vault = new Vault({
    settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) },
    keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) },
    kdf: FAST
  })
  await vault.init()
  return { db, vault, repo: new Repo(db, vault.key) }
}
const fresh = (name: string) => {
  const d = join(dir, name)
  mkdirSync(d)
  return d
}

describe.runIf(posix)('sync writes never follow a planted path', () => {
  it('#3: a symlink at the old fixed .tmp name is left alone (the reviewer repro)', async () => {
    const p = await profile()
    const syncDir = fresh('tmp-link')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'IMPORTANT')
    symlinkSync(victim, join(syncDir, SYNC_FILE + '.tmp'))
    const s = new FolderSync(p.repo, p.vault.key, { kdf: FAST, debounceMs: 1 })
    await s.enable(syncDir, 'sync-passphrase', false)
    s.stop()
    expect(readFileSync(victim, 'utf8')).toBe('IMPORTANT')
    expect(readFileSync(join(syncDir, SYNC_FILE)).subarray(0, 40).toString()).toContain('hopline-export')
    // No tmp file is left behind.
    expect(readdirSync(syncDir).filter((f) => f.endsWith('.tmp') && f !== SYNC_FILE + '.tmp')).toEqual([])
    p.db.close()
  })

  it('#3/#6: a symlink as the sync file itself is neither read nor replaced', async () => {
    const p = await profile()
    const syncDir = fresh('dst-link')
    const victim = join(dir, 'victim2.txt')
    writeFileSync(victim, 'IMPORTANT')
    symlinkSync(victim, join(syncDir, SYNC_FILE))
    const s = new FolderSync(p.repo, p.vault.key, { kdf: FAST, debounceMs: 1 })
    await expect(s.enable(syncDir, 'sync-passphrase', false)).rejects.toThrow(/not a regular file/)
    expect(readFileSync(victim, 'utf8')).toBe('IMPORTANT')
    s.stop()
    p.db.close()
  })

  it('#6: a FIFO is refused without blocking, an oversized file without reading it', async () => {
    const d = fresh('odd')
    const fifo = join(d, 'fifo')
    execFileSync('mkfifo', [fifo])
    await expect(readSyncFile(fifo)).rejects.toThrow(/not a regular file/)
    const big = join(d, 'big')
    writeFileSync(big, '')
    truncateSync(big, MAX_FILE_BYTES + 1)
    await expect(readSyncFile(big)).rejects.toThrow(/too large/)
    expect(await readSyncFile(join(d, 'absent'))).toBeNull()
  })

  it('#6: check() reports a non-regular sync file as an error, not as incoming', async () => {
    const p = await profile()
    const syncDir = fresh('check')
    const s = new FolderSync(p.repo, p.vault.key, { kdf: FAST, debounceMs: 1e9 })
    await s.enable(syncDir, 'sync-passphrase', false)
    rmSync(join(syncDir, SYNC_FILE))
    mkdirSync(join(syncDir, SYNC_FILE))
    await s.check()
    expect(s.status()).toMatchObject({ incoming: null, error: expect.stringMatching(/not a regular file/) })
    await expect(s.readIncoming()).rejects.toThrow(/not a regular file/)
    s.stop()
    p.db.close()
  })

  it('#13: the rename is skipped when the file changed while the export was sealed', async () => {
    const p = await profile()
    const syncDir = fresh('race')
    const s = new FolderSync(p.repo, p.vault.key, { kdf: FAST, debounceMs: 1e9 })
    await s.enable(syncDir, 'sync-passphrase', false)
    const f = join(syncDir, SYNC_FILE)
    writeFileSync(f, 'written by another machine meanwhile')
    const replace = (s as unknown as { replace: (f: string, d: string, b: Buffer, h: string | null) => Promise<boolean> }).replace.bind(s)
    expect(await replace(f, syncDir, Buffer.from('ours'), 'the-hash-we-read-before')).toBe(false)
    expect(readFileSync(f, 'utf8')).toBe('written by another machine meanwhile')
    expect(readdirSync(syncDir)).toEqual([SYNC_FILE])
    s.stop()
    p.db.close()
  })
})
