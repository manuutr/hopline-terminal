import { expect, it } from 'vitest'
import { complete, resolve, type PlatformId } from '../src'

/** Typical lines a user or the agent types. The budget is 1 ms per resolve/complete (median). */
const LINES: [PlatformId, string][] = [
  ['ios', 'sh ip b'],
  ['ios', 'show ip route vrf RED 10.0.0.0 255.0.0.0 longer-prefixes'],
  ['ios', 'show interfaces GigabitEthernet1/0/1 status | include connected'],
  ['nxos', 'show ip bgp summary vrf all'],
  ['eos', 'sh int status | json'],
  ['junos', 'show route 10.0.0.0/8 exact detail | match "a|b" | no-more'],
  ['fortios', 'get router info bgp neighbors 10.0.0.1 advertised-routes']
]

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

it('resolve and complete take under 1 ms per typical line (median)', () => {
  // Warm up: compiles the trees and lets the JIT settle.
  for (let i = 0; i < 200; i++) for (const [p, l] of LINES) resolve(p, 'exec', l), complete(p, 'exec', l)
  const BATCH = 50
  const samples: number[] = []
  for (let round = 0; round < 20; round++) {
    const t0 = Date.now()
    for (let i = 0; i < BATCH; i++) for (const [p, l] of LINES) resolve(p, 'exec', l), complete(p, 'exec', l)
    samples.push((Date.now() - t0) / (BATCH * LINES.length * 2))
  }
  const ms = median(samples)
  // Visible in verbose runs; the assertion is the contract.
  expect(ms).toBeLessThan(1)
})
