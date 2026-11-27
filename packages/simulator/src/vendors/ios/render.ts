/**
 * IOS-XE show-command renderers. Column layouts follow docs/research/cli-cisco-ios.md §6
 * (ntc-templates captures where the doc says byte-exact).
 */
import { now } from '../../core/runtime.ts'
import { classful, cmpIp, inSubnet, lpad, network, pad } from '../../core/text.ts'
import { maskToDotted } from '../../core/tree.ts'
import { IOS_TYPES, shortName } from '../../core/ifname.ts'
import {
  bgpUp,
  duplexMismatch,
  ifaceCounters,
  isUp,
  neighborState,
  ospfState,
  resolvedDuplex,
  uptime,
  uptimeLong,
  type Device,
  type Iface
} from '../../state.ts'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')

/** "11:02:11 UTC Tue Nov 24 2026" */
export function ciscoDate(t: number): string {
  const d = new Date(t)
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC ${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`
}

/** Syslog stamp "Nov 24 11:02:11.418". */
export function logStamp(t: number): string {
  const d = new Date(t)
  return `${MON[d.getUTCMonth()]} ${lpad(d.getUTCDate(), 2)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`
}

const inDefaultVrf = (i: Iface): boolean => !i.vrf

function ifStatus(i: Iface): [string, string] {
  if (!i.adminUp) return ['administratively down', 'down']
  return isUp(i) ? ['up', 'up'] : ['down', 'down']
}

// ---------------------------------------------------------------- version

const GPL = `licensed under the GNU General Public License ("GPL") Version 2.0.  The
software code licensed under GPL Version 2.0 is free software that comes
with ABSOLUTELY NO WARRANTY.  You can redistribute and/or modify such
GPL code under the terms of GPL Version 2.0.  For more details, see the
documentation or "License Notice" file accompanying the IOS-XE software,
or the applicable URL provided on the flyer accompanying the IOS-XE
software.
`

const CRYPTO_LICENSE = `

This product contains cryptographic features and is subject to United
States and local country laws governing import, export, transfer and
use. Delivery of Cisco cryptographic products does not imply
third-party authority to import, export, distribute or use encryption.
Importers, exporters, distributors and users are responsible for
compliance with U.S. and local country laws. By using this product you
agree to comply with applicable laws and regulations. If you are unable
to comply with U.S. and local laws, return this product immediately.

A summary of U.S. laws governing Cisco cryptographic products may be found at:
http://www.cisco.com/wwl/export/crypto/tool/stqrg.html

If you require further assistance please contact us by sending email to
export@cisco.com.


Technology Package License Information:\x20

------------------------------------------------------------------------------
Technology-package                                     Technology-package
Current                        Type                       Next reboot\x20\x20
------------------------------------------------------------------------------
network-advantage       Smart License                    network-advantage\x20\x20\x20
dna-advantage           Subscription Smart License       dna-advantage\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
AIR License Level: AIR DNA Advantage
Next reload AIR license Level: AIR DNA Advantage


Smart Licensing Status: Registration Not Applicable/Not Applicable
`

const hw = (d: Device): string => `
Base Ethernet MAC Address          : 00:a3:d1:4f:01:00
Motherboard Assembly Number        : 73-17952-06
Motherboard Serial Number          : FOC22301ABC
Model Revision Number              : B0
Motherboard Revision Number        : A0
Model Number                       : ${d.model}
System Serial Number               : ${d.serial}
`

export function showVersion(d: Device): string {
  const t = now(d)
  const [maj, min, rest] = d.version.split('.')
  const padded = `${maj}.${two(Number(min))}.${String(rest).replace(/^(\d+)/, (n) => two(Number(n)))}`
  const gig = d.interfaces.filter((i) => i.name.startsWith('Gigabit')).length
  const boot = new Date(d.bootedAt)
  const reloadAt = d.bootedAt - 381_000
  // The legal notices, license table and board IDs make show version ~85 lines; real IOS pages it.
  // The lab default leaves them out so it fits one screen (Hopline's e2e expects the prompt after
  // it); `d.vendor.showVersionFull` restores the doc's full layout (the golden test sets it).
  const full = d.vendor['showVersionFull'] === true
  const text = `Cisco IOS XE Software, Version ${padded}
Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version ${d.version}, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2023 by Cisco Systems, Inc.
Compiled Fri 20-Oct-23 10:44 by mcpre


Cisco IOS-XE software, Copyright (c) 2005-2023 by cisco Systems, Inc.
All rights reserved.  Certain components of Cisco IOS-XE software are
${full ? GPL : ''}

ROM: IOS-XE ROMMON
BOOTLDR: System Bootstrap, Version 17.9.1r[FC2], RELEASE SOFTWARE (P)

${d.hostname} uptime is ${uptimeLong(d.bootedAt, t)}
Uptime for this control processor is ${uptimeLong(d.bootedAt - 180_000, t)}
System returned to ROM by Reload Command at ${ciscoDate(reloadAt)}
System restarted at ${ciscoDate(boot.getTime())}
System image file is "flash:packages.conf"
Last reload reason: Reload Command

${full ? CRYPTO_LICENSE : ''}
cisco ${d.model} (X86) processor with 1331521K/6147K bytes of memory.
Processor board ID ${d.serial}
1 Virtual Ethernet interface
${gig > 1 ? 56 : gig} Gigabit Ethernet interfaces
8 Ten Gigabit Ethernet interfaces
2048K bytes of non-volatile configuration memory.
8388608K bytes of physical memory.
1638400K bytes of Crash Files at crashinfo:.
11264000K bytes of Flash at flash:.
0K bytes of WebUI ODM Files at webui:.
${full ? hw(d) : ''}

Switch Ports Model              SW Version        SW Image              Mode\x20\x20\x20
------ ----- -----              ----------        ----------            ----\x20\x20\x20
*    1 65    ${pad(d.model, 18)} ${pad(padded, 17)} CAT9K_IOSXE           INSTALL


Configuration register is 0x102
`
  return full ? text : text.replace(/\n{3,}/g, '\n\n')
}

// ---------------------------------------------------------------- interfaces

export function showIpIntBrief(d: Device): string {
  const rows = d.interfaces.map((i) => {
    const [st, pr] = ifStatus(i)
    return `${pad(i.name, 23)}${pad(i.ip ?? 'unassigned', 16)}YES ${pad(i.ipMethod ?? (i.ip ? 'NVRAM' : 'unset'), 7)}${pad(st, 22)}${pr}`
  })
  return ['Interface              IP-Address      OK? Method Status                Protocol', ...rows].join('\n')
}

const switchport = (i: Iface): boolean => /^(Gi|Te|Twe|Fo|Hu|Fa|Po)\d/.test(i.short) && i.vrf === undefined

function portStatus(i: Iface): string {
  if (i.errDisabled) return 'err-disabled'
  if (!i.adminUp) return 'disabled'
  return i.linkUp ? 'connected' : 'notconnect'
}

export function showIntStatus(d: Device, filter?: 'err-disabled'): string {
  let ports = d.interfaces.filter((i) => switchport(i) || i.short === 'Gi0/0')
  if (filter) {
    ports = ports.filter((i) => i.errDisabled)
    return ['', 'Port      Name               Status       Reason               Err-disabled Vlans', ...ports.map((i) => `${pad(i.short, 10)}${pad((i.description ?? '').slice(0, 18), 19)}${pad('err-disabled', 13)}${i.errDisabled}`)].join('\n')
  }
  const rows = ports.map((i) => {
    const vlan = i.mode === 'trunk' ? 'trunk' : i.mode === 'routed' ? 'routed' : String(i.vlan ?? 1)
    const up = isUp(i)
    const dup = i.duplex && i.duplex !== 'auto' ? i.duplex : up ? `a-${resolvedDuplex(i)}` : 'auto'
    const spd = i.speedSet && i.speedSet !== 'auto' ? i.speedSet : up && i.speed !== 'auto' ? `a-${i.speed}` : 'auto'
    // Real IOS columns (ntc-templates cisco_ios_show_interfaces_status.raw): Port 0, Name 10 (cut
    // at 18 characters, as the device does), Status 29, Vlan 42, Duplex 53 and Speed 60, both
    // right-aligned to width 6 ("  auto"), Type 67.
    return `${pad(i.short, 10)}${pad((i.description ?? '').slice(0, 18), 19)}${pad(portStatus(i), 13)}${pad(vlan, 11)}${lpad(dup, 6)} ${lpad(spd, 6)} ${i.media ?? '10/100/1000BaseTX'}`
  })
  return ['', 'Port      Name               Status       Vlan       Duplex  Speed Type', ...rows].join('\n')
}

export function showIntDescription(d: Device): string {
  const rows = d.interfaces.map((i) => {
    const [st, pr] = ifStatus(i)
    return `${pad(i.short, 31)}${pad(st === 'administratively down' ? 'admin down' : st, 15)}${pad(pr, 9)}${i.description ?? ''}`.trimEnd()
  })
  return ['Interface                      Status         Protocol Description', ...rows].join('\n')
}

function bw(i: Iface): number {
  const s = i.speedSet && i.speedSet !== 'auto' ? i.speedSet : i.speed
  if (/^\d+$/.test(s)) return Number(s) * 1000
  if (/^\d+G$/.test(s)) return Number(s.slice(0, -1)) * 1_000_000
  return 1_000_000
}

export function showInterface(d: Device, i: Iface): string {
  const [st, pr] = ifStatus(i)
  const c = ifaceCounters(d, i)
  const virtual = /^(Vlan|Loopback|Tunnel|Null)/.test(i.name)
  const hw = i.name.startsWith('Vlan') ? 'Ethernet SVI' : i.name.startsWith('Loop') ? 'Loopback' : i.name.startsWith('Ten') ? 'Ten Gigabit Ethernet' : 'Gigabit Ethernet'
  const status = i.errDisabled ? 'down' : st
  const lines = [`${i.name} is ${status}, line protocol is ${pr}${i.errDisabled ? ' (err-disabled)' : !i.adminUp ? ' (disabled)' : isUp(i) ? ' (connected)' : ' (notconnect)'}`]
  lines.push(`  Hardware is ${hw}${virtual && !i.mac ? '' : `, address is ${i.mac || '0000.0000.0000'} (bia ${i.mac || '0000.0000.0000'})`}`)
  if (i.description) lines.push(`  Description: ${i.description}`)
  if (i.ip) lines.push(`  Internet address is ${i.ip}/${i.mask}`)
  const mtu = i.mtu ?? 1500
  const b = virtual && !i.name.startsWith('Vlan') ? 8000000 : bw(i)
  lines.push(`  MTU ${mtu} bytes, BW ${b} Kbit/sec, DLY ${virtual ? 5000 : 10} usec,`, '     reliability 255/255, txload 1/255, rxload 1/255', '  Encapsulation ARPA, loopback not set', '  Keepalive set (10 sec)')
  if (!virtual) {
    const up = isUp(i)
    const dup = up ? (resolvedDuplex(i) === 'half' ? 'Half-duplex' : 'Full-duplex') : 'Auto-duplex'
    const spd = up ? `${i.speedSet && i.speedSet !== 'auto' ? i.speedSet : i.speed === 'auto' ? '1000' : i.speed}Mb/s` : 'Auto-speed'
    lines.push(`  ${dup}, ${spd}, media type is ${i.media ?? '10/100/1000BaseTX'}`, '  input flow-control is on, output flow-control is unsupported ', '  ARP type: ARPA, ARP Timeout 04:00:00')
  }
  lines.push(
    `  Last input 00:00:0${isUp(i) ? 1 : 0}, output 00:00:00, output hang never`,
    `  Last clearing of "show interface" counters ${i.clearedAt ? uptime(i.clearedAt, now(d)) : 'never'}`,
    '  Input queue: 0/2000/0/0 (size/max/drops/flushes); Total output drops: 0',
    '  Queueing strategy: fifo',
    '  Output queue: 0/40 (size/max)',
    `  5 minute input rate ${c.inBps} bits/sec, ${c.inPps} packets/sec`,
    `  5 minute output rate ${c.outBps} bits/sec, ${c.outPps} packets/sec`,
    `     ${c.inPkts} packets input, ${c.inBytes} bytes, 0 no buffer`,
    `     Received ${Math.floor(c.inPkts / 900)} broadcasts (${Math.floor(c.inPkts / 1400)} multicasts)`,
    `     ${c.runts} runts, ${c.giants} giants, 0 throttles `,
    `     ${c.inErrors} input errors, ${c.crc} CRC, ${c.frame} frame, ${c.overrun} overrun, ${c.ignored} ignored`,
    `     0 watchdog, ${Math.floor(c.inPkts / 1400)} multicast, 0 pause input`,
    '     0 input packets with dribble condition detected',
    `     ${c.outPkts} packets output, ${c.outBytes} bytes, 0 underruns`,
    `     Output ${Math.floor(c.outPkts / 1000)} broadcasts (${Math.floor(c.outPkts / 1300)} multicasts)`,
    `     ${c.outErrors} output errors, ${c.collisions} collisions, ${c.resets} interface resets`,
    '     0 unknown protocol drops',
    `     0 babbles, ${c.lateCollisions} late collision, ${c.deferred} deferred`,
    '     0 lost carrier, 0 no carrier, 0 pause output',
    '     0 output buffer failures, 0 output buffers swapped out'
  )
  return lines.join('\n')
}

export function showIntCountersErrors(d: Device): string {
  const ports = d.interfaces.filter(switchport)
  const a = ports.map((i) => {
    const c = ifaceCounters(d, i)
    return `${pad(i.short, 16)}${lpad(c.frame, 10)}${lpad(c.crc, 11)}${lpad(c.crc + c.frame, 11)}${lpad(c.outErrors, 11)}${lpad(0, 11)}${lpad(0, 11)}`
  })
  const b = ports.map((i) => {
    const c = ifaceCounters(d, i)
    return `${pad(i.short, 16)}${lpad(0, 12)}${lpad(c.collisions - c.lateCollisions > 0 ? c.collisions - c.lateCollisions : 0, 11)}${lpad(0, 11)}${lpad(c.lateCollisions, 11)}${lpad(c.lateCollisions, 11)}${lpad(c.runts, 11)}${lpad(0, 11)}${lpad(0, 11)}`
  })
  return [
    '',
    'Port        Align-Err     FCS-Err    Xmit-Err     Rcv-Err  UnderSize  OutDiscards',
    ...a,
    '',
    'Port      Single-Col  Multi-Col   Late-Col  Excess-Col  Carri-Sen      Runts     Giants',
    ...b
  ].join('\n')
}

function vlanList(v: number[]): string {
  const out: string[] = []
  const s = [...new Set(v)].sort((a, b) => a - b)
  for (let k = 0; k < s.length; ) {
    let e = k
    while (e + 1 < s.length && s[e + 1] === s[e]! + 1) e++
    out.push(e > k ? `${s[k]}-${s[e]}` : String(s[k]))
    k = e + 1
  }
  return out.join(',')
}

export function trunkVlans(d: Device, i: Iface): number[] {
  const allowed = i.trunkAllowed ?? Array.from({ length: 4094 }, (_, n) => n + 1)
  return allowed.filter((v) => d.vlans.some((x) => x.id === v && !x.shutdown))
}

export function showIntTrunk(d: Device): string {
  const trunks = d.interfaces.filter((i) => i.mode === 'trunk')
  const rows1 = trunks.map((i) => `${pad(i.short, 12)}${pad('on', 17)}${pad('802.1q', 15)}${pad(isUp(i) ? 'trunking' : 'not-trunking', 14)}${i.nativeVlan ?? 1}`)
  const allowed = trunks.map((i) => `${pad(i.short, 12)}${i.trunkAllowed ? vlanList(i.trunkAllowed) : '1-4094'}`)
  const active = trunks.map((i) => `${pad(i.short, 12)}${isUp(i) ? vlanList(trunkVlans(d, i)) || 'none' : 'none'}`)
  return [
    '',
    'Port        Mode             Encapsulation  Status        Native vlan',
    ...rows1,
    '',
    'Port        Vlans allowed on trunk',
    ...allowed,
    '',
    'Port        Vlans allowed and active in management domain',
    ...active,
    '',
    'Port        Vlans in spanning tree forwarding state and not pruned',
    ...active
  ].join('\n')
}

// ---------------------------------------------------------------- BGP

const estSorted = (d: Device): Device['bgp'] => [...d.bgp].sort((a, b) => cmpIp(a.ip, b.ip))

export function showBgpSummary(d: Device): string {
  const t = now(d)
  const est = d.bgp.filter((n) => bgpUp(n, t))
  const nets = est.reduce((a, n) => a + n.prefixes, 0) + 4
  const rows = estSorted(d).map((n) => {
    const up = bgpUp(n, t)
    const st = neighborState(d, n, t)
    const updown = up ? uptime(n.upSince!, t) : n.downSince ? uptime(n.downSince, t) : 'never'
    const tail = up ? lpad(n.prefixes, 9) : '  ' + (st === 'Established' ? 'Active' : st)
    return `${pad(n.ip, 16)}4${lpad(n.remoteAs, 13)} ${lpad(up ? (n.msgRcvd ?? 61234) : 0, 7)} ${lpad(up ? (n.msgSent ?? 61190) : 0, 7)} ${lpad(up ? 482 : 1, 8)}    0    0 ${pad(updown, 8)}${tail}`
  })
  return [
    `BGP router identifier ${d.routerId}, local AS number ${d.localAs}`,
    `BGP table version is 482, main routing table version 482`,
    `${nets} network entries using ${nets * 248} bytes of memory`,
    `${nets} path entries using ${nets * 136} bytes of memory`,
    `5/5 BGP path/bestpath attribute entries using 1480 bytes of memory`,
    `2 BGP AS-PATH entries using 64 bytes of memory`,
    `0 BGP route-map cache entries using 0 bytes of memory`,
    `0 BGP filter-list cache entries using 0 bytes of memory`,
    `BGP using ${nets * 248 + nets * 136 + 1480 + 64} total bytes of memory`,
    `BGP activity 491/475 prefixes, 512/496 paths, scan interval 60 secs`,
    `${nets} networks peaked at ${ciscoDate(d.bootedAt + 3600_000).replace(/^(\S+) UTC \S+ (\S+ \S+ \S+)$/, '$1 $2 UTC')} (${uptime(d.bootedAt + 3600_000, t)} ago)`,
    '',
    'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
    ...rows
  ].join('\n')
}

export function showBgpNeighbors(d: Device, ip?: string, sub?: string): string {
  const list = ip ? d.bgp.filter((n) => n.ip === ip) : estSorted(d)
  if (ip && !list.length) return `% No such neighbor or address family`
  const t = now(d)
  if (sub && list[0]) {
    const n = list[0]
    if (!bgpUp(n, t)) return ''
    const routes = sub === 'advertised-routes' ? d.interfaces.filter((i) => i.ip && i.mask !== undefined && i.mask < 32 && !i.vrf && isUp(i)).map((i) => ({ prefix: network(i.ip!, i.mask!), mask: i.mask!, nh: '0.0.0.0', path: 'i' })) : (n.routes ?? []).map((r) => ({ ...r, nh: n.ip, path: `${n.remoteAs} i` }))
    return [
      `BGP table version is 482, local router ID is ${d.routerId}`,
      'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal, ',
      '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter, ',
      '              x best-external, a additional-path, c RIB-compressed, ',
      '              t secondary path, L long-lived-stale,',
      'Origin codes: i - IGP, e - EGP, ? - incomplete',
      'RPKI validation codes: V valid, I invalid, N Not found',
      '',
      '     Network          Next Hop            Metric LocPrf Weight Path',
      ...routes.map((r) => ` *>  ${pad(`${r.prefix}/${r.mask}`, 17)}${pad(r.nh, 20)}${lpad(0, 6)}${lpad('', 7)}${lpad(sub === 'advertised-routes' ? 32768 : 0, 7)} ${r.path}`),
      '',
      `Total number of prefixes ${routes.length} `
    ].join('\n')
  }
  return list
    .map((n) => {
      const up = bgpUp(n, t)
      const via = d.interfaces.find((i) => i.name === n.via)
      const state = neighborState(d, n, t)
      const lines = [
        `BGP neighbor is ${n.ip},  remote AS ${n.remoteAs}, external link`,
        ` Description: ${n.description ?? ''}`,
        `  BGP version 4, remote router ID ${up ? (n.routerId ?? n.ip) : '0.0.0.0'}`,
        `  BGP state = ${state === 'Idle (Admin)' ? 'Idle, Administratively shut down' : state}${up ? `, up for ${uptime(n.upSince!, t)}` : ''}`
      ]
      if (!up) {
        lines.push(
          `  Last read never, last write never, hold time is 180, keepalive interval is 60 seconds`,
          `  Neighbor sessions:`,
          `    0 active, is not multisession capable (disabled)`,
          `  Connections established 3; dropped 3`,
          `  Last reset ${n.downSince ? uptime(n.downSince, t) : 'never'}, due to ${n.peerAs !== undefined && n.peerAs !== n.remoteAs ? `BGP Notification sent, peer in wrong AS` : 'Interface flap'} of session 1`
        )
        if (n.peerAs !== undefined && n.peerAs !== n.remoteAs) lines.push(`  Peer had AS ${n.peerAs} in its OPEN message, expected ${n.remoteAs}`)
        lines.push(via && !via.adminUp ? `  External BGP neighbor not directly connected.\n  No active TCP connection` : `  No active TCP connection`)
      } else {
        lines.push(
          `  Last read 00:00:12, last write 00:00:21, hold time is 180, keepalive interval is 60 seconds`,
          `  Neighbor sessions:`,
          `    1 active, is not multisession capable (disabled)`,
          `  Neighbor capabilities:`,
          `    Route refresh: advertised and received(new)`,
          `    Four-octets ASN Capability: advertised and received`,
          `    Address family IPv4 Unicast: advertised and received`,
          `    Enhanced Refresh Capability: advertised and received`,
          ` For address family: IPv4 Unicast`,
          `  Session: ${n.ip}`,
          `  BGP table version 482, neighbor version 482/0`,
          `  Output queue size : 0`,
          `  Index 1, Advertise bit 0`,
          ...(n.routeMapIn ? [`  Route map for incoming advertisements is ${n.routeMapIn}`] : []),
          ...(n.routeMapOut ? [`  Route map for outgoing advertisements is ${n.routeMapOut}`] : []),
          `  Prefixes Current: ${n.prefixes} accepted`,
          `  Connections established 4; dropped 3`,
          `  Last reset ${uptime(n.upSince!, t)}, due to Peer closed the session of session 1`,
          `Transport(tcp) path-mtu-discovery is enabled`,
          `Local host: ${via?.ip ?? '0.0.0.0'}, Local port: 179`,
          `Foreign host: ${n.ip}, Foreign port: 51022`
        )
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

export function showIpBgp(d: Device): string {
  const t = now(d)
  const rows: string[] = []
  for (const i of d.interfaces) if (i.ip && i.mask !== undefined && i.mask < 32 && !i.vrf && isUp(i) && /^Vlan/.test(i.name)) rows.push(` *>   ${pad(`${network(i.ip, i.mask)}/${i.mask}`, 17)}${pad('0.0.0.0', 20)}${lpad(0, 6)}${lpad('', 7)}${lpad(32768, 7)} i`)
  for (const n of estSorted(d)) if (bgpUp(n, t)) for (const r of n.routes ?? []) rows.push(` *>   ${pad(`${r.prefix}/${r.mask}`, 17)}${pad(n.ip, 20)}${lpad(0, 6)}${lpad(200, 7)}${lpad(0, 7)} ${n.remoteAs} i`)
  return [
    `BGP table version is 482, local router ID is ${d.routerId}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal, ',
    '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter, ',
    '              x best-external, a additional-path, c RIB-compressed, ',
    '              t secondary path, L long-lived-stale,',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    'RPKI validation codes: V valid, I invalid, N Not found',
    '',
    '     Network          Next Hop            Metric LocPrf Weight Path',
    ...rows
  ].join('\n')
}

// ---------------------------------------------------------------- routing

export interface Rib {
  code: string
  prefix: string
  mask: number
  text: string
}

/** Routing table for a VRF (undefined = global). */
export function rib(d: Device, vrf?: string): Rib[] {
  const t = now(d)
  const out: Rib[] = []
  const ifs = d.interfaces.filter((i) => (vrf ? i.vrf === vrf : inDefaultVrf(i)) && i.ip && i.mask !== undefined && isUp(i))
  const connected = (ip: string): Iface | undefined => ifs.find((i) => i.mask! < 32 && inSubnet(ip, i.ip!, i.mask!))
  for (const r of d.staticRoutes) {
    if ((r.vrf ?? undefined) !== vrf) continue
    if (!connected(r.nextHop)) continue
    out.push({ code: r.mask === 0 ? 'S*' : 'S', prefix: r.prefix, mask: r.mask, text: `[${r.ad ?? 1}/0] via ${r.nextHop}` })
  }
  for (const i of ifs) {
    if (i.mask! < 32) {
      out.push({ code: 'C', prefix: network(i.ip!, i.mask!), mask: i.mask!, text: `is directly connected, ${i.name}` })
      out.push({ code: 'L', prefix: i.ip!, mask: 32, text: `is directly connected, ${i.name}` })
    } else out.push({ code: 'C', prefix: i.ip!, mask: 32, text: `is directly connected, ${i.name}` })
  }
  if (!vrf) {
    for (const n of d.bgp) {
      if (!bgpUp(n, t)) continue
      for (const r of n.routes ?? []) if (!out.some((o) => o.prefix === r.prefix && o.mask === r.mask)) out.push({ code: 'B', prefix: r.prefix, mask: r.mask, text: `[20/0] via ${n.ip}, ${uptime(n.upSince!, t)}` })
    }
    for (const n of d.ospf?.neighbors ?? []) {
      if (ospfState(d, n) !== 'FULL') continue
      const p = (d.vendor['ospfRoutes'] as { prefix: string; mask: number; via: string }[] | undefined)?.filter((r) => r.via === n.ip) ?? []
      for (const r of p) out.push({ code: 'O', prefix: r.prefix, mask: r.mask, text: `[110/2] via ${n.ip}, ${uptime(n.upSince ?? d.bootedAt, t)}, ${n.iface}` })
    }
  }
  return out
}

function lookup(routes: Rib[], ip: string): Rib | undefined {
  return routes.filter((r) => inSubnet(ip, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask)[0]
}

export function showIpRoute(d: Device, vrf?: string, target?: string): string {
  if (vrf && !d.vrfs.some((v) => v.name === vrf)) return `% IP routing table ${vrf} does not exist`
  const routes = rib(d, vrf)
  if (target) {
    const [ip, len] = target.split('/')
    const hit = len !== undefined ? routes.find((r) => r.prefix === ip && r.mask === Number(len)) : lookup(routes, ip!)
    if (!hit) return '% Network not in table'
    const via = /via (\S+?),?( |$)/.exec(hit.text)?.[1]
    const kind = { C: 'connected', L: 'connected', S: 'static', 'S*': 'static', B: 'bgp 65001', O: 'ospf 1' }[hit.code] ?? 'connected'
    const lines = [`Routing entry for ${hit.prefix}/${hit.mask}${hit.mask === 0 ? ', supernet' : ''}`, `  Known via "${kind.replace('65001', String(d.localAs))}", distance ${/^S/.test(hit.code) ? 1 : hit.code === 'B' ? 20 : hit.code === 'O' ? 110 : 0}, metric 0${hit.code === 'S*' ? ', candidate default path' : ''}${/^[CL]$/.test(hit.code) ? ' (connected, via interface)' : ''}`]
    if (hit.code === 'B') lines.push(`  Tag ${d.bgp.find((n) => n.ip === via)?.remoteAs ?? 0}, type external`)
    lines.push(`  Routing Descriptor Blocks:`)
    lines.push(via ? `  * ${via}${/^S/.test(hit.code) ? '' : `, from ${via}`}, ${hit.code === 'B' ? `${hit.text.split(', ').at(-1)} ago` : 'via ' + (d.interfaces.find((i) => i.ip && i.mask! < 32 && inSubnet(via, i.ip, i.mask!))?.name ?? 'Null0')}` : `  * directly connected, via ${hit.text.split(', ').at(-1)}`)
    lines.push(`      Route metric is 0, traffic share count is 1`)
    return lines.join('\n')
  }
  const def = routes.find((r) => r.mask === 0)
  const header = [
    ...(vrf ? [``, `Routing Table: ${vrf}`] : []),
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2',
    '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
    '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
    '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
    '       a - application route',
    '       + - replicated route, % - next hop override, p - overrides from PfR',
    '',
    `Gateway of last resort is ${def ? `${/via (\S+)/.exec(def.text)?.[1]} to network 0.0.0.0` : 'not set'}`,
    ''
  ]
  const body: string[] = []
  if (def) body.push(`${pad(def.code, 6)}${def.prefix}/${def.mask} ${def.text}`)
  const groups = new Map<string, Rib[]>()
  for (const r of routes) {
    if (r.mask === 0) continue
    const [net, m] = classful(r.prefix)
    const key = `${net}/${m}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => cmpIp(a.split('/')[0]!, b.split('/')[0]!))
  for (const key of sortedKeys) {
    const g = groups.get(key)!.sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
    const cm = Number(key.split('/')[1])
    if (g.length === 1 && g[0]!.mask === cm) {
      const r = g[0]!
      body.push(`${pad(r.code, 6)}${r.prefix}/${r.mask} ${r.text}`)
      continue
    }
    const masks = new Set(g.map((r) => r.mask))
    body.push(masks.size > 1 ? `      ${key} is variably subnetted, ${g.length} subnets, ${masks.size} masks` : `      ${key.split('/')[0]}/${g[0]!.mask} is subnetted, ${g.length} subnets`)
    for (const r of g) body.push(`${pad(r.code, 9)}${r.prefix}/${r.mask} ${r.text}`)
  }
  return [...header, ...body].join('\n')
}

export function showOspfNeighbor(d: Device): string {
  const rows: string[] = []
  for (const n of d.ospf?.neighbors ?? []) {
    const st = ospfState(d, n)
    if (!st) continue
    const role = n.role ?? '-'
    const state = `${st}/${role === '-' ? '  -' : role}`
    const dead = `00:00:${31 + ([...n.routerId].reduce((a, c) => a + c.charCodeAt(0), 0) % 9)}`
    rows.push(`${pad(n.routerId, 16)}${lpad(n.pri, 3)}   ${pad(state, 16)}${pad(dead, 12)}${pad(n.ip, 16)}${n.iface}`)
  }
  return ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface', ...rows].join('\n')
}

export function showOspfIntBrief(d: Device): string {
  const rows = (d.ospf?.ifaces ?? []).map((o) => {
    const i = d.interfaces.find((x) => x.name === o.iface)
    const nbrs = (d.ospf?.neighbors ?? []).filter((n) => n.iface === o.iface)
    const full = nbrs.filter((n) => ospfState(d, n) === 'FULL').length
    const st = !i || !isUp(i) ? 'DOWN' : o.networkType === 'point-to-point' ? 'P2P' : 'DR'
    return `${pad(i ? i.short : o.iface, 11)}${pad(d.ospf!.process, 5)}${pad(o.area, 11)}${pad(i?.ip ? `${i.ip}/${i.mask}` : '', 19)}${pad(o.cost ?? 1, 5)}${pad(st, 6)}${full}/${nbrs.length}`
  })
  return ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C', ...rows].join('\n')
}

// ---------------------------------------------------------------- L2

/** MAC entries actually learned: the port must be up and, on a trunk, the VLAN allowed. */
export function liveMacs(d: Device): Device['mac'] {
  return d.mac.filter((m) => {
    if (m.type === 'STATIC') return true
    const i = d.interfaces.find((x) => x.short === m.port || x.name === m.port)
    if (!i || !isUp(i)) return false
    if (i.mode === 'trunk' && !trunkVlans(d, i).includes(m.vlan)) return false
    return true
  })
}

export function showMacTable(d: Device, filter?: { kind: 'address' | 'interface' | 'vlan' | 'dynamic'; value?: string }): string {
  let rows = liveMacs(d)
  if (filter?.kind === 'address') {
    const want = (filter.value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '')
    rows = rows.filter((r) => r.mac.replace(/\./g, '') === want.padStart(12, '0'))
  } else if (filter?.kind === 'interface') rows = rows.filter((r) => r.port === filter.value)
  else if (filter?.kind === 'vlan') rows = rows.filter((r) => String(r.vlan) === filter.value)
  else if (filter?.kind === 'dynamic') rows = rows.filter((r) => r.type !== 'STATIC')
  rows = [...rows].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
  return [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
    ...rows.map((r) => `${lpad(r.vlan === 0 ? 'All' : r.vlan, 4)}    ${pad(r.mac, 18)}${pad(r.type ?? 'DYNAMIC', 12)}${r.port}`),
    `Total Mac Addresses for this criterion: ${rows.length}`
  ].join('\n')
}

export function showVlan(d: Device, brief: boolean): string {
  const rows: string[] = []
  for (const v of [...d.vlans].sort((a, b) => a.id - b.id)) {
    const ports = d.interfaces.filter((i) => i.mode === 'access' && (i.vlan ?? 1) === v.id && switchport(i)).map((i) => i.short)
    const chunks: string[][] = []
    for (let k = 0; k < ports.length; k += 4) chunks.push(ports.slice(k, k + 4))
    rows.push(`${pad(v.id, 5)}${pad(v.name, 33)}${pad(v.shutdown ? 'act/lshut' : 'active', 10)}${(chunks[0] ?? []).join(', ')}`.trimEnd())
    for (const c of chunks.slice(1)) rows.push(`${' '.repeat(48)}${c.join(', ')}`)
  }
  for (const [id, name] of [
    [1002, 'fddi-default'],
    [1003, 'token-ring-default'],
    [1004, 'fddinet-default'],
    [1005, 'trnet-default']
  ] as const)
    rows.push(`${pad(id, 5)}${pad(name, 33)}act/unsup `.trimEnd())
  const head = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------', ...rows]
  if (brief) return head.join('\n')
  const types = [...d.vlans].sort((a, b) => a.id - b.id).map((v) => `${pad(v.id, 5)}enet  ${pad(100000 + v.id, 11)}1500  -      -      -        -    -        0      0   `)
  return [...head, '', 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2', '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------', ...types].join('\n')
}

export function showVrf(d: Device, brief = true): string {
  const rows = d.vrfs.map((v) => {
    const ifs = d.interfaces.filter((i) => i.vrf === v.name).map((i) => i.short)
    return `  ${pad(v.name, 33)}${pad(v.rd || '<not set>', 22)}${pad(v.name === 'Mgmt-vrf' ? 'ipv4,ipv6' : 'ipv4', 12)}${ifs.join(',')}`.trimEnd()
  })
  void brief
  return ['  Name                             Default RD            Protocols   Interfaces', ...rows].join('\n')
}

const cdpIf = (s: string): string => {
  const m = /^(Gi|Te|Fa|Twe|Hu|Fo|Et|Po)(\d.*)$/.exec(s)
  if (!m) return s
  return `${{ Gi: 'Gig', Te: 'Ten', Fa: 'Fas', Twe: 'Twe', Hu: 'Hun', Fo: 'For', Et: 'Eth', Po: 'Por' }[m[1]!]} ${m[2]}`
}

function nbrPortUp(d: Device, local: string): boolean {
  const i = d.interfaces.find((x) => x.short === local || x.name === local)
  return !!i && isUp(i)
}

export function showCdp(d: Device, detail: boolean): string {
  const ns = d.lldp.filter((n) => n.cdp && nbrPortUp(d, n.local))
  if (!d.services['cdp']) return '% CDP is not enabled'
  if (detail) {
    return ns
      .map((n) =>
        [
          '-------------------------',
          `Device ID: ${n.device.includes('.') ? n.device + '.example.net' : n.device}`,
          'Entry address(es): ',
          `  IP address: ${n.ip ?? '0.0.0.0'}`,
          `Platform: cisco ${n.platform ?? ''},  Capabilities: ${n.caps === 'R' ? 'Router Source-Route-Bridge IGMP' : 'Trans-Bridge Source-Route-Bridge IGMP'}`,
          `Interface: ${d.interfaces.find((i) => i.short === n.local)?.name ?? n.local},  Port ID (outgoing port): ${n.port.replace(/^Gig /, 'GigabitEthernet').replace(/^Gi(\d)/, 'GigabitEthernet$1')}`,
          `Holdtime : ${n.holdtime ?? 150} sec`,
          '',
          'Version :',
          n.sysDescr ?? 'Cisco IOS Software, C9120AX Software',
          '',
          'advertisement version: 2',
          'Duplex: full',
          ''
        ].join('\n')
      )
      .concat([`Total cdp entries displayed : ${ns.length}`])
      .join('\n')
  }
  const rows: string[] = []
  for (const n of ns) {
    const id = n.device.includes('.') ? n.device + '.example.net' : n.device
    const caps = n.caps === 'R' ? 'R I' : (n.caps ?? 'R')
    const data = `${pad(cdpIf(n.local), 18)}${pad(n.holdtime ?? 150, 3)}`
    const capStart = 53 - Math.floor((caps.length - 1) / 2)
    const line = (data.padEnd(capStart - 17) + caps).padEnd(58 - 17) + pad((n.platform ?? '').slice(0, 9), 9) + ' ' + cdpIf(n.port)
    if (id.length > 16) rows.push(id, ' '.repeat(17) + line)
    else rows.push(pad(id, 17) + line)
  }
  return [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,',
    '                  D - Remote, C - CVTA, M - Two-port Mac Relay',
    '',
    'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
    ...rows,
    '',
    `Total cdp entries displayed : ${ns.length}`
  ].join('\n')
}

export function showLldp(d: Device, detail: boolean): string {
  const ns = d.lldp.filter((n) => !n.noLldp && nbrPortUp(d, n.local))
  if (detail) {
    return [
      ...ns.map((n) =>
        [
          '------------------------------------------------',
          `Local Intf: ${n.local}`,
          `Chassis id: ${n.ip ? '3c22.fb81.0000' : '0000.0000.0000'}`,
          `Port id: ${n.port}`,
          `Port Description: ${n.port}`,
          `System Name: ${n.device}`,
          '',
          'System Description: ',
          n.sysDescr ?? (n.device.includes('eos') ? 'Arista Networks EOS version 4.31.2F running on an Arista DCS-7050SX3-48YC8' : 'Cisco IOS Software'),
          '',
          `Time remaining: ${(n.holdtime ?? 120) - 9} seconds`,
          `System Capabilities: ${n.caps ?? 'R'}`,
          `Enabled Capabilities: ${n.caps ?? 'R'}`,
          'Management Addresses:',
          `    IP: ${n.ip ?? '0.0.0.0'}`,
          ''
        ].join('\n')
      ),
      '',
      `Total entries displayed: ${ns.length}`
    ].join('\n')
  }
  return [
    'Capability codes:',
    '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
    '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
    '',
    'Device ID           Local Intf     Hold-time  Capability      Port ID',
    ...ns.map((n) => `${pad(n.device.slice(0, 20), 20)}${pad(n.local, 15)}${pad(120, 11)}${pad(n.caps ?? 'R', 16)}${n.port}`),
    '',
    `Total entries displayed: ${ns.length}`
  ].join('\n')
}

export function showArp(d: Device, vrf?: string): string {
  const rows: { ip: string; age: string; mac: string; iface: string }[] = []
  const ifs = d.interfaces.filter((i) => (vrf ? i.vrf === vrf : !i.vrf) && isUp(i))
  for (const i of ifs) if (i.ip && i.mac && !/^Loop/.test(i.name)) rows.push({ ip: i.ip, age: '-', mac: i.mac, iface: i.name })
  for (const a of d.arp) {
    const i = ifs.find((x) => x.name === a.iface)
    if (i) rows.push({ ip: a.ip, age: String(a.age), mac: a.mac, iface: a.iface })
  }
  rows.sort((a, b) => cmpIp(a.ip, b.ip))
  return ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface', ...rows.map((r) => `Internet  ${r.ip}${lpad(r.age, 25 - r.ip.length)}   ${pad(r.mac, 16)}ARPA   ${r.iface}`)].join('\n')
}

export function showLogging(d: Device): string {
  const n = (d.logBase ?? 0) + d.log.length
  return [
    'Syslog logging: enabled (0 messages dropped, 3 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)',
    '',
    'No Active Message Discriminator.',
    '',
    '',
    '',
    'No Inactive Message Discriminator.',
    '',
    '',
    '    Console logging: disabled',
    '    Monitor logging: level debugging, 0 messages logged, xml disabled,',
    '                     filtering disabled',
    `    Buffer logging:  level debugging, ${n} messages logged, xml disabled,`,
    '                    filtering disabled',
    '    Exception Logging: size (4096 bytes)',
    '    Count and timestamp logging messages: disabled',
    '    Persistent logging: disabled',
    '',
    'No active filter modules.',
    '',
    `    Trap logging: level informational, ${n + 4} message lines logged`,
    '        Logging to 10.10.10.20  (udp port 514, audit disabled,',
    '              link up),',
    `              ${n + 4} message lines logged,`,
    '              0 message lines rate-limited,',
    '              0 message lines dropped-by-MD,',
    '              xml disabled, sequence number disabled',
    '              filtering disabled',
    '        Logging Source-Interface:       VRF Name:',
    '        Loopback0                       ',
    '',
    'Log Buffer (102400 bytes):',
    '',
    ...d.log.map((e) => `*${logStamp(e.t)}: ${e.msg}`)
  ].join('\n')
}

export function showClock(d: Device): string {
  const t = now(d)
  const dt = new Date(t)
  return `*${two(dt.getUTCHours())}:${two(dt.getUTCMinutes())}:${two(dt.getUTCSeconds())}.${String(dt.getUTCMilliseconds()).padStart(3, '0')} UTC ${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()} ${dt.getUTCFullYear()}`
}

// ---------------------------------------------------------------- policy objects

export function showAccessLists(d: Device, name?: string): string {
  const list = name ? d.acls.filter((a) => a.name === name) : d.acls
  return list
    .map((a) => {
      const numbered = /^\d+$/.test(a.name)
      const head = `${a.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${a.name}`
      // Standard ACLs print a network as "10.0.0.0, wildcard bits 0.0.0.255" and a host bare.
      const shown = (t: string) => (a.type === 'standard' ? t.replace(/^host\s+/, '').replace(/^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/, '$1, wildcard bits $2') : t)
      const body = a.entries.map((e) => `    ${e.seq} ${e.action} ${shown(e.text)}${e.hits ? ` (${e.hits} match${e.hits === 1 ? '' : 'es'})` : ''}`)
      void numbered
      return [head, ...body].join('\n')
    })
    .join('\n')
}

export function showRouteMap(d: Device, name?: string): string {
  const list = name ? d.routeMaps.filter((r) => r.name === name) : d.routeMaps
  return list
    .flatMap((r) =>
      r.entries.map((e) =>
        [
          `route-map ${r.name}, ${e.action}, sequence ${e.seq}`,
          '  Match clauses:',
          ...e.match.map((m) => `    ${m}`),
          '  Set clauses:',
          ...e.set.map((s) => `    ${s}`),
          `  Policy routing matches: 0 packets, 0 bytes`
        ].join('\n')
      )
    )
    .join('\n')
}

export function showPrefixList(d: Device, name?: string): string {
  const list = name ? d.prefixLists.filter((p) => p.name === name) : d.prefixLists
  return list
    .map((p) => [`ip prefix-list ${p.name}: ${p.entries.length} entries`, ...p.entries.map((e) => `   seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`)].join('\n'))
    .join('\n')
}

// ---------------------------------------------------------------- system

export function cpuLoad(d: Device): [number, number, number, number] {
  const hog = d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
  const [a, b, c] = d.cpu.load
  if (!hog) return [a, Math.floor(a / 3), b, c]
  return [Math.min(99, a + hog.pct), Math.floor(hog.pct / 30), Math.min(99, b + hog.pct - 4), Math.min(99, c + hog.pct - 9)]
}

export function showProcessesCpu(d: Device, sorted: boolean): string {
  const hog = d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
  const [five, intr, one, fivem] = cpuLoad(d)
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  if (sorted) procs = procs.sort((a, b) => b.pct - a.pct || a.pid - b.pid)
  const f = (n: number): string => `${n.toFixed(2)}%`
  return [
    `CPU utilization for five seconds: ${five}%/${intr}%; one minute: ${one}%; five minutes: ${fivem}%`,
    ' PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process ',
    ...procs.map((p) => {
      const rt = 1000 + p.pid * 97 + Math.floor(p.pct * 50000)
      const inv = 300 + p.pid * 13
      const m1 = hog && hog.pid === p.pid ? p.pct - 4 : p.pct
      const m5 = hog && hog.pid === p.pid ? p.pct - 9 : p.pct
      return `${lpad(p.pid, 4)}${lpad(rt, 12)}${lpad(inv, 12)}${lpad(Math.floor(rt / inv * 1000), 11)}${lpad(f(p.pct), 7)}${lpad(f(Math.max(0, m1)), 7)}${lpad(f(Math.max(0, m5)), 7)}   0 ${p.name}`
    })
  ].join('\n')
}

export function showSpanningTree(d: Device, vlan?: number): string {
  const vlans = d.vlans.filter((v) => (vlan === undefined ? true : v.id === vlan))
  if (vlan !== undefined && !vlans.length) return `Spanning tree instance(s) for vlan ${vlan} does not exist.`
  return vlans
    .map((v) => {
      const ports = d.interfaces.filter((i) => isUp(i) && switchport(i) && ((i.mode === 'access' && (i.vlan ?? 1) === v.id) || (i.mode === 'trunk' && trunkVlans(d, i).includes(v.id))))
      return [
        '',
        `VLAN${String(v.id).padStart(4, '0')}`,
        '  Spanning tree enabled protocol rstp',
        `  Root ID    Priority    ${24576 + v.id}`,
        `             Address     00a3.d14f.0100`,
        '             This bridge is the root',
        '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
        '',
        `  Bridge ID  Priority    ${24576 + v.id}  (priority 24576 sys-id-ext ${v.id})`,
        '             Address     00a3.d14f.0100',
        '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
        '             Aging Time  300 sec',
        '',
        'Interface           Role Sts Cost      Prio.Nbr Type',
        '------------------- ---- --- --------- -------- --------------------------------',
        ...ports.map((i) => `${pad(i.short, 20)}Desg FWD ${pad(i.speed === '100' ? 19 : 4, 10)}128.${pad(i.name.split('/').at(-1)!, 4)}P2p${i.mode === 'access' && !i.description?.includes('trunk') ? ' Edge' : ''}`)
      ].join('\n')
    })
    .join('\n')
}

export function showEtherchannel(d: Device): string {
  const pos = d.interfaces.filter((i) => i.name.startsWith('Port-channel'))
  return [
    'Flags:  D - down        P - bundled in port-channel',
    '        I - stand-alone s - suspended',
    '        H - Hot-standby (LACP only)',
    '        R - Layer3      S - Layer2',
    '        U - in use      f - failed to allocate aggregator',
    '',
    '        M - not in use, minimum links not met',
    '        u - unsuitable for bundling',
    '        w - waiting to be aggregated',
    '        d - default port',
    '',
    '        A - formed by Auto LAG',
    '',
    '',
    `Number of channel-groups in use: ${pos.length}`,
    `Number of aggregators:           ${pos.length}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
    ...pos.map((p) => {
      const n = p.name.replace('Port-channel', '')
      const members = d.interfaces.filter((i) => String(i.channelGroup) === n).map((i) => `${i.short}(${isUp(i) ? 'P' : 'D'})`)
      return `${pad(n, 7)}${pad(`${p.short}(${isUp(p) ? 'SU' : 'SD'})`, 14)}${pad('LACP', 12)}${members.join(' ')}`
    })
  ].join('\n')
}

export function showErrdisableRecovery(d: Device): string {
  const recov = (d.vendor['errdisableRecovery'] as string[] | undefined) ?? []
  const causes = ['arp-inspection', 'bpduguard', 'channel-misconfig', 'dhcp-rate-limit', 'link-flap', 'loopback', 'psecure-violation', 'udld']
  const ports = d.interfaces.filter((i) => i.errDisabled)
  return [
    'ErrDisable Reason            Timer Status',
    '-----------------            --------------',
    ...causes.map((c) => `${pad(c, 29)}${recov.includes(c) ? 'Enabled' : 'Disabled'}`),
    '',
    'Timer interval: 300 seconds',
    '',
    ports.length ? 'Interfaces that will be enabled at the next timeout:' : '',
    ...(ports.length ? ['', 'Interface       Errdisable reason       Time left(sec)', '---------       -----------------       --------------', ...ports.filter((i) => recov.includes(i.errDisabled!)).map((i) => `${pad(i.short, 16)}${pad(i.errDisabled!, 24)}${lpad(211, 14)}`)] : [])
  ].join('\n')
}

export function showInventory(d: Device): string {
  return [
    `NAME: "c93xx Stack", DESCR: "c93xx Stack"`,
    `PID: ${d.model}         , VID: V02  , SN: ${d.serial}`,
    '',
    `NAME: "Switch 1", DESCR: "${d.model}"`,
    `PID: ${d.model}         , VID: V02  , SN: ${d.serial}`,
    '',
    `NAME: "Switch 1 - Power Supply A", DESCR: "Switch 1 - Power Supply A"`,
    `PID: PWR-C1-715WAC-P    , VID: V02  , SN: DTN2231V1KQ`,
    '',
    `NAME: "Switch 1 FRU Uplink Module 1", DESCR: "8x10G Uplink Module"`,
    `PID: C9300-NM-8X        , VID: V02  , SN: FOC22313QHN`
  ].join('\n')
}

export function ifConfigName(i: Iface): string {
  return shortName(i.name, IOS_TYPES)
}

export { maskToDotted }
export { duplexMismatch }
