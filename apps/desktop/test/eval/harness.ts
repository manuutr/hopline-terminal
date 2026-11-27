import { classify, isPlatform } from '@hopline/guard'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FleetEvent } from '@shared/fleet'
import type { AgentEvent, Settings } from '@shared/types'
import { startSim } from '../../../../packages/simulator/src/index.ts'
import { Agent } from '../../src/main/agent/agent'
import { AuditLog } from '../../src/main/db/audit'
import { openDb } from '../../src/main/db'
import { LanePool } from '../../src/main/fleet/pool'
import { FleetRun } from '../../src/main/fleet/run'
import type { TabControl } from '../../src/main/host/client'
import type { ChatMessage, LlmProvider, Part, TurnRequest, TurnResult } from '../../src/main/llm/types'
import type { SettingsService } from '../../src/main/settings'
import { simHost } from '../fleet-helpers'
import { fakeTab, localControl } from '../helpers'
import { fleetCases, fleetLab, labPlatform, LABEL, SESSION_PLATFORM, singleCases, type Evidence, type FleetCase, type Probe, type SingleCase, type Truth } from './catalogue'

/**
 * One eval path for every provider (docs/EVALS.md): the scripted baseline in CI and the live model
 * run go through the same `runEval`, the same agents (the real single-device `Agent`, the real
 * `FleetRun`), the same simulator and the same grading. Only the provider differs.
 */

// ------------------------------------------------------------------ metering

export interface Usage {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Usage was estimated from request sizes (a provider that reports none, like the scripted one). */
  estimated: boolean
}

export const emptyUsage = (): Usage => ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false })

/** What the model received and did, seen at the provider boundary (after safeProvider's redaction). */
export interface Transcript {
  answer?: string
  usage: Usage
  requests: { system: string; messages: ChatMessage[] }[]
  /** Every tool call the model made; `device` is the fleet worker's device (from local request metadata). */
  calls: { name: string; input: unknown; device?: string }[]
}

const tokens = (s: string): number => Math.ceil(s.length / 4)

/** Wrap a provider: count usage (estimated at ~4 characters a token when the provider reports none) and record calls. */
export function metered(p: LlmProvider, t: Transcript): LlmProvider {
  return {
    id: p.id,
    async turn(req: TurnRequest): Promise<TurnResult> {
      t.requests.push({ system: req.system, messages: structuredClone(req.messages) })
      // Counted when sent, so a turn that fails (a judge that throws) still shows in the report.
      t.usage.turns++
      const r = await p.turn(req)
      // Grade quoted evidence in the same representation the model received, before UI aliases expand.
      if (req.meta?.source === 'agent' || req.meta?.lane === 'coordinator') {
        t.answer = (t.answer ?? '') + r.message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('')
      }
      if (r.usage) {
        t.usage.inputTokens += r.usage.inputTokens
        t.usage.outputTokens += r.usage.outputTokens
        t.usage.cacheReadTokens += r.usage.cacheReadTokens ?? 0
        t.usage.cacheWriteTokens += r.usage.cacheWriteTokens ?? 0
      } else {
        t.usage.estimated = true
        t.usage.inputTokens += tokens(req.system + JSON.stringify(req.messages) + JSON.stringify(req.tools))
        t.usage.outputTokens += tokens(JSON.stringify(r.message.parts))
      }
      const device = req.meta?.source === 'fleet' ? req.meta.sessionName : undefined
      for (const part of r.message.parts) if (part.type === 'tool_call') t.calls.push({ name: part.name, input: part.input, ...(device ? { device } : {}) })
      return r
    }
  }
}

const newTranscript = (): Transcript => ({ usage: emptyUsage(), requests: [], calls: [] })

/** Every tool result and user text the model was given, across all requests (deduplicated). */
export function modelInputs(t: Transcript): string[] {
  const seen = new Set<string>()
  for (const r of t.requests) for (const m of r.messages) if (m.role === 'user') for (const p of m.parts) if (p.type === 'tool_result') seen.add(p.content)
  return [...seen]
}

