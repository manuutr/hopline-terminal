/**
 * PAN-OS configuration: a schema (for validation, `?` help and Tab), set-lines generated from the
 * Device model (the running config), a candidate kept as pending set/delete operations on top of
 * the running config (so scenarios and the topology builder can change the model underneath), the
 * brace and `set` renderings, and the commit sync from lines back into the model.
 */
import { tokenizeConf, unq } from '../junos/conf.ts'
import { inSubnet, network } from '../../core/text.ts'
import { isIpv4 } from '../../core/tree.ts'
import { now } from "../../core/runtime.ts"
import { tickBgp, type Device, type Iface } from '../../state.ts'
import type { PanosRule } from '../../devices/panos.ts'
import { pdata } from './render.ts'

export interface PLine {
  path: string[]
  value: string[]
}

export type VKind = 'ipmask' | 'ip' | 'text' | 'int' | 'enum' | 'name'

export interface SNode {
  help: string
  /** Help marker override ('>' nested, '+' option with value). */
  mark?: string
  kids?: Record<string, SNode>
  entry?: { label: string; help: string; node: SNode; values?: (d: Device, lines: PLine[], path: string[]) => string[] }
  leaf?: { kind: VKind; label: string; list?: boolean; enums?: [string, string][]; min?: number; max?: number }
}

const C = (help: string, kids: Record<string, SNode>, mark?: string): SNode => ({ help, kids, ...(mark ? { mark } : {}) })
const E = (help: string, label: string, node: SNode, values?: NonNullable<SNode['entry']>['values']): SNode => ({ help, entry: { label, help, node, ...(values ? { values } : {}) } })
const V = (help: string, kind: VKind = 'text', label = '<value>', extra: Partial<NonNullable<SNode['leaf']>> = {}): SNode => ({ help, leaf: { kind, label, ...extra } })
const YN = (help: string): SNode => V(help, 'enum', '', { enums: [['no', 'no'], ['yes', 'yes']] })
const L = (help: string, label = '<member>', kind: VKind = 'name'): SNode => V(help, kind, label, { list: true })

/** Existing entry names under a path, from the candidate. */
const names = (lines: PLine[], path: string[]): string[] => [...new Set(lines.filter((l) => path.every((p, k) => l.path[k] === p) && l.path.length > path.length).map((l) => l.path[path.length]!))]

const UNIT: SNode = C('', {
  ip: L('Interface IP addresses', '<ip/netmask>', 'ipmask'),
  tag: V('802.1q VLAN tag', 'int', '<1-4094>', { min: 1, max: 4094 }),
  comment: V('Comment', 'text'),
  'interface-management-profile': V('Interface management profile', 'name')
})
const LAYER3: SNode = C('Layer3 interface', {
  ip: L('Interface IP addresses', '<ip/netmask>', 'ipmask'),
  'interface-management-profile': V('Interface management profile', 'name'),
  mtu: V('Maximum Transfer Unit', 'int', '<576-9216>', { min: 576, max: 9216 }),
  units: E('Logical interfaces', '<name>', UNIT, (_d, l, p) => names(l, [...p, 'units']))
})
const ETH: SNode = C('', {
  layer3: LAYER3,
  'link-state': V('Link state', 'enum', '', { enums: [['auto', 'auto'], ['down', 'down'], ['up', 'up']] }),
  'link-speed': V('Link speed', 'enum', '', { enums: [['10', '10'], ['100', '100'], ['1000', '1000'], ['auto', 'auto']] }),
  'link-duplex': V('Link duplex', 'enum', '', { enums: [['auto', 'auto'], ['full', 'full'], ['half', 'half']] }),
  comment: V('Comment', 'text')
})
const PEER: SNode = C('', {
  'peer-as': V('Peer AS number', 'int', '<1-4294967295>', { min: 1, max: 4294967295 }),
  enable: YN('Enable this peer'),
  'peer-address': C('Peer address', { ip: V('IP address', 'ip', '<ip>') }),
  'local-address': C('Local address', { interface: V('Interface', 'name'), ip: V('IP address', 'ipmask', '<ip/netmask>') })
})
const RULE: SNode = C('', {
  from: L('Source zones', '<zone>'),
  to: L('Destination zones', '<zone>'),
  source: L('Source addresses', '<address>'),
  destination: L('Destination addresses', '<address>'),
  'source-user': L('Source users'),
  category: L('URL categories'),
  application: L('Applications', '<application>'),
  service: L('Services', '<service>'),
  action: V('Action', 'enum', '', { enums: [['allow', 'allow'], ['deny', 'deny'], ['drop', 'drop'], ['reset-both', 'reset-both'], ['reset-client', 'reset-client'], ['reset-server', 'reset-server']] }),
  description: V('Description', 'text'),
  disabled: YN('Disable the rule'),
  'log-start': YN('Log at session start'),
  'log-end': YN('Log at session end'),
  tag: L('Tags')
})

