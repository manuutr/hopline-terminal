import { CONFIG_SESSIONS, netLineAllowed, type ConfigSession } from '@hopline/cli-model'
import { classify, classifyConfigLines, PLATFORM_LABELS, type Classification } from '@hopline/guard'
import { cleanTerminalText, promptState, configPlan, deviceError, isModelled, modeChangeLine, type AnyPlatform, type ConfigPlan } from '@shared/cli'
import type { ExecResultMsg as ExecResult, PromptInfo } from '@shared/host-protocol'

/**
 * Platform-aware wrapping and running of an approved configuration change: the profile's
 * configuration session (cli-model CONFIG_SESSIONS) says how to enter, commit, leave and discard,
 * so the agent has no per-vendor code. Kept apart from agent.ts so that file stays small.
 */

export type LineKind = 'config' | 'disruptive'

export interface CheckedProposal {
  plan: ConfigPlan
  verdicts: Classification[]
  /** Reasons of the lines the guard marks disruptive (they need a typed confirmation). */
  disruptive: string[]
  /**
   * Wrapper lines that belong to the safety net (EOS `configure session hopline-…`, `commit timer`,
   * Junos `commit confirmed N`): sent as app-owned net lines, never classified by the deny-list.
   * Never a proposal line.
   */
  netLines: string[]
}

export type ProposalRefusal = { decision: 'blocked' | 'refused'; reason: string; kind: string }

/** Validate a proposal against the guard and the platform's configuration model. */
export function checkProposal(
  platform: AnyPlatform,
  commands: readonly string[],
  ctx: { user?: string; net?: { session: ConfigSession; netLines: readonly string[] } } = {}
): CheckedProposal | ProposalRefusal {
  if (!isModelled(platform)) return { decision: 'refused', kind: 'config', reason: 'the device platform is unknown, so nothing can be classified; set the platform for this session first' }
  const label = PLATFORM_LABELS[platform]
  const plan = configPlan(platform, commands, { user: ctx.user, session: ctx.net?.session })
  if ('error' in plan) return { decision: 'refused', kind: 'config', reason: `${plan.error} (${label})` }
  // Safety-net wrapper lines are checked against the platform's fixed net templates instead of the
  // deny-list (the host does the same); each must be one of them, in the mode it is typed in.
  const netLines = [...(ctx.net?.netLines ?? [])]
  for (const line of netLines) {
    const mode = plan.before.includes(line) ? 'exec' : 'config'
    if (!netLineAllowed(platform, line, mode)) return { decision: 'refused', kind: 'config', reason: `"${line}" is not a safety-net line of ${label}` }
  }
  const isNet = (line: string) => netLines.includes(line)
  // The wrapper lines are classified too: a platform whose guard refuses them can't take changes.
  for (const line of plan.before) {
    if (isNet(line)) continue
    const v = classify(line, platform, { mode: 'exec' })
    if (v.kind === 'blocked' || v.kind === 'disruptive') return { decision: 'refused', kind: 'config', reason: `applying changes is not supported on ${label}: "${line}" is ${v.kind} (${v.reason})` }
  }
  // The pre-check (PAN-OS pending changes) must be a read command at the exec prompt.
  if (plan.precheck && classify(plan.precheck, platform, { mode: 'exec' }).kind !== 'read')
    return { decision: 'refused', kind: 'config', reason: `applying changes is not supported on ${label}: the pre-check "${plan.precheck}" is not read-only` }
  for (const line of [...plan.after, ...plan.abort]) {
    if (isNet(line)) continue
    const v = classify(line, platform, { mode: 'config-any' })
    if (v.kind === 'blocked' || v.kind === 'disruptive') return { decision: 'refused', kind: 'config', reason: `applying changes is not supported on ${label}: "${line}" is ${v.kind} (${v.reason})` }
  }
  // Lines are classified in order, in the sub-mode the previous lines entered (interface, router...).
  const verdicts = classifyConfigLines(commands, platform, plan.session.linesFrom)
  const disruptive: string[] = []
  for (const [i, c] of commands.entries()) {
    const v = verdicts[i]!
    if (v.kind === 'blocked') return { decision: 'blocked', kind: 'blocked', reason: `"${c}": ${v.reason}` }
    if (modeChangeLine(platform, c) || (v.leavesConfig && !plan.session.blocks))
      return { decision: 'refused', kind: 'config', reason: `"${c}": do not include mode-change commands; ${describeWrapper(plan)}` }
    if (v.kind === 'disruptive') disruptive.push(`"${c}": ${v.reason}`)
  }
  return { plan, verdicts, disruptive, netLines }
}

