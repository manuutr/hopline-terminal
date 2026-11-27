import { classify, redact, type Platform } from '@hopline/guard'
import { frameOutput, untrustedText } from './untrusted'
import { archiveSucceeds, type NetState, type PlatformId, type SafetyNetSpec } from '@hopline/cli-model'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { z } from 'zod'
import type { AgentEventBody, ChangeNet, ChangePhase, ChangeUpdate, StepStatus } from '@shared/types'
import type { ExecResultMsg as ExecResult } from '@shared/host-protocol'
import { deviceError, hostBound } from '@shared/cli'
import type { AuditLog } from '../db/audit'
import type { AgentTab as TermTab, TabControl } from '../host/client'
import type { SettingsService } from '../settings'
import { runConfig, type CheckedProposal, type LineKind } from './config-apply'
import type { ToolResult } from './loop'
import type { ChangeContext } from './proposals'

/**
 * Proposals v2 (ARCHITECTURE §6.3): one approved change on one device, from the approval to its
 * end. `apply` arms the platform's safety net, applies the approved lines (stopping at the first
 * error), runs the verify commands through the guard and leaves the change waiting for the user.
 * The model states its verified / not-verified judgement with `report_verification` (`judge`);
 * only the user confirms or rolls back (`act`, from the card over IPC). A timer net (Junos commit
 * confirmed, EOS commit timer) rolls back on the device by itself: Hopline checks with a guarded
 * read when the timer is due, and before every confirm, and reports it.
 *
 * Every line is audited. The net's own lines (arm, commit under a timer, confirm, rollback, the
 * checks) are app-owned: source `safety-net`, sent in a `net` verdict that the session host checks
 * against the platform's fixed templates (cli-model safety-net.ts). They are never reachable from
 * the model: the agent's tools never pass `net`, and the deny-list still blocks these commands for
 * the agent. A change outlives the tool call and the run: its card stays actionable after the run
 * ends. Read-only mode refuses confirm and rollback too (client.exec refuses any non-read send);
 * a timer net then rolls back on the device.
 *
 * The card and the audit never claim a state the device is not shown to be in (Phase 5 safety
 * review H1-H3): one open change per session at a time (a second one could be undone by the
 * first one's rollback), a timer net's state is read before and after every confirm or rollback
 * (bound to this change's own commit comment / session name), and wherever Hopline cannot read
 * it, the change says "state unknown — check the device" (phase `unknown`, audited `unknown`)
 * instead of reporting success.
 */

/** The words every unverifiable state carries, on the card, in the audit and for the model. */
export const STATE_UNKNOWN = 'State unknown — check the device'
/** While a change is open, no other change can start on its session (H1): how to get out. */
const LOCK_HINT = 'No other change can be proposed on this device until this one is confirmed, rolled back or its tab is closed.'

/** How long `report_verification` waits for the user on a change without a device timer. */
export const DECISION_WAIT_MS = 15 * 60_000
/** After a timer net's deadline, wait this long before checking the device. */
export const EXPIRY_GRACE_MS = 10_000
/** An unreadable expiry check is retried after 15 s, doubling up to this. */
export const EXPIRY_RETRY_MAX_MS = 5 * 60_000
/** Verify output shown on the card, per command (redacted). */
const CARD_OUTPUT_CHARS = 3000

export interface ChangesDeps {
  term: TabControl
  settings: Pick<SettingsService, 'get'>
  audit: Pick<AuditLog, 'append'>
  emit: (e: AgentEventBody) => void
}

export interface ApprovedChange {
  proposalId: string
  runId: string
  tab: TermTab
  platform: PlatformId
  /** The approved lines (the ticked subset, in order). */
  commands: string[]
  checked: CheckedProposal
  /** The proposal's rollback lines, checked as config in the platform's plain session. */
  rollback: string[]
  /** Undefined when there are no rollback lines (a suggest-mode change). */
  rollbackChecked?: CheckedProposal
  verify: { command: string; expect: string }[]
  /** The device net, or undefined: the rollback lines are the undo. */
  net?: { spec: SafetyNetSpec; name: string; minutes: number }
  info: ChangeNet
  /** The device hostnames the approval is bound to. */
  hosts: string[]
  /** Disruptive lines: the hostname the user typed. */
  ack?: string
  approver: string
  /** Not every line was approved (the rollback lines were written for all of them). */
  subset: boolean
  /** From suggest mode: the model gave no rollback plan or verify commands and cannot judge. */
  suggested?: boolean
}

/** The change has an undo: a device net, or rollback lines. */
const canRollBack = (c: ApprovedChange) => !!c.net || (c.rollback.length > 0 && !!c.rollbackChecked)

type Outcome = 'confirmed' | 'rolled-back' | 'expired' | 'unknown'

