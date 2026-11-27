import { classify, isPlatform, type Platform } from '@hopline/guard'
import { userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AgentEventBody } from '@shared/types'
import type { ExecResultMsg as ExecResult } from '@shared/host-protocol'
import type { AuditLog } from '../db/audit'
import type { AgentTab as TermTab, TabControl } from '../host/client'
import type { ToolSpec } from '../llm/types'
import type { SettingsService } from '../settings'
import type { NetworkPrivacy } from '../llm/network-privacy'
import { compactRows, parseSafe } from '../parse/safe'
import { policyBlocked } from '@shared/policy-deny'
import { applyFilter, describeFilter, FILTER_SCHEMA, FilterError, isEmptyFilter, OutputFilter } from './filter'
import { malformedCall, type ToolCallContext, type ToolResult, type ToolSet } from './loop'
import { z } from 'zod'
import type { RecentOutput } from './copied'
import { VerificationInput } from './changes'
import { auditBase, MAX_VERIFY_COMMANDS, ProposalInput, type ChangeContext, type ChangeProposer } from './proposals'
import { NET_MINUTES } from '@hopline/cli-model'
import { frameOutput, untrustedText } from './untrusted'
import { agentReach } from '../fleet/reach'

/**
 * The device tool set, bound to one terminal session (an `AgentTab`) and one executor (`TabControl`).
 *
 * Every call: the guard classifies the command in main for the session's current platform (the
 * session host re-checks the signed verdict), every attempt is audited, output is redacted before
 * it is filtered, parsed, previewed for the renderer or returned to the model, and the settings'
 * command timeout and output cap apply. Changes go through the `ChangeProposer`.
 */

/** How much command output goes back to the model per tool call (the device cap is separate). */
export const MAX_TOOL_CHARS = 40_000

export const DEVICE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'run_show_command',
    description:
      'Run ONE read-only CLI command (show/ping/traceroute) on the device in the active terminal and return its output. ' +
      'The command appears live in the user\'s terminal. Anything that is not provably read-only is refused. ' +
      'Use full or common abbreviations native to the platform. Never chain commands. ' +
      'To keep output small, prefer the "filter" parameter: Hopline runs the plain command and filters the captured output locally (tail, head, grep with regex alternation, -v, -i, context lines, count), identically on every vendor. ' +
      'Use it whenever the platform lacks the pipe you need (IOS has no "| tail" or "| count"; some platforms have no pipes at all), and for regex alternation. ' +
      'Native device pipes like "| include" also work where the platform supports them, but every "|" starts a new device filter, so "| include a|b" is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'A single CLI line, e.g. "show ip bgp summary"' },
        reason: { type: 'string', description: 'One short sentence: why this command helps answer the question' },
        filter: FILTER_SCHEMA
      },
      required: ['command', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_config_change',
    description:
      'Propose configuration lines to fix a problem. Nothing is applied unless the user approves it. ' +
      'Give the lines exactly as they would be typed inside configuration mode (without "configure terminal" or "end"). ' +
      'Only propose a change after you have confirmed the cause with show commands. ' +
      'Every proposal needs a rollback plan (the exact configuration lines that undo it) and verify commands (read-only show commands, each with what you expect to see once the change works). ' +
      'On approval Hopline arms the platform safety net where there is one (Junos commit confirmed, EOS session commit timer, NX-OS checkpoint, IOS-XE archive), applies the lines, stops at the first error, runs the verify commands and returns their output. ' +
      'Then call report_verification; only the user confirms or rolls back.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'array', items: { type: 'string' }, description: 'Configuration lines, in order' },
        rationale: { type: 'string', description: 'What the change does and why, including any risk' },
        rollback: { type: 'array', items: { type: 'string' }, description: 'Configuration lines that undo the change, in order (same mode rules as commands)' },
        verify: {
          type: 'array',
          description: `Read-only commands to run after the change (1 to ${MAX_VERIFY_COMMANDS})`,
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'A read-only show command' },
              expect: { type: 'string', description: 'What its output shows when the change worked' }
            },
            required: ['command', 'expect'],
            additionalProperties: false
          }
        },
        safety_net: { type: 'string', enum: ['auto', 'rollback_lines'], description: 'Optional. "auto" (default): arm the platform\'s safety net where there is one. "rollback_lines": no device net; the rollback lines are the only undo.' },
        confirm_minutes: { type: 'integer', description: `Optional. Minutes a timer net waits for the user's confirmation before the device rolls back by itself (${NET_MINUTES.min} to ${NET_MINUTES.max}, default ${NET_MINUTES.default})` }
      },
      required: ['commands', 'rationale', 'rollback', 'verify'],
      additionalProperties: false
    }
  },
  {
    name: 'report_verification',
    description:
      'After propose_config_change applied a change and returned the verify output: say whether the output shows the change worked. ' +
      'The user sees your judgement next to the output and then confirms or rolls back; this call returns their decision. Call it once per applied change.',
    inputSchema: {
      type: 'object',
      properties: {
        verified: { type: 'boolean', description: 'true only if every verify output matches its expectation' },
        summary: { type: 'string', description: 'One short paragraph: what matched and what did not, quoting the relevant lines' }
      },
      required: ['verified', 'summary'],
      additionalProperties: false
    }
  }
]

