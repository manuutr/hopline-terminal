import { randomUUID } from 'node:crypto'
import type { FleetReport, FleetStep } from '@shared/fleet'
import type { AgentEventBody } from '@shared/types'
import type { AuditEntry, AuditLog } from '../db/audit'
import type { AgentTab, TabControl } from '../host/client'
import { DEVICE_TOOL_SPECS, DeviceTools } from '../agent/device-tools'
import { untrustedText } from '../agent/untrusted'
import { NetworkPrivacy } from '../llm/network-privacy'
import { AgentLoop, type ToolCallContext, type ToolResult, type ToolSet } from '../agent/loop'
import { auditBase, type ChangeContext, type ChangeProposer } from '../agent/proposals'
import type { LlmProvider, ToolSpec } from '../llm/types'
import type { SettingsService } from '../settings'
import type { Ledger } from './ledger'
import { workerSystemPrompt, workerTask } from './prompts'
import { mentions, reachRefusal } from './reach'
import { failedReport, REPORT_TOOL, verifyReport } from './report'

/**
 * A fleet worker (FLEET-AGENT §3.2): an `AgentLoop` over a `DeviceTools` bound to one background
 * tab, with a tool set of exactly two tools, `run_show_command` and `submit_report`.
 *
 * - Every command takes DeviceTools' path unchanged: the guard for this device's platform in main,
 *   the signed verdict re-checked by the session host, the settings' timeout and output cap,
 *   redaction before the model and the renderer see anything.
 * - Every audit row is attributed here, at the audit boundary: source `fleet`, the run id and the
 *   lane (the device's session name). That includes DeviceTools' own error path.
 * - Nothing can change the device: config proposals and disruptive commands go to a proposer that
 *   only refuses (audited); any other tool name is refused (a local model enforces no schema).
 * - The tab's redacted output is recorded in the run's ledger for evidence checks.
 */

export const FLEET_WORKER_MAX_STEPS = 8

const SHOW_SPEC: ToolSpec = {
  ...DEVICE_TOOL_SPECS.find((s) => s.name === 'run_show_command')!,
  description:
    'Run ONE read-only CLI command (show/ping/traceroute) on your device and return its output. ' +
    'Anything that is not provably read-only is refused, and the refusal is final. Use the platform\'s own syntax. Never chain commands. ' +
    'Prefer the "filter" parameter to keep output small: Hopline runs the plain command and filters the captured output locally (tail, head, grep with regex alternation, -v, -i, context lines, count), identically on every vendor.'
}

export interface WorkerDeps {
  privacy?: NetworkPrivacy
  term: TabControl
  settings: Pick<SettingsService, 'get'>
  audit: Pick<AuditLog, 'append'>
  ledger: Ledger
  runId: string
  /** The device's session name: the lane. */
  lane: string
  /** This worker's id in the ledger (a lane dispatched again gets a new one). */
  worker: string
  step: (s: FleetStep) => void
  /** A note appended to tool results when the lane's budget runs low (null: none). */
  budgetNote?: () => string | null
  /** The lane's budget is spent: only submit_report is accepted now. */
  closing?: () => boolean
  /** The task text (addresses in it may be pinged; reach.ts). */
  task?: string
}

/** Attribute every row to the fleet run and lane. */
export function fleetAudit(audit: Pick<AuditLog, 'append'>, runId: string, lane: string): Pick<AuditLog, 'append'> {
  return { append: (e: AuditEntry) => audit.append({ ...e, source: 'fleet', runId, lane }) }
}

/** The change path of a fleet investigation: there is none. Every attempt is refused and audited. */
export class Refusals implements ChangeProposer {
  constructor(
    private readonly audit: Pick<AuditLog, 'append'>,
    private readonly step: (s: FleetStep) => void
  ) {}