interface OpenChange {
  c: ApprovedChange
  phase: ChangePhase
  /** IOS-XE: the archive file the device chose. */
  snapshot?: string
  /** Timer nets: epoch ms the device rolls back, stamped when the commit line is sent (L2). */
  deadline?: number
  timer?: ReturnType<typeof setTimeout>
  /** Unreadable expiry checks in a row (backoff). */
  misses: number
  judgement?: { verified: boolean; summary: string }
  verify: NonNullable<ChangeUpdate['verify']>
  partial: boolean
  busy: boolean
  waiters: ((o: Outcome) => void)[]
}

export const VerificationInput = z
  .object({
    verified: z.boolean(),
    summary: z.string().trim().min(1).max(2000)
  })
  .strict()

/** `act` sent nothing because the change's state could not be read; the change is already in `unknown`. */
class StateUnknown extends Error {}

const failedBy = (patterns: readonly RegExp[] | undefined, text: string) => !!patterns?.some((re) => re.test(text))

export class Changes {
  private open = new Map<string, OpenChange>()

  constructor(private readonly d: ChangesDeps) {}

  private base(tab: TermTab) {
    return { sessionId: tab.session.id, sessionName: tab.session.name, host: tab.session.host }
  }

  /**
   * The change open on this session, if any (H1): a second change is refused while one is applying
   * or waiting, because rolling back the first (Junos `rollback 1`, IOS-XE `configure replace`, an
   * NX-OS checkpoint) would also undo the second, and confirming one could commit the other. A
   * change whose tab closed no longer counts: its card cannot act any more.
   */
  activeOn(sessionId: string): { proposalId: string; commands: string[]; phase: ChangePhase } | undefined {
    for (const o of this.open.values())
      if (o.c.tab.session.id === sessionId && this.d.term.get(o.c.tab.tabId)) return { proposalId: o.c.proposalId, commands: o.c.commands, phase: o.phase }
    return undefined
  }

  private update(o: OpenChange, u: Partial<ChangeUpdate> = {}): void {
    const live = this.open.get(o.c.proposalId) === o && (o.phase === 'awaiting' || o.phase === 'unknown')
    const actions: ('confirm' | 'rollback')[] = live ? (canRollBack(o.c) ? ['confirm', 'rollback'] : ['confirm']) : []
    this.d.emit({
      type: 'change',
      runId: o.c.runId,
      tabId: o.c.tab.tabId,
      proposalId: o.c.proposalId,
      phase: o.phase,
      net: o.c.info,
      ...(o.deadline ? { deadline: o.deadline } : {}),
      verify: o.verify,
      ...(o.judgement ? { judgement: o.judgement } : {}),
      partial: o.partial,
      actions,
      ...(o.c.suggested && o.phase === 'awaiting' ? { message: 'Suggest mode: the model cannot check its own change. Read the output and decide.' } : {}),
      ...u
    })
  }

  /** A summary audit row for a step of the flow (armed, verified, confirmed, rolled back, expired). */
  private note(c: ApprovedChange, command: string, decision: 'executed' | 'refused' | 'error' | 'verified' | 'not-verified' | 'confirmed' | 'rolled-back' | 'expired' | 'unknown', reason: string, approver: string | null, source: 'agent' | 'safety-net' = 'safety-net'): void {
    this.d.audit.append({ ...this.base(c.tab), source, command, kind: 'config', decision, reason, approver, durationMs: null, bytes: null, redactions: null, runId: c.runId })
  }

  private opts(signal?: AbortSignal) {
    const s = this.d.settings.get()
    return { timeoutMs: s.commandTimeoutMs, capBytes: s.outputCapBytes, ...(signal ? { signal } : {}) }
  }

  /** One app-owned net line (config verdict marked `net`), audited with source `safety-net`. */
  private async netLine(c: ApprovedChange, line: string, approver: string, signal?: AbortSignal): Promise<{ r: ExecResult; ok: boolean; text: string }> {
    const r = await this.d.term.exec(c.tab, line, 'config', { ...this.opts(signal), allowConfig: true, hosts: c.hosts, net: true })
    return this.recordNet(c, line, 'config', r, approver, c.net?.spec.actionFailed)
  }

  /** A read the net flow runs itself (IOS-XE `show archive`, the timer checks): guarded like any read. */
  private async netRead(c: ApprovedChange, command: string, signal?: AbortSignal): Promise<{ r: ExecResult; ok: boolean; text: string }> {
    const v = classify(command, c.platform as Platform)
    if (v.kind !== 'read') {
      const reason = `refused: "${command}" is not read-only (${v.reason})`
      this.d.audit.append({ ...this.base(c.tab), source: 'safety-net', command, kind: v.kind, decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null, runId: c.runId })
      return { r: { status: 'error', output: '', durationMs: 0, bytes: 0, error: reason }, ok: false, text: reason }
    }
    const r = await this.d.term.exec(c.tab, v.command, 'read', this.opts(signal))
    return this.recordNet(c, v.command, 'read', r, null)
  }

