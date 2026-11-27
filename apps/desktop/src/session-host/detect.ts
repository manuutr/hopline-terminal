import { classify, fingerprint, probeCommand, type Evidence } from '@hopline/guard'
import { PROFILES, type PlatformId } from '@hopline/cli-model'
import { cleanTerminalText, LOGIN_PROMPT, promptState } from '@shared/cli'

/** What a tab has observed passively (HostTab.observed). */
export interface Observed {
  sshServerVersion?: string
  banner: string
  tail: string
  /** Since the device last printed anything. */
  quietMs: number
  /** Since the user last typed. */
  idleMs: number
}

/** The device must have been silent this long, and the user idle this long, before a probe. */
export const QUIET_MS = 700
export const USER_IDLE_MS = 1500

/** Evidence for `fingerprint`, from what the tab saw: no command was sent to get it. */
export function evidenceOf(o: Observed): Evidence {
  const lines = cleanTerminalText(o.tail).split('\n')
  return {
    ...(o.sshServerVersion ? { sshServerVersion: o.sshServerVersion } : {}),
    ...(o.banner ? { banner: cleanTerminalText(o.banner) } : {}),
    // The prompt line plus the two above it (Junos/PAN-OS print [edit] and {master} there).
    prompt: lines.slice(-3).join('\n')
  }
}

/**
 * True when it is safe to type on an unidentified device: the last line is an idle prompt of some
 * platform (not a login, password, pager or question), the device has been quiet and the user has
 * not typed recently (the executor's input lock would silently drop their keystrokes).
 */
export function idleAtPrompt(o: Observed): boolean {
  if (o.quietMs < QUIET_MS || o.idleMs < USER_IDLE_MS) return false
  const p = promptState(o.tail, 'auto')
  return p.mode !== 'unknown' && !p.pending.trim()
}

/** What the screen ends with: detection waits for this to change before looking again. */
export const screenKey = (o: Observed): string => cleanTerminalText(o.tail).slice(-256)

/** How long a device may sit quiet on an unrecognised line before detection gives up on it. */
export const SETTLE_MS = 3000

/**
 * Detection can stop waiting: the device is at a prompt, or it has settled on something that is
 * neither a prompt nor a login (an unmodelled CLI, a menu): waiting longer would not help.
 * While a login or password prompt shows, it keeps waiting for the user.
 */
export function settled(o: Observed): 'prompt' | 'other' | null {
  if (idleAtPrompt(o)) return 'prompt'
  const last = cleanTerminalText(o.tail).split('\n').at(-1) ?? ''
  if (o.quietMs >= SETTLE_MS && o.idleMs >= SETTLE_MS && last.trim() && !LOGIN_PROMPT.test(last)) return 'other'
  return null
}

/**
 * The session host's check of an auto-detect probe: the device is idle at a prompt, the command is
 * exactly the probe the host itself would choose from its own evidence, or a candidate's own version
 * command, and it is read-only on every candidate the verdict names. Returns the refusal, or null.
 */
export function probeRefusal(command: string, candidates: readonly PlatformId[] | undefined, o: Observed): string | null {
  if (!candidates?.length) return 'refused by session host: probe without candidate platforms'
  if (!idleAtPrompt(o)) return 'refused by session host: the device is not idle at a prompt (logging in, busy, or the user is typing)'
  // The probe the host would pick from what it saw itself, or one of the candidates' own version commands.
  const own = probeCommand(fingerprint(evidenceOf(o))).command
  if (command !== own && !candidates.some((p) => PROFILES[p]?.probe === command)) return 'refused by session host: not the probe for this device'
  for (const p of candidates) if (classify(command, p).kind !== 'read') return `refused by session host: the probe is not read-only on ${p}`
  return null
}
