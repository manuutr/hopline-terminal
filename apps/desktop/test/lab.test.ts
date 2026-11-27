import { seedDevelopmentSessions } from '../src/main/lab'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { releaseInventory, visibleDevices } from '../src/main/db/legacy-lab'
import { resolveMentions } from '../src/main/fleet/mentions'
import { LAB_FOLDER, SimulatorLab } from '../src/main/lab'
import { DataKey } from '../src/main/vault/datakey'
import { randomBytes } from 'node:crypto'

const dir = mkdtempSync(join(tmpdir(), 'hopline-lab-'))
const labs: SimulatorLab[] = []
afterAll(async () => {
  await Promise.all(labs.map((l) => l.stop()))
  rmSync(dir, { recursive: true, force: true })
})

/** Connect with a plain ssh2 client; resolve with the server's key fingerprint and the first output. */
function probe(port: number): Promise<{ fp: string; banner: string }> {
  return new Promise((resolve, reject) => {
    let fp = ''
    const c = new Client()
    c.on('ready', () =>
      c.shell((err, ch) => {
        if (err) return reject(err)
        let out = ''
        ch.on('data', (d: Buffer) => {
          out += d.toString()
          if (/#\s*$/.test(out)) (c.end(), resolve({ fp, banner: out }))
        })
      })
    )
    c.on('error', reject)
    c.connect({
      host: '127.0.0.1',
      port,
      username: 'admin',
      password: 'admin',
      hostVerifier: (key: Buffer) => ((fp = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')), true)
    })
  })
}

describe('bundled simulator lab', () => {
  it('starts on loopback, points the lab sessions at it and trusts its key for exactly those ports', async () => {
    const repo = new Repo(openDb(':memory:'))
    await seedDevelopmentSessions(repo)
    const seeded = repo.listSessions()
    const ownFirewall = repo.saveSession({ ...seeded[0]!, id: undefined, name: 'fw1', platform: 'panos', port: 33221 })
    const lab = new SimulatorLab(repo, join(dir, 'lab_host_key'))
    labs.push(lab)
    const info = await lab.start()
    expect(info.running).toBe(true)
    const sessions = info.sessionIds.map((id) => repo.getSession(id)!)
    expect(sessions.map((s) => s.name)).toEqual(['core-sw1', 'dist-eos1', 'core-sw1 (telnet)', 'fgt-edge1', 'fw1'])
    for (const s of sessions) expect(s.host).toBe('127.0.0.1')
    expect(info.sessionIds).toEqual(expect.arrayContaining(seeded.map((s) => s.id)))
    expect(info.sessionIds).not.toContain(ownFirewall.id)
    expect(repo.getSession(ownFirewall.id)?.port).toBe(33221)
    // The seeded sessions were re-pointed, not duplicated.
    expect(repo.listSessions().filter((s) => s.name === 'core-sw1')).toHaveLength(1)
    const keys = repo.listHostKeys()
    const ssh = sessions.filter((s) => s.protocol === 'ssh')
    expect(keys.map((k) => k.port).sort()).toEqual(ssh.map((s) => s.port).sort())
    // The trusted fingerprint is the one the server really presents.
    const { fp, banner } = await probe(ssh[0]!.port)
    expect(keys.find((k) => k.port === ssh[0]!.port)!.fingerprint).toBe(fp)
    expect(banner).toMatch(/core-sw1#/)
    // The key is kept, private.
    if (process.platform !== 'win32') expect(statSync(join(dir, 'lab_host_key')).mode & 0o077).toBe(0)
    // Starting again is a no-op.
    expect(await lab.start()).toEqual(info)
  })

  it('keeps its host key across restarts and recreates a deleted lab folder', async () => {
    const repo = new Repo(openDb(':memory:'))
    const a = new SimulatorLab(repo, join(dir, 'lab_host_key'))
    labs.push(a)
    const first = await a.start()
    const fp1 = repo.listHostKeys()[0]!.fingerprint
    await a.stop()
    expect(a.info().running).toBe(false)
    // The user deleted the whole lab folder: it comes back.
    const folder = repo.listFolders().find((f) => f.name === LAB_FOLDER)!
    repo.removeMany({ sessionIds: first.sessionIds, folderIds: [folder.id] })
    const b = new SimulatorLab(repo, join(dir, 'lab_host_key'))
    labs.push(b)
    const second = await b.start()
    expect(second.sessionIds).toHaveLength(5)
    expect(repo.listFolders().filter((f) => f.name === LAB_FOLDER)).toHaveLength(1)
    const port = repo.getSession(second.sessionIds[0]!)!.port
    expect(repo.listHostKeys().find((k) => k.port === port)!.fingerprint).toBe(fp1)
    const { fp } = await probe(port)
    expect(fp).toBe(fp1)
  })

  it('without an OS keychain, a restart makes the seeded lab login unreadable: the lab writes it again', async () => {
    // A session-only vault: a new random data key every run.
    const key = (k = new DataKey()) => (k.setKey(randomBytes(32)), k)
    const db = openDb(':memory:')
    const first = new Repo(db, key())
    await seedDevelopmentSessions(first)
    const cred = first.listCredentials().find((c) => c.name === 'Simulator admin')!
    expect((await first.resolveCredential(cred.id))?.secret).toBe('admin')
    // Next run: same database, another key. The old secret no longer decrypts.
    const repo = new Repo(db, key())
    await expect(repo.resolveCredential(cred.id)).rejects.toThrow()
    const lab = new SimulatorLab(repo, join(dir, 'lab_host_key_nokc'))
    labs.push(lab)
    await lab.start()
    expect((await repo.resolveCredential(cred.id))?.secret).toBe('admin')
    // A locked vault is left alone: nothing to write with.
    const locked = new Repo(db, new DataKey())
    const lab2 = new SimulatorLab(locked, join(dir, 'lab_host_key_locked'))
    labs.push(lab2)
    await lab.stop()
    await expect(lab2.start()).resolves.toMatchObject({ running: true })
  })
})

describe('release inventory after a simulator upgrade', () => {
  it('hides only the original bookmarks and their dedicated login, including profiles without a manifest', async () => {
    const db = openDb(':memory:')
    try {
      const key = new DataKey()
      key.setKey(randomBytes(32))
      const repo = new Repo(db, key)
      await seedDevelopmentSessions(repo)
      const [folder] = repo.listFolders()
      const [login] = repo.listCredentials()
      const core = repo.listSessions().find((s) => s.name === 'core-sw1')!
      // Older installations recorded default ports and notes, but no generated IDs.
      repo.setSetting('ux.lab', 'null')
      const hidden = releaseInventory(repo)
      expect(hidden.sessions).toEqual([])
      expect(hidden.folders).toEqual([])
      expect(hidden.hiddenCredentials).toEqual(new Set([login!.id]))
      expect(repo.listSessions()).toHaveLength(3)
      const devices = visibleDevices(repo, false)
      expect(devices.getSession(core.id)).toBeUndefined()
      expect(devices.listFolders()).toEqual([])
      expect(resolveMentions('@core-sw1', null, devices).errors).toHaveLength(1)
      expect(resolveMentions('@core-sw1', null, visibleDevices(repo, true)).errors).toEqual([])

      // Keep an edited session, a shared login, and a nested user folder accessible.
      repo.saveSession({ ...core, port: 4022 })
      const nested = repo.saveFolder({ name: 'My devices', parentId: folder!.id })
      const shown = releaseInventory(repo)
      expect(shown.sessions.map((s) => s.id)).toEqual([core.id])
      expect(shown.folders.map((f) => f.id)).toEqual(expect.arrayContaining([folder!.id, nested.id]))
      expect(shown.hiddenCredentials.size).toBe(0)
      expect(devices.getSession(core.id)?.port).toBe(4022)
      expect(resolveMentions('@core-sw1', null, devices).errors).toEqual([])

      // A later lab tracked dynamic ports by id. Cloning a bookmark does not grant it that id.
      repo.setSetting('ux.lab', JSON.stringify({ folderId: folder!.id, sessions: { [core.name]: core.id } }))
      const clone = repo.saveSession({ ...core, id: undefined, port: 4022 })
      expect(releaseInventory(repo).sessions.map((s) => s.id)).toEqual([clone.id])
    } finally { db.close() }
  })
})
