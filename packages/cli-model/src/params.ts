import type { InterfaceSyntax, LiveSource, ParamDef } from './types'

/**
 * Parameter shorthands used by the tree DSL (`<if>`, `<vlan>`, `<1-100>` …).
 * Labels follow the Cisco `?` conventions; each platform tree may override help text.
 */
const P = (kind: ParamDef['kind'], label: string, help: string, extra: Partial<ParamDef> = {}): ParamDef => ({ kind, label, help, ...extra })

export const PARAMS: Readonly<Record<string, ParamDef>> = {
  if: P('interface', '<interface>', 'Interface name', { live: 'interfaces', capture: 'interface' }),
  vlan: P('int', '<1-4094>', 'VLAN ID', { min: 1, max: 4094, live: 'vlans', capture: 'vlan' }),
  vlans: P('range-list', 'WORD', 'VLAN IDs, e.g. 10,20-30', { min: 1, max: 4094, live: 'vlans', capture: 'vlan' }),
  vrf: P('word', 'WORD', 'VRF name', { live: 'vrfs', capture: 'vrf' }),
  ip: P('ipv4', 'A.B.C.D', 'IPv4 address', { capture: 'ip' }),
  mask: P('ipv4', 'A.B.C.D', 'Network mask', { capture: 'mask' }),
  wildcard: P('ipv4', 'A.B.C.D', 'Wildcard bits', { capture: 'wildcard' }),
  ip6: P('ipv6', 'X:X:X:X::X', 'IPv6 address', { capture: 'ip' }),
  prefix: P('ipv4-prefix', 'A.B.C.D/nn', 'IPv4 prefix', { capture: 'prefix' }),
  prefix6: P('ipv6-prefix', 'X:X:X:X::X/<0-128>', 'IPv6 prefix', { capture: 'prefix' }),
  addr: P('ip', 'A.B.C.D|X:X::X', 'IP address', { capture: 'ip' }),
  net: P('ip-or-prefix', 'A.B.C.D[/nn]', 'Address or prefix', { capture: 'prefix' }),
  host: P('host', 'WORD', 'Address or hostname', { capture: 'host' }),
  nbr: P('ip', 'A.B.C.D', 'BGP neighbor address', { live: 'bgp-neighbors', capture: 'neighbor' }),
  'ospf-nbr': P('ipv4', 'A.B.C.D', 'OSPF neighbor router ID', { live: 'ospf-neighbors', capture: 'neighbor' }),
  rm: P('word', 'WORD', 'Route-map name', { live: 'route-maps', capture: 'routeMap' }),
  pl: P('word', 'WORD', 'Prefix-list name', { live: 'prefix-lists', capture: 'prefixList' }),
  acl: P('word', 'WORD', 'Access-list name or number', { live: 'acls', capture: 'acl' }),
  policy: P('word', '<policy>', 'Policy statement name', { live: 'policy-statements', capture: 'policy' }),
  filter: P('word', '<filter>', 'Firewall filter name', { live: 'firewall-filters', capture: 'filter' }),
  zone: P('word', '<zone>', 'Security zone', { live: 'zones', capture: 'zone' }),
  vdom: P('word', '<vdom>', 'VDOM name', { live: 'vdoms', capture: 'vdom' }),
  checkpoint: P('word', 'WORD', 'Checkpoint name', { live: 'checkpoints', capture: 'checkpoint' }),
  session: P('word', 'WORD', 'Configuration session name', { live: 'config-sessions', capture: 'session' }),
  file: P('path', 'WORD', 'File or URL (flash:, bootflash:, /var/tmp/…)', { live: 'files', capture: 'file' }),
  word: P('word', 'WORD', 'Name or value'),
  name: P('word', 'WORD', 'Name', { capture: 'name' }),
  line: P('line', 'LINE', 'Text up to the end of the line'),
  regex: P('line', 'LINE', 'Regular expression'),
  mac: P('mac', 'H.H.H', 'MAC address', { capture: 'mac' }),
  asn: P('asn', '<1-4294967295>', 'Autonomous system number', { capture: 'asn' }),
  n: P('int', '<0-4294967295>', 'Number', { min: 0, max: 4294967295 }),
  pid: P('int', '<1-65535>', 'Process ID', { min: 1, max: 65535, capture: 'process' }),
  tag: P('word', 'WORD', 'Process tag or ID', { capture: 'process' })
}