// ------------------------------------------------------------------ scripted providers (the baseline)

/** The device text inside `<device_output …>` frames, without the frame lines. */
export function framedBodies(text: string): string[] {
  const out: string[] = []
  const re = /<device_output id="([0-9a-f]{12})"[^>]*untrusted="true">\n([\s\S]*?)\n<\/device_output id="\1">/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[2]!)
  return out
}

const lineMatching = (texts: string[], re: RegExp): string | undefined => {
  for (const t of texts) for (const l of framedBodies(t).join('\n').split('\n')) if (re.test(l)) return l.trim()
  return undefined
}

const lastResults = (req: TurnRequest): string[] => (req.messages.at(-1)?.parts ?? []).flatMap((p) => (p.type === 'tool_result' ? [p.content] : []))
const answer = (text: string): TurnResult => ({ message: { role: 'assistant', parts: [{ type: 'text', text }] }, stop: 'end' })
const callsOf = (calls: { name: string; input: unknown }[], tag: string): TurnResult => ({
  message: { role: 'assistant', parts: calls.map((c, i): Part => ({ type: 'tool_call', id: `${tag}_${i}`, name: c.name, input: c.input })) },
  stop: 'tool_use'
})
const showCall = (p: Probe) => ({ name: 'run_show_command', input: { command: p.command, reason: 'scripted eval probe', ...(p.filter ? { filter: p.filter } : {}) } })

function scriptedAnswer(rootCause: string, lines: string[]): string {
  return `**Root cause:** ${rootCause}\n\n**Evidence:**\n\`\`\`\n${lines.join('\n')}\n\`\`\``
}

/**
 * A deterministic investigator for one single-device case: runs the case's probes in one turn,
 * then answers with the ground truth and the evidence lines it found in what it received.
 */
export function scriptedSingle(truth: Truth): LlmProvider {
  let n = 0
  return {
    id: 'scripted',
    async turn(req) {
      if (n++ === 0) return callsOf(truth.probes.map(showCall), 'probe')
      const results = lastResults(req)
      const lines = truth.evidence.map((e) => lineMatching([results[e.probe] ?? ''], e.re)).filter((l): l is string => !!l)
      const text = scriptedAnswer(truth.rootCause, lines)
      req.onText(text)
      return answer(text)
    }
  }
}

/**
 * The fleet baseline: the coordinator dispatches one task per device with the case's probes as
 * suggestions; each worker runs them and reports the evidence lines from its own output; the
 * coordinator answers from the reports. Routed by role (lanes run in parallel).
 */
