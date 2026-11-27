import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FleetEvent } from '@shared/fleet'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { FleetService } from '../src/main/fleet/service'
import { dispatch, report, RoutedLlm, show, simHost, testSettings, type SimHost, type Turn } from './fleet-helpers'

/** FleetService: scopes stored in main by id, runs owned by the window that started them. */

let host: SimHost
beforeAll(async () => {
  host = await simHost([
    { name: 'core-sw1', platform: 'iosxe' },
    { name: 'dist-eos1', platform: 'eos' }
  ])
})
afterAll(() => host.stop())

function service(scripts: Record<string, Turn[]>, over = {}) {
  const events: { owner: object; e: FleetEvent }[] = []
  const llm = new RoutedLlm(scripts)
  const repo = { listSessions: () => host.sessions, listFolders: () => [], getSession: (id: string) => host.sessions.find((s) => s.id === id), getCredential: () => ({ kind: 'password' as const }), hostKeys: () => ['SHA256:known'] }
  const svc = new FleetService({ host, repo, settings: testSettings(over), audit: new AuditLog(openDb(':memory:')), provider: async () => llm, emit: (owner, e) => events.push({ owner, e }) })
  return { svc, events, llm }
}

const doneOf = async (events: { e: FleetEvent }[], runId: string) => {
  for (let i = 0; i < 500; i++) {
    const d = events.find((x) => x.e.runId === runId && x.e.type === 'run' && x.e.status !== 'running')
    if (d) return d.e as Extract<FleetEvent, { type: 'run' }>
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('run did not finish')
}

describe('FleetService', () => {
  it('resolves a scope, starts it once by id for the same window only, and sends events to that window', async () => {
    const s = service({
      coordinator: [{ calls: [dispatch([{ device: 'core-sw1', task: 'version' }])] }, { text: 'IOS XE 17.9.' }],
      'core-sw1': [{ calls: [show('show version')] }, { calls: [report({ status: 'found', findings: ['17.9'] })] }]
    })
    const win = {}
    const other = {}
    const scope = await s.svc.scope({ sessions: host.sessions.map((x) => x.id) }, win)
    expect(scope.devices.map((d) => d.name)).toEqual(['core-sw1', 'dist-eos1'])
    expect(() => s.svc.start({ scopeId: scope.scopeId, question: 'versions?' }, other)).toThrow(/expired/)
    const { runId } = s.svc.start({ scopeId: scope.scopeId, question: 'versions?' }, win)
    expect(() => s.svc.start({ scopeId: scope.scopeId, question: 'again' }, win)).toThrow(/expired/)
    s.svc.cancel(runId, other)
    const done = await doneOf(s.events, runId)
    expect(done.status).toBe('done')
    expect(s.events.every((x) => x.owner === win)).toBe(true)
  })

  it('needs a connected model; a closed window stops its runs', async () => {
    const off = service({}, { aiConfigured: false })
    const win = {}
    const sc = await off.svc.scope({ sessions: [host.sessions[0]!.id] }, win)
    expect(() => off.svc.start({ scopeId: sc.scopeId, question: 'q' }, win)).toThrow(/Connect a model first/)

    const s = service({ coordinator: ['hang'] })
    const sc2 = await s.svc.scope({ sessions: [host.sessions[0]!.id] }, win)
    const { runId } = s.svc.start({ scopeId: sc2.scopeId, question: 'q' }, win)
    s.svc.cancelFor(win)
    expect((await doneOf(s.events, runId)).status).toBe('cancelled')
  })
})
