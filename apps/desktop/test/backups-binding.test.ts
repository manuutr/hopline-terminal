import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { Session } from '@shared/types'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { BackupService } from '../src/main/backups/service'
import { backupAad, BackupStore } from '../src/main/backups/store'
import { DataKey } from '../src/main/vault/datakey'
import type { AgentTab } from '../src/main/host/client'
import { fakeTab, localControl } from './helpers'

const key = () => {
  let sealed: Buffer | null = null
  return new DataKey({ load: () => sealed, save: (b) => void (sealed = b), seal: async (p) => Buffer.from(p), unseal: async (b) => Buffer.from(b) })
}

function rig() {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  const k = key()
  const store = new BackupStore(db, k)
  const audit = new AuditLog(db)
  const mk = (p: Partial<Session> = {}) =>
    repo.saveSession({ name: 'core-sw1', folderId: null, host: '127.0.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {}, ...p } as never)
  return { db, repo, store, audit, mk, key: k }
}

const settings = () => ({ commandTimeoutMs: 10_000, outputCapBytes: 512 * 1024 })
const CFG = (host: string) => `Building configuration...\n\nCurrent configuration : 4390 bytes\n!\nhostname ${host}\n!\ninterface Gi1/0/1\n description x\n!\nend`
const backupRows = (r: ReturnType<typeof rig>) => r.audit.list(50).filter((a) => a.source === 'backup')

// Phase 4 review M3(b): a tab that hopped to another device must not be backed up as this session.
describe('backups are bound to the device hostname', { timeout: 30_000 }, () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeIosDevice(), port: 0 })
  })
  afterAll(() => sim.close())

  it('records the prompt hostname; a tab that now shows another hostname is refused, audited, not stored', async () => {
    const r = rig()
    const s = r.mk({ name: 'core-sw1' })
    const { tab, client, stream } = await fakeTab(sim.port, 24, { id: s.id, name: s.name, platform: 'iosxe' })
    const ctl = localControl(tab)
    const svc = new BackupService({ host: { exec: (t, c, k, o) => ctl.exec(t, c, k, o), prompt: (t) => ctl.prompt(t), tabsOf: () => [tab] }, repo: r.repo, audit: r.audit, settings, store: r.store })
    try {
      const [first] = await svc.take([s.id])
      expect(first).toMatchObject({ outcome: 'saved' })
      expect(r.store.lastHostname(s.id)).toBe('core-sw1')
      // A change that keeps the hostname is a new version (the e2e flow).
      stream.write('configure terminal\rinterface GigabitEthernet1/0/2\rdescription e2e-uplink-9\rend\r')
      await new Promise((res) => setTimeout(res, 400))
      const [changed] = await svc.take([s.id])
      expect(changed).toMatchObject({ outcome: 'saved' })
      expect(await r.store.text(changed!.versionId!)).toContain('description e2e-uplink-9')
      // The prompt now shows another device (here: the same simulator renamed, as a hop would look).
      stream.write('configure terminal\rhostname other-rtr\rend\r')
      await new Promise((res) => setTimeout(res, 400))
      const [hop] = await svc.take([s.id])
      expect(hop).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/prompt shows "other-rtr".*came from "core-sw1"/) })
      expect(r.store.list(s.id)).toHaveLength(2)
      await expect(svc.live(s.id)).rejects.toThrow(/other-rtr/)
      expect(backupRows(r).filter((a) => a.decision === 'refused' && /not stored \(the device prompt shows "other-rtr"/.test(a.reason))).toHaveLength(2)
    } finally {
      client.end()
    }
  })

  it('a background connection (straight to the host) accepts a rename the configuration itself shows, nothing else', async () => {
    const r = rig()
    const s = r.mk({ name: 'core-sw1' })
    await r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG('core-sw1'), trigger: 'manual', command: 'show running-config', hostname: 'core-sw1' })
    let shown = 'core-sw2'
    let config = CFG('core-sw2')
    const bg = { tabId: 'bg-1', session: s } as unknown as AgentTab
    const svc = new BackupService({
      host: {
        exec: async () => ({ status: 'ok', output: config, durationMs: 1, bytes: config.length }),
        prompt: async () => ({ mode: 'exec', prompt: `${shown}#`, hostname: shown }),
        tabsOf: () => [],
        openBackground: async () => bg,
        close: () => {}
      },
      repo: r.repo,
      audit: r.audit,
      settings,
      store: r.store
    })
    expect((await svc.take([s.id], 'scheduled'))[0]).toMatchObject({ outcome: 'saved' })
    expect(r.store.lastHostname(s.id)).toBe('core-sw2')
    // The prompt and the configuration disagree: refused.
    shown = 'core-sw3'
    config = CFG('somewhere-else')
    expect((await svc.take([s.id], 'scheduled'))[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/came from "core-sw2"/) })
    expect(r.store.list(s.id)).toHaveLength(2)
  })

  it('a tab that shows another device falls back to a background connection to the session host', async () => {
    const r = rig()
    const s = r.mk({ name: 'core-sw1' })
    await r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG('core-sw1'), trigger: 'manual', command: 'show running-config', hostname: 'core-sw1' })
    const userTab = { tabId: 'tab-1', session: s } as unknown as AgentTab
    const bg = { tabId: 'bg-1', session: s } as unknown as AgentTab
    const used: string[] = []
    const svc = new BackupService({
      host: {
        // The user's tab hopped to dist-9; the background connection reaches core-sw1 itself.
        exec: async (t) => (used.push(t.tabId), { status: 'ok', output: t.tabId === 'bg-1' ? CFG('core-sw1') : CFG('dist-9'), durationMs: 1, bytes: 1 }),
        prompt: async (t) => ({ mode: 'exec', prompt: '', hostname: t.tabId === 'bg-1' ? 'core-sw1' : 'dist-9' }),
        tabsOf: () => [userTab],
        openBackground: async () => bg,
        close: () => {}
      },
      repo: r.repo,
      audit: r.audit,
      settings,
      store: r.store
    })
    const [res] = await svc.take([s.id])
    expect(used).toEqual(['tab-1', 'bg-1'])
    expect(res).toMatchObject({ outcome: 'unchanged' })
    expect(backupRows(r).map((a) => a.decision).sort()).toEqual(['executed', 'refused'])
  })

  it('a version from before hostnames were recorded learns its hostname on the next unchanged capture', async () => {
    const r = rig()
    const s = r.mk()
    await r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG('core-sw1'), trigger: 'manual', command: 'show running-config' })
    expect(r.store.lastHostname(s.id)).toBeNull()
    expect((await r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG('core-sw1'), trigger: 'manual', command: 'show running-config', hostname: 'core-sw1' })).unchanged).toBe(true)
    expect(r.store.lastHostname(s.id)).toBe('core-sw1')
  })
})

