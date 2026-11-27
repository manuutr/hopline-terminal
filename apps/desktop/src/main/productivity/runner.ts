import { CONFIG_SESSIONS, getPlatform, resolve, type ModeId } from '@hopline/cli-model'
import { policyBlocked, type BlockRules } from '@shared/policy-deny'
import { classify, isPlatform, redact, type Classification, type Platform } from '@hopline/guard'
import { userInfo } from 'node:os'
import { changesMode, commandError, hostBound, hostnamesSetBy, promptUser, sameHost } from '@shared/cli'
import type { ExecResultMsg } from '@shared/host-protocol'
import type { CommandRunResult, LineKind, PlanKind, PlanLine } from '@shared/productivity'
import type { AuditRow } from '@shared/types'
import type { AuditLog } from '../db/audit'
import type { AgentTab, ExecKind, TabControl } from '../host/client'
import type { SettingsService } from '../settings'
import { checkProposal, runConfig, type CheckedProposal } from '../agent/config-apply'

/**
 * The guarded command runner for commands the user did not type: snippets, send-to-many and
 * multi-device runs. It is the agent's path without the model: guard v2 classification on the
 * session's platform, config wrapped and run with the platform's configuration session
 * (config-apply.ts), every write signed for the session host (which classifies it again), every
 * attempt audited, and every output redacted before it leaves main.
 *
 * Shapes:
 * - read: every line is read-only in exec mode; they run one after the other.
 * - exec: one exec-mode command the guard knows that changes state (`clear counters`, `clear ip
 *   bgp *`); needs confirmation, a disruptive one the typed hostname.
 * - config: configuration lines, wrapped for the platform (configure terminal … end, commit …).
 */
export type Source = 'snippet' | 'multi' | 'capture'
export type Shape = 'read' | 'exec' | 'config'

export const MAX_LINES = 50
/** Output kept for the renderer per run (after redaction). */
export const MAX_OUTPUT_CHARS = 64_000

export interface Analysis {
  kind: PlanKind
  reason: string
  shape?: Shape
  lines: PlanLine[]
  commands: string[]
  wrapper?: { before: string[]; after: string[] }
  checked?: CheckedProposal
}

/** Split a body into command lines: trimmed, blank lines dropped. Control characters are refused. */
export function splitLines(body: string): { lines: string[] } | { error: string } {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(body.replace(/\r\n/g, '\n'))) return { error: 'the command contains control characters' }
  const lines = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return { error: 'there is no command' }
  if (lines.length > MAX_LINES) return { error: `more than ${MAX_LINES} lines` }
  return { lines }
}

const refused = (reason: string, commands: string[], kind: PlanKind = 'refused'): Analysis => ({
  kind,
  reason,
  commands,
  lines: commands.map((c) => ({ command: c, kind: kind === 'blocked' ? 'blocked' : 'config', reason }))
})

/**
 * Classify commands for one device. Pure: no device, no audit. `multi`: disruptive commands are
 * refused (each device would need its own typed hostname). `readOnly`: anything not read-only is
 * refused (multi-device runs).
 */
/** Why a non-read command is refused while read-only mode is on (review Low 5: it covers every automated send). */
export const READ_ONLY_MODE_REASON = 'read-only mode is on (Settings › Assistant › Read-only mode), so only read-only commands are sent; turn it off to run configuration or exec changes'