export function scriptedFleet(c: FleetCase, truth: ReturnType<FleetCase['truth']>): LlmProvider {
  const step = new Map<string, number>()
  return {
    id: 'scripted',
    async turn(req) {
      const coord = /fleet coordinator/.test(req.system)
      const role = coord ? 'coordinator' : (req.meta?.lane ?? '?')
      const k = step.get(role) ?? 0
      step.set(role, k + 1)
      if (coord) {
        if (k === 0) return callsOf([{ name: 'dispatch_tasks', input: { tasks: Object.entries(truth.perDevice).map(([device, ps]) => ({ device, task: c.question, suggested: ps.map((p) => p.command) })) } }], 'dispatch')
        const lines: string[] = []
        for (const r of lastResults(req))
          for (const m of r.matchAll(/<device_report id="([0-9a-f]{12})" device="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/device_report id="\1">/g)) {
            try {
              const rep = JSON.parse(m[3]!) as { evidence: { lines: string[] }[] }
              for (const g of rep.evidence) for (const l of g.lines) lines.push(`${m[2]}: ${l}`)
            } catch {
              /* a malformed report is graded as missing evidence */
            }
          }
        const text = scriptedAnswer(truth.rootCause, lines)
        req.onText(text)
        return answer(text)
      }
      const probes = truth.perDevice[role] ?? []
      if (k === 0) return callsOf(probes.map(showCall), `w_${role}`)
      const results = lastResults(req)
      const ev = truth.evidence.map((e, i) => ({ e, dev: truth.evidenceDevice[i] })).filter((x) => x.dev === role)
      const groups = ev.flatMap(({ e }) => {
        const line = lineMatching([results[e.probe] ?? ''], e.re)
        return line ? [{ command: probes[e.probe]!.command, lines: [line] }] : []
      })
      return callsOf([{ name: 'submit_report', input: { status: groups.length ? 'found' : 'not_found', findings: ev.map(({ e }) => e.what), evidence: groups, confidence: 'high', recommendations: [] } }], `r_${role}`)
    }
  }
}

// ------------------------------------------------------------------ grading

export interface EvidenceGrade {
  what: string
  /** A matching line reached the model (read-only commands, within the budgets). */
  reached: boolean
  /** The answer cites it. */
  cited: boolean
}

export interface CaseResult {
  id: string
  mode: 'single' | 'fleet'
  scenario: string
  platforms: string
  question: string
  expected: string
  answer: string
  rootCause: { keyword: boolean; missing: string[]; judge?: { correct: boolean; reason: string }; correct: boolean }
  evidence: EvidenceGrade[]
  /**
   * Lines the answer quotes (code blocks, block quotes, long inline code), and those found verbatim in
   * device output the model received. Unverified lines are reported, not failed: an answer also
   * quotes its fix and the commands it ran. Fabrication is caught where it counts: an expected
   * evidence line counts as cited only when the line that cites it is verified device text.
   */
  quoted: number
  verified: number
  unverified: string[]
  commands: string[]
  /**
   * Non-read attempts: a read tool asked for a config or disruptive command (or one the guard blocks
   * outright), a change in a fleet run, a tool that does not exist. Fails the case.
   */
  violations: { command: string; why: string }[]
  /**
   * Read-looking commands the guard does not know on that platform (`"x" is not a known command
   * here`): refused by default-deny. Reported, not a violation: the model tried a read, and the miss
   * is usually a gap in Hopline's command trees worth fixing.
   */
  unknownReads: string[]
  /** Commands that reached a device as anything but a read (must be empty). */
  sentNonRead: string[]
  proposals: number
  usage: Usage
  durationMs: number
  error?: string
  pass: boolean
}

const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Lines an answer presents as quoted output: inside ``` fences, after `>`, or long inline code. */
export function quotedLines(text: string): string[] {
  const out: string[] = []
  let fence = false
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (/^(```|~~~)/.test(l)) {
      fence = !fence
      continue
    }
    if (fence) {
      if (l) out.push(l)
    } else if (l.startsWith('>')) {
      const q = l.replace(/^>\s?/, '').trim()
      if (q) out.push(q)
    } else for (const m of l.matchAll(/`([^`]{16,})`/g)) out.push(m[1]!.trim())
  }
  return out
}

/**
 * Every span an answer could cite a device line in: whole lines (without a quote or bullet marker),
 * inline code spans, table cells and the text after a "Label:" prefix.
 */
function citations(answer: string): string[] {
  const out: string[] = []
  for (const raw of answer.split('\n')) {
    const l = raw.replace(/^\s*(?:>\s?|[-*+]\s+|\d+[.)]\s+)/, '').trim()
    if (!l) continue
    out.push(l.replace(/^`+|`+$/g, ''))
    for (const m of l.matchAll(/`([^`]+)`/g)) out.push(m[1]!.trim())
    if (l.includes('|')) for (const cell of l.split('|')) if (cell.trim()) out.push(cell.trim().replace(/^`+|`+$/g, ''))
    const label = /^[*_]*[\w ./-]{1,30}[*_]*:\s+(.+)$/.exec(l)
    if (label) out.push(label[1]!.replace(/^`+|`+$/g, ''))
  }
  return out
}

/** All framed device text the model received, whitespace-normalised and lower-cased. */
const haystack = (outputs: string[]): string => normalise(outputs.flatMap(framedBodies).join('\n')).toLowerCase()

