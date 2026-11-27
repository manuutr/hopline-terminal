import { describe, expect, it } from 'vitest'
import { CONFIG_SESSIONS, resolve, type PlatformId } from '@hopline/cli-model'
import { classify } from '@hopline/guard'
import { changesMode, modeChangeLine } from '@shared/cli'
import { analyze } from '../src/main/productivity/runner'
import { allSweepLines, sampled, type SweepLine } from './support/cli-sweep'

/**
 * Phase 4 fix-round review R1, R2, X1, X3: a permanent sweep over every exec and configuration
 * line of the cli-model trees (with parameters filled and every keyword also cut to its shortest
 * unique prefix), through the runner's `analyze`.
 *
 * The whole sweep (~135k lines) runs in about 2 s, so it is the default. Set
 * HOPLINE_SAMPLE_SWEEP=1 to run a deterministic tenth of it instead.
 */
const ALL = allSweepLines()
const LINES: readonly SweepLine[] = process.env.HOPLINE_SAMPLE_SWEEP ? sampled(ALL, 10) : ALL
const GENERIC = new Set(['set', 'no', 'undo', 'default', 'delete'])
const withSession = (p: PlatformId) => CONFIG_SESSIONS[p].enter.length > 0 && !CONFIG_SESSIONS[p].blocks

describe('routing sweep over every cli-model line', () => {
  it('covers every platform with thousands of lines', () => {
    expect(LINES.length).toBeGreaterThan(process.env.HOPLINE_SAMPLE_SWEEP ? 10_000 : 100_000)
    expect(new Set(LINES.map((l) => l.platform)).size).toBe(15)
  })

  it('R1: no read is rerouted into a configuration session', () => {
    const bad = LINES.filter((l) => l.tree === 'exec' && classify(l.line, l.platform).kind === 'read' && analyze(l.platform, [l.line], { user: 'admin' }).shape === 'config')
    expect(bad.map((l) => `${l.platform}: ${l.line}`)).toEqual([])
  })

  it('R1: no exec command is rerouted into a configuration session; only generic configuration heads a configuration tree resolves deeper', () => {
    const bad: string[] = []
    let generic = 0
    for (const l of LINES) {
      if (l.tree !== 'exec' || !withSession(l.platform)) continue
      const v = classify(l.line, l.platform)
      if (v.kind === 'read' || v.kind === 'blocked' || !v.resolved) continue
      if (analyze(l.platform, [l.line], { user: 'admin' }).shape !== 'config') continue
      const head = v.expanded.split(/\s+/)[0]!.toLowerCase()
      const own = resolve(l.platform, CONFIG_SESSIONS[l.platform].linesFrom, l.line)
      // Exec knew it only as the bare generic word (`set`, `no`, `default` with nothing after it
      // resolved): a configuration line, not an exec command. Anything exec resolved deeper stays exec.
      const execDepth = v.expanded.trim().split(/\s+/).length
      if (!GENERIC.has(head) || execDepth > 1 || own.status !== 'ok' || own.resolvedMode === 'exec') bad.push(`${l.platform}: ${l.line}`)
      else generic++
    }
    expect(bad).toEqual([])
    // Junos `set …` and EOS/IOS `no …` lines still reach configuration.
    expect(generic).toBeGreaterThan(0)
  })

  it('R2: an exec command the guard does not resolve whole never goes to a configuration session', () => {
    const bad: string[] = []
    for (const l of LINES) {
      if (l.tree !== 'exec' || !withSession(l.platform)) continue
      const v = classify(l.line, l.platform)
      if (v.resolved || v.kind === 'blocked') continue
      const head = v.expanded.split(/\s+/)[0]?.toLowerCase() ?? ''
      if (GENERIC.has(head)) continue
      if (analyze(l.platform, [l.line], { user: 'admin' }).shape === 'config') bad.push(`${l.platform}: ${l.line}`)
    }
    expect(bad).toEqual([])
  })

  it('M1/X1/X3: every exec line that enters or leaves a mode, or switches context, is refused', () => {
    const bad: string[] = []
    let checked = 0
    for (const l of LINES) {
      if (l.tree !== 'exec') continue
      const v = classify(l.line, l.platform)
      if (v.kind === 'read' || !v.resolved) continue
      const moves = (v.nextMode && v.nextMode !== v.mode) || v.leavesConfig || changesMode(l.platform, l.line, v)
      if (!moves) continue
      checked++
      const a = analyze(l.platform, [l.line], { user: 'admin' })
      if (a.kind !== 'refused' && a.kind !== 'blocked') bad.push(`${l.platform}: ${l.line} -> ${a.kind}/${a.shape}`)
    }
    expect(bad).toEqual([])
    expect(checked).toBeGreaterThan(50)
  })

  it('M1/X3: every configuration line that leaves configuration mode is refused in a proposal', () => {
    const bad: string[] = []
    for (const l of LINES) {
      if (l.tree !== 'config' || !withSession(l.platform)) continue
      const v = classify(l.line, l.platform, { mode: CONFIG_SESSIONS[l.platform].linesFrom })
      if (!v.leavesConfig) continue
      const a = analyze(l.platform, ['description x', l.line], { user: 'admin' })
      if (a.kind !== 'refused' && a.kind !== 'blocked') bad.push(`${l.platform}: ${l.line}`)
      if (!modeChangeLine(l.platform, l.line)) bad.push(`${l.platform}: ${l.line} (modeChangeLine)`)
    }
    expect(bad).toEqual([])
  })
})
