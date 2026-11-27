import { PROFILES, RISK_ORDER, resolve, type ConfirmSpec, type ModeId, type PipeStage, type Resolution, type Risk } from '@hopline/cli-model'
import type { GuardPlatform } from './platforms'

/**
 * Guard v2: tree-based classification of a CLI line the AI agent wants to run.
 *
 * Order (docs/ARCHITECTURE.md §5.3):
 *  1. normalize: trim, printable ASCII only, strip a leading `do`/`run` in exec mode
 *  2. reject separators and expansion (`;` `&` `<` `>` backtick `$(` `${` `?`, escaped control sequences)
 *  3. split pipes (quote-aware only where the device is) and resolve each against the platform's
 *     pipe allow-list; anything unknown is blocked
 *  4. resolve abbreviations against the command tree; an ambiguous prefix counts as its most
 *     dangerous expansion
 *  5. take the node's risk, then argument-dependent rules (`clear ip bgp *` vs `… soft`, Junos ping count)
 *  6. default-deny: anything that does not resolve to a runnable read command is at least `config`
 *
 * Deny-listed heads are blocked nodes in the tree, so a parse failure under one is still blocked.
 */

export type CommandClass = Risk

export interface Classification {
  kind: CommandClass
  /** Human-readable reason, shown in the AI panel and stored in the audit log. */
  reason: string
  /** The exact text that may be sent to the device (trimmed; a leading `do`/`run` removed in exec mode). */
  command: string
  /** Canonical form with abbreviations expanded (empty if the line did not resolve). */
  expanded: string
  /** Device confirmations this command may raise, each with the only answer allowed. */
  confirmations: readonly ConfirmSpec[]
  /** The line may leave configuration mode (end/exit and their abbreviations). */
  leavesConfig: boolean
  /** Mode the line was classified in. */
  mode: ModeId | 'config-any'
  /** Mode the device is in after this line (config sub-modes), when known. */
  nextMode?: ModeId
  /** The command before the first pipe (expanded when it resolved), for local output filtering. */
  base: string
  /** Pipe stages as the device parses them (IOS: one regex filter takes the rest of the line). */
  pipes: readonly PipeStage[]
  /**
   * The command resolved to a modelled command. False for unknown or incomplete commands, which
   * are `config` by default-deny (the device may still know them).
   */
  resolved: boolean
}

export interface ClassifyOptions {
  /**
   * CLI mode the line will be typed in. Defaults to `exec` (privileged exec / operational mode),
   * which is where read-only commands run. `config-any` classifies against every config mode and
   * keeps the most dangerous result, for when the sub-mode is unknown.
   */
  mode?: ModeId | 'config-any'
}

export const MAX_COMMAND_LENGTH = 512
const MAX_PIPES = 4

/** Printable ASCII only: blocks \r \n \t, escape sequences, DEL, and Unicode look-alikes. */
const PRINTABLE = /^[\x20-\x7e]*$/

/**
 * Characters that chain, redirect, substitute or trigger in-line help on at least one platform:
 * `;` chains on NX-OS; `>`/`>>` redirect to flash on NX-OS/EOS; `&`, backtick, `$(`, `${` are shell
 * syntax where pipes reach bash (EOS, NX-OS); `?` makes the device print help and re-type the line,
 * so `rel?oad` would run `reload`.
 */
