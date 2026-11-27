import { isPlatform, type Platform } from '@hopline/guard'
import { canonicalize, PROFILES, type ModeId } from '@hopline/cli-model'

/**
 * The team policy's extra blocked commands (docs/POLICY.md), merged into the deny-list in main
 * (`SessionHostClient.exec`, before anything is signed) and checked again in the session host.
 * Node only (main and the session host); the renderer never imports it.
 *
 * Matching is on words, not raw text, so abbreviations do not get around it:
 *  - the command goes through the shared canonicaliser (cli-model `canonicalize`, the guard's own
 *    resolution, `do`/`run` removed) in exec and every config mode, and its canonical head
 *    (`sh run` → `show running-config`) is compared word by word, exactly;
 *  - words past what the guard resolved (unmodelled arguments, `snmp comm x`) match when they are
 *    a prefix of the pattern word (an abbreviation): this can only block more, never less;
 *  - the pattern itself is expanded the same way, so an admin may write `sh run`.
 * A pattern matches the start of the command (the part before any pipe included).
 */

export type BlockRules = Readonly<Record<string, readonly string[]>>

interface Candidate {
  exact: string[]
  loose: string[]
}

/** Lowercased words before the first pipe (only for text no tree resolves at all). */
const plainWords = (s: string): string[] =>
  s
    .toLowerCase()
    .split('|')[0]!
    .trim()
    .split(/\s+/)
    .filter(Boolean)

function modesOf(platform: Platform): ModeId[] {
  return ['exec', ...PROFILES[platform].modes.filter((m) => m.level === 'config' || m.level === 'sub-config').map((m) => m.id)]
}

/**
 * The line through the shared canonicaliser (cli-model canonical.ts, the same resolution the guard
 * and the reach rule use), in exec and every configuration mode: the expanded head compares
 * exactly, the words after it as abbreviations.
 */
function candidates(command: string, platform: Platform): Candidate[] {
  const out: Candidate[] = [{ exact: plainWords(command), loose: [] }]
  for (const mode of modesOf(platform)) {
    const c = canonicalize(platform, mode, command)
    if (c.head.length) out.push({ exact: c.head, loose: c.rest.map((w) => w.toLowerCase()) })
  }
  return out
}

function patternWords(pattern: string, platform: Platform): string[][] {
  const out = [plainWords(pattern)]
  for (const mode of modesOf(platform)) {
    const c = canonicalize(platform, mode, pattern)
    if (c.head.length) out.push([...c.head, ...c.rest.map((w) => w.toLowerCase())])
  }
  return out
}

function matches(cand: Candidate, pat: string[]): boolean {
  const all = [...cand.exact, ...cand.loose]
  if (all.length < pat.length || !pat.length) return false
  for (let i = 0; i < pat.length; i++) {
    const w = all[i]!
    const p = pat[i]!
    if (i < cand.exact.length ? w !== p : !p.startsWith(w)) return false
  }
  return true
}

/**
 * An invalid policy file fails closed (main/policy/policy.ts FAIL_CLOSED): this rule, under "all",
 * refuses every command Hopline sends, on every platform and on a device not identified yet. It
 * cannot come from a policy file (patterns are printable ASCII).
 */
export const POLICY_INVALID_RULE = '\u0000policy-invalid'
const INVALID_REFUSAL = 'blocked by team policy (the policy file is invalid, so Hopline Terminal sends no commands; ask your administrator to fix it)'

/**
 * Commands that print the whole configuration (or a saved copy, a diff or a candidate of it), per
 * platform (review M3). A blocked pattern that covers one of them (`show running-config`, `sh run`,
 * `show`) blocks the whole group, so `show configuration` or `show system rollback 0` cannot print
 * the configuration a policy meant to keep from a model. A narrower pattern (`show running-config
 * interface`) is not widened.
 */
// Every file-system spelling of the running and startup configuration (Phase 8 M2).
const MORE = ['more system:running-config', 'more system:/running-config', 'more nvram:startup-config', 'more nvram:/startup-config', 'more running-config:', 'more startup-config:']
const CISCO = ['show running-config', 'show startup-config', 'write terminal', ...MORE]
// `show archive config …` / `show archive log config …` print configuration; bare `show archive`
// only lists the archive files, and the IOS-XE safety net reads it, so it stays allowed.
const IOS_DUMPS = [...CISCO, 'show configuration', 'show archive config', 'show archive log', 'show derived-config']
export const CONFIG_DUMPS: Readonly<Partial<Record<Platform, readonly string[]>>> = {
  ios: IOS_DUMPS,
  iosxe: IOS_DUMPS,
  c9800: IOS_DUMPS,
  ciscosb: ['show running-config', 'show startup-config', 'show configuration'],
  iosxr: ['show running-config', 'show configuration', 'show startup-config', 'admin show running-config', 'admin show configuration', ...MORE],
  nxos: [...CISCO, 'show checkpoint', 'show diff rollback-patch', 'show configuration'],
  asa: [...CISCO, 'show configuration'],
  ftd: ['show running-config', 'show startup-config', 'show configuration'],
  eos: [...CISCO, 'show session-config'],
  junos: ['show configuration', 'show system rollback', 'file show'],
  panos: ['show config running', 'show config candidate', 'show config pushed-template', 'show config pushed-shared-policy', 'show config merged', 'show config saved', 'show config audit', 'show config diff'],
  // FortiOS prints configuration with `show` on any path (bare `show`, `show system global`).
  fortios: ['show', 'show full-configuration'],
  aoscx: ['show running-config', 'show startup-config', 'show checkpoint'],
  vrp: ['display current-configuration', 'display saved-configuration', 'display configuration', 'display this'],
  aireos: ['show run-config', 'show running-config']
}

/** The rules that apply to a platform: its own plus "all". */
export function rulesFor(rules: BlockRules, platform: string): string[] {
  return [...(rules['all'] ?? []), ...(rules[platform] ?? [])]
}

/** The first pattern that blocks this command, or null. */
function hit(pats: readonly string[], platform: Platform, command: string): string | null {
  const cands = candidates(command, platform)
  for (const p of pats) for (const pw of patternWords(p, platform)) if (cands.some((c) => matches(c, pw))) return p
  return null
}

/** The policy refusal for this command on this platform, or null. */
export function policyBlocked(rules: BlockRules, platform: string, command: string): string | null {
  const pats = rulesFor(rules, platform)
  if (!pats.length) return null
  if (pats.includes(POLICY_INVALID_RULE)) return INVALID_REFUSAL
  if (!isPlatform(platform)) return null // an unknown platform is refused by the guard anyway
  const direct = hit(pats, platform, command)
  if (direct) return `blocked by team policy ("${direct}")`
  // A pattern that blocks a whole configuration dump blocks every equivalent dump command.
  const dumps = CONFIG_DUMPS[platform] ?? []
  const dumpPattern = pats.find((p) => dumps.some((d) => hit([p], platform, d)))
  if (dumpPattern && hit(dumps, platform, command)) return `blocked by team policy ("${dumpPattern}": it prints the configuration)`
  return null
}