/** `<1-4094>` style literal ranges. */
export function rangeParam(min: number, max: number, help = 'Number'): ParamDef {
  return { kind: 'int', label: `<${min}-${max}>`, help, min, max }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^(?=.*:)[0-9a-f:.]{2,45}$/i

export const isIpv4 = (s: string): boolean => IPV4.test(s)
const isIpv6 = (s: string): boolean => IPV6.test(s) && (s.match(/::/g)?.length ?? 0) <= 1
function isPrefix(s: string, v6: boolean): boolean {
  const slash = s.indexOf('/')
  if (slash < 0) return false
  const len = s.slice(slash + 1)
  if (!/^\d{1,3}$/.test(len)) return false
  const n = Number(len)
  return v6 ? isIpv6(s.slice(0, slash)) && n <= 128 : isIpv4(s.slice(0, slash)) && n <= 32
}

/**
 * How many tokens `def` consumes at `tokens[i]` (0 = no match).
 * Interfaces may take two tokens on Cisco/Arista ("Gi 1/0/1").
 */
export function matchParam(def: ParamDef, tokens: readonly string[], i: number, ifs: InterfaceSyntax): number {
  const t = tokens[i]
  if (t === undefined || t === '|') return 0
  switch (def.kind) {
    case 'line':
      return tokens.length - i
    case 'word':
    case 'path':
      return 1
    case 'host':
      return /^[\w.:\-]+$/.test(t) ? 1 : 0
    case 'int': {
      if (!/^\d+$/.test(t)) return 0
      const n = Number(t)
      return n >= (def.min ?? 0) && n <= (def.max ?? Number.MAX_SAFE_INTEGER) ? 1 : 0
    }
    case 'range-list':
      return /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(t) ? 1 : 0
    case 'ipv4':
      return isIpv4(t) ? 1 : 0
    case 'ipv6':
      return isIpv6(t) ? 1 : 0
    case 'ip':
      return isIpv4(t) || isIpv6(t) ? 1 : 0
    case 'ipv4-prefix':
      return isPrefix(t, false) ? 1 : 0
    case 'ipv6-prefix':
      return isPrefix(t, true) ? 1 : 0
    case 'prefix':
      return isPrefix(t, false) || isPrefix(t, true) ? 1 : 0
    case 'ip-or-prefix':
      return isIpv4(t) || isIpv6(t) || isPrefix(t, false) || isPrefix(t, true) ? 1 : 0
    case 'mac':
      return /^([0-9a-f]{1,4}\.){2}[0-9a-f]{1,4}$|^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(t) ? 1 : 0
    case 'asn':
      return /^\d{1,10}(\.\d{1,5})?$/.test(t) ? 1 : 0
    case 'interface':
      return matchInterface(ifs, tokens, i)
  }
}

/** Splits "Gi1/0/1" into type text and numbering. */
const SPLIT = /^([a-z][a-z-]*?)(\d.*)?$/i

function typeMatches(ifs: InterfaceSyntax, typed: string): boolean {
  const t = typed.toLowerCase()
  return ifs.types.some((x) => x.full.toLowerCase().startsWith(t) || x.short.some((s) => s.toLowerCase() === t))
}

export function matchInterface(ifs: InterfaceSyntax, tokens: readonly string[], i: number): number {
  const t = tokens[i]!
  if (ifs.opaque) return /^[\w.\-:/"]+$/.test(t) ? 1 : 0
  if (ifs.fullName) return ifs.fullName.test(t) ? 1 : 0
  const m = SPLIT.exec(t)
  if (!m) return 0
  const [, type, num] = m
  if (!typeMatches(ifs, type!)) return 0
  if (num) return ifs.numbering.test(num) ? 1 : 0
  const next = tokens[i + 1]
  if (ifs.spaceBetween && next !== undefined && ifs.numbering.test(next)) return 2
  return 0
}

/**
 * Canonical full form of a typed interface ("gi1/0/1" → "GigabitEthernet1/0/1") when the type
 * prefix is unique; otherwise the input unchanged. Used to match typed text against live values.
 */
export function canonicalInterface(ifs: InterfaceSyntax, typed: string): string {
  if (ifs.opaque || ifs.fullName) return typed
  const m = SPLIT.exec(typed.replace(/\s+/, ''))
  if (!m) return typed
  const t = m[1]!.toLowerCase()
  const exactShort = ifs.types.filter((x) => x.short.some((s) => s.toLowerCase() === t))
  const byPrefix = ifs.types.filter((x) => x.full.toLowerCase().startsWith(t))
  const hits = exactShort.length === 1 ? exactShort : byPrefix
  return hits.length === 1 ? hits[0]!.full + (m[2] ?? '') : typed
}

export function paramFor(name: string): ParamDef | undefined {
  const range = /^(\d+)-(\d+)$/.exec(name)
  if (range) return rangeParam(Number(range[1]), Number(range[2]))
  return PARAMS[name]
}

export const LIVE_SOURCES: readonly LiveSource[] = [
  'interfaces',
  'vlans',
  'vrfs',
  'bgp-neighbors',
  'ospf-neighbors',
  'route-maps',
  'prefix-lists',
  'acls',
  'policy-statements',
  'firewall-filters',
  'zones',
  'address-objects',
  'vdoms',
  'vsys',
  'checkpoints',
  'config-sessions',
  'files'
]
