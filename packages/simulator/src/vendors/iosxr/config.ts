/**
 * IOS XR running-config rendered from the model, the commit database kept in `d.vendor.iosxr`,
 * interface-name resolution, and the target-vs-running diff that `show configuration` prints.
 * Layouts are `[unverified, from memory]` of IOS XR 7.x (no research doc for this platform).
 */
import { maskToDotted } from '../../core/tree.ts'
import { cmpIp } from '../../core/text.ts'
import type { ConfigSnapshot, Device, Iface } from '../../state.ts'

export interface XrCommit {
  id: string
  label?: string
  comment?: string
  user: string
  line: string
  client: string
  t: number
  before: ConfigSnapshot
  after: ConfigSnapshot
}

export interface XrStore {
  /** Last commit id handed out. */
  seq: number
  /** Newest first. */
  commits: XrCommit[]
  /** A `commit confirmed` waiting for its confirming `commit`. */
  trial?: { id: string; before: ConfigSnapshot; until: number }
  lastChange?: { t: number; by: string }
}

export function xrStore(d: Device): XrStore {
  const v = d.vendor as { iosxr?: XrStore }
  return (v.iosxr ??= { seq: 1000000000, commits: [] })
}

// ---------------------------------------------------------------- interface names

export const XR_TYPES: { full: string; short: string; virtual?: boolean }[] = [
  { full: 'GigabitEthernet', short: 'Gi' },
  { full: 'TenGigE', short: 'Te' },
  { full: 'TwentyFiveGigE', short: 'TF' },
  { full: 'FortyGigE', short: 'Fo' },
  { full: 'HundredGigE', short: 'Hu' },
  { full: 'MgmtEth', short: 'Mg' },
  { full: 'Bundle-Ether', short: 'BE', virtual: true },
  { full: 'Loopback', short: 'Lo', virtual: true },
  { full: 'tunnel-ip', short: 'ti', virtual: true },
  { full: 'BVI', short: 'BV', virtual: true },
  { full: 'Null', short: 'Nu', virtual: true }
]

/** Parse an XR interface spelling ("gi0/0/0/1", "Gi 0/0/0/1", "MgmtEth0/RSP0/CPU0/0", "lo0"). */
export function parseXrIf(text: string): { name: string; short: string; virtual: boolean } | undefined {
  const q = text.replace(/\s+/g, '')
  const m = /^([a-z][a-z-]*?)(\d[\w/.]*)$/i.exec(q)
  if (!m) return undefined
  const t = m[1]!.toLowerCase()
  const exact = XR_TYPES.filter((x) => x.full.toLowerCase() === t || x.short.toLowerCase() === t)
  const cands = exact.length ? exact : XR_TYPES.filter((x) => x.full.toLowerCase().startsWith(t))
  if (cands.length !== 1) return undefined
  const ty = cands[0]!
  const num = m[2]!
  if (ty.full !== 'MgmtEth' && !/^\d+(\/\d+)*(\.\d+)?$/.test(num)) return undefined
  return { name: ty.full + num, short: ty.short + num, virtual: !!ty.virtual }
}

export function findXrIf(d: Device, text: string): Iface | undefined {
  const q = text.replace(/\s+/g, '').toLowerCase()
  if (!q) return undefined
  const direct = d.interfaces.find((i) => i.name.toLowerCase() === q || i.short.toLowerCase() === q)
  if (direct) return direct
  const r = parseXrIf(text)
  return r ? d.interfaces.find((i) => i.name === r.name) : undefined
}

const TYPE_ORDER = ['Loopback', 'MgmtEth', 'Bundle-Ether', 'GigabitEthernet', 'TenGigE', 'TwentyFiveGigE', 'FortyGigE', 'HundredGigE', 'BVI', 'tunnel-ip']
const rank = (n: string): number => {
  const k = TYPE_ORDER.findIndex((t) => n.startsWith(t))
  return k < 0 ? 99 : k
}
const ifNum = (n: string): number[] => (n.match(/\d+/g) ?? []).map(Number)
export function ifSort(a: Iface, b: Iface): number {
  const r = rank(a.name) - rank(b.name)
  if (r) return r
  const x = ifNum(a.name)
  const y = ifNum(b.name)
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? -1) !== (y[k] ?? -1)) return (x[k] ?? -1) - (y[k] ?? -1)
  return 0
}

// ---------------------------------------------------------------- dates

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')

