/**
 * NX-OS show-command renderers. Column layouts follow docs/research/cli-cisco-nxos.md §6 (cloned
 * from ntc-templates captures); everything is derived from the shared Device model so scenarios
 * (err-disabled ports, wrong peer AS, MTU mismatch, duplex mismatch, CPU hog, pruned trunks) show.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, lpad, network, pad } from '../../core/text.ts'
import type { IfType } from '../../core/ifname.ts'
import {
  bgpBlocker,
  bgpUp,
  duplexMismatch,
  ifaceCounters,
  isUp,
  neighborState,
  ospfState,
  resolvedDuplex,
  uptime,
  type BgpNeighbor,
  type Device,
  type Iface
} from '../../state.ts'
import { cpuLoad, liveMacs, trunkVlans } from '../ios/render.ts'

export const NXOS_TYPES: IfType[] = [
  { full: 'Ethernet', short: 'Eth' },
  { full: 'port-channel', short: 'Po' },
  { full: 'loopback', short: 'Lo' },
  { full: 'Vlan', short: 'Vlan' },
  { full: 'mgmt', short: 'mgmt' },
  { full: 'Tunnel', short: 'Tunnel' },
  { full: 'nve', short: 'nve' }
]

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')
const hms = (dt: Date): string => `${two(dt.getUTCHours())}:${two(dt.getUTCMinutes())}:${two(dt.getUTCSeconds())}`
const RULE = '-'.repeat(80)

/** ctime style: "Tue Nov 24 08:15:02 2026". */
export function nxDate(t: number): string {
  const dt = new Date(t)
  return `${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${lpad(dt.getUTCDate(), 2)} ${hms(dt)} ${dt.getUTCFullYear()}`
}

/** Logfile stamp: "2026 Nov 24 08:15:02". */
export function logDate(t: number): string {
  const dt = new Date(t)
  return `${dt.getUTCFullYear()} ${MON[dt.getUTCMonth()]} ${two(dt.getUTCDate())} ${hms(dt)}`
}

/** "02:37:14 UTC Oct 28 2017" (session manager, checkpoints). */
export function utcStamp(t: number): string {
  const dt = new Date(t)
  return `${hms(dt)} UTC ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()} ${dt.getUTCFullYear()}`
}

export const feature = (d: Device, f: string): boolean => !!d.services[`feature-${f}`]

// ---------------------------------------------------------------- interface helpers

export type IfKind = 'eth' | 'po' | 'lo' | 'vlan' | 'mgmt' | 'other'

export function kind(i: Iface): IfKind {
  if (i.name.startsWith('Ethernet')) return 'eth'
  if (i.name.startsWith('port-channel')) return 'po'
  if (i.name.startsWith('loopback')) return 'lo'
  if (i.name.startsWith('Vlan')) return 'vlan'
  if (i.name.startsWith('mgmt')) return 'mgmt'
  return 'other'
}

const KIND_ORDER: IfKind[] = ['vlan', 'lo', 'eth', 'po', 'mgmt', 'other']
const ifNum = (i: Iface): number[] => (i.name.match(/\d+/g) ?? []).map(Number)
export function ifCompare(a: Iface, b: Iface): number {
  const k = KIND_ORDER.indexOf(kind(a)) - KIND_ORDER.indexOf(kind(b))
  if (k) return k
  const x = ifNum(a)
  const y = ifNum(b)
  for (let n = 0; n < Math.max(x.length, y.length); n++) if ((x[n] ?? -1) !== (y[n] ?? -1)) return (x[n] ?? -1) - (y[n] ?? -1)
  return 0
}

export const members = (d: Device, po: Iface): Iface[] => d.interfaces.filter((i) => kind(i) === 'eth' && i.channelGroup !== undefined && `port-channel${i.channelGroup}` === po.name)

/** Operational state, including derived states for port-channels (members) and SVIs (VLAN ports). */
export function operUp(d: Device, i: Iface): boolean {
  if (!isUp(i)) return false
  if (kind(i) === 'po') {
    const m = members(d, i)
    return m.length ? m.some(isUp) : true
  }
  if (kind(i) === 'vlan') {
    const id = Number(i.name.slice(4))
    const v = d.vlans.find((x) => x.id === id)
    if (!v || v.shutdown) return false
    return d.interfaces.some((p) => p !== i && (kind(p) === 'eth' || kind(p) === 'po') && p.channelGroup === undefined && operUp(d, p) && ((p.mode === 'access' && (p.vlan ?? 1) === id) || (p.mode === 'trunk' && trunkVlans(d, p).includes(id))))
  }
  return true
}

function reason(d: Device, i: Iface): string {
  if (i.errDisabled) return i.errDisabled === 'bpduguard' ? 'BPDUGuard errDisabled' : `${i.errDisabled} errDisabled`
  if (!i.adminUp) return 'Administratively down'
  if (kind(i) === 'po' && !operUp(d, i)) return 'No operational members'
  if (!operUp(d, i)) return 'Link not connected'
  return 'none'
}

const speedOf = (d: Device, i: Iface): string => (operUp(d, i) ? i.speedSet && i.speedSet !== 'auto' ? i.speedSet : i.speed : 'auto')

// ---------------------------------------------------------------- show interface brief

export function showInterfaceBrief(d: Device): string {
  const out: string[] = ['']
  const ifs = [...d.interfaces].sort(ifCompare)
  const mg = ifs.filter((i) => kind(i) === 'mgmt')
  if (mg.length) {
    out.push(RULE, 'Port   VRF          Status IP Address                              Speed    MTU', RULE)
    for (const i of mg) out.push(`${pad(i.short, 7)}${pad('--', 13)}${pad(operUp(d, i) ? 'up' : 'down', 7)}${pad(i.ip ?? '--', 40)}${pad(operUp(d, i) ? i.speed : 'auto', 9)}${i.mtu ?? 1500}`)
    out.push('')
  }
  const eth = ifs.filter((i) => kind(i) === 'eth')
  if (eth.length) {
    out.push(RULE, 'Ethernet      VLAN    Type Mode   Status  Reason                   Speed     Port', 'Interface                                                                    Ch #', RULE)
    for (const i of eth) {
      const vlan = i.mode === 'routed' ? '--' : String(i.mode === 'trunk' ? (i.nativeVlan ?? 1) : (i.vlan ?? 1))
      const left = `${pad(i.short, 14)}${pad(vlan, 8)}eth  ${pad(i.mode, 7)}${pad(operUp(d, i) ? 'up' : 'down', 8)}${reason(d, i)}`
      const sp = `${speedOf(d, i)}(D)`
      out.push(`${left.padEnd(76 - sp.length - 1)} ${sp} ${i.channelGroup ?? '--'}`)
    }
    out.push('')
  }
  const po = ifs.filter((i) => kind(i) === 'po')
  if (po.length) {
    out.push(RULE, 'Port-channel VLAN    Type Mode   Status  Reason                    Speed   Protocol', 'Interface                                                                  ', RULE)
    for (const i of po) {
      const vlan = i.mode === 'routed' ? '--' : String(i.mode === 'trunk' ? (i.nativeVlan ?? 1) : (i.vlan ?? 1))
      const left = `${pad(i.short, 13)}${pad(vlan, 8)}eth  ${pad(i.mode, 7)}${pad(operUp(d, i) ? 'up' : 'down', 8)}${reason(d, i)}`
      const sp = operUp(d, i) ? `a-${i.speed}(D)` : 'auto(D)'
      out.push(`${left.padEnd(76 - sp.length - 1)} ${sp}  ${members(d, i).length ? 'lacp' : 'none'}`)
    }
    out.push('')
  }
  const lo = ifs.filter((i) => kind(i) === 'lo')
  if (lo.length) {
    out.push(RULE, 'Interface     Status     Description', RULE)
    for (const i of lo) out.push(`${pad(i.short, 14)}${pad(operUp(d, i) ? 'up' : 'down', 11)}${i.description ?? '--'}`)
    out.push('')
  }
  const vl = ifs.filter((i) => kind(i) === 'vlan')
  if (vl.length) {
    out.push(RULE, 'Interface Secondary VLAN(Type)                    Status Reason                 ', RULE)
    for (const i of vl) out.push(`${pad(i.short, 10)}${pad('--', 40)}${pad(operUp(d, i) ? 'up' : 'down', 7)}${operUp(d, i) ? '--' : !i.adminUp ? 'Administratively down' : 'VLAN/BD is down'}`)
    out.push('')
  }
  return out.join('\n').replace(/\n+$/, '')
}

