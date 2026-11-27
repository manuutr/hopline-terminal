/**
 * Cisco ASA 9.x renderers, the ACL matcher and packet-tracer. No research doc exists for the ASA;
 * layouts are `[unverified, from memory]` of 9.1x output.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, ipToInt, lpad, network, pad } from '../../core/text.ts'
import { isIpv4, maskToDotted } from '../../core/tree.ts'
import { ifaceCounters, isUp, resolvedDuplex, type Acl, type AclEntry, type Device, type Iface } from '../../state.ts'
import type { AsaData } from '../../devices/asa.ts'

export function asaData(d: Device): AsaData {
  const v = d.vendor as { asa?: AsaData }
  return (v.asa ??= { levels: {}, groups: [], conn: { inUse: 0, most: 0 }, xlate: { inUse: 0, most: 0 } })
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')

/** "11:02:11.418 UTC Tue Nov 24 2026" */
export function asaClock(t: number): string {
  const d = new Date(t)
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')} UTC ${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`
}

export const nameOf = (i: Iface): string | undefined => i.zone
export const byNameif = (d: Device, n: string): Iface | undefined => d.interfaces.find((i) => i.zone === n)
const levelOf = (d: Device, i: Iface): number | undefined => (i.zone ? asaData(d).levels[i.zone] : undefined)

function uptimeWords(from: number, t: number): string {
  const m = Math.max(0, Math.floor((t - from) / 60000))
  const days = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const parts = [days ? `${days} day${days === 1 ? '' : 's'}` : '', h ? `${h} hour${h === 1 ? '' : 's'}` : '', !days && !h ? `${m % 60} min` : '']
  return parts.filter(Boolean).join(' ')
}

/** A stable 32-bit hash for ACE ids / cryptochecksums. */
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return h.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------- version

export function showVersion(d: Device): string {
  const t = now(d)
  const lc = asaData(d).lastChange
  const ifs = d.interfaces.map((i, k) => `${lpad(k, 2)}: ${i.name.startsWith('Management') ? 'Int: Not used' : 'Ext'}: ${pad(i.name, 20)}: address is ${i.mac}, irq 255`)
  return [
    '',
    `Cisco Adaptive Security Appliance Software Version ${d.version} `,
    'Device Manager Version 7.18(1)152',
    '',
    'Compiled on Fri 21-Apr-23 06:38 GMT by builders',
    `System image file is "boot:/asa${d.version.replace(/^(\d+)\.(\d+)\((\d+)\)(\d*)$/, (_m, a: string, b: string, c: string, e: string) => `${a}${b}${c}${e ? `-${e}` : ""}`)}-smp-k8.bin"`, // [unverified, from memory]
    'Config file at boot was "startup-config"',
    '',
    `${d.hostname} up ${uptimeWords(d.bootedAt, t)}`,
    '',
    `Hardware:   ${d.model}, 8192 MB RAM, CPU Xeon 4100/6100/8100 series 2200 MHz, 1 CPU (4 cores)`,
    'Internal ATA Compact Flash, 8192MB',
    'BIOS Flash M25P64 @ 0xfed01000, 16384KB',
    '',
    'Model Id:   ASAv30',
    '',
    ...ifs,
    '',
    'Licensed features for this platform:',
    'Maximum Physical Interfaces       : Unlimited      perpetual',
    'Maximum VLANs                     : 150            perpetual',
    'Inside Hosts                      : Unlimited      perpetual',
    'Failover                          : Active/Active  perpetual',
    'Encryption-DES                    : Enabled        perpetual',
    'Encryption-3DES-AES               : Enabled        perpetual',
    'Security Contexts                 : 2              perpetual',
    'Carrier                           : Disabled       perpetual',
    'AnyConnect Premium Peers          : 4              perpetual',
    'AnyConnect Essentials             : Disabled       perpetual',
    'Other VPN Peers                   : 300            perpetual',
    'Total VPN Peers                   : 300            perpetual',
    'AnyConnect for Mobile             : Disabled       perpetual',
    'AnyConnect for Cisco VPN Phone    : Disabled       perpetual',
    'Advanced Endpoint Assessment      : Disabled       perpetual',
    'Shared License                    : Disabled       perpetual',
    'Total TLS Proxy Sessions          : 1000           perpetual',
    'Botnet Traffic Filter             : Disabled       perpetual',
    'Cluster                           : Disabled       perpetual',
    '',
    'This platform has an ASAv VMware license.', // [unverified, from memory]
    '',
    `Serial Number: ${d.serial}`,
    'Running Permanent Activation Key: 0x2b2bd24d 0xa82c8b5c 0xa5a4a1c8 0x83e47c40 0x0f3a5d6e ',
    'Configuration register is 0x1',
    'Image type          : Release',
    'Key Version         : A',
    '',
    `Configuration last modified by ${lc?.by ?? 'enable_15'} at ${asaClock(lc?.t ?? d.bootedAt + 3600_000)}`,
    ''
  ].join('\n')
}

