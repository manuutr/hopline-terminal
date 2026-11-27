/**
 * AOS-CX 10.x renderers and running-config. No research doc exists for AOS-CX: layouts are
 * `[unverified, from memory]` of 10.1x output on 6300/8325.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, lpad, network, pad } from '../../core/text.ts'
import { bgpUp, ifaceCounters, isUp, neighborState, ospfState, resolvedDuplex, uptime, uptimeLong, type Device, type Iface } from '../../state.ts'
import type { CxData } from '../../devices/aoscx.ts'

export function cxData(d: Device): CxData {
  const v = d.vendor as { aoscx?: CxData }
  return (v.aoscx ??= { checkpoints: [] })
}

const isPort = (i: Iface): boolean => /^\d+\/\d+\/\d+$/.test(i.name)
const num = (n: string): number[] => (n.match(/\d+/g) ?? []).map(Number)
const rank = (i: Iface): number => (i.name === 'mgmt' ? 0 : isPort(i) ? 1 : i.name.startsWith('lag') ? 2 : i.name.startsWith('loopback') ? 3 : 4)
export function ifSort(a: Iface, b: Iface): number {
  const r = rank(a) - rank(b)
  if (r) return r
  const x = num(a.name)
  const y = num(b.name)
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? -1) !== (y[k] ?? -1)) return (x[k] ?? -1) - (y[k] ?? -1)
  return 0
}

/** Compress [10,11,12,20] to "10-12,20". */
export function vlanRange(v: number[]): string {
  const s = [...new Set(v)].sort((a, b) => a - b)
  const out: string[] = []
  for (let k = 0; k < s.length; ) {
    let e = k
    while (e + 1 < s.length && s[e + 1] === s[e]! + 1) e++
    out.push(e > k ? `${s[k]}-${s[e]}` : String(s[k]))
    k = e + 1
  }
  return out.join(',')
}

const allowedOn = (i: Iface): number[] => i.trunkAllowed ?? Array.from({ length: 4094 }, (_, n) => n + 1)

// ---------------------------------------------------------------- version / system

export function showVersion(d: Device): string {
  return [
    '-----------------------------------------------------------------------------',
    'ArubaOS-CX',
    '(c) Copyright 2017-2023 Hewlett Packard Enterprise Development LP',
    '-----------------------------------------------------------------------------',
    `Version      : ${d.version}`,
    'Build Date   : 2023-05-04 18:22:46 UTC',
    `Build ID     : ArubaOS-CX:${d.version}:6c1d1f2a8e1b:202305041822`,
    'Build SHA    : 6c1d1f2a8e1b4e5f9a7c3d2b1a0f9e8d7c6b5a49',
    'Hot Patches  :',
    'Active Image : primary',
    '',
    'Service OS Version : FL.01.13.0002',
    'BIOS Version       : FL-01-0003',
    ''
  ].join('\n')
}

export function showSystem(d: Device): string {
  const t = now(d)
  const [cpu] = cpuLoad(d)
  return [
    `Hostname                : ${d.hostname}`,
    'System Description      : FL.10.12.1000',
    'System Contact          :',
    'System Location         :',
    '',
    `Vendor                  : Aruba`,
    `Product Name            : JL659A ${d.model} 48SR5 CL6 PoE 4SFP56 Swch`,
    `Chassis Serial Nbr      : ${d.serial}`,
    'Base MAC Address        : 38:21:c7:5a:00:00',
    `ArubaOS-CX Version      : ${d.version}`,
    '',
    'Time Zone               : UTC',
    '',
    `Up Time                 : ${uptimeLong(d.bootedAt, t)}`,
    `CPU Util (%)            : ${cpu}`,
    'Memory Usage (%)        : 31'
  ].join('\n')
}

function activeHog(d: Device): Device['cpu']['hog'] {
  return d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
}

export function cpuLoad(d: Device): [number, number, number] {
  const h = activeHog(d)
  const [a, b, c] = d.cpu.load
  return h ? [Math.min(99, a + h.pct), Math.min(99, b + h.pct - 4), Math.min(99, c + h.pct - 9)] : [a, b, c]
}

