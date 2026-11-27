import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FleetEvent } from '@shared/fleet'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { TokenMeter } from '../src/main/fleet/budget'
import { LanePool } from '../src/main/fleet/pool'
import { FleetRun } from '../src/main/fleet/run'
import { dispatch, lastResults, report, reportFromOutput, RoutedLlm, show, simHost, testSettings, type SimHost, type Turn } from './fleet-helpers'

/** Step 4: the coordinator and the scheduler, with budgets, cancellation, per-lane timeouts and concurrency. */

let host: SimHost
beforeAll(async () => {
  host = await simHost([
    { name: 'core-sw1', platform: 'iosxe' },
    { name: 'edge-r1', platform: 'iosxe' },
    { name: 'dist-eos1', platform: 'eos' }
  ])
})
afterAll(() => host.stop())

function makeRun(scripts: Record<string, Turn[]>, o: { concurrency?: number; tokens?: number; laneMs?: number; runMs?: number; usage?: (role: string) => { inputTokens: number; outputTokens: number } | undefined; names?: string[] } = {}) {
  const audit = new AuditLog(openDb(':memory:'))
  const llm = new RoutedLlm(scripts, { usage: o.usage })
  const events: FleetEvent[] = []
  const pool = new LanePool(host, o.concurrency ?? 4)
  const devices = host.sessions.filter((s) => !o.names || o.names.includes(s.name))
  const run = new FleetRun(
    `run-${Math.random().toString(36).slice(2, 8)}`,
    'Why is BGP down between core-sw1 and edge-r1?',
    { devices, excluded: [{ name: 'wlc1', why: 'needs sign-in' }] },
    { tokens: o.tokens ?? 400_000, runMs: o.runMs ?? 60_000, laneMs: o.laneMs ?? 20_000, concurrency: o.concurrency ?? 4 },
    { pool, term: host, settings: testSettings(), audit, provider: async () => llm, emit: (e) => events.push(e), model: 'claude-opus-5-5', laneMs: o.laneMs, runMs: o.runMs }
  )
  const lanes = (name: string) => events.filter((e): e is Extract<FleetEvent, { type: 'lane' }> => e.type === 'lane' && e.lane === name).map((e) => e.status)
  const final = () => events.filter((e): e is Extract<FleetEvent, { type: 'run' }> => e.type === 'run').at(-1)!
  return { run, llm, events, audit, pool, lanes, final, rows: () => audit.list().reverse() }
}