// ---------------------------------------------------------------- interfaces

function status(i: Iface): [string, string] {
  if (!i.adminUp) return ['administratively down', 'down']
  return isUp(i) ? ['up', 'up'] : ['down', 'down']
}

export function showIntIpBrief(d: Device): string {
  return [
    'Interface                  IP-Address      OK? Method Status                Protocol',
    ...d.interfaces.map((i) => {
      const [st, pr] = status(i)
      return `${pad(i.name, 27)}${pad(i.ip ?? 'unassigned', 16)}YES ${pad(i.ip ? 'CONFIG' : 'unset', 7)}${pad(st, 22)}${pr}`
    })
  ].join('\n')
}

export function showNameif(d: Device): string {
  return ['Interface                Name                     Security', ...d.interfaces.filter((i) => i.zone).map((i) => `${pad(i.name, 25)}${pad(i.zone!, 25)}${lpad(levelOf(d, i) ?? 0, 3)}`)].join('\n')
}

export function showInterface(d: Device, i: Iface): string {
  const [st, pr] = status(i)
  const c = ifaceCounters(d, i)
  const up = isUp(i)
  const dup = resolvedDuplex(i) === 'half' ? 'Half-duplex' : 'Full-duplex'
  const l = [`Interface ${i.name} "${i.zone ?? ''}", is ${i.errDisabled ? 'down' : st}, line protocol is ${pr}`]
  l.push(`  Hardware is Accelerator rev01, BW ${i.speed === '1000' ? '1000 Mbps' : `${i.speed} Mbps`}, DLY 10 usec`)
  l.push(`\t${i.duplex && i.duplex !== 'auto' ? dup : `Auto-Duplex(${up ? dup : 'Full-duplex'})`}, ${i.speedSet && i.speedSet !== 'auto' ? `${i.speedSet} Mbps` : `Auto-Speed(${i.speed} Mbps)`}`)
  l.push('\tInput flow control is unsupported, output flow control is off')
  if (i.description !== undefined) l.push(`\tDescription: ${i.description}`)
  l.push(`\tMAC address ${i.mac}, MTU ${i.zone ? (i.mtu ?? 1500) : 'not set'}`)
  l.push(i.ip ? `\tIP address ${i.ip}, subnet mask ${maskToDotted(i.mask!)}` : '\tIP address unassigned')
  l.push(
    `\t${c.inPkts} packets input, ${c.inBytes} bytes, 0 no buffer`,
    `\tReceived ${Math.floor(c.inPkts / 900)} broadcasts, ${c.runts} runts, ${c.giants} giants`,
    `\t${c.inErrors} input errors, ${c.crc} CRC, ${c.frame} frame, ${c.overrun} overrun, ${c.ignored} ignored, 0 abort`,
    '\t0 pause input, 0 resume input',
    '\t0 L2 decode drops',
    `\t${c.outPkts} packets output, ${c.outBytes} bytes, 0 underruns`,
    '\t0 pause output, 0 resume output',
    `\t${c.outErrors} output errors, ${c.collisions} collisions, ${c.resets} interface resets`,
    `\t${c.lateCollisions} late collisions, ${c.deferred} deferred`,
    '\t0 input reset drops, 0 output reset drops',
    '\tinput queue (blocks free curr/low): hardware (0/0)',
    '\toutput queue (blocks free curr/low): hardware (0/0)'
  )
  if (i.zone) l.push('  Traffic Statistics for "' + i.zone + '":', `\t${c.inPkts} packets input, ${c.inBytes} bytes`, `\t${c.outPkts} packets output, ${c.outBytes} bytes`, '\t0 packets dropped')
  return l.join('\n')
}

