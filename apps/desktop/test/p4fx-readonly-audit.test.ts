import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AuditRow, Session } from '@shared/types'
import { newKey, sign, verify } from '@shared/verdict'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { TabControl } from '../src/main/host/client'
import { analyze, GuardedRunner, READ_ONLY_MODE_REASON } from '../src/main/productivity/runner'
import { SnippetService } from '../src/main/productivity/snippets'
import { ProductivityStore } from '../src/main/productivity/store'
import { TransferService } from '../src/main/files/service'
import { readOnlyRefusal } from '../src/session-host/guard-check'
import { fakeTab, localControl } from './helpers'

vi.mock('electron', () => ({ MessageChannelMain: class {}, utilityProcess: {}, app: {}, BrowserWindow: {}, dialog: {}, ipcMain: {} }))

/** Phase 4 fix-round review: Low 5 (read-only mode covers every automated send), A1 and A2. */
let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
afterAll(() => sim.close())

async function setup(prefs: { aiReadOnly?: boolean } = {}, wrap?: (c: TabControl) => TabControl) {
  const { tab, client } = await fakeTab(sim.port)
  const audit = new AuditLog(openDb(':memory:'))
  const st = { aiReadOnly: false, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, ...prefs }
  const control = localControl(tab)
  const runner = new GuardedRunner({ term: wrap ? wrap(control) : control, settings: { get: () => st } as never, audit })
  const kv = new Map<string, string>()
  const store = new ProductivityStore({ getSetting: (k) => kv.get(k), setSetting: (k, v) => void (v === null ? kv.delete(k) : kv.set(k, v)) })
  const snippets = new SnippetService(store, runner, { listFolders: () => [] })
  const rows = () => audit.list(100).reverse() as AuditRow[]
  return { tab, runner, store, snippets, rows, st, end: () => client.end() }
}
const snip = (body: string) => ({ name: 'test', body, mode: 'run' as const, scope: { kind: 'global' as const }, platforms: [], onBar: false })