export const SCHEMA: SNode = C('', {
  address: E('Address objects', '<name>', C('', { 'ip-netmask': V('IP address and network mask', 'ipmask', '<ip/netmask>'), fqdn: V('Fully qualified domain name', 'text'), 'ip-range': V('IP range', 'text'), description: V('Description', 'text'), tag: L('Tags') }), (_d, l) => names(l, ['address'])),
  'address-group': E('Address groups', '<name>', C('', { static: L('Static members', '<address>'), description: V('Description', 'text') }), (_d, l) => names(l, ['address-group'])),
  deviceconfig: C('Device configuration', {
    system: C('System configuration', {
      hostname: V('Hostname', 'text'),
      'ip-address': V('IP address for the management interface', 'ip', '<ip>'),
      netmask: V('Netmask for the management interface', 'ip', '<ip>'),
      'default-gateway': V('Default gateway', 'ip', '<ip>'),
      'dns-setting': C('Dns settings', { 'dns-proxy-object': { ...V('Dns proxy object to use for resolving fqdns', 'name'), mark: '>' }, servers: C('Primary and secondary dns servers', { primary: V('Primary DNS server IP address', 'ip', '<ip>'), secondary: V('Secondary DNS server IP address', 'ip', '<ip>') }) }),
      'ntp-servers': C('NTP servers', { 'primary-ntp-server': C('Primary NTP server', { 'ntp-server-address': V('NTP server address', 'text') }), 'secondary-ntp-server': C('Secondary NTP server', { 'ntp-server-address': V('NTP server address', 'text') }) }),
      timezone: V('Time zone', 'text'),
      'login-banner': V('Login banner', 'text'),
      domain: V('Domain name', 'text'),
      service: C('Management services', { 'disable-snmp': YN('Disable SNMP'), 'disable-ssh': YN('Disable SSH'), 'disable-https': YN('Disable HTTPS') })
    }),
    'high-availability': C('High availability configuration', { enabled: YN('Enable HA') })
  }),
  network: C('Network configuration', {
    interface: C('Interface configuration', {
      ethernet: E('Ethernet interfaces', '<name>', ETH, (d) => d.interfaces.filter((i) => /^ethernet\d+\/\d+$/.test(i.name)).map((i) => i.name)),
      'aggregate-ethernet': E('Aggregate interfaces', '<name>', ETH, (d) => d.interfaces.filter((i) => /^ae\d+$/.test(i.name)).map((i) => i.name)),
      loopback: C('Loopback interface', { units: E('Logical interfaces', '<name>', UNIT, (_d, l) => names(l, ['network', 'interface', 'loopback', 'units'])) }),
      tunnel: C('Tunnel interface', { units: E('Logical interfaces', '<name>', UNIT, (_d, l) => names(l, ['network', 'interface', 'tunnel', 'units'])) })
    }),
    'virtual-router': E(
      'Virtual routers',
      '<name>',
      C('', {
        interface: L('Interfaces', '<interface>'),
        'routing-table': C('Routing table', { ip: C('IPv4 routing table', { 'static-route': E('Static routes', '<name>', C('', { destination: V('Destination IP address/prefix', 'ipmask', '<ip/netmask>'), nexthop: C('Next hop', { 'ip-address': V('Next hop IP address', 'ip', '<ip>'), discard: C('Discard', {}) }), interface: V('Outgoing interface', 'name'), metric: V('Metric', 'int', '<1-65535>', { min: 1, max: 65535 }) }), (_d, l, p) => names(l, [...p, 'static-route'])) }) }),
        protocol: C('Routing protocols', {
          bgp: C('BGP', {
            enable: YN('Enable BGP'),
            'router-id': V('Router id', 'ip', '<ip>'),
            'local-as': V('Local AS number', 'int', '<1-4294967295>', { min: 1, max: 4294967295 }),
            'peer-group': E('Peer groups', '<name>', C('', { peer: E('Peers', '<name>', PEER, (_d, l, p) => names(l, [...p, 'peer'])), type: C('Peer group type', { ebgp: C('eBGP', {}), ibgp: C('iBGP', {}) }) }), (_d, l, p) => names(l, [...p, 'peer-group']))
          })
        })
      }),
      () => ['default']
    ),
    profiles: C('Network profiles', { 'interface-management-profile': E('Interface management profiles', '<name>', C('', { ping: YN('Allow ping'), ssh: YN('Allow SSH'), https: YN('Allow HTTPS'), snmp: YN('Allow SNMP') }), (_d, l) => names(l, ['network', 'profiles', 'interface-management-profile'])) })
  }),
  rulebase: C('Rulebase', { security: C('Security policy', { rules: E('Security rules', '<name>', RULE, (_d, l) => names(l, ['rulebase', 'security', 'rules'])) }), nat: C('NAT policy', { rules: E('NAT rules', '<name>', C('', { from: L('Source zones'), to: L('Destination zones'), source: L('Source addresses'), destination: L('Destination addresses'), description: V('Description', 'text') }), (_d, l) => names(l, ['rulebase', 'nat', 'rules'])) }) }),
  service: E('Service objects', '<name>', C('', { protocol: C('Protocol', { tcp: C('TCP', { port: V('Port(s)', 'text', '<0-65535>') }), udp: C('UDP', { port: V('Port(s)', 'text', '<0-65535>') }) }), description: V('Description', 'text') }), (_d, l) => names(l, ['service'])),
  zone: E('Security zones', '<name>', C('', { network: C('Network', { layer3: L('Layer3 interfaces', '<interface>'), 'virtual-wire': L('Virtual wire interfaces', '<interface>') }), 'enable-user-identification': YN('Enable user identification') }), (_d, l) => names(l, ['zone']))
})

