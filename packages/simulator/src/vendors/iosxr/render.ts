/**
 * IOS XR show-command renderers (7.x, 64-bit). No research doc exists for IOS XR: column layouts
 * are `[unverified, from memory]` of ASR 9000 / NCS output and only claim to be close.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, lpad, network, pad } from '../../core/text.ts'
import { bgpUp, ifaceCounters, isUp, neighborState, ospfState, resolvedDuplex, uptime, uptimeLong, type BgpNeighbor, type Device, type Iface } from '../../state.ts'
import { configBody, ifSort, l2mtu, xrDate, xrLogPrefix, xrStore } from './config.ts'

const shortOf = (d: Device, name: string): string => d.interfaces.find((i) => i.name === name)?.short ?? name

// ---------------------------------------------------------------- version

export function showVersion(d: Device): string {
  const t = now(d)
  return [
    `Cisco IOS XR Software, Version ${d.version}`,
    'Copyright (c) 2013-2023 by Cisco Systems, Inc.',
    '',
    'Build Information:',
    ' Built By     : ingunawa',
    ' Built On     : Fri Jul 14 01:42:51 PDT 2023',
    ' Built Host   : iox-lnx-062',
    ` Workspace    : /auto/srcarchive15/prod/${d.version}/asr9k-x64/ws`,
    ` Version      : ${d.version}`,
    ' Location     : /opt/cisco/XR/packages/',
    ` Label        : ${d.version}`,
    '',
    `cisco ${d.model.startsWith('ASR-9') ? 'ASR9K' : d.model} (${d.model}) processor`, // [unverified, from memory]
    `System uptime is ${uptimeLong(d.bootedAt, t)}`,
    ''
  ].join('\n')
}

export function showPlatform(d: Device): string {
  return [
    'Node              Type                     State                    Config state',
    '--------------------------------------------------------------------------------',
    `0/RSP0/CPU0       ${pad(`${d.model}-RSP(Active)`, 25)}IOS XR RUN               NSHUT`,
    '0/FT0             ASR-9901-FAN             OPERATIONAL              NSHUT',
    '0/0/CPU0          ASR-9901-LC              IOS XR RUN               NSHUT',
    '0/PS0/M0/PM0      PWR-2KW-AC-V2            OPERATIONAL              NSHUT',
    '0/PS0/M1/PM0      PWR-2KW-AC-V2            OPERATIONAL              NSHUT'
  ].join('\n')
}

// ---------------------------------------------------------------- interfaces

function states(i: Iface): { st: string; pr: string; brief: [string, string] } {
  if (!i.adminUp) return { st: 'administratively down', pr: 'administratively down', brief: ['admin-down', 'admin-down'] }
  if (isUp(i)) return { st: 'up', pr: 'up', brief: ['up', 'up'] }
  return { st: 'down', pr: 'down', brief: ['down', 'down'] }
}

export function showIpv4IntBrief(d: Device, vrf?: string): string {
  const list = [...d.interfaces].sort(ifSort).filter((i) => vrf === undefined || vrf === 'all' || (i.vrf ?? 'default') === vrf)
  const rows = list.map((i) => {
    const st = !i.adminUp ? 'Shutdown' : isUp(i) ? 'Up' : 'Down'
    const pr = isUp(i) ? 'Up' : 'Down'
    return `${pad(i.name, 31)}${pad(i.ip ?? 'unassigned', 16)}${pad(st, 16)}${pad(pr, 9)}${pad(i.vrf ?? 'default', 8)}`
  })
  return ['', 'Interface                      IP-Address      Status          Protocol Vrf-Name', ...rows].join('\n')
}

export function showIntBrief(d: Device): string {
  const rows = [...d.interfaces].sort(ifSort).map((i) => {
    const [a, b] = states(i).brief
    const virtual = !i.speed
    const encap = i.name.startsWith('Loopback') ? 'Loopback' : i.name.startsWith('Null') ? 'Null' : 'ARPA'
    const bw = virtual ? 0 : /G$/.test(i.speed) ? Number(i.speed.slice(0, -1)) * 1_000_000 : Number(i.speed) * 1000 || 1_000_000
    return `${lpad(i.short, 19)}${lpad(a, 12)}${lpad(b, 12)}${lpad(encap, 19)}${lpad(virtual ? 1500 : l2mtu(i), 6)}${lpad(bw, 11)}`
  })
  return ['', '               Intf       Intf        LineP              Encap  MTU        BW', '               Name       State       State               Type (byte)    (Kbps)', '-'.repeat(80), ...rows, ''].join('\n')
}

export function showInterface(d: Device, i: Iface): string {
  const s = states(i)
  const c = ifaceCounters(d, i)
  const t = now(d)
  const virtual = !i.speed
  const hw = i.name.startsWith('Loopback') ? 'Loopback interface(s)' : i.name.startsWith('MgmtEth') ? 'Management Ethernet' : 'GigabitEthernet'
  const l = [`${i.name} is ${s.st}, line protocol is ${s.pr} `]
  if (i.errDisabled) l.push(`  Interface is error-disabled (${i.errDisabled})`)
  l.push(`  Interface state transitions: ${i.lastChange && i.lastChange > d.bootedAt + 60_000 ? 3 : 1}`)
  l.push(`  Hardware is ${hw}${virtual ? '' : `, address is ${i.mac} (bia ${i.mac})`}`)
  if (i.description !== undefined) l.push(`  Description: ${i.description}`)
  l.push(i.ip ? `  Internet address is ${i.ip}/${i.mask}` : '  Internet address is Unknown')
  if (virtual) {
    l.push(`  MTU 1500 bytes, BW 0 Kbit`, '     reliability Unknown, txload Unknown, rxload Unknown', '  Encapsulation Loopback,  loopback not set,', `  Last link flapped ${uptime(i.lastChange ?? d.bootedAt, t)}`, '  Last input Unknown, output Unknown', '  Last clearing of "show interface" counters Unknown', '  Input/output data rate is disabled.')
    return l.join('\n')
  }
  const bw = /G$/.test(i.speed) ? Number(i.speed.slice(0, -1)) * 1_000_000 : 1_000_000
  l.push(
    `  MTU ${l2mtu(i)} bytes, BW ${bw} Kbit (Max: ${bw} Kbit)`,
    '     reliability 255/255, txload 0/255, rxload 0/255',
    '  Encapsulation ARPA,',
    isUp(i) ? `  ${resolvedDuplex(i) === 'half' ? 'Half' : 'Full'}-duplex, ${i.speed === '1000' ? '1000Mb/s' : `${i.speed}b/s`}, ${i.media ?? '1000BASE-LX'}, link type is force-up` : `  ${resolvedDuplex(i) === 'half' ? 'Half' : 'Full'}-duplex, ${i.speed === '1000' ? '1000Mb/s' : `${i.speed}b/s`}, ${i.media ?? '1000BASE-LX'}, link type is force-up`,
    '  output flow control is off, input flow control is off',
    '  Carrier delay (up) is 10 msec',
    '  loopback not set,',
    `  Last link flapped ${uptime(i.lastChange ?? d.bootedAt, t)}`,
    '  ARP type ARPA, ARP timeout 04:00:00',
    `  Last input 00:00:0${isUp(i) ? 0 : 9}, output 00:00:00`,
    `  Last clearing of "show interface" counters ${i.clearedAt ? uptime(i.clearedAt, t) : 'never'}`,
    `  5 minute input rate ${c.inBps} bits/sec, ${c.inPps} packets/sec`,
    `  5 minute output rate ${c.outBps} bits/sec, ${c.outPps} packets/sec`,
    `     ${c.inPkts} packets input, ${c.inBytes} bytes, 0 total input drops`,
    '     0 drops for unrecognized upper-level protocol',
    `     Received ${Math.floor(c.inPkts / 900)} broadcast packets, ${Math.floor(c.inPkts / 1400)} multicast packets`,
    `              ${c.runts} runts, ${c.giants} giants, 0 throttles, 0 parity`,
    `     ${c.inErrors} input errors, ${c.crc} CRC, ${c.frame} frame, ${c.overrun} overrun, ${c.ignored} ignored, 0 abort`,
    `     ${c.outPkts} packets output, ${c.outBytes} bytes, 0 total output drops`,
    `     Output ${Math.floor(c.outPkts / 1000)} broadcast packets, ${Math.floor(c.outPkts / 1300)} multicast packets`,
    `     ${c.outErrors} output errors, 0 underruns, 0 applique, ${c.resets} resets`,
    '     0 output buffer failures, 0 output buffers swapped out',
    `     ${c.collisions ? `${c.collisions} collisions, ${c.lateCollisions} late collisions, ` : ''}${i.lastChange && i.lastChange > d.bootedAt + 60_000 ? 2 : 0} carrier transitions`
  )
  return l.join('\n')
}

// ---------------------------------------------------------------- BGP

/** eBGP sessions on IOS XR drop every route without an inbound route-policy. [unverified, from memory] */
export const acceptsRoutes = (d: Device, n: BgpNeighbor): boolean => n.remoteAs === d.localAs || !!n.routeMapIn

