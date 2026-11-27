import { describe, expect, it } from 'vitest'
import type { ParseResult } from '@hopline/parsers'
import { compareCells, diffTables, identity, ParseHistory, toDelimited } from '../src/renderer/src/lib/table'

const t = (rows: string[][], keys?: string[]): ParseResult => ({
  template: 'cisco_ios_show_ip_interface_brief.textfsm',
  ntcPlatform: 'cisco_ios',
  headers: ['INTERFACE', 'IP_ADDRESS', 'STATUS', 'PROTO'],
  rows,
  ...(keys ? { keys } : {})
})

describe('changed since last run', () => {
  it('marks new rows, changed cells and removed rows by the identifying column', () => {
    const prev = t([
      ['Gi1/0/1', '10.0.0.1', 'up', 'up'],
      ['Gi1/0/2', 'unassigned', 'up', 'up'],
      ['Gi1/0/3', 'unassigned', 'down', 'down']
    ])
    const cur = t([
      ['Gi1/0/1', '10.0.0.1', 'up', 'up'],
      ['Gi1/0/2', 'unassigned', 'down', 'down'],
      ['Gi1/0/4', '10.0.4.1', 'up', 'up']
    ])
    const d = diffTables(prev, cur)
    expect(d.comparable).toBe(true)
    expect(d.status).toEqual(['same', 'changed', 'new'])
    expect([...d.cells[1]!]).toEqual([2, 3])
    expect(d.before[1]).toEqual(prev.rows[1])
    expect(d.removed).toEqual([['Gi1/0/3', 'unassigned', 'down', 'down']])
  })

  it('uses the template Key values when it has them', () => {
    const a = t([['x', '1', 'up', 'up']], ['IP_ADDRESS'])
    expect(identity(a, a)).toEqual([1])
  })

  it('falls back to the first two columns when no column is unique', () => {
    const a = t([
      ['same', '1', 'up', 'up'],
      ['same', '2', 'up', 'up'],
      ['same', '2', 'down', 'up']
    ])
    expect(identity(a, a)).toEqual([0, 1])
  })

  it('is not comparable across templates or without a previous run', () => {
    expect(diffTables(undefined, t([['a', 'b', 'c', 'd']])).comparable).toBe(false)
    expect(diffTables({ ...t([]), template: 'other' }, t([['a', 'b', 'c', 'd']])).comparable).toBe(false)
  })
})

describe('parse history', () => {
  it('keeps the last runs per session + command and returns the previous one', () => {
    const h = new ParseHistory()
    const k = ParseHistory.key('s1', 'show ip  interface brief', 'tpl')
    expect(k).toBe(ParseHistory.key('s1', 'SHOW IP INTERFACE BRIEF', 'tpl'))
    expect(h.push(k, t([]), 1)).toBeUndefined()
    expect(h.push(k, t([['a', 'b', 'c', 'd']]), 2)?.at).toBe(1)
    for (let i = 0; i < 10; i++) h.push(k, t([]), 10 + i)
    expect(h.runs(k)).toHaveLength(5)
    h.clear('s1')
    expect(h.runs(k)).toHaveLength(0)
  })
})

describe('export', () => {
  it('quotes CSV and neutralises spreadsheet formulas from device text', () => {
    const csv = toDelimited(['A', 'B'], [['x,y', '=HYPERLINK("http://evil")'], ['-5', '--'], [['l1', 'l2'], '@SUM(1)']], ',')
    expect(csv.split('\n')).toEqual(['A,B', '"x,y","\'=HYPERLINK(""http://evil"")"', '-5,--', '"l1, l2",\'@SUM(1)'])
    expect(toDelimited(['A'], [['a\tb']], '\t')).toBe('A\na b')
  })
  it('sorts interface names naturally', () => {
    expect(['Gi1/0/10', 'Gi1/0/2', 'Gi1/0/1'].sort(compareCells)).toEqual(['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/10'])
  })
})