  refuse(tab: AgentTab, lines: string[], kind: 'config' | 'disruptive', reason: string): ToolResult {
    for (const c of lines.length ? lines : ['(empty proposal)']) this.audit.append({ ...auditBase(tab), command: c, kind, decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
    this.step({ stepId: randomUUID(), command: (lines.join(' ⏎ ') || '(empty proposal)').slice(0, 200), status: 'refused', kind, reason })
    return { text: `REFUSED: ${reason}. This decision is final.`, isError: true }
  }

  async proposeConfig(ctx: ChangeContext, input: { commands?: unknown }): Promise<ToolResult> {
    return this.refuseConfig(ctx.tab, input)
  }

  refuseConfig(tab: AgentTab, input: { commands?: unknown }): ToolResult {
    const lines = Array.isArray(input.commands) ? input.commands.filter((c): c is string => typeof c === 'string').map((c) => c.slice(0, 500)).slice(0, 50) : []
    return this.refuse(tab, lines, 'config', 'a fleet investigation never changes a device; describe the change in your report\'s "recommendations"')
  }

  async proposeDisruptive(ctx: ChangeContext, command: string, why: string): Promise<ToolResult> {
    return this.refuse(ctx.tab, [command], 'disruptive', `${why}; disruptive commands are never run in a fleet run`)
  }

  async proposeReach(ctx: ChangeContext, command: string, why: string): Promise<ToolResult> {
    return this.refuse(ctx.tab, [command], 'config', `${why}; a fleet run only probes IP addresses`)
  }
}

export class WorkerTools implements ToolSet {
  readonly specs: ToolSpec[] = [SHOW_SPEC, REPORT_TOOL]
  /** The verified report, once submitted. */
  report: FleetReport | null = null
  private readonly device: DeviceTools
  private readonly refusals: Refusals
  private readonly audit: Pick<AuditLog, 'append'>
  private readonly copied = new Map<string, string>()

  constructor(
    private readonly tab: AgentTab,
    private readonly d: WorkerDeps
  ) {
    this.audit = fleetAudit(d.audit, d.runId, d.lane)
    // The executor as DeviceTools sees it: every result is recorded (redacted) for evidence checks.
    const term: TabControl = {
      // The team policy's blocked commands: refused (and audited as such) before exec.
      get policyRules() {
        return d.term.policyRules
      },
      get: (id) => d.term.get(id),
      mode: (t) => d.term.mode(t),
      prompt: (t) => d.term.prompt(t),
      exec: async (t, command, kind, opts) => {
        const r = await d.term.exec(t, command, kind, opts)
        // The same transform DeviceTools applies before the model sees it, so copied evidence matches.
        if (kind === 'read') {
          const output = untrustedText(r.output).text
          d.ledger.record(d.lane, command, d.privacy?.protect(output) ?? output, d.worker)
        }
        return r
      }
    }
    this.refusals = new Refusals(this.audit, d.step)
    this.device = new DeviceTools(tab, { term, settings: d.settings, privacy: d.privacy, audit: this.audit, emit: (e) => this.onDeviceEvent(e) }, this.refusals)
  }

  private onDeviceEvent(e: AgentEventBody): void {
    if (e.type !== 'step') return
    const { type: _t, runId: _r, ...step } = e
    // Copied text across devices: a command that contains a long run of another device's output.
    let from = this.copied.get(e.stepId)
    if (from === undefined && e.status === 'running') {
      from = this.d.ledger.copiedFrom(e.command, this.d.lane) ?? ''
      this.copied.set(e.stepId, from)
    }
    this.d.step({ ...step, ...(from ? { copiedFrom: from } : {}) })
  }

  /** A malformed call (Ollama): audited and refused by the device tool set; nothing runs. */
  reject(name: string, why: string, ctx: ToolCallContext): ToolResult {
    return this.device.reject(name, why, ctx)
  }

  async call(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    if (name === 'run_show_command') {
      if (this.d.closing?.()) return { text: "REFUSED: this lane's token budget is used up. Call submit_report now with what you have.", isError: true }
      const command = typeof (input as { command?: unknown })?.command === 'string' ? (input as { command: string }).command : ''
      const platform = (this.d.term.get(this.tab.tabId) ?? this.tab).session.platform
      const reach = reachRefusal(command, platform, (ip) => this.d.ledger.seen(this.d.lane, ip) || mentions(this.d.task ?? '', ip))
      if (reach) {
        this.audit.append({ ...auditBase(this.tab), command: command.slice(0, 500), kind: 'read', decision: 'refused', reason: reach, approver: null, durationMs: null, bytes: null, redactions: null })
        this.d.step({ stepId: randomUUID(), command: command.slice(0, 200), status: 'refused', kind: 'read', reason: reach })
        return { text: `REFUSED: ${reach}.`, isError: true }
      }
      const r = await this.device.call(name, input, ctx)
      const note = this.d.budgetNote?.()
      return note ? { ...r, text: `${r.text}\n\n[Hopline: ${note}]` } : r
    }
    if (name === 'submit_report') {
      const v = verifyReport(input, this.d.worker, this.d.ledger, this.d.lane)
      if (!v.ok) return { text: `ERROR: ${v.error}. Fix the report and call submit_report again.`, isError: true }
      this.report = v.report
      return { text: 'Report received.', final: true }
    }
    // propose_config_change from a model that ignores the tool list: every line is refused and audited.
    if (name === 'propose_config_change') return this.refusals.refuseConfig(this.tab, (input ?? {}) as { commands?: unknown })
    // Any other name (a local model enforces no schema).
    const reason = `unknown tool ${name.slice(0, 64)}`
    this.audit.append({ ...auditBase(this.tab), command: name.slice(0, 64), kind: 'unknown', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
    this.d.step({ stepId: randomUUID(), command: name.slice(0, 64), status: 'refused', reason })
    return { text: `REFUSED: ${reason}. Your tools are run_show_command and submit_report.`, isError: true }
  }
}

export interface WorkerOutcome {
  report: FleetReport
  /** Why the loop ended without a report, if it did. */
  error?: string
}

/** Run one worker to its report. Text without a report, a cap, a timeout or a cancel is an `error` report. */
export async function runWorker(
  tab: AgentTab,
  d: WorkerDeps & { provider: () => Promise<LlmProvider>; maxSteps?: number },
  task: string,
  suggested: string[],
  signal: AbortSignal
): Promise<WorkerOutcome> {
  const privacy = d.privacy ?? new NetworkPrivacy()
  privacy.addSession(tab.session)
  const tools = new WorkerTools(tab, { ...d, privacy })
  const loop = new AgentLoop(
    { messages: [], privacy },
    {
      provider: d.provider,
      system: () => workerSystemPrompt((d.term.get(tab.tabId) ?? tab).session),
      tools,
      emit: () => {},
      maxIterations: d.maxSteps ?? FLEET_WORKER_MAX_STEPS,
      meta: { source: 'fleet', sessionName: tab.session.name, lane: d.lane }
    }
  )
  const done = await loop.run(workerTask(task, suggested), { runId: d.runId, signal })
  if (tools.report) return { report: tools.report }
  const why = done.error ?? 'the worker answered without calling submit_report'
  return { report: failedReport(why), error: why }
}
