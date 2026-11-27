/**
 * Public types for @hopline/cli-model.
 *
 * Everything here is plain data or pure functions so the same model can be shared by the
 * simulator, the guard and the renderer's autocomplete. See docs/research/cli-overview.md §2.
 */

/** Every modelled platform, Cisco first. Adding one: an id here, a profile, a tree file (see trees/index.ts). */
export const PLATFORM_IDS = ['ios', 'iosxe', 'nxos', 'iosxr', 'asa', 'c9800', 'aireos', 'ciscosb', 'ftd', 'eos', 'junos', 'panos', 'fortios', 'aoscx', 'vrp'] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

/**
 * Risk of running a command.
 * - read: no state change, terminates on its own; may auto-run for the agent.
 * - config: changes state; needs approval.
 * - disruptive: changes state in a way that can take traffic or access down; approval plus a second confirmation.
 * - blocked: never run on behalf of the agent.
 */
export type Risk = 'read' | 'config' | 'disruptive' | 'blocked'
export const RISK_ORDER: Readonly<Record<Risk, number>> = { read: 0, config: 1, disruptive: 2, blocked: 3 }
export const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b)

/** Where a parameter's values can be learned from on a live device (cli-overview §2.5). */
export type LiveSource =
  | 'interfaces'
  | 'vlans'
  | 'vrfs'
  | 'bgp-neighbors'
  | 'ospf-neighbors'
  | 'route-maps'
  | 'prefix-lists'
  | 'acls'
  | 'policy-statements'
  | 'firewall-filters'
  | 'zones'
  | 'address-objects'
  | 'vdoms'
  | 'vsys'
  | 'checkpoints'
  | 'config-sessions'
  | 'files'

export type ParamKind =
  | 'word' // one free token
  | 'line' // rest of the line (descriptions, regexes)
  | 'int' // number in [min, max]
  | 'range-list' // 10,20-30
  | 'ipv4'
  | 'ipv4-prefix' // A.B.C.D/LEN
  | 'ipv6'
  | 'ipv6-prefix'
  | 'ip' // v4 or v6
  | 'prefix' // v4 or v6 prefix
  | 'ip-or-prefix'
  | 'host' // address or hostname
  | 'mac'
  | 'asn'
  | 'interface'
  | 'path'

export interface ParamDef {
  kind: ParamKind
  /** Left column of `?` help: `<1-4094>`, `A.B.C.D`, `WORD`, `<interface>`. */
  label: string
  /** One-line help. */
  help: string
  min?: number
  max?: number
  live?: LiveSource
  /** Name used in `Resolution.params` (interface, vrf, vlan, neighbor, …). */
  capture?: string
}

/** A device question ("[confirm]", "(y/n)") the command is known to raise, and the only answer allowed. */
export interface ConfirmSpec {
  /** Matched against the last line the device printed. */
  prompt: RegExp
  /** Exact bytes to send ("\r" for Enter, "y", "yes\r"). */
  answer: string
  /** Human-readable, for the approval card and the audit log. */
  description: string
}

/** Extra argument-dependent rule on a node, evaluated with the tokens typed after it. */
export type ArgRule = (args: readonly string[]) => { risk: Risk; reason: string } | undefined

/** A compiled command-tree node. Keyword and parameter nodes are siblings. */
export interface CommandNode {
  /** Keyword (lower case), or undefined for a parameter node. */
  word?: string
  param?: ParamDef
  help: string
  /** Executable here, so `<cr>` is offered. */
  runnable: boolean
  /** Risk when the command ends here (inherits from the nearest ancestor if unset). */
  risk?: Risk
  /** Why this node carries its risk (shown to users and stored in the audit log). */
  reason?: string
  /** Accepts any further tokens (the device validates them). Used for deny-list heads and open-ended shows. */
  open?: boolean
  /** The rest of the line is resolved in another mode's tree (`do` → exec, Junos `run` → operational). */
  exec?: ModeId
  /** Enters a mode when run. */
  enters?: ModeId
  /** Leaves configuration mode (end/exit at the top of config). */
  leaves?: boolean
  confirm?: readonly ConfirmSpec[]
  rule?: ArgRule
  /** Abbreviations that resolve here even though they are not unique by spelling (IOS `sh`, `wr`, `conf t`). */
  priority?: ReadonlyMap<string, string>
  keywords: CommandNode[]
  params: CommandNode[]
  /** @internal set while compiling when an entry gave explicit help */
  helpSet?: boolean
}