export function showResourceUtil(d: Device): string {
  const h = activeHog(d)
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: h && h.pid === p.pid ? h.pct : p.pct }))
  if (h && !procs.some((p) => p.pid === h.pid)) procs.push({ pid: h.pid, name: h.name, pct: h.pct })
  procs = procs.sort((a, b) => b.pct - a.pct || a.pid - b.pid)
  return [
    'System Resources:',
    'Processes: 245',
    `CPU usage(%): ${cpuLoad(d)[0]}`,
    'Memory usage(%): 31',
    "Open FD's: 2880",
    '',
    "Process                       CPU Usage(%)     Memory Usage(%)    Open FD's",
    '-'.repeat(75),
    ...procs.map((p) => `${pad(p.name, 30)}${pad(p.pct, 17)}${pad(1 + (p.pid % 3), 19)}${10 + (p.pid % 40)}`)
  ].join('\n')
}

// ---------------------------------------------------------------- interfaces

function reason(i: Iface): string {
  if (i.errDisabled) return `Disabled by ${i.errDisabled}`
  if (!i.adminUp) return 'Administratively down'
  if (!isUp(i)) return 'Waiting for link'
  return ''
}

export function showIntBrief(d: Device): string {
  const sep = '-'.repeat(104)
  const rows = [...d.interfaces].sort(ifSort).filter((i) => i.name !== 'mgmt').map((i) => {
    const port = isPort(i) || i.name.startsWith('lag')
    const native = !port ? '--' : i.mode === 'trunk' ? String(i.nativeVlan ?? 1) : i.mode === 'access' ? String(i.vlan ?? 1) : '--'
    const mode = !port ? '--' : i.mode
    const status = isUp(i) ? 'up' : 'down'
    const speed = isUp(i) && i.speed ? (/G$/.test(i.speed) ? String(Number(i.speed.slice(0, -1)) * 1000) : i.speed === 'auto' ? '1000' : i.speed) : '--'
    return `${pad(i.name, 10)}${pad(native, 8)}${pad(mode, 7)}${pad(port ? (i.media ?? '--') : '--', 15)}${pad(i.adminUp ? 'yes' : 'no', 8)}${pad(status, 8)}${pad(reason(i), 24)}${pad(speed, 8)}${i.description ?? ''}`.trimEnd()
  })
  return [sep, 'Port      Native  Mode   Type           Enabled Status  Reason                  Speed   Description', '          VLAN                                                                  (Mb/s)', sep, ...rows].join('\n')
}

export function showInterface(d: Device, i: Iface): string {
  const t = now(d)
  const c = ifaceCounters(d, i)
  const up = isUp(i)
  const l = [`Interface ${i.name} is ${up ? 'up' : 'down'}`, ` Admin state is ${i.adminUp ? 'up' : 'down'}`]
  if (!up && reason(i)) l.push(` State information: ${reason(i)}`)
  l.push(` Link state: ${up ? 'up' : 'down'} for ${uptime(i.lastChange ?? d.bootedAt, t)}`, ` Link transitions: ${i.lastChange && i.lastChange > d.bootedAt + 60_000 ? 3 : 1}`)
  if (i.description !== undefined) l.push(` Description: ${i.description}`)
  l.push(` Hardware: Ethernet, MAC Address: ${i.mac || '38:21:c7:5a:00:00'}`, ` MTU ${i.mtu ?? 1500}`)
  if (isPort(i)) {
    l.push(` Type ${i.media ?? '1GbT'}`, ` ${resolvedDuplex(i) === 'half' ? 'Half' : 'Full'}-duplex`, ' qos trust none', ` Speed ${up ? (/G$/.test(i.speed) ? Number(i.speed.slice(0, -1)) * 1000 : i.speed === 'auto' ? 1000 : i.speed) : 0} Mb/s`, ' Auto-negotiation is on', ' Flow-control: off', ' Error-control: off')
    if (i.mode === 'access') l.push(' VLAN Mode: access', ` Access VLAN: ${i.vlan ?? 1}`)
    else if (i.mode === 'trunk') l.push(' VLAN Mode: native-untagged', ` Native VLAN: ${i.nativeVlan ?? 1}`, ` Allowed VLAN List: ${i.trunkAllowed ? vlanRange(i.trunkAllowed) : 'all'}`)
    else l.push(' VLAN Mode: routed')
  }
  if (i.ip) l.push(` IPv4 address ${i.ip}/${i.mask}`)
  const mb = (bps: number): string => (bps / 1_000_000).toFixed(2)
  const row = (name: string, rx: string | number, tx: string | number, tot: string | number): string => ` ${pad(name, 16)} ${lpad(rx, 20)} ${lpad(tx, 20)} ${lpad(tot, 20)}`
  l.push(
    ' Rate collection interval: 300 seconds',
    '',
    ' Rate                               RX                   TX        Total (RX+TX)',
    ' ---------------- -------------------- -------------------- --------------------',
    row('Mbits / sec', mb(c.inBps), mb(c.outBps), mb(c.inBps + c.outBps)),
    row('KPkts / sec', (c.inPps / 1000).toFixed(2), (c.outPps / 1000).toFixed(2), ((c.inPps + c.outPps) / 1000).toFixed(2)),
    '',
    ' Statistic                          RX                   TX                Total',
    ' ---------------- -------------------- -------------------- --------------------',
    row('Packets', c.inPkts, c.outPkts, c.inPkts + c.outPkts),
    row('Bytes', c.inBytes, c.outBytes, c.inBytes + c.outBytes),
    row('Errors', c.inErrors, c.outErrors, c.inErrors + c.outErrors),
    row('  CRC/FCS', c.crc, 'n/a', c.crc),
    row('  Collision', 'n/a', c.collisions, c.collisions),
    row('  Late collision', 'n/a', c.lateCollisions, c.lateCollisions),
    row('  Runts', c.runts, 'n/a', c.runts),
    row('  Giants', c.giants, 'n/a', c.giants)
  )
  return l.join('\n')
}