// ------------------------------------------------------------------ schema walk

export type Walk =
  | { ok: true; node: SNode; path: string[]; value: string[]; atEntry?: boolean }
  | { ok: false; at: number }

/** Walk tokens (already prefixed with the edit path) through the schema. */
export function walk(tokens: string[]): Walk {
  let node = SCHEMA
  const path: string[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (node.leaf) return { ok: true, node, path, value: tokens.slice(i) }
    if (node.entry) {
      path.push(unq(t))
      node = node.entry.node
      i++
      continue
    }
    const k = node.kids?.[t]
    if (!k) return { ok: false, at: i }
    path.push(t)
    node = k
    i++
  }
  return { ok: true, node, path, value: [], atEntry: !!node.entry }
}

const IPV4_CIDR = /^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/

export function validValue(n: SNode, v: string): boolean {
  const l = n.leaf!
  const s = unq(v)
  switch (l.kind) {
    case 'ipmask': {
      const m = IPV4_CIDR.exec(s)
      return !!m && isIpv4(m[1]!) && (m[2] === undefined || Number(m[2]) <= 32)
    }
    case 'ip':
      return isIpv4(s)
    case 'int':
      return /^\d+$/.test(s) && (l.min === undefined || Number(s) >= l.min) && (l.max === undefined || Number(s) <= l.max)
    case 'enum':
      return (l.enums ?? []).some(([e]) => e === s)
    case 'name':
      return s.length > 0 && s.length <= 63
    default:
      return true
  }
}