/**
 * The tools' arguments, validated with zod before anything is classified or sent: a local model
 * enforces no schema (Anthropic's strict tools do). A call that does not match is refused with the
 * reason, audited, and nothing runs.
 */
export const RunShowInput = z
  .object({
    command: z.string().trim().min(1, 'is empty').max(512),
    reason: z.string().max(1000).optional(),
    filter: z.unknown().optional()
  })
  .strict()
/** propose_config_change arguments: Proposals v2's input (rollback plan, verify commands, safety net). */
export const ProposeConfigInput = ProposalInput

const issues = (e: z.ZodError): string => e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'arguments'} ${i.message}`.replace(/^(\S+) Invalid input: /, '$1: ')).join('; ')

export interface DeviceToolsDeps {
  privacy?: NetworkPrivacy
  term: TabControl
  /** Read on every call: timeouts, caps and read-only mode as they are now. */
  settings: Pick<SettingsService, 'get'>
  audit: Pick<AuditLog, 'append'>
  emit: (e: AgentEventBody) => void
  /** Recent redacted output per tab (copied-line flag on proposal cards); the chat agent keeps it. */
  recent?: (tabId: string) => RecentOutput | undefined
}

export class DeviceTools implements ToolSet {
  readonly specs = DEVICE_TOOL_SPECS

  /**
   * @param started the session as it was when the run started. Each call re-reads it from
   *   `term.get(tabId)`, so a platform set or detected during the run applies to the next call.
   */
  constructor(
    readonly started: TermTab,
    private readonly d: DeviceToolsDeps,
    /** The propose/apply path (agent/proposals.ts). */
    private readonly proposer: ChangeProposer
  ) {}

  private ev(e: AgentEventBody): void {
    this.d.emit(e)
  }

  /** Never throws: an error is audited, shown as a step and returned to the model as `ERROR:`. */
  async call(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    try {
      return await this.runTool(name, input, ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const command = typeof (input as { command?: unknown })?.command === 'string' ? (input as { command: string }).command : name
      this.d.audit.append({ ...auditBase(this.started), command, kind: 'unknown', decision: 'error', reason: msg, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId: ctx.runId, stepId: randomUUID(), command, status: 'error', reason: msg })
      return { text: `ERROR: ${msg}`, isError: true }
    }
  }

  /** A malformed call (llm/types.ts `invalid`): audited as refused and answered with the reason. */
  reject(name: string, why: string, ctx: ToolCallContext): ToolResult {
    const tab = this.d.term.get(this.started.tabId) ?? this.started
    const reason = `malformed tool call: ${why}`
    this.d.audit.append({ ...auditBase(tab), command: name.slice(0, 64), kind: 'unknown', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
    this.ev({ type: 'step', runId: ctx.runId, stepId: randomUUID(), command: name.slice(0, 64), status: 'refused', reason })
    return { text: malformedCall(name, why), isError: true }
  }

  private async runTool(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    // The session as stored now: a platform set or detected during the run applies to this call.
    const tab = this.d.term.get(this.started.tabId) ?? this.started
    const schema = name === 'run_show_command' ? RunShowInput : name === 'propose_config_change' ? ProposeConfigInput : name === 'report_verification' && this.proposer.reportVerification ? VerificationInput : null
    if (!schema) {
      const reason = `unknown tool ${name.slice(0, 64)}`
      this.d.audit.append({ ...auditBase(tab), command: name.slice(0, 64), kind: 'unknown', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId: ctx.runId, stepId: randomUUID(), command: name.slice(0, 64), status: 'refused', reason })
      return { text: `REFUSED: ${reason}. Your tools are ${this.specs.map((t) => t.name).join(', ')}.`, isError: true }
    }
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      const why = `invalid arguments: ${issues(parsed.error)}`
      const command = typeof (input as { command?: unknown })?.command === 'string' ? ((input as { command: string }).command.slice(0, 500) || name) : name
      this.d.audit.append({ ...auditBase(tab), command, kind: 'unknown', decision: 'refused', reason: why, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId: ctx.runId, stepId: randomUUID(), command, status: 'refused', reason: why })
      return { text: `REJECTED: ${why}. Nothing was run. Call ${name} again with arguments that match its schema.`, isError: true }
    }
    if (name === 'propose_config_change') {
      const p = parsed.data as z.infer<typeof ProposeConfigInput>
      if ([...p.commands, ...p.rollback, ...p.verify.map((v) => v.command)].some((line) => this.d.privacy?.hasPlaceholder(line))) {
        return this.reject(name, 'a private network placeholder cannot be used in a device command', ctx)
      }
    }
    if (name === 'run_show_command') return this.runShow(ctx, tab, parsed.data as z.infer<typeof RunShowInput>)
    if (name === 'report_verification') return this.proposer.reportVerification!(this.change(ctx, tab), parsed.data)
    return this.proposer.proposeConfig(this.change(ctx, tab), parsed.data)
  }

  /**
   * Suggest mode (a model without tool calls): the user clicked a suggested block of configuration
   * lines. It opens the same v2 card, but the model gave no rollback plan or verify commands, so
   * both are optional here. Reachable from main only (Agent.runSuggestion), never from a tool call.
   */
  async proposeSuggested(ctx: ToolCallContext, commands: string[]): Promise<ToolResult> {
    const tab = this.d.term.get(this.started.tabId) ?? this.started
    if (commands.some((line) => this.d.privacy?.hasPlaceholder(line))) return this.reject('propose_config_change', 'a private network placeholder cannot be used in a device command', ctx)
    return this.proposer.proposeConfig(this.change(ctx, tab), { commands, rationale: 'Suggested by the model (suggest mode).' }, { suggested: true })
  }

  private change(ctx: ToolCallContext, tab: TermTab): ChangeContext {
    return { runId: ctx.runId, tab, signal: ctx.signal, report: (stepId, command, kind, r, approver) => this.report(ctx.runId, stepId, tab, command, kind, r, approver) }
  }

  private async runShow(ctx: ToolCallContext, tab: TermTab, input: { command?: unknown; reason?: unknown; filter?: unknown }): Promise<ToolResult> {
    const { runId, signal } = ctx
    const raw = typeof input.command === 'string' ? input.command : ''
    if (this.d.privacy?.hasPlaceholder(raw)) return this.reject('run_show_command', 'use an interface identifier or another visible value in the command', ctx)
    const platform = tab.session.platform
    // Default-deny on an unidentified device: the guard has no profile for it.
    const classified = isPlatform(platform)
      ? classify(raw, platform)
      : { ...classify(raw, platform as Platform), kind: 'blocked' as const, reason: 'the device platform is unknown (auto-detect could not identify it), so every command is refused until the user sets the platform' }
    // The team policy's extra blocked commands are part of the deny-list (exec refuses them again).
    const denied = this.d.term.policyRules && classified.kind !== 'blocked' ? policyBlocked(this.d.term.policyRules, platform, raw) : null
    const verdict = denied ? { ...classified, kind: 'blocked' as const, reason: denied } : classified
    const stepId = randomUUID()
    const settings = this.d.settings.get()
    const base = auditBase(tab)

    if (verdict.kind === 'disruptive' && isPlatform(platform)) return this.proposer.proposeDisruptive(this.change(ctx, tab), verdict.command, verdict.reason, input)

    if (verdict.kind !== 'read') {
      const decision = verdict.kind === 'blocked' ? 'blocked' : 'refused'
      const reason =
        verdict.kind === 'config' && !verdict.resolved
          ? `${verdict.reason}; Hopline only runs commands it recognises as read-only. Use a documented show command, or a pipe filter on one`
          : verdict.kind === 'config'
          ? `${verdict.reason}; config changes must go through propose_config_change`
          : verdict.kind === 'disruptive'
            ? `${verdict.reason}; disruptive commands are not run by the assistant`
            : verdict.reason
      // Guard v2 suggests local filtering for pipes a platform lacks: name the parameter that does it.
      const hint = /filter the output locally/.test(reason) ? ' (run_show_command\'s "filter" parameter: the device gets the plain command)' : ''
      this.d.audit.append({ ...base, command: raw, kind: verdict.kind, decision, reason, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId, stepId, command: raw, status: decision, kind: verdict.kind, reason })
      return { text: `${decision.toUpperCase()}: ${reason}${hint}. This decision is final.`, isError: true }
    }

    // Phase 8 H1: a ping or traceroute to a name is a DNS lookup, a way out of the network. It is
    // never auto-run: the user clicks it (read-only mode refuses it).
    const name = agentReach(verdict.command, platform)
    if (name) {
      if (this.proposer.proposeReach) return this.proposer.proposeReach(this.change(ctx, tab), verdict.command, name, input)
      const reason = `${name}; use the IP address`
      this.d.audit.append({ ...base, command: raw, kind: 'read', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId, stepId, command: verdict.command, status: 'refused', kind: 'read', reason })
      return { text: `REFUSED: ${reason}. This decision is final.`, isError: true }
    }

    // F5b: the local filter. Validated here (a local model enforces no schema); nothing runs on a bad one.
    let filter: OutputFilter | undefined
    if (input.filter !== undefined && input.filter !== null) {
      const parsed = OutputFilter.safeParse(input.filter)
      if (!parsed.success) {
        const reason = `invalid filter: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'filter'} ${i.message}`).join('; ')}`
        this.d.audit.append({ ...base, command: raw, kind: 'read', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
        this.ev({ type: 'step', runId, stepId, command: verdict.command, status: 'refused', kind: 'read', reason })
        return { text: `REFUSED: ${reason}. Nothing was sent to the device.`, isError: true }
      }
      if (!isEmptyFilter(parsed.data)) filter = parsed.data
    }
    const label = filter && describeFilter(filter)

    this.ev({ type: 'step', runId, stepId, command: verdict.command, status: 'running', kind: 'read', filter: label, reason: typeof input.reason === 'string' ? input.reason : undefined })
    const r = await this.d.term.exec(tab, verdict.command, 'read', { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes, signal })
    // A suggested command the user clicked is logged with the user as approver.
    return this.report(runId, stepId, tab, verdict.command, 'read', r, ctx.approver ? userName() : null, filter)
  }

  private report(runId: string, stepId: string, tab: TermTab, command: string, kind: 'read' | 'config' | 'disruptive', r: ExecResult, approver: string | null, filter?: OutputFilter): ToolResult {
    // Order matters: strip escapes and redact the whole output first (untrusted.ts), so grep/count
    // can never act as an oracle on a secret; then filter; then cap what goes to the model, so the
    // cap keeps the relevant part. The renderer preview gets the same cleaned text, and the
    // copied-line detector compares against it too.
    const red = untrustedText(r.output)
    if (kind === 'read' && r.status !== 'error') this.d.recent?.(tab.tabId)?.record(command, red.text)
    const privacy = this.d.privacy
    privacy?.discover(red.text)
    const label = filter && describeFilter(filter)
    let body = red.text
    let note = ''
    let filterError: string | undefined
    if (filter) {
      try {
        const f = applyFilter(red.text, filter)
        body = f.text
        note = f.note
        if (r.status === 'capped') note += `; the device output hit the ${Math.round(r.bytes / 1024)} KB cap, so these are not the real last lines: narrow the command`
      } catch (e) {
        if (!(e instanceof FilterError)) throw e
        filterError = e.message
      }
    }
    const decision = r.status === 'ok' ? 'executed' : r.status === 'error' ? 'error' : r.status
    const why = r.error ?? (approver ? 'approved by user' : 'read-only')
    this.d.audit.append({
      ...auditBase(tab),
      command,
      kind,
      decision,
      reason: label ? `${why}; local filter: ${label}${filterError ? ` (${filterError})` : ''}` : why,
      approver,
      durationMs: r.durationMs,
      bytes: r.bytes,
      redactions: red.count
    })
    const shown = filterError ? red.text : body
    const preview = shown.length > 4000 ? shown.slice(0, 4000) + '\n…' : shown
    this.ev({ type: 'step', runId, stepId, command, status: r.status === 'ok' ? 'ok' : r.status, kind, durationMs: r.durationMs, bytes: r.bytes, preview, filter: label, filterNote: filterError ?? (note || undefined), reason: r.error })
    if (filterError) return { text: `FILTER ERROR: ${filterError}. The command ran, but its output was not returned. Retry with a simpler filter.`, isError: true }

    // Device text goes inside an untrusted frame; Hopline's own notes stay outside it, so device
    // output can't forge a note or close the frame (tags in it were neutralised by untrustedText).
    const device = privacy?.mask(tab.session.name) ?? tab.session.name
    body = privacy?.mask(body) ?? body
    const out = body.length > MAX_TOOL_CHARS ? body.slice(0, MAX_TOOL_CHARS) : body
    const empty = note ? '(no matching lines)' : '(no output)'
    const modelCommand = privacy?.mask(command) ?? command
    let text = frameOutput(device, modelCommand, out || empty)
    if (body.length > MAX_TOOL_CHARS) text += `\n[Hopline: output truncated: ${body.length - MAX_TOOL_CHARS} more characters; use a more specific command or the filter parameter]`
    if (note) text = `[Hopline filter ${label}: ${note}]\n${text}`
    // TextFSM: when a bundled template knows this command, the rows go along with the raw text.
    // Parsed from the REDACTED output only, and only for a complete, unfiltered read.
    if (r.status === 'ok' && kind === 'read' && !filter) {
      const parsed = parseSafe(tab.session.platform, command, red.text)
      if (parsed && parsed.rows.length) {
        const c = compactRows(parsed)
        const more = c.shown < c.total ? `, first ${c.shown} shown` : ''
        text += `\n\n[Hopline parsed this output with TextFSM template ${parsed.template}: ${c.total} rows${more}; tab-separated, same untrusted device data]\n${frameOutput(device, modelCommand, c.text, ' parsed="textfsm"')}`
      }
    }
    if (r.status === 'ok') return { text }
    return { text: `${r.status.toUpperCase()}: ${r.error ?? ''}\n${text}`.trim(), isError: true }
  }
}

/** The OS user, as the approver of a suggested command (the same name proposals record). */
function userName(): string {
  try {
    return userInfo().username
  } catch {
    return 'user'
  }
}