describe('Low 5: read-only mode covers every automated send', () => {
  it('analyze: with read-only mode, config and exec changes are refused with the reason; reads pass', () => {
    expect(analyze('iosxe', ['show version'], { readOnlyMode: true })).toMatchObject({ kind: 'read' })
    for (const body of [['hostname x'], ['clear counters'], ['interface Gi1/0/1', 'shutdown']])
      expect(analyze('iosxe', body, { readOnlyMode: true })).toMatchObject({ kind: 'refused', reason: expect.stringContaining(READ_ONLY_MODE_REASON) })
    expect(analyze('iosxe', ['reload'], { readOnlyMode: true }).kind).toBe('blocked')
  })

  it('snippets: the preview shows the refusal; running it is refused and audited; nothing reaches the device', async () => {
    const t = await setup({ aiReadOnly: true })
    try {
      const s = t.store.saveSnippet(snip('interface GigabitEthernet1/0/2\n description ro-test'))
      const plan = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars: {} })
      expect(plan).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/read-only mode is on/) })
      const r = await t.snippets.run({ planId: plan.planId, approve: true })
      expect(r.status).toBe('refused')
      expect(t.rows().map((x) => x.decision)).toEqual(['refused', 'refused'])
      expect(t.rows().every((x) => /read-only mode is on/.test(x.reason))).toBe(true)
    } finally {
      t.end()
    }
  })

  it('turned on between the preview and the run: refused at run time, audited with the read-only reason', async () => {
    const t = await setup()
    try {
      const s = t.store.saveSnippet(snip('interface GigabitEthernet1/0/2\n description ro-test'))
      const plan = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars: {} })
      expect(plan.kind).toBe('config')
      t.st.aiReadOnly = true
      const r = await t.snippets.run({ planId: plan.planId, approve: true })
      expect(r).toMatchObject({ status: 'refused', reason: READ_ONLY_MODE_REASON })
      expect(t.rows().map((x) => [x.command, x.decision])).toEqual([
        ['interface GigabitEthernet1/0/2', 'refused'],
        ['description ro-test', 'refused']
      ])
    } finally {
      t.end()
    }
  })

  it('the signed verdict carries readOnly; it cannot be stripped; the session host refuses non-reads under it', () => {
    const key = newKey()
    const tok = sign(key, { tabId: 't1', command: 'hostname x', kind: 'config', platform: 'iosxe', hosts: ['r1'], readOnly: true })
    expect(verify(key, tok, 't1', 'hostname x')?.readOnly).toBe(true)
    const [body, sig] = tok.split('.')
    const v = JSON.parse(Buffer.from(body!, 'base64url').toString())
    delete v.readOnly
    expect(verify(key, `${Buffer.from(JSON.stringify(v)).toString('base64url')}.${sig}`, 't1', 'hostname x')).toBeNull()
    expect(readOnlyRefusal('config', true)).toMatch(/read-only mode is on/)
    expect(readOnlyRefusal('disruptive', true)).toMatch(/read-only/)
    expect(readOnlyRefusal('read', true)).toBeNull()
    expect(readOnlyRefusal('config', undefined)).toBeNull()
  })

  it('HostClient.exec refuses any non-read while the flag is on, for every caller, before signing', async () => {
    const { SessionHostClient: HostClient } = await import('../src/main/host/client')
    let readOnly = true
    const c = new HostClient({} as never, { get: () => ({ aiReadOnly: readOnly }) } as never, {} as never)
    const tab = { tabId: 'x', session: { platform: 'iosxe' } as Session }
    for (const kind of ['config', 'disruptive'] as const) {
      const r = await c.exec(tab, 'hostname x', kind, { timeoutMs: 1000, capBytes: 1000 })
      expect(r).toMatchObject({ status: 'error', error: expect.stringMatching(/read-only mode is on/) })
    }
    readOnly = false
    // With the flag off it goes on to the host (none here: an rpc error, not the read-only refusal).
    const r = await Promise.race([c.exec(tab, 'hostname x', 'config', { timeoutMs: 1000, capBytes: 1000 }), new Promise<{ error: string }>((res) => setTimeout(() => res({ error: 'pending' }), 50))])
    expect(r.error ?? '').not.toMatch(/read-only mode/)
  })

  it('uploads are refused (and audited) while the flag is on', async () => {
    const audit: { decision: string; reason: string; kind: string }[] = []
    const session = { id: 's1', name: 'r1', host: '10.0.0.1', protocol: 'ssh', platform: 'iosxe', options: {} } as unknown as Session
    const svc = new TransferService({
      host: { owned: () => ({ session, wc: { isDestroyed: () => false, send: () => {} } as never }), request: () => Promise.reject(new Error('no host')), send: () => {}, onHostMessage: () => () => {} },
      audit: { append: (e) => audit.push(e as never) },
      pickDir: async () => null,
      readOnly: () => true
    })
    await expect(svc.upload('t1', {} as never, ['/tmp/x.bin'], { remoteDir: 'flash:' }, 'ask')).rejects.toThrow(/read-only mode is on/)
    expect(audit).toMatchObject([{ kind: 'upload', decision: 'refused', reason: expect.stringMatching(/read-only/) }])
  })
})

describe('A1: snippets:run re-checks that the tab is in the asking window', () => {
  it('a tab that left the window is refused and audited at run time', async () => {
    const t = await setup()
    try {
      const s = t.store.saveSnippet(snip('show clock'))
      const owner = {}
      const plan = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars: {} }, owner)
      const r = await t.snippets.run({ planId: plan.planId, approve: true }, owner, () => false)
      expect(r).toMatchObject({ status: 'refused', reason: expect.stringMatching(/no longer open in this window/) })
      expect(t.rows()).toMatchObject([{ command: 'show clock', decision: 'refused', source: 'snippet' }])
    } finally {
      t.end()
    }
  })
})

