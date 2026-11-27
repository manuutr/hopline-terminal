import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseOutput } from '../src'

describe('firewall route contexts', () => {
  it('keeps overlapping FortiOS prefixes and ECMP next hops inside their own VRF', () => {
    const first = 'S  10.1.0.0/16 [10/0] via 192.0.2.1, port1'
    const raw = ['Routing table for VRF=10', first, '  [10/0] via 192.0.2.2, port2', 'Routing table for VRF=20', first].join('\r\n')
    const table = parseOutput('fortios', 'get router info routing-table all', raw)!
    expect(table.rows.map((row) => [row[table.headers.indexOf('DESTINATION')], row.at(-1)])).toEqual([['10.1.0.0/16', '10'], ['10.1.0.0/16', '10'], ['10.1.0.0/16', '20']])
    expect(table.keys).toContain('VRF')
    expect(parseOutput('fortios', 'get router info routing-table all', first)?.rows[0]?.at(-1)).toBe('')
    expect(parseOutput('fortios', 'get router info routing-table all', raw.replace('VRF=20', 'VRF=unknown'))).toBeNull()
  })

  it('keeps the tunnel interface, peer and trailing path attributes from FortiOS 7.x', () => {
    const raw = ['Routing table for VRF=10', 'S  10.0.0.0/8 [10/0] via to-dc tunnel 192.0.2.3, [1/0]',
      '  [10/0] via backup tunnel 192.0.2.4, [2/0]', 'S  10.20.0.0/16 [20/0] via 192.0.2.7, port3, [3/0]'].join('\n')
    const table = parseOutput('fortios', 'get router info routing-table all', raw)!
    const paths = table.rows.map((r) => Object.fromEntries(table.headers.map((h, i) => [h, r[i]])))
    expect(paths).toMatchObject([
      { DESTINATION: '10.0.0.0/8', INTERFACE: 'to-dc', GATEWAY: '192.0.2.3', PATH_ATTRIBUTES: '1/0', LAST_TIME_UPDATE: '', VRF: '10' },
      { DESTINATION: '10.0.0.0/8', INTERFACE: 'backup', GATEWAY: '192.0.2.4', PATH_ATTRIBUTES: '2/0' },
      { DESTINATION: '10.20.0.0/16', INTERFACE: 'port3', GATEWAY: '192.0.2.7', PATH_ATTRIBUTES: '3/0' }
    ])
  })

  it('reads every PAN-OS virtual router, including after a per-router footer', () => {
    const cmd = 'show routing route'
    const dir = join(__dirname, 'fixtures/paloalto_panos/show_routing_route')
    const raw = readFileSync(join(dir, 'paloalto_panos_show_routing_route.raw'), 'utf8').trimEnd()
    const name = /^VIRTUAL ROUTER: (.+?) \(id \d+\)/m.exec(raw)![1]!
    const second = raw.replace(/^VIRTUAL ROUTER: .*$/m, 'VIRTUAL ROUTER: Branch West (id 21)')
    const first = parseOutput('panos', cmd, raw)!
    const both = parseOutput('panos', cmd, raw + '\n' + second)!
    expect(both.rows.map((r) => r.at(-1))).toEqual([...first.rows.map(() => name), ...first.rows.map(() => 'Branch West')])
    expect(both.keys).toContain('VIRTUAL_ROUTER')
    expect(parseOutput('panos', cmd + ' | match route', raw)).toBeNull()
  })
})