function describeWrapper(plan: ConfigPlan): string {
  const parts = [plan.before.length && `"${plan.before.join('", "')}" before`, plan.after.length && `"${plan.after.join('", "')}" after`].filter(Boolean)
  return parts.length ? `${parts.join(' and ')} are added automatically` : 'each line runs on its own from the exec prompt'
}

/** One line for the system prompt: how proposals are written on this platform. */
export function configHint(platform: AnyPlatform): string {
  if (!isModelled(platform)) return 'The platform of this device is not known yet: every command will be refused until the user sets it.'
  const s = CONFIG_SESSIONS[platform]
  if (s.blocks) return 'Configuration changes on this platform are "config <path>" … "end" blocks: propose whole blocks (with edit/set/next), nothing outside them.'
  if (!s.enter.length) return 'Configuration changes on this platform are single commands run from the exec prompt: propose them one per line.'
  const wrap = [`"${s.enter.join('", "')}"`, s.commit.length ? `"${s.commit.join('", "')}"` : '', s.exit.length ? `"${s.exit.join('", "')}"` : ''].filter(Boolean).join(' … ')
  return `Configuration changes on this platform are wrapped as ${wrap.replace(' … ', ' … <your lines> … ')}; propose only the lines in between.`
}

export interface RunDeps {
  platform: AnyPlatform
  /** `net`: a safety-net wrapper line (CheckedProposal.netLines), sent as an app-owned net line. */
  exec(line: string, kind: LineKind | 'read', net?: boolean): Promise<ExecResult>
  /** Record one executed line (audit + UI step); returns the text for the transcript. */
  report(line: string, kind: LineKind | 'read', r: ExecResult): string
  prompt(): Promise<PromptInfo>
}

export interface RunResult {
  /** Every line took effect (and was committed where the platform commits). */
  applied: boolean
  /** Lines already live on the device when a non-commit platform failed part-way. */
  partial: boolean
  /**
   * A commit line was sent and its outcome is not known (timeout, cancel, transport error), or the
   * leave failed after a commit: the change MAY be live. Never reported as "nothing was changed"
   * (Phase 5 review H3); the caller checks the device or leaves the change open as unknown.
   */
  uncertain?: boolean
  transcript: string[]
  /** What is left on the device that the user must look at. */
  leftover?: string
  /** Why it was not applied, in words for the user and the model. */
  reason?: string
  /** The session is back at the exec prompt at the end (false: it is still in configuration mode). */
  atExec: boolean
  /** The mode the prompt showed at the end. */
  endMode: PromptInfo['mode']
}

const matches = (patterns: readonly RegExp[] | undefined, text: string) => !!patterns?.some((re) => re.test(text))

/**
 * Run an approved change: (precheck,) enter, the lines (disruptive ones with the confirmation),
 * commit (only when the prompt allows it), leave. The first failure stops the sequence; then the
 * platform's discard lines run, so a commit-model device keeps nothing uncommitted where that is
 * possible. A failed commit or a failed leave is "not applied". Before each line the prompt must
 * still show configuration mode (the executor's capture and the device agree), and at the end the
 * session must be back at the exec prompt; if it is not, the result says so.
 */
