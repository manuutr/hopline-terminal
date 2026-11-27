import { isIpLiteral, PROBE_CAPS, probeOf, type ProbeInfo } from '@hopline/cli-model'
import type { SessionPlatform } from '@shared/types'
import { isModelled } from '@shared/cli'

/**
 * The reach rule for ping and traceroute run by a model (review M6, Phase 8 H1/H3).
 *
 * The probe is parsed by cli-model `probeOf`, on the guard's own canonical form: abbreviations
 * (`pi`, `tr`, `rep`, `cou`) are expanded, `do`/`run` wrappers removed and vendor verbs (FortiOS
 * `execute ping`) recognised, so no spelling gets past it. Nothing here matches raw tokens.
 *
 * - The guard already makes a probe past the caps (`PROBE_CAPS`: count, size, timeout, TTL), a flood,
 *   a payload or an unknown option `config`; a model's read path never runs those.
 * - The target must be an IP literal: a name is a DNS query, a channel out of the network
 *   (hex-encoded data in the labels, answered by the attacker's name server).
 *   - Single-device agent (`agentReach`): a name target is not auto-run; it becomes a one-click
 *     approval card, and in read-only mode it is refused.
 *   - Fleet worker (`reachRefusal`): refused, and the address must also appear in this lane's own
 *     output or task (a worker checks something it was shown, it does not scan).
 */

export const MAX_PING_COUNT = PROBE_CAPS.count
export const MAX_PING_SIZE = PROBE_CAPS.size
export const MAX_PING_TIMEOUT_S = PROBE_CAPS.timeoutS

function probe(command: string, platform: SessionPlatform): ProbeInfo | null {
  return isModelled(platform) ? probeOf(platform, 'exec', command) : null
}

const bare = (t: string) => t.replace(/^\[(.*)\]$/, '$1')

/** For the single-device agent: why this probe needs the user's click (a name target), or null. */
export function agentReach(command: string, platform: SessionPlatform): string | null {
  const p = probe(command, platform)
  if (!p) return null
  const name = p.targets.find((t) => !isIpLiteral(t))
  return name ? `${p.verb} to a name ("${name}") makes the device look it up in DNS, which can carry data out of the network` : null
}

/** For a fleet worker: the refusal reason, or null if the command is not a probe or passes. */
export function reachRefusal(command: string, platform: SessionPlatform, known: (ip: string) => boolean): string | null {
  const p = probe(command, platform)
  if (!p) return null
  if (p.problems.length) return `${p.verb} outside the fleet limits: ${p.problems.join('; ')}`
  if (!p.targets.length) return `${p.verb} needs a target address here: a fleet worker can't use the interactive form`
  for (const t of p.targets) {
    if (!isIpLiteral(t)) return `${p.verb} to a name is not allowed in a fleet run (a name is a DNS lookup): use an IP address from this device's output`
    if (!known(bare(t))) return `${bare(t)} does not appear in this device's output or task: a fleet worker only probes addresses it was shown`
  }
  return null
}

/** Whether `ip` appears as a whole address in `text`. */
export function mentions(text: string, ip: string): boolean {
  const esc = ip.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^0-9a-f:.])${esc}($|[^0-9a-f:.]|\\.(?![0-9]))`, 'i').test(text)
}
