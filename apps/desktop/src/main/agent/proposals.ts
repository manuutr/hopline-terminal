import { NET_MINUTES, safetyNet, type PlatformId } from '@hopline/cli-model'
import { classify, MAX_COMMAND_LENGTH } from '@hopline/guard'
import { randomBytes, randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { z } from 'zod'
import type { AgentEventBody, ChangeNet } from '@shared/types'
import type { ExecResultMsg as ExecResult } from '@shared/host-protocol'
import { policyBlocked } from '@shared/policy-deny'
import { changesMode, hostBound, hostnamesSetBy, isModelled, promptUser, sameHost } from '@shared/cli'
import type { AuditLog } from '../db/audit'
import type { AgentTab as TermTab, TabControl } from '../host/client'
import type { SettingsService } from '../settings'
import { asConfigLine } from '../productivity/runner'
import { Changes } from './changes'
import { stripInvisible } from './untrusted'
import { checkProposal, type CheckedProposal } from './config-apply'
import type { RecentOutput } from './copied'
import type { ToolResult } from './loop'

/**
 * The propose → approve path for one device: config change proposals (v2: rollback plan, verify
 * commands, safety net) and disruptive exec commands, the pending cards, and the decisions the
 * renderer sends by id. What happens after an approval (arm, apply, verify, confirm/rollback) is
 * `Changes` (changes.ts).
 *
 * Kept behind `ChangeProposer` so `DeviceTools` does not depend on how changes are approved and
 * applied (the fleet change sets will reuse the same pieces).
 */

const PROPOSAL_TIMEOUT_MS = 15 * 60_000
export const MAX_PROPOSAL_LINES = 50
export const MAX_VERIFY_COMMANDS = 8
/** Shown when the renderer decides on a proposal that already closed (timed out, cancelled, decided). */
export const PROPOSAL_CLOSED = 'This proposal is no longer open'

export type DecisionWhy = 'user' | 'timeout' | 'cancelled'

export interface PendingProposal {
  id: string
  runId: string
  tabId: string
  commands: string[]
  /** Disruptive: the device hostname the user must type to approve. */
  confirm?: string
  /** Lines may be approved one by one (config proposals; not a single exec command). */
  perLine: boolean
  /** Who the card is for, for the audit of a refused decision (L10). */
  base: ReturnType<typeof auditBase>
  resolve: (approved: boolean, why: DecisionWhy, ack?: string, lines?: number[]) => void
}

/** Redact, audit, emit a step and build the model's text for one command result (DeviceTools.report). */
export type ReportFn = (stepId: string, command: string, kind: 'read' | 'config' | 'disruptive', r: ExecResult, approver: string | null) => ToolResult

/** What a proposal needs from the tool call that made it. */
export interface ChangeContext {
  runId: string
  /** The session as stored now. */
  tab: TermTab
  signal: AbortSignal
  report: ReportFn
}

/** The small interface DeviceTools uses for anything that changes the device. */
export interface ChangeProposer {
  /** `propose_config_change`: guard every line, show a card, apply the stored lines on approval. */
  proposeConfig(ctx: ChangeContext, input: unknown, opts?: ProposeOpts): Promise<ToolResult>
  /** A disruptive exec command from `run_show_command`: never run directly, only through a typed-hostname approval. */
  proposeDisruptive(ctx: ChangeContext, command: string, why: string, input: { reason?: unknown }): Promise<ToolResult>
  /** `report_verification`: the model's judgement of an applied change's verify output. */
  reportVerification?(ctx: ChangeContext, input: unknown): Promise<ToolResult>
  /**
   * A read the agent may not auto-run (Phase 8 H1: a ping or traceroute to a name, a DNS lookup
   * that can carry data out): a one-click card; refused in read-only mode. Absent: refused.
   */
  proposeReach?(ctx: ChangeContext, command: string, why: string, input: { reason?: unknown }): Promise<ToolResult>
}

export interface ProposalsDeps {
  term: TabControl
  settings: Pick<SettingsService, 'get'>
  audit: Pick<AuditLog, 'append'>
  emit: (e: AgentEventBody) => void
  /** Recent redacted device output of a tab, for the copied-line flag. */
  recent?: (tabId: string) => RecentOutput | undefined
}

export function auditBase(tab: TermTab) {
  return { sessionId: tab.session.id, sessionName: tab.session.name, host: tab.session.host, source: 'agent' as const }
}

/** Lines as the model sends them: trimmed, empty ones dropped. */
const lines = (max: number) =>
  z
    .array(z.string().max(MAX_COMMAND_LENGTH))
    .max(max * 2)
    .transform((a) => a.map((l) => l.trim()).filter(Boolean))
    .pipe(z.array(z.string()).max(max))

/** `propose_config_change` input, validated in main (a local model enforces no schema). */
export const ProposalInput = z
  .object({
    commands: lines(MAX_PROPOSAL_LINES).pipe(z.array(z.string()).min(1, 'proposal has no commands')),
    rationale: z.string().max(4000).transform(stripInvisible).default(''),
    rollback: lines(MAX_PROPOSAL_LINES).pipe(z.array(z.string()).min(1, 'a rollback plan (the exact lines that undo the change) is required')),
    verify: z
      .array(z.object({ command: z.string().trim().min(1).max(MAX_COMMAND_LENGTH), expect: z.string().trim().max(500).transform(stripInvisible).pipe(z.string().trim().min(1)) }).strict())
      .min(1, 'at least one verify command (with what you expect to see) is required')
      .max(MAX_VERIFY_COMMANDS),
    safety_net: z.enum(['auto', 'rollback_lines']).optional(),
    confirm_minutes: z.number().int().min(NET_MINUTES.min).max(NET_MINUTES.max).optional()
  })
  .strict()
export type ProposalInput = z.infer<typeof ProposalInput>

/**
 * Suggest mode (a model without tool calls): the user clicked configuration lines the model wrote
 * as text. Nothing gives a rollback plan or verify commands, so both may be empty; the device
 * safety net is still armed, and without one there is nothing to roll back with (confirm only).
 */
const SuggestedInput = ProposalInput.extend({
  rollback: lines(MAX_PROPOSAL_LINES).default([]),
  verify: z.array(ProposalInput.shape.verify.unwrap()).max(MAX_VERIFY_COMMANDS).default([])
}).strict()

/** Main-only options (never from the model's tool input). */
export interface ProposeOpts {
  suggested?: boolean
}

/** The net a proposal gets on this platform (or the rollback lines). */
export function netFor(platform: PlatformId, choice: ProposalInput['safety_net'], minutes: number): { info: ChangeNet; net?: { spec: NonNullable<ReturnType<typeof safetyNet>>; name: string; minutes: number } } {
  const spec = choice === 'rollback_lines' ? undefined : safetyNet(platform)
  if (!spec) {
    const why = choice === 'rollback_lines' && safetyNet(platform) ? 'the assistant chose not to use the device safety net' : 'this platform has no safety net Hopline Terminal can arm'
    return { info: { kind: 'rollback-lines', label: 'rollback lines', detail: `No device safety net (${why}): rolling back runs the rollback lines below.` } }
  }
  const name = `hopline-${randomBytes(4).toString('hex')}`
  return { info: { kind: spec.kind, label: spec.label, detail: spec.describe(minutes), ...(spec.timer ? { minutes } : {}) }, net: { spec, name, minutes } }
}

/**
 * Sub-mode groups of a proposal: a line that enters a sub-mode (interface, router …) and the lines
 * classified in it. Deselecting the head without its members would change what they mean.
 */
export function lineGroups(checked: CheckedProposal, commands: readonly string[], platform: PlatformId): { head: number; members: number[] }[] {
  const top = checked.plan.session.linesFrom
  const groups: { head: number; members: number[] }[] = []
  for (const [i, v] of checked.verdicts.entries()) {
    // A head is typed at the top level, or is a line that would enter the same sub-mode from the top
    // (IOS lets `interface Gi0/2` be typed straight from `(config-if)#`).
    const head = v.mode === top || (v.nextMode !== top && classify(commands[i]!, platform, { mode: top }).nextMode === v.nextMode)
    if (head) groups.push({ head: i, members: [] })
    else groups.at(-1)?.members.push(i)
  }
  return groups.filter((g) => g.members.length)
}

export class Proposals implements ChangeProposer {
  private pending = new Map<string, PendingProposal>()
  readonly changes: Changes

  constructor(private readonly d: ProposalsDeps) {
    this.changes = new Changes(d)
  }

  private ev(e: AgentEventBody): void {
    this.d.emit(e)
  }

  /** The proposals waiting for a decision. */
  open(): IterableIterator<PendingProposal> {
    return this.pending.values()
  }

  /**
   * Approve or reject a proposal. The renderer sends only the id, the ticked line indexes and, for
   * a disruptive one, the hostname the user typed; the commands that run are the ones stored here
   * when the proposal was made, so the UI cannot alter them. A disruptive approval whose hostname
   * does not match is refused and the proposal stays open.
   */
  decide(proposalId: string, approve: boolean, why: DecisionWhy = 'user', ack?: string, lines?: number[]): void {
    const p = this.pending.get(proposalId)
    if (!p) {
      // Timed out, cancelled or already decided: the card must not show "approved" for nothing.
      if (why === 'user') throw new Error(PROPOSAL_CLOSED)
      return
    }
    // L10: a refused decision is audited too (the card stays open).
    const refused = (reason: string): never => {
      this.d.audit.append({ ...p.base, command: p.commands.join(' ⏎ ').slice(0, 500), kind: p.confirm !== undefined ? 'disruptive' : 'config', decision: 'refused', reason: `approval refused: ${reason}`, approver: userInfo().username, durationMs: null, bytes: null, redactions: null, runId: p.runId })
      throw new Error(reason)
    }
    if (approve && why === 'user' && p.confirm !== undefined && !sameHost(ack ?? '', p.confirm)) refused(`Type the device hostname "${p.confirm}" to approve this disruptive change`)
    let picked: number[] | undefined
    if (approve && lines !== undefined) {
      if (!p.perLine) refused('This proposal is approved as a whole')
      picked = [...new Set(lines)].sort((a, b) => a - b)
      if (!picked.length) refused('Tick at least one line to approve')
      if (picked.some((i) => i < 0 || i >= p.commands.length)) refused('A ticked line is not part of this proposal')
    }
    this.pending.delete(proposalId)
    this.ev({ type: 'proposal-closed', runId: p.runId, proposalId, reason: why === 'user' ? 'decided' : why })
    p.resolve(approve && why === 'user', why, p.confirm !== undefined ? ack : undefined, picked)
  }

  async reportVerification(ctx: ChangeContext, input: unknown): Promise<ToolResult> {
    return this.changes.judge(ctx, input)
  }

  async proposeConfig(ctx: ChangeContext, input: unknown, opts: ProposeOpts = {}): Promise<ToolResult> {
    const { runId, tab, signal } = ctx
    const base = auditBase(tab)
    const platform = tab.session.platform
    const raw = (input ?? {}) as { commands?: unknown }
    const rawLines = Array.isArray(raw.commands) ? raw.commands.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter(Boolean) : []
    const stepId = randomUUID()

    const refuse = (decision: 'blocked' | 'refused', reason: string, kind = 'config', shown: string[] = rawLines) => {
      for (const c of shown.length ? shown : ['(empty proposal)'])
        this.d.audit.append({ ...base, command: c, kind, decision, reason, approver: null, durationMs: null, bytes: null, redactions: null })
      const label = shown.join(' ⏎ ').slice(0, 200)
      this.ev({ type: 'step', runId, stepId, command: label || '(empty proposal)', status: decision, kind: 'config', reason })
      return { text: `${decision.toUpperCase()}: ${reason}`, isError: true }
    }

    const parsed = (opts.suggested ? SuggestedInput : ProposalInput).safeParse(input)
    if (!parsed.success) return refuse('refused', `invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
    const { commands, rationale, rollback, verify } = parsed.data
    if (!isModelled(platform)) return refuse('refused', 'the device platform is unknown, so nothing can be classified; set the platform for this session first')
    // H1: one open change per device session. A second one would be undone (or committed) by the
    // first one's rollback or confirm; Changes.apply checks again after the approval.
    const open = this.changes.activeOn(tab.session.id)
    if (open)
      return refuse(
        'refused',
        `another change is still open on this device ("${open.commands[0] ?? ''}"${open.commands.length > 1 ? ' …' : ''}, ${open.phase}): the user must confirm or roll it back on its card first. Do not propose again until they have`
      )
    // The team policy's blocked commands (docs/POLICY.md) apply to every line of the proposal: the
    // change, the rollback plan (under a device net it is never sent, so exec would never see it)
    // and the verify commands. Checked before any card; exec and the session host check again.
    const rules = this.d.term.policyRules
    if (rules) {
      for (const [section, list] of [['', commands], ['rollback plan: ', rollback], ['verify command ', verify.map((v) => v.command)]] as const)
        for (const c of list) {
          const denied = policyBlocked(rules, platform, c)
          if (denied) return refuse('blocked', `${section}"${c}": ${denied}`, 'blocked', [c])
        }
    }

    // The device this proposal is for, as its prompt shows it now. Every line that runs later is bound
    // to it (main checks again after approval, the session host before each line), so an approval
    // never lands on another device reached through a nested ssh/telnet hop. The admin name in a
    // `user@host` prompt names the commit on PAN-OS (`commit partial admin <user>`).
    const at = await this.d.term.prompt(tab)
    const host = at.hostname
    const user = promptUser(at.prompt)
    const minutes = parsed.data.confirm_minutes ?? NET_MINUTES.default
    const { info: netInfo, net } = netFor(platform, parsed.data.safety_net, minutes)
    const info: ChangeNet = !net && !rollback.length ? { ...netInfo, label: 'no undo', detail: 'No device safety net and no rollback plan (suggest mode): once applied, the change can only be kept.' } : netInfo
    const netCtx = net ? { session: net.spec.session(net.name, minutes), netLines: net.spec.sessionNetLines(net.name, minutes) } : undefined
    // The deny-list applies even with approval. Lines are classified in order, in the sub-mode the
    // previous lines entered, and wrapped the way this platform (and its net) takes changes.
    const checked = checkProposal(platform, commands, { user, net: netCtx })
    if ('decision' in checked) return refuse(checked.decision, checked.reason, checked.kind)

    // M4: the team policy also covers every line Hopline itself will send for this change: the
    // platform wrapper (enter, commit, leave, discard) and the safety net's own lines and reads
    // (arm, learn, the timer check, confirm, rollback, cleanup). A net line the policy blocks would
    // otherwise be refused at send time, after the change is live (no undo). Checked before the
    // card; exec and the session host still check every line when it is sent.
    if (rules) {
      const wrapper = [...(checked.plan.precheck ? [checked.plan.precheck] : []), ...checked.plan.before, ...checked.plan.after, ...checked.plan.abort]
      for (const c of wrapper) {
        const denied = policyBlocked(rules, platform, c)
        if (denied) return refuse('blocked', `"${c}" (added around the change on this platform): ${denied}`, 'blocked', [c])
      }
      if (net) {
        const s = net.spec
        const own = [
          ...s.arm(net.name),
          ...(s.learn ? [s.learn.command] : []),
          ...(s.check ? [s.check.command] : []),
          ...s.sessionNetLines(net.name, minutes),
          ...s.confirm(net.name),
          // IOS-XE: the archive file is known only after arming; a representative name of the same shape.
          ...s.rollback(net.name, s.kind === 'archive' ? 'flash:archive-1' : undefined),
          ...(s.cleanup?.(net.name) ?? [])
        ]
        for (const c of own) {
          const denied = policyBlocked(rules, platform, c)
          if (denied)
            return refuse(
              'blocked',
              `the ${s.label} safety net needs "${c}", which the team policy does not allow (${denied}): the change could not be undone or confirmed once live. Propose it with safety_net "rollback_lines" if the rollback lines are an acceptable undo`,
              'blocked',
              [c]
            )
        }
      }
    }

    // The rollback plan: guarded like the change itself, in the platform's plain session. Every
    // line must be a configuration line: blocked lines and reads are refused. Decision: a
    // disruptive line is allowed (the exact undo of "no shutdown" is "shutdown"); when the rollback
    // lines are the only undo, it joins the card's disruptive reasons, so approving needs the typed
    // hostname, which the rollback then carries.
    const rb = rollback.length ? checkProposal(platform, rollback, { user }) : { verdicts: [], disruptive: [] as string[] }
    if ('decision' in rb) return refuse(rb.decision, `rollback plan: ${rb.reason}`, rb.kind, rollback)
    for (const [i, v] of rb.verdicts.entries()) {
      if (v.kind === 'blocked') return refuse('blocked', `rollback plan: "${rollback[i]}": ${v.reason}`, 'blocked', rollback)
      if (v.kind !== 'config' && v.kind !== 'disruptive') return refuse('refused', `rollback plan: "${rollback[i]}" is not a configuration line (${v.reason})`, v.kind, rollback)
    }
    // Verify commands: read-only, classified at the exec prompt like run_show_command.
    for (const v of verify) {
      const c = classify(v.command, platform)
      if (c.kind !== 'read') return refuse(c.kind === 'blocked' ? 'blocked' : 'refused', `verify command "${v.command}" is not read-only (${c.reason})`, c.kind, [v.command])
    }

    if (this.d.settings.get().aiReadOnly) {
      return refuse('refused', 'the assistant is in read-only mode. The user can allow change proposals from the status bar or command palette', checked.disruptive.length ? 'disruptive' : 'config')
    }
    // Disruptive lines: the user must type the device hostname to approve (checked here and again
    // by the session host against the prompt it sees).
    let disruptive: { reasons: string[]; confirm: string } | undefined
    const reasons = [...checked.disruptive, ...(net ? [] : rb.disruptive.map((r) => `rollback ${r}`))]
    if (reasons.length) {
      if (!host) return refuse('refused', `${reasons[0]}. It is disruptive, and the device prompt shows no hostname to confirm against`, 'disruptive')
      disruptive = { reasons, confirm: host }
    }
    if (at.mode !== 'exec' && at.mode !== 'user' && checked.plan.session.enter.length)
      return refuse('refused', `the session is not at the exec prompt (it shows ${at.mode} mode); leave configuration mode first`)

    const groups = lineGroups(checked, commands, platform)

    // Copied text: a line holding a long run of recent device output may have been planted there.
    const recent = this.d.recent?.(tab.tabId)
    const copied: { section: 'commands' | 'rollback' | 'verify'; index: number; from: string }[] = []
    if (recent) {
      const scan = (section: 'commands' | 'rollback' | 'verify', list: string[]) =>
        list.forEach((l, index) => {
          const from = recent.sourceOf(l)
          if (from) copied.push({ section, index, from })
        })
      scan('commands', commands)
      scan('rollback', rollback)
      scan('verify', verify.map((v) => v.command))
    }

    const netBefore = net ? net.spec.arm(net.name) : []
    const { approved, why, ack, lines: picked, proposalId } = await this.awaitDecision(
      runId,
      tab,
      {
        commands,
        rationale,
        wrapper: { before: [...netBefore, ...(checked.plan.precheck ? [checked.plan.precheck] : []), ...checked.plan.before], after: checked.plan.after, abort: checked.plan.abort },
        disruptive,
        rollback,
        verify,
        net: info,
        ...(copied.length ? { copied } : {}),
        // Phase 8 M1: lines the command trees do not model (default-deny config) are flagged on the card.
        ...(checked.verdicts.some((v) => !v.resolved) ? { unknown: checked.verdicts.flatMap((v, i) => (v.resolved ? [] : [i])) } : {}),
        groups
      },
      signal,
      true
    )

    const approver = userInfo().username
    const kindOf = (i: number) => (checked.verdicts[i]?.kind === 'disruptive' ? 'disruptive' : 'config')
    if (!approved) {
      const reason = why === 'user' ? 'rejected by user' : why === 'timeout' ? 'approval timed out' : 'run cancelled before approval'
      for (const [i, c] of commands.entries())
        this.d.audit.append({ ...base, command: c, kind: kindOf(i), decision: 'rejected', reason, approver: why === 'user' ? approver : null, durationMs: null, bytes: null, redactions: null })
      return {
        text: why === 'user' ? 'The user REJECTED this change. Nothing was applied. Do not propose it again unless asked.' : `Not applied: ${reason}. Nothing was changed.`
      }
    }

    // The ticked lines, in order. Main re-checks the subset: dropping a line must not change the
    // mode the remaining lines are typed in (an interface line dropped, its sub-commands kept).
    const idx = picked ?? commands.map((_, i) => i)
    const chosen = idx.map((i) => commands[i]!)
    const skipped = commands.filter((_, i) => !idx.includes(i))
    let final = checked
    if (skipped.length) {
      const sub = checkProposal(platform, chosen, { user, net: netCtx })
      const refuseSubset = (reason: string) => {
        for (const [i, c] of commands.entries())
          this.d.audit.append({ ...base, command: c, kind: kindOf(i), decision: 'refused', reason, approver, durationMs: null, bytes: null, redactions: null })
        this.ev({ type: 'step', runId, stepId, command: chosen.join(' ⏎ ').slice(0, 200), status: 'refused', kind: 'config', reason })
        return { text: `REFUSED: ${reason}. Nothing was applied.`, isError: true }
      }
      if ('decision' in sub) return refuseSubset(`the ticked lines alone do not form a valid change: ${sub.reason}`)
      // A sub-mode line needs the line that enters ITS context: the same mode under another
      // interface (`description` kept, its `interface Gi0/2` dropped) would land on the wrong one.
      const orphan = groups.find((g) => !idx.includes(g.head) && g.members.some((m) => idx.includes(m)))
      if (orphan) return refuseSubset(`"${commands[orphan.members.find((m) => idx.includes(m))!]}" would be typed in another mode or context without "${commands[orphan.head]}"; tick that line too, or untick it`)
      // Inside a section a subset may stop early but not skip a line: the guard's mode model does
      // not see every nested context (IOS `address-family` stays router mode to it), so a skipped
      // middle line could move the lines after it.
      for (const g of groups) {
        const gap = g.members.findIndex((m, k) => !idx.includes(m) && g.members.slice(k + 1).some((n) => idx.includes(n)))
        if (gap >= 0) {
          const after = g.members.slice(gap + 1).find((n) => idx.includes(n))!
          return refuseSubset(`"${commands[after]}" follows the unticked "${commands[g.members[gap]!]}" in the same section; a section can stop early, but not skip a line (it may change the context of the lines after it). Untick the lines after it too, or tick it`)
        }
      }
      const moved = idx.findIndex((orig, k) => sub.verdicts[k]!.mode !== checked.verdicts[orig]!.mode)
      if (moved >= 0) return refuseSubset(`"${chosen[moved]}" would be typed in another mode without the unticked line(s) above it; tick the line that enters its mode, or untick it too`)
      final = sub
      for (const c of skipped) this.d.audit.append({ ...base, command: c, kind: 'config', decision: 'rejected', reason: 'unticked by the user (the other lines were approved)', approver, durationMs: null, bytes: null, redactions: null })
    }

    // Read-only switched on while the card waited: the setting wins over the approval.
    if (this.d.settings.get().aiReadOnly) {
      for (const [i, c] of commands.entries())
        this.d.audit.append({ ...base, command: c, kind: kindOf(i), decision: 'refused', reason: 'read-only mode was turned on before the approval', approver, durationMs: null, bytes: null, redactions: null })
      return { text: 'REFUSED: read-only mode was turned on before the approval. Nothing was applied.', isError: true }
    }

    // The device must still be the one the card was approved for.
    const now = await this.d.term.prompt(tab)
    if (!hostBound([host], now.hostname)) {
      const reason = `the device changed since the proposal: the prompt showed "${host || '(no hostname)'}" and now shows "${now.hostname || '(no hostname)'}" (a nested ssh/telnet session?). Nothing was applied`
      for (const [i, c] of commands.entries())
        this.d.audit.append({ ...base, command: c, kind: kindOf(i), decision: 'refused', reason, approver, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId, stepId, command: commands.join(' ⏎ ').slice(0, 200), status: 'refused', kind: 'config', reason })
      return { text: `REFUSED: ${reason}.`, isError: true }
    }

    // M2: bound to the hostname the prompt shows and to names the APPROVED lines set (an unticked
    // `hostname x` line must not widen it). Changes.apply narrows it again once the change is in.
    const hosts = [host, ...hostnamesSetBy(chosen)]
    const r = await this.changes.apply(ctx, {
      proposalId,
      runId,
      tab,
      platform,
      commands: chosen,
      checked: final,
      rollback,
      ...(rollback.length ? { rollbackChecked: rb as CheckedProposal } : {}),
      verify,
      ...(net ? { net } : {}),
      info,
      hosts,
      ...(ack ? { ack } : {}),
      approver,
      subset: skipped.length > 0,
      ...(opts.suggested ? { suggested: true } : {})
    })
    const note = skipped.length ? `\nThe user approved ${chosen.length} of ${commands.length} lines; not applied: ${skipped.map((s) => `"${s}"`).join(', ')}.` : ''
    return { ...r, text: r.text + note }
  }

  /** Show a proposal card and wait for the user (or the timeout, or a cancel). */
  private awaitDecision(
    runId: string,
    tab: TermTab,
    card: Omit<Extract<AgentEventBody, { type: 'proposal' }>, 'type' | 'runId' | 'proposalId'>,
    signal: AbortSignal,
    perLine = false
  ): Promise<{ approved: boolean; why: DecisionWhy; ack?: string; lines?: number[]; proposalId: string }> {
    const proposalId = randomUUID()
    this.ev({ type: 'proposal', runId, proposalId, ...card })
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(proposalId, false, 'timeout'), PROPOSAL_TIMEOUT_MS)
      const onAbort = () => this.decide(proposalId, false, 'cancelled')
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(proposalId, {
        id: proposalId,
        runId,
        tabId: tab.tabId,
        commands: card.commands,
        confirm: card.disruptive?.confirm,
        perLine,
        base: auditBase(tab),
        resolve: (ok, w, ack, lines) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve({ approved: ok, why: w, ack, lines, proposalId })
        }
      })
    })
  }

  /**
   * A read-only command Hopline will not auto-run for the model (a ping or traceroute to a name:
   * the DNS lookup is a way out of the network). One click runs it; read-only mode refuses it.
   * Every outcome is audited.
   */
  async proposeReach(ctx: ChangeContext, command: string, why: string, input: { reason?: unknown }): Promise<ToolResult> {
    const { runId, tab, signal } = ctx
    const base = auditBase(tab)
    const stepId = randomUUID()
    const refuse = (reason: string) => {
      this.d.audit.append({ ...base, command, kind: 'read', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId, stepId, command, status: 'refused', kind: 'read', reason })
      return { text: `REFUSED: ${reason}. Use the IP address instead. This decision is final.`, isError: true }
    }
    if (this.d.settings.get().aiReadOnly) return refuse(`${why}; in read-only mode the assistant only pings or traces IP addresses`)
    const rationale = typeof input.reason === 'string' ? stripInvisible(input.reason) : ''
    const { approved, why: w } = await this.awaitDecision(runId, tab, { commands: [command], rationale, exec: true, notice: `${why}. Hopline Terminal runs it only if you click Approve.` }, signal)
    const approver = userInfo().username
    if (!approved) {
      const reason = w === 'user' ? 'rejected by user' : w === 'timeout' ? 'approval timed out' : 'run cancelled before approval'
      this.d.audit.append({ ...base, command, kind: 'read', decision: 'rejected', reason, approver: w === 'user' ? approver : null, durationMs: null, bytes: null, redactions: null })
      return { text: w === 'user' ? 'The user REJECTED this command. Nothing was run. Use an IP address, or ask the user.' : `Not run: ${reason}.` }
    }
    const settings = this.d.settings.get()
    if (settings.aiReadOnly) return refuse(`${why}; read-only mode was turned on before the approval`)
    this.ev({ type: 'step', runId, stepId, command, status: 'running', kind: 'read' })
    const r = await this.d.term.exec(tab, command, 'read', { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes, signal })
    return ctx.report(stepId, command, 'read', r, approver)
  }

  /**
   * A disruptive exec command (reload, clear …) the model asked to run: never run directly. With
   * change proposals allowed it becomes a proposal the user approves by typing the device hostname;
   * in read-only mode it is refused.
   */
  async proposeDisruptive(ctx: ChangeContext, command: string, why: string, input: { reason?: unknown }): Promise<ToolResult> {
    const { runId, tab, signal } = ctx
    const base = auditBase(tab)
    const stepId = randomUUID()
    const refuse = (reason: string) => {
      this.d.audit.append({ ...base, command, kind: 'disruptive', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
      this.ev({ type: 'step', runId, stepId, command, status: 'refused', kind: 'disruptive', reason })
      return { text: `REFUSED: ${reason}. This decision is final.`, isError: true }
    }
    if (this.d.settings.get().aiReadOnly) return refuse(`${why}; disruptive commands are not run in read-only mode`)
    // Review X2: the same shape rules as the guarded runner. A line that changes the mode or the
    // context never runs as one exec command; a configuration line goes through a proposal.
    const platform = tab.session.platform
    if (isModelled(platform)) {
      const v = classify(command, platform)
      if (changesMode(platform, command, v)) return refuse(`${why}; it changes the CLI mode, privilege level or context, which would leave the session in another mode`)
      if (asConfigLine(platform, v)) return refuse(`${why}; it is a configuration line: propose it with propose_config_change`)
    }
    const p = await this.d.term.prompt(tab)
    if (p.mode !== 'exec' && p.mode !== 'user') return refuse(`${why}; the session is not at an exec prompt`)
    if (!p.hostname) return refuse(`${why}; the device prompt shows no hostname to confirm against`)

    const rationale = typeof input.reason === 'string' ? stripInvisible(input.reason) : ''
    const { approved, why: w, ack } = await this.awaitDecision(runId, tab, { commands: [command], rationale, exec: true, disruptive: { reasons: [`"${command}": ${why}`], confirm: p.hostname } }, signal)
    const approver = userInfo().username
    if (!approved) {
      const reason = w === 'user' ? 'rejected by user' : w === 'timeout' ? 'approval timed out' : 'run cancelled before approval'
      this.d.audit.append({ ...base, command, kind: 'disruptive', decision: 'rejected', reason, approver: w === 'user' ? approver : null, durationMs: null, bytes: null, redactions: null })
      return { text: w === 'user' ? 'The user REJECTED this command. Nothing was run. Do not ask again unless asked.' : `Not run: ${reason}.` }
    }
    const settings = this.d.settings.get()
    if (settings.aiReadOnly) return refuse(`${why}; read-only mode was turned on before the approval`)
    this.ev({ type: 'step', runId, stepId, command, status: 'running', kind: 'disruptive' })
    const r = await this.d.term.exec(tab, command, 'disruptive', { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes, signal, ack, hosts: [p.hostname] })
    return ctx.report(stepId, command, 'disruptive', r, approver)
  }
}
