import { describe, expect, it } from 'vitest'
import type { PlatformId } from '@hopline/cli-model'
import { contextChangeLine, modeChangeLine } from '@shared/cli'
import { analyze } from '../src/main/productivity/runner'

/** Phase 4 fix-round review R1, R2, X1, X3: the review's own examples (the sweep covers the rest). */

describe('R1: exec commands keep the exec shape', () => {
  const cases: [PlatformId, string][] = [
    ['nxos', 'debug ip ospf adj'],
    ['nxos', 'undebug all'],
    ['nxos', 'cd bootflash:'],
    ['eos', 'more flash:startup-config'],
    ['eos', 'diff running-config startup-config'],
    ['eos', 'monitor session x source Ethernet1'],
    ['asa', 'capture cap1 interface inside match ip any any'],
    ['asa', 'shun 10.0.0.9'],
    ['asa', 'debug crypto ikev2 protocol 255'],
    ['vrp', 'terminal monitor'],
    ['vrp', 'debugging ip packet']
  ]
  it.each(cases)('%s: "%s" is not wrapped in a configuration session', (platform, line) => {
    const a = analyze(platform, [line], { user: 'admin' })
    expect(a.shape).toBe('exec')
    expect(a.wrapper).toBeUndefined()
  })
  it('configuration lines that exec knows only as a bare generic word still reach configuration', () => {
    expect(analyze('junos', ['set interfaces ge-0/0/0 disable'])).toMatchObject({ shape: 'config', kind: 'disruptive' })
    expect(analyze('eos', ['no ip routing'])).toMatchObject({ shape: 'config', kind: 'disruptive' })
    expect(analyze('ios', ['no vlan 10'])).toMatchObject({ shape: 'config' })
  })
})

describe('R2: an exec command Hopline Terminal does not know whole is refused, not wrapped', () => {
  it.each([
    ['eos', 'clear ip bgp neighbor 10.0.0.1'],
    ['ios', 'sh bg ip ospf adj'],
    ['junos', 'show arp interface Ethernet1']
  ] as [PlatformId, string][])('%s: "%s"', (platform, line) => {
    const a = analyze(platform, [line], { user: 'admin' })
    expect(a.kind).toBe('refused')
    expect(a.shape).toBeUndefined()
    expect(a.reason).toMatch(/does not know the rest of it/)
  })
  it('a configuration snippet whose lines exec does not know still runs as configuration', () => {
    expect(analyze('ios', ['interface GigabitEthernet1/0/1', 'description uplink'])).toMatchObject({ shape: 'config' })
  })
})

describe('X1: context switches are refused', () => {
  const cases: [PlatformId, string][] = [
    ['nxos', 'routing-context vrf blue'],
    ['nxos', 'rout vrf blue'],
    ['eos', 'routing-context vrf blue'],
    ['fortios', 'execute enter vdom1'],
    ['fortios', 'exe ent root'],
    ['panos', 'set system setting target-vsys vsys2'],
    ['panos', 'set cli scripting-mode on'],
    ['panos', 'set cli config-output-format set']
  ]
  it.each(cases)('%s: "%s"', (platform, line) => {
    expect(contextChangeLine(platform, line)).toBe(true)
    const a = analyze(platform, [line], { user: 'admin' })
    expect(a.kind).toBe('refused')
    expect(a.shape).toBeUndefined()
  })
  it('ordinary lines with the same first words are not context switches', () => {
    expect(contextChangeLine('panos', 'set cli pager off')).toBe(false)
    expect(contextChangeLine('fortios', 'execute ping 10.0.0.1')).toBe(false)
    expect(analyze('panos', ['set cli pager off'], { user: 'admin' }).kind).not.toBe('refused')
  })
})

describe('X3: one- and two-letter abbreviations of mode words', () => {
  it.each([
    ['vrp', 'q'],
    ['vrp', 'qu'],
    ['junos', 'q'],
    ['panos', 'q'],
    ['ios', 'ex'],
    ['nxos', 'en'],
    ['aoscx', 'en']
  ] as [PlatformId, string][])('%s: "%s" is a mode change in a proposal', (platform, line) => {
    expect(modeChangeLine(platform, line)).toBe(true)
    const a = analyze(platform, ['interface x1', line], { user: 'admin' })
    expect(a.kind).toBe('refused')
  })
  it.each([
    ['ios', 'int Gi1/0/1'],
    ['ios', 'lo'],
    ['ios', 'co'],
    ['vrp', 'interface x1']
  ] as [PlatformId, string][])('%s: "%s" (another configuration word) is not', (platform, line) => {
    expect(modeChangeLine(platform, line)).toBe(false)
  })
})