export function analyze(platform: string, commands: string[], opts: { multi?: boolean; readOnly?: boolean; readOnlyMode?: boolean; user?: string; policy?: BlockRules } = {}): Analysis {
  if (!isPlatform(platform)) return refused('the device platform is unknown (auto-detect could not identify it), so every command is refused until you set the platform', commands)
  // The team policy's extra blocked commands (exec refuses them again, and so does the session host).
  if (opts.policy)
    for (const c of commands) {
      const denied = policyBlocked(opts.policy, platform, c)
      if (denied) return refused(`"${c.trim()}" is ${denied}`, commands, 'blocked')
    }
  const exec = commands.map((c) => classify(c, platform as Platform))
  const lines = (vs: { kind: string; reason: string; command: string }[]): PlanLine[] => vs.map((v) => ({ command: v.command, kind: v.kind as LineKind, reason: v.reason }))
  const blocked = exec.find((v) => v.kind === 'blocked')
  if (exec.every((v) => v.kind === 'read')) return { kind: 'read', reason: 'read-only', shape: 'read', lines: lines(exec), commands: exec.map((v) => v.command) }
  if (opts.readOnlyMode) {
    const bad = exec.find((v) => v.kind !== 'read')!
    return { ...refused(`"${bad.command}" is not read-only (${bad.reason}); ${READ_ONLY_MODE_REASON}`, commands, bad.kind === 'blocked' ? 'blocked' : 'refused'), lines: lines(exec) }
  }
  if (opts.readOnly) {
    const bad = exec.find((v) => v.kind !== 'read')!
    return { ...refused(`"${bad.command}" is not read-only (${bad.reason}); multi-device runs only run read-only commands`, commands, bad.kind === 'blocked' ? 'blocked' : 'refused'), lines: lines(exec) }
  }
  // A line the device would read as a configuration line: on a platform with a configuration session,
  // the exec classification wins only when it knows the line at least as well as configuration mode
  // does (Junos `set interfaces … disable` and EOS `no ip routing` resolve in exec only as a bare
  // `set`/`no`; they are configuration and run inside the session, with its disruptive check).
  let execRisk: string | undefined
  // R2: an exec command the guard did not resolve whole is not a configuration line either.
  for (const v of exec) {
    const head = v.kind === 'blocked' ? null : unresolvedExecLine(platform as Platform, v)
    if (head)
      return {
        ...refused(`"${v.command}" starts with the exec command "${head}", but Hopline Terminal does not know the rest of it, so it is neither run as one exec command nor sent as a configuration change; check the spelling, or type it yourself`, commands),
        lines: lines(exec)
      }
  }
  if (commands.length === 1) {
    const v = exec[0]!
    if (v.kind === 'blocked') return { kind: 'blocked', reason: v.reason, lines: lines(exec), commands }
    if (v.resolved && (v.kind === 'config' || v.kind === 'disruptive')) {
      // Never as one exec line: anything that enters or leaves a mode or changes the privilege level.
      if (changesMode(platform as Platform, v.command, v))
        return { ...refused(`"${v.command}" changes the CLI mode or privilege level, which would leave the session in another mode; Hopline Terminal enters and leaves configuration mode itself`, commands), lines: lines(exec) }
      if (!asConfigLine(platform as Platform, v)) {
        if (v.kind === 'disruptive' && opts.multi)
          return { ...refused(`${v.reason}. Disruptive commands are not sent to several devices: each one would need its own typed hostname. Run it on one device`, commands), lines: lines(exec) }
        return { kind: v.kind, reason: v.reason, shape: 'exec', lines: lines(exec), commands: [v.command] }
      }
      if (v.kind === 'disruptive') execRisk = v.reason
    }
  }
  if (exec.some((v) => v.kind === 'read') && !exec.every((v) => v.kind === 'read'))
    return { ...refused('it mixes show commands with configuration lines; keep them in separate snippets', commands), lines: lines(exec) }
  if (blocked && commands.length > 1 && blocked.resolved) return { ...refused(`"${blocked.command}": ${blocked.reason}`, commands, 'blocked'), lines: lines(exec) }
  const checked = checkProposal(platform as Platform, commands, { user: opts.user })
  if ('decision' in checked) return refused(checked.reason, commands, checked.decision === 'blocked' ? 'blocked' : 'refused')
  // The higher risk of the two readings: a line the exec tree calls disruptive stays disruptive.
  if (execRisk && !checked.disruptive.length) checked.disruptive.push(`"${commands[0]}": ${execRisk}`)
  const configLines: PlanLine[] = commands.map((c, i) => ({ command: c, kind: checked.verdicts[i]!.kind === 'disruptive' || (i === 0 && execRisk) ? 'disruptive' : 'config', reason: checked.verdicts[i]!.reason }))
  if (checked.disruptive.length && opts.multi)
    return { kind: 'refused', reason: `${checked.disruptive[0]}. Disruptive lines are not sent to several devices: each one would need its own typed hostname`, lines: configLines, commands }
  return {
    kind: checked.disruptive.length ? 'disruptive' : 'config',
    reason: checked.disruptive.length ? checked.disruptive.join('; ') : 'configuration change',
    shape: 'config',
    lines: configLines,
    commands,
    wrapper: { before: [...(checked.plan.precheck ? [checked.plan.precheck] : []), ...checked.plan.before], after: checked.plan.after },
    checked
  }
}

