import { redact } from '@hopline/guard'
import { z } from 'zod'
import type { FleetReport } from '@shared/fleet'
import type { ToolSpec } from '../llm/types'
import { normalise, type Ledger } from './ledger'
import { attr, frame, neutralise } from '../agent/untrusted'

/**
 * `submit_report`: the only text that crosses from a device to the coordinator (FLEET-AGENT §7.2).
 * Structured, verified against the lane's recorded output, capped, redacted, and framed as
 * untrusted data. The order is fixed: parse → verify → neutralise each string (invisible characters,
 * line separators, NFKC, frame tags) → cap (by dropping items) → redact → serialise → wrap. The
 * wrapped string is never sliced, so a cap can't cut a frame open.
 *
 * Every string is neutralised BEFORE it is serialised (Phase 8 review M3): NFKC after
 * `JSON.stringify` turned a fullwidth `＂］，` in a finding into real JSON syntax (forged evidence,
 * forged notes). The JSON is then written with everything outside printable ASCII, and `<` `>`,
 * escaped as `\uXXXX`, so no later transform can make a quote, a bracket, a line break or a tag.
 */

export const MAX_FINDINGS = 10
export const MAX_FINDING_CHARS = 200
export const MAX_EVIDENCE_GROUPS = 8
export const MAX_EVIDENCE_LINES = 12
export const MAX_EVIDENCE_LINE_CHARS = 240
export const MAX_RECOMMENDATIONS = 5
/** What reaches the coordinator per report (the JSON inside the frame). */
export const MAX_REPORT_CHARS = 4_000

export const REPORT_TOOL: ToolSpec = {
  name: 'submit_report',
  description:
    'Finish your task: submit your findings to the coordinator. This ends your work on this device. ' +
    'Every evidence line must be copied exactly from output you received from run_show_command on this device; lines that are not are dropped. ' +
    `At most ${MAX_FINDINGS} findings of ${MAX_FINDING_CHARS} characters. ` +
    'If a configuration change would fix the problem, describe it in "recommendations" (nothing is applied or proposed from an investigation).',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['found', 'not_found', 'blocked', 'error'], description: 'found: you found what the task asked; not_found: you checked and it is not there; blocked: a command you needed was refused; error: you could not finish' },
      findings: { type: 'array', items: { type: 'string' }, description: 'Short factual statements, most important first' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: { command: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } } },
          required: ['command', 'lines'],
          additionalProperties: false
        },
        description: 'The output lines that support the findings, grouped by the command that printed them'
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Optional: a change you would make, described in words or as config lines. Never applied.' }
    },
    required: ['status', 'findings', 'evidence', 'confidence'],
    additionalProperties: false
  }
}

const Str = z.string().max(20_000)
const Input = z.object({
  status: z.enum(['found', 'not_found', 'blocked', 'error']),
  findings: z.array(Str).max(200),
  evidence: z.array(z.object({ command: Str, lines: z.array(Str).max(500) })).max(100),
  confidence: z.enum(['low', 'medium', 'high']),
  recommendations: z.array(Str).max(100).optional()
})

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** One line of worker text: neutralised first (U+2028 becomes a line break, NFKC can lengthen), then flattened. */
const oneLine = (s: string): string => neutralise(s).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim()

/**
 * The report's JSON as the coordinator reads it: `JSON.stringify`, then every character outside
 * printable ASCII, and `<` `>`, as a `\uXXXX` escape. The body is pure ASCII with no tag
 * brackets, so nothing downstream (normalisation, a model's own reading) can turn a string's
 * content into JSON syntax or a frame tag. Used for the size cap too, so the cap measures what is sent.
 */