// ---------------------------------------------------------------- show interface status / description / trunk

export function showInterfaceStatus(d: Device): string {
  const rows = [...d.interfaces]
    .filter((i) => ['mgmt', 'eth', 'po', 'lo', 'vlan'].includes(kind(i)))
    .sort((a, b) => (kind(a) === 'mgmt' ? -1 : kind(b) === 'mgmt' ? 1 : ifCompare(a, b)))
    .map((i) => {
      const st = i.errDisabled ? 'err-disabled' : !i.adminUp ? 'disabled' : operUp(d, i) ? 'connected' : 'notconnec'
      const vlan = i.mode === 'routed' ? 'routed' : i.mode === 'trunk' ? 'trunk' : String(i.vlan ?? 1)
      const virtual = kind(i) === 'lo' || kind(i) === 'vlan'
      const duplex = virtual ? 'auto' : operUp(d, i) ? resolvedDuplex(i) : 'auto'
      const type = virtual ? '--' : kind(i) === 'mgmt' ? '--' : kind(i) === 'po' ? '--' : `${i.media ?? i.speed}base-SR`.replace(/^(\d+)G/, '$1Gbase').replace('Gbasebase', 'Gbase')
      return `${pad(i.short, 14)}${pad((i.description ?? '--').slice(0, 18), 19)}${pad(st, 10)}${pad(vlan, 10)}${pad(duplex, 8)}${pad(virtual ? 'auto' : speedOf(d, i), 8)}${type}`
    })
  return ['', RULE, 'Port          Name               Status    Vlan      Duplex  Speed   Type', RULE, ...rows].join('\n')
}

export function showInterfaceDescription(d: Device): string {
  const ifs = [...d.interfaces].sort(ifCompare)
  const eth = ifs.filter((i) => kind(i) === 'eth' || kind(i) === 'mgmt')
  const other = ifs.filter((i) => kind(i) !== 'eth' && kind(i) !== 'mgmt')
  const R = '-'.repeat(79)
  return [
    '',
    R,
    'Port          Type   Speed   Description',
    R,
    ...eth.map((i) => `${pad(i.short, 14)}${pad('eth', 7)}${pad(kind(i) === 'mgmt' ? i.speed : speedOf(d, i), 8)}${i.description ?? '--'}`),
    '',
    R,
    'Interface                Description',
    R,
    ...other.map((i) => `${pad(i.short, 25)}${i.description ?? '--'}`)
  ].join('\n')
}

export function vlanList(v: number[]): string {
  const s = [...new Set(v)].sort((a, b) => a - b)
  const out: string[] = []
  for (let k = 0; k < s.length; ) {
    let j = k
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++
    out.push(j > k + 1 ? `${s[k]}-${s[j]}` : j === k + 1 ? `${s[k]},${s[j]}` : `${s[k]}`)
    k = j + 1
  }
  return out.join(',')
}

export function showInterfaceTrunk(d: Device): string {
  const trunks = [...d.interfaces].filter((i) => i.mode === 'trunk').sort(ifCompare)
  const allowed = (i: Iface): string => (i.trunkAllowed ? vlanList(i.trunkAllowed) || 'none' : '1-4094')
  return [
    '',
    RULE,
    'Port          Native  Status        Port',
    '              Vlan                  Channel',
    RULE,
    ...trunks.map((i) => `${pad(i.short, 14)}${pad(i.nativeVlan ?? 1, 8)}${pad(!operUp(d, i) ? 'not-trunking' : i.channelGroup !== undefined ? 'trnk-bndl' : 'trunking', 14)}${i.channelGroup !== undefined ? `Po${i.channelGroup}` : '--'}`),
    '',
    RULE,
    'Port          Vlans Allowed on Trunk',
    RULE,
    ...trunks.map((i) => `${pad(i.short, 14)}${allowed(i)}`),
    '',
    RULE,
    'Port          STP Forwarding',
    RULE,
    ...trunks.map((i) => `${pad(i.short, 14)}${operUp(d, i) && i.channelGroup === undefined ? vlanList(trunkVlans(d, i)) || 'none' : 'none'}`)
  ].join('\n')
}

// ---------------------------------------------------------------- show interface <x>

const bw = (speed: string): number => {
  const m = /^(\d+)(G?)$/.exec(speed)
  if (!m) return 1000000
  return Number(m[1]) * (m[2] ? 1000000 : 1000)
}

/**
 * Local workaround: state.ts ifaceCounters derives outPps from `(seed >> 4)` on an unsigned seed,
 * which goes negative for some names (e.g. Ethernet1/1). Clamp the derived TX values here.
 */
function counters(d: Device, i: Iface, t: number): ReturnType<typeof ifaceCounters> {
  const c = ifaceCounters(d, i, t)
  for (const k of ['outPps', 'outBps', 'outPkts', 'outBytes'] as const) c[k] = Math.abs(c[k])
  return c
}