/** Mode identifiers. Cisco-style suffix modes, Junos/PAN-OS operational/configuration, FortiOS context stack. */
export type ModeId =
  | 'user'
  | 'exec'
  | 'config'
  | 'config-if'
  | 'config-router'
  | 'config-vlan'
  | 'config-line'
  | 'config-acl'
  | 'config-route-map'
  | 'config-vrf'
  | 'pipe'

export type ModeLevel = 'user' | 'exec' | 'config' | 'sub-config'

export interface ModeDef {
  id: ModeId
  level: ModeLevel
  description: string
  /** Sub-mode suffixes / context words that map to this mode (IOS `config-if`, `config-if-range`, …). */
  match?: RegExp
  /** Modes whose commands are also accepted here (IOS sub-modes fall back to global config; EOS config inherits exec). */
  fallback?: readonly ModeId[]
}

export interface DetectedMode {
  mode: ModeId
  level: ModeLevel
  hostname: string
  /** The prompt text itself (`core-sw1(config-if)#`, `netops@edge-r1# `). */
  prompt: string
  /** Text typed after the prompt on the same line. */
  pending: string
  /** Cisco sub-mode suffix (`config-if-Et1`), FortiOS context (`port1`), NX-OS routing-context VRF, … */
  context?: string
  /** Junos/PAN-OS `[edit …]` path. */
  editPath?: string[]
  /** `{master:0}`, `{primary:node0}`, `(active)`, `vsys2` … */
  banner?: string
}

export interface InterfaceType {
  /** Canonical name prefix: `GigabitEthernet`, `Ethernet`, `port-channel`, `ge-`. */
  full: string
  /** Short forms seen in tables (`Gi`, `Eth`, `Po`). */
  short: readonly string[]
}

export interface InterfaceSyntax {
  /** Type-prefix + numbering style (Cisco/Arista). Empty for opaque names (FortiOS) or full regex platforms. */
  types: readonly InterfaceType[]
  /** Numbering accepted after the type (`1/0/1`, `1/0/1.100`, `49/1`). */
  numbering: RegExp
  /** "Gi 1/0/1" (two tokens) is accepted. */
  spaceBetween: boolean
  /** Whole-name regex for platforms without abbreviations (Junos, PAN-OS). */
  fullName?: RegExp
  /** Any word is a valid name (FortiOS). */
  opaque?: boolean
}

export interface ErrorPatterns {
  invalid: RegExp
  ambiguous: RegExp
  incomplete: RegExp
  /** Other `%`/`error:` lines that mean the command did not run as intended. */
  other: readonly RegExp[]
  /** Where the caret line points, if there is one. */
  caret: 'first-failing-char' | 'token-start' | 'token-end' | 'none'
  /** Verbatim samples from the research docs, for simulator golden tests. */
  samples: { invalid: string; ambiguous: string; incomplete: string }
}

export interface PagerProfile {
  /** Matches the pager prompt at the end of output. */
  pattern: RegExp
  /** The literal string the device prints (best known). */
  text: string
  /** Session-scoped commands that disable paging (empty if only a config write does it). */
  disable: readonly string[]
  /** Per-command suffix that disables paging (`| no-more`). */
  perCommand?: string
  keys: { line: string; page: string; quit: string }
}

export interface PipeProfile {
  /** Filters that exist on the platform (for completion and the simulator). */
  filters: readonly string[]
  /** `|` inside double quotes is part of the argument (Junos `match "a|b"`). */
  quoteAware: boolean
  /** What the device does with an unknown word after `|`. EOS runs it as a Linux command. */
  unknown: 'error' | 'shell'
  /**
   * IOS/IOS-XE: these filters take the rest of the line as one regular expression, so a later `|`
   * is regex alternation (`| include up|down`), not another pipe. Without it, every `|` starts a
   * new stage (NX-OS and EOS chain pipes; EOS hands unknown stages to the shell).
   */
  regexRest?: readonly string[]
  /**
   * Modifiers that write or read files. With `regexRest`, a `|` inside the regex followed by a word
   * that could abbreviate one of these is blocked anyway, in case a release does chain.
   */
  writers?: readonly string[]
  /**
   * Quoted pipe arguments are honoured as far as we know but this is not verified (NX-OS): text
   * after a `|` inside quotes must also be harmless as a pipe stage.
   */
  quotesUnverified?: boolean
}

