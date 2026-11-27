import { canonicalize } from './canonical'
import { matchWord } from './words'
import type { ModeId, PlatformId, Risk } from './types'

/**
 * Reachability probes (ping, traceroute) on every platform, parsed with the shared canonicaliser
 * (Phase 8 review H2/H3). The command trees accept their options through an open `...`, so the
 * options are resolved here, against a per-platform vocabulary, with the device's prefix rule.
 *
 * One parse feeds two rules:
 *  - the guard (`probeRisk`): a probe past the caps (count, size, timeout, TTL), a flood, a
 *    never-ending form, a payload or an option Hopline does not know is `config`, never `read`;
 *  - the agent and fleet reach rule (apps/desktop main/fleet/reach.ts): the target must be an IP
 *    literal (a name is a DNS lookup, a channel out of the network).
 */

export const PROBE_CAPS = {
  /** Echo requests or probes per hop. */
  count: 10,
  /** Datagram size, bytes. */
  size: 1500,
  /** Per-reply timeout, seconds. */
  timeoutS: 5,
  /** Highest TTL a traceroute walks (most paths are under 30 hops). */
  ttl: 64
} as const

export type ProbeVerb = 'ping' | 'traceroute'

type OptKind =
  /** Echo requests (ping) or probes per hop (traceroute). */
  | 'count'
  | 'size'
  | 'timeout'
  | 'interval'
  | 'ttl'
  /** Two TTL values: min and max (IOS/ASA `ttl 1 30`). */
  | 'ttl-range'
  /** Sends as fast as possible (Junos `rapid`): allowed while the count is within the cap. */
  | 'rapid'
  /** A pattern or data the model chooses goes on the wire. */
  | 'payload'
  /** An address or an interface the probe is sourced from. */
  | 'source'
  /** The destination given as an option (PAN-OS `host X`). */
  | 'target'
  /** Takes one plain value that is not a name lookup (vrf, interface, tos, port …). */
  | 'value'
  /** A flag with no value. */
  | 'flag'

interface Opt {
  kind: OptKind
  /** Unit of a time value: the cap is in seconds; `ms` options are divided by 1000. */
  ms?: boolean
}

interface ProbeSpec {
  /** Canonical command heads (expanded keyword paths) and what they are. */
  verbs: Readonly<Record<string, ProbeVerb>>
  options: Readonly<Record<ProbeVerb, Readonly<Record<string, Opt>>>>
  /** Options start with `-` (VRP). */
  dash?: boolean
  /** One plain word may stand before the target (ASA/FTD interface name). */
  leadingWord?: boolean
  /** The ping never stops without a count (Junos, PAN-OS); `rapid` also bounds it on Junos. */
  needsCount?: boolean
  /** The destination is only given through an option (PAN-OS `host`). */
  targetOption?: boolean
}

const o = (kind: OptKind, ms?: boolean): Opt => (ms ? { kind, ms } : { kind })
const flags = (...w: string[]) => Object.fromEntries(w.map((x) => [x, o('flag')]))
const values = (...w: string[]) => Object.fromEntries(w.map((x) => [x, o('value')]))