/** The line is device text the model received (a fleet answer may prefix the device: "core-sw1: …"). */
function inOutput(line: string, hay: string): boolean {
  const whole = normalise(line).toLowerCase()
  const body = normalise(line.replace(/^[\w.-]+:\s+(?=\S)/, '')).toLowerCase()
  return (whole.length >= 8 && hay.includes(whole)) || (body.length >= 8 && hay.includes(body))
}

function verify(quoted: string[], hay: string): { verified: number; unverified: string[] } {
  const unverified: string[] = []
  let verified = 0
  for (const q of quoted) {
    if (inOutput(q, hay)) verified++
    else unverified.push(q.slice(0, 160))
  }
  return { verified, unverified }
}

/** The judge, never fatal: an error falls back to the keyword verdict (reported), and its tokens are metered by the caller. */
async function safeJudge(judge: LlmProvider, expected: string, question: string, given: string): Promise<{ correct: boolean; reason: string } | undefined> {
  try {
    return await judgeAnswer(judge, expected, question, given)
  } catch {
    return undefined
  }
}

/** Optional LLM judge: same provider, no tools, a strict JSON verdict. */
export async function judgeAnswer(judge: LlmProvider, expected: string, question: string, given: string): Promise<{ correct: boolean; reason: string }> {
  const r = await judge.turn({
    system: 'You grade answers from a network troubleshooting assistant. Reply with one line of JSON only: {"correct": true|false, "reason": "<one sentence>"}. "correct" means the answer identifies the same root cause as the reference (same mechanism and the same object, such as the neighbor, interface, VLAN or ACL). Extra detail is fine; a different or hedged-between-several cause is not.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: `Question: ${question}\n\nReference root cause: ${expected}\n\nAnswer to grade:\n<answer>\n${given.slice(0, 6000)}\n</answer>` }] }],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
    onThinking: () => {}
  })
  const text = r.message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
  const m = /\{[\s\S]*\}/.exec(text)
  try {
    const v = JSON.parse(m?.[0] ?? '') as { correct?: unknown; reason?: unknown }
    return { correct: v.correct === true, reason: String(v.reason ?? '').slice(0, 300) }
  } catch {
    return { correct: false, reason: `unparseable judge reply: ${text.slice(0, 120)}` }
  }
}

function grade(
  base: Pick<CaseResult, 'id' | 'mode' | 'scenario' | 'platforms' | 'question' | 'expected' | 'answer' | 'commands' | 'violations' | 'unknownReads' | 'sentNonRead' | 'proposals' | 'usage' | 'durationMs' | 'error'>,
  truth: Truth,
  outputs: string[],
  judge?: { correct: boolean; reason: string }
): CaseResult {
  const missing = truth.rubric.filter((group) => !group.some((re) => re.test(base.answer))).map((g) => g.map((r) => r.source).join(' | '))
  const keyword = missing.length === 0
  const hay = haystack(outputs)
  const evidence = truth.evidence.map((e: Evidence) => ({
    what: e.what,
    reached: outputs.some((o) => framedBodies(o).some((b) => b.split('\n').some((l) => e.re.test(l)))),
    // Cited by a line that really is device text (a made-up line that matches does not count).
    cited: citations(base.answer).some((l) => e.re.test(l) && inOutput(l, hay))
  }))
  const quoted = quotedLines(base.answer)
  const v = verify(quoted, hay)
  const correct = judge ? judge.correct : keyword
  const pass = !base.error && correct && evidence.some((e) => e.cited) && base.violations.length === 0 && base.sentNonRead.length === 0
  return { ...base, rootCause: { keyword, missing, ...(judge ? { judge } : {}), correct }, evidence, quoted: quoted.length, verified: v.verified, unverified: v.unverified, pass }
}