export function reportJson(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(/[^\x20-\x7e\n]|[<>]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}
/** The fields the coordinator receives, in its order (`flags` as `notes`). */
const wire = (r: FleetReport) => ({ status: r.status, findings: r.findings, evidence: r.evidence, confidence: r.confidence, recommendations: r.recommendations, notes: r.flags })

/** Parse and verify a worker's report. Returns the error text for the model on a malformed one. */
export function verifyReport(input: unknown, worker: string, ledger: Ledger, lane = worker.replace(/#\d+$/, '')): { ok: true; report: FleetReport } | { ok: false; error: string } {
  const p = Input.safeParse(input)
  if (!p.success) return { ok: false, error: `invalid report: ${p.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'report'} ${i.message}`).join('; ')}` }
  const r = p.data
  const flags: string[] = []
  let unverified = 0
  let replaced = 0
  // Group verified lines under the command that really printed them (the claimed command is free
  // text from the model: it is kept only when it is one this worker ran and its output has the line).
  const groups = new Map<string, string[]>()
  for (const g of r.evidence) {
    for (const raw of g.lines) {
      const src = ledger.source(worker, raw, g.command)
      if (src === null) {
        unverified++
        continue
      }
      if (src !== normalise(g.command)) replaced++
      const list = groups.get(src) ?? []
      groups.set(src, list)
      list.push(cut(oneLine(raw), MAX_EVIDENCE_LINE_CHARS))
    }
  }
  const evidence: FleetReport['evidence'] = [...groups].map(([command, lines]) => ({ command: cut(oneLine(command), 200), lines }))
  if (unverified) flags.push(`${unverified} evidence line(s) dropped: not found in this device's recorded output`)
  if (replaced) flags.push(`${replaced} evidence line(s) were filed under the command that actually printed them`)
  // Cap by dropping items, never by cutting the framed text.
  let ev = evidence.slice(0, MAX_EVIDENCE_GROUPS).map((g) => ({ ...g, lines: g.lines.slice(0, MAX_EVIDENCE_LINES) }))
  if (evidence.length > MAX_EVIDENCE_GROUPS || evidence.some((g) => g.lines.length > MAX_EVIDENCE_LINES)) flags.push('evidence capped')
  let findings = r.findings.map(oneLine).filter(Boolean)
  if (findings.length > MAX_FINDINGS || findings.some((f) => f.length > MAX_FINDING_CHARS)) flags.push('findings capped')
  findings = findings.slice(0, MAX_FINDINGS).map((f) => cut(f, MAX_FINDING_CHARS))
  let recommendations = (r.recommendations ?? []).map(oneLine).filter(Boolean).slice(0, MAX_RECOMMENDATIONS).map((x) => cut(x, MAX_FINDING_CHARS))
  for (const rec of recommendations) {
    if (ledger.copiedFromOwn(worker, rec)) flags.push('a recommendation contains text copied from this device\'s own output')
    const from = ledger.copiedFrom(rec, lane)
    if (from) flags.push(`a recommendation contains text copied from ${from}'s report`)
  }
  // "found" needs a finding and at least one verified evidence line; otherwise it is unconfirmed.
  let status = r.status
  let confidence = r.confidence
  if (status === 'found' && (!findings.length || !ev.length)) {
    status = 'not_found'
    confidence = 'low'
    flags.push('claimed "found" without a verified evidence line: reported as not found, low confidence')
  } else if (!ev.length && unverified) confidence = 'low'
  const report: FleetReport = { status, findings, evidence: ev, confidence, recommendations, unverified, flags }
  // The total size: drop evidence groups, then findings, until the JSON fits.
  while (reportJson(wire(report)).length > MAX_REPORT_CHARS && (ev.length || findings.length > 1 || recommendations.length)) {
    if (ev.length) ev = ev.slice(0, -1)
    else if (recommendations.length) recommendations = recommendations.slice(0, -1)
    else findings = findings.slice(0, -1)
    report.evidence = ev
    report.findings = findings
    report.recommendations = recommendations
    if (!report.flags.includes('report capped')) report.flags.push('report capped')
  }
  return { ok: true, report: redactReport(report) }
}

function redactReport(r: FleetReport): FleetReport {
  const red = (s: string) => redact(s).text
  return { ...r, findings: r.findings.map(red), recommendations: r.recommendations.map(red), evidence: r.evidence.map((g) => ({ command: red(g.command), lines: g.lines.map(red) })) }
}

/** A report for a lane that never submitted one (timeout, budget, error, cancel). */
export function failedReport(why: string): FleetReport {
  return { status: 'error', findings: [], evidence: [], confidence: 'low', recommendations: [], unverified: 0, flags: [cut(oneLine(why), MAX_FINDING_CHARS)] }
}

// Frame-tag neutralising and attribute escaping are shared with the single-device path (agent/untrusted.ts).
export { attr, frame, neutralise }

/**
 * The report's text as the coordinator reads it once the `\uXXXX` escapes are decoded: for the
 * ledger's copied-from-another-lane check, which compares a recommendation with what it saw.
 */
export const reportShown = (report: FleetReport): string => JSON.stringify(wire(report), null, 1)

/** The report as the coordinator sees it: JSON inside an untrusted frame. */
export function frameReport(device: string, report: FleetReport, status: string): string {
  const body = reportJson(wire(report))
  return frame('device_report', body, ` device="${attr(device)}" lane_status="${attr(status)}" untrusted="true"`)
}
