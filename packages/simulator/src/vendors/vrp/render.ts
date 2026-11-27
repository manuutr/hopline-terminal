/**
 * VRP `display` renderers (CE6800 flavour). Column layouts are from memory of CE6800/S-series
 * output [unverified, from memory]; values come from the shared model and its state helpers.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, lpad, network, pad } from '../../core/text.ts'
import { maskToDotted } from '../../core/tree.ts'
import { ifaceCounters, isUp, neighborState, ospfState, resolvedDuplex, type Device, type Iface } from '../../state.ts'
import { ospfArea } from './config.ts'
import { hwMac, isPhysical } from './names.ts'

const two = (n: number): string => String(n).padStart(2, '0')

/** 2026-11-24 11:02:11 (UTC; the lab runs in UTC). */
export function hwDate(t: number): string {
  const x = new Date(t)
  return `${x.getUTCFullYear()}-${two(x.getUTCMonth() + 1)}-${two(x.getUTCDate())} ${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}`
}

function uptimeWords(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000))
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const p = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  return `${p(days, 'day')}, ${p(hours, 'hour')}, ${p(m, 'minute')}`
}

export function displayVersion(d: Device): string {
  const t = now(d)
  const up = uptimeWords(t - d.bootedAt)
  return [
    'Huawei Versatile Routing Platform Software',
    `VRP (R) software, Version 8.191 (CE6881 ${d.version})`,
    'Copyright (C) 2012-2020 Huawei Technologies Co., Ltd.',
    `HUAWEI ${d.model} uptime is ${up}`,
    'Patch Version: V200R019SPH005',
    '',
    `${d.model}(Master) 1 : uptime is ${up}`,
    `        StartupTime ${hwDate(d.bootedAt).replace(/-/g, '/')}`,
    'Memory     Size    : 4096 M bytes',
    'Flash      Size    : 2048 M bytes',
    `${d.model} version information`,
    '1. PCB      Version : CEM48S6CQP04    VER A',
    '2. MAB      Version : 1',
    `3. Board    Type    : ${d.model}`,
    '4. CPLD1    Version : 102',
    '5. BIOS     Version : 205'
  ].join('\n')
}

/** PHY column: `*down` admin down, `down` link/error down. */
function phy(i: Iface): string {
  if (!i.adminUp) return '*down'
  return isUp(i) ? 'up' : 'down'
}

function proto(i: Iface): string {
  if (!isUp(i)) return 'down'
  return /^(LoopBack|NULL)/.test(i.name) ? 'up(s)' : 'up'
}

const LEGEND = [
  'PHY: Physical',
  '*down: administratively down',
  '^down: standby',
  '(l): loopback',
  '(s): spoofing',
  '(E): E-Trunk down',
  '(b): BFD down',
  '(B): Bit-error-detection down',
  '(e): ETHOAM down',
  '(d): Dampening Suppressed',
  '(p): port alarm down',
  '(dl): DLDP down',
  '(c): CFM down',
  '(sd): Signal Degrade'
]

export function interfaceBrief(d: Device): string {
  const out = [...LEGEND, 'InUti/OutUti: input utility rate/output utility rate', 'Interface                  PHY      Protocol  InUti OutUti   inErrors  outErrors']
  for (const i of d.interfaces) {
    const c = ifaceCounters(d, i)
    const virtual = !i.speed
    const uti = virtual ? '--' : isUp(i) ? '0.01%' : '0%'
    out.push(`${pad(i.name, 27)}${pad(phy(i), 9)}${pad(proto(i), 8)}${lpad(uti, 7)}${lpad(uti, 7)}${lpad(c.inErrors, 11)}${lpad(c.outErrors, 11)}`)
  }
  return out.join('\n')
}

export function ipInterfaceBrief(d: Device): string {
  const l3 = d.interfaces.filter((i) => i.mode === 'routed')
  const upPhy = l3.filter((i) => i.adminUp && i.linkUp && !i.errDisabled).length
  const upProto = l3.filter(isUp).length
  const out = [
    '*down: administratively down',
    '^down: standby',
    '(l): loopback',
    '(s): spoofing',
    '(E): E-Trunk down',
    `The number of interface that is UP in Physical is ${upPhy}`,
    `The number of interface that is DOWN in Physical is ${l3.length - upPhy}`,
    `The number of interface that is UP in Protocol is ${upProto}`,
    `The number of interface that is DOWN in Protocol is ${l3.length - upProto}`,
    '',
    'Interface                         IP Address/Mask      Physical   Protocol  VPN '
  ]
  for (const i of l3) {
    const addr = i.ip && i.mask !== undefined ? `${i.ip}/${i.mask}` : 'unassigned'
    out.push(`${pad(i.name, 34)}${pad(addr, 21)}${pad(phy(i), 11)}${pad(proto(i), 10)}--`)
  }
  return out.join('\n')
}