  private recordNet(c: ApprovedChange, command: string, kind: 'read' | 'config', r: ExecResult, approver: string | null, failed?: readonly RegExp[]): { r: ExecResult; ok: boolean; text: string } {
    // Escapes, invisible characters and frame tags out, then redaction (agent/untrusted.ts).
    const red = untrustedText(r.output)
    const text = red.text
    const ok = r.status === 'ok' && (kind === 'read' || (deviceError(c.platform, r.output) === null && !failedBy(failed, text)))
    const decision = r.status === 'ok' ? 'executed' : r.status === 'error' ? 'error' : r.status
    this.d.audit.append({
      ...this.base(c.tab),
      source: 'safety-net',
      command,
      kind,
      decision,
      reason: r.error ?? (ok ? `safety net (${c.info.label})` : `safety net (${c.info.label}): the device reported an error`),
      approver,
      durationMs: r.durationMs,
      bytes: r.bytes,
      redactions: red.count,
      runId: c.runId
    })
    return { r, ok, text: r.error ? `${r.error}\n${text}`.trim() : text }
  }

  /**
   * Arm, apply, verify. Returns the tool result for the model. A change that is (even partly) live
   * stays open for the user's confirm or rollback.
   */
  async apply(ctx: ChangeContext, c: ApprovedChange): Promise<ToolResult> {
    const { runId, signal } = ctx
    const o: OpenChange = { c, phase: 'applying', verify: [], partial: false, busy: true, waiters: [], misses: 0 }
    // H1: checked again here, synchronously before the change is registered (two cards may have
    // been approved one after the other; the check before the card cannot see the later one).
    const other = this.activeOn(c.tab.session.id)
    if (other) {
      const message = `Another change is open on this device ("${other.commands[0] ?? ''}"${other.commands.length > 1 ? ' …' : ''}): confirm or roll it back on its card first. Nothing was sent.`
      for (const line of c.commands) this.d.audit.append({ ...this.base(c.tab), source: 'agent', command: line, kind: 'config', decision: 'refused', reason: message, approver: c.approver, durationMs: null, bytes: null, redactions: null, runId })
      o.phase = 'failed'
      this.update(o, { message })
      return { text: `REFUSED: ${message} Propose this change again after the user has decided on the open one.`, isError: true }
    }
    this.open.set(c.proposalId, o)
    this.update(o)
    const transcript: string[] = []
    const step = (command: string, r: ExecResult, text: string, ok: boolean, stepId: string) => {
      const preview = text.length > 4000 ? text.slice(0, 4000) + '\n…' : text
      const status: StepStatus = r.status === 'ok' ? (ok ? 'ok' : 'error') : r.status
      this.d.emit({ type: 'step', runId, stepId, command, status, kind: 'config', durationMs: r.durationMs, bytes: r.bytes, preview, reason: r.error ?? (ok ? undefined : 'the device reported an error') })
    }
    const fail = (message: string): ToolResult => {
      o.phase = 'failed'
      o.busy = false
      this.open.delete(c.proposalId)
      this.update(o, { message })
      return { text: `NOT APPLIED: ${message}\n\n${transcript.join('\n\n')}`.trim(), isError: true }
    }

    // 1. Arm the net (exec-mode snapshot lines; IOS-XE learns the archive file the device chose).
    const net = c.net
    if (net) {
      const before = net.spec.learn ? await this.netRead(c, net.spec.learn.command, signal) : undefined
      // L5: the "before" read must work, or a silent arm failure would look like a new snapshot.
      if (before && !before.ok) return fail(`"${net.spec.learn!.command}" failed before arming the ${c.info.label} safety net, so nothing was changed`)
      const prev = before ? net.spec.learn!.parse(before.text) : null
      for (const line of net.spec.arm(net.name)) {
        const stepId = randomUUID()
        this.d.emit({ type: 'step', runId, stepId, command: line, status: 'running', kind: 'config' })
        const r = await this.netLine(c, line, c.approver, signal)
        const ok = r.ok && !failedBy(net.spec.armFailed, r.text)
        step(line, r.r, r.text, ok, stepId)
        transcript.push(this.framed(c, line, r.text))
        if (!ok) return fail(`the ${c.info.label} safety net could not be armed ("${line}" failed), so nothing was changed. Propose again with safety_net "rollback_lines" if the user accepts the rollback lines as the only undo`)
      }
      if (net.spec.learn) {
        const after = await this.netRead(c, net.spec.learn.command, signal)
        const file = after.ok ? net.spec.learn.parse(after.text) : null
        if (!file || !archiveSucceeds(prev, file)) return fail(`the device did not report a new ${c.info.label} snapshot after "${net.spec.arm(net.name).join('", "')}", so nothing was changed. Propose again with safety_net "rollback_lines" if the user accepts the rollback lines as the only undo`)
        o.snapshot = file
      }
    }

    // 2. Apply the approved lines, wrapped for the platform (and the net's session); stop at the first error.
    const settings = this.d.settings.get()
    const opts = { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes, signal, allowConfig: true, hosts: c.hosts, ...(c.ack ? { ack: c.ack } : {}) }
    let sid = ''
    let lastNet = false
    const run = await runConfig(
      {
        platform: c.platform,
        exec: (line, kind, isNet) => {
          lastNet = !!isNet
          this.d.emit({ type: 'step', runId, stepId: (sid = randomUUID()), command: line, status: 'running', kind })
          if (kind === 'read') {
            const v = classify(line, c.platform as Platform)
            if (v.kind !== 'read') return Promise.resolve({ status: 'error' as const, output: '', durationMs: 0, bytes: 0, error: `refused: "${line}" is not read-only (${v.reason})` })
            return this.d.term.exec(c.tab, line, kind, { timeoutMs: opts.timeoutMs, capBytes: opts.capBytes, signal })
          }
          // L2: a timer starts on the device when its commit line runs, so the deadline is stamped
          // as the line is sent, not after the verify reads.
          if (isNet && net?.spec.timer && c.checked.plan.commit.includes(line)) o.deadline = Date.now() + net.minutes * 60_000
          return this.d.term.exec(c.tab, line, kind, isNet ? { ...opts, net: true } : opts)
        },
        report: (line, kind, r) => {
          if (!lastNet) return ctx.report(sid, line, kind, r, c.approver).text
          const n = this.recordNet(c, line, 'config', r, c.approver)
          step(line, r, n.text, n.ok, sid)
          return this.framed(c, line, n.text)
        },
        prompt: () => this.d.term.prompt(c.tab)
      },
      c.checked,
      c.commands
    )
    transcript.push(...run.transcript)
    const where = run.atExec ? '' : ` WARNING: the session is still in ${run.endMode} mode, not at the exec prompt.`
    // M2: from here on the change is bound to the device the prompt shows (the hostname it had, or
    // one an approved line set), not to every name a proposed line mentioned.
    if (run.applied || run.partial || run.uncertain) await this.narrowHosts(c)

    // H3: a commit was sent and did not report back. Never "nothing was changed": read the net's
    // state, or leave the change open as unknown with its undo offered.
    if (run.uncertain) {
      const why = run.reason ?? 'the commit did not report back'
      // The check is an exec-mode read; in configuration mode it would read something else.
      const s = net?.spec.check && run.atExec ? await this.netState(o) : null
      if (s?.state === 'pending') {
        if (run.atExec) return this.verifyAndAwait(o, ctx, transcript, `APPLIED (approved by ${c.approver}): ${why}, but the device shows this change's commit waiting for confirmation.`)
        return this.await(o, ctx, `APPLIED (approved by ${c.approver}): ${why}, but the device shows this change's commit waiting for confirmation.${where} The verify commands were not run.`, transcript)
      }
      if (s?.state === 'rolled-back' || s?.absent) return fail(`${why}; "${net!.spec.check!.command}" shows this change's commit is not on the device, so nothing was changed.${where}`)
      const message = `${STATE_UNKNOWN}: ${why}${s ? ` and the device's state could not be read (${s.why})` : ''}. The change may be live.${where}${run.atExec ? '' : ' Leave configuration mode by hand; Confirm and Roll back check the device first.'}`
      this.note(c, c.commands[0] ?? '(change)', 'unknown', message, null)
      return this.await(
        o,
        ctx,
        `UNCERTAIN (approved by ${c.approver}): ${message} Do not tell the user it was not applied. The verify commands were not run. The user checks the device and confirms or rolls back from the card.`,
        transcript,
        message
      )
    }

    if (!run.applied) {
      if (!run.partial) {
        // Nothing is live (a candidate was discarded, or nothing was typed): remove the snapshot.
        if (net?.spec.cleanup) for (const line of net.spec.cleanup(net.name)) await this.netLine(c, line, c.approver, signal)
        return fail(`${run.reason ?? 'a line failed'}. Nothing was changed.${where}`)
      }
      // Stopped at the first error with lines already live: the user rolls back or keeps them.
      o.partial = true
      return this.await(o, ctx, `PARTIALLY APPLIED, stopped at the first error (approved by ${c.approver}). Reason: ${run.reason ?? 'a line failed'}.${where} The lines before it are live. The verify commands were not run. The user can roll back (${this.undoText(o)}) or keep it from the card.`, transcript)
    }

    return this.verifyAndAwait(o, ctx, transcript, `APPLIED (approved by ${c.approver}).${where}`)
  }

