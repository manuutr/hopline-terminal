/**
 * FortiOS `get` / `diagnose` renderers (docs/research/cli-fortinet-fortios.md section 6). Layouts
 * follow the ntc raw captures quoted in the doc; values come from the Device model and
 * d.vendor.fortiData.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, lpad, macColon, network, pad } from '../../core/text.ts'
import { maskToDotted } from '../../core/tree.ts'
import { isUp, neighborState, ospfState, type Device, type Iface } from '../../state.ts'
import type { FortiData } from '../../devices/fortios.ts'

export function fdata(d: Device): FortiData {
  const v = d.vendor as { fortiData?: FortiData }
  v.fortiData ??= { ifExtra: {}, ifIndex: {}, policies: [], addresses: [{ name: 'all', rec: [['uuid', '00000000-0000-51ef-0000-000000000000']] }], console: { output: 'more' }, ospfRoutes: [], sessions: [], arpDiag: {}, lldpMac: {}, uuidSeq: 1 }
  return v.fortiData
}

const two = (n: number): string => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function ctime(ms: number): string {
  const x = new Date(ms)
  return `${DAYS[x.getUTCDay()]} ${MONTHS[x.getUTCMonth()]} ${two(x.getUTCDate())} ${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())} ${x.getUTCFullYear()}`
}

/** ZebOS age: `01:12:33` under a day, then `2d03h11m`. */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  if (h < 24) return `${two(h)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
  return `${Math.floor(h / 24)}d${two(h % 24)}h${two(Math.floor((s % 3600) / 60))}m`
}

export const ipMask = (i: Iface): string => (i.ip ? `${i.ip} ${maskToDotted(i.mask ?? 32)}` : '0.0.0.0 0.0.0.0')

export function ifIndex(d: Device, i: Iface): number {
  return fdata(d).ifIndex[i.name] ?? 20 + d.interfaces.indexOf(i)
}

export const extra = (d: Device, name: string, k: string): string | undefined => fdata(d).ifExtra[name]?.find(([f]) => f === k)?.[1]

export const ifType = (d: Device, i: Iface): string => extra(d, i.name, 'type') ?? (i.speed ? 'physical' : 'vlan')

/** Up, including a VLAN interface's parent. */
export function ifUp(d: Device, i: Iface): boolean {
  if (!isUp(i)) return false
  const parent = extra(d, i.name, 'interface')?.replace(/"/g, '')
  const p = parent ? d.interfaces.find((x) => x.name === parent) : undefined
  return !p || isUp(p)
}

// ------------------------------------------------------------------ system

export function systemStatus(d: Device): string {
  return [
    `Version: ${d.model} v${d.version},build2662,240514 (GA.F)`,
    'First GA patch build date: 230509',
    'Current Security Level: Low',
    'Firmware Signature: certified',
    'Virus-DB: 93.06337(2025-11-26 16:20)',
    'Extended DB: 93.06337(2025-11-26 16:20)',
    'AV AI/ML Model: 4.03476(2025-11-26 19:45)',
    'IPS-DB: 34.00122(2025-11-20 01:21)',
    'IPS-ETDB: 0.00000(2001-01-01 00:00)',
    'APP-DB: 34.00124(2025-11-25 00:56)',
    'FMWP-DB: 25.00090(2025-09-15 13:20)',
    'IPS Malicious URL Database: 5.00603(2025-11-21 01:46)',
    'IoT-Detect: 35.00125(2025-11-25 16:28)',
    'OT-Detect-DB: 34.00123(2025-11-21 15:16)',
    'OT-Patch-DB: 34.00123(2025-11-21 13:21)',
    'OT-Threat-DB: 34.00122(2025-11-20 01:20)',
    'IPS-Engine: 7.00575(2025-07-03 18:00)',
    `Serial-Number: ${d.serial}`,
    'License Status: Valid',
    'Log hard disk: Available',
    `Hostname: ${d.hostname}`,
    'Private Encryption: Disable',
    'Operation Mode: NAT',
    'Current virtual domain: root',
    'Max number of virtual domains: 1',
    'Virtual domains status: 1 in NAT mode, 0 in TP mode',
    'Virtual domain configuration: disable',
    'FIPS-CC mode: disable',
    'Current HA mode: standalone',
    'Branch point: 2662',
    'Release Version Information: GA',
    `System time: ${ctime(now(d))}`,
    'Last reboot reason: warm reboot'
  ].join('\n')
}

/** The CPU hog, while the service that feeds it is on. */
export function hog(d: Device): Device['cpu']['hog'] {
  const h = d.cpu.hog
  return h && (!h.whileService || d.services[h.whileService]) ? h : undefined
}

export function performance(d: Device): string {
  const t = now(d)
  const user = Math.round(hog(d)?.pct ?? d.cpu.load[0])
  const mins = Math.floor((t - d.bootedAt) / 60000)
  const sessions = fdata(d).sessions.length
  const cpu = (u: number): string => `${u}% user 0% system 0% nice ${100 - u}% idle 0% iowait 0% irq 0% softirq`
  return [
    `CPU states: ${cpu(user)}`,
    `CPU0 states: ${cpu(Math.max(0, user - 1))}`,
    `CPU1 states: ${cpu(Math.min(100, user + 1))}`,
    'Memory: 3112532k total, 1018512k used (32.7%), 1863964k free (59.9%), 230056k freeable (7.4%)',
    'Average network usage: 99 / 9 kbps in 1 minute, 99 / 4 kbps in 10 minutes, 102 / 21 kbps in 30 minutes',
    'Maximal network usage: 144 / 37 kbps in 1 minute, 158 / 61 kbps in 10 minutes, 1069 / 4463 kbps in 30 minutes',
    `Average sessions: ${sessions * 10} sessions in 1 minute, ${sessions * 10 - 1} sessions in 10 minutes, ${sessions * 9} sessions in 30 minutes`,
    'Maximal sessions: 32 sessions in 1 minute, 35 sessions in 10 minutes, 56 sessions in 30 minutes',
    'Average session setup rate: 0 sessions per second in last 1 minute, 0 sessions per second in last 10 minutes, 0 sessions per second in last 30 minutes',
    'Maximal session setup rate: 3 sessions per second in last 1 minute, 12 sessions per second in last 10 minutes, 21 sessions per second in last 30 minutes',
    'Average NPU sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes',
    'Maximal NPU sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes',
    'Average nTurbo sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes',
    'Maximal nTurbo sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes',
    'Virus caught: 0 total in 1 minute',
    'IPS attacks blocked: 0 total in 1 minute',
    `Uptime: ${Math.floor(mins / 1440)} days, ${Math.floor((mins % 1440) / 60)} hours, ${mins % 60} minutes`
  ].join('\n')
}

/** One `diagnose sys top` snapshot (the real command refreshes until `q`). */
export function sysTop(d: Device): string {
  const t = now(d)
  const h = hog(d)
  const mins = Math.floor((t - d.bootedAt) / 60000)
  const procs = [...d.cpu.processes]
  if (h && !procs.some((p) => p.pid === h.pid)) procs.push({ pid: h.pid, name: h.name, pct: h.pct })
  const pct = (p: { pid: number; pct: number }): number => (h && h.pid === p.pid ? h.pct : p.pct)
  const busy = Math.min(100, Math.round(procs.reduce((a, p) => a + pct(p), 0)))
  const rows = procs.sort((a, b) => pct(b) - pct(a)).map((p) => `${p.name.padStart(15)}${lpad(p.pid, 9)}      ${h && h.pid === p.pid ? 'R' : 'S'}${lpad(pct(p).toFixed(1), 8)}${lpad('1.2', 8)}`)
  return [`Run Time:  ${Math.floor(mins / 1440)} days, ${Math.floor((mins % 1440) / 60)} hours and ${mins % 60} minutes`, `${busy}U, 0N, 0S, ${100 - busy}I, 0WA, 0HI, 0SI, 0ST; 3040T, 1766F`, ...rows].join('\n')
}

export function haStatus(d: Device): string {
  return `HA Health Status: OK\nModel: ${d.model}\nMode: standalone\nGroup: 0\nDebug: 0\nCluster Uptime: 0 days 0:0:0\nCluster state change time: ${ctime(d.bootedAt)}\nses_pickup: disable\noverride: disable`
}

// ------------------------------------------------------------------ interfaces

const speedText = (i: Iface): string => (i.speed === '10G' ? '10000Mbps' : i.speed === '25G' ? '25000Mbps' : `${i.speed || '1000'}Mbps`)

export function interfacePhysical(d: Device): string {
  const out = ['== [onboard]']
  for (const i of d.interfaces.filter((x) => ifType(d, x) === 'physical')) {
    const up = isUp(i)
    out.push(`    ==[${i.name}]`, '        mode: static', `        ip: ${ipMask(i)}`, '        ipv6: ::/0', `        status: ${up ? 'up' : 'down'}`, `        speed: ${up ? `${speedText(i)} (Duplex: ${i.duplex === 'half' ? 'half' : 'full'})` : 'n/a'}`, '        FEC: none', '        FEC_cap: none')
  }
  return out.join('\n')
}

export function interfaceLines(d: Device, name?: string): string {
  const list = d.interfaces.filter((i) => !name || i.name === name)
  return list
    .flatMap((i) => [
      `== [ ${i.name} ]`,
      `name: ${i.name}   mode: static    ip: ${ipMask(i)}   status: ${i.adminUp ? 'up' : 'down'}    netbios-forward: disable    type: ${ifType(d, i)}   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    explicit-web-proxy: disable    explicit-ftp-proxy: disable    proxy-captive-portal: disable    mtu-override: disable    wccp: disable    drop-overlapped-fragment: disable    drop-fragment: disable`
    ])
    .join('\n')
}

// ------------------------------------------------------------------ routing

export function ipsecSummary(d: Device): string {
  return (d.ipsec ?? []).map((t) => {
    const up = [t.iface, t.underlay].every((name) => d.interfaces.some((i) => i.name === name && ifUp(d, i)))
    return `'${t.name}' ${t.peer}:0  selectors(total,up): 1/${up ? 1 : 0}  rx(pkt,err): ${t.rx}/0  tx(pkt,err): ${t.tx}/0`
  }).join('\n')
}

interface Rt {
  vrf: string
  code: string
  prefix: string
  mask: number
  text: string
}

export function routes(d: Device): Rt[] {
  const t = now(d)
  const out: Rt[] = []
  for (const i of d.interfaces) {
    if (!i.ip || i.mask === undefined || !ifUp(d, i)) continue
    out.push({ vrf: i.vrf ?? '0', code: 'C', prefix: network(i.ip, i.mask), mask: i.mask, text: `is directly connected, ${i.name}` })
  }
  for (const s of d.staticRoutes) {
    const via = d.interfaces.find((i) => i.ip && i.mask !== undefined && (i.vrf ?? '0') === (s.vrf ?? '0') && ifUp(d, i) && inSubnet(s.nextHop, i.ip, i.mask))
    if (via) out.push({ vrf: s.vrf ?? '0', code: s.mask === 0 ? 'S*' : 'S', prefix: s.prefix, mask: s.mask, text: `[${s.ad ?? 10}/0] via ${s.nextHop}, ${via.name}` })
  }
  for (const r of fdata(d).ospfRoutes) {
    const n = d.ospf?.neighbors.find((x) => x.ip === r.via)
    if (!n || ospfState(d, n) !== 'FULL') continue
    const vrf = d.interfaces.find((i) => i.name === r.iface)?.vrf ?? '0'
    if (out.some((x) => x.vrf === vrf && x.prefix === r.prefix && x.mask === r.mask)) continue
    out.push({ vrf, code: 'O', prefix: r.prefix, mask: r.mask, text: `[110/${r.cost}] via ${r.via}, ${r.iface}, ${age(t - (n.upSince ?? d.bootedAt))}` })
  }
  for (const b of d.bgp) {
    if (neighborState(d, b, t) !== 'Established') continue
    const vrf = b.vrf ?? d.interfaces.find((i) => i.name === b.via)?.vrf ?? '0'
    for (const r of b.routes ?? []) {
      if (out.some((x) => x.vrf === vrf && x.prefix === r.prefix && x.mask === r.mask)) continue
      out.push({ vrf, code: r.mask === 0 ? 'B*' : 'B', prefix: r.prefix, mask: r.mask, text: `[${b.remoteAs === d.localAs ? 200 : 20}/0] via ${b.ip}, ${b.via}, ${age(t - (b.upSince ?? t))}` })
    }
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

export function routingTable(d: Device, filter?: string): string {
  let rs = routes(d)
  const codes: Record<string, string> = { connected: 'C', static: 'S', bgp: 'B', ospf: 'O' }
  if (filter && codes[filter]) rs = rs.filter((r) => r.code.startsWith(codes[filter]!))
  return [
    'Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP',
    '       O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2',
    '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
    '       * - candidate default',
    '',
    ...[...new Set(['0', ...d.interfaces.map((i) => i.vrf ?? '0')])].sort((a, b) => Number(a) - Number(b)).flatMap((vrf) => [
      `Routing table for VRF=${vrf}`,
      ...rs.filter((r) => r.vrf === vrf).map((r) => `${pad(r.code, 8)}${r.prefix}/${r.mask} ${r.text}`)
    ])
  ].join('\n')
}

export function bgpState(d: Device, ip: string): string {
  const n = d.bgp.find((b) => b.ip === ip)!
  const s = neighborState(d, n)
  return s === 'Idle (Admin)' ? 'Idle (Admin)' : s
}

export function bgpSummary(d: Device): string {
  const t = now(d)
  const est = d.bgp.filter((n) => bgpState(d, n.ip) === 'Established')
  const ver = est.reduce((a, n) => a + (n.routes?.length ?? 0), 0) + 4
  const rows = d.bgp.map((n) => {
    const st = bgpState(d, n.ip)
    const up = st === 'Established'
    const ud = up ? age(t - (n.upSince ?? t)) : n.downSince !== undefined && n.msgRcvd ? age(t - n.downSince) : 'never'
    const tail = up ? lpad(n.prefixes, 9) : ` ${pad(st, 11)}`
    return `${pad(n.ip, 16)}4${lpad(n.remoteAs, 11)}${lpad(n.msgRcvd ?? 0, 8)}${lpad(n.msgSent ?? 0, 8)}${lpad(up ? ver : 0, 9)}${lpad(0, 5)}${lpad(0, 5)}${lpad(ud, 9)}${tail}`
  })
  return [`BGP router identifier ${d.routerId}, local AS number ${d.localAs}`, `BGP table version is ${ver}`, `${Math.max(1, est.length - 1)} BGP AS-PATH entries`, '0 BGP community entries', '', 'Neighbor        V         AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd', ...rows, '', `Total number of neighbors ${d.bgp.length}`].join('\n')
}

export function bgpNeighbors(d: Device, ip?: string): string {
  const t = now(d)
  const list = d.bgp.filter((n) => !ip || n.ip === ip)
  if (!list.length) return `% No such neighbor or address family`
  return [
    'VRF 0 neighbor table:',
    ...list.flatMap((n) => {
      const st = bgpState(d, n.ip)
      const up = st === 'Established'
      return [
        `BGP neighbor is ${n.ip}, remote AS ${n.remoteAs}, local AS ${d.localAs}, ${n.remoteAs === d.localAs ? 'internal' : 'external'} link`,
        `  BGP version 4, remote router ID ${up ? (n.routerId ?? '0.0.0.0') : '0.0.0.0'}`,
        `  BGP state = ${st}${up ? `, up for ${age(t - (n.upSince ?? t))}` : ''}`,
        `  Last read 00:00:01, hold time is 180, keepalive interval is 60 seconds`,
        '  Configured hold time is 180, keepalive interval is 60 seconds',
        ...(up ? ['  Neighbor capabilities:', '    Route refresh: advertised and received (old and new)', '    Address family IPv4 Unicast: advertised and received'] : []),
        `  Received ${n.msgRcvd ?? 0} messages, 0 notifications, 0 in queue`,
        `  Sent ${n.msgSent ?? 0} messages, 0 notifications, 0 in queue`,
        '  Route refresh request: received 0, sent 0',
        '  Minimum time between advertisement runs is 30 seconds',
        '',
        ' For address family: IPv4 Unicast',
        `  BGP table version ${up ? 7 : 0}, neighbor version ${up ? 7 : 0}`,
        '  Index 1, Offset 0, Mask 0x2',
        `  ${up ? n.prefixes : 0} accepted prefixes`,
        ''
      ]
    })
  ].join('\n')
}

export function ospfNeighbor(d: Device): string {
  const t = now(d)
  const rows = (d.ospf?.neighbors ?? [])
    .map((n) => {
      const s = ospfState(d, n)
      if (!s) return undefined
      const st = s === 'FULL' ? `Full/ ${n.role === 'DR' || n.role === 'BDR' || n.role === 'DROTHER' ? n.role : '-'}` : s === 'EXSTART' ? 'ExStart/ -' : '2-Way/ DROther'
      const dead = 30 + (Math.floor(t / 1000) % 10)
      return `${pad(n.routerId, 16)}${lpad(n.pri, 3)}   ${pad(st, 17)}${pad(`00:00:${two(dead)}`, 12)}${pad(n.ip, 16)}${n.iface}`
    })
    .filter((x): x is string => !!x)
  return ['OSPF process 0:', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...rows].join('\n')
}

// ------------------------------------------------------------------ arp / lldp / sessions

/** ARP entries on up interfaces whose address lies in that interface's subnet (drops entries a lab rewire made stale). */
export function liveArp(d: Device): Device['arp'] {
  return d.arp.filter((a) => {
    if (!a.mac) return false
    const i = d.interfaces.find((x) => x.name === a.iface)
    if (!i) return true
    return ifUp(d, i) && (!i.ip || i.mask === undefined || inSubnet(a.ip, i.ip, i.mask))
  })
}

export function systemArp(d: Device): string {
  return ['Address           Age(min)   Hardware Addr      Interface', ...liveArp(d).map((a) => `${pad(a.ip, 18)}${pad(a.age, 11)}${macColon(a.mac)} ${a.iface}`)].join('\n')
}

export function arpList(d: Device): string {
  const f = fdata(d)
  return liveArp(d)
    .map((a) => {
      const i = d.interfaces.find((x) => x.name === a.iface)
      return `index=${i ? ifIndex(d, i) : 0} ifname=${a.iface} ${a.ip} ${macColon(a.mac)} ${f.arpDiag[a.ip] ?? 'state=00000002 use=10 confirm=10 update=60 ref=2'}`
    })
    .join('\n')
}

export function lldpSummary(d: Device): string {
  const f = fdata(d)
  return d.lldp
    .map((n, k) => {
      const i = d.interfaces.find((x) => x.name === n.local)
      const chassis = macColon(n.chassisId ?? '0').toUpperCase()
      return `${k + 1} port '${n.local}' ${i ? ifIndex(d, i) : 0} mac ${f.lldpMac[chassis] ?? chassis} chassis ${chassis} port '${n.port}' system '${n.device}'`
    })
    .join('\n')
}

export interface SessFilter {
  src?: string
  dst?: string
  sport?: string
  dport?: string
  proto?: string
  policy?: string
}

const hex8 = (n: number): string => n.toString(16).padStart(8, '0')

export function sessionList(d: Device, f: SessFilter): string {
  const t = now(d)
  const list = fdata(d).sessions.filter((s) => (!f.src || s.src === f.src) && (!f.dst || s.dst === f.dst) && (!f.sport || String(s.sport) === f.sport) && (!f.dport || String(s.dport) === f.dport) && (!f.proto || String(s.proto) === f.proto) && (!f.policy || String(s.policy) === f.policy))
  const out: string[] = []
  for (const s of list) {
    const dur = Math.floor((t - s.start) / 1000)
    out.push(
      '',
      `session info: proto=${s.proto} proto_state=${s.protoState} duration=${dur} expire=${Math.max(0, s.timeout - dur)} timeout=${s.timeout} flags=00000000 socktype=0 sockport=0 av_idx=0 use=3`,
      'origin-shaper=',
      'reply-shaper=',
      'per_ip_shaper=',
      'class_id=0 ha_id=0 policy_dir=0 tunnel=/ vlan_cos=0/255',
      'state=log may_dirty npu f00',
      `statistic(bytes/packets/allow_err): org=${s.orgBytes}/${s.orgPkts}/1 reply=${s.replyBytes}/${s.replyPkts}/1 tuples=2`,
      `tx speed(Bps/kbps): ${Math.floor(s.orgBytes / Math.max(1, dur))}/${Math.floor((s.orgBytes * 8) / Math.max(1, dur) / 1000)} rx speed(Bps/kbps): ${Math.floor(s.replyBytes / Math.max(1, dur))}/${Math.floor((s.replyBytes * 8) / Math.max(1, dur) / 1000)}`,
      `orgin->sink: org pre->post, reply pre->post dev=${s.devIn}->${s.devOut}/${s.devOut}->${s.devIn} gwy=${s.gwy}`,
      `hook=pre dir=org act=noop ${s.src}:${s.sport}->${s.dst}:${s.dport}(0.0.0.0:0)`,
      `hook=post dir=reply act=noop ${s.dst}:${s.dport}->${s.src}:${s.sport}(0.0.0.0:0)`,
      `misc=0 policy_id=${s.policy} pol_uuid_idx=0 auth_info=0 chk_client_info=0 vd=0`,
      `serial=${s.serial} tos=ff/ff app_list=0 app=0 url_cat=0`,
      `rpdb_link_id=${hex8(0)} ngfwid=n/a`,
      `npu_state=${hex8(0)}`
    )
  }
  out.push(`total session ${list.length}`)
  return out.join('\n')
}

export function sessionStat(d: Device): string {
  const s = fdata(d).sessions
  const tcp = s.filter((x) => x.proto === 6).length
  return [`misc info:       session_count=${s.length} setup_rate=0 exp_count=0 clash=0`, '        memory_tension_drop=0 ephemeral=0/65536 removeable=0', 'delete=0, flush=0, dev_down=0/0 ses_walkers=0', 'TCP sessions:', `         ${tcp} in ESTABLISHED state`, 'firewall error stat:', 'error1=00000000', 'error2=00000000', 'error3=00000000', 'error4=00000000', 'tt=00000000', 'cont=00000000', 'ids_recv=00000000', 'url_recv=00000000', 'av_recv=00000000', 'fqdn_count=00000000', 'fqdn6_count=00000000', 'global: ses_limit=0 ses6_limit=0 rt_limit=0 rt6_limit=0'].join('\n')
}

export { isUp }
