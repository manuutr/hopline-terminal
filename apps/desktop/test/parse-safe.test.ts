import { describe, expect, it } from 'vitest'
import { clampLines, compactRows, MAX_MODEL_CHARS, MAX_PARSE_LINE, parseSafe } from '../src/main/parse/safe'
import { parseTable, registerParser } from '../src/main/productivity/parsers'

const BRIEF = `Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet1/0/1   10.0.0.1        YES manual up                    up
GigabitEthernet1/0/2   unassigned      YES unset  administratively down down`

describe('main-process TextFSM for the agent', () => {
  it('parses with the bundled template and keeps the rows compact', () => {
    const r = parseSafe('iosxe', 'show ip interface brief', BRIEF)!
    expect(r.template).toBe('cisco_ios_show_ip_interface_brief.textfsm')
    expect(compactRows(r).text.split('\n')).toEqual([
      'INTERFACE\tIP_ADDRESS\tSTATUS\tPROTO',
      'GigabitEthernet1/0/1\t10.0.0.1\tup\tup',
      'GigabitEthernet1/0/2\tunassigned\tadministratively down\tdown'
    ])
  })

  it('returns null for no template, a pipe, an unknown platform and oversized input', () => {
    expect(parseSafe('iosxe', 'show clock', '10:00')).toBeNull()
    expect(parseSafe('iosxe', 'show ip interface brief | include up', BRIEF)).toBeNull()
    expect(parseSafe('auto', 'show ip interface brief', BRIEF)).toBeNull()
    expect(parseSafe('iosxe', 'show ip interface brief', BRIEF + '\n'.repeat(600_000))).toBeNull()
  })

  it('caps what goes to the model', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `GigabitEthernet1/0/${String(i).padEnd(4)} 10.0.0.1        YES manual up                    up`)
    const r = parseSafe('iosxe', 'show ip interface brief', [BRIEF.split('\n')[0], ...rows].join('\n'))!
    const c = compactRows(r)
    expect(c.total).toBe(2000)
    expect(c.shown).toBeLessThan(c.total)
    expect(c.text.length).toBeLessThanOrEqual(MAX_MODEL_CHARS)
  })
})

// Phase 4 review M7: hostile output must not stall main, per device or across a run.
describe('parse budget and long lines', () => {
  it('cuts lines over MAX_PARSE_LINE before parsing and still parses the table', () => {
    const long = BRIEF + '\n' + 'x'.repeat(100_000)
    expect(clampLines(long).split('\n').at(-1)!.length).toBe(MAX_PARSE_LINE)
    expect(clampLines(BRIEF)).toBe(BRIEF)
    const t0 = performance.now()
    const r = parseSafe('iosxe', 'show ip interface brief', long)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(r?.rows.length).toBeGreaterThanOrEqual(2)
  })
  it('a shared budget caps each parse and, once spent, parses nothing', () => {
    const budget = { remainingMs: 0 }
    expect(parseSafe('iosxe', 'show ip interface brief', BRIEF, 250, budget)).toBeNull()
    const some = { remainingMs: 1000 }
    expect(parseSafe('iosxe', 'show ip interface brief', BRIEF, 250, some)).not.toBeNull()
    expect(some.remainingMs).toBeLessThan(1000)
  })
  it('parseTable stops calling the parser once the run budget is spent (the raw text stays)', async () => {
    let calls = 0
    registerParser((_p, _c, _t, opts) => {
      calls++
      // Each parse "takes" 400 ms of the shared budget.
      if (opts?.budget) opts.budget.remainingMs -= 400
      return { template: 't', ntcPlatform: 'x', headers: ['A'], rows: [['1']] }
    })
    try {
      const budget = { remainingMs: 1000 }
      const out = []
      for (let i = 0; i < 64; i++) out.push(await parseTable('iosxe', 'show x', 'y', budget))
      expect(calls).toBe(3)
      expect(out.filter(Boolean)).toHaveLength(3)
    } finally {
      registerParser(null)
    }
  })

  it('reports when a multi-device table contains only the first 2,000 rows', async () => {
    registerParser(() => ({ template: 'test', ntcPlatform: 'test', headers: ['PREFIX'], rows: Array.from({ length: 2001 }, (_, i) => [String(i)]) }))
    try {
      const table = await parseTable('fortios', 'get router info routing-table all', 'routes')
      expect(table?.rows).toHaveLength(2000)
      expect(table?.totalRows).toBe(2001)
    } finally {
      registerParser(null)
    }
  })
})
