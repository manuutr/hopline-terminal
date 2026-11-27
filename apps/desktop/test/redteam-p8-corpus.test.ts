import { appendFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classify, detectMode, type GuardPlatform } from '@hopline/guard'
import { policyBlocked } from '@shared/policy-deny'
import { hostRefusal } from '../src/session-host/guard-check'
import { reachRefusal } from '../src/main/fleet/reach'
import { analyze } from '../src/main/productivity/runner'
import { CORPUS, POLICY_CASES, POLICY_RULES, REACH_CASES, type Row } from './fixtures/p8-corpus'
import { KNOWN_ANALYZE, KNOWN_CORPUS, KNOWN_POLICY, KNOWN_REACH } from './fixtures/p8-corpus-known'

/**
 * Phase 8 security review, workstream A: the 8,047-row adversarial corpus as a permanent
 * regression test, run against the real classifier (main) AND the session host's re-check.
 *
 * - `B` rows: main blocks the line, and the host refuses it under a read, a config and a
 *   disruptive verdict (with the right typed hostname).
 * - `N` rows: main does not call it read, and the host refuses a read verdict for it.
 * - `R` rows: main calls it read and the host accepts the read verdict.
 *
 * Every `B` row also goes through `analyze()` (snippets, send-to-many, multi-device runs).
 * The team-policy dump group (M2) and the fleet reach guard (H3) have their own case lists.
 *
 * The known-failure lists (fixtures/p8-corpus-known.ts) are strict both ways: a row that fails
 * and is not listed fails the test, and so does a listed row that now passes (remove it).
 */

const TAILS: Record<string, [string, string]> = {
  ios: ['R1#', 'R1(config)#'], iosxe: ['R1#', 'R1(config)#'], c9800: ['WLC1#', 'WLC1(config)#'], nxos: ['N1#', 'N1(config)#'],
  iosxr: ['RP/0/RP0/CPU0:R1#', 'RP/0/RP0/CPU0:R1(config)#'], asa: ['asa1#', 'asa1(config)#'], ftd: ['>', '>'], eos: ['E1#', 'E1(config)#'],
  junos: ['admin@J1> ', '[edit]\nadmin@J1# '], panos: ['admin@PA1> ', '[edit]\nadmin@PA1# '], fortios: ['FGT1 # ', 'FGT1 (global) # '],
  aoscx: ['sw1# ', 'sw1(config)# '], vrp: ['<R1>', '[R1]'], aireos: ['(WLC1) >', '(WLC1) config>'], ciscosb: ['sw1#', 'sw1(config)#']
}

export const rowKey = (r: Row) => `${r.p}|${r.mode ?? 'exec'}|${r.variant ?? 'base'}|${JSON.stringify(r.cmd)}`

function check(r: Row): { pass: boolean; why: string } {
  const p = r.p as GuardPlatform
  const g = classify(r.cmd, p, { mode: (r.mode ?? 'exec') as never })
  const [et, ct] = TAILS[r.p]!
  const hn = detectMode(p, et)?.hostname ?? ''
  const tail = r.mode && r.mode !== 'exec' ? ct : et
  const hostRead = hostRefusal(r.cmd, p, 'read', et)
  const hostCfg = hostRefusal(r.cmd, p, 'config', tail, undefined, [hn])
  const hostDis = hostRefusal(r.cmd, p, 'disruptive', tail, hn, [hn])
  let pass: boolean
  if (r.expect === 'B') pass = g.kind === 'blocked' && !!hostRead && !!hostCfg && !!hostDis
  else if (r.expect === 'N') pass = g.kind !== 'read' && !!hostRead
  else pass = g.kind === 'read' && !hostRead
  const host = `host read=${hostRead ? 'refused' : 'ALLOWED'} config=${hostCfg ? 'refused' : 'ALLOWED'} disruptive=${hostDis ? 'refused' : 'ALLOWED'}`
  return { pass, why: `expected ${r.expect}, main=${g.kind} (${g.reason}); ${host}` }
}

/** Strict both ways: unexpected failures and stale known failures are both reported. */
function compare(failing: Map<string, string>, known: readonly string[], name: string) {
  // Maintenance: P8_CORPUS_DUMP=<file> appends today's failures per list (to prune the known lists).
  if (process.env.P8_CORPUS_DUMP) appendFileSync(process.env.P8_CORPUS_DUMP, JSON.stringify({ name, failing: [...failing.keys()] }) + '\n')
  const k = new Set(known)
  const unexpected = [...failing].filter(([key]) => !k.has(key)).map(([key, why]) => `${key} :: ${why}`)
  const fixed = known.filter((key) => !failing.has(key))
  return { unexpected, fixed }
}

describe('Phase 8 red-team corpus (main classifier + session host re-check)', () => {
  it('has the full corpus', () => {
    // 8,047 rows; 20 are repeats of a row in another category (same platform, mode and line), so
    // the known-failure lists key on 8,027 distinct lines.
    expect(CORPUS.length).toBe(8047)
    expect(new Set(CORPUS.map(rowKey)).size).toBe(8027)
  })

  it('every row holds, except the listed known failures (and none of those passes)', () => {
    const failing = new Map<string, string>()
    for (const r of CORPUS) {
      const c = check(r)
      if (!c.pass) failing.set(rowKey(r), `[${r.cat}] ${c.why}`)
    }
    const { unexpected, fixed } = compare(failing, KNOWN_CORPUS, 'KNOWN_CORPUS')
    expect(unexpected, 'rows that fail and are not known failures').toEqual([])
    expect(fixed, 'known failures that now pass: remove them from p8-corpus-known.ts').toEqual([])
  })

  it('every B row is blocked or refused through analyze() (snippets, send-to-many, multi-device)', () => {
    const failing = new Map<string, string>()
    for (const r of CORPUS.filter((x) => x.expect === 'B')) {
      const a = analyze(r.p, [r.cmd])
      if (a.kind !== 'blocked' && a.kind !== 'refused') failing.set(rowKey(r), `${a.kind}/${a.shape ?? '-'} ${a.reason.slice(0, 120)}`)
    }
    const { unexpected, fixed } = compare(failing, KNOWN_ANALYZE, 'KNOWN_ANALYZE')
    expect(unexpected).toEqual([])
    expect(fixed, 'known failures that now pass: remove them from p8-corpus-known.ts').toEqual([])
  })

  it('the team policy dump group (M2) blocks every config-dump spelling', () => {
    const failing = new Map<string, string>()
    for (const [p, c] of POLICY_CASES) if (!policyBlocked(POLICY_RULES, p, c)) failing.set(`${p}|${c}`, 'allowed by policy')
    const { unexpected, fixed } = compare(failing, KNOWN_POLICY, 'KNOWN_POLICY')
    expect(unexpected).toEqual([])
    expect(fixed, 'known failures that now pass: remove them from p8-corpus-known.ts').toEqual([])
  })

  it('the fleet reach guard (H3) refuses every abbreviation, wrapper and vendor verb', () => {
    const failing = new Map<string, string>()
    for (const [p, c] of REACH_CASES) if (!reachRefusal(c, p as GuardPlatform, () => true)) failing.set(`${p}|${c}`, `passes (guard: ${classify(c, p as GuardPlatform).kind})`)
    const { unexpected, fixed } = compare(failing, KNOWN_REACH, 'KNOWN_REACH')
    expect(unexpected).toEqual([])
    expect(fixed, 'known failures that now pass: remove them from p8-corpus-known.ts').toEqual([])
  })
})
