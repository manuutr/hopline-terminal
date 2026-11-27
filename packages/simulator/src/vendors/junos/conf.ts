/**
 * Junos configuration as an ordered list of set-lines (without the leading `set `). The list is
 * authoritative for config mode; `commit` syncs it into the shared Device model so show commands
 * and scenarios see the change. Also: the hierarchical (brace) view, `| display set`, and the
 * `show | compare` diff. Shared with PAN-OS, whose configure mode has the same shape.
 */
import { network } from '../../core/text.ts'
import { inSubnet } from '../../core/text.ts'
import type { Device, Iface } from '../../state.ts'

/** Statements whose children are bare names: `interfaces ge-0/0/1 { ... }`. */
const NAME_CONTAINERS = new Set(['interfaces', 'vlans', 'routing-instances', 'groups', 'zones', 'address-book', 'applications'])
/** Statements that take a name and open a block: `unit 0 { ... }`, `group CORE { ... }`. */
const NAMED = new Set([
  'unit',
  'family',
  'group',
  'neighbor',
  'area',
  'interface',
  'policy-statement',
  'term',
  'prefix-list',
  'user',
  'route',
  'address',
  'security-zone',
  'policy',
  'filter',
  'vlan',
  'community',
  'from-zone',
  'to-zone',
  'host-inbound-traffic',
  'entry',
  'application',
  'rulebase',
  'rules',
  'zone',
  'deviceconfig',
  'vsys',
  'virtual-router',
  'ethernet',
  'layer3'
])
/** Statements that are always containers (even with one child). */
const CONTAINERS = new Set([
  'system',
  'services',
  'protocols',
  'routing-options',
  'policy-options',
  'login',
  'ospf',
  'bgp',
  'static',
  'security',
  'from',
  'snmp',
  'chassis',
  'firewall',
  'lldp',
  'root-authentication',
  'syslog',
  'policies',
  'network',
  'shared',
  'devices'
])
/** Leaves that hold one value (setting them again replaces). */
const SINGLE = new Set([
  'description',
  'host-name',
  'domain-name',
  'router-id',
  'autonomous-system',
  'peer-as',
  'type',
  'export',
  'import',
  'interface-type',
  'mtu',
  'class',
  'encrypted-password',
  'local-address',
  'metric',
  'then',
  'vlan-id',
  'next-hop',
  'speed',
  'link-mode',
  'local-preference',
  'hold-time',
  'action',
  'version'
])

export function tokenizeConf(s: string): string[] {
  const out: string[] = []
  const re = /"(?:[^"\\]|\\.)*"|\S+/g
  for (const m of s.matchAll(re)) out.push(m[0])
  return out
}

/** Node keys for a set-line's tokens: `['interfaces', 'ge-0/0/1', 'unit 0', 'description X']`. */
export function keysOf(tokens: string[]): string[] {
  const keys: string[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    const rest = tokens.length - i - 1
    if (NAME_CONTAINERS.has(t)) {
      keys.push(t)
      i++
      if (i < tokens.length) {
        keys.push(tokens[i]!)
        i++
      }
      continue
    }
    if (NAMED.has(t) && rest >= 1) {
      keys.push(`${t} ${tokens[i + 1]}`)
      i += 2
      continue
    }
    if (CONTAINERS.has(t) && rest >= 1) {
      keys.push(t)
      i++
      continue
    }
    if (rest === 0) {
      keys.push(t)
      i++
      continue
    }
    if (rest === 1) {
      keys.push(`${t} ${tokens[i + 1]}`)
      i += 2
      continue
    }
    keys.push(t)
    i++
  }
  return keys
}

export interface CNode {
  key: string
  children: CNode[]
  leaf: boolean
}

export function buildTree(lines: string[]): CNode {
  const root: CNode = { key: '', children: [], leaf: false }
  for (const l of lines) {
    const keys = keysOf(tokenizeConf(l))
    let n = root
    keys.forEach((k, idx) => {
      const last = idx === keys.length - 1
      let c = n.children.find((x) => x.key === k)
      if (!c) {
        c = { key: k, children: [], leaf: last }
        n.children.push(c)
      } else if (!last) c.leaf = false
      n = c
    })
  }
  return root
}

/** The subtree at a path (keys), or undefined. */
export function subtree(root: CNode, path: string[]): CNode | undefined {
  let n: CNode | undefined = root
  for (const k of path) {
    n = n?.children.find((c) => c.key === k)
    if (!n) return undefined
  }
  return n
}

/** Brace view, 4-space indent. */
export function renderTree(n: CNode, depth = 0, marker?: string): string[] {
  const out: string[] = []
  const pad = (dd: number): string => (marker ? marker + ' '.repeat(dd * 4 - 1) : ' '.repeat(dd * 4))
  for (const c of n.children) {
    if (c.leaf && !c.children.length) out.push(`${pad(depth)}${c.key};`)
    else {
      out.push(`${pad(depth)}${c.key} {`)
      out.push(...renderTree(c, depth + 1, marker))
      out.push(`${pad(depth)}}`)
    }
  }
  return out
}