/** Value tokens: a single value, or `[ a b ]` for lists. */
export function parseValue(n: SNode, toks: string[]): string[] | undefined {
  if (!toks.length) return undefined
  let vals = toks
  if (toks[0] === '[') {
    if (toks.at(-1) !== ']' || !n.leaf!.list) return undefined
    vals = toks.slice(1, -1)
  } else if (toks.length > 1) {
    if (n.leaf!.kind !== 'text') return undefined
    return undefined
  }
  if (!vals.length || !vals.every((v) => validValue(n, v))) return undefined
  return vals
}

// ------------------------------------------------------------------ rendering

const q = (s: string): string => (s === '' || /[\s"';{}[\]]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

export function setLineText(l: PLine): string {
  const v = l.value.length > 1 ? `[ ${l.value.join(' ')} ]` : (l.value[0] ?? '')
  return `set ${l.path.map(q).join(' ')}${v ? ' ' + v : ''}`
}

/** Brace view ({ } with 2-space indents, `[ a b ]` lists). */
export function braceView(lines: PLine[], base: string[] = []): string[] {
  interface T {
    k: string
    kids: T[]
    value?: string[]
  }
  const root: T = { k: '', kids: [] }
  for (const l of lines) {
    let n = root
    for (const p of l.path.slice(base.length)) {
      let c = n.kids.find((x) => x.k === p && !x.value)
      if (!c) {
        c = { k: p, kids: [] }
        n.kids.push(c)
      }
      n = c
    }
    n.value = l.value
  }
  const out: string[] = []
  const go = (n: T, depth: number): void => {
    for (const c of n.kids) {
      const ind = '  '.repeat(depth)
      if (c.value && !c.kids.length) out.push(`${ind}${q(c.k)} ${c.value.length > 1 ? `[ ${c.value.join(' ')}]`.replace(/ \]$/, ' ]') : c.value[0]};`)
      else {
        out.push(`${ind}${q(c.k)} {`)
        go(c, depth + 1)
        out.push(`${ind}}`)
      }
    }
  }
  go(root, 0)
  return out
}

// ------------------------------------------------------------------ device <-> lines

interface Store {
  /** Candidate edits on top of the running config. */
  ops: { op: 'set' | 'delete'; path: string[]; value: string[]; /** Admin who typed it (`commit partial admin`). */ by?: string }[]
  /** Config lines the model has no field for (kept across commits). */
  extra: PLine[]
}

export function store(d: Device): Store {
  const v = d.vendor as { panosConf?: Store }
  v.panosConf ??= { ops: [], extra: [{ path: ['deviceconfig', 'system', 'dns-setting', 'servers', 'primary'], value: ['8.8.8.8'] }, { path: ['deviceconfig', 'system', 'timezone'], value: ['UTC'] }, { path: ['network', 'profiles', 'interface-management-profile', 'allow-ping', 'ping'], value: ['yes'] }] }
  return v.panosConf
}

const ifPath = (i: Iface): string[] | undefined => {
  if (/^ethernet\d+\/\d+$/.test(i.name)) return ['network', 'interface', 'ethernet', i.name]
  if (/^ae\d+$/.test(i.name)) return ['network', 'interface', 'aggregate-ethernet', i.name]
  let m = /^(ethernet\d+\/\d+)\.\d+$/.exec(i.name)
  if (m) return ['network', 'interface', 'ethernet', m[1]!, 'layer3', 'units', i.name]
  m = /^(ae\d+)\.\d+$/.exec(i.name)
  if (m) return ['network', 'interface', 'aggregate-ethernet', m[1]!, 'layer3', 'units', i.name]
  m = /^(loopback|tunnel)\.\d+$/.exec(i.name)
  if (m) return ['network', 'interface', m[1]!, 'units', i.name]
  return undefined
}

const BGP = ['network', 'virtual-router', 'default', 'protocol', 'bgp']
const peerGroup = (d: Device, as: number): string => (as === d.localAs ? 'ibgp' : 'ebgp')

/** The running configuration, generated from the model. */
export function runningLines(d: Device): PLine[] {
  const p = pdata(d)
  const L: PLine[] = []
  const add = (path: string[], ...value: string[]): void => {
    L.push({ path, value })
  }
  add(['deviceconfig', 'system', 'hostname'], d.hostname)
  add(['deviceconfig', 'system', 'ip-address'], p.mgmt.ip)
  add(['deviceconfig', 'system', 'netmask'], p.mgmt.mask)
  add(['deviceconfig', 'system', 'default-gateway'], p.mgmt.gw)
  if (d.services['snmp'] !== undefined) add(['deviceconfig', 'system', 'service', 'disable-snmp'], d.services['snmp'] ? 'no' : 'yes')
  for (const i of d.interfaces) {
    const base = ifPath(i)
    if (!base) continue
    const sub = base.includes('units')
    if (i.ip) add([...base, ...(sub ? [] : ['layer3']), 'ip'], `${i.ip}/${i.mask}`)
    if (p.mgmtProfile[i.name]) add([...base, ...(sub ? [] : ['layer3']), 'interface-management-profile'], p.mgmtProfile[i.name]!)
    if (sub && i.vlan !== undefined) add([...base, 'tag'], String(i.vlan))
    if (i.description !== undefined) add([...base, 'comment'], q(i.description))
    if (!sub && !i.adminUp && /^ethernet/.test(i.name)) add([...base, 'link-state'], 'down')
  }
  const vrIfs = d.interfaces.filter((i) => i.ip && ifPath(i)).map((i) => i.name)
  if (vrIfs.length) add(['network', 'virtual-router', 'default', 'interface'], ...vrIfs)
  d.staticRoutes.forEach((s, k) => {
    const n = s.name ?? `route-${k + 1}`
    const b = ['network', 'virtual-router', 'default', 'routing-table', 'ip', 'static-route', n]
    add([...b, 'destination'], `${s.prefix}/${s.mask}`)
    add([...b, 'nexthop', 'ip-address'], s.nextHop)
    if (s.ad !== undefined) add([...b, 'metric'], String(s.ad))
  })
  if (d.bgp.length) {
    add([...BGP, 'enable'], 'yes')
    add([...BGP, 'router-id'], d.routerId)
    add([...BGP, 'local-as'], String(d.localAs))
    for (const n of d.bgp) {
      const pb = [...BGP, 'peer-group', peerGroup(d, n.remoteAs), 'peer', peerNameOf(n)]
      add([...pb, 'peer-as'], String(n.remoteAs))
      add([...pb, 'peer-address', 'ip'], n.ip)
      add([...pb, 'local-address', 'interface'], n.via)
      if (n.shutdown) add([...pb, 'enable'], 'no')
    }
  }
  const zones = new Map<string, string[]>()
  for (const i of d.interfaces) if (i.zone) zones.set(i.zone, [...(zones.get(i.zone) ?? []), i.name])
  for (const [z, m] of zones) add(['zone', z, 'network', 'layer3'], ...m)
  for (const a of p.addresses) {
    if (a.ipNetmask) add(['address', a.name, 'ip-netmask'], a.ipNetmask)
    if (a.fqdn) add(['address', a.name, 'fqdn'], a.fqdn)
    if (a.description !== undefined) add(['address', a.name, 'description'], q(a.description))
  }
  for (const r of p.rules) {
    const b = ['rulebase', 'security', 'rules', r.name]
    add([...b, 'from'], ...r.from)
    add([...b, 'to'], ...r.to)
    add([...b, 'source'], ...r.source)
    add([...b, 'destination'], ...r.destination)
    add([...b, 'application'], ...r.application)
    add([...b, 'service'], ...r.service)
    add([...b, 'action'], r.action)
    if (r.description !== undefined) add([...b, 'description'], q(r.description))
    if (r.disabled) add([...b, 'disabled'], 'yes')
  }
  return [...L, ...store(d).extra.map((l) => structuredClone(l))]
}

const peerNameOf = (n: { description?: string; ip: string }): string => (n.description && /^[\w.-]+$/.test(n.description) ? n.description : `peer-${n.ip.replace(/\./g, '-')}`)

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, k) => x === b[k])
const startsWith = (a: string[], b: string[]): boolean => b.length <= a.length && b.every((x, k) => a[k] === x)

