import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { BackupSchedule } from '@shared/backups'
import type { Session } from '@shared/types'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { BackupService, cleanCapture, summarize } from '../src/main/backups/service'
import { isDue, lastSlot, nextSlot } from '@shared/backup-schedule'
import { BackupStore } from '../src/main/backups/store'
import { DataKey, VaultLockedError } from '../src/main/vault/datakey'
import { fakeTab, localControl } from './helpers'
import type { AgentTab } from '../src/main/host/client'

const key = () => {
  let sealed: Buffer | null = null
  return new DataKey({ load: () => sealed, save: (b) => void (sealed = b), seal: async (p) => Buffer.from(p), unseal: async (b) => Buffer.from(b) })
}

function rig(now = () => Date.now()) {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  const store = new BackupStore(db, key(), now)
  const audit = new AuditLog(db)
  const mk = (p: Partial<Session> = {}) =>
    repo.saveSession({ name: 'core-sw1', folderId: null, host: '127.0.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {}, ...p } as never)
  return { db, repo, store, audit, mk }
}

const CFG = (desc: string, stamp = '03:19:10') => `Building configuration...\n\nCurrent configuration : 4390 bytes\n!\n! Last configuration change at ${stamp} UTC Wed Nov 25 2026\n!\nhostname core-sw1\n!\ninterface Gi1/0/1\n description ${desc}\n!\nsnmp-server community S3cretComm RO\nend`

describe('schedule', () => {
  const at = (s: string) => new Date(s).getTime()
  it('daily: the last slot at or before now, and the next one', () => {
    const s = { cadence: 'daily' as const, weekday: 0, time: '02:30' }
    expect(lastSlot(s, at('2026-11-25T10:00:00'))).toBe(at('2026-11-25T02:30:00'))
    expect(lastSlot(s, at('2026-11-25T01:00:00'))).toBe(at('2026-11-24T02:30:00'))
    expect(nextSlot(s, at('2026-11-25T10:00:00'))).toBe(at('2026-11-26T02:30:00'))
  })
  it('weekly: steps back to the weekday', () => {
    // 2026-11-25 is a Wednesday (3).
    const s = { cadence: 'weekly' as const, weekday: 1, time: '06:00' }
    expect(lastSlot(s, at('2026-11-25T10:00:00'))).toBe(at('2026-11-23T06:00:00'))
    expect(lastSlot({ ...s, weekday: 3 }, at('2026-11-25T05:00:00'))).toBe(at('2026-11-18T06:00:00'))
    expect(nextSlot(s, at('2026-11-25T10:00:00'))).toBe(at('2026-11-30T06:00:00'))
  })
  it('due once per slot; a new schedule waits for its first slot; a missed slot catches up once', () => {
    const base = { cadence: 'daily' as const, weekday: 0, time: '02:00', enabled: true }
    // Created at 10:00: today's 02:00 is before it, so not due until tomorrow.
    const s = { ...base, createdAt: at('2026-11-25T10:00:00'), lastRunAt: null }
    expect(isDue(s, at('2026-11-25T23:00:00'))).toBe(false)
    expect(isDue(s, at('2026-11-26T02:00:30'))).toBe(true)
    expect(isDue({ ...s, lastRunAt: at('2026-11-26T02:00:30') }, at('2026-11-26T09:00:00'))).toBe(false)
    // The app was closed for three days: one catch-up run on start, not three.
    const old = { ...s, lastRunAt: at('2026-11-26T02:00:30') }
    expect(isDue(old, at('2026-11-29T08:00:00'))).toBe(true)
    expect(isDue({ ...old, lastRunAt: at('2026-11-29T08:00:00') }, at('2026-11-29T09:00:00'))).toBe(false)
    expect(isDue({ ...old, enabled: false }, at('2026-11-29T08:00:00'))).toBe(false)
  })
})

describe('backup store', () => {
  it('encrypts at rest: the database holds neither the config nor a plain hash of it', async () => {
    const r = rig()
    const s = r.mk()
    const { version } = await r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG('uplink'), trigger: 'manual', command: 'show running-config' })
    const row = r.db.prepare('SELECT * FROM config_backups').get() as Record<string, unknown>
    const dump = JSON.stringify(row, (_k, v) => (v && typeof v === 'object' && 'type' in v && v.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') : v))
    expect(dump).not.toContain('hostname core-sw1')
    expect(dump).not.toContain('S3cretComm')
    expect((row['content_enc'] as Buffer).includes(Buffer.from('S3cretComm'))).toBe(false)
    expect(await r.store.text(version.id)).toBe(CFG('uplink'))
    // A blob moved to another row does not decrypt (AAD bound to the id).
    r.db.prepare("INSERT INTO config_backups SELECT 'other', session_id, session_name, platform, ts, digest, size, lines, trigger, command, content_enc, hostname, aad_v FROM config_backups").run()
    await expect(r.store.text('other')).rejects.toThrow()
  })

  it('dedupes captures that differ only in noise; a real change is a new version', async () => {
    const r = rig()
    const s = r.mk()
    const add = (text: string) => r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text, trigger: 'manual', command: 'show running-config' })
    expect((await add(CFG('uplink'))).unchanged).toBe(false)
    expect((await add(CFG('uplink', '09:00:00').replace('4390', '4391'))).unchanged).toBe(true)
    expect((await add(CFG('uplink-2'))).unchanged).toBe(false)
    expect(r.store.list(s.id)).toHaveLength(2)
  })

  it('retention keeps the newest N and drops old ones, never the newest', async () => {
    let t = Date.UTC(2026, 0, 1)
    const r = rig(() => t)
    const s = r.mk()
    r.store.setRetention({ keepLast: 3, maxAgeDays: 30 })
    for (let i = 0; i < 5; i++) {
      t += 86_400_000
      await r.store.add({ sessionId: s.id, sessionName: s.name, platform: 'iosxe', text: CFG(`d${i}`), trigger: 'manual', command: 'x' })
    }
    expect(r.store.list(s.id).map((v) => v.lines)).toHaveLength(3)
    t += 365 * 86_400_000
    expect(r.store.prune(s.id)).toBe(2)
    expect(r.store.list(s.id)).toHaveLength(1)
    expect(() => r.store.setRetention({ keepLast: 0, maxAgeDays: 1 })).toThrow()
  })

  it('a locked vault stores nothing', async () => {
    const db = openDb(':memory:')
    const repo = new Repo(db)
    const s = repo.saveSession({ name: 'x', folderId: null, host: 'h', port: 22, protocol: 'ssh', platform: 'ios', username: '', credentialId: null, logToFile: false, notes: '', options: {} } as never)
    const store = new BackupStore(db, new DataKey())
    await expect(store.add({ sessionId: s.id, sessionName: 'x', platform: 'ios', text: CFG('a'), trigger: 'manual', command: 'x' })).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('schedules round-trip; moving the time restarts the clock', () => {
    let t = 1000
    const r = rig(() => t)
    const s = r.store.saveSchedule({ kind: 'tag', target: 'core', cadence: 'daily', weekday: 1, time: '02:00', enabled: true })
    r.store.markRun(s.id, 5000, '1 saved')
    t = 9000
    const same = r.store.saveSchedule({ ...s, enabled: false })
    expect(same).toMatchObject({ createdAt: 1000, lastRunAt: 5000, lastSummary: '1 saved', enabled: false })
    expect(r.store.saveSchedule({ ...s, time: '03:00' }).createdAt).toBe(9000)
    expect(() => r.store.saveSchedule({ ...s, id: 'nope' })).toThrow(/No such schedule/)
  })
})

describe('cleanCapture and summarize', () => {
  it('drops CRs, trailing spaces and blank edges', () => {
    expect(cleanCapture('\r\n\nhostname x  \r\n!\r\n\n')).toBe('hostname x\n!')
  })
  it('summarises a run in words', () => {
    expect(summarize([])).toBe('no sessions')
    expect(summarize([{ sessionId: 'a', sessionName: 'a', outcome: 'saved' }, { sessionId: 'b', sessionName: 'b', outcome: 'skipped' }])).toBe('1 saved, 1 skipped (not connected or unknown platform)')
  })
})

describe('backup service against the simulator', { timeout: 30_000 }, () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeIosDevice(), port: 0 })
  })
  afterAll(() => sim.close())

  it('takes a guarded, audited backup; dedupes; skips sessions without a tab or a platform; shows live redacted', async () => {
    const r = rig()
    const s = r.mk({ name: 'core-sw1' })
    const noTab = r.mk({ name: 'edge-2' })
    const unknown = r.mk({ name: 'mystery', platform: 'auto' })
    const { tab, client, stream } = await fakeTab(sim.port, 24, { id: s.id, name: s.name, platform: 'iosxe' })
    const ctl = localControl(tab)
    const execs: { command: string; kind: string }[] = []
    let changed = 0
    const svc = new BackupService({
      host: { exec: (t, c, k, o) => (execs.push({ command: c, kind: k }), ctl.exec(t, c, k, o)), tabsOf: (id) => (id === s.id ? [tab] : []) },
      repo: r.repo,
      audit: r.audit,
      settings: () => ({ commandTimeoutMs: 10_000, outputCapBytes: 512 * 1024 }),
      store: r.store,
      changed: () => changed++
    })
    try {
      const [first, skipped, unk] = await svc.take([s.id, noTab.id, unknown.id])
      expect(first).toMatchObject({ outcome: 'saved', sessionName: 'core-sw1' })
      expect(skipped).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/not connected/) })
      expect(unk).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/platform is unknown/) })
      // Only the read-only backup command was ever sent, as a read.
      expect(execs).toEqual([{ command: 'show running-config', kind: 'read' }])
      const text = await r.store.text(first!.versionId!)
      expect(text).toMatch(/^Building configuration/)
      expect(text).toContain('hostname core-sw1')
      expect(text.trimEnd()).toMatch(/\nend$/)
      expect(text).not.toContain('core-sw1#')

      // The device's "Last configuration change" timestamp moves on; the config doesn't.
      const again = await svc.take([s.id])
      expect(again[0]).toMatchObject({ outcome: 'unchanged', versionId: first!.versionId })

      // A real change on the device is a new version.
      stream.write('configure terminal\rhostname core-sw9\rend\r')
      await new Promise((res) => setTimeout(res, 400))
      // A rename on the tab is refused (the hostname the executor ran at is checked, review B7)
      // until the user accepts the new name (review B3).
      const renamed = await svc.takeOne(s.id, 'manual')
      expect(renamed).toMatchObject({ outcome: 'skipped', renamed: { from: 'core-sw1', to: 'core-sw9' } })
      const third = await svc.acceptRename(s.id, 'core-sw9')
      expect(third.outcome).toBe('saved')
      expect(r.store.list(s.id)).toHaveLength(2)
      expect(changed).toBeGreaterThan(0)

      // The renderer view and "compare with live" are redacted.
      const view = await svc.view(third.versionId!)
      expect(view.text).toContain('hostname core-sw9')
      expect(view.redactions).toBeGreaterThan(0)
      expect(view.text).not.toMatch(/key 7 [0-9A-F]{6,}/)
      const live = await svc.live(s.id)
      expect(live.id).toBeNull()
      expect(live.text).toContain('hostname core-sw9')
      expect(r.store.list(s.id)).toHaveLength(2)

      // Every attempt is in the audit log as source "backup".
      const rows = r.audit.list(50).filter((a) => a.source === 'backup')
      // + the refused rename and the accepted one (kind "binding", approver set).
      expect(rows.map((a) => a.decision).sort()).toEqual(['executed', 'executed', 'executed', 'executed', 'executed', 'refused', 'refused', 'refused'].sort())
      expect(rows.find((a) => a.kind === 'binding')).toMatchObject({ command: 'device renamed: accept core-sw9', approver: expect.any(String) })
      expect(rows.find((a) => /unchanged/.test(a.reason))).toBeTruthy()
      expect(rows.find((a) => /compare with live/.test(a.reason))).toBeTruthy()
    } finally {
      client.end()
    }
  })

  it('schedules cover a folder tree or a tag, and a due schedule runs once', async () => {
    let t = new Date('2026-11-25T10:00:00').getTime()
    const r = rig(() => t)
    const dc = r.repo.saveFolder({ name: 'DC', parentId: null })
    const rack = r.repo.saveFolder({ name: 'Rack 1', parentId: dc.id })
    const a = r.mk({ name: 'a', folderId: rack.id })
    const b = r.mk({ name: 'b', folderId: null, tags: ['core'] } as Partial<Session>)
    const seen: string[][] = []
    const svc = new BackupService({ host: { exec: async () => ({ status: 'error', output: '', durationMs: 0, bytes: 0 }), tabsOf: () => [] }, repo: r.repo, audit: r.audit, settings: () => ({ commandTimeoutMs: 1, outputCapBytes: 1 }), store: r.store, now: () => t })
    expect(svc.targets({ kind: 'folder', target: dc.id }).map((x) => x.id)).toEqual([a.id])
    expect(svc.targets({ kind: 'tag', target: 'CORE' }).map((x) => x.id)).toEqual([b.id])
    const orig = svc.take.bind(svc)
    svc.take = async (ids, trig) => (seen.push(ids), orig(ids, trig))
    const sched = r.store.saveSchedule({ kind: 'folder', target: dc.id, cadence: 'daily', weekday: 0, time: '02:00', enabled: true })
    await svc.tick()
    expect(seen).toHaveLength(0)
    t = new Date('2026-11-26T02:01:00').getTime()
    await svc.tick()
    await svc.tick()
    expect(seen).toEqual([[a.id]])
    expect(r.store.schedules().find((x: BackupSchedule) => x.id === sched.id)).toMatchObject({ lastRunAt: t, lastSummary: '1 skipped (not connected or unknown platform); 1 will be backed up when they connect' })
    expect(svc.pendingSessions()).toEqual([a.id])
  })

  it('a slot missed for lack of a connection (catch-up on start) is taken when the session connects', async () => {
    let t = new Date('2026-11-26T09:00:00').getTime()
    const r = rig(() => t)
    const s = r.mk({ name: 'core-sw1', tags: ['core'] } as Partial<Session>)
    let tabs: AgentTab[] = []
    const { tab, client } = await fakeTab(sim.port, 24, { id: s.id, name: s.name, platform: 'iosxe' })
    const ctl = localControl(tab)
    const svc = new BackupService({ host: { exec: (x, c, k, o) => ctl.exec(x, c, k, o), tabsOf: () => tabs }, repo: r.repo, audit: r.audit, settings: () => ({ commandTimeoutMs: 10_000, outputCapBytes: 512 * 1024 }), store: r.store, now: () => t })
    try {
      // The app starts after the 02:00 slot was missed: the catch-up tick finds nothing connected.
      r.store.saveSchedule({ kind: 'tag', target: 'core', cadence: 'daily', weekday: 0, time: '02:00', enabled: true })
      t = new Date('2026-11-27T09:00:00').getTime()
      await svc.tick()
      expect(r.store.list(s.id)).toHaveLength(0)
      expect(svc.pendingSessions()).toEqual([s.id])
      // Another session connecting changes nothing; this one connecting takes the backup, once.
      expect(await svc.onConnected('other', [0])).toBeUndefined()
      tabs = [tab]
      const res = await svc.onConnected(s.id, [0])
      expect(res).toMatchObject({ outcome: 'saved' })
      expect(r.store.list(s.id)).toHaveLength(1)
      expect(svc.pendingSessions()).toEqual([])
      expect(await svc.onConnected(s.id, [0])).toBeUndefined()
    } finally {
      client.end()
    }
  })
  it('R2: a session without a tab is backed up over a background connection, always closed, audited, redacted', async () => {
    const r = rig()
    const s = r.mk({ name: 'core-sw1' })
    const signIn = r.mk({ name: 'needs-pw' })
    const tel = r.mk({ name: 'old-telnet', protocol: 'telnet' } as Partial<Session>)
    const { tab, client } = await fakeTab(sim.port, 24, { id: s.id, name: s.name, platform: 'iosxe' })
    const ctl = localControl(tab)
    const opened: string[] = []
    const closed: string[] = []
    const execs: string[] = []
    const svc = new BackupService({
      host: {
        exec: (t, c, k, o) => (execs.push(`${t.tabId} ${k} ${c}`), ctl.exec(t, c, k, o)),
        tabsOf: () => [],
        openBackground: async (id) => {
          opened.push(id)
          if (id === signIn.id) throw new Error('no prompt (the device may want a typed sign-in)')
          return tab
        },
        close: (id) => closed.push(id)
      },
      repo: r.repo,
      audit: r.audit,
      settings: () => ({ commandTimeoutMs: 10_000, outputCapBytes: 512 * 1024 }),
      store: r.store
    })
    try {
      const [ok, pw, telnet] = await svc.take([s.id, signIn.id, tel.id], 'scheduled')
      expect(ok).toMatchObject({ outcome: 'saved', sessionName: 'core-sw1' })
      // Stored credentials only: a device that wants a typed sign-in is skipped, never prompted.
      expect(pw).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/^not connected: a background connection failed/) })
      // Telnet sign-in is typed at the device: no background connection is even tried.
      expect(telnet).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/telnet/) })
      expect(opened.sort()).toEqual([s.id, signIn.id].sort())
      // The background connection is closed after the capture; only the read-only command was sent.
      expect(closed).toEqual([tab.tabId])
      expect(execs).toEqual([`${tab.tabId} read show running-config`])
      const rows = r.audit.list(50).filter((a) => a.source === 'backup')
      expect(rows.find((a) => a.decision === 'executed' && /background connection/.test(a.reason))).toBeTruthy()
      expect(rows.filter((a) => a.decision === 'refused')).toHaveLength(2)
      // What the renderer sees is redacted.
      const view = await svc.view(ok!.versionId!)
      expect(view.redactions).toBeGreaterThan(0)
      expect(view.text).not.toMatch(/key 7 [0-9A-F]{6,}/)
    } finally {
      client.end()
    }
  })

  it('R2: the background connection is closed even when the capture fails', async () => {
    const r = rig()
    const s = r.mk({ name: 'core-sw1' })
    const closed: string[] = []
    const bg = { tabId: 'bg-1', session: s } as unknown as AgentTab
    const svc = new BackupService({
      host: { exec: async () => ({ status: 'timeout', output: '', durationMs: 5, bytes: 0, error: 'timed out' }), tabsOf: () => [], openBackground: async () => bg, close: (id) => closed.push(id) },
      repo: r.repo,
      audit: r.audit,
      settings: () => ({ commandTimeoutMs: 1, outputCapBytes: 1 }),
      store: r.store
    })
    const [res] = await svc.take([s.id], 'scheduled')
    expect(res).toMatchObject({ outcome: 'failed' })
    expect(closed).toEqual(['bg-1'])
    expect(r.audit.list(10).find((a) => a.source === 'backup' && a.decision === 'timeout' && /background connection/.test(a.reason))).toBeTruthy()
  })
})