export function showInterface(d: Device, i: Iface): string {
  const t = now(d)
  const up = operUp(d, i)
  const c = counters(d, i, t)
  const k = kind(i)
  const why = i.errDisabled ? ` (${i.errDisabled === 'bpduguard' ? 'BPDUGuard errDisabled' : 'errDisabled'})` : !i.adminUp ? ' (Administratively down)' : !up && k === 'eth' ? ' (Link not connected)' : ''
  const head = `${i.name} is ${up ? 'up' : 'down'}${why}`
  const lines: string[] = [head]
  if (k === 'lo') {
    lines.push(`admin state is ${i.adminUp ? 'up' : 'down'},`, '  Hardware: Loopback')
    if (i.description) lines.push(`  Description: ${i.description}`)
    if (i.ip) lines.push(`  Internet Address is ${i.ip}/${i.mask}`)
    lines.push(`  MTU ${i.mtu ?? 1500} bytes, BW 8000000 Kbit, DLY 5000 usec`, '  reliability 255/255, txload 1/255, rxload 1/255', '  Encapsulation LOOPBACK, medium is broadcast', '  Auto-mdix is turned off', '    0 packets input 0 bytes', '    0 multicast frames 0 compressed', '    0 input errors 0 frame 0 overrun 0 fifo', '    0 packets output 0 bytes 0 underruns', '    0 output errors 0 collisions 0 fifo', '    0 out_carrier_errors')
    return lines.join('\n')
  }
  if (k === 'vlan') {
    lines.push(`admin state is ${i.adminUp ? 'up' : 'down'}, Hardware: EtherSVI, address: ${i.mac} (bia ${i.mac})`)
    if (i.description) lines.push(`  Description: ${i.description}`)
    if (i.ip) lines.push(`  Internet Address is ${i.ip}/${i.mask}`)
    lines.push(`  MTU ${i.mtu ?? 1500} bytes, BW 1000000 Kbit, DLY 10 usec,`, '   reliability 255/255, txload 1/255, rxload 1/255', '  Encapsulation ARPA, loopback not set', '  Keepalive not supported', '  ARP type: ARPA', `  Last clearing of "show interface" counters ${i.clearedAt ? uptime(i.clearedAt, t) : 'never'}`, '  L3 in Switched:', `    ucast: ${c.inPkts} pkts, ${c.inBytes} bytes`)
    return lines.join('\n')
  }
  const dup = up ? `${resolvedDuplex(i)}-duplex` : 'auto-duplex'
  const sp = up ? (i.speed.endsWith('G') ? `${i.speed.slice(0, -1)} Gb/s` : `${i.speed} Mb/s`) : 'auto-speed'
  lines.push(`admin state is ${i.adminUp ? 'up' : 'down'}, Dedicated Interface`)
  if (k === 'po') lines.push(`  Hardware: Port-Channel, address: ${i.mac} (bia ${i.mac})`)
  else lines.push(`  Hardware: ${k === 'mgmt' ? 'GigabitEthernet' : '100/1000/10000/25000 Ethernet'}, address: ${i.mac} (bia ${i.mac})`)
  if (i.description) lines.push(`  Description: ${i.description}`)
  if (i.ip) lines.push(`  Internet Address is ${i.ip}/${i.mask}`)
  lines.push(
    `  MTU ${i.mtu ?? 1500} bytes, BW ${bw(i.speed)} Kbit , DLY 10 usec`,
    `  reliability 255/255, txload 1/255, rxload 1/255`,
    `  Encapsulation ARPA, medium is broadcast`,
    `  Port mode is ${i.mode}`,
    `  ${dup}, ${sp}${k === 'eth' ? `, media type is ${i.media ?? i.speed}` : ''}`
  )
  if (k === 'po') lines.push(`  Members in this channel: ${members(d, i).map((m) => m.short).join(', ')}`)
  if (i.channelGroup !== undefined) lines.push(`  Belongs to Po${i.channelGroup}`)
  lines.push(
    `  Beacon is turned off`,
    `  Auto-Negotiation is turned on  FEC mode is Auto`,
    `  Input flow-control is off, output flow-control is off`,
    `  Auto-mdix is turned off`,
    `  Rate mode is dedicated`,
    `  Switchport monitor is off `,
    `  EtherType is 0x8100 `,
    `  EEE (efficient-ethernet) : n/a`,
    `  Last link flapped ${uptime(i.lastChange ?? d.bootedAt, t)}`,
    `  Last clearing of "show interface" counters ${i.clearedAt ? uptime(i.clearedAt, t) : 'never'}`,
    `  ${i.lastChange ? 2 : 1} interface resets`,
    `  30 seconds input rate ${c.inBps} bits/sec, ${c.inPps} packets/sec`,
    `  30 seconds output rate ${c.outBps} bits/sec, ${c.outPps} packets/sec`,
    `  Load-Interval #2: 5 minute (300 seconds)`,
    `    input rate ${c.inBps} bps, ${c.inPps} pps; output rate ${c.outBps} bps, ${c.outPps} pps`,
    `  RX`,
    `    ${c.inPkts} unicast packets  0 multicast packets  0 broadcast packets`,
    `    ${c.inPkts} input packets  ${c.inBytes} bytes`,
    `    0 jumbo packets  0 storm suppression packets`,
    `    ${c.runts} runts  ${c.giants} giants  ${c.crc} CRC  0 no buffer`,
    `    ${c.inErrors} input error  0 short frame  ${c.overrun} overrun   0 underrun  ${c.ignored} ignored`,
    `    0 watchdog  0 bad etype drop  0 bad proto drop  0 if down drop`,
    `    0 input with dribble  0 input discard`,
    `    0 Rx pause`,
    `  TX`,
    `    ${c.outPkts} unicast packets  0 multicast packets  0 broadcast packets`,
    `    ${c.outPkts} output packets  ${c.outBytes} bytes`,
    `    0 jumbo packets`,
    `    ${c.outErrors} output error  ${c.collisions} collision  ${c.deferred} deferred  ${c.lateCollisions} late collision`,
    `    0 lost carrier  0 no carrier  0 babble  0 output discard`,
    `    0 Tx pause`
  )
  if (duplexMismatch(i)) lines.push(`  %% duplex mismatch suspected: far end runs ${i.peer?.duplex ?? 'auto'}`.replace('%% ', ''))
  return lines.join('\n')
}

export function showInterfaceCountersErrors(d: Device): string {
  const t = now(d)
  const ifs = [...d.interfaces].filter((i) => kind(i) === 'eth' || kind(i) === 'po' || kind(i) === 'mgmt').sort(ifCompare)
  const R = '-'.repeat(79)
  return [
    '',
    R,
    'Port          Align-Err    FCS-Err   Xmit-Err    Rcv-Err  UnderSize OutDiscards',
    R,
    ...ifs.map((i) => {
      const c = counters(d, i, t)
      return `${pad(i.short, 14)}${lpad(c.frame, 9)}${lpad(c.crc, 11)}${lpad(c.outErrors, 11)}${lpad(c.inErrors, 11)}${lpad(c.runts, 11)}${lpad(0, 12)}`
    }),
    '',
    R,
    'Port         Single-Col  Multi-Col   Late-Col  Exces-Col  Carri-Sen       Runts',
    R,
    ...ifs.map((i) => {
      const c = counters(d, i, t)
      return `${pad(i.short, 14)}${lpad(Math.floor(c.collisions / 2), 9)}${lpad(c.collisions - Math.floor(c.collisions / 2), 11)}${lpad(c.lateCollisions, 11)}${lpad(0, 11)}${lpad(0, 11)}${lpad(c.runts, 12)}`
    })
  ].join('\n')
}

// ---------------------------------------------------------------- L3 interfaces / VRFs

export function vrfNames(d: Device): string[] {
  return ['default', ...d.vrfs.map((v) => v.name)]
}

const ifVrf = (i: Iface): string => i.vrf ?? 'default'

export function showIpIntBrief(d: Device, vrf?: string): string {
  const names = vrf === 'all' ? vrfNames(d) : [vrf ?? 'default']
  const blocks: string[] = []
  for (const name of names) {
    const id = vrfNames(d).indexOf(name) + 1
    if (!id) return `% VRF ${name} not found`
    const ifs = d.interfaces.filter((i) => ifVrf(i) === name && i.ip).sort(ifCompare)
    if (vrf === 'all' && !ifs.length) continue
    const rows = ifs.map((i) => {
      const proto = operUp(d, i) ? 'up' : 'down'
      const link = i.adminUp && !i.errDisabled && i.linkUp ? 'up' : 'down'
      return `${pad(i.short, 21)}${pad(i.ip!, 16)}${pad(`protocol-${proto}/link-${link}/admin-${i.adminUp ? 'up' : 'down'}`, 35)}`
    })
    blocks.push([`IP Interface Status for VRF "${name}"(${id})`, 'Interface            IP Address      Interface Status', ...rows].join('\n'))
  }
  return blocks.join('\n\n')
}

export function showVrf(d: Device): string {
  const names = vrfNames(d)
  const rows = [...names].sort().map((n) => `${pad(n, 35)}${lpad(names.indexOf(n) + 1, 6)} ${pad('Up', 8)}--`)
  return ['VRF-Name                           VRF-ID State   Reason', ...rows].join('\n')
}

// ---------------------------------------------------------------- VLANs / port-channels / STP

export function vlanPorts(d: Device, id: number): string[] {
  return [...d.interfaces]
    .filter((p) => (kind(p) === 'eth' || kind(p) === 'po') && p.channelGroup === undefined)
    .filter((p) => (p.mode === 'access' && (p.vlan ?? 1) === id) || (p.mode === 'trunk' && operUp(d, p) && trunkVlans(d, p).includes(id)))
    .sort(ifCompare)
    .map((p) => p.short)
}

