import { describe, expect, it } from 'vitest'
import { policyBlocked } from '@shared/policy-deny'

/**
 * Phase 8 M2: with the platform's configuration dump blocked by the team policy, every other
 * spelling that prints the configuration is blocked too (matched through the shared canonicaliser,
 * so abbreviations and do/run wrappers do not get around it).
 */
const rules = { iosxe: ['show running-config'], asa: ['show running-config'], nxos: ['show running-config'], eos: ['show running-config'], iosxr: ['show running-config'], junos: ['show configuration'], panos: ['show config running'], fortios: ['show full-configuration'], vrp: ['display current-configuration'] }

describe('M2: the configuration dump group', () => {
  it.each([
    ['iosxe', 'write terminal'], ['iosxe', 'wr t'], ['iosxe', 'sh run'], ['iosxe', 'do sh run'], ['iosxe', 'show running-config all'], ['iosxe', 'sh run all'],
    ['iosxe', 'more system:running-config'], ['iosxe', 'more system:/running-config'], ['iosxe', 'more nvram:startup-config'], ['iosxe', 'show startup-config'], ['iosxe', 'sh start'],
    ['iosxe', 'show archive config differences'], ['iosxe', 'show archive log config all'], ['iosxe', 'show configuration'],
    ['asa', 'write terminal'], ['asa', 'more system:running-config'], ['asa', 'show run all'],
    ['nxos', 'show startup-config'], ['eos', 'more running-config:'], ['eos', 'show running-config all'],
    ['iosxr', 'admin show running-config'], ['iosxr', 'admin show configuration'],
    ['junos', 'show configuration'], ['junos', 'sh conf'], ['junos', 'show configuration | display set'], ['junos', 'run show configuration'],
    ['panos', 'show config candidate'], ['panos', 'show config diff'],
    ['fortios', 'show'], ['fortios', 'show system global'], ['fortios', 'sh full-configuration'],
    ['vrp', 'display this'], ['vrp', 'dis cu']
  ] as const)('%s: %s is blocked', (p, c) => expect(policyBlocked(rules, p, c)).toMatch(/blocked by team policy/))

  it('other reads stay allowed', () => {
    for (const [p, c] of [['iosxe', 'show version'], ['iosxe', 'show ip interface brief'], ['fortios', 'get system status'], ['junos', 'show interfaces terse'], ['vrp', 'display version']] as const)
      expect(policyBlocked(rules, p, c), `${p} ${c}`).toBeNull()
  })
})