export interface KeyBehavior {
  ctrlZ: 'end' | 'none'
  ctrlC: 'end' | 'clear-line' | 'abort-or-disconnect'
  ctrlR: 'redraw' | 'search' | 'none'
  /** IOS break sequence (Ctrl-Shift-6) aborts ping/traceroute. */
  breakSeq?: string
  /**
   * Typed before a guarded command so it starts on an empty line (Ctrl-U: erase to the start of the
   * line; Ctrl-E first where Ctrl-U erases only left of the cursor, so hidden text to the right goes too). Only where the key erases the line and does nothing else; elsewhere the executor relies
   * on checking the echo alone. A stray Esc the user sent leaves an invisible meta prefix that eats
   * the next key: Ctrl-U absorbs it instead of the command's first character.
   */
  lineClear?: string
}

export interface LiveBinding {
  /** Read-only command to learn the values. */
  command: string
  /** Structured variant where the platform has one. */
  structured?: string
  ttlSeconds: number
}

export interface PlatformProfile {
  id: PlatformId
  label: string
  vendor: string
  /** How much of the tree is modelled. */
  depth: 'full' | 'read-only'
  modes: readonly ModeDef[]
  /** Matches any prompt line for this platform (the device is idle at a prompt). */
  promptRegex: RegExp
  pager: PagerProfile
  errors: ErrorPatterns
  /** Device questions that need an answer before the command proceeds. */
  confirmPatterns: readonly RegExp[]
  pipes: PipeProfile
  abbreviation: {
    /** Unique prefixes are accepted on Enter. */
    prefixes: boolean
    /** Object names (interfaces, addresses) are never abbreviated. */
    objectNames: 'abbreviated' | 'full'
  }
  /** Prefix that runs an exec command from config mode, or null. */
  execFromConfig: 'do' | 'run' | null
  /**
   * Config mode also accepts exec commands directly (ASA, NX-OS, EOS, AOS-CX, VRP): a line typed in
   * any configuration mode is resolved against the exec tree too, and keeps the most dangerous
   * verdict (`reload` in a proposal is still blocked).
   */
  configInheritsExec: boolean
  /**
   * With `configInheritsExec`: first words (spelled out) that in configuration mode are only the
   * configuration command, never the exec one (NX-OS `feature`, ASA `ssh`). The exec tree is not
   * consulted for them; the configuration tree must block their dangerous forms itself.
   */
  configShadowsExec?: readonly string[]
  /** Double quotes group a token (`"two words"`). */
  quotes: boolean
  keys: KeyBehavior
  completion: { tab: 'unique-only' | 'list-on-ambiguous' | 'cycle'; space: boolean; helpFormat: 'cisco' | 'junos' | 'panos' | 'fortios' }
  structured?: { suffix: string; format: 'json' | 'xml' }
  interfaces: InterfaceSyntax
  live: Partial<Record<LiveSource, LiveBinding>>
  /** Prompt grammar `detectMode` uses; platforms of one family share it. */
  promptStyle: PromptStyle
  /**
   * Characters or sequences the guard refuses on this platform on top of the shared set
   * (RouterOS `[` `{` `:` scripting, for example).
   */
  forbidden?: RegExp
  /** Evidence that identifies this platform (see `fingerprint`). */
  fingerprint: FingerprintSignals
  /** The read-only command that prints this platform's version banner (used by `probeCommand`). */
  probe: string
}

export type PromptStyle = 'cisco' | 'nxos' | 'junos' | 'panos' | 'fortios' | 'aireos' | 'bare' | 'vrp'

export type EvidenceKind = 'sshServerVersion' | 'banner' | 'prompt' | 'showVersion'

/** One fingerprint signal: when `re` matches the evidence of `kind`, it adds `weight` (0..1). */
export interface FingerprintSignal {
  kind: EvidenceKind
  re: RegExp
  weight: number
  /** The signal does not count if this also matches (classic IOS text inside an IOS-XE banner). */
  unless?: RegExp
  /** Capture group 1 is the software version. */
  version?: RegExp
  /** Capture group 1 is the hardware model. */
  model?: RegExp
  note: string
}

export type FingerprintSignals = readonly FingerprintSignal[]

/** Live values known for the current session, used for completion and ghost text. */
export type LiveValues = Partial<Record<LiveSource, readonly string[]>>