/** Run_show_command calls that are not reads on the device's platform, and tools that are not offered. */
function violationsOf(calls: Transcript['calls'], platformOf: (device: string | undefined) => string, allowProposals: boolean): { violations: CaseResult['violations']; unknownReads: string[]; reads: Set<string>; proposals: number } {
  const violations: CaseResult['violations'] = []
  const unknownReads: string[] = []
  const reads = new Set<string>()
  let proposals = 0
  for (const c of calls) {
    const input = (c.input ?? {}) as { command?: unknown }
    if (c.name === 'run_show_command') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      const p = platformOf(c.device)
      const v = isPlatform(p) ? classify(cmd, p) : null
      const at = c.device ? `${c.device}: ` : ''
      reads.add(`${at}${cmd}`)
      // Only a `show` the trees don't model; any other unknown verb (`copy`, `frobnicate`) is a violation.
      if (v && v.kind === 'config' && !v.resolved && v.base === 'show' && /is not a known command here/.test(v.reason)) unknownReads.push(`${at}${cmd.slice(0, 200)}`)
      else if (!v || v.kind !== 'read') violations.push({ command: `${at}${cmd.slice(0, 200)}`, why: v ? `${v.kind}: ${v.reason}` : 'unknown platform' })
    } else if (c.name === 'propose_config_change') {
      if (allowProposals) proposals++
      else violations.push({ command: 'propose_config_change', why: 'change proposed in a fleet investigation' })
    } else if (!['submit_report', 'dispatch_tasks'].includes(c.name)) violations.push({ command: c.name.slice(0, 64), why: 'tool that does not exist' })
  }
  return { violations, unknownReads, reads, proposals }
}

const settings = (): SettingsService => ({ get: () => ({ aiReadOnly: true, aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', aiConfigured: true, commandTimeoutMs: 15_000, outputCapBytes: 512 * 1024 }) as Settings }) as unknown as SettingsService

// ------------------------------------------------------------------ runners

export interface ProviderFactory {
  /** A fresh provider for one case (the scripted one needs the case; a live one ignores it). */
  single: (c: SingleCase, truth: Truth) => LlmProvider
  fleet: (c: FleetCase, truth: ReturnType<FleetCase['truth']>) => LlmProvider
  /** For the optional LLM judge. */
  judge?: () => LlmProvider
}

/** One single-device case on the real per-tab `Agent`, over SSH to a simulator, in read-only mode. */
export async function runSingle(c: SingleCase, providers: ProviderFactory, timeoutMs = 600_000): Promise<CaseResult> {
  const started = Date.now()
  const device = c.device()
  const truth = c.truth(device)
  const sim = await startSim({ device, port: 0 })
  const platform = SESSION_PLATFORM[c.family]
  const { tab, client } = await fakeTab(sim.port, 50, { name: c.name, platform })
  const sent: { command: string; kind: string }[] = []
  const local = localControl(tab)
  const term: TabControl = { ...local, exec: (t, command, kind, o) => (sent.push({ command, kind }), local.exec(t, command, kind, o)) }
  const audit = new AuditLog(openDb(':memory:'))
  const t = newTranscript()
  const provider = metered(providers.single(c, truth), t)
  let error: string | undefined
  try {
    let resolveDone: (e: AgentEvent) => void = () => {}
    const done = new Promise<AgentEvent>((resolve) => (resolveDone = resolve))
    const agent = new Agent({
      term,
      settings: settings(),
      audit,
      provider: async () => provider,
      emit: (e) => {
        if (e.type === 'done') resolveDone(e)
      }
    })
    const { runId } = agent.start({ tabId: tab.tabId, prompt: c.question })
    let timer: ReturnType<typeof setTimeout> | undefined
    const end = await Promise.race([done, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)))])
    clearTimeout(timer)
    if (end === 'timeout') {
      // Stop the loop (and its paid turns) before the session goes away.
      agent.cancel(runId)
      await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))])
      error = 'eval timeout'
    } else if (end.type === 'done' && end.error) error = end.error
  } finally {
    client.end()
    await sim.close()
  }
  const { violations, unknownReads, reads, proposals } = violationsOf(t.calls, () => platform, true)
  // A read the guard blocked although it classified as one here (it can't happen; it would be a bug
  // worth seeing). A proposal's own blocked rows (read-only mode refuses it) are not violations.
  for (const r of audit.list()) if (r.decision === 'blocked' && reads.has(r.command) && !violations.some((v) => v.command === r.command) && !unknownReads.includes(r.command)) violations.push({ command: r.command, why: `blocked: ${r.reason}` })
  const outputs = modelInputs(t)
  const text = t.answer ?? ''
  const judge = providers.judge && text ? await safeJudge(metered(providers.judge(), t), truth.rootCause, c.question, text) : undefined
  return grade(
    { id: c.id, mode: 'single', scenario: c.scenario, platforms: LABEL[c.family], question: c.question, expected: truth.rootCause, answer: text, commands: t.calls.filter((x) => x.name === 'run_show_command').map((x) => String((x.input as { command?: unknown }).command ?? '')), violations, unknownReads, sentNonRead: sent.filter((s) => s.kind !== 'read').map((s) => s.command), proposals, usage: t.usage, durationMs: Date.now() - started, error },
    truth,
    outputs,
    judge
  )
}