// ---------------------------------------------------------------- routing

export interface AsaRoute {
  code: string
  prefix: string
  mask: number
  via?: string
  iface: string
  ad?: number
}

/** Interface a next hop is connected through (up, nameif'd). */
export function egressFor(d: Device, ip: string): Iface | undefined {
  return d.interfaces.filter((i) => i.zone && i.ip && isUp(i) && i.mask! < 32 && inSubnet(ip, i.ip, i.mask!)).sort((a, b) => b.mask! - a.mask!)[0]
}

export function asaRib(d: Device): AsaRoute[] {
  const out: AsaRoute[] = []
  for (const i of d.interfaces) {
    if (!i.zone || !i.ip || !isUp(i)) continue
    out.push({ code: 'C', prefix: network(i.ip, i.mask!), mask: i.mask!, iface: i.zone })
    out.push({ code: 'L', prefix: i.ip, mask: 32, iface: i.zone })
  }
  for (const r of d.staticRoutes) {
    const e = egressFor(d, r.nextHop)
    if (!e) continue
    out.push({ code: r.mask === 0 ? 'S*' : 'S', prefix: r.prefix, mask: r.mask, via: r.nextHop, iface: e.zone!, ad: r.ad ?? 1 })
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

export function lookup(d: Device, ip: string): AsaRoute | undefined {
  return asaRib(d)
    .filter((r) => inSubnet(ip, r.prefix, r.mask))
    .sort((a, b) => b.mask - a.mask)[0]
}

export function showRoute(d: Device): string {
  const rib = asaRib(d)
  const def = rib.find((r) => r.mask === 0)
  return [
    '',
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2, V - VPN',
    '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
    '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
    '       o - ODR, P - periodic downloaded static route, + - replicated route',
    '       SI - Static InterVRF, BI - BGP InterVRF',
    def ? `Gateway of last resort is ${def.via} to network 0.0.0.0` : 'Gateway of last resort is not set',
    '',
    ...rib.map((r) => `${pad(r.code, 9)}${r.prefix} ${maskToDotted(r.mask)} ${r.via ? `[${r.ad}/0] via ${r.via}, ${r.iface}` : `is directly connected, ${r.iface}`}`),
    ''
  ].join('\n')
}

export function showArp(d: Device): string {
  return d.arp
    .map((a) => ({ a, i: d.interfaces.find((x) => x.name === a.iface) }))
    .filter((x) => x.i?.zone && isUp(x.i))
    .map(({ a, i }) => `\t${i!.zone} ${a.ip} ${a.mac} ${a.age * 60}`)
    .join('\n')
}

// ---------------------------------------------------------------- ACLs

const PORTS: Record<string, number> = { ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, www: 80, http: 80, pop3: 110, ntp: 123, imap4: 143, snmp: 161, bgp: 179, ldap: 389, https: 443, syslog: 514, ldaps: 636, sqlnet: 1521, 'rdp': 3389 }
const ICMP: Record<string, number> = { 'echo-reply': 0, unreachable: 3, echo: 8, 'time-exceeded': 11 }

const portNum = (s: string): number => (/^\d+$/.test(s) ? Number(s) : (PORTS[s] ?? -1))

interface AddrMatch {
  test: (ip: string) => boolean
}
interface PortMatch {
  test: (p: number) => boolean
}

function parseAddr(t: string[], i: number): [AddrMatch, number] | undefined {
  const w = t[i]
  if (w === 'any' || w === 'any4') return [{ test: () => true }, i + 1]
  if (w === 'host' && t[i + 1] && isIpv4(t[i + 1]!)) return [{ test: (ip) => ip === t[i + 1] }, i + 2]
  if (w && isIpv4(w) && t[i + 1] && isIpv4(t[i + 1]!)) {
    const len = t[i + 1]!.split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0)
    return [{ test: (ip) => inSubnet(ip, w, len) }, i + 2]
  }
  return undefined
}

function parsePort(t: string[], i: number): [PortMatch | undefined, number] {
  const op = t[i]
  if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt') {
    const n = portNum(t[i + 1] ?? '')
    return [{ test: (p) => (op === 'eq' ? p === n : op === 'neq' ? p !== n : op === 'lt' ? p < n : p > n) }, i + 2]
  }
  if (op === 'range') {
    const a = portNum(t[i + 1] ?? '')
    const b = portNum(t[i + 2] ?? '')
    return [{ test: (p) => p >= a && p <= b }, i + 3]
  }
  return [undefined, i]
}