export function applySet(lines: PLine[], path: string[], value: string[], list: boolean): PLine[] {
  const hit = lines.find((l) => same(l.path, path))
  if (hit) {
    hit.value = list ? [...new Set([...hit.value, ...value])] : value
    return lines
  }
  // Keep a block together: insert after the last line that shares the longest prefix.
  let at = -1
  let best = 0
  lines.forEach((l, k) => {
    let c = 0
    while (c < l.path.length && c < path.length - 1 && l.path[c] === path[c]) c++
    if (c >= best && c > 0) {
      best = c
      at = k
    }
  })
  const next = { path, value }
  if (at >= 0) lines.splice(at + 1, 0, next)
  else lines.push(next)
  return lines
}

/** Returns false when nothing matched. */
export function applyDelete(lines: PLine[], path: string[], value: string[]): { lines: PLine[]; hit: boolean } {
  if (value.length) {
    const l = lines.find((x) => same(x.path, path))
    if (!l) return { lines, hit: false }
    const left = l.value.filter((v) => !value.includes(v))
    if (left.length === l.value.length) return { lines, hit: false }
    return { lines: left.length ? lines : lines.filter((x) => x !== l), hit: (l.value = left, true) }
  }
  const kept = lines.filter((l) => !startsWith(l.path, path))
  return { lines: kept, hit: kept.length !== lines.length }
}