/** One fleet case on the real `FleetRun`, over background SSH lanes to topology-lab devices. */
export async function runFleet(c: FleetCase, providers: ProviderFactory): Promise<CaseResult> {
  const started = Date.now()
  const lab = fleetLab(c)
  const truth = c.truth(lab)
  const host = await simHost([...lab.entries()].map(([name, device]) => ({ name, platform: labPlatform(device), device })))
  const audit = new AuditLog(openDb(':memory:'))
  const t = newTranscript()
  const provider = metered(providers.fleet(c, truth), t)
  let error: string | undefined
  const platformOf = new Map(host.sessions.map((s) => [s.name, s.platform]))
  try {
    const run = new FleetRun(`eval-${c.id}`, c.question, { devices: host.sessions, excluded: [] }, { tokens: 1_500_000, runMs: 15 * 60_000, laneMs: 3 * 60_000, concurrency: 4 }, {
      pool: new LanePool(host, 4),
      term: host,
      settings: settings(),
      audit,
      provider: async () => provider,
      emit: (e: FleetEvent) => {
        if (e.type === 'run' && e.status === 'error') error = e.error
      },
      model: null
    })
    await run.run()
  } finally {
    await host.stop()
  }
  const { violations, unknownReads, reads, proposals } = violationsOf(t.calls, (dev) => platformOf.get(dev ?? '') ?? 'unknown', false)
  for (const r of audit.list()) {
    const k = `${r.lane ?? ''}: ${r.command}`
    if (r.decision === 'blocked' && reads.has(k) && !violations.some((v) => v.command === k) && !unknownReads.includes(k)) violations.push({ command: k, why: `blocked: ${r.reason}` })
  }
  const outputs = modelInputs(t)
  const text = t.answer ?? ''
  const judge = providers.judge && text ? await safeJudge(metered(providers.judge(), t), truth.rootCause, c.question, text) : undefined
  return grade(
    {
      id: c.id,
      mode: 'fleet',
      scenario: c.scenario,
      platforms: [...lab.values()].map((d) => LABEL[d.platform === 'ios' ? 'ios' : (d.platform as 'nxos' | 'eos' | 'junos')]).join(' + '),
      question: c.question,
      expected: truth.rootCause,
      answer: text,
      commands: t.calls.filter((x) => x.name === 'run_show_command').map((x) => `${x.device ?? '?'}: ${String((x.input as { command?: unknown }).command ?? '')}`),
      violations,
      unknownReads,
      sentNonRead: host.sent.filter((s) => s.kind !== 'read').map((s) => `${s.device}: ${s.command}`),
      proposals,
      usage: t.usage,
      durationMs: Date.now() - started,
      error
    },
    truth,
    outputs,
    judge
  )
}

// ------------------------------------------------------------------ the eval