export interface Flow {
  proto: 'tcp' | 'udp' | 'icmp'
  src: string
  sport: number
  dst: string
  dport: number
}

/** Does an ACE (`tcp any host 1.2.3.4 eq https`) match the flow? */
export function aceMatches(e: AclEntry, f: Flow): boolean {
  if (e.action === 'remark') return false
  const t = e.text.trim().split(/\s+/)
  const proto = t[0]
  if (proto !== 'ip' && proto !== f.proto) return false
  const s = parseAddr(t, 1)
  if (!s) return false
  let i = s[1]
  let sp: PortMatch | undefined
  if (proto !== 'icmp') [sp, i] = parsePort(t, i)
  const dd = parseAddr(t, i)
  if (!dd) return false
  i = dd[1]
  if (!s[0].test(f.src) || !dd[0].test(f.dst)) return false
  if (proto === 'icmp' && t[i] && t[i] !== 'log') {
    const want = /^\d+$/.test(t[i]!) ? Number(t[i]) : ICMP[t[i]!]
    if (want !== undefined && want !== f.sport) return false
  }
  if (proto === 'tcp' || proto === 'udp') {
    const [dp] = parsePort(t, i)
    if (sp && !sp.test(f.sport)) return false
    if (dp && !dp.test(f.dport)) return false
  }
  return true
}