export function showIpIntBrief(d: Device): string {
  const rows = [...d.interfaces].sort(ifSort).filter((i) => i.ip && i.name !== 'mgmt').map((i) => `${pad(i.name, 16)}${pad(`${i.ip}/${i.mask}`, 22)}${isUp(i) ? 'up' : 'down'}/${i.adminUp ? 'up' : 'down'}`)
  return ['', 'Interface       IP Address            Interface Status', '                                      link/admin', '--------------  --------------------  ------------------', ...rows].join('\n')
}

// ---------------------------------------------------------------- VLANs

export function vlanMembers(d: Device, id: number): Iface[] {
  return [...d.interfaces].sort(ifSort).filter((i) => isPort(i) && ((i.mode === 'access' && (i.vlan ?? 1) === id) || (i.mode === 'trunk' && allowedOn(i).includes(id))))
}

export function showVlan(d: Device, id?: number): string {
  const list = [...d.vlans].sort((a, b) => a.id - b.id).filter((v) => id === undefined || v.id === id)
  if (id !== undefined && !list.length) return `VLAN ${id} has not been configured.`
  const sep = '-'.repeat(104)
  const rows = list.map((v) => {
    const m = vlanMembers(d, v.id)
    const up = !v.shutdown && m.some(isUp)
    const why = v.shutdown ? 'admin_down' : up ? 'ok' : 'no_member_port'
    const ifs = compressPorts(m.map((i) => i.name))
    return `${pad(v.id, 6)}${pad(v.name, 34)}${pad(up ? 'up' : 'down', 8)}${pad(why, 23)}${pad(v.id === 1 ? 'default' : 'static', 10)}${ifs}`.trimEnd()
  })
  return ['', sep, 'VLAN  Name                              Status  Reason                 Type      Interfaces', sep, ...rows].join('\n')
}

/** "1/1/1,1/1/2,1/1/3" -> "1/1/1-1/1/3". */
function compressPorts(names: string[]): string {
  const out: string[] = []
  for (let k = 0; k < names.length; ) {
    const [a, b, c] = num(names[k]!)
    let e = k
    while (e + 1 < names.length) {
      const [x, y, z] = num(names[e + 1]!)
      if (x === a && y === b && z === c! + (e + 1 - k)) e++
      else break
    }
    out.push(e > k ? `${names[k]}-${names[e]}` : names[k]!)
    k = e + 1
  }
  return out.join(',')
}