const IOS: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  options: {
    ping: { repeat: o('count'), size: o('size'), timeout: o('timeout'), source: o('source'), data: o('payload'), ...flags('df-bit', 'validate', 'verbose', 'ip', 'ipv6'), ...values('vrf', 'tos', 'egress', 'ingress') },
    traceroute: { probe: o('count'), timeout: o('timeout'), ttl: o('ttl-range'), source: o('source'), ...flags('numeric', 'ip', 'ipv6'), ...values('vrf', 'port') }
  }
}
const SB: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  options: {
    ping: { count: o('count'), size: o('size'), timeout: o('timeout', true), ...flags('ip', 'ipv6') },
    traceroute: { size: o('size'), ttl: o('ttl'), count: o('count'), timeout: o('timeout'), source: o('source'), ...flags('ip', 'ipv6') }
  }
}
const NXOS_PING = { count: o('count'), 'packet-size': o('size'), timeout: o('timeout'), interval: o('interval'), source: o('source'), 'source-interface': o('source'), ...flags('df-bit', 'multicast'), ...values('vrf', 'interface') }
const NXOS: ProbeSpec = {
  verbs: { ping: 'ping', ping6: 'ping', traceroute: 'traceroute', traceroute6: 'traceroute' },
  options: { ping: NXOS_PING, traceroute: { source: o('source'), 'source-interface': o('source'), ...flags('show-mpls-hops'), ...values('vrf') } }
}
const EOS: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  options: {
    ping: { repeat: o('count'), size: o('size'), timeout: o('timeout'), interval: o('interval'), source: o('source'), interface: o('source'), ...flags('df-bit', 'ip', 'ipv6'), ...values('vrf') },
    traceroute: { source: o('source'), ...flags('ip', 'ipv6'), ...values('vrf') }
  }
}
const IOSXR: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  options: {
    ping: { count: o('count'), size: o('size'), timeout: o('timeout'), source: o('source'), pattern: o('payload'), ...flags('donnotfrag', 'verbose', 'ipv4', 'ipv6'), ...values('vrf', 'type', 'priority') },
    traceroute: { probe: o('count'), timeout: o('timeout'), source: o('source'), maxttl: o('ttl'), minttl: o('ttl'), ...flags('numeric', 'verbose', 'ipv4', 'ipv6'), ...values('vrf', 'port', 'priority') }
  }
}
const ASA: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  leadingWord: true,
  options: {
    ping: { repeat: o('count'), size: o('size'), timeout: o('timeout'), data: o('payload'), ...flags('validate') },
    traceroute: { probe: o('count'), timeout: o('timeout'), ttl: o('ttl-range'), source: o('source'), ...flags('numeric', 'use-icmp'), ...values('port') }
  }
}
const FTD: ProbeSpec = { ...ASA, options: { ping: { ...ASA.options.ping, ...flags('system') }, traceroute: { ...ASA.options.traceroute, ...flags('system') } } }
const JUNOS: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  needsCount: true,
  options: {
    ping: {
      count: o('count'),
      size: o('size'),
      interval: o('interval'),
      rapid: o('rapid'),
      wait: o('timeout'),
      ttl: o('ttl'),
      source: o('source'),
      pattern: o('payload'),
      ...flags('do-not-fragment', 'bypass-routing', 'inet', 'inet6', 'no-resolve', 'detail', 'record-route', 'strict'),
      ...values('routing-instance', 'interface', 'tos', 'logical-system')
    },
    traceroute: { wait: o('timeout'), ttl: o('ttl'), source: o('source'), ...flags('no-resolve', 'inet', 'inet6', 'as-number-lookup', 'propagate-ttl'), ...values('routing-instance', 'interface', 'tos', 'logical-system') }
  }
}
const PANOS: ProbeSpec = {
  verbs: { ping: 'ping', traceroute: 'traceroute' },
  needsCount: true,
  targetOption: true,
  options: {
    ping: { count: o('count'), size: o('size'), interval: o('interval'), wait: o('timeout'), ttl: o('ttl'), source: o('source'), host: o('target'), pattern: o('payload'), ...flags('bypass-routing', 'do-not-fragment', 'inet6', 'no-resolve', 'verbose'), ...values('tos') },
    traceroute: { host: o('target'), 'first-ttl': o('ttl'), 'max-ttl': o('ttl'), wait: o('timeout'), source: o('source'), ...flags('ipv4', 'ipv6', 'no-resolve', 'do-not-fragment', 'bypass-routing'), ...values('port', 'tos', 'pause') }
  }
}
const FORTIOS: ProbeSpec = {
  // Options are set beforehand with `execute ping-options …` (a config-class command).
  verbs: { 'execute ping': 'ping', 'execute ping6': 'ping', 'execute traceroute': 'traceroute', 'execute tracert6': 'traceroute' },
  options: { ping: {}, traceroute: {} }
}
const AOSCX: ProbeSpec = {
  verbs: { ping: 'ping', ping6: 'ping', traceroute: 'traceroute', traceroute6: 'traceroute' },
  options: {
    ping: { repetitions: o('count'), 'datagram-size': o('size'), timeout: o('timeout'), interval: o('interval'), source: o('source'), 'data-fill': o('payload'), ...flags('do-not-fragment'), ...values('vrf', 'tos', 'ip-option') },
    traceroute: { probes: o('count'), timeout: o('timeout'), maxttl: o('ttl'), minttl: o('ttl'), source: o('source'), ...values('vrf', 'dstport', 'ip-option') }
  }
}
const VRP: ProbeSpec = {
  verbs: { ping: 'ping', tracert: 'traceroute' },
  dash: true,
  options: {
    ping: { c: o('count'), s: o('size'), t: o('timeout', true), m: o('interval', true), a: o('source'), i: o('source'), p: o('payload'), h: o('ttl'), ...flags('f', 'n', 'q', 'r', 'v', 'd', 'ip', 'ipv6'), ...values('vpn-instance', 'tos') },
    traceroute: { q: o('count'), w: o('timeout', true), m: o('ttl'), f: o('ttl'), a: o('source'), ...flags('n', 'v', 'ipv6'), ...values('vpn-instance', 'p') }
  }
}
const AIREOS: ProbeSpec = { verbs: { ping: 'ping' }, options: { ping: {}, traceroute: {} } }