export function showAccessList(d: Device, name?: string): string {
  const list = name ? d.acls.filter((a) => a.name === name) : d.acls
  const out = name ? [] : ['access-list cached ACL log flows: total 0, denied 0 (deny-flow-max 4096)', '            alert-interval 300']
  for (const a of list) {
    const aces = a.entries.filter((e) => e.action !== 'remark')
    out.push(`access-list ${a.name}; ${aces.length} elements; name hash: 0x${hash(a.name)}`)
    a.entries.forEach((e, k) => {
      if (e.action === 'remark') out.push(`access-list ${a.name} line ${k + 1} remark ${e.text}`)
      else out.push(`access-list ${a.name} line ${k + 1} extended ${e.action} ${e.text}${/\blog\b/.test(e.text) ? ' informational interval 300' : ''} (hitcnt=${e.hits ?? 0}) 0x${hash(a.name + e.text)}`)
    })
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- packet-tracer

export interface TraceResult {
  text: string
  allowed: boolean
}

export function packetTracer(d: Device, inName: string, f: Flow): TraceResult {
  const st = asaData(d)
  const inIf = byNameif(d, inName)
  if (!inIf) return { text: `ERROR: interface ${inName} not found`, allowed: false }
  const phases: string[][] = []
  let n = 0
  const phase = (type: string, sub: string, result: 'ALLOW' | 'DROP', config: string[], info: string[] = []): void => {
    n++
    phases.push([`Phase: ${n}`, `Type: ${type}`, `Subtype: ${sub}`, `Result: ${result}`, `Elapsed time: ${[12000, 9000, 5000, 3000, 2000, 1000][(n - 1) % 6]} ns`, 'Config:', ...config, 'Additional Information:', ...info, ''])
  }
  const route = lookup(d, f.dst)
  const outIf = route ? byNameif(d, route.iface) : undefined
  const tail = (action: 'allow' | 'drop', reason?: string): string[] => [
    'Result:',
    `input-interface: ${inName}(vrfid:0)`,
    `input-status: ${inIf.adminUp ? (isUp(inIf) ? 'up' : 'down') : 'down'}`,
    `input-line-status: ${isUp(inIf) ? 'up' : 'down'}`,
    ...(outIf ? [`output-interface: ${outIf.zone}(vrfid:0)`, `output-status: ${isUp(outIf) ? 'up' : 'down'}`, `output-line-status: ${isUp(outIf) ? 'up' : 'down'}`] : []),
    `Action: ${action}`,
    `Time Taken: ${phases.length * 7000} ns`,
    ...(reason ? [`Drop-reason: ${reason}, Drop-location: frame 0x000055d1c8a4b2c1 flow (NA)/NA`] : []),
    ''
  ]
  const done = (allowed: boolean, reason?: string): TraceResult => ({ text: ['', ...phases.flat(), ...tail(allowed ? 'allow' : 'drop', reason)].join('\n'), allowed })
  if (!isUp(inIf)) return done(false, '(interface-down) Input interface is down') // [unverified, from memory]
  phase('ACCESS-LIST', '', 'ALLOW', ['Implicit Rule'], ['MAC Access list'])
  if (!route || !outIf) {
    phase('ROUTE-LOOKUP', '', 'DROP', [], [`No route to host ${f.dst}`])
    return done(false, '(no-route) No route to host')
  }
  phase('ROUTE-LOOKUP', 'No ECMP load balancing', 'ALLOW', [], [`Destination is looked up in routing table`, `Found next-hop ${route.via ?? f.dst} using egress ifc  ${outIf.zone}(vrfid:0)`])
  const grp = st.groups.find((g) => g.iface === inName && g.dir === 'in')
  const acl: Acl | undefined = grp ? d.acls.find((a) => a.name === grp.acl) : undefined
  if (acl) {
    const e = acl.entries.find((x) => aceMatches(x, f))
    const cfg = (x?: AclEntry): string[] => [`access-group ${acl.name} in interface ${inName}`, ...(x ? [`access-list ${acl.name} extended ${x.action} ${x.text} `] : [])]
    if (!e) {
      phase('ACCESS-LIST', '', 'DROP', ['Implicit Rule'])
      return done(false, '(acl-drop) Flow is denied by configured rule')
    }
    e.hits = (e.hits ?? 0) + 1
    if (e.action === 'deny') {
      phase('ACCESS-LIST', 'log', 'DROP', cfg(e))
      return done(false, '(acl-drop) Flow is denied by configured rule')
    }
    phase('ACCESS-LIST', 'log', 'ALLOW', cfg(e))
  } else {
    const a = levelOf(d, inIf) ?? 0
    const b = levelOf(d, outIf) ?? 0
    if (a <= b) {
      phase('ACCESS-LIST', '', 'DROP', ['Implicit Rule'])
      return done(false, '(acl-drop) Flow is denied by configured rule')
    }
    phase('ACCESS-LIST', '', 'ALLOW', ['Implicit Rule'])
  }
  phase('CONN-SETTINGS', '', 'ALLOW', ['class-map class-default', ' match any', 'policy-map global_policy', ' class class-default', '  set connection advanced-options UM_STATIC_TCP_MAP', 'service-policy global_policy global'])
  phase('NAT', 'per-session', 'ALLOW', [])
  phase('IP-OPTIONS', '', 'ALLOW', [])
  if (f.proto !== 'icmp') phase('INSPECT', '', 'ALLOW', ['class-map inspection_default', ' match default-inspection-traffic', 'policy-map global_policy', ' class inspection_default', '  inspect esmtp ', 'service-policy global_policy global'])
  phase('FLOW-CREATION', '', 'ALLOW', [], [`New flow created with id ${8000 + (ipToInt(f.src) % 1000)}, packet dispatched to next module`])
  st.conn.inUse++
  st.conn.most = Math.max(st.conn.most, st.conn.inUse)
  return done(true)
}

// ---------------------------------------------------------------- system

function activeHog(d: Device): Device['cpu']['hog'] {
  return d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
}

export function cpuLoad(d: Device): [number, number, number] {
  const h = activeHog(d)
  const [a, b, c] = d.cpu.load
  return h ? [Math.min(99, a + h.pct), Math.min(99, b + h.pct - 4), Math.min(99, c + h.pct - 9)] : [a, b, c]
}

export function showCpuUsage(d: Device): string {
  const [a, b, c] = cpuLoad(d)
  return `CPU utilization for 5 seconds = ${a}%; 1 minute: ${b}%; 5 minutes: ${c}%`
}

export function showProcessesCpu(d: Device, nonZero: boolean): string {
  const h = activeHog(d)
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: h && h.pid === p.pid ? h.pct : p.pct }))
  if (h && !procs.some((p) => p.pid === h.pid)) procs.push({ pid: h.pid, name: h.name, pct: h.pct })
  procs = procs.sort((x, y) => y.pct - x.pct || x.pid - y.pid)
  if (nonZero) procs = procs.filter((p) => p.pct > 0)
  return [
    `Hardware:   ${d.model}`,
    `Cisco Adaptive Security Appliance Software Version ${d.version} `,
    'ASLR enabled, text region 55d1c6a00000-55d1cb2a6c35',
    'PC         Thread       5Sec     1Min     5Min   Process',
    ...procs.map((p) => `0x${(0x55d1c8a40000 + p.pid * 0x1b3).toString(16).slice(-8)} 0x${(0x7f2a00000000 + p.pid * 0x9f0).toString(16).slice(-8)} ${lpad(`${p.pct.toFixed(1)}%`, 7)}  ${lpad(`${Math.max(0, h && h.pid === p.pid ? p.pct - 4 : p.pct).toFixed(1)}%`, 7)}  ${lpad(`${Math.max(0, h && h.pid === p.pid ? p.pct - 9 : p.pct).toFixed(1)}%`, 7)}   ${p.name}`)
  ].join('\n')
}

