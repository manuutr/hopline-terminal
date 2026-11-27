import { describe, expect, it } from 'vitest'
import { hostRefusal } from '../src/session-host/guard-check'

describe('session host second enforcement point', () => {
  it('runs read commands from exec', () => expect(hostRefusal('show ip bgp summary', 'iosxe', 'read', 'core-sw1#')).toBeNull())
  it('refuses a read spec that is not read', () => expect(hostRefusal('conf t', 'iosxe', 'read', 'core-sw1#')).toMatch(/not a read-only command/))
  it('refuses blocked commands', () => expect(hostRefusal('reload', 'iosxe', 'config', 'core-sw1#')).toMatch(/deny-list/))
  it('classifies config lines in the mode the prompt shows', () => {
    expect(hostRefusal('description uplink', 'iosxe', 'config', 'core-sw1(config-if)#')).toBeNull()
    // Interface shutdown is disruptive since review L2 (it was the config example here).
    expect(hostRefusal('shutdown', 'iosxe', 'config', 'core-sw1(config-if)#')).toMatch(/disruptive/)
    expect(hostRefusal('switchport trunk allowed vlan 10', 'iosxe', 'config', 'core-sw1(config-if)#')).toMatch(/disruptive/)
  })
  it('refuses disruptive commands even with an approved config verdict', () => {
    expect(hostRefusal('clear ip bgp *', 'iosxe', 'config', 'core-sw1#')).toMatch(/disruptive/)
    expect(hostRefusal('no router bgp 65001', 'iosxe', 'config', 'core-sw1(config)#')).toMatch(/disruptive/)
  })
  it('an unclear or unmodelled prompt checks every config mode', () => {
    expect(hostRefusal('switchport trunk allowed vlan 10', 'iosxe', 'config', 'garbage output')).toMatch(/disruptive/)
    expect(hostRefusal('switchport trunk allowed vlan 10', 'iosxe', 'config', 'core-sw1(config-weird)#')).toMatch(/disruptive/)
  })
})