const depth = (expanded: string): number => expanded.trim().split(/\s+/).filter(Boolean).length

/** Words that start a configuration line on some platform and that exec trees also know as a bare head. */
const GENERIC_CONFIG_HEADS = new Set(['set', 'no', 'undo', 'default', 'delete'])
/**
 * Exec heads that are never configuration lines, whatever configuration mode makes of them
 * (configuration mode inherits exec on NX-OS, EOS, ASA ...): they keep the exec shape.
 */
const EXEC_ONLY_HEADS = new Set(['debug', 'undebug', 'debugging', 'terminal', 'more', 'diff', 'cd', 'find', 'test', 'capture', 'shun', 'monitor', 'clear'])

/** Read-only heads: an unknown `show …` is a mistyped read, never a configuration line (Junos configuration mode has its own `show`). */
const READ_HEADS = new Set(['show', 'display', 'get', 'ping', 'traceroute', 'tracert'])

const headOf = (expanded: string, typed: string): string => (expanded.trim().split(/\s+/)[0] || typed.trim().split(/\s+/)[0] || '').toLowerCase()

/** The configuration line resolved in a configuration tree itself (not through the exec fallback). */
function ownConfigResolution(platform: Platform, line: string): { depth: number } | null {
  const s = CONFIG_SESSIONS[platform]
  const r = resolve(platform, s.linesFrom, line)
  if (r.status !== 'ok' || !r.resolvedMode || !isConfigMode(platform, r.resolvedMode)) return null
  return { depth: depth(r.base) }
}

const isConfigMode = (platform: Platform, mode: ModeId): boolean => {
  const level = getPlatform(platform).profile.modes.find((m) => m.id === mode)?.level
  return level === 'config' || level === 'sub-config'
}

/**
 * A single line that resolved in exec mode, but that the platform's configuration mode knows
 * better: run it as configuration. Only on platforms with a configuration session to enter
 * (AireOS, FTD and FortiOS take their changes at the exec prompt).
 *
 * Phase 4 fix-round review R1: decided on the configuration tree's own commands (never the exec
 * fallback, which made `debug …` on NX-OS "deeper in configuration mode"), only for a line
 * configuration resolves deeper than exec, and never for an exec-only head (`debug`, `clear`,
 * `monitor` ...). A line exec knows only as a bare word goes to configuration only when that word
 * is a generic configuration head (`set`, `no`, `undo`, `default`, `delete`).
 */
export function asConfigLine(platform: Platform, v: Classification): boolean {
  const s = CONFIG_SESSIONS[platform]
  if (!s.enter.length || s.blocks) return false
  const head = headOf(v.expanded, v.command)
  if (EXEC_ONLY_HEADS.has(head)) return false
  const c = ownConfigResolution(platform, v.command)
  if (!c) return false
  const inExec = depth(v.expanded)
  // Deeper in configuration mode, or exec matched only a bare generic head (`set`, `no`) that a
  // configuration tree resolves itself.
  return c.depth > inExec || (inExec <= 1 && GENERIC_CONFIG_HEADS.has(head) && depth(v.command) > inExec)
}

/**
 * Phase 4 fix-round review R2: a line that starts with an exec-only command but that the exec
 * tree could not resolve whole (`clear ip bgp neighbor 10.0.0.1` on EOS). It is not a
 * configuration line, so it is never wrapped in a configuration session; returns the head.
 */
export function unresolvedExecLine(platform: Platform, v: Classification): string | null {
  if (v.resolved) return null
  const s = CONFIG_SESSIONS[platform]
  if (!s.enter.length || s.blocks) return null
  const typed = v.command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!typed) return null
  const model = getPlatform(platform)
  const execWords = (model.tree('exec')?.keywords ?? []).map((k) => k.word!)
  // The head exec resolved (`sh` → `show`), else the one exec keyword the typed word abbreviates.
  const expandedHead = v.expanded.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const prefixed = execWords.filter((w) => w.startsWith(typed))
  const head = execWords.includes(expandedHead) ? expandedHead : execWords.includes(typed) ? typed : prefixed.length === 1 ? prefixed[0]! : null
  if (!head || GENERIC_CONFIG_HEADS.has(head)) return null
  if (EXEC_ONLY_HEADS.has(head) || READ_HEADS.has(head)) return head
  // A word a configuration tree knows itself (without the exec fallback) may start a configuration line.
  const inConfig = model.modes.some((m) => isConfigMode(platform, m) && (model.tree(m)?.keywords ?? []).some((k) => k.word === head))
  return inConfig ? null : head
}

