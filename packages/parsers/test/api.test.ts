import { PLATFORM_IDS } from '@hopline/cli-model'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandCompletion, findTemplate, listTemplates, lookup, NTC_COMMIT, ParseTimeoutError, parseOutput, PLATFORM_MAP } from '../src'

const SHIPB = `Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     10.0.0.1        YES NVRAM  up                    up
GigabitEthernet0/1     unassigned      YES unset  administratively down down
`

describe('parseOutput', () => {
  it('parses with the template ntc picks, by abbreviation', () => {
    for (const cmd of ['show ip interface brief', 'sh ip int br', 'sh  ip   int  brief ']) {
      const r = parseOutput('ios', cmd, SHIPB)
      expect(r?.template, cmd).toBe('cisco_ios_show_ip_interface_brief.textfsm')
    }
    const r = parseOutput('iosxe', 'sh ip int br', SHIPB)!
    expect(r.ntcPlatform).toBe('cisco_ios')
    expect(r.headers).toEqual(['INTERFACE', 'IP_ADDRESS', 'STATUS', 'PROTO'])
    expect(r.rows).toEqual([
      ['GigabitEthernet0/0', '10.0.0.1', 'up', 'up'],
      ['GigabitEthernet0/1', 'unassigned', 'administratively down', 'down']
    ])
  })

  it('returns null for pipes, unknown commands, unknown platforms and unparsable output', () => {
    expect(parseOutput('ios', 'show ip interface brief | include up', SHIPB)).toBeNull()
    expect(parseOutput('ios', 'show running-config', 'hostname x\n')).toBeNull()
    expect(parseOutput('nope', 'show version', 'x')).toBeNull()
    expect(parseOutput('ios', 'show ip interface brief', '')).toBeNull()
    // The template's catch-all `^. -> Error` fires: no table, not an exception.
    expect(parseOutput('ios', 'show ip access-lists', 'Standard IP access list 1\nthis is not an ACL line\n')).toBeNull()
  })

  it('reports Key values', () => {
    const raw = readFileSync(join(__dirname, 'fixtures/huawei_vrp/display_vlan_brief/huawei_vrp_display_vlan_brief_ap.raw'), 'utf8')
    const r = parseOutput('vrp', 'display vlan brief', raw)
    expect(r?.keys).toEqual(['VLAN_ID'])
    expect(parseOutput('ios', 'sh ip int br', SHIPB)?.keys).toBeUndefined()
  })

  it('throws ParseTimeoutError when the budget runs out', () => {
    const big = SHIPB + 'GigabitEthernet0/2     10.0.0.2        YES NVRAM  up                    up\n'.repeat(200_000)
    expect(() => parseOutput('ios', 'sh ip int br', big, { budgetMs: 1 })).toThrow(ParseTimeoutError)
  })
})

describe('index matching', () => {
  it('expands [[ ]] like clitable', () => {
    expect(expandCompletion('sh[[ow]] ip')).toBe('sh(o(w)?)? ip')
  })

  it('first match wins, so longer commands are not shadowed', () => {
    expect(findTemplate('ios', 'show ip ospf neighbor detail')).toBe('cisco_ios_show_ip_ospf_neighbor_detail.textfsm')
    expect(findTemplate('ios', 'show ip ospf neighbor')).toBe('cisco_ios_show_ip_ospf_neighbor.textfsm')
    expect(findTemplate('ios', 'show cdp neighbors detail')).toBe('cisco_ios_show_cdp_neighbors_detail.textfsm')
  })

  it('a command whose ntc template is not bundled is unsupported, not parsed by a shorter one', () => {
    // show ip bgp neighbors X advertised-routes has its own (unbundled) template upstream.
    const e = lookup('ios', 'show ip bgp neighbors 10.0.0.1 advertised-routes')
    expect(e?.template).toBe('cisco_ios_show_ip_bgp_neighbors_advertised-routes.textfsm')
    expect(findTemplate('ios', 'show ip bgp neighbors 10.0.0.1 advertised-routes')).toBeNull()
  })

  it('maps every cli-model platform and the major vendors', () => {
    for (const p of PLATFORM_IDS) expect(PLATFORM_MAP[p], p).toBeDefined()
    expect(findTemplate('nxos', 'show int status')).toBe('cisco_nxos_show_interface_status.textfsm')
    expect(findTemplate('eos', 'show ip bgp summary')).toBe('arista_eos_show_ip_bgp_summary.textfsm')
    expect(findTemplate('junos', 'show bgp summary')).toBe('juniper_junos_show_bgp_summary.textfsm')
    expect(findTemplate('iosxr', 'show ip interface brief')).toBe('cisco_xr_show_ip_interface_brief.textfsm')
    expect(findTemplate('asa', 'show arp')).toBe('cisco_asa_show_arp.textfsm')
    expect(findTemplate('ftd', 'show arp')).toBe('cisco_asa_show_arp.textfsm')
    expect(findTemplate('aireos', 'show ap summary')).toBe('cisco_wlc_ssh_show_ap_summary.textfsm')
    expect(findTemplate('panos', 'show system info')).toBe('paloalto_panos_show_system_info.textfsm')
    expect(findTemplate('fortios', 'get system status')).toBe('fortinet_get_system_status.textfsm')
    expect(findTemplate('vrp', 'display version')).toBe('huawei_vrp_display_version.textfsm')
  })

  it('lists bundled templates per platform', () => {
    expect(listTemplates('ios').length).toBeGreaterThan(80)
    expect(listTemplates('nope')).toEqual([])
    expect(new Set(listTemplates().map((t) => t.template)).size).toBeGreaterThan(300)
  })

  it('pins the ntc-templates commit', () => {
    expect(NTC_COMMIT).toBe('06fa33389fbcca31cd59aac5fd5cb2ce5c900939')
  })
})

describe('@hopline/parsers/match stays light', () => {
  it('never imports the template texts', () => {
    const src = readFileSync(join(__dirname, '../src/match.ts'), 'utf8') + readFileSync(join(__dirname, '../src/pyre.ts'), 'utf8') + readFileSync(join(__dirname, '../src/platforms.ts'), 'utf8')
    expect(src).not.toMatch(/templates\.generated|from '\.\/index'|from '\.\/textfsm'/)
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { exports: Record<string, string> }
    expect(pkg.exports['./match']).toBe('./src/match.ts')
  })
})