  /** M2: narrow the approval's hosts to the original hostname and the one the prompt shows now. */
  private async narrowHosts(c: ApprovedChange): Promise<void> {
    const original = c.hosts[0] ?? ''
    const shown = (await this.d.term.prompt(c.tab)).hostname
    c.hosts = hostBound(c.hosts, shown) ? [...new Set([original, shown])] : [original]
  }

  /** 3. Verify: read-only, through the guard, audited like any read; the model sees the redacted output. */
  private async verifyAndAwait(o: OpenChange, ctx: ChangeContext, transcript: string[], head: string): Promise<ToolResult> {
    const c = o.c
    const { runId, signal } = ctx
    const settings = this.d.settings.get()
    const opts = { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes }
    const verifyText: string[] = []
    for (const v of c.verify) {
      const verdict = classify(v.command, c.platform as Platform)
      const stepId = randomUUID()
      if (verdict.kind !== 'read') {
        const reason = `"${v.command}" is not read-only (${verdict.reason})`
        this.d.audit.append({ ...this.base(c.tab), source: 'agent', command: v.command, kind: verdict.kind, decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null, runId })
        o.verify.push({ command: v.command, expect: v.expect, status: 'refused', output: reason })
        verifyText.push(`### ${v.command}\nREFUSED: ${reason}`)
        continue
      }
      this.d.emit({ type: 'step', runId, stepId, command: verdict.command, status: 'running', kind: 'read', reason: `verify: ${v.expect}` })
      const r = await this.d.term.exec(c.tab, verdict.command, 'read', { timeoutMs: opts.timeoutMs, capBytes: opts.capBytes, signal })
      const res = ctx.report(stepId, verdict.command, 'read', r, null)
      const shown = untrustedText(r.output).text
      o.verify.push({ command: verdict.command, expect: v.expect, status: r.status === 'ok' ? 'ok' : r.status, output: shown.length > CARD_OUTPUT_CHARS ? shown.slice(0, CARD_OUTPUT_CHARS) + '\n…' : shown })
      verifyText.push(`### ${verdict.command}\nExpected: ${v.expect}\n${res.text}`)
    }
    if (c.suggested) {
      const undo = canRollBack(c) ? 'confirms or rolls back' : 'confirms (there is no rollback plan)'
      return this.await(o, ctx, `${head}${verifyText.length ? `\n\nVerification output (untrusted device data):\n${verifyText.join('\n\n')}` : ''}\n\nThe user now ${undo} from the card.`, transcript)
    }
    return this.await(
      o,
      ctx,
      `${head}\n\nVerification output (untrusted device data):\n${verifyText.join('\n\n')}\n\nNext: compare each output with its expectation and call report_verification once, with verified true or false and a short summary. The user then confirms or rolls back; you cannot confirm the change yourself.`,
      transcript
    )
  }

