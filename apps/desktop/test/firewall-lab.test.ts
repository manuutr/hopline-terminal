import { describe, expect, it } from 'vitest'
import { makeFirewallLab } from '@hopline/simulator'
import { parseOutput } from '@hopline/parsers'
import { routingTable, ipsecSummary } from '../../../packages/simulator/src/vendors/fortios/render'
import { fibLookup, routingRoute, vpnFlow } from '../../../packages/simulator/src/vendors/panos/render'
import { mergeTables } from '../src/renderer/src/features/multi/tables'
import { diffTables } from '../src/renderer/src/lib/table'

describe('branch VPN investigation', () => {
  it('distinguishes a working tunnel from a missing return route in the LAN VRF', () => {
    const { fortios, panos } = makeFirewallLab()
    expect(vpnFlow(panos)).toMatch(/to-branch\s+active/)
    expect(ipsecSummary(fortios)).toContain('selectors(total,up): 1/1')
    expect(fibLookup(panos, '10.20.0.50')).toContain('interface tunnel.1')
    const read = () => parseOutput('fortios', 'get router info routing-table all', routingTable(fortios))!
    const fault = read()
    const scoped = (destination: string, vrf: string) => fault.rows.filter((r) => r[fault.headers.indexOf('DESTINATION')] === destination && r.at(-1) === vrf)
    expect(scoped('10.20.0.0/24', '10')[0]).toContain('port3')
    expect(scoped('0.0.0.0/0', '10')[0]).toContain('port1')
    expect(scoped('10.100.0.0/24', '10')).toHaveLength(0)
    expect(scoped('10.100.0.0/24', '20')[0]).toContain('vlan100')
    expect(parseOutput('panos', 'show routing route', routingRoute(panos))?.rows.some((r) => r.includes('tunnel.1') && r.at(-1) === 'default')).toBe(true)
    fortios.staticRoutes.push({ prefix: '10.100.0.0', mask: 24, nextHop: '169.254.10.1', vrf: '10' })
    const restored = read()
    const diff = diffTables(fault, restored)
    expect(restored.rows.filter((_, i) => diff.status[i] === 'new')).toEqual([expect.arrayContaining(['10.100.0.0/24', 'to-dc', '10'])])
    expect(diff.removed).toEqual([])
  })

  it('looks up the most specific active IPv4 paths per session and context, keeping equal paths', () => {
    const forti = parseOutput('fortios', 'get router info routing-table all', [
      'Routing table for VRF=10', 'S*  0.0.0.0/0 [10/0] via 192.0.2.1, port1',
      'Routing table for VRF=20', 'S  10.0.0.0/8 [10/0] via 192.0.2.2, port2',
      'S  10.100.0.0/24 [10/0] via 192.0.2.3, port3', '  [10/0] via 192.0.2.4, port4'
    ].join('\n'))!
    const pan = parseOutput('panos', 'show routing route', [
      'VIRTUAL ROUTER: west (id 2)', '10.100.0.10/32 192.0.2.6 10 S tunnel.2',
      '10.100.0.0/24 192.0.2.5 10 A S tunnel.1', 'total routes shown: 2'
    ].join('\n'))!
    const devices = [{ name: 'edge', table: forti }, { name: 'edge', table: pan }]
    const lookup = (ip: string) => mergeTables(devices, pan.template, ip)!.rows
    expect(lookup('10.100.0.10').map((r) => [r[2], r[3], r[6]])).toEqual([
      ['10', '0.0.0.0/0', 'port1'], ['20', '10.100.0.0/24', 'port3'],
      ['20', '10.100.0.0/24', 'port4'], ['west', '10.100.0.0/24', 'tunnel.1']
    ])
    expect(lookup('255.255.255.255')).toHaveLength(1)
    expect(lookup('0.0.0.0')).toHaveLength(1)
    expect(lookup('10.100.0.256')).toHaveLength(0)
    expect(lookup('')).toHaveLength(6)
  })

  it('withdraws the VPN association when its underlay goes down', () => {
    const { fortios, panos } = makeFirewallLab()
    fortios.interfaces.find((i) => i.name === 'port1')!.linkUp = false
    panos.interfaces.find((i) => i.name === 'ethernet1/1')!.linkUp = false
    expect(ipsecSummary(fortios)).toContain('selectors(total,up): 1/0')
    expect(vpnFlow(panos)).toMatch(/to-branch\s+init/)
  })
})