export function displayInterface(d: Device, i: Iface): string {
  const c = ifaceCounters(d, i)
  const state = !i.adminUp ? 'Administratively DOWN' : i.errDisabled ? `ERROR DOWN(${i.errDisabled})` : isUp(i) ? 'UP' : 'DOWN'
  const idx = d.interfaces.indexOf(i) + 5
  const out = [`${i.name} current state : ${state} (ifindex: ${idx})`, `Line protocol current state : ${isUp(i) ? 'UP' : 'DOWN'}`]
  if (i.description !== undefined) out.push(`Description: ${i.description}`)
  if (i.mode === 'routed') {
    out.push(`Route Port,The Maximum Transmit Unit is ${i.mtu ?? 1500}`)
    out.push(i.ip && i.mask !== undefined ? `Internet Address is ${i.ip}/${i.mask}` : 'Internet protocol processing : disabled')
  } else {
    out.push('Switch Port, TPID : 8100(Hex), The Maximum Frame Length is 9216')
    out.push(i.mode === 'trunk' ? `Port link-type: trunk, PVID : ${i.nativeVlan ?? 1}` : `Port link-type: access, PVID : ${i.vlan ?? 1}`)
  }
  if (i.mac) out.push(`IP Sending Frames' Format is PKTFMT_ETHNT_2, Hardware address is ${hwMac(i.mac)}`)
  if (isPhysical(i)) {
    const speed = i.speed === '10G' ? '10000' : i.speed === '25G' ? '25000' : i.speed || '1000'
    out.push(`Port Mode: COMMON ${i.media === 'RJ45' ? 'COPPER' : 'FIBER'}, Port Split: -`)
    out.push(`Speed: ${speed}, Loopback: NONE`)
    out.push(`Duplex: ${resolvedDuplex(i).toUpperCase()}, Negotiation: ${i.duplex && i.duplex !== 'auto' ? 'DISABLE' : 'ENABLE'}`)
    out.push(`Input Flow-control: DISABLE, Output Flow-control: DISABLE`)
    out.push(`Mdi: -, Fec: NONE`)
    out.push(`Last physical up time   : ${isUp(i) ? hwDate(i.lastChange ?? d.bootedAt) : '-'}`)
    out.push(`Last physical down time : ${isUp(i) ? '-' : hwDate(i.lastChange ?? d.bootedAt)}`)
    out.push(`Current system time: ${hwDate(now(d))}`)
    out.push(`Statistics last cleared:${i.clearedAt ? hwDate(i.clearedAt) : 'never'}`)
    out.push(`    Last 300 seconds input rate: ${c.inBps} bits/sec, ${c.inPps} packets/sec`)
    out.push(`    Last 300 seconds output rate: ${c.outBps} bits/sec, ${c.outPps} packets/sec`)
    out.push(`    Input: ${c.inBytes} bytes, ${c.inPkts} packets`)
    out.push(`    Output: ${c.outBytes} bytes, ${c.outPkts} packets`)
    out.push(`    Input:`)
    out.push(`      Unicast: ${c.inPkts} packets, Multicast: 0 packets`)
    out.push(`      Broadcast: 0 packets, JumboOctets: 0 packets`)
    out.push(`      CRC: ${c.crc} packets, Symbol: 0 packets`)
    out.push(`      Overrun: ${c.overrun} packets, InRangeLength: 0 packets`)
    out.push(`      LongPacket: ${c.giants} packets, Jabber: 0 packets, Alignment: ${c.frame} packets`)
    out.push(`      Fragment: ${c.runts} packets, Undersized Frame: ${c.runts} packets`)
    out.push(`      RxPause: 0 packets`)
    out.push(`    Output:`)
    out.push(`      Unicast: ${c.outPkts} packets, Multicast: 0 packets`)
    out.push(`      Broadcast: 0 packets, JumboOctets: 0 packets`)
    out.push(`      Lost: 0 packets, Overflow: 0 packets, Underrun: 0 packets`)
    out.push(`      System: 0 packets, Overruns: 0 packets`)
    out.push(`      TxPause: 0 packets`)
    out.push(`      Collisions: ${c.collisions} packets, Late Collisions: ${c.lateCollisions} packets, Deferral: ${c.deferred} packets`)
    out.push(`    Input bandwidth utilization  : ${isUp(i) ? '0.01%' : '0%'}`)
    out.push(`    Output bandwidth utilization : ${isUp(i) ? '0.01%' : '0%'}`)
  } else {
    out.push(`Current system time: ${hwDate(now(d))}`)
    out.push(`    Input: ${c.inBytes} bytes, ${c.inPkts} packets`)
    out.push(`    Output: ${c.outBytes} bytes, ${c.outPkts} packets`)
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ VLANs

function vlanMembers(d: Device, vid: number): { ut: Iface[]; tg: Iface[] } {
  const ut: Iface[] = []
  const tg: Iface[] = []
  for (const i of d.interfaces) {
    if (!isPhysical(i) || i.name.startsWith('MEth')) continue
    if (i.mode === 'access' && (i.vlan ?? 1) === vid) ut.push(i)
    if (i.mode === 'trunk') {
      if ((i.nativeVlan ?? 1) === vid) ut.push(i)
      else if (i.trunkAllowed?.includes(vid)) tg.push(i)
    }
  }
  return { ut, tg }
}

export function displayVlan(d: Device, vid?: number): string {
  const rule = '-'.repeat(80)
  const out = [
    rule,
    'U: Up;         D: Down;         TG: Tagged;         UT: Untagged;',
    'MP: Vlan-mapping;               ST: Vlan-stacking;',
    '#: ProtocolTransparent-vlan;    *: Management-vlan;',
    'MAC-LRN: MAC-address learning;  STAT: Statistic;',
    'BC: Broadcast; MC: Multicast;   UC: Unknown-unicast;',
    'FWD: Forward;  DSD: Discard;',
    rule,
    '',
    'VID          Ports',
    rule
  ]
  const vlans = [...d.vlans].sort((a, b) => a.id - b.id).filter((v) => vid === undefined || v.id === vid)
  const tag = (i: Iface): string => `${i.name}(${isUp(i) ? 'U' : 'D'})`
  for (const v of vlans) {
    const { ut, tg } = vlanMembers(d, v.id)
    const rows: string[] = []
    const chunk = (label: string, list: Iface[]): void => {
      for (let k = 0; k < list.length; k += 3) rows.push(`${k === 0 ? label : '   '}${list.slice(k, k + 3).map((i) => pad(tag(i), 19)).join('').trimEnd()}`)
    }
    chunk('UT:', ut)
    chunk('TG:', tg)
    if (!rows.length) out.push(`${lpad(v.id, 4)}`)
    rows.forEach((r, k) => out.push(`${k === 0 ? lpad(v.id, 4) : '    '}         ${r}`))
  }
  out.push('', 'VID Type     Status  Property  MAC-LRN STAT    BC  MC  UC  Description', rule)
  for (const v of vlans) {
    const desc = v.name || `VLAN ${String(v.id).padStart(4, '0')}`
    out.push(`${lpad(v.id, 4)} common   ${pad(v.shutdown ? 'disable' : 'enable', 8)}default   enable  disable FWD FWD FWD ${desc}`)
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ routing

/** VRP Up/Down: hh:mm:ss under a day, else 0041h03m [unverified, from memory]. */
export function hwUpDown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h < 24) return `${two(h)}:${two(m)}:${two(s % 60)}`
  return `${String(h).padStart(4, '0')}h${two(m)}m`
}

export function bgpPeer(d: Device): string {
  const t = now(d)
  const est = d.bgp.filter((n) => neighborState(d, n, t) === 'Established').length
  const out = [
    '',
    ` BGP local router ID : ${d.routerId}`,
    ` Local AS number : ${d.localAs}`,
    ` Total number of peers : ${d.bgp.length}                 Peers in established state : ${est}`,
    '',
    '  Peer            V          AS  MsgRcvd  MsgSent  OutQ  Up/Down       State  PrefRcv'
  ]
  for (const n of [...d.bgp].sort((a, b) => cmpIp(a.ip, b.ip))) {
    const st = neighborState(d, n, t)
    const up = st === 'Established'
    const state = st === 'Idle (Admin)' ? 'Idle(Admin)' : st
    const since = up ? n.upSince! : (n.downSince ?? d.bootedAt)
    out.push(`  ${pad(n.ip, 16)}${pad('4', 2)}${lpad(n.remoteAs, 10)}${lpad(up ? (n.msgRcvd ?? 0) : 0, 9)}${lpad(up ? (n.msgSent ?? 0) : 0, 9)}${lpad(0, 6)} ${pad(hwUpDown(t - since), 9)}${lpad(state, 12)}${lpad(up ? n.prefixes : 0, 9)}`)
  }
  return out.join('\n')
}

const OSPF_STATE: Record<string, string> = { FULL: 'Full', EXSTART: 'ExStart', '2WAY': '2-Way' }

export function ospfPeerBrief(d: Device): string {
  const o = d.ospf
  if (!o) return ''
  const rule = ' ' + '-'.repeat(76)
  const rows = o.neighbors.map((n) => ({ n, st: ospfState(d, n) })).filter((x) => x.st)
  const out = [`OSPF Process ${o.process} with Router ID ${o.routerId ?? d.routerId}`, '                  Peer Statistic Information', rule, ' Area Id          Interface                        Neighbor id      State']
  for (const { n, st } of rows) out.push(` ${pad(ospfArea(n.area), 17)}${pad(n.iface, 33)}${pad(n.routerId, 17)}${OSPF_STATE[st!]}`)
  out.push(rule, ` Total Peer(s):     ${rows.length}`)
  return out.join('\n')
}

interface Route {
  dest: string
  mask: number
  proto: string
  pre: number
  cost: number
  flags: string
  nh: string
  iface: string
}

export function routes(d: Device): Route[] {
  const r: Route[] = []
  for (const i of d.interfaces) {
    if (!isUp(i) || !i.ip || i.mask === undefined) continue
    if (i.mask < 32) r.push({ dest: network(i.ip, i.mask), mask: i.mask, proto: 'Direct', pre: 0, cost: 0, flags: 'D', nh: i.ip, iface: i.name })
    r.push({ dest: i.ip, mask: 32, proto: 'Direct', pre: 0, cost: 0, flags: 'D', nh: '127.0.0.1', iface: i.mask === 32 ? i.name : i.name })
  }
  r.push({ dest: '127.0.0.0', mask: 8, proto: 'Direct', pre: 0, cost: 0, flags: 'D', nh: '127.0.0.1', iface: 'InLoopBack0' })
  r.push({ dest: '127.0.0.1', mask: 32, proto: 'Direct', pre: 0, cost: 0, flags: 'D', nh: '127.0.0.1', iface: 'InLoopBack0' })
  const outIf = (nh: string): Iface | undefined => d.interfaces.find((i) => isUp(i) && i.ip && i.mask !== undefined && network(i.ip, i.mask) === network(nh, i.mask))
  for (const s of d.staticRoutes) {
    const i = outIf(s.nextHop)
    if (i) r.push({ dest: s.prefix, mask: s.mask, proto: 'Static', pre: s.ad ?? 60, cost: 0, flags: 'RD', nh: s.nextHop, iface: i.name })
  }
  for (const n of d.ospf?.neighbors ?? []) {
    if (ospfState(d, n) !== 'FULL') continue
    r.push({ dest: n.routerId, mask: 32, proto: 'OSPF', pre: 10, cost: 1, flags: 'D', nh: n.ip, iface: n.iface })
  }
  const t = now(d)
  for (const n of d.bgp) {
    if (neighborState(d, n, t) !== 'Established') continue
    const i = d.interfaces.find((x) => x.name === n.via)
    for (const p of n.routes ?? []) {
      if (r.some((x) => x.dest === p.prefix && x.mask === p.mask && x.pre < 255)) continue
      r.push({ dest: p.prefix, mask: p.mask, proto: n.remoteAs === d.localAs ? 'IBGP' : 'EBGP', pre: 255, cost: 0, flags: 'RD', nh: n.ip, iface: i?.name ?? n.via })
    }
  }
  return r.sort((a, b) => cmpIp(a.dest, b.dest) || a.mask - b.mask)
}

export function routingTable(d: Device): string {
  const r = routes(d)
  const dests = new Set(r.map((x) => `${x.dest}/${x.mask}`)).size
  const out = [
    'Proto: Protocol        Pre: Preference',
    'Route Flags: R - relay, D - download to fib, T - to vpn-instance, B - black hole route',
    '-'.repeat(78),
    'Routing Table : _public_',
    `         Destinations : ${dests}       Routes : ${r.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost        Flags NextHop         Interface',
    ''
  ]
  for (const x of r) out.push(`${lpad(`${x.dest}/${x.mask}`, 18)}  ${pad(x.proto, 8)}${pad(x.pre, 5)}${pad(x.cost, 12)}${pad(x.flags, 6)}${pad(x.nh, 16)}${x.iface}`)
  return out.join('\n')
}

export function lldpBrief(d: Device): string {
  const out = ['Local Intf       Neighbor Dev             Neighbor Intf             Exptime(s)']
  for (const n of d.lldp) {
    if (n.noLldp) continue
    const i = d.interfaces.find((x) => x.name === n.local)
    if (i && !isUp(i)) continue
    out.push(`${pad(n.local, 17)}${pad(n.device, 25)}${pad(n.port, 26)}${n.holdtime ?? 120}`)
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ system

function activeHog(d: Device): Device['cpu']['hog'] {
  const h = d.cpu.hog
  return h && (!h.whileService || d.services[h.whileService]) ? h : undefined
}

export function cpuUsage(d: Device): string {
  const hog = activeHog(d)
  const [a, b, c] = d.cpu.load
  const five = Math.min(99, a + (hog?.pct ?? 0))
  const one = Math.min(99, b + (hog ? hog.pct - 4 : 0))
  const fiveMin = Math.min(99, c + (hog ? hog.pct - 9 : 0))
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  procs = procs.sort((x, y) => y.pct - x.pct)
  const out = [
    'CPU Usage Stat. Cycle: 60 (Second)',
    `CPU Usage            : ${five}% Max: ${Math.max(five, 37)}%`,
    `CPU Usage Stat. Time : ${hwDate(now(d)).replace(' ', '  ')}`,
    `CPU utilization for five seconds: ${five}%: one minute: ${one}%: five minutes: ${fiveMin}%`,
    `Max CPU Usage Stat. Time : ${hwDate(now(d) - 3 * 3600_000)}.`,
    '',
    'TaskName        CPU  Runtime(CPU Tick High/Tick Low)  Task Explanation'
  ]
  for (const p of procs) out.push(`${pad(p.name, 15)}${lpad(`${p.pct}%`, 4)}${lpad('0/  ' + (p.pid * 7919).toString(16), 20)}       ${p.name}`)
  return out.join('\n')
}

export function displayClock(d: Device): string {
  const x = new Date(now(d))
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `${hwDate(now(d))}\n${days[x.getUTCDay()]}\nTime Zone(Default Zone Name) : UTC`
}

export function logbuffer(d: Device): string {
  const out = ['Logging buffer configuration and contents : enabled', 'Allowed max buffer size : 1024', 'Actual buffer size : 1024', 'Channel number : 4 , Channel name : logbuffer', 'Dropped messages : 0', 'Overwritten messages : 0', `Current messages : ${d.log.length}`, '']
  for (const e of [...d.log].reverse()) out.push(`${hwDate(e.t)} ${d.hostname} %%01${e.msg}`)
  return out.join('\n')
}

export function macTable(d: Device): string {
  const rows = d.mac.filter((m) => {
    const i = d.interfaces.find((x) => x.name === m.port)
    return !i || isUp(i)
  })
  const out = ['Flags: * - Backup', '       # - forwarding logical interface, operations cannot be performed based', '           on the interface.', 'BD   : bridge domain   Age : dynamic MAC learned time in seconds', '-'.repeat(79), 'MAC Address    VLAN/VSI/BD   Learned-From        Type                Age', '-'.repeat(79)]
  for (const m of rows) out.push(`${pad(hwMac(m.mac), 15)}${pad(`${m.vlan}/-/-`, 14)}${pad(m.port, 20)}${pad(m.type === 'STATIC' ? 'static' : 'dynamic', 20)}${m.type === 'STATIC' ? '-' : '120'}`)
  out.push('-'.repeat(79), `Total items: ${rows.length}`)
  return out.join('\n')
}

export function arpAll(d: Device): string {
  const out = ['ARP timeout:1200s', 'IP ADDRESS      MAC ADDRESS    EXP(M) TYPE/VLAN       INTERFACE        VPN-INSTANCE', '-'.repeat(84)]
  let n = 0
  for (const i of d.interfaces) {
    if (!isUp(i) || !i.ip || !i.mac) continue
    out.push(`${pad(i.ip, 16)}${pad(hwMac(i.mac), 15)}${pad('', 7)}${pad('I', 16)}${i.name}`)
    n++
  }
  for (const a of d.arp) {
    const i = d.interfaces.find((x) => x.name === a.iface)
    if (i && !isUp(i)) continue
    out.push(`${pad(a.ip, 16)}${pad(hwMac(a.mac), 15)}${pad(20 - (a.age % 20), 7)}${pad('D', 16)}${a.iface}`)
    n++
  }
  out.push('-'.repeat(84), `Total:${n}         Dynamic:${n - d.interfaces.filter((i) => isUp(i) && i.ip && i.mac).length}         Static:0         Interface:${d.interfaces.filter((i) => isUp(i) && i.ip && i.mac).length}`)
  return out.join('\n')
}

export { maskToDotted }