const FORBIDDEN = /[;<>`&?]|\$\(|\$\{/

/** Escaped control sequences that a later layer (or a lenient device) might decode. */
const ESCAPED = /\\(?:[nrtae0fv]|x[0-9a-f]{2}|u[0-9a-f]{4}|c[a-z@[\]^_])|%0[0-9a-f]|%1[0-9a-f]|%7f|&#/i

const verdict = (kind: CommandClass, reason: string, command: string, mode: Classification['mode']): Classification => ({
  kind,
  reason,
  command,
  expanded: '',
  confirmations: [],
  leavesConfig: false,
  mode,
  base: '',
  pipes: [],
  resolved: false
})

function configModes(platform: GuardPlatform): ModeId[] {
  return PROFILES[platform].modes.filter((m) => m.level === 'config' || m.level === 'sub-config').map((m) => m.id)
}

function pipeCount(r: Resolution): number {
  return r.pipes.length
}

/**
 * Classify a single CLI line. Default-deny: anything not provably read-only is `config`
 * (needs approval), `disruptive` (approval plus a second confirmation) or `blocked`.
 */
export function classify(raw: string, platform: GuardPlatform, opts: ClassifyOptions = {}): Classification {
  const profile = PROFILES[platform]
  if (!profile) return verdict('blocked', `unknown platform "${String(platform)}"`, raw.trim(), 'exec')
  const mode = opts.mode ?? 'exec'
  let command = raw.trim()

  if (!command) return verdict('blocked', 'empty command', command, mode)
  if (command.length > MAX_COMMAND_LENGTH) return verdict('blocked', `longer than ${MAX_COMMAND_LENGTH} characters`, command, mode)
  if (!PRINTABLE.test(raw)) return verdict('blocked', 'contains control, newline or non-ASCII characters', command, mode)
  if (FORBIDDEN.test(command)) return verdict('blocked', 'contains chaining, redirection, substitution or help characters (; & < > ` $( ${ ?)', command, mode)
  if (ESCAPED.test(command)) return verdict('blocked', 'contains an escaped or encoded control sequence', command, mode)
  if (profile.forbidden?.test(command)) return verdict('blocked', `contains characters that ${profile.label} evaluates as script syntax`, command, mode)

  // `do show …` (Cisco/Arista) or `run show …` (Junos/PAN-OS) typed for exec: classify what actually
  // executes, and send it without the prefix (read commands only run from exec mode).
  if (mode === 'exec' && profile.execFromConfig) {
    const prefix = profile.execFromConfig
    for (;;) {
      const m = /^(\S+)\s*(.*)$/.exec(command)
      if (!m || m[1]!.toLowerCase() !== prefix) break
      command = m[2]!
      if (!command) return verdict('blocked', `bare "${prefix}"`, command, mode)
    }
  }

  const modes: ModeId[] = mode === 'config-any' ? configModes(platform) : [mode]
  if (!modes.length) return verdict('blocked', `no configuration mode on ${profile.label}`, command, mode)

  let best: Resolution | undefined
  let leaves = false
  for (const m of modes) {
    const r = resolve(platform, m, command)
    leaves ||= r.leaves
    if (!best || RISK_ORDER[r.risk] > RISK_ORDER[best.risk] || (r.risk === best.risk && best.status !== 'ok' && r.status === 'ok')) best = r
  }
  const r = best!
  if (pipeCount(r) > MAX_PIPES) return verdict('blocked', `more than ${MAX_PIPES} pipes`, command, mode)

  // Reachability probes (review H2) are capped inside resolve (cli-model probe.ts): count, size,
  // timeout and TTL caps, no flood, payload or unknown option; over a cap is `config`, never read.
  let kind = r.risk
  let reason = r.reason
  // Phase 8 A-L1: at a configuration prompt, a line the config tree does not model is also held to
  // the exec deny-list (FortiOS `execute reboot` inside a block). A modelled config line keeps its
  // config meaning (IOS `crypto pki trustpoint` is config, not the exec `crypto pki` form).
  if (mode !== 'exec' && r.status !== 'ok' && kind !== 'blocked') {
    const asExec = resolve(platform, 'exec', command)
    if (asExec.risk === 'blocked') {
      kind = 'blocked'
      reason = `${asExec.reason} (the exec deny-list holds at a configuration prompt too)`
    }
  }

  const nextMode = mode === 'config-any' ? undefined : r.status === 'ok' ? (r.enters ?? (r.resolvedMode && r.resolvedMode !== 'exec' ? r.resolvedMode : mode)) : mode
  return {
    kind,
    reason,
    command,
    expanded: r.expanded,
    confirmations: kind === 'blocked' ? [] : r.confirm,
    leavesConfig: leaves,
    mode,
    nextMode,
    base: r.base,
    pipes: r.stages,
    resolved: r.status === 'ok'
  }
}

/**
 * Classify the lines of a configuration change in order, starting in global configuration mode,
 * following the sub-modes they enter (`interface …` → interface mode). Use this for proposals:
 * `shutdown` means something different under `interface` and under `router bgp`.
 */
export function classifyConfigLines(lines: readonly string[], platform: GuardPlatform, start: ModeId = 'config'): Classification[] {
  let mode = start
  const out: Classification[] = []
  for (const line of lines) {
    const c = classify(line, platform, { mode })
    out.push(c)
    if (c.nextMode && c.nextMode !== 'exec' && c.nextMode !== 'user') mode = c.nextMode
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Bound confirmation answers

const lastLine = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .at(-1) ?? ''

/** True if the last line of `text` is a device question waiting for an answer ("[confirm]", "(y/n)"). */
export function isConfirmationPrompt(platform: GuardPlatform, text: string): boolean {
  const line = lastLine(text)
  if (!line) return false
  return PROFILES[platform].confirmPatterns.some((re) => re.test(line))
}

export type ConfirmationDecision = { answer: string; description: string } | { refuse: string }

/**
 * Decide how to answer a device confirmation raised while `command` runs. Only an answer bound to
 * that command's tree node (and to this exact prompt) is allowed; anything else must be refused,
 * which the executor does by sending Ctrl-C. Never answers for a blocked command.
 */
export function answerConfirmation(platform: GuardPlatform, command: string, promptText: string, opts: ClassifyOptions = {}): ConfirmationDecision {
  const c = classify(command, platform, opts)
  if (c.kind === 'blocked') return { refuse: `"${command}" is blocked: ${c.reason}` }
  const line = lastLine(promptText)
  const spec = c.confirmations.find((s) => s.prompt.test(line))
  if (!spec) return { refuse: `the device asked "${line.slice(0, 120)}", which is not an approved answer for "${command}"` }
  return { answer: spec.answer, description: spec.description }
}
