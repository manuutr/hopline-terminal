/**
 * PAN-OS show renderers (docs/research/cli-paloalto-panos.md section 6). Layouts are the ntc raw
 * captures quoted in the doc; every value comes from the Device model or d.vendor.panosData.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, intToIp, ipToInt, lpad, macColon, network, pad } from '../../core/text.ts'
import { maskToDotted } from '../../core/tree.ts'
import { isUp, neighborState, ospfState, type Device, type Iface } from '../../state.ts'
import type { PanosData, PanosRule } from '../../devices/panos.ts'

export function pdata(d: Device): PanosData {
  const v = d.vendor as { panosData?: PanosData }
  v.panosData ??= {
    ifIds: {},
    aeMembers: {},
    mgmtProfile: {},
    ospfRoutes: [],
    advertised: {},
    rules: [],
    addresses: [],
    sessions: [],
    counters: [],
    lastCounterSample: d.bootedAt,
    jobs: [],
    nextJob: 1,
    arpTtl: {},
    macTtl: {},
    lldpPortDescr: {},
    mgmt: { ip: '192.168.1.1', mask: '255.255.255.0', gw: '192.168.1.254', mac: '00:50:56:00:00:00' },
    ha: { peer: '', localState: 'active', peerState: 'unknown', since: d.bootedAt }
  }
  return v.panosData
}

const two = (n: number): string => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Tue Nov 24 09:12:44 2026` (UTC). */
export function ctime(ms: number): string {
  const x = new Date(ms)
  return `${DAYS[x.getUTCDay()]} ${MONTHS[x.getUTCMonth()]} ${two(x.getUTCDate())} ${hms(ms)} ${x.getUTCFullYear()}`
}
export const hms = (ms: number): string => {
  const x = new Date(ms)
  return `${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}`
}
/** `2026/11/24 09:05:12`. */
export const ymdhms = (ms: number): string => {
  const x = new Date(ms)
  return `${x.getUTCFullYear()}/${two(x.getUTCMonth() + 1)}/${two(x.getUTCDate())} ${hms(ms)}`
}

const cidr = (i: Iface): string => `${i.ip}/${i.mask}`

/** Up, including the parent of a subinterface (ethernet1/3.100 follows ethernet1/3). */
export function ifUp(d: Device, i: Iface): boolean {
  if (!isUp(i)) return false
  const parent = i.name.includes('.') ? d.interfaces.find((x) => x.name === i.name.split('.')[0]) : undefined
  return !parent || isUp(parent)
}

// ------------------------------------------------------------------ system

