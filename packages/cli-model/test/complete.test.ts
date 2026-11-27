import { describe, expect, it } from 'vitest'
import { complete } from '../src'

describe('complete', () => {
  it.each([
    ['ios', 'sh ip b', 'gp'],
    ['iosxe', 'sh ip b', 'gp'],
    ['nxos', 'sh ip b', 'gp'],
    ['eos', 'sh ip b', 'gp'],
    ['junos', 'show bgp s', 'ummary'],
    ['fortios', 'get sys', 'tem']
  ] as const)('%s: ghost text for "%s" is "%s"', (p, line, ghost) => expect(complete(p, 'exec', line).ghost).toBe(ghost))

  it('candidates carry help and risk', () => {
    const c = complete('ios', 'exec', 'sh ip b')
    expect(c.candidates).toEqual([expect.objectContaining({ text: 'bgp', kind: 'keyword', risk: 'read' })])
    expect(c.candidates[0]!.help).toBeTruthy()
    expect(c.partial).toBe('b')
    expect(c.replaceFrom).toBe(6)
  })

  it('lists next keywords after a space', () => {
    const c = complete('ios', 'exec', 'show ip bgp ')
    expect(c.partial).toBe('')
    expect(c.candidates.map((x) => x.text)).toEqual(expect.arrayContaining(['summary', 'neighbors']))
  })

  it('no ghost text when the prefix is ambiguous', () => {
    const c = complete('ios', 'exec', 'show i')
    expect(c.candidates.length).toBeGreaterThan(1)
    expect(c.ghost).toBe('')
  })

  it('offers live values for typed params, with a unique ghost', () => {
    const live = { interfaces: ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/24', 'Vlan10'] }
    const c = complete('ios', 'exec', 'show interfaces Gi1/0/2', live)
    expect(c.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'GigabitEthernet1/0/24', kind: 'value' })]))
    expect(c.ghost).toBe('4')
  })

  it('completes pipe modifiers after |', () => {
    const c = complete('ios', 'exec', 'show run | inc')
    expect(c.candidates.map((x) => x.text)).toContain('include')
    expect(c.ghost).toBe('lude')
  })
})