export function showVlan(d: Device, brief: boolean): string {
  const rows: string[] = []
  for (const v of [...d.vlans].sort((a, b) => a.id - b.id)) {
    const ports = vlanPorts(d, v.id)
    const chunks: string[] = []
    for (let k = 0; k < ports.length; k += 4) chunks.push(ports.slice(k, k + 4).join(', ') + (k + 4 < ports.length ? ',' : ''))
    rows.push(`${pad(v.id, 5)}${pad(v.name, 33)}${pad(v.shutdown ? 'sus/lshut' : 'active', 10)}${chunks[0] ?? ''}`.trimEnd())
    for (const c of chunks.slice(1)) rows.push(`${' '.repeat(48)}${c}`)
  }
  const out = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------', ...rows]
  if (!brief) out.push('', 'VLAN Type         Vlan-mode', '---- -----        ----------', ...[...d.vlans].sort((a, b) => a.id - b.id).map((v) => `${pad(v.id, 5)}${pad('enet', 13)}CE`))
  return out.join('\n')
}

export function showPortChannelSummary(d: Device): string {
  const pos = [...d.interfaces].filter((i) => kind(i) === 'po').sort(ifCompare)
  return [
    'Flags:  D - Down        P - Up in port-channel (members)',
    '        I - Individual  H - Hot-standby (LACP only)',
    '        s - Suspended   r - Module-removed',
    '        b - BFD Session Wait',
    '        S - Switched    R - Routed',
    '        U - Up (port-channel)',
    '        p - Up in delay-lacp mode (member)',
    '        M - Not in use. Min-links not met',
    RULE,
    'Group Port-       Type     Protocol  Member Ports',
    '      Channel',
    RULE,
    ...pos.map((p) => {
      const n = p.name.replace('port-channel', '')
      const flags = `${p.mode === 'routed' ? 'R' : 'S'}${operUp(d, p) ? 'U' : 'D'}`
      return `${pad(n, 6)}${pad(`${p.short}(${flags})`, 12)}${pad('Eth', 9)}${pad('LACP', 10)}${members(d, p).map((m) => pad(`${m.short}(${isUp(m) ? 'P' : 'D'})`, 13)).join('').trimEnd()}`
    })
  ].join('\n')
}

export function showSpanningTree(d: Device, vlan?: number): string {
  const vlans = [...d.vlans].filter((v) => (vlan === undefined ? true : v.id === vlan)).sort((a, b) => a.id - b.id)
  if (vlan !== undefined && !vlans.length) return `ERROR: No spanning tree instance exists for vlan ${vlan}`
  const mac = d.interfaces.find((i) => i.mac)?.mac ?? '00de.fb20.0000'
  return vlans
    .map((v) => {
      const ports = [...d.interfaces].filter((p) => (kind(p) === 'eth' || kind(p) === 'po') && p.channelGroup === undefined && operUp(d, p) && ((p.mode === 'access' && (p.vlan ?? 1) === v.id) || (p.mode === 'trunk' && trunkVlans(d, p).includes(v.id)))).sort(ifCompare)
      return [
        '',
        `VLAN${String(v.id).padStart(4, '0')}`,
        '  Spanning tree enabled protocol rstp',
        `  Root ID    Priority    ${32768 + v.id}`,
        `             Address     ${mac}`,
        '             This bridge is the root',
        '             Hello Time  2  sec  Max Age 20 sec  Forward Delay 15 sec',
        '',
        `  Bridge ID  Priority    ${32768 + v.id}  (priority 32768 sys-id-ext ${v.id})`,
        `             Address     ${mac}`,
        '             Hello Time  2  sec  Max Age 20 sec  Forward Delay 15 sec',
        '',
        'Interface        Role Sts Cost      Prio.Nbr Type',
        '---------------- ---- --- --------- -------- --------------------------------',
        ...ports.map((p) => `${pad(p.short, 17)}Desg FWD ${pad(p.speed === '100G' ? 100 : kind(p) === 'po' ? 1 : 200, 10)}${pad(`128.${ifNum(p).at(-1) ?? 1}`, 9)}${p.mode === 'trunk' ? 'P2p' : 'P2p Edge'}`)
      ].join('\n')
    })
    .join('\n')
}

// ---------------------------------------------------------------- MAC / ARP

