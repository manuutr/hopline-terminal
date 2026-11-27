import { classify, detectMode } from '@hopline/guard'
import { netLineAllowed } from '@hopline/cli-model'
import { hostBound, isModelled, sameHost, type AnyPlatform } from '@shared/cli'
import { policyBlocked, type BlockRules } from '@shared/policy-deny'

export type HostKind = 'read' | 'config' | 'disruptive'

export { sameHost } from '@shared/cli'

/**
 * Config and disruptive verdicts must name the device they were approved for (review M2). A verdict
 * without a hostname binding is refused, so a main-side caller that forgets it fails closed.
 */
export function bindingRefusal(kind: HostKind, hosts: readonly string[] | undefined): string | null {
  return kind !== 'read' && !hosts?.length ? 'refused by session host: this change is not bound to a device (no approved hostname in its verdict)' : null
}

/**
 * The team policy's extra blocked commands (sent by main at init), checked here again: main
 * refuses them before signing, so a verdict for one means main was bypassed.
 */
export function policyRefusal(rules: BlockRules, platform: AnyPlatform, command: string, probe?: readonly string[]): string | null {
  // An unidentified device (the auto-detect probe, review L8): the command is checked against every
  // platform it was signed for, and the "all" rules (an invalid policy blocks everything).
  const platforms = platform === 'auto' ? [...(probe ?? []), 'auto'] : [platform]
  for (const p of platforms) {
    const denied = policyBlocked(rules, p, command)
    if (denied) return `refused by session host: ${denied}`
  }
  return null
}

/** Read-only mode was on when main signed: anything but a read is refused here too (review Low 5). */
export function readOnlyRefusal(kind: HostKind, readOnly: boolean | undefined): string | null {
  return readOnly && kind !== 'read' ? 'refused by session host: read-only mode is on, so only read-only commands are sent' : null
}

/**
 * The session host's second enforcement point. Read commands only run from exec mode; config
 * lines are classified in the mode the device prompt shows (interface, router, ...), or against
 * every config mode when the prompt is unclear. Blocked commands never run. Disruptive ones run
 * only with a disruptive verdict whose acknowledgement names the host in the device prompt.
 * Returns the refusal reason, or null if the command may run.
 */
export function hostRefusal(command: string, platform: AnyPlatform, kind: HostKind, tail: string, ack?: string, hosts?: readonly string[]): string | null {
  if (!isModelled(platform)) return 'refused by session host: the device platform is not known, so nothing can be classified'
  const { detected, mode } = hostMode(platform, kind, tail)
  // Approved for one device: the prompt must still show it (a nested ssh/telnet hop changes it).
  if (kind !== 'read' && hosts) {
    if (!detected) return 'refused by session host: the device prompt is not recognisable, so it cannot be checked against the device this change was approved for'
    if (!hostBound(hosts, detected.hostname))
      return `refused by session host: the device changed: the prompt shows "${detected.hostname}", but this change was approved for "${hosts.filter(Boolean)[0] ?? '(no hostname)'}" (a nested ssh/telnet session?)`
  }
  const again = classify(command, platform, { mode })
  if (again.kind === 'blocked') return `refused by session host: ${again.reason}`
  // Phase 8 A-L1: at a configuration prompt, a line the config tree does not model is also held to
  // the exec deny-list (FortiOS `execute reboot` in a block, Junos `request system reboot` at [edit]).
  // A modelled config line keeps its config meaning (`crypto pki trustpoint` is config, not the exec form).
  if (mode !== 'exec' && !again.resolved) {
    const asExec = classify(command, platform, { mode: 'exec' })
    if (asExec.kind === 'blocked') return `refused by session host: ${asExec.reason} (exec deny-list, checked at a configuration prompt)`
  }
  if (again.kind === 'disruptive') {
    if (kind !== 'disruptive') return `refused by session host: disruptive command (${again.reason}) without a typed confirmation`
    if (!detected?.hostname) return 'refused by session host: disruptive command, and the device prompt shows no hostname to confirm against'
    if (!ack || !sameHost(ack, detected.hostname)) return `refused by session host: the confirmation does not match the device hostname "${detected.hostname}"`
  }
  if (kind === 'read' && again.kind !== 'read') return 'refused by session host: not a read-only command'
  return null
}

/** The mode the host classifies a line in: exec for reads, else the mode the device prompt shows. */
function hostMode(platform: Parameters<typeof detectMode>[0], kind: HostKind, tail: string) {
  const detected = kind === 'read' ? undefined : detectMode(platform, tail)
  // An unmodelled sub-mode (e.g. `(config-weird)#`) reports as plain `config`: check every mode.
  const unmodelled = detected?.mode === 'config' && (detected.level === 'sub-config' || (!!detected.context && detected.context !== 'config'))
  const mode = detected === undefined ? 'exec' : detected === null || unmodelled ? 'config-any' : detected.mode
  return { detected, mode } as const
}

/**
 * The guard's expanded form of the line, as the host classifies it (Phase 8 review A-L2): on
 * platforms that complete a word on space (Junos, PAN-OS) the executor requires every word the
 * device completed to be this expansion's word. '' when the platform is not modelled or the line
 * did not resolve.
 */
export function hostExpanded(command: string, platform: AnyPlatform, kind: HostKind, tail: string): string {
  if (!isModelled(platform)) return ''
  return classify(command, platform, { mode: hostMode(platform, kind, tail).mode }).expanded
}

/**
 * A safety-net verdict (`net`, signed by main's safety-net flow only): the line skips the deny-list
 * but must match one of the platform's fixed net templates (cli-model safety-net.ts), typed in the
 * template's mode, at the prompt of the device the change was approved for. Config kind only.
 * Returns the refusal reason, or null if the line may run.
 */
export function netRefusal(command: string, platform: AnyPlatform, kind: HostKind, tail: string, hosts?: readonly string[]): string | null {
  if (kind !== 'config') return 'refused by session host: a safety-net line must be a config verdict'
  if (!isModelled(platform)) return 'refused by session host: the device platform is not known, so nothing can be classified'
  if (!hosts?.length) return 'refused by session host: this change is not bound to a device (no approved hostname in its verdict)'
  const detected = detectMode(platform, tail)
  if (!detected) return 'refused by session host: the device prompt is not recognisable, so it cannot be checked against the device this change was approved for'
  if (!hostBound(hosts, detected.hostname))
    return `refused by session host: the device changed: the prompt shows "${detected.hostname}", but this change was approved for "${hosts.filter(Boolean)[0] ?? '(no hostname)'}" (a nested ssh/telnet session?)`
  // A config template holds in any configuration level (EOS commits from a sub-mode, Junos from any [edit] path).
  const mode = detected.level === 'exec' || detected.level === 'user' ? 'exec' : 'config'
  if (!netLineAllowed(platform, command, mode)) return `refused by session host: "${command}" is not one of this platform's safety-net lines (in ${mode} mode)`
  return null
}