export interface RunnerDeps {
  term: TabControl
  settings: Pick<SettingsService, 'get'>
  audit: AuditLog
}

export interface RunOpts {
  source: Source
  /** The user confirmed this exact plan (config and disruptive). */
  approved: boolean
  /** Disruptive: the hostname the user typed. */
  ack?: string
  /** The hostname the prompt showed when the plan was made; the run is refused if it changed. */
  hostname?: string
  /** A short note for the audit row (the snippet name, the run id). */
  note?: string
  signal?: AbortSignal
  /** Called before each line, for progress. */
  onLine?: (line: string) => void
  /** The session as previewed, for the audit rows when the tab is gone at run time (review A2). */
  session?: { id: string; name: string; host: string; ephemeral?: boolean }
}

export class GuardedRunner {
  constructor(private readonly d: RunnerDeps) {}

  get term(): TabControl {
    return this.d.term
  }

  private base(tab: AgentTab, source: Source) {
    return { sessionId: tab.session.id, sessionName: tab.session.name, host: tab.session.host, source }
  }

  private audit(tab: AgentTab, o: RunOpts, command: string, kind: string, decision: 'blocked' | 'refused' | 'rejected' | 'cancelled', reason: string): void {
    this.d.audit.append({ ...this.base(tab, o.source), command, kind, decision, reason: o.note ? `${reason} (${o.note})` : reason, approver: decision === 'rejected' ? userInfo().username : null, durationMs: null, bytes: null, redactions: null })
  }

  /** The team policy's extra blocked commands. */
  policyRules(): BlockRules | undefined {
    return this.d.term.policyRules
  }

  /** Global read-only mode (Settings): every automated send is read-only while it is on. */
  readOnlyMode(): boolean {
    return !!this.d.settings.get().aiReadOnly
  }

  /** Classify for this tab's session as it is now (the platform may have been detected since). */
  async analyze(tabId: string, commands: string[], opts: { multi?: boolean; readOnly?: boolean } = {}): Promise<{ tab: AgentTab; analysis: Analysis; hostname: string } | null> {
    const tab = this.d.term.get(tabId)
    if (!tab) return null
    const p = await this.d.term.prompt(tab)
    return { tab, analysis: analyze(tab.session.platform, commands, { ...opts, readOnlyMode: this.readOnlyMode(), user: promptUser(p.prompt), policy: this.d.term.policyRules }), hostname: p.hostname }
  }

  /** One audit row for something that did not run through `run` (an insert, a target that never connected). */
  record(tab: AgentTab, command: string, kind: string, decision: AuditRow['decision'], reason: string, o: Pick<RunOpts, 'source' | 'note'>): void {
    this.d.audit.append({ ...this.base(tab, o.source), command, kind, decision, reason: o.note ? `${reason} (${o.note})` : reason, approver: decision === 'rejected' ? userInfo().username : null, durationMs: null, bytes: null, redactions: null })
  }

  /** Record a refusal or a rejection for every line (nothing ran). */
  refuse(tab: AgentTab, a: Analysis, o: RunOpts, decision: 'blocked' | 'refused' | 'rejected', reason: string): CommandRunResult {
    for (const l of a.lines.length ? a.lines : [{ command: '(empty)', kind: 'config' as const, reason }]) this.audit(tab, o, l.command, l.kind, decision, reason)
    return { status: decision, output: '', reason, redactions: 0 }
  }