export function systemInfo(d: Device): string {
  const t = now(d)
  const p = pdata(d)
  const s = Math.floor((t - d.bootedAt) / 1000)
  const days = Math.floor(s / 86400)
  const up = `${days} days, ${Math.floor((s % 86400) / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
  return [
    '',
    `hostname: ${d.hostname}`,
    `ip-address: ${p.mgmt.ip}`,
    `netmask: ${p.mgmt.mask}`,
    `default-gateway: ${p.mgmt.gw}`,
    'ipv6-address: unknown',
    `ipv6-link-local-address: fe80::250:56ff:fe8a:1000/64`,
    'ipv6-default-gateway: ',
    `mac-address: ${p.mgmt.mac}`,
    `time: ${ctime(t)}`,
    `uptime: ${up}`,
    'family: vm',
    `model: ${d.model}`,
    `serial: ${d.serial}`,
    'vm-mac-base: BA:DB:EE:FB:AD:00',
    'vm-mac-count: 256',
    'vm-uuid: 564D8B6D-7BDB-75AF-400F-B062016DC67E',
    'vm-cpuid: ESX:FB060000FDFB8B07',
    'vm-license: VM-300',
    'vm-mode: VMWare ESXi',
    `sw-version: ${d.version}`,
    'global-protect-client-package-version: 0.0.0',
    'app-version: 8930-9310',
    'app-release-date: 2026/11/18 15:04:12 PST',
    'av-version: 5021-5539',
    'av-release-date: 2026/11/23 06:01:33 PST',
    'threat-version: 8930-9310',
    'threat-release-date: 2026/11/18 15:04:12 PST',
    'wf-private-version: 0',
    'wf-private-release-date: unknown',
    'url-db: paloaltonetworks',
    'wildfire-version: 0',
    'wildfire-release-date: unknown',
    'url-filtering-version: 20261124.20142',
    'global-protect-datafile-version: 0',
    'global-protect-datafile-release-date: unknown',
    'logdb-version: 11.1.2',
    'platform-family: vm',
    'vpn-disable-mode: off',
    'multi-vsys: off',
    'operational-mode: normal'
  ].join('\n')
}

export function systemResources(d: Device): string {
  const t = now(d)
  const h = hog(d)
  const load = h ? [h.pct / 25, h.pct / 30, h.pct / 40] : d.cpu.load.map((l) => l / 10)
  const procs = [...d.cpu.processes]
  if (h && !procs.some((p) => p.pid === h.pid)) procs.push({ pid: h.pid, name: h.name, pct: h.pct })
  const pct = (p: { pid: number; pct: number }): number => (h && h.pid === p.pid ? h.pct : p.pct)
  const idle = Math.max(0, 100 - procs.reduce((a, p) => a + pct(p), 0))
  return [
    `top - ${hms(t)} up ${Math.floor((t - d.bootedAt) / 86400_000)} days,  ${Math.floor(((t - d.bootedAt) % 86400_000) / 3600_000)}:${two(Math.floor(((t - d.bootedAt) % 3600_000) / 60_000))},  1 user,  load average: ${load.map((l) => l.toFixed(2)).join(', ')}`,
    `Tasks: 176 total,   1 running, 175 sleeping,   0 stopped,   0 zombie`,
    `%Cpu(s): ${(100 - idle).toFixed(1)} us,  0.4 sy,  0.0 ni, ${idle.toFixed(1)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`,
    'MiB Mem :   7954.5 total,   1024.3 free,   4412.8 used,   2517.4 buff/cache',
    'MiB Swap:      0.0 total,      0.0 free,      0.0 used.   3102.6 avail Mem',
    '',
    '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ...procs.sort((a, b) => pct(b) - pct(a)).map((p) => `${lpad(p.pid, 7)} root      20   0  812340 215420  14200 S ${lpad(pct(p).toFixed(1), 5)}   2.6  41:12.07 ${p.name}`)
  ].join('\n')
}

// ------------------------------------------------------------------ interfaces

export function ifId(d: Device, i: Iface): number {
  const p = pdata(d)
  if (p.ifIds[i.name] !== undefined) return p.ifIds[i.name]!
  const m = /^ethernet1\/(\d+)$/.exec(i.name)
  if (m) return 15 + Number(m[1])
  return 259 + d.interfaces.indexOf(i)
}

const isHw = (i: Iface): boolean => !i.name.includes('.')
const isPhys = (i: Iface): boolean => i.speed !== ''

export function hwState(i: Iface): string {
  if (!isPhys(i)) return `[n/a]/[n/a]/${i.adminUp ? 'up' : 'down'}/[n/a]`
  if (!i.adminUp) return 'ukn/ukn/down(power-down)/ukn'
  if (!isUp(i)) return 'ukn/ukn/down((autoneg))/ukn'
  return `${i.speed}/${i.duplex === 'half' ? 'half' : 'full'}/up/auto`
}

export function interfaceAll(d: Device, which: 'all' | 'hardware' | 'logical'): string {
  const out: string[] = []
  if (which !== 'logical') {
    const hw = d.interfaces.filter(isHw)
    out.push(`total configured hardware interfaces: ${hw.length}`, 'name                    id    speed/duplex/state/fec        mac address', '-'.repeat(80))
    for (const i of hw) out.push(`${pad(i.name, 24)}${pad(ifId(d, i), 6)}${pad(hwState(i), 30)}${i.mac}`)
    const ae = Object.entries(pdata(d).aeMembers).filter(([n]) => d.interfaces.some((i) => i.name === n))
    out.push('', `aggregation groups: ${ae.length}`)
    for (const [n, m] of ae) out.push(`${n} members:`, `  ${m.join(' ')}`)
    out.push('')
  }
  if (which !== 'hardware') {
    if (which === 'all') out.push('')
    out.push(`total configured logical interfaces: ${d.interfaces.length}`, '', 'name                      id    vsys zone             forwarding               tag    address', '', '------------------- ----- ---- ---------------- ------------------------ ------ ------------------')
    for (const i of d.interfaces) out.push(`${pad(i.name, 26)}${pad(ifId(d, i), 6)}${pad(1, 5)}${pad(i.zone ?? '', 17)}${pad(i.ip ? 'vr:default' : 'N/A', 25)}${pad(i.vlan ?? 0, 7)}${i.ip ? cidr(i) : 'N/A'}`)
  }
  return out.join('\n')
}

export function interfaceDetail(d: Device, i: Iface): string {
  const p = pdata(d)
  const t = now(d)
  const phys = isPhys(i)
  const st = hwState(i).split('/')
  const lines = [
    '-------------------------------------------------------------------------------',
    `Name: ${i.name}, ID: ${ifId(d, i)}`,
    `Link status:`,
    `  Runtime link speed/duplex/state: ${phys ? `${st[0]}/${st[1]}/${st[2]}` : `${st[0]}/${st[1]}/${st[2]}`}`,
    `  Configured link speed/duplex/state: auto/auto/${i.adminUp ? 'auto' : 'down'}`,
    `MAC address:`,
    `  Port MAC address ${i.mac}`,
    `Operation mode: layer3`,
    '-------------------------------------------------------------------------------',
    `Name: ${i.name}, ID: ${ifId(d, i)}`,
    `Operation mode: layer3`,
    `Virtual router default`,
    `Interface MTU ${i.mtu ?? 1500}`,
    `Interface IP address: ${i.ip ? cidr(i) : 'N/A'}`,
    `Interface management profile: ${p.mgmtProfile[i.name] ?? 'N/A'}`,
    `Service configured:`,
    `Zone: ${i.zone ?? 'N/A'}, virtual system: vsys1`,
    `Adjust TCP MSS: no`,
    `Policing: no`,
    `Comment: ${i.description ?? ''}`,
    '-------------------------------------------------------------------------------'
  ]
  if (phys) {
    const secs = Math.max(0, (t - (i.clearedAt ?? d.bootedAt)) / 1000)
    const c = { rx: Math.floor((isUp(i) ? 20 : 0) * secs * 0.6), tx: Math.floor((isUp(i) ? 18 : 0) * secs * 0.6) }
    lines.push('', 'Physical port counters read from MAC:', '-------------------------------------------------------------------------------', `rx-broadcast                  0`, `rx-bytes                      ${c.rx * 118}`, `rx-unicast                    ${c.rx}`, `tx-bytes                      ${c.tx * 126}`, `tx-unicast                    ${c.tx}`, '-------------------------------------------------------------------------------')
  }
  return lines.join('\n')
}

export function vpnFlow(d: Device): string {
  const tunnels = d.ipsec ?? []
  const rows = tunnels.map((t, index) => {
    const wan = d.interfaces.find((i) => i.name === t.underlay)
    const iface = d.interfaces.find((i) => i.name === t.iface)
    const active = wan && iface && ifUp(d, wan) && ifUp(d, iface)
    return `${pad(String(index + 1), 6)}${pad(t.name, 30)}${pad(active ? 'active' : 'init', 8)}off     ${pad(wan?.ip ?? '0.0.0.0', 22)}${pad(t.peer, 22)}${t.iface}`
  })
  return [`total tunnels configured: ${tunnels.length}`, 'filter - type IPSec, state any', '',
    `total IPSec tunnel shown: ${rows.length}`, '', 'id    name                          state   monitor local-ip              peer-ip               tunnel-i/f', ...rows].join('\n')
}

// ------------------------------------------------------------------ routing

interface Rt {
  prefix: string
  mask: number
  nexthop: string
  metric: string
  flags: string
  age: string
  iface: string
  nextAs: string
}

export function routes(d: Device): Rt[] {
  const t = now(d)
  const p = pdata(d)
  const out: Rt[] = []
  for (const i of d.interfaces) {
    if (!i.ip || i.mask === undefined || !ifUp(d, i)) continue
    out.push({ prefix: network(i.ip, i.mask), mask: i.mask, nexthop: i.ip, metric: '0', flags: 'A C', age: '', iface: i.name, nextAs: '' })
    if (i.mask < 32) out.push({ prefix: i.ip, mask: 32, nexthop: '0.0.0.0', metric: '0', flags: 'A H', age: '', iface: '', nextAs: '' })
  }
  for (const s of d.staticRoutes) {
    const via = d.interfaces.find((i) => i.ip && i.mask !== undefined && ifUp(d, i) && inSubnet(s.nextHop, i.ip, i.mask))
    if (!via) continue
    out.push({ prefix: s.prefix, mask: s.mask, nexthop: s.nextHop, metric: String(s.ad ?? 10), flags: 'A S', age: '', iface: via.name, nextAs: '' })
  }
  const nb = d.ospf?.neighbors.find((n) => ospfState(d, n) === 'FULL')
  if (nb) {
    const age = String(Math.floor((t - (nb.upSince ?? d.bootedAt)) / 1000))
    for (const r of p.ospfRoutes) {
      const n = d.ospf!.neighbors.find((x) => x.ip === r.via)
      if (!n || ospfState(d, n) !== 'FULL') continue
      out.push({ prefix: r.prefix, mask: r.mask, nexthop: r.via, metric: String(r.metric), flags: 'A Oi', age, iface: r.iface, nextAs: '' })
    }
  }
  for (const b of d.bgp) {
    if (neighborState(d, b, t) !== 'Established') continue
    const age = String(Math.floor((t - (b.upSince ?? t)) / 1000))
    for (const r of b.routes ?? []) {
      if (out.some((x) => x.prefix === r.prefix && x.mask === r.mask)) continue
      out.push({ prefix: r.prefix, mask: r.mask, nexthop: b.ip, metric: '', flags: 'A?B', age, iface: '', nextAs: String(b.remoteAs) })
    }
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

export function routingRoute(d: Device, filter: { type?: string; destination?: string } = {}): string {
  let rs = routes(d)
  const types: Record<string, string> = { connect: 'C', static: 'S', ospf: 'O', bgp: 'B', host: 'H' }
  if (filter.type) rs = rs.filter((r) => r.flags.includes(types[filter.type!] ?? '?!'))
  if (filter.destination) {
    const [ip, len] = filter.destination.split('/')
    rs = rs.filter((r) => (len ? r.prefix === network(ip!, Number(len)) && r.mask === Number(len) : inSubnet(ip!, r.prefix, r.mask)))
  }
  const rows = rs.map((r) => `${pad(`${r.prefix}/${r.mask}`, 44)}${pad(r.nexthop, 40)}${pad(r.metric, 7)}${pad(r.flags, 11)}${pad(r.age, 6)}${pad(r.iface, 19)}${r.nextAs}`.trimEnd())
  return [
    'flags: A:active, ?:loose, C:connect, H:host, S:static, ~:internal, R:rip, O:ospf, B:bgp,',
    '       Oi:ospf intra-area, Oo:ospf inter-area, O1:ospf ext-type-1, O2:ospf ext-type-2, E:ecmp, M:multicast',
    '',
    'VIRTUAL ROUTER: default (id 1)',
    '  ==========',
    'destination                                 nexthop                                 metric flags      age   interface          next-AS',
    ...rows,
    `total routes shown: ${rows.length}`
  ].join('\n')
}

export function fibLookup(d: Device, ip: string): string {
  const best = routes(d)
    .filter((r) => r.flags !== 'A H' && inSubnet(ip, r.prefix, r.mask))
    .sort((a, b) => b.mask - a.mask)[0]
  if (!best) return `--------------------------------------------------------------------------------\nruntime route lookup(virtual-router: default, ip: ${ip}) failed\n--------------------------------------------------------------------------------`
  const iface = best.iface || d.bgp.find((b) => b.ip === best.nexthop)?.via || ''
  const src = d.interfaces.find((i) => i.name === iface)?.ip ?? ''
  return `--------------------------------------------------------------------------------\nruntime route lookup(virtual-router: default, ip: ${ip}):\n  destination: ${best.prefix}/${best.mask}, nexthop ${best.nexthop}, interface ${iface}, source ${src}\n--------------------------------------------------------------------------------`
}

export function bgpState(d: Device, ip: string): string {
  const n = d.bgp.find((b) => b.ip === ip)!
  const s = neighborState(d, n)
  return s === 'Idle (Admin)' ? 'Idle' : s
}

export function bgpSummary(d: Device): string {
  const p = pdata(d)
  const up = d.bgp.filter((n) => bgpState(d, n.ip) === 'Established')
  const rib = up.reduce((a, n) => a + (p.advertised[n.ip] ?? 1), 0) + 6
  const out = [
    '  ==========',
    `  router id:                     ${d.routerId}`,
    '  virtual router:                default',
    '  reject default route:          no',
    '  redist default route:          allow',
    '  Install BGP routes:            yes',
    '  Graceful Restart:              supported',
    '  AS size:                       4',
    `  Local AS:                      ${d.localAs}`,
    '  Local member AS:               0',
    '  Cluster id:                    0.0.0.0',
    '  Default local preference:      100',
    '  Always compare MED:            no',
    '  Aggregate regardless MED:      yes',
    '  Deterministic MED processing:  yes',
    '  Accept ORF:                    no',
    '  Accept CISCO style prefix:     yes',
    '  mp-bgp-enable:                 yes',
    '  afi-safi-ipv4-unicast:         yes',
    `  rib-out entries:               current ${rib}, peak ${rib}`
  ]
  for (const n of d.bgp) {
    const st = bgpState(d, n.ip)
    const est = st === 'Established'
    out.push(`    peer ${peerName(n)}: AS ${n.remoteAs}, ${st}, IP ${n.ip}`, `      bgpAfiIpv4/unicast pfx:    Accepted pfx: ${est ? n.prefixes : 0}, Advertised pfx: ${est ? (p.advertised[n.ip] ?? 1) : 0}`)
  }
  return out.join('\n')
}

export const peerName = (n: { description?: string; ip: string }): string => (n.description && /^[\w.-]+$/.test(n.description) ? n.description : `peer-${n.ip.replace(/\./g, '-')}`)

export function bgpPeer(d: Device, name?: string): string {
  const t = now(d)
  const list = d.bgp.filter((n) => !name || peerName(n) === name)
  return list
    .map((n) => {
      const st = bgpState(d, n.ip)
      const est = st === 'Established'
      const iface = d.interfaces.find((i) => i.name === n.via)
      return [
        '  ==========',
        `  Peer:                         ${peerName(n)}`,
        '  Virtual Router:               default',
        '  Peer group:                   ' + (n.remoteAs === d.localAs ? 'ibgp' : 'ebgp'),
        `  Peer router id:               ${est ? (n.routerId ?? '0.0.0.0') : '0.0.0.0'}`,
        `  Remote AS:                    ${n.remoteAs}`,
        `  Peer status:                  ${st}${est ? `, for ${Math.floor((t - (n.upSince ?? t)) / 1000)} seconds` : ''}`,
        `  Peer address:                 ${n.ip}:179`,
        `  Local address:                ${iface?.ip ?? '0.0.0.0'}:${est ? 33127 : 0}`,
        `  Reflector client:             No`,
        `  Prefix limit:                 5000`,
        `  Holdtime:                     ${est ? 90 : 0}`,
        `  Keepalive:                    ${est ? 30 : 0}`,
        `  Messages received:            ${n.msgRcvd ?? 0}`,
        `  Messages sent:                ${n.msgSent ?? 0}`,
        `  Prefixes accepted:            ${est ? n.prefixes : 0}`,
        ...(n.description && !/^[\w.-]+$/.test(n.description) ? [`  Description:                  ${n.description}`] : [])
      ].join('\n')
    })
    .join('\n')
}

export function ospfNeighbor(d: Device): string {
  const t = now(d)
  const out: string[] = []
  for (const n of d.ospf?.neighbors ?? []) {
    const s = ospfState(d, n)
    if (!s) continue
    out.push(
      '  ==========',
      '  virtual router:               default',
      `  neighbor address:             ${n.ip}`,
      `  local address binding:        ${d.interfaces.find((i) => i.name === n.iface)?.ip ?? '0.0.0.0'}`,
      '  type:                         dynamic',
      `  status:                       ${s === 'FULL' ? 'full' : s === 'EXSTART' ? 'exstart' : '2way'}`,
      `  neighbor router ID:           ${n.routerId}`,
      `  area id:                      ${n.area}`,
      `  neighbor priority:            ${n.pri}`,
      `  lifetime remain:              ${33 + (Math.floor(t / 1000) % 7)}`,
      '  messages pending:             0',
      '  LSA request pending:          0',
      '  options:                      0x42',
      '  hello suppressed:             no',
      '  restart helper status:        not helping'
    )
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ arp / mac / lldp

/** ARP entries on up interfaces whose address lies in that interface's subnet (drops entries a lab rewire made stale). */
/** The CPU hog, while the service that feeds it is on. */
export function hog(d: Device): Device['cpu']['hog'] {
  const h = d.cpu.hog
  return h && (!h.whileService || d.services[h.whileService]) ? h : undefined
}

export function liveArp(d: Device): Device['arp'] {
  return d.arp.filter((a) => {
    const i = d.interfaces.find((x) => x.name === a.iface)
    if (!i) return true
    return ifUp(d, i) && (!i.ip || i.mask === undefined || inSubnet(a.ip, i.ip, i.mask))
  })
}

/** Source-NAT address: the egress zone's interface address (the model's address can move in the lab). */
export function natIp(d: Device, zone: string, fallback: string): string {
  if (d.interfaces.some((i) => i.ip === fallback)) return fallback
  return d.interfaces.find((i) => i.zone === zone && i.ip)?.ip ?? fallback
}

export function arpAll(d: Device, iface?: string): string {
  const p = pdata(d)
  const list = liveArp(d).filter((a) => !iface || a.iface === iface)
  return [
    '',
    'maximum of entries supported :      1500',
    'default timeout:                    1800 seconds',
    `total ARP entries in table :        ${list.length}`,
    `total ARP entries shown :           ${list.length}`,
    'status: s - static, c - complete, e - expiring, i - incomplete',
    '',
    'interface         ip address      hw address        port              status   ttl',
    '-'.repeat(80),
    ...list.map((a) => `${pad(a.iface, 18)}${pad(a.ip, 16)}${pad(a.mac ? macColon(a.mac) : '(incomplete)', 18)}${pad(a.iface, 20)}${pad(a.mac ? 'c' : 'i', 7)}${p.arpTtl[a.ip] ?? Math.max(1, 1800 - a.age * 60)}`)
  ].join('\n')
}

export function macAll(d: Device): string {
  const p = pdata(d)
  return [
    '',
    'maximum of entries supported :      1500',
    'default timeout :                   1800 seconds',
    `total MAC entries in table :        ${d.mac.length}`,
    `total MAC entries shown :           ${d.mac.length}`,
    'status: s - static, c - complete, i - incomplete',
    '',
    'vlan                hw address        interface         status   ttl',
    '-'.repeat(80),
    ...d.mac.map((m) => `${pad(d.vlans.find((v) => v.id === m.vlan)?.name ?? String(m.vlan), 20)}${pad(m.mac, 18)}${pad(m.port, 20)}${pad('c', 7)}${p.macTtl[m.mac] ?? 1800}`)
  ].join('\n')
}

export function lldpAll(d: Device): string {
  const p = pdata(d)
  return d.lldp
    .map((n) => {
      const i = d.interfaces.find((x) => x.name === n.local)
      const caps = (n.caps ?? 'R')
        .split(',')
        .map((c) => c.trim() + ',')
        .join(' ')
      return [
        'Local information:',
        `Index ${i ? ifId(d, i) : 0}`,
        `Local interface: ${n.local}`,
        `Local Port ID: ${/(\d+)$/.exec(n.local)?.[1] ?? '0'}`,
        'Neighbor information:',
        '',
        'Chassis type: MAC address',
        `Chassis ID: ${n.chassisId ?? '00:00:00:00:00:00'}`,
        'Port type: Interface name',
        `Port ID: ${n.port}`,
        `Port description: ${p.lldpPortDescr[n.local] ?? n.port}`,
        `TTL: ${n.holdtime ?? 120}`,
        `System name: ${n.device}`,
        `System description: ${n.sysDescr ?? n.platform ?? ''}`,
        'System capabilities:',
        `Supported: ${caps}`,
        `Enabled: ${caps}`
      ].join('\n')
    })
    .join('\n\n')
}

// ------------------------------------------------------------------ sessions / counters / jobs / ha

export interface SessionFilter {
  source?: string
  destination?: string
  application?: string
  from?: string
  to?: string
  'destination-port'?: string
  protocol?: string
  rule?: string
}

export function sessionsFiltered(d: Device, f: SessionFilter): PanosData['sessions'] {
  return pdata(d).sessions.filter(
    (s) =>
      (!f.source || s.src === f.source) &&
      (!f.destination || s.dst === f.destination) &&
      (!f.application || s.app === f.application) &&
      (!f.from || s.from === f.from) &&
      (!f.to || s.to === f.to) &&
      (!f['destination-port'] || String(s.dport) === f['destination-port']) &&
      (!f.protocol || String(s.proto) === f.protocol) &&
      (!f.rule || s.rule === f.rule)
  )
}

export function sessionAll(d: Device, f: SessionFilter = {}): string {
  const list = sessionsFiltered(d, f)
  if (!list.length) return 'No Active Sessions'
  return [
    'ID/vsys  application    state  type flag  src[sport]/zone/proto (translated IP[port])',
    '                                              dst[dport]/zone (translated IP[port]',
    '-'.repeat(79),
    ...list.flatMap((s) => [
      `${pad(`${s.id}/${s.vsys}`, 9)}${pad(s.app, 15)}${pad(s.state, 8)}${pad(s.type, 6)}${pad(s.flag, 4)}${s.src}[${s.sport}]/${s.from}/${s.proto} (${natIp(d, s.to, s.natSrc)}[${s.natSport}])`,
      `${' '.repeat(42)}${s.dst}[${s.dport}]/${s.to} (${s.natDst}[${s.natDport}])`
    ])
  ].join('\n')
}

export function sessionInfo(d: Device): string {
  const n = pdata(d).sessions.length
  const tcp = pdata(d).sessions.filter((s) => s.proto === 6).length
  const udp = pdata(d).sessions.filter((s) => s.proto === 17).length
  return [
    'target-dp:                                       *.dp0',
    '--------------------------------------------------------------------------------',
    'Number of sessions supported:                    256000',
    `Number of allocated sessions:                    ${n}`,
    `Number of active TCP sessions:                   ${tcp}`,
    `Number of active UDP sessions:                   ${udp}`,
    `Number of active ICMP sessions:                  ${n - tcp - udp}`,
    'Number of active GTPc sessions:                  0',
    'Number of active GTPu sessions:                  0',
    'Number of pending GTPu sessions:                 0',
    'Number of active BCAST sessions:                 0',
    'Number of active MCAST sessions:                 0',
    'Number of active predict sessions:               0',
    'Number of active SCTP sessions:                  0',
    'Number of active SCTP associations:              0',
    `Session table utilization:                       0%`,
    'Number of sessions created since bootup:         418233',
    'Packet rate:                                     63/s',
    'Throughput:                                      312 kbps',
    'New connection establish rate:                   2 cps',
    '--------------------------------------------------------------------------------',
    'Session timeout',
    '  TCP default timeout:                           3600 secs',
    '  UDP default timeout:                           30 secs',
    '  ICMP default timeout:                          6 secs',
    '--------------------------------------------------------------------------------'
  ].join('\n')
}

export function sessionId(d: Device, id: number): string {
  const s = pdata(d).sessions.find((x) => x.id === id)
  if (!s) return 'Session ' + id + ' is not valid'
  const t = now(d)
  return [
    '',
    `Session           ${s.id}`,
    '',
    '        c2s flow:',
    `                source:      ${s.src} [${s.from}]`,
    `                dst:         ${s.dst}`,
    `                proto:       ${s.proto}`,
    `                sport:       ${s.sport}           dport:      ${s.dport}`,
    '                state:       ' + s.state + '          type:       ' + s.type,
    '',
    '        s2c flow:',
    `                source:      ${s.natDst} [${s.to}]`,
    `                dst:         ${natIp(d, s.to, s.natSrc)}`,
    `                proto:       ${s.proto}`,
    `                sport:       ${s.natDport}            dport:      ${s.natSport}`,
    '',
    `        start time                           : ${ctime(s.start)}`,
    `        timeout                              : ${s.proto === 6 ? 3600 : 30} sec`,
    `        time to live                         : ${Math.max(1, (s.proto === 6 ? 3600 : 30) - Math.floor((t - s.start) / 1000))} sec`,
    `        vsys                                 : vsys${s.vsys}`,
    `        application                          : ${s.app}`,
    `        rule                                 : ${s.rule}`,
    `        session to be logged at end          : True`,
    `        ingress interface                    : ${d.interfaces.find((i) => i.zone === s.from && i.ip)?.name ?? ''}`,
    `        egress interface                     : ${d.interfaces.find((i) => i.zone === s.to && i.ip)?.name ?? ''}`
  ].join('\n')
}

export function counterGlobal(d: Device, f: { delta?: boolean; severity?: string }): string {
  const p = pdata(d)
  const t = now(d)
  const elapsed = ((t - p.lastCounterSample) / 1000).toFixed(3)
  if (f.delta) p.lastCounterSample = t
  const list = p.counters.filter((c) => !f.severity || c.severity === f.severity)
  return [
    'Global counters:',
    `Elapsed time since last sampling: ${elapsed} seconds`,
    '',
    'name                                   value     rate severity  category  aspect    description',
    '-'.repeat(80),
    ...list.map((c) => `${pad(c.name, 31)}${lpad(c.value, 13)}${lpad(c.rate, 9)} ${pad(c.severity, 10)}${pad(c.category, 10)}${pad(c.aspect, 10)}${c.description}`),
    '-'.repeat(80),
    `Total counters shown: ${list.length}`,
    '-'.repeat(80)
  ].join('\n')
}

export function jobsAll(d: Device): string {
  const rows = [...pdata(d).jobs].sort((a, b) => b.id - a.id)
  return [
    '',
    'Enqueued              Dequeued           ID  PositionInQ                              Type                         Status Result Completed',
    '-'.repeat(138),
    ...rows.map((j) => `${pad(ymdhms(j.enq), 22)}${hms(j.deq)}${lpad(j.id, 13)}${lpad(j.type, 47)}${lpad(j.status, 31)}${lpad(j.result, 7)} ${j.status === 'FIN' ? hms(j.done) : ''}`.trimEnd())
  ].join('\n')
}

export function jobId(d: Device, id: number): string {
  const j = pdata(d).jobs.find((x) => x.id === id)
  if (!j) return `Server error : job ${id} not found`
  return [
    'Enqueued              Dequeued       ID             Type    Status Result Completed',
    `${pad(ymdhms(j.enq), 22)}${hms(j.deq)}${lpad(j.id, 9)}${lpad(j.type, 17)}${lpad(j.status, 10)}${lpad(j.result, 7)}  ${hms(j.done)}`,
    `Details:${j.details ?? ''}`
  ].join('\n')
}

export function haState(d: Device): string {
  const p = pdata(d)
  const days = Math.max(0, Math.floor((now(d) - p.ha.since) / 86400_000))
  if (!p.ha.peer) return '\nHA not enabled'
  return [
    '',
    'Group 1:',
    '  Mode: Active-Passive',
    '  Local Information:',
    '    Version: 1',
    '    Mode: Active-Passive',
    `    State: ${p.ha.localState} (last ${days} days)`,
    '    State Synchronization: Complete; type: ethernet',
    '  Peer Information:',
    '    Connection status: up',
    '    Version: 1',
    '    Mode: Active-Passive',
    `    State: ${p.ha.peerState} (last ${days} days)`,
    '  Configuration Synchronization:',
    '    Enabled: yes',
    '    Running Configuration: synchronized'
  ].join('\n')
}

export function logSystem(d: Device): string {
  const rows = [...d.log].sort((a, b) => b.t - a.t)
  return [
    'Time                Severity Subtype Object EventID ID Description',
    '===============================================================================',
    ...rows.map((l) => `${ymdhms(l.t)} info     ${l.msg}`)
  ].join('\n')
}

// ------------------------------------------------------------------ security policy

const APP_PORTS: Record<string, string> = {
  dns: 'udp/any/53',
  'dns-base': 'udp/any/53',
  ssl: 'tcp/any/443',
  'web-browsing': 'tcp/any/80',
  ssh: 'tcp/any/22',
  ntp: 'udp/any/123',
  ping: 'icmp/any/any',
  bgp: 'tcp/any/179',
  any: 'any/any/any'
}

/** Address object names resolved to their values (PAN-OS shows the compiled form). */
function resolveAddr(d: Device, list: string[]): string[] {
  const p = pdata(d)
  return list.map((a) => p.addresses.find((x) => x.name === a)?.ipNetmask ?? p.addresses.find((x) => x.name === a)?.fqdn ?? a)
}

const plist = (l: string[]): string => (l.length === 1 ? l[0]! : `[ ${l.join(' ')} ]`)

function appService(r: PanosRule): string[] {
  if (r.service.includes('application-default')) return r.application.map((a, k) => `${k}:${a}/${APP_PORTS[a] ?? 'tcp/any/any'}`)
  return r.application.map((a, k) => `${k}:${a}/${r.service.includes('any') ? 'any/any/any' : r.service.join(',')}`)
}

export function ruleBlock(d: Device, r: PanosRule, index?: number): string {
  return [
    `"${r.name}${index !== undefined ? `; index: ${index}` : ''}" {`,
    `        from ${plist(r.from)};`,
    `        source ${plist(resolveAddr(d, r.source))};`,
    '        source-region none;',
    `        to ${plist(r.to)};`,
    `        destination ${plist(resolveAddr(d, r.destination))};`,
    '        destination-region none;',
    '        user any;',
    '        source-device any;',
    '        destinataion-device any;',
    '        category any;',
    `        application/service ${plist(appService(r))};`,
    `        action ${r.action};`,
    '        icmp-unreachable: no',
    '        terminal yes;',
    '}'
  ].join('\n')
}

export function runningPolicy(d: Device): string {
  return pdata(d)
    .rules.filter((r) => !r.disabled)
    .map((r) => ruleBlock(d, r))
    .join('\n\n')
}

function addrMatch(d: Device, list: string[], ip: string | undefined): boolean {
  if (list.includes('any') || !ip) return true
  return resolveAddr(d, list).some((a) => {
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(a)) {
      const [n, l] = a.split('/')
      return inSubnet(ip, n!, Number(l))
    }
    if (/^\d+\.\d+\.\d+\.\d+-\d+\.\d+\.\d+\.\d+$/.test(a)) {
      const [x, y] = a.split('-')
      return ipToInt(ip) >= ipToInt(x!) && ipToInt(ip) <= ipToInt(y!)
    }
    return a === ip
  })
}

const PROTO: Record<string, string> = { '6': 'tcp', '17': 'udp', '1': 'icmp' }

function svcMatch(r: PanosRule, port?: string, proto?: string, app?: string): boolean {
  if (app && !r.application.includes('any') && !r.application.includes(app)) return false
  if (r.service.includes('any') || (!port && !proto)) return true
  const pr = proto ? PROTO[proto] : undefined
  const specs = r.service.includes('application-default') ? r.application.map((a) => APP_PORTS[a] ?? 'tcp/any/any') : []
  if (!specs.length) return true
  return specs.some((s) => {
    const [sp, , dp] = s.split('/')
    return (sp === 'any' || !pr || sp === pr) && (dp === 'any' || !port || dp === port)
  })
}

export interface MatchQuery {
  from?: string
  to?: string
  source?: string
  destination?: string
  'destination-port'?: string
  protocol?: string
  application?: string
}

export function policyMatch(d: Device, q: MatchQuery): string {
  const rules = pdata(d).rules
  const k = rules.findIndex(
    (r) =>
      !r.disabled &&
      (!q.from || r.from.includes('any') || r.from.includes(q.from)) &&
      (!q.to || r.to.includes('any') || r.to.includes(q.to)) &&
      addrMatch(d, r.source, q.source) &&
      addrMatch(d, r.destination, q.destination) &&
      svcMatch(r, q['destination-port'], q.protocol, q.application)
  )
  if (k >= 0) return ruleBlock(d, rules[k]!, k + 1)
  const intra = q.from && q.from === q.to
  const r: PanosRule = { name: intra ? 'intrazone-default' : 'interzone-default', from: [q.from ?? 'any'], to: [q.to ?? 'any'], source: ['any'], destination: ['any'], application: ['any'], service: ['any'], action: intra ? 'allow' : 'deny' }
  return ruleBlock(d, r, rules.length + (intra ? 1 : 2))
}

export const ipMask = (ip: string, mask: number): string => `${ip} ${maskToDotted(mask)}`
export { intToIp }