export function showMacTable(d: Device, filter?: { kind: 'vlan' | 'interface' | 'address' | 'dynamic'; value?: string }): string {
  let rows = liveMacs(d)
  if (filter?.kind === 'vlan') rows = rows.filter((r) => String(r.vlan) === filter.value)
  else if (filter?.kind === 'interface') rows = rows.filter((r) => r.port === filter.value)
  else if (filter?.kind === 'address') {
    const want = (filter.value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').padStart(12, '0')
    rows = rows.filter((r) => r.mac.replace(/\./g, '') === want)
  } else if (filter?.kind === 'dynamic') rows = rows.filter((r) => r.type !== 'STATIC')
  const dyn = rows.filter((r) => r.type !== 'STATIC').sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
  const gw = rows.filter((r) => r.type === 'STATIC').sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
  return [
    'Legend:',
    '        * - primary entry, G - Gateway MAC, (R) - Routed MAC, O - Overlay MAC',
    '        age - seconds since last seen,+ - primary entry using vPC Peer-Link,',
    '        (T) - True, (F) - False',
    '     VLAN       MAC Address       Type     age    Secure  NTFY     Ports',
    '------------+-----------------+----------+-------+------+------+------------------',
    ...dyn.map((r) => `*    ${pad(r.vlan, 11)}${pad(r.mac, 17)}${pad('dynamic', 11)}${pad('0', 9)}${pad('F', 7)}${pad('F', 5)}${r.port}`),
    ...gw.map((r) => `G    ${pad(r.vlan, 9)}${pad(r.mac, 19)}${pad('static', 11)}${pad('-', 9)}${pad('F', 7)}${pad('F', 5)}${r.port}`)
  ].join('\n')
}

const ageHms = (mins: number): string => {
  const s = Math.round(mins * 60)
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}

export function showIpArp(d: Device, vrf?: string): string {
  const names = vrfNames(d)
  const want = vrf === 'all' ? names : [vrf ?? 'default']
  const entries = d.arp
    .map((a) => ({ a, i: d.interfaces.find((x) => x.name === a.iface) }))
    .filter((e) => e.i && operUp(d, e.i) && want.includes(ifVrf(e.i)))
    .sort((x, y) => names.indexOf(ifVrf(x.i!)) - names.indexOf(ifVrf(y.i!)))
  return [
    '',
    'Flags: * - Adjacencies learnt on non-active FHRP router',
    '       + - Adjacencies synced via CFSoE',
    '       # - Adjacencies Throttled for Glean',
    '       D - Static Adjacencies attached to down interface',
    '',
    vrf === 'all' ? 'IP ARP Table for all contexts' : `IP ARP Table for context ${want[0]}`,
    `Total number of entries: ${entries.length}`,
    'Address         Age       MAC Address     Interface',
    ...entries.map(({ a }) => `${pad(a.ip, 16)}${pad(ageHms(a.age), 10)}${pad(a.mac, 16)}${a.iface}`)
  ].join('\n')
}

export function showIpAdjacency(d: Device): string {
  const rows = d.arp.filter((a) => {
    const i = d.interfaces.find((x) => x.name === a.iface)
    return i && operUp(d, i) && !i.vrf
  })
  return [
    'Flags: # - Adjacencies Throttled for Glean',
    '       G - Adjacencies of vPC peer with G/W bit',
    '       R - Adjacencies learnt remotely',
    '',
    'IP Adjacency Table for VRF default',
    `Total number of entries: ${rows.length}`,
    'Address         MAC Address     Pref Source     Interface        Flags',
    ...rows.map((a) => `${pad(a.ip, 16)}${pad(a.mac, 16)}${pad('50', 5)}${pad('arp', 11)}${a.iface}`)
  ].join('\n')
}

// ---------------------------------------------------------------- routing

export interface Via {
  text: string
}
export interface Route {
  prefix: string
  mask: number
  attached: boolean
  vias: string[]
  proto: string
}

export function routes(d: Device, vrf = 'default'): Route[] {
  const t = now(d)
  const table = new Map<string, Route>()
  const put = (prefix: string, mask: number, via: string, proto: string, attached = false): void => {
    const k = `${prefix}/${mask}`
    const r = table.get(k) ?? { prefix, mask, attached, vias: [], proto }
    r.vias.push(via)
    r.attached ||= attached
    table.set(k, r)
  }
  const ifs = d.interfaces.filter((i) => ifVrf(i) === vrf && i.ip && i.mask !== undefined && operUp(d, i)).sort(ifCompare)
  const age = (i: Iface): string => uptime(i.lastChange ?? d.bootedAt, t)
  for (const i of ifs) {
    if (i.mask! < 32) {
      put(network(i.ip!, i.mask!), i.mask!, `*via ${i.ip}, ${i.short}, [0/0], ${age(i)}, direct`, 'direct', true)
      put(i.ip!, 32, `*via ${i.ip}, ${i.short}, [0/0], ${age(i)}, local`, 'local', true)
    } else {
      put(i.ip!, 32, `*via ${i.ip}, ${i.short}, [0/0], ${age(i)}, local`, 'local', true)
      put(i.ip!, 32, `*via ${i.ip}, ${i.short}, [0/0], ${age(i)}, direct`, 'direct', true)
    }
  }
  const connected = (ip: string): Iface | undefined => ifs.find((i) => i.mask! < 32 && inSubnet(ip, i.ip!, i.mask!))
  for (const r of d.staticRoutes) {
    if ((r.vrf ?? 'default') !== vrf || !connected(r.nextHop)) continue
    put(r.prefix, r.mask, `*via ${r.nextHop}${r.vrf && r.vrf !== vrf ? `%${r.vrf}` : ''}, [${r.ad ?? 1}/0], ${uptime(d.bootedAt, t)}, static`, 'static')
  }
  if (vrf === 'default') {
    const ospfR = (d.vendor['ospfRoutes'] as { prefix: string; mask: number; via: string; metric?: number }[] | undefined) ?? []
    for (const n of d.ospf?.neighbors ?? []) {
      if (ospfState(d, n) !== 'FULL') continue
      const i = d.interfaces.find((x) => x.name === n.iface)
      for (const r of ospfR.filter((x) => x.via === n.ip)) put(r.prefix, r.mask, `*via ${n.ip}, ${i?.short ?? n.iface}, [110/${r.metric ?? 41}], ${uptime(n.upSince ?? d.bootedAt, t)}, ospf-${d.ospf!.process}, intra`, 'ospf')
    }
  }
  for (const n of d.bgp) {
    if ((n.vrf ?? 'default') !== vrf || !bgpUp(n, t)) continue
    const ibgp = n.remoteAs === d.localAs
    for (const r of n.routes ?? []) {
      if (table.has(`${r.prefix}/${r.mask}`)) continue
      put(r.prefix, r.mask, `*via ${n.ip}, [${ibgp ? 200 : 20}/0], ${uptime(n.upSince!, t)}, bgp-${d.localAs}, ${ibgp ? 'internal' : 'external'}, tag ${n.remoteAs}`, 'bgp')
    }
  }
  return [...table.values()].sort((a, b) => cmpIp(a.prefix, b.prefix) || a.mask - b.mask)
}

const ROUTE_HEADER = (vrf: string): string[] => [`IP Route Table for VRF "${vrf}"`, "'*' denotes best ucast next-hop", "'**' denotes best mcast next-hop", "'[x/y]' denotes [preference/metric]", "'%<string>' in via output denotes VRF <string>", '']

const routeLines = (r: Route): string[] => [`${r.prefix}/${r.mask}, ubest/mbest: ${r.vias.length}/0${r.attached ? ', attached' : ''}`, ...r.vias.map((v) => `    ${v}`)]

export function showIpRoute(d: Device, vrf = 'default', target?: string): string {
  const names = vrf === 'all' ? vrfNames(d) : [vrf]
  const out: string[] = []
  for (const name of names) {
    if (!vrfNames(d).includes(name)) return `% VRF ${name} not found`
    let rs = routes(d, name)
    if (target) {
      const [ip, len] = target.split('/')
      const hit = len !== undefined ? rs.filter((r) => r.prefix === network(ip!, Number(len)) && r.mask === Number(len)) : rs.filter((r) => inSubnet(ip!, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask).slice(0, 1)
      if (!hit.length) {
        out.push(...ROUTE_HEADER(name), `Route not found`)
        continue
      }
      rs = hit
    }
    if (out.length) out.push('')
    out.push(...ROUTE_HEADER(name), ...rs.flatMap(routeLines))
  }
  return out.join('\n')
}

export function showIpRouteSummary(d: Device, vrf = 'default'): string {
  const rs = routes(d, vrf)
  const by = (p: string): number => rs.reduce((a, r) => a + r.vias.filter((v) => v.includes(p)).length, 0)
  return [
    `IP Route Table for VRF "${vrf}"`,
    `Total number of routes: ${rs.length}`,
    `Total number of paths:  ${rs.reduce((a, r) => a + r.vias.length, 0)}`,
    '',
    'Best paths per protocol:      Backup paths per protocol:',
    `  am             : ${by('local')}         None`,
    `  local          : ${by('local')}`,
    `  direct         : ${by('direct')}`,
    ...(by('static') ? [`  static         : ${by('static')}`] : []),
    ...(by('ospf-') ? [`  ospf-${d.ospf?.process ?? '1'}  : ${by('ospf-')}`] : []),
    ...(by('bgp-') ? [`  bgp-${d.localAs}      : ${by('bgp-')}`] : []),
    '',
    'Number of routes per mask-length:',
    ...[...new Set(rs.map((r) => r.mask))].sort((a, b) => a - b).map((m) => `  /${m}: ${rs.filter((r) => r.mask === m).length}`)
  ].join('\n')
}

// ---------------------------------------------------------------- BGP

const bgpState = (d: Device, n: BgpNeighbor, t: number): string => {
  if (bgpUp(n, t)) return String(n.prefixes)
  return neighborState(d, n, t)
}

export function bgpSummaryLines(d: Device, vrf = 'default'): string[] {
  const t = now(d)
  const peers = d.bgp.filter((n) => (n.vrf ?? 'default') === vrf)
  const up = peers.filter((n) => bgpUp(n, t))
  const ver = (d.vendor['bgpTableVersion'] as number | undefined) ?? 42
  const entries = up.reduce((a, n) => a + n.prefixes, 0) + 2
  return [
    `BGP summary information for VRF ${vrf}, address family IPv4 Unicast`,
    `BGP router identifier ${d.routerId}, local AS number ${d.localAs}`,
    `BGP table version is ${ver}, IPv4 Unicast config peers ${peers.length}, capable peers ${up.length}`,
    `${entries} network entries and ${entries} paths using ${entries * 244} bytes of memory`,
    `BGP attribute entries [${up.length + 1}/${(up.length + 1) * 352}], BGP AS path entries [${up.length}/${up.length * 6}]`,
    'BGP community entries [0/0], BGP clusterlist entries [0/0]',
    '',
    'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
    ...peers.map((n) => {
      const isUpN = bgpUp(n, t)
      const ud = isUpN ? uptime(n.upSince!, t) : n.downSince !== undefined ? uptime(n.downSince, t) : 'never'
      return `${pad(n.ip, 16)}4${lpad(n.remoteAs, 13)}${lpad(isUpN ? (n.msgRcvd ?? 0) : 0, 8)}${lpad(isUpN ? (n.msgSent ?? 0) : 0, 8)}${lpad(isUpN ? ver : 0, 10)}${lpad(0, 5)}${lpad(0, 5)} ${pad(ud, 8)}${lpad(bgpState(d, n, t), 13)}`
    })
  ]
}

export function showBgpSummary(d: Device, vrf = 'default'): string {
  if (vrf === 'all') {
    const names = vrfNames(d).filter((v) => v === 'default' || d.bgp.some((n) => n.vrf === v))
    return names.map((v) => bgpSummaryLines(d, v).join('\n')).join('\n\n')
  }
  return bgpSummaryLines(d, vrf).join('\n')
}

export function showBgpNeighbors(d: Device, ip?: string): string {
  const t = now(d)
  const list = ip ? d.bgp.filter((n) => n.ip === ip) : d.bgp
  if (ip && !list.length) return `BGP neighbor ${ip} not found`
  return list
    .map((n) => {
      const isUpN = bgpUp(n, t)
      const st = isUpN ? 'Established' : neighborState(d, n, t) === 'Idle (Admin)' ? 'Idle' : neighborState(d, n, t)
      const blocker = bgpBlocker(d, n)
      const ebgp = n.remoteAs !== d.localAs
      const lines = [
        `BGP neighbor is ${n.ip}, remote AS ${n.remoteAs}, ${ebgp ? 'ebgp' : 'ibgp'} link, Peer index ${d.bgp.indexOf(n) + 3}`,
        ...(n.description ? [`  Description: ${n.description}`] : []),
        `  BGP version 4, remote router ID ${isUpN ? (n.routerId ?? '0.0.0.0') : '0.0.0.0'}`,
        `  Neighbor previous state = ${isUpN ? 'OpenConfirm' : 'Idle'}`,
        `  BGP state = ${st}${isUpN ? `, up for ${uptime(n.upSince!, t)}` : `, down for ${n.downSince !== undefined ? uptime(n.downSince, t) : 'never'}${n.shutdown ? ', Shutdown (Admin)' : ''}`}`,
        `  Neighbor vrf: ${n.vrf ?? 'default'}`,
        ...(n.updateSource ? [`  Using ${n.updateSource} as update source for this peer`] : []),
        ...(blocker === 'wrong-as' ? [`  Last reset by us ${n.downSince !== undefined ? uptime(n.downSince, t) : '00:00:01'}, due to bad peer AS`, `  Notification sent: OPEN Message Error, Bad Peer AS (peer sent AS ${n.peerAs})`] : []),
        `  Last read ${isUpN ? '00:00:03' : 'never'}, hold time = 180, keepalive interval is 60 seconds`,
        `  Last written ${isUpN ? '00:00:41' : 'never'}, keepalive timer expiry due 00:00:18`,
        `  Received ${isUpN ? (n.msgRcvd ?? 0) : 0} messages, 0 notifications, 0 bytes in queue`,
        `  Sent ${isUpN ? (n.msgSent ?? 0) : 0} messages, ${blocker === 'wrong-as' ? 1 : 0} notifications, 0(0) bytes in queue`,
        `  Connections established ${isUpN ? 1 : 0}, dropped ${n.downSince !== undefined ? 1 : 0}`,
        '',
        '  For address family: IPv4 Unicast',
        `  BGP table version ${(d.vendor['bgpTableVersion'] as number | undefined) ?? 42}, neighbor version ${isUpN ? ((d.vendor['bgpTableVersion'] as number | undefined) ?? 42) : 0}`,
        `  ${isUpN ? n.prefixes : 0} accepted prefixes (${isUpN ? n.prefixes : 0} paths), consuming ${(isUpN ? n.prefixes : 0) * 240} bytes of memory`,
        ...(n.routeMapIn ? [`  Inbound route-map configured is ${n.routeMapIn}, handle obtained`] : []),
        ...(n.routeMapOut ? [`  Outbound route-map configured is ${n.routeMapOut}, handle obtained`] : []),
        '',
        `  Local host: ${d.interfaces.find((i) => i.name === (n.updateSource ?? n.via))?.ip ?? '0.0.0.0'}, Local port: ${isUpN ? 179 : 0}`,
        `  Foreign host: ${n.ip}, Foreign port: ${isUpN ? 50413 : 0}`
      ]
      return lines.join('\n')
    })
    .join('\n\n')
}

export function showIpBgp(d: Device, neighbor?: string, which?: 'advertised-routes' | 'received-routes' | 'routes'): string {
  const t = now(d)
  const rows: string[] = []
  const local = d.interfaces.filter((i) => i.name.startsWith('loopback') && i.ip && !i.vrf && operUp(d, i))
  if (!neighbor || which === 'advertised-routes') for (const i of local) rows.push(`*>l${pad(`${i.ip}/32`, 19)}${pad('0.0.0.0', 26)}${lpad(100, 7)}${lpad(32768, 11)} i`)
  for (const n of d.bgp) {
    if (neighbor && n.ip !== neighbor) continue
    if (which === 'advertised-routes') continue
    if (!bgpUp(n, t)) continue
    for (const r of n.routes ?? []) rows.push(`*>e${pad(`${r.prefix}/${r.mask}`, 19)}${pad(n.ip, 26)}${lpad('', 7)}${lpad(0, 11)} ${n.remoteAs} i`)
  }
  if (neighbor && !d.bgp.some((n) => n.ip === neighbor)) return `BGP neighbor ${neighbor} not found`
  return [
    `BGP routing table information for VRF default, address family IPv4 Unicast`,
    `BGP table version is ${(d.vendor['bgpTableVersion'] as number | undefined) ?? 42}, Local Router ID is ${d.routerId}`,
    'Status: s-suppressed, x-deleted, S-stale, d-dampened, h-history, *-valid, >-best',
    'Path type: i-internal, e-external, c-confed, l-local, a-aggregate, r-redist, I-injected',
    'Origin codes: i - IGP, e - EGP, ? - incomplete, | - multipath, & - backup, 2 - best2',
    '',
    '   Network            Next Hop            Metric     LocPrf     Weight Path',
    ...rows
  ].join('\n')
}

// ---------------------------------------------------------------- OSPF

export function showOspfNeighbors(d: Device): string {
  const t = now(d)
  if (!d.ospf) return ''
  const rows: string[] = []
  for (const n of d.ospf.neighbors) {
    const st = ospfState(d, n)
    if (!st) continue
    const i = d.interfaces.find((x) => x.name === n.iface)
    const role = n.role && n.role !== '-' ? n.role : ' -'
    const since = st === 'FULL' ? (n.upSince ?? d.bootedAt) : (i?.lastChange ?? t - 37_000)
    rows.push(` ${pad(n.routerId, 16)}${lpad(n.pri, 3)} ${pad(`${st}/${role}`, 17)}${pad(uptime(since, t), 9)}${pad(n.ip, 16)}${i?.short ?? n.iface}`)
  }
  return [` OSPF Process ID ${d.ospf.process} VRF default`, ` Total number of neighbors: ${rows.length}`, ' Neighbor ID     Pri State            Up Time  Address         Interface', ...rows].join('\n')
}

export function showOspfIntBrief(d: Device): string {
  if (!d.ospf) return ''
  const rows = d.ospf.ifaces.map((o, k) => {
    const i = d.interfaces.find((x) => x.name === o.iface)
    const nb = d.ospf!.neighbors.filter((n) => n.iface === o.iface && ospfState(d, n)).length
    const st = !i || !operUp(d, i) ? 'DOWN' : kind(i) === 'lo' ? 'LOOPBACK' : o.networkType === 'point-to-point' ? 'P2P' : 'DR'
    return ` ${pad(i?.short ?? o.iface, 24)}${pad(k + 1, 7)}${pad(o.area, 16)}${pad(o.cost ?? (kind(i!) === 'lo' ? 1 : 40), 7)}${pad(st, 9)}${pad(nb, 10)}${i && i.adminUp ? 'up' : 'down'}  `
  })
  return [` OSPF Process ID ${d.ospf.process} VRF default`, ` Total number of interface: ${rows.length}`, ' Interface               ID     Area            Cost   State    Neighbors Status', ...rows].join('\n')
}

export function showOspf(d: Device): string {
  if (!d.ospf) return ''
  const full = d.ospf.neighbors.filter((n) => ospfState(d, n) === 'FULL').length
  return [
    '',
    ` Routing Process ${d.ospf.process} with ID ${d.ospf.routerId ?? d.routerId} VRF default`,
    ' Routing Process Instance Number 1',
    ' Stateful High Availability enabled',
    ' Graceful-restart is configured',
    '   Grace period: 60 state: Inactive ',
    ' Supports only single TOS(TOS0) routes',
    ' Supports opaque LSA',
    ' Administrative distance 110',
    ' Reference Bandwidth is 40000 Mbps',
    ' Area BACKBONE(0.0.0.0) ',
    `        Area has existed for ${uptime(d.bootedAt, now(d))}`,
    `        Interfaces in this area: ${d.ospf.ifaces.length} Active interfaces: ${d.ospf.ifaces.filter((o) => { const i = d.interfaces.find((x) => x.name === o.iface); return i && operUp(d, i) }).length}`,
    `        Passive interfaces: ${d.ospf.ifaces.filter((o) => o.passive).length}  Loopback interfaces: ${d.ospf.ifaces.filter((o) => o.iface.startsWith('loopback')).length}`,
    `        Adjacencies FULL: ${full}`
  ].join('\n')
}

// ---------------------------------------------------------------- CDP / LLDP

export interface CdpNeighbor {
  local: string
  device: string
  holdtime: number
  caps: string
  platform: string
  port: string
}

const localUp = (d: Device, local: string): boolean => {
  const i = d.interfaces.find((x) => x.short === local || x.name === local)
  return !!i && operUp(d, i)
}

export function cdpNeighbors(d: Device): CdpNeighbor[] {
  if (d.services['cdp'] === false) return []
  // Lab links mark Cisco-to-Cisco LLDP entries with `cdp`; the factory's own CDP table covers the rest.
  const lab: CdpNeighbor[] = d.lldp.filter((n) => n.cdp).map((n) => ({ local: n.local, device: n.device, holdtime: 150, caps: (n.caps ?? '').includes('R') ? 'R S I s' : 'S I s', platform: n.platform ?? '', port: n.port }))
  const covered = new Set(lab.map((n) => n.local))
  const own = ((d.vendor['cdp'] as CdpNeighbor[] | undefined) ?? []).filter((n) => !covered.has(n.local) && (n.local.startsWith('mgmt') || d.lldp.some((l) => l.local === n.local)))
  return [...own, ...lab].filter((n) => localUp(d, n.local))
}

export function showCdp(d: Device, detail: boolean): string {
  const ns = cdpNeighbors(d)
  if (detail) {
    return ns
      .map((n) =>
        [
          '----------------------------------------',
          `Device ID:${n.device}`,
          '',
          'Interface address(es):',
          `    IPv4 Address: ${d.lldp.find((l) => l.local === n.local)?.ip ?? '0.0.0.0'}`,
          `Platform: ${n.platform}, Capabilities: ${n.caps.replace(/R/, 'Router').replace(/ S/, ' Switch').replace(/ I/, ' IGMP Filtering').replace(/ s$/, ' Supports-STP-Dispute')}`,
          `Interface: ${d.interfaces.find((i) => i.short === n.local)?.name ?? n.local}, Port ID (outgoing port): ${n.port}`,
          `Holdtime: ${n.holdtime} sec`
        ].join('\n')
      )
      .join('\n\n')
  }
  const rows: string[] = []
  for (const n of ns) {
    if (n.device.length > 18) rows.push(n.device, `${' '.repeat(20)}${pad(n.local, 15)}${pad(n.holdtime, 7)}${pad(n.caps, 10)}${pad(n.platform, 14)}${n.port}`)
    else rows.push(`${pad(n.device, 19)}${pad(n.local, 15)}${pad(n.holdtime, 7)}${pad(n.caps, 12)}${pad(n.platform, 14)}${n.port}`)
  }
  return [
    'Capability Codes: R - Router, T - Trans-Bridge, B - Source-Route-Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater,',
    '                  V - VoIP-Phone, D - Remotely-Managed-Device,',
    '                  s - Supports-STP-Dispute',
    '',
    'Device-ID          Local Intrfce  Hldtme Capability  Platform      Port ID',
    ...rows,
    '',
    `Total entries displayed: ${ns.length}`
  ].join('\n')
}

export function lldpNeighbors(d: Device): Device['lldp'] {
  return d.lldp.filter((n) => !n.noLldp && localUp(d, n.local))
}

export function showLldp(d: Device, detail: boolean): string {
  const ns = lldpNeighbors(d)
  if (detail) {
    return [
      'Capability codes:',
      '  (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
      '  (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
      ...ns.map((n) =>
        [
          `Device ID            Local Intf      Hold-time  Capability  Port ID  `,
          '',
          `Chassis id: ${n.device}`,
          `Port id: ${n.port}`,
          `Local Port id: ${n.local}`,
          `Port Description: ${n.port}`,
          `System Name: ${n.device}`,
          `System Description: ${n.sysDescr ?? ''}`,
          `Time remaining: ${n.holdtime ?? 120} seconds`,
          `System Capabilities: ${n.caps ?? 'B'}`,
          `Enabled Capabilities: ${n.caps ?? 'B'}`,
          `Management Address: ${n.ip ?? 'not advertised'}`,
          'Vlan ID: not advertised',
          ''
        ].join('\n')
      ),
      `Total entries displayed: ${ns.length}`
    ].join('\n')
  }
  const rows: string[] = []
  for (const n of ns) {
    const tail = `${pad(n.local, 16)}${pad(n.holdtime ?? 120, 11)}${pad((n.caps ?? 'B').replace(/,/g, ''), 12)}${pad(n.port, 14)}`
    if (n.device.length > 20) rows.push(n.device, ' '.repeat(21) + tail)
    else rows.push(pad(n.device, 21) + tail)
  }
  return [
    'Capability codes:',
    '  (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
    '  (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
    'Device ID            Local Intf      Hold-time  Capability  Port ID  ',
    ...rows,
    `Total entries displayed: ${ns.length}`
  ].join('\n')
}

// ---------------------------------------------------------------- system

export function showVersion(d: Device): string {
  const t = now(d)
  const s = Math.max(0, Math.floor((t - d.bootedAt) / 1000))
  const days = Math.floor(s / 86400)
  const hrs = Math.floor((s % 86400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  const img = d.version.replace(/[()]/g, '.').replace(/\.$/, '').replace(/\.(\d+)\.(\d+)\.?([a-z]?)/, '.$1.$2$3')
  return `Cisco Nexus Operating System (NX-OS) Software
TAC support: http://www.cisco.com/tac
Copyright (C) 2002-2023, Cisco and/or its affiliates.
All rights reserved.
The copyrights to certain works contained in this software are
owned by other third parties and used and distributed under their own
licenses, such as open source.  This software is provided "as is," and unless
otherwise stated, there is no warranty, express or implied, including but not
limited to warranties of merchantability and fitness for a particular purpose.
Certain components of this software are licensed under
the GNU General Public License (GPL) version 2.0 or
GNU General Public License (GPL) version 3.0  or the GNU
Lesser General Public License (LGPL) Version 2.1 or
Lesser General Public License (LGPL) Version 2.0.
A copy of each such license is available at
http://www.opensource.org/licenses/gpl-2.0.php and
http://opensource.org/licenses/gpl-3.0.html and
http://www.opensource.org/licenses/lgpl-2.1.php and
http://www.gnu.org/licenses/old-licenses/library.txt.

Software
  BIOS: version 05.47
  NXOS: version ${d.version} [Maintenance Release]
  Host NXOS: version ${d.version}
  BIOS compile time:  04/28/2022
  NXOS image file is: bootflash:///nxos64-cs.${img}.M.bin
  NXOS compile time:  10/3/2023 12:00:00 [10/04/2023 01:37:52]
  NXOS boot mode: LXC

Hardware
  cisco Nexus9000 ${d.model.replace(/^N9K-/, '')} Chassis
  Intel(R) Xeon(R) CPU D-1528 @ 1.90GHz with 24569028 kB of memory.
  Processor Board ID ${d.serial}
  Device name: ${d.hostname}
  bootflash:  115805708 kB

Kernel uptime is ${days} day(s), ${hrs} hour(s), ${mins} minute(s), ${secs} second(s)

Last reset at 431208 usecs after ${nxDate(d.bootedAt)}
  Reason: Reset Requested by CLI command reload
  System version: ${d.version}
  Service:

plugin
  Core Plugin, Ethernet Plugin

Active Package(s):
`
}

export function versionJson(d: Device): Record<string, unknown> {
  const s = Math.max(0, Math.floor((now(d) - d.bootedAt) / 1000))
  return {
    header_str: 'Cisco Nexus Operating System (NX-OS) Software',
    bios_ver_str: '05.47',
    kickstart_ver_str: d.version,
    nxos_ver_str: d.version,
    bios_cmpl_time: '04/28/2022',
    nxos_file_name: `bootflash:///nxos64-cs.${d.version}.M.bin`,
    chassis_id: `Nexus9000 ${d.model.replace(/^N9K-/, '')} Chassis`,
    cpu_name: 'Intel(R) Xeon(R) CPU D-1528 @ 1.90GHz',
    memory: 24569028,
    mem_type: 'kB',
    proc_board_id: d.serial,
    host_name: d.hostname,
    bootflash_size: 115805708,
    kern_uptm_days: Math.floor(s / 86400),
    kern_uptm_hrs: Math.floor((s % 86400) / 3600),
    kern_uptm_mins: Math.floor((s % 3600) / 60),
    kern_uptm_secs: s % 60,
    rr_usecs: 431208,
    rr_ctime: nxDate(d.bootedAt),
    rr_reason: 'Reset Requested by CLI command reload',
    rr_sys_ver: d.version,
    rr_service: null,
    manufacturer: 'Cisco Systems, Inc.'
  }
}

export function showLogging(d: Device, last?: number): string {
  const lines = d.log.map((l) => `${logDate(l.t)} ${d.hostname} ${l.msg}`)
  return (last !== undefined ? lines.slice(-last) : lines).join('\n')
}

export function showClock(d: Device): string {
  const dt = new Date(now(d))
  return `${hms(dt)}.${String(dt.getUTCMilliseconds()).padStart(3, '0')} UTC ${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()} ${dt.getUTCFullYear()}\nTime source is NTP`
}

const FEATURES = ['bash-shell', 'bfd', 'bgp', 'dhcp', 'eigrp', 'hsrp', 'interface-vlan', 'lacp', 'lldp', 'nv overlay', 'nxapi', 'ospf', 'pim', 'scp-server', 'ssh', 'telnet', 'tunnel', 'vpc']
export const KNOWN_FEATURES = FEATURES

export function showFeature(d: Device): string {
  return ['Feature Name          Instance  State', '--------------------  --------  --------', ...FEATURES.map((f) => `${pad(f, 23)}${pad('1', 11)}${feature(d, f) || f === 'ssh' ? 'enabled' : 'disabled'}`)].join('\n')
}

export function showProcessesCpu(d: Device, sorted: boolean): string {
  const hog = d.cpu.hog && (!d.cpu.hog.whileService || d.services[d.cpu.hog.whileService]) ? d.cpu.hog : undefined
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  if (sorted) procs = procs.sort((a, b) => b.pct - a.pct || a.pid - b.pid)
  const [five] = cpuLoad(d)
  const user = Math.max(0, five - 1)
  return [
    '',
    'PID    Runtime(ms)  Invoked   uSecs  1Sec    Process',
    '-----  -----------  --------  -----  ------  -----------',
    ...procs.map((p) => {
      const rt = 1000 + p.pid * 7 + Math.floor(p.pct * 90000)
      const inv = 300 + (p.pid % 997) * 13
      return `${pad(p.pid, 7)}${lpad(rt, 11)}  ${lpad(inv, 8)}  ${lpad(Math.floor((rt / inv) * 1000), 5)}  ${lpad(`${p.pct.toFixed(1)}%`, 6)}  ${p.name}`
    }),
    '',
    `CPU util  :   ${lpad(user.toFixed(2), 5)}% user,   ${lpad('1.00', 5)}% kernel,   ${lpad((100 - user - 1).toFixed(2), 5)}% idle`,
    'Please note that only processes from the requested vdc are shown above'
  ].join('\n')
}

export function showSystemResources(d: Device): string {
  const [five, , one, fivem] = cpuLoad(d)
  return [
    `Load average:   1 minute: ${(one / 25).toFixed(2)}   5 minutes: ${(fivem / 25).toFixed(2)}   15 minutes: ${(fivem / 25).toFixed(2)}`,
    'Processes   :   812 total, 1 running',
    `CPU states  :   ${Math.max(0, five - 1).toFixed(2)}% user,   1.00% kernel,   ${(99 - Math.max(0, five - 1)).toFixed(2)}% idle`,
    'Memory usage:   24569028K total,  9876543K used, 14692485K free',
    'Kernel vmalloc:   0K total,   0K free',
    'Kernel buffers:   234567K Used',
    'Kernel cached :   5432109K Used',
    '',
    'Current memory status: OK'
  ].join('\n')
}

export function showAccessLists(d: Device, name?: string): string {
  const list = name ? d.acls.filter((a) => a.name === name) : d.acls
  return list
    .map((a) => [``, `IP access list ${a.name}`, ...a.entries.map((e) => `        ${e.seq} ${e.action} ${e.text}${e.hits ? ` [match=${e.hits}]` : ''}`)].join('\n'))
    .join('\n')
}

export function showPrefixList(d: Device, name?: string): string {
  const list = name ? d.prefixLists.filter((p) => p.name === name) : d.prefixLists
  return list.map((p) => [`ip prefix-list ${p.name}: ${p.entries.length} entries`, ...p.entries.map((e) => `   seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''} `)].join('\n')).join('\n')
}

export function showRouteMap(d: Device, name?: string): string {
  const list = name ? d.routeMaps.filter((r) => r.name === name) : d.routeMaps
  return list
    .flatMap((r) =>
      r.entries.map((e) => [`route-map ${r.name}, ${e.action}, sequence ${e.seq} `, '  Match clauses:', ...e.match.map((m) => `    ${m} `), '  Set clauses:', ...e.set.map((s) => `    ${s} `)].join('\n'))
    )
    .join('\n')
}