export function showBgpSummary(d: Device, vrf?: string): string {
  const t = now(d)
  const list = d.bgp.filter((n) => (vrf ? n.vrf === vrf : !n.vrf)).sort((a, b) => cmpIp(a.ip, b.ip))
  const ver = 42 + d.bgp.filter((n) => bgpUp(n, t)).reduce((a, n) => a + n.prefixes, 0)
  const rows = list.map((n) => {
    const up = bgpUp(n, t)
    const st = neighborState(d, n, t)
    const updown = up ? uptime(n.upSince!, t) : n.downSince ? uptime(n.downSince, t) : 'never'
    const tail = up ? lpad(acceptsRoutes(d, n) ? n.prefixes : 0, 12) : ` ${st === 'Established' ? 'Active' : st}`
    return `${pad(n.ip, 16)}${lpad(0, 3)} ${lpad(n.remoteAs, 5)} ${lpad(up ? (n.msgRcvd ?? 1000) : 0, 7)} ${lpad(up ? (n.msgSent ?? 1000) : 0, 7)} ${lpad(up ? ver : 0, 8)} ${lpad(0, 4)} ${lpad(0, 4)} ${lpad(updown, 8)}${tail}`
  })
  return [
    `BGP router identifier ${d.routerId}, local AS number ${d.localAs}`,
    'BGP generic scan interval 60 secs',
    'Non-stop routing is enabled',
    'BGP table state: Active',
    `Table ID: 0xe0000000   RD version: ${ver}`,
    `BGP main routing table version ${ver}`,
    'BGP NSR Initial initsync version 4 (Reached)',
    'BGP NSR/ISSU Sync-Group versions 0/0',
    'BGP scan interval 60 secs',
    '',
    'BGP is operating in STANDALONE mode.',
    '',
    '',
    'Process       RcvTblVer   bRIB/RIB   LabelVer  ImportVer  SendTblVer  StandbyVer',
    `Speaker       ${lpad(ver, 9)}  ${lpad(ver, 9)}  ${lpad(ver, 9)}  ${lpad(ver, 9)}   ${lpad(ver, 9)}           0`,
    '',
    'Neighbor        Spk    AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down  St/PfxRcd',
    ...rows,
    ''
  ].join('\n')
}