export async function runConfig(d: RunDeps, checked: CheckedProposal, commands: readonly string[]): Promise<RunResult> {
  const { plan, verdicts } = checked
  const s = plan.session
  const transcript: string[] = []
  const output = (r: ExecResult) => cleanTerminalText(r.output)
  const failed = (r: ExecResult, extra?: readonly RegExp[]) => r.status !== 'ok' || deviceError(d.platform, r.output) !== null || matches(extra, output(r))
  const nets = new Set(checked.netLines)
  // Only wrapper lines may be net lines: a proposal line is never sent as one, whatever it says.
  const run = async (line: string, kind: LineKind | 'read', wrapper = false) => {
    const r = await d.exec(line, kind, wrapper && nets.has(line))
    transcript.push(`${line}\n${d.report(line, kind, r)}`)
    return r
  }
  const step = async (line: string, kind: LineKind, extra?: readonly RegExp[], wrapper = false) => !failed(await run(line, kind, wrapper), extra)
  const finish = async (res: Omit<RunResult, 'atExec' | 'endMode' | 'transcript'>): Promise<RunResult> => {
    const mode = (await d.prompt()).mode
    const atExec = mode === 'exec' || mode === 'user'
    const stuck = atExec ? '' : `the session is still in ${mode === 'unknown' ? 'an unrecognised' : mode} mode, not at the exec prompt: check it and leave configuration mode by hand`
    return { ...res, transcript, atExec, endMode: mode, ...(stuck ? { reason: res.reason ? `${res.reason}; ${stuck}` : stuck } : {}) }
  }
  let typed = 0
  // Lines wait for a commit (a candidate, or VRP two-stage `[~host]`): a failure leaves nothing live.
  let staged = s.candidate
  const wrapped = s.enter.length > 0
  const abort = async (reason: string, uncertain = false): Promise<RunResult> => {
    // Discard: run the abort lines; FortiOS blocks may be nested, so repeat while still in config.
    // Only while the device is still in configuration mode (a FortiOS `config …` that failed never opened).
    for (let round = 0; round < (s.blocks ? 4 : 1) && plan.abort.length; round++) {
      if ((await d.prompt()).mode !== 'config') break
      for (const line of plan.abort) await step(line, 'config')
    }
    return finish({ applied: false, partial: !staged && typed > 0, leftover: s.leftover, reason, ...(uncertain ? { uncertain } : {}) })
  }

  if (s.precheck && plan.precheck) {
    const r = await run(plan.precheck, 'read')
    if (failed(r)) return finish({ applied: false, partial: false, reason: `the pre-check "${plan.precheck}" failed, so nothing was changed` })
    // Anything printed besides the echoed command and the prompt is a pending change.
    const body = output(r)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith(plan.precheck!) && promptState(l, d.platform).mode === 'unknown')
      .join('\n')
    if (s.precheck.dirty.test(body)) return finish({ applied: false, partial: false, reason: s.precheck.message })
  }
  for (const line of plan.before) {
    // Configuration mode never opened: there is nothing to discard.
    const r = await run(line, 'config', true)
    const refused = s.enterRefused?.find((x) => x.re.test(output(r)))
    if (refused) return finish({ applied: false, partial: false, reason: refused.message })
    if (failed(r)) return finish({ applied: false, partial: false, reason: `"${line}" failed, so configuration mode was not entered` })
  }
  if (s.commitWhen && !staged) staged = s.commitWhen.test((await d.prompt()).prompt)
  for (const [i, line] of commands.entries()) {
    // Re-sync before each line: the device must still be in configuration mode.
    if (wrapped && (await d.prompt()).mode !== 'config') return abort(`the device left configuration mode before "${line}"`)
    const ok = await step(line, verdicts[i]!.kind === 'disruptive' ? 'disruptive' : 'config')
    if (!ok) return abort(`"${line}" failed`)
    typed++
  }
  const commit = !s.commitWhen || staged
  // Once a commit line was typed, a failure no longer proves "not committed": only a commit the
  // device answered with an error is a known failure. A timeout, a cancel or a transport error may
  // have committed it (a slow commit, Stop, a dropped tab), so the result is uncertain. The abort
  // lines still run: they only discard what is NOT committed (Junos `rollback 0` drops the
  // uncommitted candidate, never a commit) and are typed only while the prompt shows configuration
  // mode (EOS `commit timer` leaves the session, so its `abort` cannot reach a committed session).
  let committed = false
  for (const line of plan.commit) {
    if (!commit) break
    const r = await run(line, 'config', true)
    if (r.status !== 'ok') return abort(`"${line}" was sent but did not finish (${r.error ?? r.status}): the commit may have reached the device`, true)
    if (failed(r, s.commitFailed)) {
      // A later commit line failing after an earlier one went through: something is committed.
      if (committed) return finish({ applied: false, partial: false, uncertain: true, reason: `"${line}" failed after an earlier commit line went through` })
      return abort(`"${line}" failed: the change was not committed`)
    }
    committed = true
  }
  for (const line of s.exit) {
    const r = await run(line, 'config', true)
    if (failed(r, s.exitFailed)) {
      // The device says changes are still uncommitted (IOS-XR "Uncommitted changes found", Junos
      // "Exit with uncommitted changes?"): discard them (the abort lines only drop the uncommitted
      // candidate). After a commit line that answered without an error, what that commit did is
      // not known, so the result stays uncertain.
      if (staged && r.status === 'ok' && matches(s.exitFailed, output(r)))
        return committed ? abort(`"${line}" reported uncommitted changes after "${plan.commit.join('", "')}"; they were discarded, but the commit may have gone through`, true) : abort(`"${line}" did not leave cleanly: the change was not committed`)
      // Committed, then the leave failed otherwise: the change is (probably) live, the session may be stuck.
      if (committed) return finish({ applied: false, partial: false, uncertain: true, reason: `"${line}" failed after the commit: the change is probably live, but the session may still be in configuration mode` })
      // Still uncommitted on a commit platform, or the leave failed.
      if (staged) return abort(`"${line}" did not leave cleanly: the change was not committed`)
      return finish({ applied: false, partial: typed > 0, reason: `"${line}" failed after the lines were applied: they are live, but the session may still be in configuration mode` })
    }
  }
  return finish({ applied: true, partial: false })
}
