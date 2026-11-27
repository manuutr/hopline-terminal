import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AuditRow } from '@shared/types'
import { fillSnippet, snippetApplies, snippetVars, valueProblem } from '@shared/snippets'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { analyze, GuardedRunner, splitLines } from '../src/main/productivity/runner'
import { SnippetService } from '../src/main/productivity/snippets'
import { ProductivityStore } from '../src/main/productivity/store'
import { fakeTab, localControl } from './helpers'

let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
afterAll(() => sim.close())

const settings = { get: () => ({ commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) } as never

async function setup() {
  const { tab, client } = await fakeTab(sim.port)
  const db = openDb(':memory:')
  const audit = new AuditLog(db)
  const runner = new GuardedRunner({ term: localControl(tab), settings, audit })
  const kv = new Map<string, string>()
  const store = new ProductivityStore({ getSetting: (k) => kv.get(k), setSetting: (k, v) => void (v === null ? kv.delete(k) : kv.set(k, v)) })
  const snippets = new SnippetService(store, runner, { listFolders: () => [{ id: 'f1', name: 'Lab', parentId: null, sort: 0 }] })
  const rows = () => audit.list(100).reverse() as AuditRow[]
  return { tab, client, runner, store, snippets, rows, end: () => client.end() }
}

const snip = (body: string, mode: 'run' | 'insert' = 'run') => ({ name: 'test', body, mode, scope: { kind: 'global' as const }, platforms: [], onBar: false })

describe('analyze (pure guard plan)', () => {
  it('read lines run as reads; blocked is blocked; unknown platform refuses everything', () => {
    expect(analyze('iosxe', ['show version', 'show ip int br'])).toMatchObject({ kind: 'read', shape: 'read' })
    expect(analyze('iosxe', ['reload'])).toMatchObject({ kind: 'blocked' })
    expect(analyze('iosxe', ['write erase'])).toMatchObject({ kind: 'blocked' })
    expect(analyze('auto', ['show version'])).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/platform is unknown/) })
  })
  it('a known exec command that changes state is one confirmed exec line; disruptive needs the hostname', () => {
    expect(analyze('iosxe', ['clear counters'])).toMatchObject({ kind: 'config', shape: 'exec' })
    expect(analyze('iosxe', ['clear ip bgp *'])).toMatchObject({ kind: 'disruptive', shape: 'exec' })
  })
  it('send-to-many refuses disruptive commands and lines, and says why', () => {
    expect(analyze('iosxe', ['clear ip bgp *'], { multi: true })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/not sent to several devices/) })
  })
  it('multi-device runs refuse anything not read-only', () => {
    expect(analyze('iosxe', ['clear counters'], { readOnly: true })).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/only run read-only/) })
  })
  it('configuration lines are wrapped for the platform; mode changes and mixes are refused', () => {
    const a = analyze('iosxe', ['interface GigabitEthernet1/0/2', 'description uplink'])
    expect(a).toMatchObject({ kind: 'config', shape: 'config', wrapper: { before: ['configure terminal'], after: ['end'] } })
    expect(analyze('iosxe', ['configure terminal', 'hostname x'])).toMatchObject({ kind: 'refused' })
    expect(analyze('iosxe', ['show version', 'hostname x'])).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/mixes show/) })
  })
  it('bodies: control characters and too many lines are refused', () => {
    expect(splitLines('show version\x1b[2J')).toEqual({ error: expect.stringMatching(/control/) })
    expect(splitLines('show version\r\n\r\nshow clock')).toEqual({ lines: ['show version', 'show clock'] })
    expect(splitLines(Array(51).fill('show clock').join('\n'))).toEqual({ error: expect.stringMatching(/more than 50/) })
  })
})

describe('snippet variables and scope', () => {
  it('finds variables with an autocomplete source, and fills them', () => {
    expect(snippetVars('interface {{interface}}\n switchport access vlan {{vlan}}\n desc {{interface}}')).toEqual([
      { name: 'interface', source: 'interfaces' },
      { name: 'vlan', source: 'vlans' }
    ])
    expect(fillSnippet('show int {{ intf }}', { intf: 'Gi1/0/1' })).toEqual({ text: 'show int Gi1/0/1' })
    expect(fillSnippet('show int {{intf}}', {})).toEqual({ error: '{{intf}} has no value' })
    expect(fillSnippet('show int {{intf}}', { intf: 'Gi1\rreload' })).toEqual({ error: expect.stringMatching(/one line/) })
    expect(valueProblem('x'.repeat(200))).toMatch(/at most/)
  })
  it('applies by scope (session, folder and its subfolders, global) and platform', () => {
    const folders = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }]
    const s = { id: 's1', folderId: 'b', platform: 'iosxe' as const }
    expect(snippetApplies({ scope: { kind: 'folder', id: 'a' }, platforms: [] }, s, folders)).toBe(true)
    expect(snippetApplies({ scope: { kind: 'folder', id: 'x' }, platforms: [] }, s, folders)).toBe(false)
    expect(snippetApplies({ scope: { kind: 'session', id: 's1' }, platforms: ['iosxe'] }, s, folders)).toBe(true)
    expect(snippetApplies({ scope: { kind: 'global' }, platforms: ['junos'] }, s, folders)).toBe(false)
  })
})

