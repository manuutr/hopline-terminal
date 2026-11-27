/**
 * Platform behaviour the app needs at run time (prompt, pager, device errors, how a config change
 * is wrapped), read from the cli-model profiles instead of per-vendor code. Main and the session
 * host use it; it holds no secrets and no Node APIs.
 */
import { CONFIG_SESSIONS, detectMode, getPlatform, PLATFORM_IDS, PROFILES, type ConfigSession, type DetectedMode, type PlatformId } from '@hopline/cli-model'
import type { PromptMode } from './host-protocol'

/** A session's platform as stored: a modelled platform, or `auto` until it is identified. */
export type AnyPlatform = PlatformId | 'auto'

export const isModelled = (p: string | undefined | null): p is PlatformId => !!p && p in PROFILES

// eslint-disable-next-line no-control-regex
// CSI (7- and 8-bit), OSC (7- and 8-bit: titles, OSC 8 links, OSC 52 clipboard), DCS/SOS/PM/APC
// strings (7- and 8-bit: their payload is not text either), charset and single-character escapes.
// An 8-bit string cut short by another 8-bit introducer is removed up to it (a terminal cancels it
// and never shows that payload, so it must not reach the model as text); still linear, since a
// payload run ends at the next introducer.
const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x9d)[^\x07\x1b\x9c\x90\x98\x9d\x9e\x9f]*(?:\x07|\x9c|\x1b\\|(?=[\x90\x98\x9d\x9e\x9f]))|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x07\x1b]*(?:\x07|\x1b\\)|[\x90\x98\x9e\x9f][^\x07\x1b\x9c\x90\x98\x9d\x9e\x9f]*(?:\x07|\x9c|\x1b\\|(?=[\x90\x98\x9d\x9e\x9f]))|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g

/**
 * A backspace erases the character before it (not a newline, not another backspace), applied until
 * nothing changes. One pass with a stack, so hostile output (a long run of text, then as many
 * backspaces) stays linear. The 8-bit string introducers are excluded from their own payload class
 * in ANSI above for the same reason: an unterminated run is not rescanned from every start (M1).
 */
function eraseBackspaces(s: string): string {
  if (!s.includes('\x08')) return s
  const out: string[] = []
  for (const ch of s.split('')) {
    const top = out.length ? out[out.length - 1] : undefined
    if (ch === '\x08' && top !== undefined && top !== '\x08' && top !== '\n') out.pop()
    else out.push(ch)
  }
  return out.join('')
}