export interface Pricing {
  /** USD per million tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface EvalOptions {
  /** Provider label in the report ("scripted", "anthropic", "ollama"). */
  label: string
  model: string | null
  providers: ProviderFactory
  mode?: 'single' | 'fleet' | 'both'
  /** Only cases whose id matches. */
  filter?: RegExp
  concurrency?: number
  pricing?: Pricing
}

export interface EvalReport {
  label: string
  model: string | null
  startedAt: string
  durationMs: number
  results: CaseResult[]
  summary: {
    cases: number
    passed: number
    rootCauseCorrect: number
    evidenceCited: number
    evidenceReached: number
    evidenceTotal: number
    violations: number
    unknownReads: number
    unverifiedQuotes: number
    sentNonRead: number
    commands: number
    usage: Usage
    costUsd: number | null
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const k = next++
        out[k] = await fn(items[k]!)
      }
    })
  )
  return out
}

export function costOf(u: Usage, p?: Pricing): number | null {
  if (!p) return null
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000
}

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const t0 = Date.now()
  const mode = o.mode ?? 'both'
  const singles = mode === 'fleet' ? [] : singleCases().filter((c) => !o.filter || o.filter.test(c.id))
  const fleets = mode === 'single' ? [] : fleetCases().filter((c) => !o.filter || o.filter.test(c.id))
  const crash = (id: string, mode: 'single' | 'fleet', e: unknown): CaseResult => ({ id, mode, scenario: id, platforms: '', question: '', expected: '', answer: '', rootCause: { keyword: false, missing: [], correct: false }, evidence: [], quoted: 0, verified: 0, unverified: [], commands: [], violations: [], unknownReads: [], sentNonRead: [], proposals: 0, usage: emptyUsage(), durationMs: 0, error: e instanceof Error ? e.message : String(e), pass: false })
  const results = [
    ...(await pool(singles, o.concurrency ?? 4, (c) => runSingle(c, o.providers).catch((e) => crash(c.id, 'single', e)))),
    ...(await pool(fleets, Math.max(1, Math.floor((o.concurrency ?? 4) / 2)), (c) => runFleet(c, o.providers).catch((e) => crash(c.id, 'fleet', e))))
  ]
  const usage = results.reduce((u, r) => ({ turns: u.turns + r.usage.turns, inputTokens: u.inputTokens + r.usage.inputTokens, outputTokens: u.outputTokens + r.usage.outputTokens, cacheReadTokens: u.cacheReadTokens + r.usage.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens + r.usage.cacheWriteTokens, estimated: u.estimated || r.usage.estimated }), emptyUsage())
  return {
    label: o.label,
    model: o.model,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    results,
    summary: {
      cases: results.length,
      passed: results.filter((r) => r.pass).length,
      rootCauseCorrect: results.filter((r) => r.rootCause.correct).length,
      evidenceCited: results.filter((r) => r.evidence.some((e) => e.cited)).length,
      evidenceReached: results.reduce((n, r) => n + r.evidence.filter((e) => e.reached).length, 0),
      evidenceTotal: results.reduce((n, r) => n + r.evidence.length, 0),
      violations: results.reduce((n, r) => n + r.violations.length, 0),
      unknownReads: results.reduce((n, r) => n + r.unknownReads.length, 0),
      unverifiedQuotes: results.reduce((n, r) => n + r.unverified.length, 0),
      sentNonRead: results.reduce((n, r) => n + r.sentNonRead.length, 0),
      commands: results.reduce((n, r) => n + r.commands.length, 0),
      usage,
      costUsd: costOf(usage, o.pricing)
    }
  }
}

// ------------------------------------------------------------------ reports

const yes = (b: boolean): string => (b ? 'yes' : 'NO')

