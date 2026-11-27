import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeDevice, startSim, type RunningSim, type SimPlatform } from '../../../packages/simulator/src/index.ts'
import type { MultiEvent } from '@shared/productivity'
import type { AuditRow, Session } from '@shared/types'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { AgentTab } from '../src/main/host/client'
import { MultiService, type MultiHost } from '../src/main/productivity/multi'
import { registerParser } from '../src/main/productivity/parsers'
import { GuardedRunner } from '../src/main/productivity/runner'
import { fakeTab, localControl } from './helpers'

const sims = new Map<string, RunningSim>()
const OWNER = {}
const PLATS: [SimPlatform, Session['platform']][] = [
  ['ios', 'iosxe'],
  ['eos', 'eos'],
  ['junos', 'junos'],
  ['nxos', 'nxos']
]
beforeAll(async () => {
  for (const [p] of PLATS) sims.set(p, await startSim({ device: makeDevice(p), port: 0 }))
})
afterAll(async () => {
  for (const s of sims.values()) await s.close()
})

const session = (id: string, platform: Session['platform'], extra: Partial<Session> = {}): Session =>
  ({ id, name: id, host: '127.0.0.1', port: sims.get(id)?.port ?? 1, protocol: 'ssh', platform, username: 'admin', credentialId: null, folderId: 'lab', tags: ['lab'], logToFile: false, notes: '', options: {}, ...extra }) as Session

/** A session host made of in-process ssh shells: one per "background connection". */
function world(sessions: Session[], prefs: Record<string, unknown> = {}) {
  type T = Awaited<ReturnType<typeof fakeTab>>
  const tabs = new Map<string, { t: T; ctl: ReturnType<typeof localControl>; owner: object | null }>()
  let seq = 0
  const opened: string[] = []
  const closed: string[] = []
  const host: MultiHost = {
    get: (id) => tabs.get(id)?.t.tab,
    exec: (tab, ...rest) => tabs.get(tab.tabId)!.ctl.exec(tab, ...rest),
    mode: (tab) => tabs.get(tab.tabId)!.ctl.mode(tab),
    prompt: (tab) => tabs.get(tab.tabId)?.ctl.prompt(tab) ?? Promise.resolve({ mode: 'unknown', prompt: '', hostname: '' }),
    tabsOf: (sid) => [...tabs.values()].filter((x) => x.owner && x.t.tab.session.id === sid).map((x) => x.t.tab as AgentTab),
    ownedBy: (id, owner) => tabs.get(id)?.owner === owner,
    close: (id) => {
      closed.push(id)
      tabs.get(id)?.t.client.end()
      tabs.delete(id)
    },
    openBackground: async (sid) => {
      const s = sessions.find((x) => x.id === sid)!
      if (s.id === 'down') throw new Error('connection refused')
      const tabId = `bg-${++seq}`
      const t = await fakeTab(sims.get(s.id)!.port, 24, s)
      ;(t.raw as { tabId: string }).tabId = tabId
      await new Promise((r) => setTimeout(r, 150))
      tabs.set(tabId, { t, ctl: localControl(t.tab), owner: null })
      opened.push(tabId)
      return t.tab as AgentTab
    }
  }
  const audit = new AuditLog(openDb(':memory:'))
  const runner = new GuardedRunner({ term: host, settings: { get: () => ({ commandTimeoutMs: 8000, outputCapBytes: 512 * 1024, ...prefs }) } as never, audit })
  const events: MultiEvent[] = []
  let done: () => void = () => {}
  const finished = () => new Promise<void>((r) => (done = r))
  const multi = new MultiService({
    host,
    runner,
    repo: { listSessions: () => sessions, listFolders: () => [{ id: 'lab', parentId: null }, { id: 'sub', parentId: 'lab' }], getSession: (id) => sessions.find((s) => s.id === id) },
    emit: (_o, e) => (events.push(e), e.done && done())
  })
  const final = (key: string) => events.filter((e) => e.key === key).at(-1)
  /** A tab the user has open in this window. */
  const userTab = async (sid: string) => {
    const s = sessions.find((x) => x.id === sid)!
    const t = await fakeTab(sims.get(s.id)!.port, 24, s)
    ;(t.raw as { tabId: string }).tabId = `user-${sid}`
    tabs.set(`user-${sid}`, { t, ctl: localControl(t.tab), owner: OWNER })
    return `user-${sid}`
  }
  return { host, multi, events, final, finished, audit: () => audit.list(200).reverse() as AuditRow[], opened, closed, tabs, userTab }
}