const SPECS: Readonly<Record<PlatformId, ProbeSpec>> = {
  ios: IOS,
  iosxe: IOS,
  c9800: IOS,
  ciscosb: SB,
  nxos: NXOS,
  iosxr: IOSXR,
  asa: ASA,
  ftd: FTD,
  eos: EOS,
  junos: JUNOS,
  panos: PANOS,
  fortios: FORTIOS,
  aoscx: AOSCX,
  vrp: VRP,
  aireos: AIREOS
}

export interface ProbeOption {
  /** Canonical option word (`rep` → `repeat`). */
  word: string
  kind: OptKind
  /** The value(s) as typed. */
  values: string[]
}

export interface ProbeInfo {
  verb: ProbeVerb
  /** Canonical head (`ping`, `execute ping`). */
  head: string
  /** Destinations: positional words and a `host` option. */
  targets: string[]
  /** A plain word before the target (ASA interface name). */
  leading?: string
  options: ProbeOption[]
  /** What makes this probe more than a bounded read, for the guard (empty: within the caps). */
  problems: string[]
}

const NUM = /^\d{1,9}(?:\.\d{1,3})?$/

/** An IPv4 or IPv6 literal (no name, no prefix length, optional `[...]` around IPv6). */
export function isIpLiteral(s: string): boolean {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return true
  const t = s.replace(/^\[(.*)\]$/, '$1')
  if (!t.includes(':') || !/^[0-9a-f:.]+$/i.test(t)) return false
  const dbl = t.split('::')
  if (dbl.length > 2) return false
  const groups = (x: string) => (x ? x.split(':') : [])
  const parts = [...groups(dbl[0]!), ...(dbl.length === 2 ? groups(dbl[1]!) : [])]
  let n = parts.length
  const last = parts.at(-1)
  if (last?.includes('.')) {
    if (!t.endsWith(last) || !isIpLiteral(last)) return false
    parts.pop()
    n++ // the IPv4 tail fills two groups
  }
  if (!parts.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false
  return dbl.length === 2 ? n <= 7 : n === 8
}

/** A source value that is no name lookup: an address, or an interface name (`Gi0/0.100`, `lo0`, `inside`). */
export function isSourceValue(s: string): boolean {
  return isIpLiteral(s) || (/^[A-Za-z][\w/:.-]{0,63}$/.test(s) && !/\.[A-Za-z]/.test(s))
}

/** A plain option value (vrf name, interface, number): letters, digits and `_-/:.` with no dotted name. */
const isPlainValue = (s: string) => /^[\w/:.-]{1,64}$/.test(s) && !/\.[A-Za-z]/.test(s)

/** Parse a ping or traceroute (any platform, any mode; `do`/`run` wrappers included). Null if the line is not one. */
export function probeOf(platform: PlatformId, mode: ModeId, line: string): ProbeInfo | null {
  const spec = SPECS[platform]
  if (!spec) return null
  const c = canonicalize(platform, mode, line)
  let verb: ProbeVerb | undefined
  let used = 0
  // Longest canonical head first (`execute ping` before `execute`).
  for (let n = Math.min(c.head.length, 2); n >= 1 && !verb; n--) {
    const v = spec.verbs[c.head.slice(0, n).join(' ')]
    if (v) {
      verb = v
      used = n
    }
  }
  if (!verb) return null
  // Keywords the tree resolved after the verb (`ping vrf X ip …`) are typed words like the rest.
  const args = [...c.head.slice(used), ...c.rest]
  const vocab = spec.options[verb]
  const words = Object.keys(vocab)
  const info: ProbeInfo = { verb, head: c.head.slice(0, used).join(' '), targets: [], options: [], problems: [] }
  const problem = (p: string) => info.problems.push(p)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    // Dash platforms (VRP): options are `-c 5`; a plain word is an option only when spelled out (`ipv6`).
    const dashed = !!spec.dash && /^-[A-Za-z]/.test(a)
    const isOpt = spec.dash ? dashed || words.includes(a.toLowerCase()) : !isIpLiteral(a) && /^[A-Za-z]/.test(a)
    const typed = dashed ? a.slice(1) : a
    const m = isOpt ? matchWord(words, typed) : null
    if (m && 'ambiguous' in m) {
      problem(`"${a}" is ambiguous here (${m.ambiguous.join(', ')})`)
      continue
    }
    if (!m) {
      if (dashed) {
        problem(`Hopline doesn't recognise the ${verb} option "${a}"`)
        continue
      }
      // A positional word: the destination, or the ASA interface name before it.
      info.targets.push(a)
      continue
    }
    const opt = vocab[m.word]!
    const take = opt.kind === 'flag' || opt.kind === 'rapid' ? 0 : opt.kind === 'ttl-range' ? 2 : 1
    const vals = args.slice(i + 1, i + 1 + take)
    i += take
    info.options.push({ word: m.word, kind: opt.kind, values: vals })
    if (vals.length < take) {
      problem(`"${m.word}" needs a value`)
      continue
    }
    const num = (v: string) => (NUM.test(v) ? Number(v) : NaN)
    const label = spec.dash ? `-${m.word}` : m.word
    switch (opt.kind) {
      case 'count': {
        const n = num(vals[0]!)
        if (!(n >= 1 && n <= PROBE_CAPS.count && Number.isInteger(n))) problem(`${label} ${vals[0]}: at most ${PROBE_CAPS.count} without approval`)
        break
      }
      case 'size': {
        const n = num(vals[0]!)
        if (!(n >= 0 && n <= PROBE_CAPS.size)) problem(`${label} ${vals[0]}: at most ${PROBE_CAPS.size} bytes without approval`)
        break
      }
      case 'timeout': {
        const n = num(vals[0]!) / (opt.ms ? 1000 : 1)
        if (!(n >= 0 && n <= PROBE_CAPS.timeoutS)) problem(`${label} ${vals[0]}: at most ${PROBE_CAPS.timeoutS} s${opt.ms ? ` (${PROBE_CAPS.timeoutS * 1000} ms)` : ''} without approval`)
        break
      }
      case 'interval':
        if (Number.isNaN(num(vals[0]!))) problem(`${label} ${vals[0]}: not a number`)
        break
      case 'ttl':
      case 'ttl-range':
        for (const v of vals) {
          const n = num(v)
          if (!(n >= 0 && n <= PROBE_CAPS.ttl && Number.isInteger(n))) problem(`${label} ${v}: at most ${PROBE_CAPS.ttl} without approval`)
        }
        break
      case 'payload':
        problem(`${label}: a chosen payload goes on the wire`)
        break
      case 'source':
        if (!isSourceValue(vals[0]!)) problem(`${label} ${vals[0]}: must be an address or an interface`)
        break
      case 'target':
        info.targets.push(vals[0]!)
        break
      case 'value':
        if (!isPlainValue(vals[0]!)) problem(`${label} ${vals[0]}: not a plain value`)
        break
    }
  }
  if (spec.leadingWord && info.targets.length === 2 && isPlainValue(info.targets[0]!) && !isIpLiteral(info.targets[0]!)) info.leading = info.targets.shift()
  if (info.targets.length > 1) problem(`Hopline doesn't recognise "${info.targets.slice(0, -1).join(' ')}" in this ${verb}`)
  if (!info.targets.length) problem(`${verb} has no destination here (the interactive form asks questions)`)
  const has = (k: OptKind) => info.options.some((x) => x.kind === k)
  if (verb === 'ping' && spec.needsCount && !has('count') && !(platform === 'junos' && has('rapid')))
    problem(`${platform === 'junos' ? 'Junos' : 'PAN-OS'} ping runs until interrupted; add a count (at most ${PROBE_CAPS.count})`)
  return info
}

/** The guard's rule: a probe outside the caps needs approval (`config`). Undefined: within them, or not a probe. */
export function probeRisk(platform: PlatformId, mode: ModeId, line: string): { risk: Risk; reason: string } | undefined {
  const p = probeOf(platform, mode, line)
  if (!p || !p.problems.length) return undefined
  return { risk: 'config', reason: `${p.verb} outside the read-only limits (${p.problems.join('; ')})` }
}