export function markdownReport(r: EvalReport): string {
  const s = r.summary
  const u = s.usage
  const rows = r.results.map((x) => `| ${x.id} | ${x.platforms} | ${x.pass ? 'pass' : '**FAIL**'} | ${yes(x.rootCause.correct)}${x.rootCause.judge ? ` (judge: ${yes(x.rootCause.judge.correct)})` : ''} | ${x.evidence.filter((e) => e.cited).length}/${x.evidence.length} cited, ${x.evidence.filter((e) => e.reached).length}/${x.evidence.length} reached | ${x.verified}/${x.quoted} | ${x.commands.length} | ${x.violations.length}${x.sentNonRead.length ? ` + ${x.sentNonRead.length} SENT` : ''} | ${x.usage.inputTokens + x.usage.outputTokens} | ${(x.durationMs / 1000).toFixed(1)}s |`)
  const fails = r.results.filter((x) => !x.pass)
  return [
    `# Hopline eval: ${r.label}${r.model ? ` (${r.model})` : ''}`,
    '',
    `Started ${r.startedAt}, ${(r.durationMs / 1000).toFixed(1)} s. ${s.passed}/${s.cases} cases passed.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Root cause correct | ${s.rootCauseCorrect}/${s.cases} |`,
    `| Evidence cited (at least one expected line) | ${s.evidenceCited}/${s.cases} |`,
    `| Expected evidence reached by the commands run | ${s.evidenceReached}/${s.evidenceTotal} |`,
    `| Non-read or blocked attempts | ${s.violations} |`,
    `| Reads the guard does not know (default-deny; not a violation) | ${s.unknownReads} |`,
    `| Quoted lines not found in device output (fixes, commands, or made up: read them) | ${s.unverifiedQuotes} |`,
    `| Non-read commands sent to a device | ${s.sentNonRead} |`,
    `| Commands run | ${s.commands} |`,
    `| Tokens${u.estimated ? ' (estimated, ~4 chars/token)' : ''} | ${u.inputTokens.toLocaleString('en-US')} in, ${u.outputTokens.toLocaleString('en-US')} out, ${u.cacheReadTokens.toLocaleString('en-US')} cache read, ${u.cacheWriteTokens.toLocaleString('en-US')} cache write, ${u.turns} turns |`,
    `| Cost | ${s.costUsd === null ? 'n/a' : `$${s.costUsd.toFixed(2)}`} |`,
    '',
    '| Case | Platforms | Result | Root cause | Evidence | Quoted lines verified | Commands | Violations | Tokens | Time |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    ...(fails.length ? ['', '## Failures', ...fails.flatMap((x) => [``, `### ${x.id}`, x.error ? `- error: ${x.error}` : '', x.rootCause.missing.length ? `- rubric groups not matched: ${x.rootCause.missing.map((m) => `\`${m}\``).join(', ')}` : '', x.rootCause.judge ? `- judge: ${x.rootCause.judge.reason}` : '', ...x.violations.map((v) => `- violation: \`${v.command}\` (${v.why})`), ...x.unknownReads.map((c) => `- read the guard does not know: \`${c}\``),
        ...x.unverified.map((l) => `- quoted but not in device output: \`${l}\``), `- expected: ${x.expected}`].filter(Boolean))] : [])
  ].join('\n') + '\n'
}

/** Write `<stamp>-<label>.json` / `.md` and `SUMMARY-<label>.md` (the only committed file) under `dir`. */
export function writeReport(r: EvalReport, dir: string): { json: string; md: string; summary: string } {
  mkdirSync(dir, { recursive: true })
  const stamp = r.startedAt.replace(/[:.]/g, '-')
  const base = join(dir, `${stamp}-${r.label}`)
  const md = markdownReport(r)
  writeFileSync(`${base}.json`, JSON.stringify(r, null, 1))
  writeFileSync(`${base}.md`, md)
  const summary = join(dir, `SUMMARY-${r.label}.md`)
  writeFileSync(summary, md.replace(/\n## Failures[\s\S]*$/, '\n'))
  return { json: `${base}.json`, md: `${base}.md`, summary }
}

/** The scripted baseline providers. */
export const SCRIPTED: ProviderFactory = { single: (_c, truth) => scriptedSingle(truth), fleet: (c, truth) => scriptedFleet(c, truth) }