  /**
   * Run an analysed plan on a tab. Re-classifies first (the caller's analysis may be stale), then
   * enforces the confirmation rules. Every line that reaches the device is audited with its result.
   */
  async run(tabId: string, planned: Analysis, o: RunOpts & { multi?: boolean; readOnly?: boolean }): Promise<CommandRunResult> {
    const fresh = await this.analyze(tabId, planned.commands, { multi: o.multi, readOnly: o.readOnly })
    if (!fresh) {
      // Nothing ran, but the attempt is on record (review A2).
      const s = o.session
      for (const l of planned.lines.length ? planned.lines : [{ command: '(empty)', kind: planned.kind }])
        this.d.audit.append({ sessionId: s && !s.ephemeral ? s.id : null, sessionName: s?.name ?? '(closed tab)', host: s?.host ?? '', source: o.source, command: l.command, kind: l.kind, decision: 'error', reason: o.note ? `the tab is closed (${o.note})` : 'the tab is closed', approver: null, durationMs: null, bytes: null, redactions: null })
      return { status: 'error', output: '', reason: 'the tab is closed', redactions: 0 }
    }
    const { tab, analysis: a, hostname } = fresh
    // Read-only mode turned on since the preview: refused, audited, with that reason (Low 5).
    if (this.readOnlyMode() && planned.shape && planned.shape !== 'read') return this.refuse(tab, a, o, 'refused', READ_ONLY_MODE_REASON)
    if (a.kind !== planned.kind || a.shape !== planned.shape || a.commands.join('\n') !== planned.commands.join('\n'))
      return this.refuse(tab, a, o, 'refused', 'the guard decision changed since the preview (the device platform or mode changed); preview it again')
    if (a.kind === 'blocked') return this.refuse(tab, a, o, 'blocked', a.reason)
    if (a.kind === 'refused' || !a.shape) return this.refuse(tab, a, o, 'refused', a.reason)
    if (a.shape !== 'read' && !o.approved) return this.refuse(tab, a, o, 'rejected', 'not confirmed')
    // The device must still be the one the preview was made for (a nested ssh/telnet hop changes the
    // prompt). Reads too: their output is shown and stored as this device's.
    if (o.hostname !== undefined && !hostBound([o.hostname], hostname))
      return this.refuse(tab, a, o, 'refused', `the device changed since the preview: the prompt showed "${o.hostname || '(no hostname)'}" and now shows "${hostname || '(no hostname)'}"`)
    if (a.shape !== 'read') {
      if (a.kind === 'disruptive') {
        if (o.multi) return this.refuse(tab, a, o, 'refused', 'disruptive commands are not sent to several devices')
        if (!hostname) return this.refuse(tab, a, o, 'refused', `${a.reason}; the device prompt shows no hostname to confirm against`)
        if (!o.ack || !sameHost(o.ack, hostname)) return this.refuse(tab, a, o, 'refused', `the typed hostname does not match the device ("${hostname}")`)
      }
    }
    const res = await this.send(tab, a, o, hostname)
    // Lines of the plan that never reached the device (a stop, an earlier failure) are on record too (review A2).
    const why = res.status === 'cancelled' ? 'not run: stopped' : `not run: an earlier line ended with ${res.status}${res.reason ? ` (${res.reason.slice(0, 120)})` : ''}`
    if (res.started) for (const c of res.unsent) this.audit(tab, o, c, a.lines.find((l) => l.command === c)?.kind ?? a.kind, 'cancelled', why)
    return res.result
  }

