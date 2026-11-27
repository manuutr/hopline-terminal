import { describe, expect, it } from 'vitest'
import { detectMode, type PlatformId } from '../src'

describe('detectMode', () => {
  it.each([
    ['ios', 'core-sw1>', 'user', 'core-sw1'],
    ['ios', 'core-sw1#', 'exec', 'core-sw1'],
    ['ios', 'core-sw1(config)#', 'config', 'core-sw1'],
    ['ios', 'core-sw1(config-if)#', 'config-if', 'core-sw1'],
    ['iosxe', 'core-sw1(config-router)#', 'config-router', 'core-sw1'],
    ['iosxe', 'core-sw1(config-ext-nacl)#', 'config-acl', 'core-sw1'],
    ['nxos', 'leaf1(config-if)#', 'config-if', 'leaf1'],
    ['eos', 'dist-eos1(config-if-Et1)#', 'config-if', 'dist-eos1'],
    ['eos', 'dist-eos1>', 'user', 'dist-eos1'],
    ['junos', 'netops@edge-r1>', 'exec', 'edge-r1'],
    ['panos', 'admin@fw1>', 'exec', 'fw1']
  ] as const)('%s: %s → %s', (p, prompt, mode, host) => {
    const d = detectMode(p as PlatformId, `some output\r\n${prompt} `)
    expect(d?.mode).toBe(mode)
    expect(d?.hostname).toBe(host)
  })

  it('junos configuration mode with the [edit] banner', () => {
    const d = detectMode('junos', '\r\n[edit interfaces ge-0/0/0]\r\nnetops@edge-r1# ')
    expect(d?.mode).toBe('config')
    expect(d?.editPath).toEqual(['interfaces', 'ge-0/0/0'])
  })

  it('fortios config context', () => {
    const d = detectMode('fortios', 'FGT-1 (interface) # ')
    expect(d?.mode).toBe('config')
    expect(d?.context).toBe('interface')
    expect(detectMode('fortios', 'FGT-1 # ')?.mode).toBe('exec')
  })

  it('reports text typed after the prompt', () => expect(detectMode('ios', 'core-sw1#show ver')?.pending).toBe('show ver'))

  it('returns null when not at a prompt', () => {
    expect(detectMode('ios', ' --More-- ')).toBeNull()
    expect(detectMode('ios', 'Password: ')).toBeNull()
  })
})

describe('detectMode: Cisco tier 1', () => {
  it.each([
    ['iosxr', 'RP/0/RP0/CPU0:pe1#', 'exec', 'pe1'],
    ['iosxr', 'RP/0/RP0/CPU0:pe1(config)#', 'config', 'pe1'],
    ['iosxr', 'RP/0/RSP0/CPU0:pe1(config-if)#', 'config-if', 'pe1'],
    ['asa', 'asa1>', 'user', 'asa1'],
    ['asa', 'asa1#', 'exec', 'asa1'],
    ['asa', 'asa1(config)#', 'config', 'asa1'],
    ['c9800', 'wlc9800(config)#', 'config', 'wlc9800'],
    ['ciscosb', 'sg350#', 'exec', 'sg350'],
    ['aireos', '(Cisco Controller) >', 'exec', 'Cisco Controller'],
    ['aireos', '(wlc1) config>', 'config', 'wlc1'],
    ['ftd', '> ', 'exec', '']
  ] as const)('%s: %s -> %s', (p, prompt, mode, host) => {
    const d = detectMode(p as PlatformId, `output\r\n${prompt}`)
    expect(d?.mode).toBe(mode)
    expect(d?.hostname).toBe(host)
  })
})

describe('detectMode: tier 2', () => {
  it.each([
    ['aoscx', 'sw1#', 'exec', 'sw1'],
    ['aoscx', 'sw1(config-if)#', 'config-if', 'sw1'],
    ['vrp', '<HUAWEI>', 'exec', 'HUAWEI'],
    ['vrp', '[HUAWEI]', 'config', 'HUAWEI'],
    ['vrp', '[~HUAWEI]', 'config', 'HUAWEI'],
    ['vrp', '[HUAWEI-GigabitEthernet0/0/1]', 'config-if', 'HUAWEI'],
    ['vrp', '[HUAWEI-bgp]', 'config-router', 'HUAWEI']
  ] as const)('%s: %s -> %s', (p, prompt, mode, host) => {
    const d = detectMode(p as PlatformId, `output\r\n${prompt}`)
    expect(d?.mode).toBe(mode)
    expect(d?.hostname).toBe(host)
  })
})