describe('A2: audit gaps', () => {
  it('GuardedRunner.run with the tab closed writes a row per line', async () => {
    const t = await setup()
    try {
      const a = analyze('iosxe', ['show clock', 'show version'])
      const r = await t.runner.run('gone', a, { source: 'snippet', approved: false, session: { id: 's1', name: 'core-sw1', host: '127.0.0.1' } })
      expect(r).toMatchObject({ status: 'error', reason: 'the tab is closed' })
      expect(t.rows()).toMatchObject([
        { command: 'show clock', decision: 'error', sessionName: 'core-sw1', reason: 'the tab is closed' },
        { command: 'show version', decision: 'error' }
      ])
    } finally {
      t.end()
    }
  })

  it('lines after a failure in a multi-line plan get a "not run" row', async () => {
    let n = 0
    const t = await setup({}, (c) => ({ ...c, exec: async (...args) => (++n === 2 ? { status: 'error' as const, output: '', durationMs: 1, bytes: 0, error: 'boom' } : c.exec(...args)) }))
    try {
      const a = analyze('iosxe', ['show clock', 'show users', 'show version'])
      // The second line fails; the third never runs.
      const r = await t.runner.run('tab-1', a, { source: 'snippet', approved: false })
      expect(r.status).toBe('error')
      const rows = t.rows()
      expect(rows.map((x) => [x.command, x.decision])).toEqual([
        ['show clock', 'executed'],
        ['show users', 'error'],
        ['show version', 'cancelled']
      ])
      expect(rows[2]!.reason).toMatch(/not run: an earlier line ended with error/)
    } finally {
      t.end()
    }
  })

  it('lines after a stop get a "not run: stopped" row', async () => {
    const ctl = new AbortController()
    const t = await setup({}, (c) => ({ ...c, exec: (...args) => c.exec(...args).finally(() => ctl.abort()) }))
    try {
      const a = analyze('iosxe', ['show clock', 'show version', 'show users'])
      const r = await t.runner.run('tab-1', a, { source: 'snippet', approved: false, signal: ctl.signal })
      expect(r.status).toBe('cancelled')
      expect(t.rows().map((x) => [x.command, x.decision, x.reason])).toEqual([
        ['show clock', 'executed', 'read-only'],
        ['show version', 'cancelled', 'not run: stopped'],
        ['show users', 'cancelled', 'not run: stopped']
      ])
    } finally {
      t.end()
    }
  })

  it('"typed, not sent" results are audited as such', async () => {
    const t = await setup({}, (c) => ({ ...c, exec: async () => ({ status: 'error', output: '', durationMs: 1, bytes: 0, error: 'the device did not echo', typedNotSent: true }) }))
    try {
      await t.runner.run('tab-1', analyze('iosxe', ['show clock']), { source: 'snippet', approved: false })
      expect(t.rows()[0]).toMatchObject({ decision: 'error', reason: expect.stringMatching(/^typed, not sent: the device did not echo/) })
    } finally {
      t.end()
    }
  })

  it('snippet previews that never run are audited when they expire or their window closes', async () => {
    const t = await setup()
    try {
      const s = t.store.saveSnippet(snip('interface GigabitEthernet1/0/2\n description gone'))
      const w = {}
      await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars: {} }, w)
      t.snippets.dropFor({})
      expect(t.rows()).toHaveLength(0)
      t.snippets.dropFor(w)
      expect(t.rows()).toMatchObject([
        { command: 'interface GigabitEthernet1/0/2', decision: 'cancelled', reason: expect.stringMatching(/window closed/) },
        { command: 'description gone', decision: 'cancelled' }
      ])
      const p = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars: {} }, w)
      const now = Date.now()
      const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60_000)
      try {
        await expect(t.snippets.run({ planId: p.planId, approve: true }, w)).rejects.toThrow(/expired/)
      } finally {
        spy.mockRestore()
      }
      expect(t.rows().slice(2)).toMatchObject([
        { decision: 'cancelled', reason: expect.stringMatching(/expired before it was run/) },
        { decision: 'cancelled' }
      ])
    } finally {
      t.end()
    }
  })
})