export function showBgpNeighbors(d: Device, ip?: string): string {
  const t = now(d)
  const list = ip ? d.bgp.filter((n) => n.ip === ip) : [...d.bgp].sort((a, b) => cmpIp(a.ip, b.ip))
  if (ip && !list.length) return `% No such neighbor`
  return list
    .map((n) => {
      const up = bgpUp(n, t)
      const st = neighborState(d, n, t)
      const ibgp = n.remoteAs === d.localAs
      const l = [
        '',
        `BGP neighbor is ${n.ip}${n.vrf ? `, vrf ${n.vrf}` : ''}`,
        ` Remote AS ${n.remoteAs}, local AS ${d.localAs}, ${ibgp ? 'internal' : 'external'} link`,
        ...(n.description !== undefined ? [` Description: ${n.description}`] : []),
        ` Remote router ID ${up ? (n.routerId ?? n.ip) : '0.0.0.0'}`,
        `  BGP state = ${st === 'Idle (Admin)' ? 'Idle (Admin)' : st}${up ? `, up for ${uptime(n.upSince!, t)}` : ''}`,
        '  NSR State: None',
        `  Last read 00:00:${up ? 12 : '00'}, Last read before reset 00:00:00`,
        '  Hold time is 180, keepalive interval is 60 seconds',
        '  Configured hold time: 180, keepalive: 60, min acceptable hold time: 3',
        ...(n.updateSource ? [`  Update source: ${n.updateSource}`] : []),
        `  Received ${up ? (n.msgRcvd ?? 1000) : 0} messages, 0 notifications, 0 in queue`,
        `  Sent ${up ? (n.msgSent ?? 1000) : 0} messages, ${up ? 0 : 1} notifications, 0 in queue`,
        '',
        ' For Address Family: IPv4 Unicast',
        `  BGP neighbor version ${up ? 42 : 0}`,
        '  Update group: 0.1 Filter-group: 0.1  No Refresh request being processed',
        n.routeMapIn ? `  Policy for incoming advertisements is ${n.routeMapIn}` : ibgp ? '' : '  No inbound policy: all routes are rejected (EBGP default)',
        ...(n.routeMapOut ? [`  Policy for outgoing advertisements is ${n.routeMapOut}`] : []),
        `  ${up && acceptsRoutes(d, n) ? n.prefixes : 0} accepted prefixes, ${up && acceptsRoutes(d, n) ? n.prefixes : 0} are bestpaths`,
        '',
        `  Connections established ${up ? 4 : 3}; dropped 3`,
        `  Local host: ${d.interfaces.find((i) => i.name === (n.updateSource ?? n.via))?.ip ?? '0.0.0.0'}, Local port: 179, IF Handle: 0x00000000`,
        `  Foreign host: ${n.ip}, Foreign port: ${up ? 51022 : 0}`,
        `  Last reset ${n.downSince ? uptime(n.downSince, t) : '00:00:00'}, due to ${n.peerAs !== undefined && n.peerAs !== n.remoteAs ? 'BGP Notification sent: peer in wrong AS' : n.shutdown ? 'Admin. shutdown (CEASE notification sent - administrative shutdown)' : 'Interface flap'}`,
        ...(n.peerAs !== undefined && n.peerAs !== n.remoteAs ? [`  Peer had AS ${n.peerAs} in its OPEN message, expected ${n.remoteAs}`] : [])
      ]
      return l.filter((x) => x !== '').join('\n')
    })
    .join('\n\n')
}