  private async send(tab: AgentTab, a: Analysis, o: RunOpts, hostname: string): Promise<{ result: CommandRunResult; status: CommandRunResult['status']; reason?: string; unsent: string[]; started: boolean }> {
    const unsent = [...a.commands]
    let started = false
    const done = (r: CommandRunResult) => ({ result: r, status: r.status, reason: r.reason, unsent, started })
    const settings = this.d.settings.get()
    const approver = a.shape === 'read' ? null : userInfo().username
    const outputs: string[] = []
    let redactions = 0
    const platform = tab.session.platform as Platform
    const exec = (line: string, kind: ExecKind, extra: { hosts?: string[]; ack?: string; allowConfig?: boolean } = {}): Promise<ExecResultMsg> => {
      o.onLine?.(line)
      // A tab that closes or a host that refuses mid-run is a failed line (audited), not a thrown error.
      return this.d.term
        .exec(tab, line, kind, { timeoutMs: settings.commandTimeoutMs, capBytes: settings.outputCapBytes, signal: o.signal, ...extra })
        .catch((e: unknown): ExecResultMsg => ({ status: 'error', output: '', durationMs: 0, bytes: 0, error: o.signal?.aborted ? 'stopped' : e instanceof Error ? e.message : String(e) }))
        .then((r) => {
          // The device said the line did not run as typed (`% Invalid input`, `syntax error`): failed, not ok.
          const err = r.status === 'ok' ? commandError(platform, r.output) : null
          return err ? { ...r, status: 'error' as const, error: `the device reported an error: ${err.slice(0, 200)}` } : r
        })
    }
    const report = (line: string, kind: ExecKind, r: ExecResultMsg): string => {
      started = true
      const at = unsent.indexOf(line)
      if (at >= 0) unsent.splice(at, 1)
      const red = redact(r.output)
      redactions += red.count
      outputs.push(red.text)
      const decision = r.status === 'ok' ? 'executed' : r.status
      // Typed but Enter never pressed, and the line not confirmed empty (executor E3).
      const why = r.typedNotSent ? `typed, not sent: ${r.error ?? ''}` : (r.error ?? (approver ? 'approved by user' : 'read-only'))
      this.d.audit.append({ ...this.base(tab, o.source), command: line, kind, decision, reason: o.note ? `${why} (${o.note})` : why, approver, durationMs: r.durationMs, bytes: r.bytes, redactions: red.count })
      return red.text
    }
    const result = (status: CommandRunResult['status'], reason?: string) => {
      let output = outputs.join('\n')
      if (output.length > MAX_OUTPUT_CHARS) output = '…\n' + output.slice(-MAX_OUTPUT_CHARS)
      return done({ status, output, reason, redactions })
    }

    if (a.shape === 'read') {
      for (const line of a.commands) {
        if (o.signal?.aborted) return result('cancelled', 'stopped')
        const r = await exec(line, 'read')
        report(line, 'read', r)
        if (r.status !== 'ok') return result(r.status, r.error)
      }
      return result('ok')
    }
    if (a.shape === 'exec') {
      const kind = a.kind === 'disruptive' ? 'disruptive' : 'config'
      const p = await this.d.term.prompt(tab)
      if (p.mode !== 'exec' && p.mode !== 'user') return done(this.refuse(tab, a, o, 'refused', `the session is not at the exec prompt (it shows ${p.mode} mode)`))
      const r = await exec(a.commands[0]!, kind, { hosts: [hostname], ...(o.ack ? { ack: o.ack } : {}) })
      report(a.commands[0]!, kind, r)
      // Belt and braces for M1: an exec line must leave the session at the exec prompt.
      const after = await this.d.term.prompt(tab)
      if (r.status === 'ok' && after.mode !== 'exec' && after.mode !== 'user')
        return result('error', `"${a.commands[0]}" left the session in ${after.mode === 'unknown' ? 'an unrecognised' : after.mode} mode: check it and return to the exec prompt by hand`)
      return result(r.status === 'ok' ? 'ok' : r.status, r.error)
    }
    // Configuration: the platform's session (enter, lines, commit, leave; discard on failure).
    const at = await this.d.term.prompt(tab)
    if (at.mode !== 'exec' && at.mode !== 'user' && a.checked!.plan.session.enter.length)
      return done(this.refuse(tab, a, o, 'refused', `the session is not at the exec prompt (it shows ${at.mode} mode); leave configuration mode first`))
    const hosts = [hostname, ...hostnamesSetBy(a.commands)]
    const run = await runConfig(
      {
        platform,
        exec: (line, kind) => {
          if (kind === 'read') {
            const v = classify(line, platform)
            if (v.kind !== 'read') return Promise.resolve({ status: 'error' as const, output: '', durationMs: 0, bytes: 0, error: `refused: "${line}" is not read-only (${v.reason})` })
            return exec(line, 'read')
          }
          return exec(line, kind, { hosts, allowConfig: true, ...(o.ack ? { ack: o.ack } : {}) })
        },
        report: (line, kind, r) => report(line, kind, r),
        prompt: () => this.d.term.prompt(tab)
      },
      a.checked!,
      a.commands
    )
    if (run.applied) return result('ok', run.atExec ? undefined : run.reason)
    // Phase 5 review H3: a commit that did not report back may be live; never a plain "error".
    if (run.uncertain) return result('partial', `State unknown — check the device: ${run.reason ?? 'the commit did not report back'}`)
    return result(run.partial ? 'partial' : 'error', [run.reason, run.leftover].filter(Boolean).join('; '))
  }
}