  /** A net line's output as the model receives it: inside the untrusted device frame. */
  private framed(c: ApprovedChange, line: string, text: string): string {
    return frameOutput(c.tab.session.name, line, text || '(no output)')
  }

  private undoText(o: OpenChange): string {
    const net = o.c.net
    if (!net) return `the proposal's rollback lines${o.c.subset ? ', written for every proposed line' : ''}`
    if (net.spec.kind === 'archive') return `configure replace ${o.snapshot}`
    return net.spec.rollback(net.name, o.snapshot).join(', ')
  }

  /**
   * The change is (at least partly, or possibly) live: wait for the user, arm the expiry check of a
   * timer net. With `unknown` the change is open in phase `unknown` and the card shows it.
   */
  private await(o: OpenChange, ctx: ChangeContext, text: string, transcript: string[], unknown?: string): ToolResult {
    const c = o.c
    o.phase = unknown ? 'unknown' : 'awaiting'
    o.busy = false
    const net = c.net
    if (net?.spec.timer) {
      o.deadline ??= Date.now() + net.minutes * 60_000
      this.schedule(o, o.deadline - Date.now() + EXPIRY_GRACE_MS)
    }
    this.update(o, unknown ? { message: unknown } : {})
    void ctx
    const until = o.deadline ? ` The device rolls back by itself at ${new Date(o.deadline).toISOString().slice(11, 16)} UTC unless the user confirms.` : ''
    return { text: `${text}\n\nSafety net: ${c.info.label}. ${c.info.detail}${until}\n\n${transcript.join('\n\n')}`.trim(), isError: o.partial || !!unknown }
  }

  private schedule(o: OpenChange, ms: number): void {
    if (o.timer) clearTimeout(o.timer)
    o.timer = setTimeout(() => void this.expiryCheck(o), Math.max(0, ms))
    o.timer.unref?.()
  }