/** "Tue Nov 24 11:02:11 2026" */
export function xrDate(t: number): string {
  const d = new Date(t)
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/** Exec timestamp line: "Tue Nov 24 11:02:11.418 UTC" */
export function xrStamp(t: number): string {
  const d = new Date(t)
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')} UTC`
}

/** Syslog prefix: "RP/0/RSP0/CPU0:Nov 24 11:02:11.418 UTC: " */
export function xrLogPrefix(t: number): string {
  const d = new Date(t)
  return `RP/0/RSP0/CPU0:${MON[d.getUTCMonth()]} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')} UTC: `
}

// ---------------------------------------------------------------- config text

export const l2mtu = (i: Iface): number => (i.mtu ?? 1500) + 14

function ifaceBlock(i: Iface): string[] {
  const l = [`interface ${i.name}`]
  if (i.description !== undefined) l.push(` description ${i.description}`)
  if (i.mtu !== undefined && i.mtu !== 1500) l.push(` mtu ${l2mtu(i)}`)
  if (i.vrf) l.push(` vrf ${i.vrf}`)
  if (i.ip) l.push(` ipv4 address ${i.ip} ${maskToDotted(i.mask!)}`)
  if (i.speedSet && i.speedSet !== 'auto') l.push(` speed ${i.speedSet}`)
  if (i.duplex && i.duplex !== 'auto') l.push(` duplex ${i.duplex}`)
  if (!i.adminUp) l.push(' shutdown')
  l.push('!')
  return l
}

function prefixEntry(e: { prefix: string; ge?: number; le?: number }): string {
  return `${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`
}

/** The config body (no "Building configuration..." / "!! Last configuration change" header). */
export function configBody(d: Device): string[] {
  const out: string[] = [`hostname ${d.hostname}`, 'logging console informational', 'logging buffered 2097152', 'domain name lab.example.net']
  out.push('username netops', ' group root-lr', ' group cisco-support', ' secret 10 $6$4cBzWkqL$e7Hj5Rm2pZkT0vYc8NwL3fXa9uIq6sDgOyBhKnM1', '!')
  for (const v of [...d.vrfs].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`vrf ${v.name}`, ' address-family ipv4 unicast')
    if (v.rd) out.push('  import route-target', `   ${v.rd}`, '  !', '  export route-target', `   ${v.rd}`, '  !')
    out.push(' !', '!')
  }
  if (d.motd !== undefined) out.push(`banner motd ^${d.motd}^`)
  out.push('line default', ' transport input ssh', '!')
  for (const a of d.acls) {
    out.push(`ipv4 access-list ${a.name}`)
    for (const e of a.entries) out.push(` ${e.seq} ${e.action} ${e.text}`)
    out.push('!')
  }
  for (const i of [...d.interfaces].sort(ifSort)) out.push(...ifaceBlock(i))
  for (const p of d.prefixLists) {
    out.push(`prefix-set ${p.name}`)
    p.entries.forEach((e, k) => out.push(`  ${prefixEntry(e)}${k < p.entries.length - 1 ? ',' : ''}`))
    out.push('end-set', '!')
  }
  for (const r of d.routeMaps) {
    out.push(`route-policy ${r.name}`)
    for (const e of r.entries) for (const s of e.set) out.push(`  ${s}`)
    out.push('end-policy', '!')
  }
  const statics = d.staticRoutes
  if (statics.length) {
    out.push('router static')
    const byVrf = new Map<string, typeof statics>()
    for (const r of statics) byVrf.set(r.vrf ?? '', [...(byVrf.get(r.vrf ?? '') ?? []), r])
    const glob = byVrf.get('') ?? []
    if (glob.length) {
      out.push(' address-family ipv4 unicast')
      for (const r of glob) out.push(`  ${r.prefix}/${r.mask} ${r.nextHop}${r.ad ? ` ${r.ad}` : ''}`)
      out.push(' !')
    }
    for (const [vrf, list] of byVrf) {
      if (!vrf) continue
      out.push(` vrf ${vrf}`, '  address-family ipv4 unicast')
      for (const r of list) out.push(`   ${r.prefix}/${r.mask} ${r.nextHop}${r.ad ? ` ${r.ad}` : ''}`)
      out.push('  !', ' !')
    }
    out.push('!')
  }
  if (d.ospf) {
    out.push(`router ospf ${d.ospf.process}`)
    if (d.ospf.routerId) out.push(` router-id ${d.ospf.routerId}`)
    const areas = [...new Set(d.ospf.ifaces.map((o) => o.area))]
    for (const a of areas) {
      out.push(` area ${a}`)
      for (const o of d.ospf.ifaces.filter((x) => x.area === a)) {
        out.push(`  interface ${o.iface}`)
        if (o.cost) out.push(`   cost ${o.cost}`)
        if (o.networkType === 'point-to-point') out.push('   network point-to-point')
        if (o.mtuIgnore) out.push('   mtu-ignore enable')
        if (o.passive) out.push('   passive enable')
        out.push('  !')
      }
      out.push(' !')
    }
    out.push('!')
  }
  if (d.localAs) {
    out.push(`router bgp ${d.localAs}`, ` bgp router-id ${d.routerId}`, ' address-family ipv4 unicast', ' !', ' address-family vpnv4 unicast', ' !')
    for (const n of [...d.bgp].filter((x) => !x.vrf).sort((a, b) => cmpIp(a.ip, b.ip))) out.push(...nbrBlock(n, ' '))
    for (const v of [...d.vrfs].filter((x) => x.rd).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(` vrf ${v.name}`, `  rd ${v.rd}`, '  address-family ipv4 unicast', '   redistribute connected', '  !')
      for (const n of d.bgp.filter((x) => x.vrf === v.name)) out.push(...nbrBlock(n, '  '))
      out.push(' !')
    }
    out.push('!')
  }
  out.push('ssh server v2', 'ssh server vrf MGMT', ...d.extraConfig)
  return out
}

