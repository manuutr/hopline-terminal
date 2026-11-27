/** Junos operational show output (docs/research/cli-juniper-junos.md §6.2), rendered from the model. */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, lpad, network, pad } from '../../core/text.ts'
import { bgpUp, ifaceCounters, isUp, neighborState, ospfState, type Device, type Iface } from '../../state.ts'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number): string => String(n).padStart(2, '0')

/** BGP summary style: `3d 4:12:55`, `4:12:55`, `1w2d 3:04:05`. */
export function junosAge(from: number, t: number, padHours = false): string {
  const s = Math.max(0, Math.floor((t - from) / 1000))
  const w = Math.floor(s / 604800)
  const d = Math.floor((s % 604800) / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const hh = padHours ? two(h) : String(h)
  const clock = `${hh}:${two(m)}:${two(sec)}`
  if (w) return `${w}w${d}d ${clock}`
  if (d) return `${d}d ${clock}`
  return padHours ? `${two(h)}:${two(m)}:${two(sec)}` : clock
}

export function stamp(t: number): string {
  const d = new Date(t)
  return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
}

export function isoTime(t: number): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`
}

const PSEUDO = ['dsc', 'gre', 'ipip', 'lsi', 'mtun', 'pimd', 'pime', 'tap']
const physical = (i: Iface): boolean => /^(ge|xe|et|fe|ae)-?\d/.test(i.name)

export function showInterfacesTerse(d: Device, filter?: string): string {
  const rows: string[] = []
  const row = (name: string, admin: string, link: string, proto = '', local = '', remote = ''): string => (pad(name, 24) + pad(admin, 6) + pad(link, 5) + pad(proto, 9) + (remote ? pad(local, 20) + remote : local)).trimEnd()
  const st = (i: Iface): [string, string] => [i.adminUp ? 'up' : 'down', i.adminUp && isUp(i) ? 'up' : 'down']
  const emit = (i: Iface): void => {
    const [a, l] = st(i)
    rows.push(row(i.name, a, l))
    if (i.ip) {
      const local = i.mask === 32 ? i.ip : `${i.ip}/${i.mask}`
      rows.push(row(`${i.name}.0`, a, l, 'inet', local, i.mask === 32 ? '--> 0/0' : ''))
    } else if (i.units?.includes(0)) rows.push(row(`${i.name}.0`, a, l, 'inet'))
    if (i.name === 'lo0') rows.push(row('lo0.16385', 'up', 'up', 'inet'))
  }
  const phys = d.interfaces.filter(physical)
  const others = [...d.interfaces.filter((i) => !physical(i)).map((i) => i.name), ...PSEUDO].sort()
  for (const i of phys) emit(i)
  for (const n of others) {
    const i = d.interfaces.find((x) => x.name === n)
    if (i) emit(i)
    else rows.push(row(n, 'up', 'up'))
  }
  const re = filter ? new RegExp('^' + filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '(\\.\\d+)?$') : undefined
  const body = re ? rows.filter((r) => re.test(r.split(' ')[0]!)) : rows
  return ['Interface               Admin Link Proto    Local                 Remote', ...body].join('\n')
}

export function showInterfacesDescriptions(d: Device): string {
  const rows = d.interfaces.filter((i) => i.description).map((i) => `${pad(i.name, 24)}${pad(i.adminUp ? 'up' : 'down', 6)}${pad(i.adminUp && isUp(i) ? 'up' : 'down', 5)}${i.description}`)
  return ['Interface               Admin Link Description', ...rows].join('\n')
}

export function showInterface(d: Device, i: Iface, extensive: boolean): string {
  const t = now(d)
  const c = ifaceCounters(d, i, t)
  const up = i.adminUp && isUp(i)
  const lines = [
    `Physical interface: ${i.name}, ${i.adminUp ? 'Enabled' : 'Administratively down'}, Physical link is ${up ? 'Up' : 'Down'}`,
    `  Interface index: ${148 + d.interfaces.indexOf(i)}, SNMP ifIndex: ${526 + d.interfaces.indexOf(i)}`,
    ...(i.description ? [`  Description: ${i.description}`] : []),
    `  Link-level type: Ethernet, MTU: ${i.mtu ?? 1514}, LAN-PHY mode, Speed: ${i.speed === '1000' ? '1000mbps' : i.speed || 'Unspecified'}, BPDU Error: None, Loop Detect PDU Error: None,`,
    `  Link-mode: ${i.peer?.duplex === 'half' ? 'Half-duplex' : 'Full-duplex'}, Flow control: Enabled, Auto-negotiation: Enabled, Remote fault: Online`,
    `  Device flags   : Present Running`,
    `  Interface flags: ${up ? 'SNMP-Traps Internal: 0x4000' : 'Down SNMP-Traps Internal: 0x4000'}`,
    `  Current address: ${i.mac || '00:05:86:71:2c:00'}, Hardware address: ${i.mac || '00:05:86:71:2c:00'}`,
    `  Last flapped   : ${isoTime(i.lastChange ?? d.bootedAt)} (${junosAge(i.lastChange ?? d.bootedAt, t, true)} ago)`,
    `  Input rate     : ${c.inBps} bps (${c.inPps} pps)`,
    `  Output rate    : ${c.outBps} bps (${c.outPps} pps)`
  ]
  if (extensive) {
    lines.push(
      '  Input errors:',
      `    Errors: ${c.inErrors}, Drops: 0, Framing errors: ${c.crc}, Runts: ${c.runts}, Policed discards: 0, L3 incompletes: 0, L2 channel errors: 0,`,
      `    L2 mismatch timeouts: 0, FIFO errors: 0, Resource errors: 0`,
      '  Output errors:',
      `    Carrier transitions: 1, Errors: ${c.outErrors}, Drops: 0, Collisions: ${c.collisions}, Aged packets: 0, FIFO errors: 0, HS link CRC errors: 0,`,
      `    MTU errors: 0, Resource errors: 0`
    )
  }
  if (i.ip) {
    lines.push(
      '',
      `  Logical interface ${i.name}.0 (Index 336) (SNMP ifIndex 540)`,
      '    Flags: Up SNMP-Traps 0x4004000 Encapsulation: ENET2',
      `    Input packets : ${c.inPkts}`,
      `    Output packets: ${c.outPkts}`,
      `    Protocol inet, MTU: ${(i.mtu ?? 1514) - 14}`,
      '      Flags: Sendbcast-pkt-to-re',
      '      Addresses, Flags: Is-Preferred Is-Primary',
      `        Destination: ${network(i.ip, i.mask!)}/${i.mask}, Local: ${i.ip}, Broadcast: ${broadcast(i.ip, i.mask!)}`
    )
  }
  return lines.join('\n')
}

function broadcast(ip: string, mask: number): string {
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
  const b = (n | (mask === 0 ? 0xffffffff : (1 << (32 - mask)) - 1)) >>> 0
  return [24, 16, 8, 0].map((s) => (b >>> s) & 255).join('.')
}

export function showBgpSummary(d: Device, groups: number): string {
  const t = now(d)
  const est = d.bgp.filter((n) => bgpUp(n, t))
  const paths = est.reduce((a, n) => a + n.prefixes, 0)
  const rows: string[] = []
  for (const n of [...d.bgp].sort((a, b) => cmpIp(a.ip, b.ip))) {
    const up = bgpUp(n, t)
    const st = neighborState(d, n, t)
    const since = up ? n.upSince! : (n.downSince ?? d.bootedAt)
    const state = up ? 'Establ' : st === 'Idle (Admin)' ? 'Idle' : st === 'Idle' ? 'Idle' : 'Active'
    rows.push(`${pad(n.ip, 16)}${lpad(n.remoteAs, 11)}${lpad(up ? (n.msgRcvd ?? 0) : 0, 11)}${lpad(up ? (n.msgSent ?? 0) : 0, 11)}${lpad(0, 8)}${lpad(up ? 1 : 0, 8)}${lpad(junosAge(since, t), 12)} ${state}`)
    if (up) rows.push(`  inet.0: ${n.prefixes}/${n.prefixes}/${n.prefixes}/0`)
  }
  return [
    'Threading mode: BGP I/O',
    'Default eBGP mode: advertise - accept, receive - accept',
    `Groups: ${groups} Peers: ${d.bgp.length} Down peers: ${d.bgp.length - est.length}`,
    'Table          Tot Paths  Act Paths Suppressed    History Damp State    Pending',
    'inet.0',
    `${lpad(paths, 24)}${lpad(paths, 11)}${lpad(0, 11)}${lpad(0, 11)}${lpad(0, 11)}${lpad(0, 11)}`,
    'Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...',
    ...rows
  ].join('\n')
}

export function showBgpNeighbor(d: Device, ip?: string): string {
  const t = now(d)
  const list = ip ? d.bgp.filter((n) => n.ip === ip) : d.bgp
  if (!list.length) return ''
  return list
    .map((n) => {
      const up = bgpUp(n, t)
      const via = d.interfaces.find((i) => i.name === n.via)
      const wrong = n.peerAs !== undefined && n.peerAs !== n.remoteAs
      return [
        `Peer: ${n.ip}+179 AS ${n.remoteAs}   Local: ${via?.ip ?? d.routerId}+${up ? 63740 : 179} AS ${d.localAs}`,
        `  Group: ${n.description ?? ''}         Routing-Instance: master`,
        `  Forwarding routing-instance: master`,
        `  Type: External    State: ${up ? 'Established' : neighborState(d, n, t) === 'Idle' ? 'Idle' : 'Active'}    Flags: <${up ? 'Sync' : 'ImportEval'}>`,
        `  Last State: ${up ? 'OpenConfirm' : 'Idle'}   Last Event: ${up ? 'RecvKeepAlive' : 'ConnectRetry'}`,
        `  Last Error: ${wrong ? 'Open Message Error' : up ? 'None' : 'Hold Timer Expired Error'}`,
        ...(wrong ? [`  Error: 'Open Message Error' Sent: 1 Recv: 0`, `    Peer AS ${n.peerAs} does not match configured peer-as ${n.remoteAs}`] : []),
        ...(n.routeMapOut ? [`  Export: [ ${n.routeMapOut} ] `] : []),
        `  Options: <Preference PeerAS Refresh>`,
        `  Holdtime: 90 Preference: 170`,
        `  Number of flaps: ${up ? 1 : 0}`,
        ...(up ? [`  Peer ID: ${n.routerId ?? n.ip}     Local ID: ${d.routerId}         Active Holdtime: 90`, `  Table inet.0 Bit: 20000`, `    Active prefixes:              ${n.prefixes}`, `    Received prefixes:            ${n.prefixes}`, `    Accepted prefixes:            ${n.prefixes}`] : [])
      ].join('\n')
    })
    .join('\n\n')
}

export function showOspfNeighbor(d: Device): string {
  const rows: string[] = []
  for (const n of d.ospf?.neighbors ?? []) {
    const st = ospfState(d, n)
    if (!st) continue
    const state = st === 'FULL' ? 'Full' : st === 'EXSTART' ? 'ExStart' : '2Way'
    rows.push(`${pad(n.ip, 17)}${pad(n.iface + '.0', 23)}${pad(state, 10)}${n.routerId}${lpad(n.pri, 20 - n.routerId.length)}${lpad(34, 6)}`)
  }
  return ['Address          Interface              State     ID               Pri  Dead', ...rows].join('\n')
}

export function showOspfInterface(d: Device): string {
  const rows = (d.ospf?.ifaces ?? []).map((o) => {
    const i = d.interfaces.find((x) => x.name === o.iface)
    const nbrs = (d.ospf?.neighbors ?? []).filter((n) => n.iface === o.iface && ospfState(d, n) === 'FULL').length
    const st = !i || !isUp(i) ? 'Down' : o.passive ? 'DRother' : o.networkType === 'point-to-point' ? 'PtToPt' : 'DR'
    return `${pad(o.iface + '.0', 21)}${pad(st, 8)}${pad(o.area, 16)}${pad('0.0.0.0', 16)}${pad('0.0.0.0', 16)}${nbrs}`
  })
  return ['Interface           State   Area            DR ID           BDR ID          Nbrs', ...rows].join('\n')
}

interface JRoute {
  prefix: string
  mask: number
  proto: string
  pref: number
  since: number
  extra?: string
  lines: string[]
}

export function routes(d: Device): JRoute[] {
  const t = now(d)
  const out: JRoute[] = []
  const ifs = d.interfaces.filter((i) => !i.vrf && i.ip && isUp(i) && i.adminUp)
  for (const i of ifs) {
    const since = i.lastChange ?? d.bootedAt
    if (i.mask === 32) out.push({ prefix: i.ip!, mask: 32, proto: 'Direct', pref: 0, since, lines: [`                    >  via ${i.name}.0`] })
    else {
      out.push({ prefix: network(i.ip!, i.mask!), mask: i.mask!, proto: 'Direct', pref: 0, since, lines: [`                    >  via ${i.name}.0`] })
      out.push({ prefix: i.ip!, mask: 32, proto: 'Local', pref: 0, since, lines: [`                       Local via ${i.name}.0`] })
    }
  }
  const via = (nh: string): Iface | undefined => ifs.find((i) => i.mask! < 32 && inSubnet(nh, i.ip!, i.mask!))
  for (const r of d.staticRoutes) {
    const i = via(r.nextHop)
    if (i) out.push({ prefix: r.prefix, mask: r.mask, proto: 'Static', pref: 5, since: d.bootedAt, lines: [`                    >  to ${r.nextHop} via ${i.name}.0`] })
  }
  const seed = (d.vendor['junosSeed'] as { ospfRoutes?: { prefix: string; mask: number; via: string; metric?: number }[] } | undefined)?.ospfRoutes ?? []
  for (const n of d.ospf?.neighbors ?? []) {
    if (ospfState(d, n) !== 'FULL') continue
    for (const r of seed.filter((x) => x.via === n.ip)) out.push({ prefix: r.prefix, mask: r.mask, proto: 'OSPF', pref: 10, since: n.upSince ?? d.bootedAt, extra: `, metric ${r.metric ?? 1}`, lines: [`                    >  to ${n.ip} via ${n.iface}.0`] })
  }
  for (const n of d.bgp) {
    if (!bgpUp(n, t)) continue
    const i = d.interfaces.find((x) => x.name === n.via)
    for (const r of n.routes ?? []) {
      if (out.some((o) => o.prefix === r.prefix && o.mask === r.mask)) continue
      out.push({ prefix: r.prefix, mask: r.mask, proto: 'BGP', pref: 170, since: n.upSince! + 5000, extra: ', localpref 100', lines: [`                      AS path: ${n.remoteAs} I, validation-state: unverified`, `                    >  to ${n.ip} via ${i?.name ?? n.via}.0`] })
    }
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

export function showRoute(d: Device, opts: { target?: string; exact?: boolean; protocol?: string; terse?: boolean } = {}): string {
  const t = now(d)
  let rs = routes(d)
  if (opts.protocol) rs = rs.filter((r) => r.proto.toLowerCase() === opts.protocol!.toLowerCase())
  if (opts.target) {
    const [ip, len] = opts.target.split('/')
    if (opts.exact || len !== undefined) rs = rs.filter((r) => r.prefix === ip && (len === undefined || r.mask === Number(len)))
    else {
      const best = rs.filter((r) => inSubnet(ip!, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask)[0]
      rs = best ? [best] : []
    }
  }
  const all = routes(d)
  const head = ['', `inet.0: ${all.length} destinations, ${all.length} routes (${all.length} active, 0 holddown, 0 hidden)`, '+ = Active Route, - = Last Active, * = Both', '']
  if (opts.target && !rs.length) return ''
  if (opts.terse) return [...head, 'A V Destination        P Prf   Metric 1   Metric 2  Next hop        AS path', ...rs.map((r) => `* ? ${pad(`${r.prefix}/${r.mask}`, 19)}${r.proto[0]} ${lpad(r.pref, 3)}${lpad(r.proto === 'OSPF' ? 1 : '', 11)}${' '.repeat(11)}${r.lines.at(-1)!.includes('to ') ? '>' + (/to (\S+)/.exec(r.lines.at(-1)!)?.[1] ?? '') : '>' + (/via (\S+)/.exec(r.lines.at(-1)!)?.[1] ?? '')}`)].join('\n')
  const body = rs.flatMap((r) => [`${pad(`${r.prefix}/${r.mask}`, 19)}*[${r.proto}/${r.pref}] ${junosAge(r.since, t, true)}${r.extra ?? ''}`, ...r.lines])
  return [...head, ...body].join('\n')
}

export function showRouteSummary(d: Device): string {
  const rs = routes(d)
  const by = (p: string): number => rs.filter((r) => r.proto === p).length
  return [
    `Autonomous system number: ${d.localAs}`,
    `Router ID: ${d.routerId}`,
    '',
    `inet.0: ${rs.length} destinations, ${rs.length} routes (${rs.length} active, 0 holddown, 0 hidden)`,
    ...['Direct', 'Local', 'OSPF', 'BGP', 'Static'].filter((p) => by(p)).map((p) => `${lpad(p, 23)}:${lpad(by(p), 6)} routes,${lpad(by(p), 6)} active`)
  ].join('\n')
}

export function showArp(d: Device): string {
  const rows = d.arp.filter((a) => {
    const i = d.interfaces.find((x) => x.name === a.iface)
    return i && isUp(i)
  })
  return ['MAC Address       Address         Interface                Flags', ...rows.map((a) => `${pad(a.mac, 18)}${pad(a.ip, 16)}${pad(a.iface + '.0', 25)}none`), `Total entries: ${rows.length}`].join('\n')
}

export function showLldp(d: Device): string {
  const rows = d.lldp.filter((n) => {
    const i = d.interfaces.find((x) => x.name === n.local)
    return i && isUp(i) && i.adminUp
  })
  return ['', 'Local Interface    Parent Interface    Chassis Id          Port info          System Name', ...rows.map((n) => `${pad(n.local, 19)}${pad(n.parent ?? '-', 20)}${pad(n.chassisId ?? '-', 20)}${pad(n.port, 19)}${n.device}`)].join('\n')
}

export function showVersion(d: Device): string {
  const k = '[20231115.f0321c3_builder_stable_12_224]'
  const j = '[20231206.104530_builder_junos_224_r3]'
  return [
    `Hostname: ${d.hostname}`,
    `Model: ${d.model}`,
    `Junos: ${d.version}`,
    `JUNOS OS Kernel 64-bit  ${k}`,
    `JUNOS OS libs ${k}`,
    `JUNOS OS runtime ${k}`,
    `JUNOS OS time zone information ${k}`,
    `JUNOS network stack and utilities ${j}`,
    `JUNOS libs ${j}`,
    `JUNOS modules ${j}`,
    `JUNOS mx modules ${j}`,
    `JUNOS daemons ${j}`,
    `JUNOS mx daemons ${j}`
  ].join('\n')
}

export function showLog(d: Device): string {
  return d.log.map((e) => `${stamp(e.t)}  ${d.hostname} ${e.msg}`).join('\n')
}

export function showSystemUptime(d: Device): string {
  const t = now(d)
  return [
    `Current time: ${isoTime(t)}`,
    `Time Source:  LOCAL CLOCK `,
    `System booted: ${isoTime(d.bootedAt)} (${junosAge(d.bootedAt, t, true)} ago)`,
    `Protocols started: ${isoTime(d.bootedAt + 60_000)} (${junosAge(d.bootedAt + 60_000, t, true)} ago)`,
    `Last configured: ${isoTime((d.vendor['junosLastCommit'] as number | undefined) ?? d.bootedAt)} by ${d.user}`,
    `${new Date(t).toISOString().slice(11, 16)}  up ${Math.floor((t - d.bootedAt) / 86400000)} days, ${new Date(t - d.bootedAt).toISOString().slice(11, 16)}, 1 user, load averages: 0.32, 0.28, 0.25`
  ].join('\n')
}

export function cpuHog(d: Device): { pid: number; name: string; pct: number } | undefined {
  const h = d.cpu.hog
  return h && (!h.whileService || d.services[h.whileService]) ? h : undefined
}

export function showRoutingEngine(d: Device): string {
  const hog = cpuHog(d)
  const user = hog ? Math.min(97, hog.pct) : d.cpu.load[0]
  const idle = Math.max(0, 100 - user - 2)
  const t = now(d)
  return [
    'Routing Engine status:',
    '    Temperature                 40 degrees C / 104 degrees F',
    '    Total memory              4096 MB Max  1352 MB used ( 33 percent)',
    '      Control plane memory    2548 MB Max   917 MB used ( 36 percent)',
    '    5 sec CPU utilization:',
    `      User                      ${lpad(user, 3)} percent`,
    '      Background                  0 percent',
    '      Kernel                      2 percent',
    '      Interrupt                   0 percent',
    `      Idle                      ${lpad(idle, 3)} percent`,
    `    Model                          RE-VMX`,
    `    Start time                     ${isoTime(d.bootedAt)}`,
    `    Uptime                         ${junosAge(d.bootedAt, t)}`,
    `    Load averages:                 1 minute   5 minute  15 minute`,
    `                                       ${(user / 100).toFixed(2)}       0.28       0.25`
  ].join('\n')
}

export function showProcesses(d: Device): string {
  const hog = cpuHog(d)
  const procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  procs.sort((a, b) => b.pct - a.pct)
  return [
    `last pid: 8123;  load averages:  0.32,  0.28,  0.25  up ${junosAge(d.bootedAt, now(d))}`,
    `${procs.length + 140} processes: 2 running, ${procs.length + 136} sleeping, 2 zombie`,
    '',
    '  PID USERNAME       THR PRI NICE   SIZE    RES STATE    C   TIME    WCPU COMMAND',
    ...procs.map((p) => `${lpad(p.pid, 5)} root            ${lpad(3, 3)}  20    0 ${lpad('812M', 6)} ${lpad('64M', 6)} ${pad(p.pct > 20 ? 'RUN' : 'select', 8)} ${lpad(1, 1)} ${lpad('12:04', 6)} ${lpad(p.pct.toFixed(2) + '%', 7)} ${p.name}`)
  ].join('\n')
}