describe('FleetRun', () => {
  it('dispatches a wire alias to its selected device and displays its saved name locally', async () => {
    let alias = ''
    const r = makeRun({
      coordinator: [(req) => {
        alias = /\| (device-[\w-]+) \| Cisco IOS-XE \|/.exec(req.system)![1]!
        return { calls: [dispatch([{ device: alias, task: 'Read the clock' }])] }
      }, () => ({ text: 'Clock checked on ' + alias })],
      'core-sw1': [{ calls: [report({ status: 'not_found', findings: ['Clock checked'] })] }]
    }, { names: ['core-sw1'] })
    await r.run.run()
    expect(r.lanes('core-sw1').at(-1)).toBe('not_found')
    for (const req of r.llm.seen) {
      // Only model-visible content. The fake adapter keeps lane metadata and wire IDs separately.
      expect([req.system, ...lastResults(req)].join('\n')).not.toContain('core-sw1')
    }
    expect(r.events.find((e) => e.type === 'text')).toMatchObject({ text: 'Clock checked on core-sw1' })
  })
  it('3 lanes: one finds, one is blocked, one times out; reports come back framed; every tab closes', async () => {
    const closedBefore = host.closed.length
    const r = makeRun(
      {
        coordinator: [
          { calls: [dispatch([{ device: 'core-sw1', task: 'Check BGP to 10.0.0.2' }, { device: 'edge-r1', task: 'Reload is not allowed; see what happens' }, { device: 'DIST-EOS1', task: 'Check LLDP' }])] },
          { text: 'core-sw1 has 10.0.0.2 Idle. edge-r1 could not be checked.' }
        ],
        'core-sw1': [{ calls: [show('show ip bgp summary')] }, reportFromOutput('show ip bgp summary', /10\.0\.0\.2/)],
        'edge-r1': [{ calls: [show('reload')] }, { calls: [report({ status: 'blocked', findings: ['reload is blocked'] })] }],
        'dist-eos1': ['hang']
      },
      { laneMs: 1500 }
    )
    await r.run.run()
    expect(r.lanes('core-sw1')).toEqual(['queued', 'connecting', 'running', 'found'])
    expect(r.lanes('edge-r1').at(-1)).toBe('blocked')
    expect(r.lanes('dist-eos1').at(-1)).toBe('timeout')
    expect(r.final().status).toBe('done')
    expect(r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toMatch(/Idle/)
    // The coordinator got three framed, untrusted reports and nothing else from devices.
    const back = lastResults(r.llm.requests('coordinator')[1]!)[0]!
    expect(back.match(/<device_report id="[0-9a-f]{12}" device="[^"]+" lane_status="[a-z_]+" untrusted="true">/g)).toHaveLength(3)
    expect(back).toMatch(/lane_status="timeout"/)
    expect(r.llm.requests('coordinator')[0]!.system).toMatch(/\| device-\d+-[a-f0-9]+ \| Cisco IOS-XE \|/)
    expect(r.llm.requests('coordinator')[0]!.system).toMatch(/device-\d+-[a-f0-9]+: needs sign-in/)
    // Nothing non-read was sent anywhere; the blocked command never reached the device.
    expect(host.sent.filter((s) => s.kind !== 'read')).toEqual([])
    expect(host.sent.some((s) => s.command === 'reload')).toBe(false)
    expect(r.rows().find((x) => x.command === 'reload')).toMatchObject({ decision: 'blocked', source: 'fleet', lane: 'edge-r1', runId: r.run.runId })
    expect(host.closed.length - closedBefore).toBe(3)
    expect(r.pool.openCount).toBe(0)
  })

  it('names resolve only against the frozen scope; a task quoting another device\'s output is sent back', async () => {
    const r = makeRun({
      coordinator: [
        { calls: [dispatch([{ device: '10.9.9.9', task: 'log in here' }, { device: 'core-sw2', task: 'x' }, { device: 'core-sw1', task: 'Show the BGP summary' }])] },
        (req) => {
          // Quote a line of core-sw1's output in a task for edge-r1.
          const line = lastResults(req)[0]!.split('\n').find((l) => /10\.0\.0\.2/.test(l) && l.length > 40)!
          return { calls: [dispatch([{ device: 'edge-r1', task: `Compare with ${JSON.parse(line.trim().replace(/,$/, '')) as string}` }])] }
        },
        { text: 'Done.' }
      ],
      'core-sw1': [{ calls: [show('show ip bgp summary')] }, reportFromOutput('show ip bgp summary', /10\.0\.0\.2\s+4/)]
    })
    await r.run.run()
    const first = lastResults(r.llm.requests('coordinator')[1]!)[0]!
    expect(first).toMatch(/REFUSED for "10\.9\.9\.9": not a device in this run's scope/)
    expect(first).toMatch(/REFUSED for "core-sw2"/)
    const second = lastResults(r.llm.requests('coordinator')[2]!)[0]!
    expect(second).toMatch(/REFUSED for device-[\w-]+: the task quotes output from device-[\w-]+/)
    expect(r.lanes('edge-r1')).toEqual([])
    const refused = r.rows().filter((x) => x.command === 'dispatch_tasks')
    expect(refused.map((x) => [x.sessionName, x.decision, x.source])).toEqual([
      ['10.9.9.9', 'refused', 'fleet'],
      ['core-sw2', 'refused', 'fleet'],
      ['edge-r1', 'refused', 'fleet']
    ])
  })

  it('concurrency 1: lanes queue for the single background slot', async () => {
    const r = makeRun(
      {
        coordinator: [{ calls: [dispatch(host.sessions.map((s) => ({ device: s.name, task: 'show the clock' })))] }, { text: 'ok' }],
        'core-sw1': [{ calls: [show('show clock')] }, { calls: [report({ status: 'not_found' })] }],
        'edge-r1': [{ calls: [show('show clock')] }, { calls: [report({ status: 'not_found' })] }],
        'dist-eos1': [{ calls: [show('show clock')] }, { calls: [report({ status: 'not_found' })] }]
      },
      { concurrency: 1 }
    )
    await r.run.run()
    expect(r.pool.maxOpen).toBe(1)
    for (const s of host.sessions) expect(r.lanes(s.name).at(-1)).toBe('not_found')
  })

  it('budget: a spent lane closes with a report; the coordinator is warned, then answers without dispatching (review M2)', async () => {
    // 100k tokens: the coordinator keeps 25k, one lane gets 75k. Worker turns cost 32k, coordinator turns 11k.
    const closingWorker: Turn = (req) => (/token budget is used up/.test(req.system) ? { calls: [report({ status: 'not_found', findings: ['partial: the clock was read'] })] } : { calls: [show('show clock')] })
    const again = { calls: [dispatch([{ device: 'core-sw1', task: 'look again' }])] }
    const r = makeRun(
      {
        coordinator: [{ calls: [dispatch([{ device: 'core-sw1', task: 'look' }])] }, again, again, { text: 'Answer from the reports I have.' }],
        'core-sw1': Array.from({ length: 10 }, () => closingWorker)
      },
      { tokens: 100_000, usage: (role) => (role === 'coordinator' ? { inputTokens: 11_000, outputTokens: 0 } : { inputTokens: 32_000, outputTokens: 0 }), names: ['core-sw1'] }
    )
    await r.run.run()
    const w = r.llm.requests('core-sw1')
    // Turns 1-3 fit (96k after the third); the 4th would not, so it is a closing turn: told, and it reports.
    expect(w.slice(0, 3).every((q) => !/token budget is used up/.test(q.system))).toBe(true)
    expect(w[3]!.system).toMatch(/token budget is used up. Call submit_report now/)
    expect(lastResults(w[2]!)[0]).toMatch(/budget is nearly used: submit your report now/)
    const first = r.events.find((e): e is Extract<FleetEvent, { type: 'lane' }> => e.type === 'lane' && e.lane === 'core-sw1' && !!e.report)!
    expect(first.status).toBe('not_found')
    expect(first.report!.findings).toEqual(['partial: the clock was read'])
    // Round 2: no share left; one closing turn, a report again, no command run.
    expect(w).toHaveLength(5)
    expect(w[4]!.system).toMatch(/token budget is used up/)
    // The coordinator: warned at 88% (2nd result), then its 3rd turn is a closing turn; the dispatch in it is refused, the 4th answers.
    const c = r.llm.requests('coordinator')
    expect(lastResults(c[2]!)[0]).toMatch(/Write the final answer now/)
    expect(c[2]!.system).toMatch(/Do not dispatch again: write the final answer now/)
    expect(lastResults(c[3]!)[0]).toMatch(/REFUSED: the token budget is used up/)
    expect(c).toHaveLength(4)
    expect(r.final().status).toBe('done')
    expect(r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toContain('Answer from the reports I have.')
    expect(r.rows().some((x) => x.command === 'dispatch_tasks' && x.decision === 'refused' && /budget/.test(x.reason))).toBe(true)
    // The header figure is the meter's: input-equivalent, the same unit as the budget.
    const usage = r.events.filter((e) => e.type === 'usage').at(-1) as Extract<FleetEvent, { type: 'usage' }>
    expect(usage.usage.inputTokens).toBe(5 * 32_000 + 4 * 11_000)
    expect(usage.usage.metered).toBe(usage.usage.inputTokens)
    expect(usage.usage.costUsd).toBeCloseTo(((5 * 32_000 + 4 * 11_000) * 4) / 1e6)
  })

  it('cancel mid-run: every running executor gets the IOS break (Ctrl-Shift-6), lanes end cancelled, tabs close', async () => {
    const r = makeRun({
      coordinator: [{ calls: [dispatch([{ device: 'core-sw1', task: 'ping 10.0.0.2' }, { device: 'edge-r1', task: 'ping 10.0.0.2' }])] }, { text: 'never' }],
      'core-sw1': [{ calls: [show('ping 10.0.0.2 repeat 10')] }],
      'edge-r1': [{ calls: [show('ping 10.0.0.2 repeat 10')] }]
    })
    const closedBefore = host.closed.length
    const done = r.run.run()
    const running = () => host.sent.filter((s) => s.command === 'ping 10.0.0.2 repeat 10').length
    const start = running()
    for (let i = 0; i < 400 && running() < start + 2; i++) await new Promise((x) => setTimeout(x, 5))
    await new Promise((x) => setTimeout(x, 120))
    r.run.cancel()
    await done
    for (const n of ['core-sw1', 'edge-r1']) {
      expect(host.keys.get(n)!.includes('\x1e')).toBe(true)
      expect(r.lanes(n).at(-1)).toBe('cancelled')
    }
    expect(r.final().status).toBe('cancelled')
    expect(host.closed.length - closedBefore).toBe(2)
  })

  it('meter: the coordinator keeps 25%, the rest is split over dispatched lanes', () => {
    const m = new TokenMeter(400_000, null)
    expect(m.share('coordinator')).toBe(100_000)
    m.allot(['a', 'b', 'c'])
    expect(m.share('a')).toBe(100_000)
    m.add('a', { input: 50_000, output: 0 })
    expect(m.fraction('a')).toBe(0.5)
    expect(m.usage().costUsd).toBeNull()
  })
})