// ---------------------------------------------------------------- routing

export interface XrRoute {
  code: string
  prefix: string
  mask: number
  ad?: number
  metric?: number
  via?: string
  iface?: string
  age: string
  proto: string
}

export function xrRib(d: Device, vrf?: string): XrRoute[] {
  const t = now(d)
  const inVrf = (i: Iface): boolean => (vrf ? i.vrf === vrf : !i.vrf)
  const ifs = d.interfaces.filter((i) => inVrf(i) && i.ip && i.mask !== undefined && isUp(i))
  const out: XrRoute[] = []
  const connected = (ip: string): Iface | undefined => ifs.find((i) => i.mask! < 32 && inSubnet(ip, i.ip!, i.mask!))
  for (const i of ifs) {
    const age = uptime(i.lastChange ?? d.bootedAt, t)
    if (i.mask! < 32) out.push({ code: 'C', prefix: network(i.ip!, i.mask!), mask: i.mask!, iface: i.name, age, proto: 'connected' })
    out.push({ code: 'L', prefix: i.ip!, mask: 32, iface: i.name, age, proto: 'local' })
  }
  for (const r of d.staticRoutes) {
    if ((r.vrf ?? undefined) !== vrf || !connected(r.nextHop)) continue
    out.push({ code: r.mask === 0 ? 'S*' : 'S', prefix: r.prefix, mask: r.mask, ad: r.ad ?? 1, metric: 0, via: r.nextHop, age: uptime(d.bootedAt, t), proto: 'static' })
  }
  if (!vrf) {
    for (const n of d.bgp) {
      if (n.vrf || !bgpUp(n, t) || !acceptsRoutes(d, n)) continue
      const ibgp = n.remoteAs === d.localAs
      for (const r of n.routes ?? []) if (!out.some((o) => o.prefix === r.prefix && o.mask === r.mask)) out.push({ code: 'B', prefix: r.prefix, mask: r.mask, ad: ibgp ? 200 : 20, metric: 0, via: n.ip, age: uptime(n.upSince!, t), proto: `bgp ${d.localAs}` })
    }
    for (const n of d.ospf?.neighbors ?? []) {
      if (ospfState(d, n) !== 'FULL') continue
      const cost = (d.ospf?.ifaces.find((o) => o.iface === n.iface)?.cost ?? 1) + 1
      const routes = (d.vendor['ospfRoutes'] as { prefix: string; mask: number; via: string }[] | undefined)?.filter((r) => r.via === n.ip) ?? []
      for (const r of routes) out.push({ code: 'O', prefix: r.prefix, mask: r.mask, ad: 110, metric: cost, via: n.ip, iface: n.iface, age: uptime(n.upSince ?? d.bootedAt, t), proto: `ospf ${d.ospf!.process}` })
    }
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask || (a.code === 'L' ? 1 : -1))
}