// ---------------------------------------------------------------- LLDP, routing, OSPF, BGP

export function showLldp(d: Device, port?: string): string {
  const ns = d.lldp.filter((n) => !n.noLldp && (port === undefined || n.local === port)).filter((n) => {
    const i = d.interfaces.find((x) => x.name === n.local)
    return !!i && isUp(i)
  })
  if (port !== undefined) {
    const n = ns[0]
    if (!n) return `No LLDP neighbors found on port ${port}`
    return [
      '',
      `Port                           : ${n.local}`,
      `Neighbor Entries               : 1`,
      `Neighbor Chassis-Name          : ${n.device}`,
      `Neighbor Chassis-Description   : ${n.sysDescr ?? ''}`,
      `Neighbor Chassis-ID            : ${n.chassisId ?? ''}`,
      `Neighbor Management-Address    : ${n.ip ?? ''}`,
      `Chassis Capabilities Available : ${(n.caps ?? 'R').replace(/B/, 'Bridge').replace(/R/, 'Router').replace(/W/, 'WLAN')}`,
      `Neighbor Port-ID               : ${n.port}`,
      `TTL                            : ${n.holdtime ?? 120}`
    ].join('\n')
  }
  return [
    '',
    'LLDP Neighbor Information',
    '=========================',
    '',
    `Total Neighbor Entries          : ${ns.length}`,
    'Total Neighbor Entries Deleted  : 0',
    'Total Neighbor Entries Dropped  : 0',
    'Total Neighbor Entries Aged-Out : 0',
    '',
    'LOCAL-PORT  CHASSIS-ID         PORT-ID                     PORT-DESC                   TTL     SYS-NAME',
    '-'.repeat(104),
    ...ns.map((n) => `${pad(n.local, 12)}${pad(n.chassisId ?? '', 19)}${pad(n.port, 28)}${pad(n.port, 28)}${pad(n.holdtime ?? 120, 8)}${n.device}`)
  ].join('\n')
}

interface CxRoute {
  prefix: string
  mask: number
  nh: string
  iface: string
  origin: string
  dist: string
  age: string
}