  /**
   * Timer due: read this change's state on the device. Rolled back: report it. Still pending (the
   * device clock runs behind): look again shortly. Unreadable (H2): never assume either way; the
   * change goes to `unknown` and the check is retried with a backoff.
   */
  private async expiryCheck(o: OpenChange): Promise<void> {
    if (this.open.get(o.c.proposalId) !== o || (o.phase !== 'awaiting' && o.phase !== 'unknown')) return
    if (o.busy) return this.schedule(o, 5_000)
    const tab = this.d.term.get(o.c.tab.tabId)
    if (!tab) return this.finish(o, 'unknown', `The confirm timer expired after the session closed, so Hopline Terminal could not check the device. ${STATE_UNKNOWN}: it should have rolled the change back by itself.`, null)
    o.busy = true
    let s: { state: NetState; why: string }
    try {
      s = await this.netState(o)
    } finally {
      o.busy = false
    }
    if (this.open.get(o.c.proposalId) !== o) return
    if (s.state === 'rolled-back') return this.finish(o, 'expired', `The confirm timer expired: the device rolled the change back by itself (checked with "${o.c.net!.spec.check!.command}").`, null)
    if (s.state === 'pending') {
      // Readable again and still waiting: back to the normal countdown.
      if (o.phase === 'unknown') {
        o.phase = 'awaiting'
        o.misses = 0
        this.update(o, { message: 'The device answers again: the change still waits for your decision.' })
      }
      return this.schedule(o, 15_000)
    }
    o.misses++
    const wait = Math.min(EXPIRY_RETRY_MAX_MS, 15_000 * 2 ** (o.misses - 1))
    const message = `${STATE_UNKNOWN}: the confirm timer is due, but Hopline Terminal could not read the change's state on the device (${s.why}). It checks again in ${Math.round(wait / 1000)} s. ${LOCK_HINT}`
    if (o.phase !== 'unknown') this.note(o.c, o.c.commands[0] ?? '(change)', 'unknown', message, null)
    o.phase = 'unknown'
    this.update(o, { message })
    this.schedule(o, wait)
  }

  /** Timer nets: this change's state as the device shows it, and why when it is unknown. Never takes the run's signal. */
  private async netState(o: OpenChange): Promise<{ state: NetState; why: string; absent?: boolean }> {
    const check = o.c.net?.spec.check
    if (!check) return { state: 'unknown', why: 'this safety net has no state check' }
    const r = await this.netRead(o.c, check.command)
    if (!r.ok) return { state: 'unknown', why: `"${check.command}" ${r.r.error ? `failed: ${r.r.error}` : `returned ${r.r.status}`}` }
    // r.ok: the read ended at the device prompt (status ok, not capped), so a missing row is meaningful.
    const state = check.state(r.text, o.c.net!.name, r.r.status === 'ok')
    return { state, why: state === 'unknown' ? `"${check.command}" does not show this change as pending, confirmed or rolled back` : '', ...(check.absent?.(r.text, o.c.net!.name) ? { absent: true } : {}) }
  }

  private finish(o: OpenChange, outcome: Outcome, message: string, approver: string | null): void {
    if (o.timer) clearTimeout(o.timer)
    o.phase = outcome
    o.busy = false
    this.open.delete(o.c.proposalId)
    this.note(o.c, o.c.commands[0] ?? '(change)', outcome, message, approver)
    this.update(o, { message })
    for (const w of o.waiters.splice(0)) w(outcome)
  }