export function cleanTerminalText(s: string): string {
  const t = eraseBackspaces(s.replace(ANSI, ''))
  // eslint-disable-next-line no-control-regex
  // C1 controls too (\x9b is a one-byte CSI): device text must not carry hidden escapes into prompts or the model.
  return t.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export interface PromptState {
  mode: PromptMode
  prompt: string
  pending: string
  hostname: string
  /** The platform whose prompt grammar matched (the session's, or the first match for `auto`). */
  platform?: PlatformId
  detected: DetectedMode | null
}

const toMode = (d: DetectedMode): PromptMode => (d.level === 'user' ? 'user' : d.level === 'exec' ? 'exec' : 'config')

/** Lines that look like a prompt but are a question: logins, passwords, pagers, confirmations. */
/** Login and credential prompts: the user is still getting in, so detection keeps waiting. */
export const LOGIN_PROMPT = /(?:user ?name|login|password|passphrase|passcode|pin|token|otp|response)[^:]*:\s*$/i

const NOT_A_PROMPT = /(?:user ?name|login|password|passphrase|passcode|pin|token|otp|response)[^:]*:\s*$|--more--|\(more|\[confirm\]|\[y(?:es)?\/n(?:o)?\]|\(y\/n\)/i

/**
 * Credential, menu and question words that end the line whatever the terminator (`Password>`,
 * `Passcode>`, `Enter selection#`, `Choice>`, `Press any key>`). Anchored to the whole last word
 * before the terminator, so hostnames that merely contain one (`spine1#`, `login-gw>`,
 * `token-rtr#`) are still prompts.
 */
const CREDENTIAL_OR_MENU =
  /(?:^|[\s(])(?:user ?name|login|password|passwd|passphrase|passcode|pin|token|otp|response|verification code|code|secret|selection|select|choice|option|menu|continue|press any key|any key|enter|answer|y\/n|yes\/no)\s*[>#$%:?\]]\s*$/i

/** A Unix shell rather than a device CLI (`bash-4.3#`, `sh-4.2$`, `[admin@sw1 ~]$`, `root@sw1:~#`). */
const UNIX_SHELL = /^(?:(?:ba|z|k|c|tc|da|a)?sh(?:-\d[\d.]*)?[#$]|\[[^\]]*@[^\]]*\]\s?[#$]|\S+@\S+:[~/]\S*\s?[#$])\s*$/i

/**
 * Classify the last line of the terminal as a prompt. With `auto`, every platform's prompt grammar
 * is tried (Cisco-style first) and the first match wins; that only says "the device is idle at some
 * prompt", which is all an unidentified session is ever asked.
 */
export function promptState(tail: string, platform: AnyPlatform): PromptState {
  const text = cleanTerminalText(tail)
  const last = text.split('\n').at(-1) ?? ''
  const none: PromptState = { mode: 'unknown', prompt: '', pending: last, hostname: '', detected: null }
  if (NOT_A_PROMPT.test(last) || CREDENTIAL_OR_MENU.test(last) || UNIX_SHELL.test(last.trim())) return none
  const tryOne = (p: PlatformId): PromptState | null => {
    const d = detectMode(p, text)
    return d ? { mode: toMode(d), prompt: d.prompt, pending: d.pending, hostname: d.hostname, platform: p, detected: d } : null
  }
  if (platform !== 'auto') return isModelled(platform) ? (tryOne(platform) ?? none) : none
  // Unidentified: only accept a prompt with nothing typed after it.
  for (const p of PLATFORM_IDS) {
    const s = tryOne(p)
    if (s && !s.pending.trim()) return s
  }
  return none
}

/** Every pager prompt the platform (or, for `auto`, any platform) prints. */
export function pagerPattern(platform: AnyPlatform): RegExp {
  const list = isModelled(platform) ? [PROFILES[platform]] : Object.values(PROFILES)
  // Generic forms too: Cisco "--More--", Junos "---(more 42%)---".
  const sources = [...new Set([...list.map((p) => p.pager.pattern.source), String.raw`(?:\s*--\s*More\s*--\s*|---\(more(?: \d+%)?\)---)\s*$`])]
  return new RegExp(sources.map((s) => `(?:${s})`).join('|'), 'i')
}

export function pagerKeys(platform: AnyPlatform): { page: string; quit: string } {
  return isModelled(platform) ? PROFILES[platform].pager.keys : { page: ' ', quit: 'q' }
}

/** The key that empties the input line before a guarded command, where the profile marks one safe. */
export function lineClearKey(platform: AnyPlatform): string | undefined {
  return isModelled(platform) ? PROFILES[platform].keys.lineClear : undefined
}

/**
 * The keys that stop a running command, in the order the executor sends them (each only if the
 * prompt has not come back after the one before): the platform's break sequence first (IOS
 * Ctrl-Shift-6: IOS ignores Ctrl-C during a ping or traceroute, Phase 8 review H2), then Ctrl-C.
 * Ctrl-C is left out after a break sequence where it ends configuration mode (`ctrlC: 'end'`)
 * and the command was typed there: a queued Ctrl-C replayed at the prompt would leave the mode.
 */
export function interruptKeys(platform: AnyPlatform, mode?: PromptMode): string[] {
  const p = isModelled(platform) ? PROFILES[platform] : undefined
  const brk = p?.keys.breakSeq
  if (!brk || brk === '\x03') return ['\x03']
  return mode === 'config' && p.keys.ctrlC === 'end' ? [brk] : [brk, '\x03']
}

/** The platform completes a word on space (Junos, PAN-OS: `sh` echoes `show`). */
export function completesOnSpace(platform: AnyPlatform): boolean {
  return isModelled(platform) && PROFILES[platform].completion.space
}

/** The first line of `output` that the platform prints when a command did not run as typed. */
export function deviceError(platform: AnyPlatform, output: string): string | null {
  if (!isModelled(platform)) return null
  const e = PROFILES[platform].errors
  const text = cleanTerminalText(output)
  for (const re of [e.invalid, e.ambiguous, e.incomplete, ...e.other]) {
    const m = re.exec(text)
    if (m) return (text.slice(m.index).split('\n')[0] ?? m[0]).trim()
  }
  return null
}

/** How much of a command's output `commandError` looks at: errors come right after the echo. */
const ERROR_HEAD_LINES = 6

/**
 * The device's error for a command that just ran, or null: `deviceError` on the first lines of the
 * output only, so a long read (`show logging`, a config with a banner) that merely contains an
 * error-shaped line further down is not reported as failed.
 */
export function commandError(platform: AnyPlatform, output: string): string | null {
  const head = cleanTerminalText(output)
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, ERROR_HEAD_LINES)
    .join('\n')
  return head ? deviceError(platform, head) : null
}

/** Words that move the session between privilege levels or off the device, whatever mode they are typed in. */
const PRIVILEGE_WORDS = new Set(['enable', 'disable', 'login', 'logout', 'exit', 'quit', 'end', 'return', 'system-view', 'edit', 'cli', 'start', 'shell', 'bash', 'run'])

/**
 * A single exec-mode line that changes the CLI mode or privilege level (`configure terminal`,
 * `enable`, `disable`, `exit`, Junos `edit`, VRP `system-view`/`quit`/`return`, FortiOS `config …`).
 * Such a line can't be run as one guarded exec command: the session would be left in another mode.
 * `expanded` / `nextMode` / `leavesConfig` come from the guard's classification of the line.
 */
export function changesMode(platform: PlatformId, line: string, v: { expanded: string; nextMode?: string; leavesConfig: boolean; mode: string }): boolean {
  if (v.leavesConfig) return true
  if (v.nextMode && v.nextMode !== v.mode) return true
  if (modeChangeLine(platform, line)) return true
  const typed = line.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const word = v.expanded.trim().split(/\s+/)[0]?.toLowerCase() || typed
  return PRIVILEGE_WORDS.has(word) || PRIVILEGE_WORDS.has(typed)
}

export interface ConfigPlan {
  session: ConfigSession
  /** Typed before the proposal's lines. */
  before: string[]
  /** Typed after them on success (commit, leave). */
  after: string[]
  /** Typed after a failure part-way. */
  abort: string[]
  /** The commit lines inside `after` (PAN-OS names the admin: `commit partial admin <user>`). */
  commit: string[]
  /** Read-only check typed at the exec prompt before entering (PAN-OS pending changes). */
  precheck?: string
}

/** The admin name in a `user@host` prompt (PAN-OS, Junos), or '' when the prompt shows none. */
export function promptUser(prompt: string): string {
  return /^([\w.\-]+)@[\w.\-]/.exec(prompt.trim())?.[1] ?? ''
}

/**
 * How an approved change runs on this platform. Returns an error for proposals that do not fit the
 * platform's model (FortiOS blocks that do not balance, a mode change inside the lines).
 */
export function configPlan(platform: PlatformId, lines: readonly string[], ctx: { user?: string; session?: ConfigSession } = {}): ConfigPlan | { error: string } {
  // A safety net (cli-model safety-net.ts) may apply the change in another session (EOS configure session, Junos commit confirmed).
  const session = ctx.session ?? CONFIG_SESSIONS[platform]
  if (session.blocks) {
    // FortiOS: `config <path>` … `end`, balanced, with nothing outside a block.
    let depth = 0
    for (const l of lines) {
      if (/^config\s+\S/i.test(l)) depth++
      else if (/^end$/i.test(l)) {
        if (--depth < 0) return { error: `"${l}" closes a block that was never opened` }
      } else if (depth === 0) return { error: `"${l}" is outside a "config …" block; FortiOS changes are "config <path>" … "end" blocks` }
      else if (/^(?:abort)$/i.test(l)) return { error: `"${l}" discards the change; leave it out` }
    }
    if (depth !== 0) return { error: 'every "config …" block must end with "end"' }
  }
  // PAN-OS commits only this admin's changes, so it needs the admin name from the `user@host` prompt.
  if (session.commitAs && !/^[\w.\-]+$/.test(ctx.user ?? ''))
    return { error: 'the device prompt shows no admin name ("user@host"), so the commit cannot be limited to this admin\'s changes' }
  const commit = [...(session.commitAs && ctx.user ? session.commitAs(ctx.user) : session.commit)]
  return { session, before: [...session.enter], after: [...commit, ...session.exit], abort: [...session.abort], commit, ...(session.precheck ? { precheck: session.precheck.command } : {}) }
}

/**
 * Lines that switch the CLI context without a mode change the prompt grammar sees, or that change
 * what the session prints (Phase 4 fix-round review X1): NX-OS/EOS `routing-context vrf X`,
 * FortiOS `execute enter <vdom>`, PAN-OS `set system setting target-vsys` / `target`, `set cli
 * scripting-mode`, `set cli config-output-format` (backups would capture another format). Each is
 * a word sequence; a typed word matches when it abbreviates the word.
 */
const CONTEXT_CHANGES: Partial<Record<PlatformId, readonly (readonly string[])[]>> = {
  nxos: [['routing-context', 'vrf']],
  // EOS `cli vrf` is the successor of `routing-context vrf` (Phase 8 A-L4).
  eos: [['routing-context', 'vrf'], ['cli', 'vrf']],
  junos: [['set', 'cli', 'logical-system']],
  fortios: [['execute', 'enter']],
  panos: [
    ['set', 'system', 'setting', 'target-vsys'],
    ['set', 'system', 'setting', 'target'],
    ['set', 'cli', 'scripting-mode'],
    ['set', 'cli', 'config-output-format']
  ]
}

/** The line switches the session's context (VRF, VDOM, vsys) or its output format. */
export function contextChangeLine(platform: PlatformId, line: string): boolean {
  const typed = line.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return (CONTEXT_CHANGES[platform] ?? []).some((seq) => typed.length >= seq.length && seq.every((w, i) => w.startsWith(typed[i]!)))
}

const rootCache = new Map<PlatformId, { words: Set<string>; priority: Map<string, string> }>()

/** Keywords at the top of the tree configuration lines are typed in (with its fallbacks: exec where configuration inherits it). */
function rootWords(platform: PlatformId): { words: Set<string>; priority: Map<string, string> } {
  let out = rootCache.get(platform)
  if (out) return out
  const model = getPlatform(platform)
  out = { words: new Set<string>(), priority: new Map<string, string>() }
  for (const r of model.roots(CONFIG_SESSIONS[platform].linesFrom)) {
    for (const k of r.keywords) out.words.add(k.word!)
    for (const [a, w] of r.priority ?? []) if (!out.priority.has(a)) out.priority.set(a, w.split(' ')[0]!)
  }
  rootCache.set(platform, out)
  return out
}

/** Mode-change words a proposal must not contain on platforms with a wrapper (they are added). */
export function modeChangeLine(platform: PlatformId, line: string): boolean {
  const s = CONFIG_SESSIONS[platform]
  const first = line.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!first) return false
  if (contextChangeLine(platform, line)) return true
  const words = new Set(
    s.blocks
      ? // FortiOS blocks carry their own `config`/`end`; only a session-level exit is out of place.
        ['exit', 'quit', 'logout']
      : !s.enter.length
        ? // Single exec lines (AireOS, FTD): nothing to wrap, but never leave the session.
          ['exit', 'end', 'quit', 'logout']
        : ['configure', 'config', 'end', 'exit', 'quit', 'return', 'commit', 'abort', 'system-view', 'rollback', 'logout', ...[...s.enter, ...s.commit, ...s.exit, ...s.abort].map((l) => l.split(' ')[0]!)]
  )
  if (words.has(first)) return true
  if (!s.blocks && s.enter.length && first === 'conf') return true
  // Any abbreviation the device would accept (`q`, `ex`, `en`, `ret`; review X3): the tree words it
  // abbreviates. When one of them is a mode-change word, or the trees know none of them, the device
  // may read it as that word.
  const { words: known, priority } = rootWords(platform)
  const viaPriority = priority.get(first)
  if (viaPriority) return words.has(viaPriority)
  const candidates = [...known].filter((w) => w.startsWith(first))
  if (candidates.some((w) => words.has(w))) return true
  return !candidates.length && [...words].some((w) => w.startsWith(first))
}

/**
 * The prompt hostname is one the approval was bound to. Hostnames compare like `sameHost`; a device
 * whose prompt shows no hostname (FTD `>`) matches only a binding that had none either (a hop between
 * two such devices cannot be told apart: documented gap).
 */
export const hostBound = (hosts: readonly string[], shown: string): boolean => hosts.some((h) => (h.trim() === '' ? shown.trim() === '' : sameHost(h, shown)))

/** Hostnames a proposal's own lines set (`hostname x`, `set system host-name x` ...), so the prompt may show them afterwards. */
export function hostnamesSetBy(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    const m = /^(?:hostname|switchname|sysname|config\s+sysname|set\s+system\s+host-name|set\s+groups\s+\S+\s+system\s+host-name|set\s+deviceconfig\s+system\s+hostname|set\s+hostname)\s+"?([^\s";]+)"?;?\s*$/i.exec(l.trim())
    if (m) out.push(m[1]!)
  }
  return out
}

/**
 * Hostnames a captured configuration sets, for the backup binding (review B2): the line forms of
 * `hostnamesSetBy` (IOS `hostname`, NX-OS `switchname`, VRP `sysname`, AireOS `config sysname`,
 * Junos `set system host-name` and SRX `set groups nodeN system host-name`, PAN-OS `set
 * deviceconfig system hostname`, FortiOS `set hostname`), plus the brace forms (Junos `host-name
 * x;`, PAN-OS `hostname x;`) and the PAN-OS XML `<hostname>x</hostname>`.
 */
export function configHostnames(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim())
  const out = hostnamesSetBy(lines)
  for (const l of lines) {
    const m = /^(?:host-name|hostname)\s+"?([^\s";{}]+)"?;$/.exec(l) ?? /^<hostname>([^<\s]+)<\/hostname>$/.exec(l)
    if (m) out.push(m[1]!)
  }
  return [...new Set(out)]
}