/** The candidate: running plus every pending edit, or only those of one admin (`commit partial admin X`). */
export function candidateLines(d: Device, by?: string): PLine[] {
  let lines = runningLines(d)
  for (const o of store(d).ops) {
    if (by !== undefined && o.by !== by) continue
    if (o.op === 'set') {
      const w = walk(o.path)
      lines = applySet(lines, o.path, o.value, !!(w.ok && w.node.leaf?.list))
    } else lines = applyDelete(lines, o.path, o.value).lines
  }
  return lines
}

export const pending = (d: Device): boolean => store(d).ops.length > 0 && candidateLines(d).map(setLineText).join('\n') !== runningLines(d).map(setLineText).join('\n')

// ------------------------------------------------------------------ commit

export interface Issue {
  xpath: string
  msg: string
}

/** Semantic validation PAN-OS runs at commit time. */
export function validate(d: Device, lines: PLine[]): Issue[] {
  const zones = new Set(lines.filter((l) => l.path[0] === 'zone').map((l) => l.path[1]!))
  const addrs = new Set(lines.filter((l) => l.path[0] === 'address' || l.path[0] === 'address-group').map((l) => l.path[1]!))
  const issues: Issue[] = []
  const rules = new Map<string, PLine[]>()
  for (const l of lines) if (l.path[0] === 'rulebase' && l.path[1] === 'security') rules.set(l.path[3]!, [...(rules.get(l.path[3]!) ?? []), l])
  for (const [name, ls] of rules) {
    const get = (k: string): string[] => ls.find((l) => l.path[4] === k)?.value ?? []
    for (const k of ['from', 'to']) for (const z of get(k)) if (z !== 'any' && !zones.has(z)) issues.push({ xpath: `rulebase -> security -> rules -> ${name} -> ${k}`, msg: `'${z}' is not a valid reference` })
    for (const k of ['source', 'destination']) for (const a of get(k)) if (a !== 'any' && !addrs.has(a) && !IPV4_CIDR.test(a) && !/^\d+\.\d+\.\d+\.\d+-\d+\.\d+\.\d+\.\d+$/.test(a)) issues.push({ xpath: `rulebase -> security -> rules -> ${name} -> ${k}`, msg: `'${a}' is not a valid reference` })
    for (const k of ['from', 'to', 'source', 'destination', 'application', 'service']) if (!get(k).length) issues.push({ xpath: `rulebase -> security -> rules -> ${name}`, msg: `${k} is missing` })
  }
  for (const l of lines) {
    if (l.path[0] === 'zone') for (const m of l.value) if (!d.interfaces.some((i) => i.name === m)) issues.push({ xpath: `zone -> ${l.path[1]} -> network -> layer3`, msg: `'${m}' is not a valid reference` })
  }
  return issues
}