describe('guarded runner against the simulator', () => {
  it('a read snippet runs at once and is audited with source snippet', async () => {
    const t = await setup()
    try {
      const s = t.store.saveSnippet(snip('show ip interface brief | include {{interface}}'))
      const plan = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars: { interface: 'GigabitEthernet1/0/1' } })
      expect(plan).toMatchObject({ kind: 'read', hostname: 'core-sw1' })
      expect(t.rows()).toHaveLength(0) // previews are never audited
      const r = await t.snippets.run({ planId: plan.planId, approve: true })
      expect(r.status).toBe('ok')
      expect(r.output).toMatch(/GigabitEthernet1\/0\/1/)
      expect(t.rows()).toMatchObject([{ source: 'snippet', command: 'show ip interface brief | include GigabitEthernet1/0/1', kind: 'read', decision: 'executed', reason: expect.stringMatching(/snippet “test”/) }])
      // A plan runs once.
      await expect(t.snippets.run({ planId: plan.planId, approve: true })).rejects.toThrow(/expired/)
    } finally {
      t.end()
    }
  })

  it('config needs confirmation: declined is rejected and nothing runs; approved is applied in configure terminal … end', async () => {
    const t = await setup()
    try {
      const s = t.store.saveSnippet(snip('interface {{interface}}\n description {{text}}'))
      const vars = { interface: 'GigabitEthernet1/0/2', text: 'via-snippet' }
      const p1 = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars })
      expect(p1).toMatchObject({ kind: 'config', wrapper: { before: ['configure terminal'], after: ['end'] } })
      expect(await t.snippets.run({ planId: p1.planId, approve: false })).toMatchObject({ status: 'rejected' })
      expect(t.rows().every((r) => r.decision === 'rejected' && r.source === 'snippet')).toBe(true)
      const p2 = await t.snippets.prepare({ snippetId: s.id, tabId: 'tab-1', vars })
      const r = await t.snippets.run({ planId: p2.planId, approve: true })
      expect(r).toMatchObject({ status: 'ok' })
      const executed = t.rows().filter((x) => x.decision === 'executed').map((x) => x.command)
      expect(executed).toEqual(['configure terminal', 'interface GigabitEthernet1/0/2', 'description via-snippet', 'end'])
      const show = await t.store.saveSnippet(snip('show running-config interface GigabitEthernet1/0/2'))
      const p3 = await t.snippets.prepare({ snippetId: show.id, tabId: 'tab-1', vars: {} })
      expect((await t.snippets.run({ planId: p3.planId, approve: true })).output).toMatch(/description via-snippet/)
    } finally {
      t.end()
    }
  })

  it('blocked never runs, and is audited when tried; disruptive needs the right hostname', async () => {
    const t = await setup()
    try {
      const b = t.store.saveSnippet(snip('write erase'))
      const pb = await t.snippets.prepare({ snippetId: b.id, tabId: 'tab-1', vars: {} })
      expect(pb.kind).toBe('blocked')
      expect(await t.snippets.run({ planId: pb.planId, approve: true })).toMatchObject({ status: 'blocked' })
      expect(t.rows()).toMatchObject([{ command: 'write erase', decision: 'blocked', source: 'snippet' }])
      const d = t.store.saveSnippet(snip('clear ip bgp *'))
      const pd = await t.snippets.prepare({ snippetId: d.id, tabId: 'tab-1', vars: {} })
      expect(pd).toMatchObject({ kind: 'disruptive', confirm: 'core-sw1' })
      expect(await t.snippets.run({ planId: pd.planId, approve: true, ack: 'core-sw2' })).toMatchObject({ status: 'refused', reason: expect.stringMatching(/does not match/) })
      expect(t.rows().filter((r) => r.decision === 'executed')).toHaveLength(0)
    } finally {
      t.end()
    }
  })

  it('insert returns one filled line, refuses blocked and multi-line bodies, and audits the insert and the blocked try', async () => {
    const t = await setup()
    try {
      const i = t.store.saveSnippet(snip('show interfaces {{interface}}', 'insert'))
      expect(await t.snippets.insert({ snippetId: i.id, tabId: 'tab-1', vars: { interface: 'Gi1/0/1' } })).toMatchObject({ text: 'show interfaces Gi1/0/1', kind: 'read' })
      const two = t.store.saveSnippet(snip('show clock\nshow version', 'insert'))
      await expect(t.snippets.insert({ snippetId: two.id, tabId: 'tab-1', vars: {} })).rejects.toThrow(/insert types one line/)
      const bad = t.store.saveSnippet(snip('write erase', 'insert'))
      await expect(t.snippets.insert({ snippetId: bad.id, tabId: 'tab-1', vars: {} })).rejects.toThrow(/Blocked/)
      const scoped = t.store.saveSnippet({ ...snip('show clock', 'insert'), platforms: ['junos'] })
      await expect(t.snippets.insert({ snippetId: scoped.id, tabId: 'tab-1', vars: {} })).rejects.toThrow(/does not apply/)
      expect(t.rows()).toMatchObject([
        { source: 'snippet', command: 'show interfaces Gi1/0/1', kind: 'read', decision: 'inserted' },
        { source: 'snippet', command: 'write erase', decision: 'blocked' }
      ])
      // A run snippet can't be inserted, and an insert snippet can't be prepared as a run (review Low 4).
      await expect(t.snippets.prepare({ snippetId: i.id, tabId: 'tab-1', vars: { interface: 'Gi1/0/1' } })).rejects.toThrow(/insert snippet/)
    } finally {
      t.end()
    }
  })
})
