import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fleetCases, singleCases } from './eval/catalogue'
import type { LlmProvider, Part, TurnResult } from '../src/main/llm/types'
import { framedBodies, runEval, runSingle, SCRIPTED, writeReport, type EvalReport, type ProviderFactory } from './eval/harness'

/**
 * The scripted eval baseline (docs/EVALS.md), in the normal suite. A deterministic investigator
 * plays each case through the REAL agents (per-tab `Agent`, `FleetRun`) over SSH to the simulator,
 * under the default budgets and in read-only mode. It checks the plumbing a live model depends on:
 * the tools work, the outputs come back framed and parseable, and every case's expected evidence
 * is reachable with read-only commands. It says nothing about a model's reasoning.
 */

const dir = mkdtempSync(join(tmpdir(), 'hopline-eval-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let report: EvalReport

describe('eval baseline (scripted provider, same code path as the live eval)', () => {
  it('covers the fault matrix: every fault, four vendors, single-device and fleet', () => {
    const s = singleCases()
    const scenarios = new Set(s.map((c) => c.scenario))
    for (const id of ['bgp-wrong-as', 'bgp-auth-mismatch', 'bgp-acl-blocked', 'ospf-mtu-mismatch', 'ospf-hello-mismatch', 'ospf-area-mismatch', 'err-disabled', 'port-security-violation', 'vlan-missing-trunk', 'acl-drop', 'duplex-mismatch', 'stp-root-moved', 'fhrp-flap', 'crc-errors']) expect(scenarios).toContain(id)
    expect(new Set(s.map((c) => c.family))).toEqual(new Set(['ios', 'nxos', 'eos', 'junos']))
    expect(fleetCases().length).toBeGreaterThanOrEqual(5)
  })

  it('every case passes: evidence reached and cited, quoted lines verified, nothing but reads', async () => {
    report = await runEval({ label: 'scripted', model: null, providers: SCRIPTED, concurrency: 6 })
    const bad = report.results.filter((r) => !r.pass).map((r) => ({ id: r.id, error: r.error, missing: r.rootCause.missing, evidence: r.evidence.filter((e) => !e.reached || !e.cited).map((e) => e.what), unverified: r.unverified, violations: r.violations }))
    expect(bad).toEqual([])
    for (const r of report.results) {
      expect(r.evidence.every((e) => e.reached && e.cited), r.id).toBe(true)
      expect(r.sentNonRead, r.id).toEqual([])
      expect(r.violations, r.id).toEqual([])
      expect(r.quoted, r.id).toBeGreaterThan(0)
      expect(r.verified, r.id).toBe(r.quoted)
      expect(r.unknownReads, r.id).toEqual([])
    }
    expect(report.summary.usage.estimated).toBe(true)
  }, 180_000)

  it('writes the JSON and markdown reports and the summary', () => {
    const files = writeReport(report, dir)
    const json = JSON.parse(readFileSync(files.json, 'utf8')) as EvalReport
    expect(json.summary.cases).toBe(report.results.length)
    expect(readFileSync(files.summary, 'utf8')).toMatch(/# Hopline eval: scripted\n[\s\S]*\| Root cause correct \| (\d+)\/\1 \|/)
  })
})

/**
 * A live model answers in its own shape: the fix in a fence, commands in inline code, a table, a
 * proposal at the end, the odd read the guard does not know. These are graded like the live run
 * would be, so a correct live answer is not failed for its formatting.
 */
describe('grading realistic answers (no model)', () => {
  const tool = (calls: { name: string; input: unknown }[], tag: string): TurnResult => ({ message: { role: 'assistant', parts: calls.map((c, i): Part => ({ type: 'tool_call', id: `${tag}_${i}`, name: c.name, input: c.input })) }, stop: 'tool_use' })
  const say = (text: string): TurnResult => ({ message: { role: 'assistant', parts: [{ type: 'text', text }] }, stop: 'end' })
  const results = (msgs: { parts: Part[] }[]) => (msgs.at(-1)?.parts ?? []).flatMap((p) => (p.type === 'tool_result' ? [p.content] : []))

  /** Probes, then an unknown read and a proposal, then a live-style answer built by `answer`. */
  function liveStyle(answer: (evidence: string[], rootCause: string) => string, extra: { name: string; input: unknown }[] = []): ProviderFactory {
    return {
      single: (_c, truth) => {
        let n = 0
        let lines: string[] = []
        const p: LlmProvider = {
          id: 'scripted',
          async turn(req) {
            n++
            if (n === 1) return tool(truth.probes.map((x) => ({ name: 'run_show_command', input: { command: x.command, reason: 'look' } })), 'p')
            if (n === 2) {
              const got = results(req.messages)
              lines = truth.evidence.flatMap((e) => framedBodies(got[e.probe] ?? '').join('\n').split('\n').filter((l) => e.re.test(l)).slice(0, 1).map((l) => l.trim()))
              if (extra.length) return tool(extra, 'x')
            }
            const text = answer(lines, truth.rootCause)
            req.onText(text)
            return say(text)
          }
        }
        return p
      },
      fleet: () => {
        throw new Error('single only')
      }
    }
  }
  const bgp = singleCases().find((c) => c.id === 'bgp-wrong-as/ios')!

  it('a fix fence, inline commands and a table do not fail a correct, evidenced answer', async () => {
    const r = await runSingle(
      bgp,
      liveStyle((ev, rc) =>
        [
          '## Root cause',
          rc,
          '',
          '| Neighbor | State | Why |',
          '| --- | --- | --- |',
          '| (see above) | Idle/Active | peer in wrong AS |',
          '',
          'I ran `show ip bgp summary` and `show logging | include BGP` to confirm.',
          '',
          '```',
          ...ev,
          '```',
          '',
          'Fix:',
          '```',
          'router bgp 65000',
          ' neighbor 192.0.2.1 remote-as 64999',
          '```'
        ].join('\n')
      )
    )
    expect(r.error).toBeUndefined()
    expect(r.evidence.some((e) => e.cited)).toBe(true)
    expect(r.unverified.length).toBeGreaterThan(0)
    expect(r.violations).toEqual([])
    expect(r.pass, JSON.stringify({ missing: r.rootCause.missing, ev: r.evidence })).toBe(true)
  })

  it('evidence cited mid-sentence in inline code, in a labelled bullet or in a table cell counts', async () => {
    const shapes: ((ev: string[], rc: string) => string)[] = [
      (ev, rc) => `${rc} The log shows \`${ev.at(-1)}\` right after the session drops.`,
      (ev, rc) => `${rc}\n\n- Log: \`${ev.at(-1)}\`\n- State: see above`,
      (ev, rc) => `${rc}\n\n| What | Line |\n| --- | --- |\n| mismatch | ${ev.at(-1)} |`
    ]
    for (const shape of shapes) {
      const r = await runSingle(bgp, liveStyle(shape))
      expect(r.evidence.at(-1)!.cited, shape(['<line>'], '<rc>')).toBe(true)
      expect(r.pass).toBe(true)
    }
  })

  it('an evidence line that is made up does not count as cited', async () => {
    const r = await runSingle(bgp, liveStyle((ev, rc) => `${rc}\n\n\`\`\`\n${ev.map((l) => `${l} (seen twice)`).join('\n')}\n\`\`\``))
    expect(r.evidence.some((e) => e.cited)).toBe(false)
    expect(r.pass).toBe(false)
  })

  it('a proposal after the diagnosis is counted, not a violation; an unknown read is reported, not failed', async () => {
    const r = await runSingle(
      bgp,
      liveStyle(
        (ev, rc) => `**Root cause:** ${rc}\n\n\`\`\`\n${ev.join('\n')}\n\`\`\``,
        [
          { name: 'run_show_command', input: { command: 'show frobnicate status', reason: 'look' } },
          { name: 'propose_config_change', input: { commands: ['router bgp 65000', 'neighbor 192.0.2.1 remote-as 64999'], rationale: 'fix the AS' } }
        ]
      )
    )
    expect(r.proposals).toBe(1)
    expect(r.unknownReads).toEqual(['show frobnicate status'])
    expect(r.violations).toEqual([])
    expect(r.sentNonRead).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('copy, clear or an unknown verb through the read tool is a violation, not an unknown read', async () => {
    for (const command of ['copy', 'clear', 'frobnicate now']) {
      const r = await runSingle(bgp, liveStyle((ev, rc) => `${rc}\n\`\`\`\n${ev.join('\n')}\n\`\`\``, [{ name: 'run_show_command', input: { command, reason: 'x' } }]))
      expect(r.unknownReads, command).toEqual([])
      expect(r.violations.map((v) => v.command), command).toEqual([command])
      expect(r.pass, command).toBe(false)
    }
  })

  it('a case that times out cancels the agent, so no paid turn keeps running', async () => {
    let aborted: AbortSignal | undefined
    const hang: ProviderFactory = {
      single: () => ({
        id: 'scripted',
        turn: (req) =>
          new Promise<TurnResult>((_, reject) => {
            aborted = req.signal
            req.signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true })
          })
      }),
      fleet: () => {
        throw new Error('single only')
      }
    }
    const r = await runSingle(bgp, hang, 300)
    expect(r.error).toBe('eval timeout')
    expect(aborted?.aborted).toBe(true)
  })

  it('a judge that throws falls back to the keyword verdict, keeps the answer and meters the judge', async () => {
    const report = await runEval({ label: 'judge-throws', model: null, providers: { ...SCRIPTED, judge: () => ({ id: 'scripted', turn: async () => { throw new Error('judge down') } }) }, mode: 'single', filter: /^bgp-wrong-as\/ios$/ })
    const [r] = report.results
    expect(r!.error).toBeUndefined()
    expect(r!.answer).toMatch(/Root cause/)
    expect(r!.rootCause.judge).toBeUndefined()
    expect(r!.rootCause.correct).toBe(true)
    expect(r!.usage.turns).toBe(3)
  })

  it('a non-read attempt through the read tool fails the case', async () => {
    const r = await runSingle(bgp, liveStyle((ev, rc) => `${rc}\n\`\`\`\n${ev.join('\n')}\n\`\`\``, [{ name: 'run_show_command', input: { command: 'clear ip bgp *', reason: 'reset' } }]))
    expect(r.violations.map((v) => v.command)).toEqual(['clear ip bgp *'])
    expect(r.sentNonRead).toEqual([])
    expect(r.pass).toBe(false)
  })

  it('the LLM judge path: fenced JSON or prose then JSON is parsed; garbage is a wrong verdict', async () => {
    const judge = (reply: string) => (): LlmProvider => ({
      id: 'scripted',
      async turn(req) {
        expect(req.tools).toEqual([])
        expect(req.signal.aborted).toBe(false)
        req.onText(reply)
        return say(reply)
      }
    })
    const run = (reply: string) => runEval({ label: 'judge', model: null, providers: { ...SCRIPTED, judge: judge(reply) }, mode: 'single', filter: /^bgp-wrong-as\/(ios|junos)$/ })
    const fenced = await run('Verdict:\n```json\n{"correct": true, "reason": "Same mechanism and neighbor."}\n```')
    expect(fenced.results.map((r) => r.rootCause.judge)).toEqual([{ correct: true, reason: 'Same mechanism and neighbor.' }, { correct: true, reason: 'Same mechanism and neighbor.' }])
    expect(fenced.summary.passed).toBe(2)
    const prose = await run('The answer names the wrong AS on the same neighbor. {"correct": false, "reason": "hedges"}')
    expect(prose.results.every((r) => r.rootCause.judge?.correct === false && !r.rootCause.correct && !r.pass)).toBe(true)
    const junk = await run('I cannot decide.')
    expect(junk.results[0]!.rootCause.judge!.reason).toMatch(/unparseable/)
  })
})