describe('multi-device runs and send-to-many', () => {
  it('resolves folders (with subfolders), tags and sessions once each, and excludes what cannot run', () => {
    const ss = [session('ios', 'iosxe'), session('eos', 'eos', { folderId: 'sub', tags: [] }), session('auto1', 'auto', { tags: ['x'] }), session('ser', 'iosxe', { protocol: 'serial', folderId: null, tags: ['x'] }), session('tel', 'iosxe', { protocol: 'telnet', folderId: 'sub' })]
    const { multi } = world(ss)
    const r = multi.resolve({ folders: ['lab'], tags: ['x'], sessions: ['ios'] }, OWNER)
    expect(r.map((t) => t.key)).toEqual(['ios', 'eos', 'auto1', 'ser', 'tel'])
    expect(r.find((t) => t.key === 'tel')!.excluded).toMatch(/telnet sign-in/)
    expect(r.find((t) => t.key === 'auto1')!.excluded).toMatch(/platform is not known/)
    expect(r.find((t) => t.key === 'ser')!.excluded).toMatch(/serial/)
    expect(r.find((t) => t.key === 'eos')!.excluded).toBeUndefined()
  })

  it('previews per platform: translated where the table has an equivalent, refused when not read-only on that platform', async () => {
    const { multi } = world(PLATS.map(([p, plat]) => session(p, plat)))
    const p = await multi.preview({ mode: 'run', targets: { folders: ['lab'] }, command: 'show interfaces status', perPlatform: true }, OWNER)
    const by = Object.fromEntries(p.rows.map((r) => [r.target.key, r]))
    expect(by['ios']).toMatchObject({ kind: 'read', lines: [{ command: 'show interfaces status' }] })
    expect(by['junos']).toMatchObject({ kind: 'read', translated: true, lines: [{ command: 'show interfaces terse' }] })
    expect(by['nxos']).toMatchObject({ kind: 'read', translated: true, lines: [{ command: 'show interface status' }] })
    const raw = await multi.preview({ mode: 'run', targets: { folders: ['lab'] }, command: 'show ip interface brief' }, OWNER)
    expect(raw.rows.find((r) => r.target.key === 'junos')).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/read-only/) })
    await expect(multi.preview({ mode: 'run', targets: { folders: ['lab'] }, command: 'show clock\nshow version' }, OWNER)).rejects.toThrow(/one show command/)
  })

  it('runs one command on several platforms in background connections, audited as multi, and closes them', async () => {
    const w = world([...PLATS.map(([p, plat]) => session(p, plat)), session('down', 'iosxe')])
    const p = await w.multi.preview({ mode: 'run', targets: { folders: ['lab'] }, command: 'show version', perPlatform: true }, OWNER)
    expect(p.counts).toEqual({ read: 5, config: 0, refused: 0 })
    const end = w.finished()
    w.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 3 }, OWNER)
    await end
    expect(w.final('ios')).toMatchObject({ status: 'ok', background: true, output: expect.stringMatching(/Cisco IOS XE/) })
    expect(w.final('eos')).toMatchObject({ status: 'ok', output: expect.stringMatching(/Arista/) })
    expect(w.final('junos')).toMatchObject({ status: 'ok', output: expect.stringMatching(/Junos/i) })
    expect(w.final('down')).toMatchObject({ status: 'error', reason: expect.stringMatching(/could not connect: connection refused/) })
    expect(w.events.map((e) => `${e.key}:${e.status}`)).toContain('ios:connecting')
    const rows = w.audit()
    expect(rows.filter((r) => r.decision === 'executed').map((r) => `${r.sessionName}:${r.command}`).sort()).toEqual(['eos:show version', 'ios:show version', 'junos:show version', 'nxos:show version'])
    expect(rows.every((r) => r.source === 'multi')).toBe(true)
    expect(w.tabs.size).toBe(0)
    expect(w.closed.sort()).toEqual(w.opened.sort())
    // A preview runs once.
    expect(() => w.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 3 }, OWNER)).toThrow(/expired/)
  })

  it('send-to-many: config needs confirmation, disruptive and blocked are refused per target with the reason', async () => {
    const w = world([session('ios', 'iosxe'), session('eos', 'eos')])
    const cfg = await w.multi.preview({ mode: 'send', targets: { sessions: ['ios', 'eos'] }, command: 'interface Ethernet1\n description via-multi' }, OWNER)
    expect(cfg.needsConfirm).toBe(true)
    expect(cfg.rows.find((r) => r.target.key === 'ios')).toMatchObject({ kind: 'config', wrapper: { before: ['configure terminal'], after: ['end'] } })
    expect(() => w.multi.start({ previewId: cfg.previewId, confirmConfig: false, concurrency: 2 }, OWNER)).toThrow(/Confirm/)
    const bgp = await w.multi.preview({ mode: 'send', targets: { sessions: ['ios'] }, command: 'clear ip bgp *' }, OWNER)
    expect(bgp.rows[0]).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/not sent to several devices/) })
    const wipe = await w.multi.preview({ mode: 'send', targets: { sessions: ['ios'] }, command: 'write erase' }, OWNER)
    expect(wipe.rows[0]).toMatchObject({ kind: 'blocked' })
    let end = w.finished()
    w.multi.start({ previewId: wipe.previewId, confirmConfig: true, concurrency: 1 }, OWNER)
    await end
    expect(w.final('ios')).toMatchObject({ status: 'blocked' })
    expect(w.opened).toHaveLength(0) // never connected for a refused target
    // All-refused previews are audited when made (review Low 3), once each.
    expect(w.audit()).toMatchObject([
      { command: 'clear ip bgp *', decision: 'refused', source: 'multi' },
      { command: 'write erase', decision: 'blocked', source: 'multi' }
    ])

    const again = await w.multi.preview({ mode: 'send', targets: { sessions: ['ios', 'eos'] }, command: 'interface Ethernet1\n description via-multi' }, OWNER)
    end = w.finished()
    w.multi.start({ previewId: again.previewId, confirmConfig: true, concurrency: 2 }, OWNER)
    await end
    expect(w.final('eos')).toMatchObject({ status: 'ok' })
    const eos = w.audit().filter((r) => r.sessionName === 'eos' && r.decision === 'executed').map((r) => r.command)
    expect(eos).toEqual(['configure terminal', 'interface Ethernet1', 'description via-multi', 'end'])
  })

  it('stop-all skips queued targets and the parser hook fills the table when one is registered', async () => {
    const w = world(PLATS.map(([p, plat]) => session(p, plat)))
    registerParser((platform, command, text) => ({ template: `${platform}_${command}`, ntcPlatform: platform, headers: ['LINES'], rows: [[String(text.split('\n').length)]] }))
    try {
      const p = await w.multi.preview({ mode: 'run', targets: { folders: ['lab'] }, command: 'show clock' }, OWNER)
      const end = w.finished()
      const { runId } = w.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 1 }, OWNER)
      w.multi.cancel(runId, {}) // another window can't stop it
      await new Promise((r) => setTimeout(r, 20))
      w.multi.cancel(runId, OWNER)
      await end
      const statuses = PLATS.map(([k]) => w.final(k)!.status)
      expect(statuses.filter((s) => s === 'skipped').length).toBeGreaterThanOrEqual(2)
      expect(w.events.at(-1)).toMatchObject({ done: true, status: 'cancelled' })
      expect(w.tabs.size).toBe(0)
    } finally {
      registerParser(null)
    }
    const w2 = world([session('ios', 'iosxe')])
    registerParser(() => ({ template: 'cisco_ios_show_clock', ntcPlatform: 'cisco_ios', headers: ['TIME'], rows: [['12:00']] }))
    try {
      const p = await w2.multi.preview({ mode: 'run', targets: { sessions: ['ios'] }, command: 'show clock' }, OWNER)
      const end = w2.finished()
      w2.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 1 }, OWNER)
      await end
      expect(w2.final('ios')).toMatchObject({ status: 'ok', table: { template: 'cisco_ios_show_clock', headers: ['TIME'], rows: [['12:00']] } })
    } finally {
      registerParser(null)
    }
  })

  it('send-to-many binds a reused tab to the device its prompt showed at preview (a hop is refused)', async () => {
    const w = world([session('ios', 'iosxe')])
    const tabId = await w.userTab('ios')
    const p = await w.multi.preview({ mode: 'send', targets: { tabs: [tabId] }, command: 'interface GigabitEthernet1/0/3\n description bound' }, OWNER)
    expect(p.rows[0]!.target).toMatchObject({ tabId, hostname: 'core-sw1' })
    // The user hops from this tab to another device before starting.
    const real = w.host.prompt
    w.host.prompt = async () => ({ mode: 'exec', prompt: 'other-sw#', hostname: 'other-sw' })
    const end = w.finished()
    w.multi.start({ previewId: p.previewId, confirmConfig: true, concurrency: 1 }, OWNER)
    await end
    w.host.prompt = real
    expect(w.final('ios')).toMatchObject({ status: 'refused', reason: expect.stringMatching(/device changed/) })
    expect(w.audit().filter((r) => r.decision === 'executed')).toHaveLength(0)
    expect(w.tabs.has(tabId)).toBe(true) // the user's tab is never closed by a run
    w.tabs.get(tabId)!.t.client.end()
  })

  it('M3a: a multi-device read on a reused tab is refused after a hop, like config', async () => {
    const w = world([session('ios', 'iosxe')])
    const tabId = await w.userTab('ios')
    const p = await w.multi.preview({ mode: 'run', targets: { tabs: [tabId] }, command: 'show version' }, OWNER)
    const real = w.host.prompt
    w.host.prompt = async () => ({ mode: 'exec', prompt: 'other-sw#', hostname: 'other-sw' })
    const end = w.finished()
    w.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 1 }, OWNER)
    await end
    w.host.prompt = real
    expect(w.final('ios')).toMatchObject({ status: 'refused', reason: expect.stringMatching(/device changed since the preview/) })
    expect(w.audit()).toMatchObject([{ command: 'show version', decision: 'refused', source: 'multi' }])
    w.tabs.get(tabId)!.t.client.end()
  })

  it('Low 3: a target that could not connect, and a run that was stopped, are audited', async () => {
    const w = world([session('down', 'iosxe')])
    const p = await w.multi.preview({ mode: 'run', targets: { sessions: ['down'] }, command: 'show version' }, OWNER)
    const end = w.finished()
    w.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 1 }, OWNER)
    await end
    expect(w.audit()).toMatchObject([{ sessionName: 'down', command: 'show version', decision: 'error', reason: expect.stringMatching(/could not connect: connection refused/), source: 'multi' }])
  })

  it('Low 3: an all-refused preview is audited at once; a declined configuration preview is audited as rejected', async () => {
    const w = world([session('ios', 'iosxe')])
    await w.multi.preview({ mode: 'run', targets: { sessions: ['ios'] }, command: 'configure terminal' }, OWNER)
    expect(w.audit()).toMatchObject([{ command: 'configure terminal', decision: 'refused', source: 'multi' }])
    const cfg = await w.multi.preview({ mode: 'send', targets: { sessions: ['ios'] }, command: 'interface GigabitEthernet1/0/3\n description x' }, OWNER)
    expect(cfg.needsConfirm).toBe(true)
    w.multi.decline(cfg.previewId, {}) // another window: ignored
    expect(w.audit()).toHaveLength(1)
    w.multi.decline(cfg.previewId, OWNER)
    expect(w.audit().slice(1)).toMatchObject([
      { command: 'interface GigabitEthernet1/0/3', decision: 'rejected', reason: expect.stringMatching(/declined/) },
      { command: 'description x', decision: 'rejected' }
    ])
    expect(w.audit()[1]!.approver).toBeTruthy()
    expect(() => w.multi.start({ previewId: cfg.previewId, confirmConfig: true, concurrency: 1 }, OWNER)).toThrow(/expired/)
  })

  it('fix-round A2: a preview its window never started is audited when the window closes, or when it expires', async () => {
    const w = world([session('ios', 'iosxe')])
    await w.multi.preview({ mode: 'send', targets: { sessions: ['ios'] }, command: 'interface GigabitEthernet1/0/3\n description x' }, OWNER)
    w.multi.cancelFor({}) // another window: nothing
    expect(w.audit()).toHaveLength(0)
    w.multi.cancelFor(OWNER)
    expect(w.audit()).toMatchObject([
      { command: 'interface GigabitEthernet1/0/3', decision: 'cancelled', reason: expect.stringMatching(/window closed before the preview was started/), source: 'multi' },
      { command: 'description x', decision: 'cancelled' }
    ])
    const p = await w.multi.preview({ mode: 'run', targets: { sessions: ['ios'] }, command: 'show clock' }, OWNER)
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60_000)
    try {
      expect(() => w.multi.start({ previewId: p.previewId, confirmConfig: false, concurrency: 1 }, OWNER)).toThrow(/expired/)
    } finally {
      spy.mockRestore()
    }
    expect(w.audit().at(-1)).toMatchObject({ command: 'show clock', decision: 'cancelled', reason: expect.stringMatching(/expired before it was started/) })
  })

  it('fix-round Low 5: with read-only mode on, send-to-many configuration is refused in the preview and audited', async () => {
    const w = world([session('ios', 'iosxe')], { aiReadOnly: true })
    const p = await w.multi.preview({ mode: 'send', targets: { sessions: ['ios'] }, command: 'interface GigabitEthernet1/0/3\n description x' }, OWNER)
    expect(p.rows[0]).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/read-only mode is on/) })
    expect(p.needsConfirm).toBe(false)
    expect(w.audit()[0]).toMatchObject({ decision: 'refused', reason: expect.stringMatching(/read-only mode is on/) })
    // Reads still run.
    const r = await w.multi.preview({ mode: 'run', targets: { sessions: ['ios'] }, command: 'show clock' }, OWNER)
    expect(r.rows[0]!.kind).toBe('read')
  })
})