/** The node hostnames of a Junos SRX chassis cluster (`set groups node0 system host-name a`): one device under several names. */
export function clusterHostnames(text: string): string[] {
  const out: string[] = []
  for (const l of text.split('\n')) {
    const m = /^\s*set\s+groups\s+node\d+\s+system\s+host-name\s+"?([^\s";]+)"?\s*$/i.exec(l)
    if (m) out.push(m[1]!)
  }
  return out
}

/**
 * How a platform's prompt names the device, for the backup binding only (review B1, B8): the
 * disruptive confirmation still compares the whole prompt hostname.
 * - `split`: the device name is the text before this character (ASA `fw/pri/act` and, after a
 *   failover, `fw/sec/act`: unit and role follow the first `/`).
 * - `defaults`: factory prompt names that every unconfigured device shares (VRP `<HUAWEI>`, AireOS
 *   `(Cisco Controller)`); they identify nothing, so the hostname the configuration sets is used.
 */
const BINDING: Partial<Record<PlatformId, { split?: string; defaults?: readonly string[] }>> = {
  asa: { split: '/' },
  ftd: { split: '/' },
  vrp: { defaults: ['huawei'] },
  aireos: { defaults: ['cisco controller'] }
}

/** The device name in a prompt hostname, for the backup binding (ASA `fw/sec/act` → `fw`). */
export function bindingHostname(platform: AnyPlatform, shown: string): string {
  const b = isModelled(platform) ? BINDING[platform] : undefined
  const h = shown.trim()
  return b?.split && h.includes(b.split) ? h.slice(0, h.indexOf(b.split)).trim() : h
}

/** The prompt shows no name or a factory one (FTD `>`, VRP `<HUAWEI>`), so it cannot tell devices apart. */
export function unbindablePrompt(platform: AnyPlatform, shown: string): boolean {
  const h = bindingHostname(platform, shown).toLowerCase()
  return !h || !!(isModelled(platform) && BINDING[platform]?.defaults?.includes(h))
}

/** Disruptive confirmations compare hostnames the way the user sees them (main, host and the card). */
export const sameHost = (a: string, b: string): boolean => !!a.trim() && !!b.trim() && a.trim().toLowerCase() === b.trim().toLowerCase()