export function cxRib(d: Device, vrf = 'default'): CxRoute[] {
  const t = now(d)
  const inVrf = (i: Iface): boolean => (i.vrf ?? 'default') === vrf
  const ifs = d.interfaces.filter((i) => inVrf(i) && i.ip && isUp(i))
  const out: CxRoute[] = []
  for (const i of ifs) {
    if (i.mask! < 32) out.push({ prefix: network(i.ip!, i.mask!), mask: i.mask!, nh: '-', iface: i.name, origin: 'C', dist: '[0/0]', age: '-' })
    out.push({ prefix: i.ip!, mask: 32, nh: '-', iface: i.name, origin: 'L', dist: '[0/0]', age: '-' })
  }
  for (const r of d.staticRoutes) {
    if ((r.vrf ?? 'default') !== vrf) continue
    const via = ifs.find((i) => i.mask! < 32 && inSubnet(r.nextHop, i.ip!, i.mask!))
    if (via) out.push({ prefix: r.prefix, mask: r.mask, nh: r.nextHop, iface: via.name, origin: 'S', dist: `[${r.ad ?? 1}/0]`, age: uptime(d.bootedAt, t) })
  }
  if (vrf === 'default') {
    for (const n of d.ospf?.neighbors ?? []) {
      if (ospfState(d, n) !== 'FULL') continue
      for (const r of (d.vendor['ospfRoutes'] as { prefix: string; mask: number; via: string }[] | undefined)?.filter((x) => x.via === n.ip) ?? []) out.push({ prefix: r.prefix, mask: r.mask, nh: n.ip, iface: n.iface, origin: 'O', dist: '[110/2]', age: uptime(n.upSince ?? d.bootedAt, t) })
    }
    for (const n of d.bgp) if (bgpUp(n, t)) for (const r of n.routes ?? []) out.push({ prefix: r.prefix, mask: r.mask, nh: n.ip, iface: '-', origin: 'B/E', dist: '[20/0]', age: uptime(n.upSince!, t) })
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

export function showIpRoute(d: Device, vrf = 'default'): string {
  const rows = cxRib(d, vrf).map((r) => `${pad(`${r.prefix}/${r.mask}`, 20)}${pad(r.nh, 17)}${pad(r.iface, 14)}${pad('-', 18)}${pad(r.origin, 9)}${pad(r.dist, 13)}${r.age}`)
  return [
    '',
    'Displaying ipv4 routes selected for forwarding',
    '',
    "Origin Codes: C - connected, S - static, L - local",
    '              R - RIP, B - BGP, O - OSPF',
    'Type Codes:   E - External BGP, I - Internal BGP, V - VPN, EV - EVPN',
    '              IA - OSPF internal area, E1 - OSPF external type 1',
    '              E2 - OSPF external type 2',
    '',
    `VRF: ${vrf}`,
    '',
    'Prefix              Nexthop          Interface     VRF(egress)       Origin/  Distance/    Age',
    '                                                                     Type     Metric',
    '-'.repeat(104),
    ...rows,
    '',
    `Total Route Count : ${rows.length}`
  ].join('\n')
}

export function showOspfNeighbors(d: Device): string {
  if (!d.ospf) return 'No OSPF neighbor found.'
  const rows: string[] = []
  for (const n of d.ospf.neighbors) {
    const st = ospfState(d, n)
    if (!st) continue
    rows.push(`${pad(n.routerId, 17)}${pad(n.pri, 10)}${pad(`${st}/${n.role ?? 'DROther'}`, 18)}${pad(n.ip, 18)}${n.iface}`)
  }
  return [`VRF : default                          Process : ${d.ospf.process}`, '='.repeat(51), '', `Total Number of Neighbors : ${rows.length}`, '', 'Neighbor ID      Priority  State             Nbr Address       Interface', '-'.repeat(73), ...rows].join('\n')
}

export function showBgpSummary(d: Device): string {
  if (!d.localAs) return '% BGP is not configured'
  const t = now(d)
  return [
    ' VRF : default',
    ' BGP Summary',
    ' -----------',
    ` Local AS               : ${d.localAs}        BGP Router Identifier  : ${d.routerId}`,
    ` Peers                  : ${d.bgp.length}            Log Neighbor Changes   : No`,
    ` Cfg. Hold Time         : 180          Cfg. Keep Alive        : 60`,
    '',
    ' Neighbor        Remote-AS MsgRcvd MsgSent   Up/Down Time State        AdminStatus',
    ...d.bgp.map((n) => ` ${pad(n.ip, 16)}${pad(n.remoteAs, 10)}${pad(bgpUp(n, t) ? (n.msgRcvd ?? 100) : 0, 8)}${pad(bgpUp(n, t) ? (n.msgSent ?? 100) : 0, 10)}${pad(bgpUp(n, t) ? uptime(n.upSince!, t) : '00h:00m:00s', 13)}${pad(neighborState(d, n, t), 13)}${n.shutdown ? 'Down' : 'Up'}`)
  ].join('\n')
}

export function showMacTable(d: Device): string {
  const live = d.mac.filter((m) => {
    const i = d.interfaces.find((x) => x.name === m.port)
    return !!i && isUp(i) && (i.mode !== 'trunk' || allowedOn(i).includes(m.vlan))
  })
  return [`MAC age-time            : 300 seconds`, `Number of MAC addresses : ${live.length}`, '', 'MAC Address          VLAN     Type                      Port', '-'.repeat(62), ...live.map((m) => `${pad(m.mac, 21)}${pad(m.vlan, 9)}${pad('dynamic', 26)}${m.port}`)].join('\n')
}

export function showArp(d: Device): string {
  const rows = d.arp.filter((a) => d.interfaces.some((i) => i.name === a.iface && isUp(i))).map((a) => `${pad(a.ip, 17)}${pad(a.mac, 19)}${pad(a.iface, 10)}${pad(a.iface.startsWith('vlan') ? (d.mac.find((m) => m.mac === a.mac)?.port ?? '1/1/49') : '', 14)}${pad('default', 9)}reachable`)
  return ['', 'IPv4 Address     MAC                Port      Physical Port VRF      State', '-'.repeat(84), ...rows, '', `Total Number Of ARP Entries Listed: ${rows.length}.`, '-'.repeat(84)].join('\n')
}

// ---------------------------------------------------------------- config

export function configBody(d: Device): string[] {
  const out: string[] = ['!', `!Version AOS-CX ${d.version}`, '!export-password: default', `hostname ${d.hostname}`, 'user admin group administrators password ciphertext AQBapZ1vF4c7pQ1rUq8Hn2xK', 'clock timezone utc', 'ntp server 10.10.10.20 iburst', 'ntp enable']
  if (d.motd !== undefined) out.push('banner motd !', ...d.motd.split('\n'), '!')
  out.push('!', '!', 'ssh server vrf mgmt')
  for (const v of [...d.vlans].sort((a, b) => a.id - b.id)) {
    out.push(`vlan ${v.id}`)
    if (v.id !== 1 || v.name !== 'DEFAULT_VLAN_1') if (v.name !== `VLAN${v.id}`) out.push(`    name ${v.name}`)
    if (v.shutdown) out.push('    shutdown')
  }
  out.push('spanning-tree')
  for (const i of [...d.interfaces].sort(ifSort)) {
    if (i.name.startsWith('loopback')) out.push(`interface loopback ${i.name.slice(8)}`)
    else if (i.name.startsWith('vlan')) out.push(`interface vlan ${i.name.slice(4)}`)
    else if (i.name.startsWith('lag')) out.push(`interface lag ${i.name.slice(3)}`)
    else out.push(`interface ${i.name}`)
    const port = isPort(i)
    if (port || i.name === 'mgmt') out.push(i.adminUp ? '    no shutdown' : '    shutdown')
    else if (!i.adminUp) out.push('    shutdown')
    if (i.description !== undefined) out.push(`    description ${i.description}`)
    if (i.mtu) out.push(`    mtu ${i.mtu}`)
    if (port) {
      if (i.mode === 'routed') out.push('    routing')
      else {
        out.push('    no routing')
        if (i.mode === 'access') out.push(`    vlan access ${i.vlan ?? 1}`)
        else out.push(`    vlan trunk native ${i.nativeVlan ?? 1}`, `    vlan trunk allowed ${i.trunkAllowed ? (i.trunkAllowed.length ? vlanRange(i.trunkAllowed) : 'none') : 'all'}`)
      }
    }
    if (i.name === 'mgmt') {
      if (i.ip) out.push(`    ip static ${i.ip}/${i.mask}`, '    default-gateway 192.168.99.1')
    } else if (i.ip) out.push(`    ip address ${i.ip}/${i.mask}`)
    const o = d.ospf?.ifaces.find((x) => x.iface === i.name)
    if (o) out.push(`    ip ospf ${d.ospf!.process} area ${o.area}`)
    if (o?.passive) out.push('    ip ospf passive')
    if (o?.networkType === 'point-to-point') out.push('    ip ospf network point-to-point')
  }
  out.push('!')
  for (const r of d.staticRoutes) out.push(`ip route ${r.prefix}/${r.mask} ${r.nextHop}${r.vrf ? ` vrf ${r.vrf}` : ''}${r.ad ? ` distance ${r.ad}` : ''}`)
  out.push('!')
  if (d.ospf) {
    out.push(`router ospf ${d.ospf.process}`)
    if (d.ospf.routerId) out.push(`    router-id ${d.ospf.routerId}`)
    for (const a of [...new Set(d.ospf.ifaces.map((o) => o.area))]) out.push(`    area ${a}`)
  }
  if (d.localAs) {
    out.push(`router bgp ${d.localAs}`, `    bgp router-id ${d.routerId}`)
    for (const n of d.bgp) {
      out.push(`    neighbor ${n.ip} remote-as ${n.remoteAs}`)
      if (n.description !== undefined) out.push(`    neighbor ${n.ip} description ${n.description}`)
      if (n.shutdown) out.push(`    neighbor ${n.ip} shutdown`)
    }
    out.push('    address-family ipv4 unicast', ...d.bgp.map((n) => `        neighbor ${n.ip} activate`), '    exit-address-family', '!')
  }
  out.push(...d.extraConfig, 'https-server vrf mgmt')
  return out
}

export function runningConfig(d: Device, body = configBody(d)): string {
  return ['Current configuration:', ...body].join('\n')
}