const routeLine = (r: XrRoute): string =>
  `${pad(r.code, 5)}${r.prefix}/${r.mask} ${r.via ? `[${r.ad}/${r.metric}] via ${r.via}, ${r.age}${r.iface ? `, ${r.iface}` : ''}` : `is directly connected, ${r.age}, ${r.iface}`}`

export function showRoute(d: Device, vrf?: string, filter?: string, target?: string): string {
  if (vrf && !d.vrfs.some((v) => v.name === vrf)) return `% VRF ${vrf} not found`
  let routes = xrRib(d, vrf)
  if (target) {
    const [ip, len] = target.split('/')
    const hit = len !== undefined ? routes.find((r) => r.prefix === ip && r.mask === Number(len)) : routes.filter((r) => inSubnet(ip!, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask)[0]
    if (!hit) return `% Network not in table`
    return [
      '',
      `Routing entry for ${hit.prefix}/${hit.mask}`,
      `  Known via "${hit.proto}", distance ${hit.ad ?? 0}, metric ${hit.metric ?? 0}${hit.code === 'S*' ? ', candidate default path' : ''}${/^[CL]$/.test(hit.code) ? ' (connected)' : ''}`,
      ...(hit.code === 'B' ? [`  Tag ${d.bgp.find((n) => n.ip === hit.via)?.remoteAs ?? 0}, type ${hit.ad === 200 ? 'internal' : 'external'}`] : []),
      `  Installed ${xrDate(now(d) - 1000).replace(/^\S+ /, '')} for ${hit.age}`,
      '  Routing Descriptor Blocks',
      hit.via ? `    ${hit.via}, from ${hit.via}${hit.iface ? `, via ${hit.iface}` : ''}` : `    directly connected, via ${hit.iface}`,
      '      Route metric is 0',
      '  No advertising protos. '
    ].join('\n')
  }
  if (filter) routes = routes.filter((r) => (filter === 'connected' ? /^[CL]$/.test(r.code) : filter === 'static' ? r.code.startsWith('S') : filter === 'bgp' ? r.code === 'B' : filter === 'ospf' ? r.code === 'O' : filter === 'local' ? r.code === 'L' : true))
  const def = xrRib(d, vrf).find((r) => r.mask === 0)
  return [
    '',
    'Codes: C - connected, S - static, R - RIP, B - BGP, (>) - Diversion path',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
    '       i - ISIS, L1 - IS-IS level-1, L2 - IS-IS level-2',
    '       ia - IS-IS inter area, su - IS-IS summary null, * - candidate default',
    '       U - per-user static route, o - ODR, L - local, G  - DAGR, l - LISP',
    '       A - access/subscriber, a - Application route',
    '       M - mobile route, r - RPL, t - Traffic Engineering, (!) - FRR Backup path',
    '',
    def ? `Gateway of last resort is ${def.via} to network 0.0.0.0` : 'Gateway of last resort is not set',
    '',
    ...routes.map(routeLine),
    ''
  ].join('\n')
}

// ---------------------------------------------------------------- OSPF

export function showOspfNeighbor(d: Device): string {
  if (!d.ospf) return ''
  const t = now(d)
  const rows: string[] = []
  for (const n of d.ospf.neighbors) {
    const st = ospfState(d, n)
    if (!st) continue
    const role = n.role ?? '-'
    rows.push(`${pad(n.routerId, 16)}${pad(n.pri, 6)}${pad(`${st}/${role === '-' ? '  -' : role}`, 16)}${pad(`00:00:3${[...n.routerId].reduce((a, c) => a + c.charCodeAt(0), 0) % 9}`, 12)}${pad(n.ip, 16)}${n.iface}`)
    rows.push(`    Neighbor is up for ${uptime(n.upSince ?? d.bootedAt, t)}`)
  }
  return [
    '',
    '* Indicates MADJ interface',
    '# Indicates Neighbor awaiting BFD session up',
    '',
    `Neighbors for OSPF ${d.ospf.process}`,
    '',
    'Neighbor ID     Pri   State           Dead Time   Address         Interface',
    ...rows,
    '',
    `Total neighbor count: ${rows.length / 2}`
  ].join('\n')
}

export function showOspfIntBrief(d: Device): string {
  if (!d.ospf) return ''
  const rows = d.ospf.ifaces.map((o) => {
    const i = d.interfaces.find((x) => x.name === o.iface)
    const nbrs = d.ospf!.neighbors.filter((n) => n.iface === o.iface)
    const full = nbrs.filter((n) => ospfState(d, n) === 'FULL').length
    const st = !i || !isUp(i) ? 'DOWN' : i.name.startsWith('Loopback') ? 'LOOP' : o.networkType === 'point-to-point' ? 'P2P' : 'DR'
    return `${pad(i?.short ?? o.iface, 11)}${pad(d.ospf!.process, 6)}${pad(o.area, 9)}${pad(i?.ip ? `${i.ip}/${i.mask}` : '', 19)}${pad(o.cost ?? 1, 5)}${pad(st, 6)}${full}/${nbrs.length}`
  })
  return ['', '* Indicates MADJ interface', '', `Interfaces for OSPF ${d.ospf.process}`, '', 'Interface    PID   Area     IP Address/Mask    Cost  State Nbrs F/C', ...rows].join('\n')
}

// ---------------------------------------------------------------- L2 neighbours, ARP, VRF

function nbrUp(d: Device, local: string): boolean {
  const i = d.interfaces.find((x) => x.short === local || x.name === local)
  return !!i && isUp(i)
}

export function showLldp(d: Device): string {
  const ns = d.lldp.filter((n) => !n.noLldp && nbrUp(d, n.local))
  return [
    'Capability codes:',
    '        (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
    '        (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
    '',
    'Device ID       Local Intf               Hold-time  Capability     Port ID',
    ...ns.map((n) => `${pad(n.device.slice(0, 15), 16)}${pad(n.local, 25)}${pad(n.holdtime ?? 120, 11)}${pad(n.caps ?? 'R', 15)}${n.port}`),
    '',
    `Total entries displayed: ${ns.length}`,
    ''
  ].join('\n')
}

export function showCdp(d: Device): string {
  if (d.services['cdp'] === false) return '% CDP is not enabled'
  const ns = d.lldp.filter((n) => n.cdp && nbrUp(d, n.local))
  return [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater',
    '',
    'Device ID       Local Intrfce    Holdtme Capability Platform        Port ID',
    ...ns.map((n) => `${pad(n.device.slice(0, 15), 16)}${pad(n.local, 17)}${pad(n.holdtime ?? 120, 8)}${pad(n.caps ?? 'R', 11)}${pad((n.platform ?? '').replace(/^cisco /, '').slice(0, 15), 16)}${n.port}`),
    ''
  ].join('\n')
}

export function showArp(d: Device, vrf?: string): string {
  const rows: string[] = []
  const ifs = d.interfaces.filter((i) => (vrf ? i.vrf === vrf : !i.vrf) && isUp(i))
  const all: { ip: string; age: string; mac: string; state: string; iface: string }[] = []
  for (const i of ifs) if (i.ip && i.mac) all.push({ ip: i.ip, age: '-', mac: i.mac, state: 'Interface', iface: i.name })
  for (const a of d.arp) if (ifs.some((i) => i.name === a.iface)) all.push({ ip: a.ip, age: `${String(Math.floor(a.age / 60)).padStart(2, '0')}:${String(a.age % 60).padStart(2, '0')}:00`, mac: a.mac, state: 'Dynamic', iface: a.iface })
  all.sort((a, b) => cmpIp(a.ip, b.ip))
  for (const r of all) rows.push(`${pad(r.ip, 16)}${pad(r.age, 11)}${pad(r.mac, 16)}${pad(r.state, 11)}ARPA  ${r.iface}`)
  return ['', '-'.repeat(79), '0/RSP0/CPU0', '-'.repeat(79), 'Address         Age        Hardware Addr   State      Type  Interface', ...rows].join('\n')
}

export function showVrfAll(d: Device): string {
  const rows: string[] = []
  for (const v of [...d.vrfs].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push(`${pad(v.name, 21)}${v.rd || 'not set'}`)
    if (v.rd) rows.push(`${' '.repeat(41)}${pad(`import  ${v.rd}`, 27)}IPV4  Unicast`, `${' '.repeat(41)}${pad(`export  ${v.rd}`, 27)}IPV4  Unicast`)
  }
  return ['VRF                  RD                  RT                         AFI   SAFI', ...rows].join('\n')
}

// ---------------------------------------------------------------- policy

/** `show rpl route-policy X` / `show rpl prefix-set X`: the config blocks. */
export function showRpl(d: Device, kind: 'route-policy' | 'prefix-set', name?: string): string {
  const body = configBody(d)
  const out: string[] = []
  for (let k = 0; k < body.length; k++) {
    if (!body[k]!.startsWith(`${kind} `)) continue
    if (name && body[k] !== `${kind} ${name}`) continue
    for (; k < body.length && body[k] !== '!'; k++) out.push(body[k]!)
    out.push('')
  }
  if (name && !out.length) return `% Policy [${name}] does not exist`
  return out.join('\n')
}

export function showAccessLists(d: Device, name?: string): string {
  const list = name ? d.acls.filter((a) => a.name === name) : d.acls
  if (name && !list.length) return `% Access-list ${name} does not exist`
  return list.map((a) => [`ipv4 access-list ${a.name}`, ...a.entries.map((e) => ` ${e.seq} ${e.action} ${e.text}${e.hits ? ` (${e.hits} matches)` : ''}`)].join('\n')).join('\n')
}

// ---------------------------------------------------------------- system

export function cpuLoad(d: Device): [number, number, number] {
  const hog = activeHog(d)
  const [a, b, c] = d.cpu.load
  if (!hog) return [a, b, c]
  return [Math.min(99, a + hog.pct), Math.min(99, b + hog.pct - 4), Math.min(99, c + hog.pct - 9)]
}

function activeHog(d: Device): Device['cpu']['hog'] {
  return d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
}

export function showProcessesCpu(d: Device): string {
  const hog = activeHog(d)
  const [one, five, fifteen] = cpuLoad(d)
  const procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  // Real XR lists by PID; the hog is sorted first so the culprit tops the table (scenario requirement).
  procs.sort((a, b) => b.pct - a.pct || a.pid - b.pid)
  return [
    '',
    `CPU utilization for one minute: ${one}%; five minutes: ${five}%; fifteen minutes: ${fifteen}%`,
    '',
    'PID    1Min    5Min    15Min Process',
    ...procs.map((p) => {
      const m5 = hog && hog.pid === p.pid ? Math.max(0, p.pct - 4) : p.pct
      const m15 = hog && hog.pid === p.pid ? Math.max(0, p.pct - 9) : p.pct
      return `${pad(p.pid, 7)}${lpad(`${p.pct}%`, 4)}${lpad(`${m5}%`, 8)}${lpad(`${m15}%`, 9)} ${p.name}`
    })
  ].join('\n')
}

export function showLogging(d: Device): string {
  const n = (d.logBase ?? 0) + d.log.length
  return [
    'Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns)',
    '    Console logging: level informational, 312 messages logged',
    '    Monitor logging: level debugging, 0 messages logged',
    '    Trap logging: level informational, 0 messages logged',
    `    Buffer logging: level debugging, ${n} messages logged`,
    '',
    'Log Buffer (2097152 bytes):',
    '',
    ...d.log.map((e) => `${xrLogPrefix(e.t)}${e.msg}`)
  ].join('\n')
}

export function showCommitList(d: Device, limit?: number): string {
  const list = xrStore(d).commits.slice(0, limit ?? 100)
  return [
    'SNo. Label/ID              User      Line                Client      Time Stamp',
    '~~~~ ~~~~~~~~              ~~~~      ~~~~                ~~~~~~      ~~~~~~~~~~',
    ...list.map((c, k) => `${pad(k + 1, 5)}${pad(c.label ?? c.id, 22)}${pad(c.user, 10)}${pad(c.line, 21)}${pad(c.client, 12)}${xrDate(c.t)}`)
  ].join('\n')
}

export { shortOf }
