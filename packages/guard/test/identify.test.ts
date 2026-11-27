import { describe, expect, it } from 'vitest'
import { classify, fingerprint, GUARD_PLATFORMS, probeCommand, type GuardPlatform } from '../src'

describe('probeCommand under the guard', () => {
  // Every pair and the full set of candidates: the probe must be read on each platform it covers.
  const sets: GuardPlatform[][] = [[...GUARD_PLATFORMS]]
  for (const a of GUARD_PLATFORMS) for (const b of GUARD_PLATFORMS) if (a < b) sets.push([a, b])

  it.each(sets.map((s) => [s.join('+'), s] as const))('%s', (_name, cands) => {
    const p = probeCommand({ platform: 'unknown', confidence: 0, evidence: [], candidates: cands.map((platform) => ({ platform, score: 0.3 })) })
    expect(p.covers.length).toBeGreaterThan(0)
    expect([...p.covers, ...p.others].sort()).toEqual([...cands].sort())
    for (const c of p.covers) expect(classify(p.command, c).kind, `${p.command} on ${c}`).toBe('read')
    // Where the probe is not read, it must be a command the device does not know (it prints an
    // error), never a recognised state-changing or blocked one.
    for (const o of p.others) {
      const r = classify(p.command, o)
      expect(r.kind === 'read' || (r.kind === 'config' && !r.resolved), `${p.command} on ${o}: ${r.kind} ${r.reason}`).toBe(true)
    }
  })

  it('a decided fingerprint probes that platform only', () => {
    const fp = fingerprint({ showVersion: 'sw-version: 11.1.6\nmodel: PA-VM' })
    const p = probeCommand(fp)
    expect(p).toEqual({ command: 'show system info', covers: ['panos'], others: [] })
  })
})

describe('unknown platform', () => {
  it.each(['show version', 'sh ip int br', 'get system status', 'reload'])('%s is blocked on an unknown platform', (cmd) => {
    expect(classify(cmd, 'unknown' as GuardPlatform).kind).toBe('blocked')
  })
})