  /**
   * The user's confirm or rollback from the card. Throws a message for the card when it cannot run
   * (closed, busy, read-only, the device changed, its state unreadable); the change then stays open.
   * Every refusal is audited (L10).
   */
  async act(proposalId: string, action: 'confirm' | 'rollback'): Promise<void> {
    const o = this.open.get(proposalId)
    if (!o || (o.phase !== 'awaiting' && o.phase !== 'unknown')) throw new Error('This change is no longer waiting for a decision')
    if (o.busy) throw new Error('Hopline Terminal is still working on this change')
    // L1: taken before the first await, so a second click (or the expiry check) cannot run alongside.
    o.busy = true
    const was = o.phase
    const c = o.c
    const approver = userInfo().username
    const verb = action === 'confirm' ? 'confirm' : 'roll back'
    const refuse = (reason: string, shown = reason): never => {
      o.busy = false
      o.phase = was
      this.note(c, `(${verb})`, 'refused', reason, approver)
      throw new Error(shown)
    }
    if (action === 'rollback' && !canRollBack(c)) refuse('this change has no rollback plan and no device safety net', 'This change has no rollback plan and no device safety net: there is nothing Hopline Terminal can roll back with')
    if (this.d.settings.get().aiReadOnly)
      refuse(
        `read-only mode is on, so the ${verb} was not sent${c.net?.spec.timer ? '; the device rolls back by itself when its timer expires' : ''}`,
        `Read-only mode is on: Hopline Terminal sends nothing but show commands, so it cannot ${verb} this change.${c.net?.spec.timer ? ' The device rolls back by itself when its timer expires.' : ''}`
      )
    if (!this.d.term.get(c.tab.tabId)) refuse(`the session is closed, so the ${verb} was not sent`, 'The session is closed')
    let now: Awaited<ReturnType<TabControl['prompt']>>
    try {
      now = await this.d.term.prompt(c.tab)
    } catch (e) {
      return refuse(`the device prompt could not be read (${e instanceof Error ? e.message : String(e)})`)
    }
    if (!hostBound(c.hosts, now.hostname)) {
      const reason = `the device changed since the approval: the prompt shows "${now.hostname || '(no hostname)'}" (a nested ssh/telnet session?)`
      refuse(reason, `Not sent: ${reason}`)
    }
    if (now.mode !== 'exec' && now.mode !== 'user') refuse(`the session is in ${now.mode} mode, so the ${verb} was not sent`, `The session is in ${now.mode} mode; leave configuration mode first`)
    o.phase = action === 'confirm' ? 'confirming' : 'rolling-back'
    this.update(o)
    const net = c.net
    const check = net?.spec.timer ? net.spec.check : undefined
    try {
      // A timer net: read THIS change's state first (H2). Rolled back: say so. Unreadable or not
      // ours: send nothing ("confirmed" or "rolled back" must never hide an unknown state).
      if (check) {
        const s = await this.netState(o)
        if (s.state === 'rolled-back') return this.finish(o, 'expired', `The confirm timer had already expired: the device rolled the change back by itself (checked with "${check.command}"). Nothing was sent.`, null)
        if (s.state !== 'pending') return this.stillUnknown(o, approver, `Not ${action === 'confirm' ? 'confirmed' : 'rolled back'}: Hopline Terminal could not verify the change's state on the device (${s.why}), so it sent nothing. ${STATE_UNKNOWN}.`)
      }
      let failure: string | undefined
      const lines = action === 'confirm' ? (net?.spec.confirm(net.name) ?? []) : net ? net.spec.rollback(net.name, o.snapshot) : null
      if (lines === null) {
        // No device net: the proposal's rollback lines, wrapped like any change (guarded config lines).
        const r = await this.rollbackLines(o, approver)
        if (!r.ok) failure = `Rollback stopped: ${r.reason}. Check the device.`
      } else {
        for (const line of lines) {
          const r = await this.netLine(c, line, approver)
          if (!r.ok) {
            failure = `"${line}" failed: ${r.r.error ?? r.text.split('\n').slice(-3).join(' ').trim()}`
            break
          }
        }
      }
      if (check) {
        // Read the state again: the action must show on the device (H2, L2, L10).
        const s = await this.netState(o)
        const want = action === 'confirm' ? 'confirmed' : 'rolled-back'
        if (s.state === want) {
          const done = action === 'confirm' ? `Confirmed by ${approver}: the change is kept (checked with "${check.command}").` : `Rolled back by ${approver}: the ${c.info.label} undid the change (checked with "${check.command}").`
          return this.finish(o, want, done, approver)
        }
        if (action === 'confirm' && s.state === 'rolled-back')
          return this.finish(o, 'expired', `The device timer expired before the confirm took: the device rolled the change back by itself, and it is NOT in effect (checked with "${check.command}").`, approver)
        if (s.state === 'pending') return this.reopen(o, `${failure ?? `The ${verb} was sent`}, but the device still waits for confirmation: the change is live until its timer expires.`, 'awaiting')
        // Lines were sent and the result cannot be read: nothing more is sent for this change.
        return this.finish(o, 'unknown', `${failure ? `${failure}. ` : `The ${verb} was sent, but `}Hopline Terminal could not verify the result (${s.why || `the device shows it ${s.state}`}). ${STATE_UNKNOWN}.`, approver)
      }
      // Without a read the phase it had stays (an `unknown` change does not become "applied").
      if (failure) return this.reopen(o, failure, was)
      if (net?.spec.cleanup) for (const line of net.spec.cleanup(net.name)) await this.netLine(c, line, approver)
      if (was === 'unknown' && action === 'confirm')
        return this.finish(o, 'unknown', `Closed by ${approver} without a device check: Hopline Terminal never saw whether the change reached the device. ${STATE_UNKNOWN}.`, approver)
      // No read checks a checkpoint, archive or rollback-lines undo: say what ran, not what the device holds (L10).
      const done =
        action === 'confirm'
          ? `Confirmed by ${approver}: the change is kept.`
          : `Rolled back by ${approver}: ${net ? `"${(lines ?? []).join('", "')}" (${c.info.label}) ran` : 'the rollback lines ran'} without a device error. Hopline Terminal did not read the configuration back.`
      return this.finish(o, action === 'confirm' ? 'confirmed' : 'rolled-back', done, approver)
    } catch (e) {
      if (!(e instanceof StateUnknown)) this.reopen(o, e instanceof Error ? e.message : String(e), was)
      throw e
    }
  }

  /** Nothing was sent: the change stays open in `unknown`; the card offers the actions again (they re-check). */
  private stillUnknown(o: OpenChange, approver: string, message: string): never {
    message = `${message} ${LOCK_HINT}`
    o.phase = 'unknown'
    o.busy = false
    this.note(o.c, o.c.commands[0] ?? '(change)', 'unknown', message, approver)
    this.update(o, { message })
    throw new StateUnknown(message)
  }