/** `show | compare`: [edit path] sections with + / - statements. */
export function compareTrees(a: CNode, b: CNode, path: string[] = []): string[] {
  const out: string[] = []
  const section: string[] = []
  const keysA = new Set(a.children.map((c) => c.key))
  const keysB = new Set(b.children.map((c) => c.key))
  const sub: string[] = []
  for (const c of a.children) {
    if (!keysB.has(c.key)) section.push(...renderTree({ key: '', leaf: false, children: [c] }, 1, '-'))
  }
  for (const c of b.children) {
    if (!keysA.has(c.key)) section.push(...renderTree({ key: '', leaf: false, children: [c] }, 1, '+'))
    else {
      const ca = a.children.find((x) => x.key === c.key)!
      if (!(ca.leaf && !ca.children.length && c.leaf && !c.children.length)) sub.push(...compareTrees(ca, c, [...path, c.key]))
    }
  }
  if (section.length) out.push(path.length ? `[edit ${path.join(' ')}]` : '[edit]', ...section)
  out.push(...sub)
  return out
}

// ------------------------------------------------------------------ edits

export interface EditResult {
  lines: string[]
  /** Nothing to delete. */
  notFound?: boolean
}

export function setLine(lines: string[], line: string): string[] {
  const keys = keysOf(tokenizeConf(line))
  const last = keys.at(-1)!
  const word = last.split(' ')[0]!
  const parent = keys.slice(0, -1).join('\u0000')
  let out = lines
  if (SINGLE.has(word)) {
    out = lines.filter((l) => {
      const k = keysOf(tokenizeConf(l))
      return !(k.length === keys.length && k.slice(0, -1).join('\u0000') === parent && k.at(-1)!.split(' ')[0] === word)
    })
  }
  // Setting a leaf where a container stood (or the reverse) keeps both, as Junos merges.
  if (out.includes(line)) return out
  // Keep statements of the same parent together (Junos sorts by schema; we keep insertion order per block).
  let at = -1
  for (let i = out.length - 1; i >= 0; i--) {
    const k = keysOf(tokenizeConf(out[i]!))
    let common = 0
    while (common < k.length && common < keys.length - 1 && k[common] === keys[common]) common++
    if (common > 0 && common >= Math.min(keys.length - 1, 2)) {
      at = i
      break
    }
  }
  const next = [...out]
  if (at >= 0) next.splice(at + 1, 0, line)
  else next.push(line)
  return next
}

export function deleteLines(lines: string[], path: string): EditResult {
  const dk = keysOf(tokenizeConf(path))
  const tok = tokenizeConf(path)
  let hit = false
  const kept = lines.filter((l) => {
    const lk = keysOf(tokenizeConf(l))
    const lt = tokenizeConf(l)
    // Token-prefix match covers both containers and leaves (`delete interfaces ge-0/0/2 description`).
    const tokPrefix = tok.every((t, i) => lt[i] === t)
    const keyPrefix = dk.every((k, i) => lk[i] === k || (i === dk.length - 1 && lk[i]?.startsWith(k + ' ')))
    const m = tokPrefix || keyPrefix
    if (m) hit = true
    return !m
  })
  return { lines: kept, notFound: !hit }
}

// ------------------------------------------------------------------ device <-> lines

interface Seed {
  groups?: { name: string; type: string; peerAs?: number; export?: string; import?: string; neighbors: string[] }[]
  policy?: string[]
  ospfRoutes?: { prefix: string; mask: number; via: string; metric?: number }[]
}