/** Apply committed lines to the model. */
export function syncDevice(d: Device, lines: PLine[]): void {
  const p = pdata(d)
  const get = (path: string[]): string[] | undefined => lines.find((l) => same(l.path, path))?.value
  const handled = new Set<PLine>()
  const take = (pred: (l: PLine) => boolean): PLine[] => {
    const r = lines.filter(pred)
    for (const l of r) handled.add(l)
    return r
  }
  take((l) => l.path[0] === 'deviceconfig' && l.path[1] === 'system' && ['hostname', 'ip-address', 'netmask', 'default-gateway'].includes(l.path[2]!) && l.path.length === 3)
  d.hostname = unq(get(['deviceconfig', 'system', 'hostname'])?.[0] ?? d.hostname)
  p.mgmt.ip = get(['deviceconfig', 'system', 'ip-address'])?.[0] ?? p.mgmt.ip
  p.mgmt.mask = get(['deviceconfig', 'system', 'netmask'])?.[0] ?? p.mgmt.mask
  p.mgmt.gw = get(['deviceconfig', 'system', 'default-gateway'])?.[0] ?? p.mgmt.gw
  // Management services (the high-cpu scenario's mgmtsrvr hog runs while SNMP is on).
  const snmp = take((l) => same(l.path, ['deviceconfig', 'system', 'service', 'disable-snmp']))[0]
  if (snmp) d.services['snmp'] = snmp.value[0] !== 'yes'
  else if (d.services['snmp'] !== undefined) d.services['snmp'] = true
  // Interfaces.
  for (const i of d.interfaces) {
    const base = ifPath(i)
    if (!base) continue
    const sub = base.includes('units')
    const l3 = sub ? base : [...base, 'layer3']
    take((l) => same(l.path, [...l3, 'ip']) || same(l.path, [...l3, 'interface-management-profile']) || same(l.path, [...base, 'comment']) || same(l.path, [...base, 'link-state']) || (sub && same(l.path, [...base, 'tag'])))
    const ip = get([...l3, 'ip'])?.[0]
    if (ip) {
      const [a, m] = ip.split('/')
      i.ip = a
      i.mask = m === undefined ? 32 : Number(m)
    } else {
      i.ip = undefined
      i.mask = undefined
    }
    const prof = get([...l3, 'interface-management-profile'])?.[0]
    if (prof) p.mgmtProfile[i.name] = prof
    else delete p.mgmtProfile[i.name]
    const c = get([...base, 'comment'])?.[0]
    i.description = c === undefined ? undefined : unq(c)
    if (sub) {
      const tag = get([...base, 'tag'])?.[0]
      i.vlan = tag ? Number(tag) : undefined
    } else if (/^ethernet/.test(i.name)) {
      const was = i.adminUp
      i.adminUp = get([...base, 'link-state'])?.[0] !== 'down'
      if (was !== i.adminUp) i.lastChange = now(d)
    }
  }
  take((l) => same(l.path, ['network', 'virtual-router', 'default', 'interface']))
  // Static routes.
  const sr = take((l) => startsWith(l.path, ['network', 'virtual-router', 'default', 'routing-table', 'ip', 'static-route']))
  const srNames = [...new Set(sr.map((l) => l.path[6]!))]
  d.staticRoutes = srNames
    .map((n) => {
      const b = ['network', 'virtual-router', 'default', 'routing-table', 'ip', 'static-route', n]
      const dst = get([...b, 'destination'])?.[0] ?? ''
      const [pfx, len] = dst.split('/')
      const metric = get([...b, 'metric'])?.[0]
      return { prefix: network(pfx ?? '0.0.0.0', Number(len ?? 32)), mask: Number(len ?? 32), nextHop: get([...b, 'nexthop', 'ip-address'])?.[0] ?? '', name: n, ...(metric ? { ad: Number(metric) } : {}) }
    })
    .filter((s) => s.nextHop)
  // BGP.
  const bl = take((l) => startsWith(l.path, BGP))
  const las = get([...BGP, 'local-as'])?.[0]
  if (las) d.localAs = Number(las)
  const rid = get([...BGP, 'router-id'])?.[0]
  if (rid) d.routerId = rid
  const peers = new Map<string, string[]>()
  for (const l of bl) if (l.path[5] === 'peer-group' && l.path[7] === 'peer') peers.set(l.path[8]!, l.path.slice(0, 9))
  const keep: typeof d.bgp = []
  for (const [name, b] of peers) {
    const ip = get([...b, 'peer-address', 'ip'])?.[0]
    if (!ip) continue
    let n = d.bgp.find((x) => x.ip === ip)
    if (!n) {
      const via = d.interfaces.find((i) => i.ip && i.mask !== undefined && inSubnet(ip, i.ip, i.mask))?.name ?? ''
      n = { ip, remoteAs: 0, via, prefixes: 0, description: name }
    }
    n.remoteAs = Number(get([...b, 'peer-as'])?.[0] ?? n.remoteAs)
    n.shutdown = get([...b, 'enable'])?.[0] === 'no' ? true : undefined
    const via = get([...b, 'local-address', 'interface'])?.[0]
    if (via) n.via = via
    if (/^[\w.-]+$/.test(name)) n.description = name
    keep.push(n)
  }
  if (bl.length) d.bgp = keep
  // Zones.
  const zl = take((l) => l.path[0] === 'zone' && same(l.path.slice(2), ['network', 'layer3']))
  for (const i of d.interfaces) i.zone = zl.find((l) => l.value.includes(i.name))?.path[1]
  // Addresses and rules.
  const al = take((l) => l.path[0] === 'address' && ['ip-netmask', 'fqdn', 'description'].includes(l.path[2]!) && l.path.length === 3)
  p.addresses = [...new Set(al.map((l) => l.path[1]!))].map((name) => {
    const v = (k: string): string | undefined => get(['address', name, k])?.[0]
    const desc = v('description')
    return { name, ...(v('ip-netmask') ? { ipNetmask: v('ip-netmask') } : {}), ...(v('fqdn') ? { fqdn: v('fqdn') } : {}), ...(desc !== undefined ? { description: unq(desc) } : {}) }
  })
  const rl = take((l) => startsWith(l.path, ['rulebase', 'security', 'rules']) && ['from', 'to', 'source', 'destination', 'application', 'service', 'action', 'description', 'disabled'].includes(l.path[4]!) && l.path.length === 5)
  p.rules = [...new Set(rl.map((l) => l.path[3]!))].map((name): PanosRule => {
    const v = (k: string): string[] => get(['rulebase', 'security', 'rules', name, k]) ?? []
    const desc = v('description')[0]
    return { name, from: v('from'), to: v('to'), source: v('source'), destination: v('destination'), application: v('application'), service: v('service'), action: v('action')[0] ?? 'allow', ...(desc !== undefined ? { description: unq(desc) } : {}), ...(v('disabled')[0] === 'yes' ? { disabled: true } : {}) }
  })
  store(d).extra = lines.filter((l) => !handled.has(l)).map((l) => structuredClone(l))
  store(d).ops = []
  tickBgp(d)
}

export { tokenizeConf, unq }
