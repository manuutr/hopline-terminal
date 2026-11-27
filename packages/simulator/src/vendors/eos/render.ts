/**
 * EOS show-command renderers (docs/research/cli-arista-eos.md §6). Everything is derived from the
 * model through the state helpers, so scenario fields (errDisabled, peerAs, peerMtu, far-end
 * duplex, trunkAllowed, cpu.hog) show through.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, lpad, macColon, network, pad } from '../../core/text.ts'
import { bgpBlocker, bgpUp, duplexMismatch, ifaceCounters, isUp, neighborState, ospfState, resolvedDuplex, type BgpNeighbor, type Device, type Iface } from '../../state.ts'
import { cpuLoad, liveMacs, trunkVlans } from '../ios/render.ts'
import { sortedIfaces } from './config.ts'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')

/** "Tue Nov 24 11:02:11 2026" */
export function eosDate(t: number): string {
  const d = new Date(t)
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/** Syslog stamp "Nov 24 09:12:44". */
export function logStamp(t: number): string {
  const d = new Date(t)
  return `${MON[d.getUTCMonth()]} ${lpad(d.getUTCDate(), 2)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
}

/** BGP Up/Down: hh:mm:ss under a day, then 17d12h. */
export function eosUpDown(from: number, t: number): string {
  const s = Math.max(0, Math.floor((t - from) / 1000))
  const h = Math.floor(s / 3600)
  if (h < 24) return `${two(h)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
  return `${Math.floor(h / 24)}d${two(h % 24)}h`
}

/** "2 days, 3:11:09 ago" / "0:05:05 ago". */
export function ago(from: number, t: number): string {
  const s = Math.max(0, Math.floor((t - from) / 1000))
  const days = Math.floor(s / 86400)
  const rest = `${Math.floor((s % 86400) / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
  return `${days ? `${days} day${days === 1 ? '' : 's'}, ` : ''}${rest} ago`
}

/** "2 weeks, 3 days, 14 hours and 22 minutes" */
export function eosUptime(from: number, t: number): string {
  const m = Math.max(0, Math.floor((t - from) / 60000))
  const w = Math.floor(m / (7 * 1440))
  const d = Math.floor((m % (7 * 1440)) / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mi = m % 60
  const pl = (n: number, s: string): string => `${n} ${s}${n === 1 ? '' : 's'}`
  return `${w ? `${pl(w, 'week')}, ` : ''}${d || w ? `${pl(d, 'day')}, ` : ''}${pl(h, 'hour')} and ${pl(mi, 'minute')}`
}

const ADDR_MAC = (d: Device): string => (d.vendor['eosSystemMac'] as string | undefined) ?? '2899.3a11.0000'

// ---------------------------------------------------------------- version

const BUILD_ID = '7d8f4a5c-2b1e-4c3a-9f06-1e2d3c4b5a69'

export function showVersion(d: Device): string {
  return [
    `Arista ${d.model}`,
    'Hardware version: 11.01',
    `Serial number: ${d.serial}`,
    `Hardware MAC address: ${ADDR_MAC(d)}`,
    `System MAC address: ${ADDR_MAC(d)}`,
    '',
    `Software image version: ${d.version}`,
    'Architecture: x86_64',
    `Internal build version: ${d.version}-35141176.${d.version.replace(/\./g, '')}`,
    `Internal build ID: ${BUILD_ID}`,
    'Image format version: 3.0',
    'Image optimization: Strata-4GB',
    '',
    'Kernel version: 5.10.209-arista-amd64',
    '',
    `Uptime: ${eosUptime(d.bootedAt, now(d))}`,
    'Total memory: 8099260 kB',
    'Free memory: 5512384 kB'
  ].join('\n')
}

/** Float with one decimal, as eAPI prints timestamps. */
const F = (n: number): string => `__F:${(Math.round(n * 10) / 10).toFixed(1)}`

function json(o: unknown): string {
  return JSON.stringify(o, null, 4).replace(/"__F:([\d.]+)"/g, '$1')
}

export function versionJson(d: Device): string {
  const t = now(d)
  return json({
    mfgName: 'Arista',
    modelName: d.model,
    hardwareRevision: '11.01',
    serialNumber: d.serial,
    systemMacAddress: macColon(ADDR_MAC(d)),
    hwMacAddress: macColon(ADDR_MAC(d)),
    configMacAddress: '00:00:00:00:00:00',
    version: d.version,
    architecture: 'x86_64',
    internalVersion: `${d.version}-35141176.${d.version.replace(/\./g, '')}`,
    internalBuildId: BUILD_ID,
    imageFormatVersion: '3.0',
    imageOptimization: 'Strata-4GB',
    bootupTimestamp: F(d.bootedAt / 1000),
    uptime: F((t - d.bootedAt) / 1000),
    memTotal: 8099260,
    memFree: 5512384,
    isIntlVersion: false
  })
}

// ---------------------------------------------------------------- interfaces

/** Link status word for status tables. */
export function linkStatus(i: Iface): string {
  if (i.errDisabled) return 'errdisabled'
  if (!i.adminUp) return 'disabled'
  return isUp(i) ? 'connected' : 'notconnect'
}

function ipStatus(i: Iface): [string, string] {
  if (!i.adminUp) return ['adminDown', 'down']
  if (i.errDisabled) return ['down', 'errdisabled']
  return isUp(i) ? ['up', 'up'] : ['down', 'lowerlayerdown']
}

const mtuOf = (i: Iface): number => i.mtu ?? (i.name.startsWith('Loopback') ? 65535 : 1500)

export function showIpIntBrief(d: Device, vrf?: string): string {
  const rows = sortedIfaces(d)
    .filter((i) => i.ip && (vrf === undefined || vrf === 'all' || (i.vrf ?? 'default') === vrf))
    .map((i) => {
      const [st, pr] = ipStatus(i)
      return `${pad(i.name, 18)}${pad(`${i.ip}/${i.mask}`, 21)}${pad(st, 13)}${pad(pr, 15)}${lpad(mtuOf(i), 8)}`
    })
  return [
    `${' '.repeat(82)}Address`,
    'Interface         IP Address           Status       Protocol            MTU    Owner',
    '----------------- -------------------- ------------ -------------- ----------- -------',
    ...rows
  ].join('\n')
}

const autoneg = (i: Iface): boolean => i.name.startsWith('Management')

function vlanCol(i: Iface): string {
  if (i.channelGroup !== undefined) return `in Po${i.channelGroup}`
  if (i.mode === 'trunk') return 'trunk'
  if (i.mode === 'routed') return 'routed'
  return String(i.vlan ?? 1)
}

export function showIntStatus(d: Device, filter?: (i: Iface) => boolean): string {
  const rows = sortedIfaces(d)
    .filter((i) => /^(Ethernet|Management|Port-Channel)/.test(i.name) && (!filter || filter(i)))
    .map((i) => {
      const a = autoneg(i) ? 'a-' : ''
      const dx = `${a}${resolvedDuplex(i)}`
      const sp = `${a}${i.speedSet ?? i.speed}`
      return `${pad(i.short, 11)}${pad(i.description ?? '', 20)}${pad(linkStatus(i), 13)}${pad(vlanCol(i), 9)}${pad(dx, 7)}${pad(sp, 7)}${i.media ?? ''}`.trimEnd()
    })
  return ['Port       Name                Status       Vlan     Duplex Speed  Type            Flags Encapsulation', ...rows].join('\n')
}

export function showIntDescription(d: Device): string {
  const rows = sortedIfaces(d).map((i) => {
    const [st, pr] = ipStatus(i)
    return `${pad(i.short, 31)}${pad(st === 'adminDown' ? 'admin down' : st, 15)}${pad(pr, 19)}${i.description ?? ''}`.trimEnd()
  })
  return ['Interface                      Status         Protocol           Description', ...rows].join('\n')
}

const BW: Record<string, number> = { '1G': 1000000, '10G': 10000000, '25G': 25000000, '40G': 40000000, '100G': 100000000 }

export function showInterface(d: Device, i: Iface): string {
  const t = now(d)
  const c = ifaceCounters(d, i, t)
  const st = !i.adminUp ? 'administratively down' : i.errDisabled ? 'down' : isUp(i) ? 'up' : 'down'
  const pr = !i.adminUp ? 'down (disabled)' : i.errDisabled ? 'down (errdisabled)' : isUp(i) ? 'up (connected)' : 'down (notconnect)'
  const l = [`${i.name} is ${st}, line protocol is ${pr}`]
  const virtual = /^(Loopback|Vlan)/.test(i.name)
  l.push(virtual ? `  Hardware is ${i.name.startsWith('Vlan') ? 'Vlan' : 'Loopback'}${i.mac ? `, address is ${i.mac} (bia ${i.mac})` : ''}` : `  Hardware is Ethernet, address is ${i.mac} (bia ${i.mac})`)
  if (i.description !== undefined) l.push(`  Description: ${i.description}`)
  if (i.ip) l.push(`  Internet address is ${i.ip}/${i.mask}`, '  Broadcast address is 255.255.255.255')
  const sp = i.speedSet ?? i.speed
  l.push(`  ${i.ip ? 'IP MTU' : 'Ethernet MTU'} ${mtuOf(i)} bytes${sp ? ` , BW ${BW[sp] ?? 1000000} kbit` : ''}`)
  if (!virtual) {
    l.push(`  ${resolvedDuplex(i) === 'full' ? 'Full' : 'Half'}-duplex, ${sp.replace('G', 'Gb/s')}, auto negotiation: ${autoneg(i) ? 'on' : 'off'}, uni-link: n/a`)
    if (i.errDisabled) l.push(`  Link is errdisabled (${i.errDisabled})`)
  }
  l.push(isUp(i) ? `  Up ${ago(i.lastChange ?? d.bootedAt, t).replace(/ ago$/, '')}` : `  Down ${ago(i.lastChange ?? d.bootedAt, t).replace(/ ago$/, '')}`)
  l.push('  Loopback Mode : None', `  ${2 + (i.lastChange ? 1 : 0)} link status changes since last clear`, `  Last clearing of "show interface" counters ${i.clearedAt ? ago(i.clearedAt, t) : 'never'}`)
  if (!virtual) {
    const mbps = (bps: number): string => `${(bps / 1e6).toFixed(2)} Mbps`
    l.push(
      `  5 minutes input rate ${mbps(c.inBps)} (0.0% with framing overhead), ${c.inPps} packets/sec`,
      `  5 minutes output rate ${mbps(c.outBps)} (0.0% with framing overhead), ${c.outPps} packets/sec`,
      `     ${c.inPkts} packets input, ${c.inBytes} bytes`,
      `     Received ${Math.floor(c.inPkts / 2000)} broadcasts, ${Math.floor(c.inPkts / 300)} multicast`,
      `     ${c.runts} runts, ${c.giants} giants`,
      `     ${c.inErrors} input errors, ${c.crc} CRC, ${c.frame} alignment, 0 symbol, 0 input discards`,
      '     0 PAUSE input',
      `     ${c.outPkts} packets output, ${c.outBytes} bytes`,
      `     Sent ${Math.floor(c.outPkts / 2000)} broadcasts, ${Math.floor(c.outPkts / 300)} multicast`,
      `     ${c.outErrors} output errors, ${c.collisions} collisions`,
      `     ${c.lateCollisions} late collision, ${c.deferred} deferred, 0 output discards`,
      '     0 PAUSE output'
    )
  }
  return l.join('\n')
}

export function showIntCountersErrors(d: Device): string {
  const rows = sortedIfaces(d)
    .filter((i) => i.name.startsWith('Ethernet') || i.name.startsWith('Management'))
    .map((i) => {
      const c = ifaceCounters(d, i)
      return `${pad(i.short, 15)}${lpad(c.crc, 5)}${lpad(c.frame, 7)}${lpad(0, 7)}${lpad(c.inErrors, 6)}${lpad(c.runts, 7)}${lpad(c.giants, 7)}${lpad(c.outErrors + c.lateCollisions, 7)}`
    })
  return ['Port            FCS  Align Symbol    Rx  Runts Giants     Tx', ...rows].join('\n')
}

export function showIntTrunk(d: Device): string {
  const trunks = sortedIfaces(d).filter((i) => i.mode === 'trunk')
  const comp = (v: number[]): string => (v.length ? compressVlans(v) : 'none')
  return [
    'Port          Mode         Status       Native vlan',
    '---------     ----------   ----------   -----------',
    ...trunks.map((i) => `${pad(i.short, 14)}${pad('trunk', 13)}${pad(isUp(i) ? 'trunking' : 'not-trunking', 13)}${i.nativeVlan ?? 1}`),
    '',
    'Port          Vlans allowed',
    '---------     -------------',
    ...trunks.map((i) => `${pad(i.short, 14)}${i.trunkAllowed ? comp(i.trunkAllowed) : 'All'}`),
    '',
    'Port          Vlans allowed and active in management domain',
    '---------     ---------------------------------------------',
    ...trunks.map((i) => `${pad(i.short, 14)}${comp(trunkVlans(d, i))}`)
  ].join('\n')
}

function compressVlans(v: number[]): string {
  const s = [...new Set(v)].sort((a, b) => a - b)
  const out: string[] = []
  for (let k = 0; k < s.length; ) {
    let j = k
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++
    out.push(j > k ? `${s[k]}-${s[j]}` : String(s[k]))
    k = j + 1
  }
  return out.join(',')
}

// ---------------------------------------------------------------- BGP

function stateWord(d: Device, n: BgpNeighbor, t: number): string {
  if (bgpUp(n, t)) return 'Estab'
  const s = neighborState(d, n, t)
  return s === 'Idle (Admin)' ? 'Idle(Admin)' : s
}

export function showBgpSummary(d: Device, vrf = 'default'): string {
  const t = now(d)
  const peers = d.bgp.filter((n) => (n.vrf ?? 'default') === vrf || vrf === 'all')
  const desc = peers.some((n) => n.description !== undefined)
  const rows = peers.map((n) => {
    const up = bgpUp(n, t)
    const ud = up ? eosUpDown(n.upSince!, t) : n.downSince !== undefined ? eosUpDown(n.downSince, t) : 'never'
    const pre = desc ? pad(n.description ?? '', 25) : ''
    const rcvd = up ? (n.msgRcvd ?? 0) : 0
    const sent = up ? (n.msgSent ?? 0) : 0
    return `  ${pre}${pad(n.ip, 17)}4 ${pad(n.remoteAs, 11)}${lpad(rcvd, 9)}${lpad(sent, 10)}${lpad(0, 5)}${lpad(0, 5)}${lpad(ud, 9)} ${pad(stateWord(d, n, t), 8)}${up ? `${pad(n.prefixes, 7)}${n.prefixes}` : ''}`.trimEnd()
  })
  return [
    `BGP summary information for VRF ${vrf}`,
    `Router identifier ${d.routerId}, local AS number ${d.localAs}`,
    'Neighbor Status Codes: m - Under maintenance',
    `  ${desc ? 'Description              ' : ''}Neighbor         V AS           MsgRcvd   MsgSent  InQ OutQ  Up/Down State   PfxRcd PfxAcc`,
    ...rows
  ].join('\n')
}

export function bgpSummaryJson(d: Device): string {
  const t = now(d)
  const peers: Record<string, unknown> = {}
  for (const n of d.bgp) {
    const up = bgpUp(n, t)
    peers[n.ip] = { description: n.description ?? '', version: 4, msgReceived: up ? (n.msgRcvd ?? 0) : 0, msgSent: up ? (n.msgSent ?? 0) : 0, inMsgQueue: 0, outMsgQueue: 0, asn: String(n.remoteAs), prefixAccepted: up ? n.prefixes : 0, prefixReceived: up ? n.prefixes : 0, upDownTime: F(((up ? n.upSince : n.downSince) ?? d.bootedAt) / 1000), underMaintenance: false, peerState: up ? 'Established' : neighborState(d, n, t).replace('Idle (Admin)', 'Idle') }
  }
  return json({ vrfs: { default: { routerId: d.routerId, peers, vrf: 'default', asn: String(d.localAs) } } })
}

export function showBgpNeighbors(d: Device, ip?: string, sub?: string): string {
  const t = now(d)
  const list = ip ? d.bgp.filter((n) => n.ip === ip) : d.bgp
  if (ip && !list.length) return `% No such neighbor ${ip}`
  if (sub) {
    const n = list[0]!
    const routes = bgpUp(n, t) ? (n.routes ?? []) : []
    if (sub === 'advertised-routes') return bgpTable(d, d.interfaces.filter((i) => i.ip && !i.vrf && i.name.startsWith('Loopback')).map((i) => ({ prefix: i.ip!, mask: i.mask!, nh: '-', path: 'i' })))
    return bgpTable(d, routes.map((r) => ({ prefix: r.prefix, mask: r.mask, nh: n.ip, path: `${n.remoteAs} i` })))
  }
  return list
    .map((n) => {
      const up = bgpUp(n, t)
      const st = up ? 'Established' : neighborState(d, n, t).replace('Idle (Admin)', 'Idle')
      const ext = n.remoteAs !== d.localAs
      const lines = [`BGP neighbor is ${n.ip}, remote AS ${n.remoteAs}, ${ext ? 'external' : 'internal'} link`]
      if (n.description !== undefined) lines.push(`  Description: ${n.description}`)
      lines.push(`  BGP version 4, remote router ID ${up ? (n.routerId ?? '0.0.0.0') : '0.0.0.0'}, VRF ${n.vrf ?? 'default'}`)
      if (up) lines.push('  Negotiated BGP version 4')
      lines.push('  Last read 00:00:12, last write 00:00:05', '  Hold time is 180, keepalive interval is 60 seconds', '  Configured hold time is 180, keepalive interval is 60 seconds', '  Connect timer is inactive')
      lines.push(up ? `  BGP state is Established, up for ${eosUpDown(n.upSince!, t)}` : `  BGP state is ${st}, down for ${eosUpDown(n.downSince ?? d.bootedAt, t)}`)
      if (n.shutdown) lines.push('  Peer is administratively shut down')
      lines.push(`  Number of transitions to established: ${up ? 1 : 0}`, `  Last state was ${up ? 'OpenConfirm' : 'Established'}`, `  Last event was ${up ? 'RecvKeepAlive' : 'Stop'}`)
      if (bgpBlocker(d, n) === 'wrong-as') lines.push(`  Last rcvd notification:OPEN Message Error/bad peer AS, Last time ${eosUpDown(n.downSince ?? t, t)}`, `  Peer reported AS ${n.peerAs}, configured remote AS ${n.remoteAs}`)
      else if (!up && n.downSince !== undefined) lines.push(`  Last sent notification:Cease/other configuration change, Last time ${eosUpDown(n.downSince, t)}`)
      lines.push(
        '  Message Statistics:',
        '                                  Sent      Rcvd',
        `    Opens:                           ${lpad(up ? 1 : 0, 5)}     ${lpad(up ? 1 : 0, 5)}`,
        `    Updates:                         ${lpad(up ? 4 : 0, 5)}     ${lpad(up ? n.prefixes : 0, 5)}`,
        `    Keepalives:                      ${lpad(up ? (n.msgSent ?? 0) - 5 : 0, 5)}     ${lpad(up ? (n.msgRcvd ?? 0) - n.prefixes - 1 : 0, 5)}`,
        '  Prefix Statistics:',
        '                                   Sent      Rcvd',
        `    IPv4 Unicast:                  ${lpad(up ? 1 : 0, 5)}     ${lpad(up ? n.prefixes : 0, 5)}`,
        `  Inbound route map is ${n.routeMapIn ?? 'not set'}`,
        `  Outbound route map is ${n.routeMapOut ?? 'not set'}`,
        `Local AS is ${d.localAs}, local router ID ${d.routerId}`,
        `Local TCP address is ${d.interfaces.find((i) => i.name === n.via)?.ip ?? '0.0.0.0'}, local port is ${up ? 179 : 0}`,
        `Remote TCP address is ${n.ip}, remote port is ${up ? 51432 : 0}`
      )
      return lines.join('\n')
    })
    .join('\n\n')
}

function bgpTable(d: Device, rows: { prefix: string; mask: number; nh: string; path: string }[]): string {
  return [
    `BGP routing table information for VRF default`,
    `Router identifier ${d.routerId}, local AS number ${d.localAs}`,
    'Route status codes: s - suppressed, * - valid, > - active, E - ECMP head, e - ECMP',
    '                    S - Stale, c - Contributing to ECMP, b - backup, L - labeled-unicast',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    'RPKI Origin Validation codes: V - valid, I - invalid, U - unknown',
    'AS Path Attributes: Or-ID - Originator ID, C-LST - Cluster List, LL Nexthop - Link Local Nexthop',
    '',
    '          Network                Next Hop              Metric  AIGP       LocPref Weight  Path',
    ...rows.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask).map((r) => ` * >      ${pad(`${r.prefix}/${r.mask}`, 23)}${pad(r.nh, 22)}${pad(0, 8)}${pad('-', 11)}${pad(100, 8)}${pad(r.nh === '-' ? 32768 : 0, 8)}${r.path}`)
  ].join('\n')
}

export function showIpBgp(d: Device): string {
  const t = now(d)
  const rows: { prefix: string; mask: number; nh: string; path: string }[] = []
  for (const i of d.interfaces) if (i.ip && !i.vrf && i.name.startsWith('Loopback') && isUp(i)) rows.push({ prefix: i.ip, mask: i.mask!, nh: '-', path: 'i' })
  for (const n of d.bgp) if (bgpUp(n, t)) for (const r of n.routes ?? []) rows.push({ prefix: r.prefix, mask: r.mask, nh: n.ip, path: `${n.remoteAs} i` })
  return bgpTable(d, rows)
}

// ---------------------------------------------------------------- routing

export interface EosRoute {
  code: string
  prefix: string
  mask: number
  text: string
}

export function eosRib(d: Device, vrf?: string): EosRoute[] {
  const t = now(d)
  const inVrf = (i: Iface): boolean => (vrf && vrf !== 'default' ? i.vrf === vrf : !i.vrf)
  const ifs = d.interfaces.filter((i) => inVrf(i) && i.ip && i.mask !== undefined && isUp(i))
  const out: EosRoute[] = []
  const add = (r: EosRoute): void => {
    if (!out.some((o) => o.prefix === r.prefix && o.mask === r.mask)) out.push(r)
  }
  for (const i of ifs) add({ code: 'C', prefix: network(i.ip!, i.mask!), mask: i.mask!, text: `is directly connected, ${i.name}` })
  const egress = (nh: string): Iface | undefined => ifs.find((i) => i.mask! < 32 && inSubnet(nh, i.ip!, i.mask!))
  for (const r of d.staticRoutes) {
    if ((r.vrf ?? undefined) !== (vrf && vrf !== 'default' ? vrf : undefined)) continue
    const e = egress(r.nextHop)
    if (!e && !/^null0$/i.test(r.nextHop)) continue
    add({ code: 'S', prefix: r.prefix, mask: r.mask, text: `[${r.ad ?? 1}/0] via ${r.nextHop}, ${e?.name ?? 'Null0'}` })
  }
  if (!vrf || vrf === 'default') {
    for (const n of d.ospf?.neighbors ?? []) {
      if (ospfState(d, n) !== 'FULL') continue
      const routes = (d.vendor['ospfRoutes'] as { prefix: string; mask: number; via: string }[] | undefined)?.filter((r) => r.via === n.ip) ?? []
      for (const r of routes) add({ code: 'O', prefix: r.prefix, mask: r.mask, text: `[110/20] via ${n.ip}, ${n.iface}` })
    }
    for (const n of d.bgp) {
      if (n.vrf || !bgpUp(n, t)) continue
      for (const r of n.routes ?? []) add({ code: n.remoteAs === d.localAs ? 'B I' : 'B E', prefix: r.prefix, mask: r.mask, text: `[200/0] via ${n.ip}, ${n.via}` })
    }
  }
  return out.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

const CODES = [
  'Codes: C - connected, S - static, K - kernel,',
  '       O - OSPF, IA - OSPF inter area, E1 - OSPF external type 1,',
  '       E2 - OSPF external type 2, N1 - OSPF NSSA external type 1,',
  '       N2 - OSPF NSSA external type2, B - Other BGP Routes,',
  '       B I - iBGP, B E - eBGP, R - RIP, I L1 - IS-IS level 1,',
  '       I L2 - IS-IS level 2, O3 - OSPFv3, A B - BGP Aggregate,',
  '       A O - OSPF Summary, NG - Nexthop Group Static Route,',
  '       V - VXLAN Control Service, M - Martian,',
  '       DH - DHCP client installed default route,',
  '       DP - Dynamic Policy Route, L - VRF Leaked,',
  '       G  - gRIBI, RC - Route Cache Route'
]

export function showIpRoute(d: Device, vrf = 'default', target?: string): string {
  if (vrf !== 'default' && !d.vrfs.some((v) => v.name === vrf)) return `% IP Routing table for VRF ${vrf} does not exist.`
  let routes = eosRib(d, vrf)
  const row = (r: EosRoute): string => ` ${pad(r.code, 8)} ${r.prefix}/${r.mask} ${r.text}`
  const head = ['', `VRF: ${vrf}`, ...CODES, '']
  if (target) {
    const [ip, len] = target.split('/')
    routes = len !== undefined ? routes.filter((r) => r.prefix === network(ip!, Number(len)) && r.mask === Number(len)) : routes.filter((r) => inSubnet(ip!, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask).slice(0, 1)
    return [...head, ...routes.map(row), ''].join('\n')
  }
  const def = routes.find((r) => r.mask === 0)
  const routing = vrf === 'default' ? d.services['ip-routing'] !== false : false
  return [
    ...head,
    ...(def ? ['Gateway of last resort:', row(def)] : ['Gateway of last resort is not set']),
    '',
    ...routes.filter((r) => r.mask !== 0).map(row),
    ...(routing ? [] : ['', '! IP routing not enabled']),
    ''
  ].join('\n')
}

export function routeSummary(d: Device): string {
  const r = eosRib(d)
  const n = (c: string): number => r.filter((x) => x.code === c).length
  return [
    'VRF: default',
    '   Route Source                                Number Of Routes',
    '------------------------------------- -------------------------',
    `   connected                                                 ${n('C')}`,
    `   static (persistent)                                       ${n('S')}`,
    `   ospf                                                      ${n('O')}`,
    `   bgp                                                       ${n('B E') + n('B I')}`,
    '',
    `   Total Routes                                              ${r.length}`
  ].join('\n')
}

export function showOspfNeighbor(d: Device): string {
  const rows: string[] = []
  for (const n of d.ospf?.neighbors ?? []) {
    const st = ospfState(d, n)
    if (!st) continue
    const role = n.role && n.role !== '-' && st === 'FULL' ? `/${n.role}` : st === '2WAY' ? `/${n.role ?? 'DROTHER'}` : ''
    const dead = `00:00:${31 + ([...n.routerId].reduce((a, c) => a + c.charCodeAt(0), 0) % 9)}`
    rows.push(`${pad(n.routerId, 16)}${pad(d.ospf!.process, 9)}${pad('default', 9)}${pad(n.pri, 4)}${pad(st + role, 23)}${pad(dead, 12)}${pad(n.ip, 16)}${n.iface}`)
  }
  return ['Neighbor ID     Instance VRF      Pri State                  Dead Time   Address         Interface', ...rows].join('\n')
}

export function showOspfIntBrief(d: Device): string {
  const rows = (d.ospf?.ifaces ?? []).map((o) => {
    const i = d.interfaces.find((x) => x.name === o.iface)
    const nbrs = (d.ospf?.neighbors ?? []).filter((n) => n.iface === o.iface && ospfState(d, n))
    const st = !i || !isUp(i) ? 'DOWN' : o.networkType === 'point-to-point' ? 'P2P' : 'DR'
    const area = /\./.test(o.area) ? o.area : `0.0.0.${o.area}`
    return `   ${pad(i?.name ?? o.iface, 16)}${pad(d.ospf!.process, 9)}${pad('default', 9)}${pad(area, 16)}${pad(i?.ip ? `${i.ip}/${i.mask}` : '', 19)}${pad(o.cost ?? 10, 6)}${pad(st, 11)}${nbrs.length}`
  })
  return ['   Interface       Instance VRF      Area            IP Address         Cost  State      Nbrs', ...rows].join('\n')
}

// ---------------------------------------------------------------- L2

export function showMacTable(d: Device, filter?: { kind: 'address' | 'interface' | 'vlan' | 'dynamic' | 'static'; value?: string }): string {
  const t = now(d)
  let rows = liveMacs(d)
  if (filter?.kind === 'address') {
    const want = (filter.value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').padStart(12, '0')
    rows = rows.filter((r) => r.mac.replace(/\./g, '') === want)
  } else if (filter?.kind === 'interface') rows = rows.filter((r) => r.port === filter.value)
  else if (filter?.kind === 'vlan') rows = rows.filter((r) => String(r.vlan) === filter.value)
  else if (filter?.kind === 'dynamic') rows = rows.filter((r) => r.type !== 'STATIC')
  else if (filter?.kind === 'static') rows = rows.filter((r) => r.type === 'STATIC')
  rows = [...rows].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
  const moved = (d.vendor['eosMacMoved'] as Record<string, number> | undefined) ?? {}
  return [
    '          Mac Address Table',
    '------------------------------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports      Moves   Last Move',
    '----    -----------       ----        -----      -----   ---------',
    ...rows.map((r) => (r.type === 'STATIC' ? `${lpad(r.vlan, 4)}    ${pad(r.mac, 18)}${pad('STATIC', 12)}${r.port}` : `${lpad(r.vlan, 4)}    ${pad(r.mac, 18)}${pad('DYNAMIC', 12)}${pad(r.port, 11)}${pad(1, 8)}${ago(moved[r.mac] ?? d.bootedAt, t)}`)),
    `Total Mac Addresses for this criterion: ${rows.length}`,
    '',
    '          Multicast Mac Address Table',
    '------------------------------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       ----        -----',
    'Total Mac Addresses for this criterion: 0'
  ].join('\n')
}

/** Ports where a VLAN is active: access ports in it and trunks carrying it, while up. */
export function vlanPorts(d: Device, id: number): string[] {
  const ports: string[] = []
  if (d.interfaces.some((i) => i.name === `Vlan${id}` && isUp(i))) ports.push('Cpu')
  for (const i of sortedIfaces(d)) {
    if (!isUp(i) || !/^(Ethernet|Port-Channel)/.test(i.name) || i.channelGroup !== undefined) continue
    if (i.mode === 'access' && (i.vlan ?? 1) === id) ports.push(i.short)
    if (i.mode === 'trunk' && trunkVlans(d, i).includes(id)) ports.push(i.short)
  }
  return ports
}

export function showVlan(d: Device, id?: number): string {
  const list = id === undefined ? d.vlans : d.vlans.filter((v) => v.id === id)
  if (id !== undefined && !list.length) return `% VLAN ${id} not found in current VLAN database`
  const rows: string[] = []
  for (const v of list) {
    const ports = vlanPorts(d, v.id)
    const head = `${pad(v.id, 6)}${pad(v.name, 33)}${pad(v.shutdown ? 'suspended' : 'active', 10)}`
    const chunks: string[] = []
    let cur = ''
    for (const p of ports) {
      const next = cur ? `${cur}, ${p}` : p
      if (next.length > 31 && cur) {
        chunks.push(cur + ',')
        cur = p
      } else cur = next
    }
    chunks.push(cur)
    rows.push((head + chunks[0]).trimEnd())
    for (const c of chunks.slice(1)) rows.push(`${' '.repeat(49)}${c}`)
  }
  return ['VLAN  Name                             Status    Ports', '----- -------------------------------- --------- -------------------------------', ...rows].join('\n')
}

export function vlanJson(d: Device): string {
  const vlans: Record<string, unknown> = {}
  for (const v of d.vlans) vlans[String(v.id)] = { name: v.name, dynamic: false, status: v.shutdown ? 'suspended' : 'active', interfaces: Object.fromEntries(vlanPorts(d, v.id).map((p) => [p.replace(/^Et/, 'Ethernet').replace(/^Po/, 'Port-Channel'), { privatePromoted: false, blocked: null }])) }
  return json({ vlans, sourceDetail: '' })
}

export function intStatusJson(d: Device): string {
  const out: Record<string, unknown> = {}
  for (const i of sortedIfaces(d).filter((x) => /^(Ethernet|Management)/.test(x.name))) out[i.name] = { description: i.description ?? '', linkStatus: linkStatus(i), vlanInformation: { interfaceMode: i.mode === 'routed' ? 'routed' : i.mode === 'trunk' ? 'trunk' : 'bridged', ...(i.mode === 'access' ? { vlanId: i.vlan ?? 1 } : {}) }, bandwidth: (BW[i.speed] ?? 1000000) * 1000, duplex: resolvedDuplex(i) === 'full' ? 'duplexFull' : 'duplexHalf', interfaceType: i.media ?? '' }
  return json({ interfaceStatuses: out })
}

export function ipIntBriefJson(d: Device): string {
  const out: Record<string, unknown> = {}
  for (const i of sortedIfaces(d).filter((x) => x.ip)) {
    const [st, pr] = ipStatus(i)
    out[i.name] = { name: i.name, interfaceStatus: st === 'adminDown' ? 'disabled' : st === 'up' ? 'connected' : 'notconnect', lineProtocolStatus: pr === 'lowerlayerdown' ? 'lowerLayerDown' : pr, mtu: mtuOf(i), interfaceAddress: { ipAddr: { address: i.ip, maskLen: i.mask } } }
  }
  return json({ interfaces: out })
}

export function showVrf(d: Device): string {
  const ifs = (vrf?: string): string => sortedIfaces(d).filter((i) => i.ip && i.vrf === vrf).map((i) => i.short).join(', ')
  return [
    '   VRF           Protocols       State         Interfaces',
    '------------- --------------- ---------------- ---------------',
    `   default       IPv4            routing       ${ifs(undefined)}`,
    ...d.vrfs.map((v) => `   ${pad(v.name, 14)}${pad('IPv4', 16)}${pad('no routing', 14)}${ifs(v.name)}`)
  ].join('\n')
}

export function showArp(d: Device, vrf?: string): string {
  const macPort = (mac: string): string | undefined => liveMacs(d).find((m) => m.mac === mac)?.port
  const fullPort = (p: string): string => p.replace(/^Et(\d)/, 'Ethernet$1').replace(/^Po(\d)/, 'Port-Channel$1')
  const block = (v?: string): string[] =>
    d.arp
      .filter((a) => {
        const i = d.interfaces.find((x) => x.name === a.iface)
        return i && isUp(i) && (v === undefined ? !i.vrf : i.vrf === v)
      })
      .map((a) => {
        const s = Math.round(a.age * 60)
        const age = s ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : '0'
        const p = a.iface.startsWith('Vlan') ? macPort(a.mac) : undefined
        return `${pad(a.ip, 16)}${lpad(age, 9)}  ${pad(a.mac, 16)}${a.iface}${p ? `, ${fullPort(p)}` : ''}`
      })
  const head = 'Address         Age (sec)  Hardware Addr   Interface'
  if (vrf === 'all') return [undefined, ...d.vrfs.map((v) => v.name)].map((v) => [`VRF: ${v ?? 'default'}`, head, ...block(v)].join('\n')).join('\n\n')
  return [head, ...block(vrf && vrf !== 'default' ? vrf : undefined)].join('\n')
}

export function showLldp(d: Device, detail: boolean): string {
  const live = d.lldp.filter((n) => !n.noLldp && (() => { const i = d.interfaces.find((x) => x.short === n.local); return !i || isUp(i) })())
  const t = now(d)
  if (detail) {
    return live
      .map((n) => {
        const i = d.interfaces.find((x) => x.short === n.local)
        return [
          `Interface ${i?.name ?? n.local} detected 1 LLDP neighbors:`,
          '',
          `  Neighbor ${(i?.mac ?? '0000.0000.0000')}/${n.port}, age 12 seconds`,
          '  Discovered 2 days, 3:11:40 ago; Last changed 2 days, 3:11:40 ago',
          `  - Chassis ID type: MAC address (4)`,
          `    Chassis ID     : ${i?.mac ?? '0000.0000.0000'}`,
          `  - Port ID type: Interface name (5)`,
          `    Port ID     : "${n.port}"`,
          `  - Time To Live: ${n.holdtime ?? 120} seconds`,
          `  - System Name: "${n.device}"`,
          `  - System Description: "${n.sysDescr ?? ''}"`,
          `  - System Capabilities : ${(n.caps ?? 'R').split(',').map((c) => ({ B: 'Bridge', R: 'Router', T: 'Telephone' })[c.trim()] ?? c).join(', ')}`,
          `    Enabled Capabilities: ${(n.caps ?? 'R').split(',').map((c) => ({ B: 'Bridge', R: 'Router', T: 'Telephone' })[c.trim()] ?? c).join(', ')}`,
          ...(n.ip ? [`  - Management Address Subtype: IPv4 (1)`, `    Management Address        : ${n.ip}`] : [])
        ].join('\n')
      })
      .join('\n\n')
  }
  const st = (d.vendor['eosLldpStats'] as { changed: number; inserts: number; deletes: number; drops: number; ageouts: number } | undefined) ?? { changed: d.bootedAt, inserts: live.length, deletes: 0, drops: 0, ageouts: 0 }
  return [
    `Last table change time   : ${ago(st.changed, t)}`,
    `Number of table inserts  : ${st.inserts}`,
    `Number of table deletes  : ${st.deletes}`,
    `Number of table drops    : ${st.drops}`,
    `Number of table age-outs : ${st.ageouts}`,
    '',
    'Port          Neighbor Device ID       Neighbor Port ID    TTL',
    '---------- ------------------------ ---------------------- ---',
    ...live.map((n) => `${pad(n.local, 14)}${pad(n.device, 25)}${pad(n.port, 20)}${n.holdtime ?? 120}`)
  ].join('\n')
}

export function lldpJson(d: Device): string {
  return json({ lldpNeighbors: d.lldp.filter((n) => !n.noLldp).map((n) => ({ port: n.local.replace(/^Et/, 'Ethernet'), neighborDevice: n.device, neighborPort: n.port, ttl: n.holdtime ?? 120 })) })
}

// ---------------------------------------------------------------- system

const FACILITIES = ['aaa', 'accounting', 'acl', 'agent', 'bfd', 'bgp', 'eth', 'extension', 'fhrp', 'fru', 'intf', 'ip', 'lacp', 'lag', 'lldp', 'mlag', 'ospf', 'process', 'routing', 'spantree', 'sys', 'vlan', 'vxlan']

export function showLogging(d: Device, last?: number): string {
  const lines = d.log.map((e) => `${logStamp(e.t)} ${d.hostname} ${e.msg}`)
  if (last !== undefined) return lines.slice(-last).join('\n')
  return [
    'Syslog logging: enabled',
    'Buffer logging: level debugging',
    'Console logging: level errors',
    'Persistent logging: disabled',
    'Monitor logging: level errors',
    'Synchronous logging: disabled',
    'Trap logging: level informational',
    "    Logging to '10.255.255.50' port 514 in VRF MGMT via udp",
    'Sequence numbers: disabled',
    'Syslog facility: local7',
    'Hostname format: Hostname only',
    'Repeat logging interval: disabled',
    'Repeat messages: disabled',
    'Root login logging: disabled',
    '',
    'External configuration:',
    '    active:',
    '    inactive:',
    '',
    'Facility                   Severity            Effective Severity',
    '--------------------       -------------       ------------------',
    ...FACILITIES.map((f) => `${pad(f, 27)}${pad('debugging', 20)}debugging`),
    '',
    'Log Buffer:',
    ...lines
  ].join('\n')
}

export function showProcessesTop(d: Device): string {
  const t = now(d)
  const [five] = cpuLoad(d)
  const hog = d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  procs = procs.sort((a, b) => b.pct - a.pct || a.pid - b.pid)
  const up = Math.floor((t - d.bootedAt) / 60000)
  const dt = new Date(t)
  const la = (five / 100 * 4).toFixed(2)
  const us = Math.max(0, five - 1).toFixed(1)
  return [
    `top - ${two(dt.getUTCHours())}:${two(dt.getUTCMinutes())}:${two(dt.getUTCSeconds())} up ${Math.floor(up / 1440)} days, ${two(Math.floor((up % 1440) / 60))}:${two(up % 60)},  1 user,  load average: ${la}, ${la}, ${la}`,
    `Tasks: 312 total,   1 running, 311 sleeping,   0 stopped,   0 zombie`,
    `%Cpu(s): ${lpad(us, 4)} us,  0.9 sy,  0.0 ni, ${lpad((100 - five).toFixed(1), 4)} id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st`,
    'KiB Mem:   8099260 total,  2586876 used,  5512384 free,   245100 buffers',
    'KiB Swap:        0 total,        0 used,        0 free.  1945960 cached Mem',
    '',
    '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND',
    ...procs.map((p) => `${lpad(p.pid, 5)} root      20   0 ${lpad('612m', 7)} ${lpad('302m', 6)} ${lpad('151m', 6)} ${p.pct > 50 ? 'R' : 'S'} ${lpad(p.pct.toFixed(1), 5)}  3.8 ${lpad(`${Math.floor(p.pct * 9 + p.pid / 100)}:${two(p.pid % 60)}.31`, 9)} ${p.name}`)
  ].join('\n')
}

export function showAccessLists(d: Device, name?: string): string {
  const list = name ? d.acls.filter((a) => a.name === name) : d.acls
  return list.map((a) => [`IP Access List ${a.name}${a.type === 'standard' ? ' (standard)' : ''}`, ...a.entries.map((e) => `        ${e.seq} ${e.action} ${e.text}${e.hits ? ` [match ${e.hits} packets, 0:00:12 ago]` : ''}`)].join('\n')).join('\n\n')
}

export function showRouteMap(d: Device, name?: string): string {
  const list = name ? d.routeMaps.filter((r) => r.name === name) : d.routeMaps
  return list
    .flatMap((r) => r.entries.map((e) => [`route-map ${r.name} ${e.action} ${e.seq}`, '  Description:', '  Match clauses:', ...e.match.map((m) => `    match ${m}`), '  SubRouteMap:', '  Set clauses:', ...e.set.map((s) => `    set ${s}`)].join('\n')))
    .join('\n')
}

export function showPrefixList(d: Device, name?: string): string {
  const list = name ? d.prefixLists.filter((p) => p.name === name) : d.prefixLists
  return list.map((p) => [`ip prefix-list ${p.name}`, ...p.entries.map((e) => `      seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`)].join('\n')).join('\n')
}

export function showClock(d: Device): string {
  return `${eosDate(now(d))}\nTimezone: UTC\nClock source: NTP server (10.255.255.50)`
}

export function showUptime(d: Device): string {
  return showProcessesTop(d).split('\n')[0]!.replace(/^top - /, ' ')
}

export function showInventory(d: Device): string {
  return [
    'System information',
    '  Model                    Description',
    '  ------------------------ ----------------------------------------------------',
    `  ${pad(d.model, 25)}48x25GbE (SFP28) & 8x100GbE (QSFP100) switch`,
    '',
    '  HW Version  Serial Number  Mfg Date   Epoch',
    '  ----------- -------------- ---------- -----',
    `  11.01       ${pad(d.serial, 15)}2025-06-11 01.00`
  ].join('\n')
}

export { duplexMismatch }
