import { describe, expect, it } from 'vitest'
import { contextFor, noiseMask, normalizeConfig, stanzaPaths, stanzas, stanzaStyle, stripNoise } from '@shared/config-text'
import { summarizeChanges } from '../src/renderer/src/features/backups/changes'

const IOS = `Building configuration...

Current configuration : 4390 bytes
!
! Last configuration change at 03:19:10 UTC Wed Nov 25 2026 by netops
! NVRAM config last updated at 01:59:10 UTC Wed Nov 25 2026 by netops
!
version 17.9
hostname core-sw1
!
crypto pki certificate chain TP-self-signed-1
 certificate self-signed 01
  3082032E 30820216 A0030201 02020101 300D0609 2A864886 F70D0101 05050030
  30312E30 2C060355 04031325 494F532D 53656C66 2D536967 6E65642D 43657274
  \tquit
!
interface GigabitEthernet1/0/1
 description uplink
 switchport mode trunk
 !
interface Vlan10
 ip address 10.10.10.1 255.255.255.0
!
router bgp 65001
 neighbor 10.0.0.2 remote-as 65002
 address-family ipv4
  neighbor 10.0.0.2 activate
 exit-address-family
!
ntp clock-period 36028797
end`

describe('noise filter', () => {
  it('drops IOS timestamps, byte counts, ntp clock-period and certificate blobs, keeps the config', () => {
    const out = stripNoise(IOS)
    for (const gone of ['Last configuration change', 'NVRAM config', 'Current configuration', 'Building configuration', 'ntp clock-period', '3082032E', 'quit'])
      expect(out, gone).not.toContain(gone)
    for (const kept of ['hostname core-sw1', 'certificate self-signed 01', 'interface GigabitEthernet1/0/1', ' switchport mode trunk', 'end']) expect(out).toContain(kept)
  })

  it('covers NX-OS, IOS-XR, Junos, VRP, ASA and uptime lines', () => {
    const lines = [
      '!Time: Wed Nov 25 06:19:10 2026',
      '!Running configuration last done at: Sat Nov 21 07:19:37 2026',
      'Wed Nov 25 06:19:10.395 UTC',
      '!! Last configuration change at Mon Nov 23 06:19:10 2026 by netops',
      '## Last commit: 2026-11-24 10:00:01 UTC by netops',
      '!Last configuration was updated at 2026-11-02 01:28:14+00:00 by SYSTEM automatically',
      'Cryptochecksum:dd25cecfd0845beacf845a57ce8458c4',
      '! Uptime: 12 days',
      'hostname x'
    ]
    expect(noiseMask(lines)).toEqual([true, true, true, true, true, true, true, true, false])
  })

  it('two captures that differ only in noise normalise to the same text', () => {
    const later = IOS.replace('03:19:10', '04:20:11').replace('4390', '4391').replace('36028797', '36028800')
    expect(normalizeConfig(later)).toBe(normalizeConfig(IOS))
    expect(normalizeConfig(IOS.replace('uplink', 'uplink-2'))).not.toBe(normalizeConfig(IOS))
  })
})

describe('stanzas', () => {
  it('IOS: children sit under their header; ! at column 0 ends the stanza', () => {
    const lines = IOS.split('\n')
    const at = (s: string) => lines.findIndex((l) => l === s)
    expect(contextFor(lines, 'indent', at(' switchport mode trunk'))).toBe('interface GigabitEthernet1/0/1')
    expect(contextFor(lines, 'indent', at('  neighbor 10.0.0.2 activate'))).toBe('router bgp 65001 › address-family ipv4')
    expect(contextFor(lines, 'indent', at('hostname core-sw1'))).toBe('')
    const st = stanzas(lines, 'indent')
    const intf = st.find((s) => s.header === 'interface GigabitEthernet1/0/1')!
    expect(lines.slice(intf.start, intf.end + 1).join('\n')).toBe('interface GigabitEthernet1/0/1\n description uplink\n switchport mode trunk\n !')
    expect(st.find((s) => s.header === 'address-family ipv4')).toBeTruthy()
  })

  it('Junos braces: the hierarchy path', () => {
    const text = `system {\n    host-name edge-r1;\n}\ninterfaces {\n    ge-0/0/0 {\n        unit 0 {\n            family inet {\n                address 203.0.113.2/30;\n            }\n        }\n    }\n}`
    const lines = text.split('\n')
    expect(stanzaStyle(text, 'junos')).toBe('braces')
    expect(contextFor(lines, 'braces', 7)).toBe('interfaces › ge-0/0/0 › unit 0 › family inet')
    const st = stanzas(lines, 'braces')
    expect(st.map((s) => s.header)).toEqual(['system', 'interfaces', 'ge-0/0/0', 'unit 0', 'family inet'])
    expect(st[1]).toMatchObject({ start: 3, end: 11 })
  })

  it('Junos display set: the leading path', () => {
    const text = 'set system host-name edge-r1\nset interfaces ge-0/0/0 description TRANSIT\nset interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30\nset protocols bgp group EBGP neighbor 203.0.113.1 peer-as 64500'
    const lines = text.split('\n')
    expect(stanzaStyle(text, 'junos')).toBe('set')
    expect(stanzaPaths(lines, 'set').map((p) => p[0])).toEqual(['system host-name', 'interfaces ge-0/0/0', 'interfaces ge-0/0/0', 'protocols bgp group'])
    expect(stanzas(lines, 'set')).toEqual([{ start: 1, end: 2, header: 'interfaces ge-0/0/0' }])
  })

  it('FortiOS config/edit blocks', () => {
    const text = 'config system interface\n    edit "port1"\n        set ip 203.0.113.2 255.255.255.252\n    next\nend'
    const lines = text.split('\n')
    expect(stanzaStyle(text, 'fortios')).toBe('fortios')
    expect(contextFor(lines, 'fortios', 2)).toBe('config system interface › edit "port1"')
    expect(stanzas(lines, 'fortios')).toEqual([
      { start: 0, end: 4, header: 'config system interface' },
      { start: 1, end: 3, header: 'edit "port1"' }
    ])
  })
})

describe('diff change list', () => {
  it('labels each hunk with its stanza, on the side that has lines', () => {
    const a = ['hostname r1', '!', 'interface Gi1', ' description old', '!', 'interface Gi2', ' shutdown', '!']
    const b = ['hostname r1', '!', 'interface Gi1', ' description new', '!', '!']
    const out = summarizeChanges(
      [
        { originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
        { originalStartLineNumber: 6, originalEndLineNumber: 7, modifiedStartLineNumber: 5, modifiedEndLineNumber: 0 }
      ],
      a,
      b,
      'indent'
    )
    expect(out[0]).toMatchObject({ added: 1, removed: 1, context: 'interface Gi1', preview: 'description new', side: 'modified', line: 4 })
    expect(out[1]).toMatchObject({ added: 0, removed: 2, context: '', preview: 'interface Gi2', side: 'original', line: 6 })
  })
})