function nbrBlock(n: Device['bgp'][number], ind: string): string[] {
  const l = [`${ind}neighbor ${n.ip}`, `${ind} remote-as ${n.remoteAs}`]
  if (n.description !== undefined) l.push(`${ind} description ${n.description}`)
  if (n.password) l.push(`${ind} password encrypted ${n.password}`)
  if (n.updateSource) l.push(`${ind} update-source ${n.updateSource}`)
  if (n.shutdown) l.push(`${ind} shutdown`)
  l.push(`${ind} address-family ipv4 unicast`)
  if (n.routeMapIn) l.push(`${ind}  route-policy ${n.routeMapIn} in`)
  if (n.routeMapOut) l.push(`${ind}  route-policy ${n.routeMapOut} out`)
  l.push(`${ind} !`, `${ind}!`)
  return l
}

export function runningConfig(d: Device, body = configBody(d)): string {
  const lc = xrStore(d).lastChange
  return ['Building configuration...', `!! IOS XR Configuration ${d.version}`, ...(lc ? [`!! Last configuration change at ${xrDate(lc.t)} by ${lc.by}`] : []), '!', ...body, 'end', ''].join('\n')
}

// ---------------------------------------------------------------- diff (show configuration)

interface CNode {
  line: string
  kids: CNode[]
}

function parse(lines: string[]): CNode[] {
  const root: CNode = { line: '', kids: [] }
  const stack: { n: CNode; ind: number }[] = [{ n: root, ind: -1 }]
  for (const raw of lines) {
    if (/^\s*!\s*$/.test(raw) || !raw.trim()) continue
    const ind = raw.length - raw.trimStart().length
    while (stack.length > 1 && stack.at(-1)!.ind >= ind) stack.pop()
    const node: CNode = { line: raw.trim(), kids: [] }
    stack.at(-1)!.n.kids.push(node)
    stack.push({ n: node, ind })
  }
  return root.kids
}

function dump(n: CNode, ind: string): string[] {
  return [`${ind}${n.line}`, ...n.kids.flatMap((k) => dump(k, ind + ' ')), ...(n.kids.length ? [`${ind}!`] : [])]
}

function diffNodes(a: CNode[], b: CNode[], ind: string): string[] {
  const out: string[] = []
  const added = b.filter((x) => !a.some((y) => y.line === x.line))
  for (const x of b) {
    const y = a.find((z) => z.line === x.line)
    if (!y) out.push(...dump(x, ind))
    else {
      const sub = diffNodes(y.kids, x.kids, ind + ' ')
      if (sub.length) out.push(`${ind}${x.line}`, ...sub, `${ind}!`)
    }
  }
  for (const y of a) {
    if (b.some((x) => x.line === y.line)) continue
    // A changed value ("description A" -> "description B") is shown as the new line only.
    const key = y.line.split(' ')[0]
    if (!y.kids.length && added.some((x) => !x.kids.length && x.line.split(' ')[0] === key && !['neighbor', 'interface'].includes(key!))) continue
    out.push(`${ind}no ${y.line}`)
  }
  return out
}

/** Lines that turn config `from` into config `to`, in XR config syntax. */
export function configDiff(from: string[], to: string[]): string[] {
  return diffNodes(parse(from), parse(to), '')
}