// Phase 4 review Low 1: backups:take / backups:live only drive a tab of the asking window.
describe('backups use only the asking window\'s tabs', () => {
  it('another window\'s tab is not used: the background connection is', async () => {
    const r = rig()
    const s = r.mk()
    const userTab = { tabId: 'tab-other-window', session: s } as unknown as AgentTab
    const bg = { tabId: 'bg-1', session: s } as unknown as AgentTab
    const used: string[] = []
    const mine = {}
    const theirs = {}
    const svc = new BackupService({
      host: {
        exec: async (t) => (used.push(t.tabId), { status: 'ok', output: CFG('core-sw1'), durationMs: 1, bytes: 1 }),
        tabsOf: () => [userTab],
        ownedBy: (tabId, owner) => tabId === userTab.tabId && owner === theirs,
        openBackground: async () => bg,
        close: () => {}
      },
      repo: r.repo,
      audit: r.audit,
      settings,
      store: r.store
    })
    await svc.take([s.id], 'manual', mine)
    expect(used).toEqual(['bg-1'])
    await svc.live(s.id, theirs)
    expect(used).toEqual(['bg-1', 'tab-other-window'])
  })
})

// Phase 4 review Low 6: the backup AAD binds the session and the version.
describe('backup AAD binds the session id and the version id', () => {
  it('new rows use the v2 AAD; a row moved to another session no longer decrypts', async () => {
    const r = rig()
    const a = r.mk({ name: 'a' })
    const b = r.mk({ name: 'b' })
    const { version } = await r.store.add({ sessionId: a.id, sessionName: 'a', platform: 'iosxe', text: CFG('a'), trigger: 'manual', command: 'show running-config' })
    expect(r.db.prepare('SELECT aad_v FROM config_backups WHERE id = ?').get(version.id)).toEqual({ aad_v: 2 })
    expect(await r.store.text(version.id)).toBe(CFG('a'))
    r.db.prepare('UPDATE config_backups SET session_id = ? WHERE id = ?').run(b.id, version.id)
    await expect(r.store.text(version.id)).rejects.toThrow()
  })

  it('migrates v1 rows (decrypt with the old AAD, re-encrypt); a v1 row found after the sweep is re-bound and audited (B4, B5)', async () => {
    const r = rig()
    r.store = new BackupStore(r.db, r.key, Date.now, r.audit)
    const s = r.mk()
    const insertV1 = async (id: string, text: string) => {
      const enc = await r.key.encrypt(gzipSync(Buffer.from(text)), backupAad(1, s.id, id))
      r.db
        .prepare(`INSERT INTO config_backups (id, session_id, session_name, platform, ts, digest, size, lines, trigger, command, content_enc) VALUES (?, ?, 'x', 'iosxe', ?, ?, 1, 1, 'manual', 'show running-config', ?)`)
        .run(id, s.id, Date.now(), `d-${id}`, enc)
    }
    await insertV1('old-1', CFG('one'))
    await insertV1('old-2', CFG('two'))
    // Read before the sweep: re-encrypted on the way.
    expect(await r.store.text('old-1')).toBe(CFG('one'))
    expect(r.db.prepare('SELECT aad_v FROM config_backups WHERE id = ?').get('old-1')).toEqual({ aad_v: 2 })
    expect(await r.store.migrateAad()).toEqual({ migrated: 1, failed: 0 })
    expect(await r.store.text('old-2')).toBe(CFG('two'))
    expect(r.db.prepare('SELECT COUNT(*) AS n FROM config_backups WHERE aad_v = 1').get()).toEqual({ n: 0 })
    // Nothing so far is a late migration.
    expect(r.audit.list(50).filter((a) => a.kind === 'migration')).toHaveLength(0)
    // After the sweep, a v1 row (an older Hopline after a downgrade, or written into the database)
    // still reads (B4: no unreadable row), is re-bound to the session it sits in, and is audited (B5).
    await insertV1('late', CFG('late'))
    expect(await r.store.text('late')).toBe(CFG('late'))
    expect(r.db.prepare('SELECT aad_v FROM config_backups WHERE id = ?').get('late')).toEqual({ aad_v: 2 })
    await insertV1('late-2', CFG('late2'))
    expect(await r.store.migrateAad()).toEqual({ migrated: 1, failed: 0 })
    const late = r.audit.list(50).filter((a) => a.kind === 'migration')
    expect(late.map((a) => a.command).sort()).toEqual(['re-encrypt config version late', 're-encrypt config version late-2'])
    expect(late.every((a) => a.sessionName === 'x' && a.source === 'backup')).toBe(true)
  })

  it('B6: a failed re-encryption does not fail the read', async () => {
    const r = rig()
    const s = r.mk()
    const enc = await r.key.encrypt(gzipSync(Buffer.from(CFG('one'))), backupAad(1, s.id, 'old-1'))
    r.db
      .prepare(`INSERT INTO config_backups (id, session_id, session_name, platform, ts, digest, size, lines, trigger, command, content_enc) VALUES (?, ?, 'x', 'iosxe', ?, 'd', 1, 1, 'manual', 'show running-config', ?)`)
      .run('old-1', s.id, Date.now(), enc)
    const orig = r.key.encrypt.bind(r.key)
    r.key.encrypt = async () => {
      throw new Error('disk full')
    }
    expect(await r.store.text('old-1')).toBe(CFG('one'))
    r.key.encrypt = orig
    expect(r.db.prepare('SELECT aad_v FROM config_backups WHERE id = ?').get('old-1')).toEqual({ aad_v: 1 })
  })

  it('B4: a newest version that does not decrypt is not "unchanged": a readable copy is stored', async () => {
    const r = rig()
    const s = r.mk()
    const add = () => r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG('one'), trigger: 'manual', command: 'show running-config', hostname: 'one' })
    const { version } = await add()
    r.db.prepare('UPDATE config_backups SET content_enc = ? WHERE id = ?').run(Buffer.from('garbage-garbage-garbage-garbage-garbage'), version.id)
    const again = await add()
    expect(again.unchanged).toBe(false)
    expect(await r.store.text(again.version.id)).toBe(CFG('one'))
    // And a readable newest version is still deduplicated.
    expect((await add()).unchanged).toBe(true)
  })
})