  private reopen(o: OpenChange, message: string, phase: 'awaiting' | 'unknown'): void {
    o.phase = phase
    o.busy = false
    this.note(o.c, `(${message.slice(0, 60)})`, 'error', message, null)
    this.update(o, { message })
  }

  /**
   * The proposal's rollback lines. A disruptive line carries the typed confirmation as the hostname
   * the prompt shows when it is typed, if that is a name the approval is bound to (L6: after an
   * approved rename, or a rollback line that renames back, the name the user typed would be refused).
   */
  private async rollbackLines(o: OpenChange, approver: string): Promise<{ ok: boolean; reason?: string }> {
    const c = o.c
    const settings = this.d.settings.get()
    const opts = { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes, allowConfig: true, hosts: c.hosts, ...(c.ack ? { ack: c.ack } : {}) }
    const run = await runConfig(
      {
        platform: c.platform,
        exec: (line, kind: LineKind | 'read') => {
          if (kind === 'read') {
            const v = classify(line, c.platform as Platform)
            if (v.kind !== 'read') return Promise.resolve({ status: 'error' as const, output: '', durationMs: 0, bytes: 0, error: `refused: "${line}" is not read-only (${v.reason})` })
            return this.d.term.exec(c.tab, line, 'read', { timeoutMs: opts.timeoutMs, capBytes: opts.capBytes })
          }
          if (kind !== 'disruptive' || !c.ack) return this.d.term.exec(c.tab, line, kind, opts)
          return this.d.term.prompt(c.tab).then((p) => this.d.term.exec(c.tab, line, kind, { ...opts, ack: p.hostname && hostBound(c.hosts, p.hostname) ? p.hostname : c.ack }))
        },
        report: (line, kind, r) => this.recordNet(c, line, kind === 'read' ? 'read' : 'config', r, approver).text,
        prompt: () => this.d.term.prompt(c.tab)
      },
      c.rollbackChecked!,
      c.rollback
    )
    return run.applied ? { ok: true } : { ok: false, reason: run.reason ?? 'a rollback line failed' }
  }

  /** `report_verification`: the model's judgement, then wait for the user's decision. */
  async judge(ctx: ChangeContext, input: unknown): Promise<ToolResult> {
    const parsed = VerificationInput.safeParse(input)
    if (!parsed.success) return { text: `ERROR: invalid report_verification: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`, isError: true }
    const o = [...this.open.values()].reverse().find((x) => x.c.runId === ctx.runId && x.c.tab.tabId === ctx.tab.tabId)
    if (!o || (o.phase !== 'awaiting' && o.phase !== 'unknown' && o.phase !== 'confirming' && o.phase !== 'rolling-back')) return { text: 'ERROR: no applied change of this run is waiting for verification.', isError: true }
    if (o.judgement) return { text: 'ERROR: the verification was already reported for this change.', isError: true }
    const summary = redact(parsed.data.summary).text
    o.judgement = { verified: parsed.data.verified, summary }
    this.note(o.c, 'report_verification', parsed.data.verified ? 'verified' : 'not-verified', summary.slice(0, 500), null, 'agent')
    this.update(o)
    const wait = o.deadline ? Math.max(0, o.deadline - Date.now()) + EXPIRY_GRACE_MS + 15_000 : DECISION_WAIT_MS
    const outcome = await new Promise<Outcome | 'waiting' | 'cancelled'>((resolve) => {
      const t = setTimeout(() => resolve('waiting'), wait)
      const onAbort = () => resolve('cancelled')
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      o.waiters.push((x) => {
        clearTimeout(t)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(x)
      })
    })
    switch (outcome) {
      case 'confirmed':
        return { text: 'The user CONFIRMED the change: it is kept.' }
      case 'rolled-back':
        return { text: 'The user ROLLED BACK the change: the device is back to its previous configuration.' }
      case 'expired':
        return { text: 'Nobody confirmed in time: the device rolled the change back by itself. The change is NOT in effect.' }
      case 'unknown':
        return { text: 'Hopline Terminal could not verify the state of the change on the device: state unknown. Tell the user to check the device; do not say whether the change is in effect.', isError: true }
      case 'cancelled':
        return { text: 'Run cancelled. The change is still waiting for the user\'s decision on the card.', isError: true }
      default:
        return { text: 'The user has not decided yet. The change is live; the card still offers confirm and rollback.' }
    }
  }

  /** Open changes (tests and the IPC contract). */
  pending(): string[] {
    return [...this.open.keys()]
  }

  /** Stop every timer (app quit). The devices keep their own timers. */
  dispose(): void {
    for (const o of this.open.values()) if (o.timer) clearTimeout(o.timer)
  }
}
