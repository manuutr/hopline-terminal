import { describe, expect, it } from 'vitest'
import { CONFIG_DUMPS, POLICY_INVALID_RULE, policyBlocked } from '@shared/policy-deny'

/** Phase 5 safety review M3: a blocked configuration dump blocks its equivalents too. */

const RUN: Record<string, string[]> = {
  iosxe: ['show running-config', 'show startup-config'],
  iosxr: ['show running-config'],
  junos: ['show configuration'],
  panos: ['show config running'],
  eos: ['show running-config'],
  nxos: ['show running-config']
}

const BYPASSES: [string, string][] = [
  ['iosxe', 'show configuration'],
  ['iosxe', 'show archive config differences nvram:startup-config system:running-config'],
  ['iosxr', 'show configuration running'],
  ['iosxr', 'show configuration commit changes last 1'],
  ['junos', 'show system rollback 0'],
  ['junos', 'show system rollback compare 0 1'],
  ['panos', 'show config candidate'],
  ['panos', 'show config pushed-template'],
  ['eos', 'show session-config'],
  ['nxos', 'show checkpoint hopline-00000000']
]

describe('configuration dump equivalents (M3)', () => {
  for (const [platform, command] of BYPASSES)
    it(`${platform}: "${command}" is blocked when the running configuration is`, () => {
      expect(policyBlocked(RUN, platform, command)).toMatch(/blocked by team policy/)
    })

  it('an abbreviated dump pattern widens too (sh run)', () => {
    expect(policyBlocked({ iosxe: ['sh run'] }, 'iosxe', 'show configuration')).toMatch(/blocked by team policy/)
  })

  it('a narrower pattern is not widened, and other reads still pass', () => {
    expect(policyBlocked({ iosxe: ['show running-config interface'] }, 'iosxe', 'show configuration')).toBeNull()
    expect(policyBlocked(RUN, 'iosxe', 'show interfaces status')).toBeNull()
    expect(policyBlocked(RUN, 'junos', 'show system uptime')).toBeNull()
    expect(policyBlocked(RUN, 'panos', 'show system info')).toBeNull()
  })

  it('without a dump pattern nothing changes', () => {
    expect(policyBlocked({ iosxe: ['show version'] }, 'iosxe', 'show configuration')).toBeNull()
  })

  it('every platform group blocks its own members once its first member is blocked', () => {
    for (const [platform, group] of Object.entries(CONFIG_DUMPS)) for (const cmd of group!) expect(policyBlocked({ [platform]: [group![0]!] }, platform, cmd), `${platform} ${cmd}`).not.toBeNull()
  })
})

describe('an invalid policy blocks every command (L7)', () => {
  it('on every platform and on a device not identified yet', () => {
    const rules = { all: [POLICY_INVALID_RULE] }
    for (const platform of ['iosxe', 'junos', 'auto', 'whatever']) expect(policyBlocked(rules, platform, 'show version')).toMatch(/policy file is invalid/)
  })
})