export function showLogging(d: Device): string {
  const n = (d.logBase ?? 0) + d.log.length
  return [
    'Syslog logging: enabled',
    '    Facility: 20',
    '    Timestamp logging: enabled',
    '    Hide Username logging: enabled',
    '    Standby logging: disabled',
    '    Debug-trace logging: disabled',
    '    Console logging: disabled',
    '    Monitor logging: disabled',
    `    Buffer logging: level informational, ${n} messages logged`,
    '    Trap logging: level informational, facility 20, 0 messages logged',
    '    Permit-hostdown logging: disabled',
    '    History logging: disabled',
    '    Device ID: disabled',
    '    Mail logging: disabled',
    '    ASDM logging: disabled',
    ...d.log.map((e) => `${asaClock(e.t).replace(/^(\S+) UTC \S+ (\S+) (\d+) (\d+)$/, '$2 $3 $4 $1')}: ${e.msg}`)
  ].join('\n')
}

// ---------------------------------------------------------------- running-config

export function configLines(d: Device): string[] {
  const st = asaData(d)
  const out: string[] = [`ASA Version ${d.version} `, '!', `hostname ${d.hostname}`, 'domain-name lab.example.net', 'enable password ***** pbkdf2', 'names', 'no mac-address auto', '']
  if (d.motd !== undefined) out.splice(3, 0, ...d.motd.split('\n').map((l) => `banner motd ${l}`))
  out.push('!')
  for (const i of d.interfaces) {
    out.push(`interface ${i.name}`)
    if (i.description !== undefined) out.push(` description ${i.description}`)
    if (!i.adminUp) out.push(' shutdown')
    if (i.zone) {
      out.push(` nameif ${i.zone}`, ` security-level ${st.levels[i.zone] ?? 0}`)
      if (i.name.startsWith('Management')) out.splice(out.length - 2, 0, ' management-only')
    } else out.push(' no nameif', ' no security-level')
    out.push(i.ip ? ` ip address ${i.ip} ${maskToDotted(i.mask!)} ` : ' no ip address', '!')
  }
  out.push('ftp mode passive', 'dns server-group DefaultDNS', ' domain-name lab.example.net', 'same-security-traffic permit intra-interface')
  for (const a of d.acls) for (const e of a.entries) out.push(e.action === 'remark' ? `access-list ${a.name} remark ${e.text}` : `access-list ${a.name} extended ${e.action} ${e.text} `)
  out.push('pager lines 24', 'logging enable', 'logging timestamp', 'logging buffered informational')
  for (const i of d.interfaces) if (i.zone) out.push(`mtu ${i.zone} ${i.mtu ?? 1500}`)
  out.push('no failover', 'no failover wait-disable', 'icmp unreachable rate-limit 1 burst-size 1', 'no asdm history enable', 'arp timeout 14400', 'no arp permit-nonconnected', 'arp rate-limit 16384')
  for (const g of st.groups) out.push(`access-group ${g.acl} ${g.dir} interface ${g.iface}`)
  for (const r of d.staticRoutes) {
    const e = egressFor(d, r.nextHop) ?? d.interfaces.find((i) => i.zone && i.ip && i.mask! < 32 && inSubnet(r.nextHop, i.ip, i.mask!))
    out.push(`route ${e?.zone ?? 'outside'} ${r.prefix} ${maskToDotted(r.mask)} ${r.nextHop} ${r.ad ?? 1}`)
  }
  out.push(
    'timeout xlate 3:00:00',
    'timeout conn 1:00:00 half-closed 0:10:00 udp 0:02:00 sctp 0:02:00 icmp 0:00:02',
    'user-identity default-domain LOCAL',
    'aaa authentication ssh console LOCAL',
    'aaa authorization exec LOCAL auto-enable',
    'http server enable',
    'http 192.168.99.0 255.255.255.0 management',
    'ssh stricthostkeycheck',
    'ssh 192.168.99.0 255.255.255.0 management',
    'ssh timeout 30',
    'ssh version 2',
    'ssh key-exchange group dh-group14-sha256',
    'console timeout 0',
    ...d.extraConfig,
    '!',
    'class-map inspection_default',
    ' match default-inspection-traffic',
    '!',
    'policy-map global_policy',
    ' class inspection_default',
    '  inspect dns preset_dns_map ',
    '  inspect esmtp ',
    '  inspect icmp ',
    '!',
    'service-policy global_policy global',
    'prompt hostname context ',
    'username netops password ***** pbkdf2 privilege 15'
  )
  return out
}

export function runningConfig(d: Device, body = configLines(d)): string {
  const text = body.join('\n')
  return [': Saved', '', ':', `: Serial Number: ${d.serial}`, `: Hardware:   ${d.model}, 8192 MB RAM, CPU Xeon 4100/6100/8100 series 2200 MHz, 1 CPU (4 cores)`, ':', ...body, `Cryptochecksum:${hash(text)}${hash(text + 'a')}${hash(text + 'b')}${hash(text + 'c')}`, ': end'].join('\n')
}