const q = (s: string): string => (/[\s;{}"]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s)
export const unq = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s)

/** Generate the set-lines for a device that has none yet (first shell, or after a scenario). */
export function linesFromDevice(d: Device): string[] {
  const seed = (d.vendor['junosSeed'] as Seed | undefined) ?? {}
  const l: string[] = [`version ${d.version}`, `system host-name ${d.hostname}`, 'system root-authentication encrypted-password "$6$REDACTED"', `system login user ${d.user} class super-user`, 'system services ssh']
  if (d.vrfs.some((v) => v.name === 'mgmt_junos')) l.push('system management-instance')
  for (const i of d.interfaces) {
    const n = i.name
    if (i.description !== undefined) l.push(`interfaces ${n} description ${q(i.description)}`)
    if (!i.adminUp) l.push(`interfaces ${n} disable`)
    if (i.mtu) l.push(`interfaces ${n} mtu ${i.mtu}`)
    if (i.ip) l.push(`interfaces ${n} unit 0 family inet address ${i.ip}/${i.mask}`)
  }
  if (d.routerId) l.push(`routing-options router-id ${d.routerId}`)
  if (d.localAs) l.push(`routing-options autonomous-system ${d.localAs}`)
  for (const r of d.staticRoutes) l.push(`routing-options static route ${r.prefix}/${r.mask} next-hop ${r.nextHop}`)
  if (d.ospf) {
    for (const o of d.ospf.ifaces) {
      const base = `protocols ospf area ${o.area} interface ${o.iface}.0`
      if (o.networkType === 'point-to-point') l.push(`${base} interface-type p2p`)
      else if (o.passive) l.push(`${base} passive`)
      else l.push(base)
      if (o.cost) l.push(`${base} metric ${o.cost}`)
    }
  }
  const groups: NonNullable<Seed['groups']> = seed.groups ?? d.bgp.map((n) => ({ name: `PEER-${n.remoteAs}`, type: 'external', peerAs: n.remoteAs, neighbors: [n.ip] }))
  for (const g of groups) {
    const ns = d.bgp.filter((n) => g.neighbors.includes(n.ip))
    const ip = (n: (typeof ns)[number]): string => n.ip
    l.push(`protocols bgp group ${g.name} type ${g.type}`)
    if (g.import) l.push(`protocols bgp group ${g.name} import ${g.import}`)
    if (g.export) l.push(`protocols bgp group ${g.name} export ${g.export}`)
    // A neighbor whose AS differs from the group's carries its own peer-as.
    const gAs = ns[0]?.remoteAs ?? g.peerAs
    if (gAs) l.push(`protocols bgp group ${g.name} peer-as ${gAs}`)
    for (const n of ns) {
      l.push(`protocols bgp group ${g.name} neighbor ${ip(n)}`)
      if (n.remoteAs !== gAs) l.push(`protocols bgp group ${g.name} neighbor ${ip(n)} peer-as ${n.remoteAs}`)
      if (n.shutdown) l.push(`protocols bgp group ${g.name} neighbor ${ip(n)} shutdown`)
    }
  }
  for (const n of d.bgp) if (!groups.some((g) => g.neighbors.includes(n.ip))) l.push(`protocols bgp group PEER-${n.remoteAs} type external`, `protocols bgp group PEER-${n.remoteAs} peer-as ${n.remoteAs}`, `protocols bgp group PEER-${n.remoteAs} neighbor ${n.ip}`)
  for (const p of d.prefixLists) for (const e of p.entries) l.push(`policy-options prefix-list ${p.name} ${e.prefix}`)
  l.push(...(seed.policy ?? []))
  l.push(...d.extraConfig)
  return l
}

export interface CommitIssue {
  path: string
  statement: string
  message: string
}

/** `commit check`: the few validations the simulator models. */
export function checkLines(lines: string[]): CommitIssue[] {
  const tree = buildTree(lines)
  const issues: CommitIssue[] = []
  const bgp = subtree(tree, ['protocols', 'bgp'])
  for (const g of bgp?.children ?? []) {
    if (!g.key.startsWith('group ')) continue
    const groupAs = g.children.some((c) => c.key.startsWith('peer-as '))
    const external = g.children.some((c) => c.key === 'type external')
    for (const n of g.children.filter((c) => c.key.startsWith('neighbor '))) {
      const own = n.children.some((c) => c.key.startsWith('peer-as '))
      if (external && !groupAs && !own) issues.push({ path: `protocols bgp ${g.key} ${n.key}`, statement: '', message: 'Peer AS must be specified for EBGP neighbors' })
    }
  }
  for (const pl of lines) {
    const m = /^interfaces (\S+) unit \d+ family inet address (\S+)$/.exec(pl)
    if (m && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(m[2]!)) issues.push({ path: `interfaces ${m[1]} unit 0 family inet`, statement: `address ${m[2]};`, message: `invalid prefix: ${m[2]}` })
  }
  return issues
}

/** Apply committed set-lines to the shared model (keeps operational state). */
export function syncDevice(d: Device, lines: string[]): void {
  const tree = buildTree(lines)
  const get = (path: string[], word: string): string | undefined => subtree(tree, path)?.children.find((c) => c.key.startsWith(word + ' '))?.key.slice(word.length + 1)
  const hn = get(['system'], 'host-name')
  if (hn) d.hostname = unq(hn)
  const ifs = subtree(tree, ['interfaces'])
  for (const i of d.interfaces) {
    const n = ifs?.children.find((c) => c.key === i.name)
    const has = (k: string): boolean => !!n?.children.some((c) => c.key === k)
    const desc = n?.children.find((c) => c.key.startsWith('description '))
    i.description = desc ? unq(desc.key.slice('description '.length)) : undefined
    i.adminUp = !has('disable')
    const mtu = n?.children.find((c) => c.key.startsWith('mtu '))
    i.mtu = mtu ? Number(mtu.key.slice(4)) : undefined
    const addr = subtree(tree, ['interfaces', i.name, 'unit 0', 'family inet'])?.children.find((c) => c.key.startsWith('address '))
    if (addr) {
      const [ip, len] = addr.key.slice('address '.length).split('/')
      i.ip = ip
      i.mask = Number(len)
      i.units = [0]
    } else {
      i.ip = undefined
      i.mask = undefined
    }
  }
  // Logical interfaces that need no hardware.
  for (const c of ifs?.children ?? []) {
    if (d.interfaces.some((i) => i.name === c.key)) continue
    if (!/^(lo\d+|irb|ae\d+|vlan)$/.test(c.key)) continue
    const addr = subtree(c, ['unit 0', 'family inet'])?.children.find((x) => x.key.startsWith('address '))
    const [ip, len] = addr ? addr.key.slice(8).split('/') : []
    d.interfaces.push({ name: c.key, short: c.key, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '', ...(ip ? { ip, mask: Number(len), units: [0] } : {}) })
  }
  const rid = get(['routing-options'], 'router-id')
  if (rid) d.routerId = rid
  const as = get(['routing-options'], 'autonomous-system')
  d.localAs = as ? Number(as) : 0
  d.staticRoutes = []
  for (const r of subtree(tree, ['routing-options', 'static'])?.children ?? []) {
    if (!r.key.startsWith('route ')) continue
    const [prefix, len] = r.key.slice(6).split('/')
    const nh = r.children.find((c) => c.key.startsWith('next-hop '))?.key.slice(9)
    if (nh) d.staticRoutes.push({ prefix: prefix!, mask: Number(len), nextHop: nh })
  }
  // BGP: neighbors from groups.
  const old = d.bgp
  const bgp: Device['bgp'] = []
  for (const g of subtree(tree, ['protocols', 'bgp'])?.children ?? []) {
    if (!g.key.startsWith('group ')) continue
    const gAs = g.children.find((c) => c.key.startsWith('peer-as '))?.key.slice(8)
    const exp = g.children.find((c) => c.key.startsWith('export '))?.key.slice(7)
    const imp = g.children.find((c) => c.key.startsWith('import '))?.key.slice(7)
    for (const n of g.children.filter((c) => c.key.startsWith('neighbor '))) {
      const ip = n.key.slice(9)
      const own = n.children.find((c) => c.key.startsWith('peer-as '))?.key.slice(8)
      const prev = old.find((x) => x.ip === ip)
      const via = d.interfaces.find((i) => i.ip && i.mask !== undefined && i.mask < 32 && inSubnet(ip, i.ip, i.mask))?.name ?? prev?.via ?? 'lo0'
      const remoteAs = Number(own ?? gAs ?? 0)
      const nb: Device['bgp'][number] = { ...(prev ?? { ip, prefixes: 0 }), ip, remoteAs, via, description: g.key.slice(6), shutdown: n.children.some((c) => c.key === 'shutdown') || undefined, routeMapOut: exp, routeMapIn: imp }
      if (prev && prev.remoteAs !== remoteAs) {
        nb.upSince = undefined
        nb.downSince = undefined
      }
      if (!nb.shutdown) delete nb.shutdown
      bgp.push(nb)
    }
  }
  d.bgp = bgp
  // OSPF interfaces.
  const areas = subtree(tree, ['protocols', 'ospf'])?.children ?? []
  if (areas.length || d.ospf) {
    d.ospf ??= { process: '0', ifaces: [], neighbors: [] }
    d.ospf.ifaces = []
    for (const a of areas) {
      if (!a.key.startsWith('area ')) continue
      for (const i of a.children.filter((c) => c.key.startsWith('interface '))) {
        const name = i.key.slice(10).replace(/\.0$/, '')
        const has = (k: string): boolean => i.children.some((c) => c.key === k)
        const metric = i.children.find((c) => c.key.startsWith('metric '))?.key.slice(7)
        d.ospf.ifaces.push({ iface: name, area: a.key.slice(5), ...(has('interface-type p2p') ? { networkType: 'point-to-point' as const } : {}), ...(has('passive') ? { passive: true } : {}), ...(metric ? { cost: Number(metric) } : {}) })
      }
    }
  }
  d.prefixLists = []
  for (const p of subtree(tree, ['policy-options'])?.children ?? []) {
    if (!p.key.startsWith('prefix-list ')) continue
    d.prefixLists.push({ name: p.key.slice(12), entries: p.children.map((c, k) => ({ seq: (k + 1) * 5, action: 'permit' as const, prefix: c.key })) })
  }
}

/** Connected prefix for a /len address (used by renderers). */
export function connected(i: Iface): string {
  return `${network(i.ip!, i.mask!)}/${i.mask}`
}
