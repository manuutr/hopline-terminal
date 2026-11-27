/**
 * Vendor-neutral, plain-data model of a simulated device. Config commands mutate it, show commands
 * render it, and fault scenarios change its "physical truth" (peer AS, peer MTU, far-end duplex,
 * a CPU hog) so the symptoms are derived and the right fix clears them.
 *
 * Everything here must stay structuredClone-able: runtime things (timers, sessions) live in
 * core/runtime.ts. Device factories live in devices/ and are re-exported here.
 */
import { now as clockNow } from './core/runtime.ts'

/** Platform ids; the same ids as @hopline/cli-model profiles where they overlap. */
export type SimPlatform = 'ios' | 'nxos' | 'eos' | 'junos' | 'panos' | 'fortios' | 'iosxr' | 'asa' | 'aireos' | 'c9800' | 'aoscx' | 'vrp' | 'routeros'

export interface Counters {
  inPkts: number
  inBytes: number
  outPkts: number
  outBytes: number
  inErrors: number
  crc: number
  frame: number
  overrun: number
  ignored: number
  runts: number
  giants: number
  outErrors: number
  collisions: number
  lateCollisions: number
  deferred: number
  resets: number
  inBps: number
  outBps: number
  inPps: number
  outPps: number
}

export interface Iface {
  name: string
  short: string
  ip?: string
  mask?: number
  description?: string
  adminUp: boolean
  /** Physical link (cable plugged, far end up). */
  linkUp: boolean
  vlan?: number
  mode: 'routed' | 'access' | 'trunk'
  /** Nominal speed as shown in tables: '1000', '100', '10G', '25G', 'auto' or '' for virtual. */
  speed: string
  mac: string
  /** How the address was learned, for IOS `show ip interface brief` Method. */
  ipMethod?: 'NVRAM' | 'manual' | 'unset' | 'DHCP'
  mtu?: number
  /** Configured duplex; undefined = auto. */
  duplex?: 'auto' | 'full' | 'half'
  /** Configured speed; undefined = auto. */
  speedSet?: string
  /** Allowed VLANs on a trunk; undefined = all. */
  trunkAllowed?: number[]
  nativeVlan?: number
  vrf?: string
  /** Err-disabled cause (e.g. 'bpduguard'); the port is down while set. */
  errDisabled?: string
  bpduGuard?: boolean
  channelGroup?: number
  /** Media type shown in status tables. */
  media?: string
  /** Security zone (PAN-OS, FortiOS, SRX). */
  zone?: string
  /** FortiOS alias / allowaccess. */
  alias?: string
  allowaccess?: string[]
  /** Junos/PAN-OS logical unit numbers configured under the interface. */
  units?: number[]
  /** Far-end facts for derived faults: duplex/speed mismatch, MTU mismatch. */
  peer?: { duplex?: 'auto' | 'full' | 'half'; speed?: string; mtu?: number }
  /** Static error counters (on top of derived ones). */
  errors?: Partial<Counters>
  /** When the counters were last cleared (ms epoch); default boot. */
  clearedAt?: number
  /** When derived error growth started (scenario). */
  faultSince?: number
  /** Last link state change (ms epoch). */
  lastChange?: number
  /** CRC errors added per minute since `faultSince` (a bad cable or optic; duplex stays matched). */
  crcRate?: number
  /** Port security (shown by the scenario renderers in scenarios/extra.ts). */
  portSecurity?: { max: number; violation: 'shutdown' | 'restrict' | 'protect'; violations: number; lastMac?: string; lastVlan?: number }
}

export interface BgpNeighbor {
  ip: string
  /** Configured remote AS. */
  remoteAs: number
  /** The AS the peer really uses; defaults to remoteAs. A mismatch keeps the session down. */
  peerAs?: number
  description?: string
  /** Interface the neighbor is reached through; BGP is Idle while it is down. */
  via: string
  prefixes: number
  upSince?: number
  /** `neighbor X shutdown`. */
  shutdown?: boolean
  /** Remote router ID once established. */
  routerId?: string
  vrf?: string
  routeMapIn?: string
  routeMapOut?: string
  /** Routes learned from this peer when established. */
  routes?: { prefix: string; mask: number }[]
  msgRcvd?: number
  msgSent?: number
  /** Down since (for the Up/Down column of a down peer). */
  downSince?: number
  password?: string
  updateSource?: string
  /** The MD5 password the far end uses; differing from `password` keeps the session down. */
  peerPassword?: string
  /** A local ACL / firewall filter (by name) that drops TCP 179 to or from this peer. */
  filteredBy?: string
  /** The far end refuses the session (its side of a link-level fault; used by the topology lab). */
  peerRefuses?: boolean
}

export interface OspfNeighbor {
  routerId: string
  ip: string
  /** Full local interface name. */
  iface: string
  pri: number
  area: string
  /** MTU the neighbor advertises in its DBD; a mismatch sticks the adjacency in EXSTART. */
  peerMtu?: number
  role?: 'DR' | 'BDR' | 'DROTHER' | '-'
  upSince?: number
  /** Hello interval the neighbor sends (seconds); differing from ours blocks the adjacency. */
  peerHello?: number
  /** Area the neighbor puts this link in; differing from ours blocks the adjacency. */
  peerArea?: string
}

export interface OspfConfig {
  process: string
  routerId?: string
  ifaces: { iface: string; area: string; cost?: number; mtuIgnore?: boolean; passive?: boolean; networkType?: 'broadcast' | 'point-to-point'; /** Hello interval, seconds (default 10). */ hello?: number }[]
  neighbors: OspfNeighbor[]
}

export interface AclEntry {
  seq: number
  action: 'permit' | 'deny' | 'remark'
  text: string
  hits?: number
}
export interface Acl {
  name: string
  type: 'standard' | 'extended'
  entries: AclEntry[]
}
export interface RouteMapEntry {
  seq: number
  action: 'permit' | 'deny'
  match: string[]
  set: string[]
  hits?: number
}
export interface RouteMap {
  name: string
  entries: RouteMapEntry[]
}
export interface PrefixListEntry {
  seq: number
  action: 'permit' | 'deny'
  prefix: string
  ge?: number
  le?: number
}
export interface PrefixList {
  name: string
  entries: PrefixListEntry[]
}

export interface MacEntry {
  vlan: number
  mac: string
  port: string
  type?: 'DYNAMIC' | 'STATIC'
}

export interface LldpNeighbor {
  local: string
  device: string
  port: string
  /** LLDP capability letters, e.g. 'R', 'B,R'. */
  caps?: string
  /** CDP: only Cisco devices speak it. */
  cdp?: boolean
  /** Speaks CDP only (not listed by LLDP). */
  noLldp?: boolean
  platform?: string
  ip?: string
  holdtime?: number
  /** Remote system description (show lldp neighbors detail). */
  sysDescr?: string
  /** LLDP chassis id as the platform prints it. */
  chassisId?: string
  /** Local parent (LAG) interface, '-' when none (Junos). */
  parent?: string
}

export interface ArpEntry {
  ip: string
  mac: string
  iface: string
  /** Minutes. */
  age: number
}

export interface StaticRoute {
  prefix: string
  mask: number
  nextHop: string
  vrf?: string
  name?: string
  ad?: number
}

export interface Process {
  pid: number
  name: string
  /** CPU percent (5 s). */
  pct: number
}

export interface Device {
  platform: SimPlatform
  hostname: string
  model: string
  serial: string
  version: string
  bootedAt: number
  localAs: number
  routerId: string
  /** Default login user shown in docs (Junos `netops`, PAN-OS `admin`). */
  user: string
  interfaces: Iface[]
  vlans: { id: number; name: string; shutdown?: boolean }[]
  vrfs: { name: string; rd: string; interfaces: string[] }[]
  bgp: BgpNeighbor[]
  ospf?: OspfConfig
  mac: MacEntry[]
  lldp: LldpNeighbor[]
  arp: ArpEntry[]
  staticRoutes: StaticRoute[]
  /** Lab IPsec associations and packet counters at the time of the simulated incident. */
  ipsec?: { name: string; iface: string; underlay: string; peer: string; rx: number; tx: number }[]
  acls: Acl[]
  routeMaps: RouteMap[]
  prefixLists: PrefixList[]
  /** Services that change behavior (e.g. `ip http server` feeds the HTTP CORE CPU hog). */
  services: Record<string, boolean>
  /** Base CPU utilisation (5 s, 1 min, 5 min) and the process table. */
  cpu: { load: [number, number, number]; processes: Process[]; hog?: { pid: number; name: string; pct: number; whileService?: string } }
  /** Login banner (MOTD). */
  motd?: string
  /** What remote routers do with a prefix (routing-loop scenario). */
  remoteRoutes?: { prefix: string; mask: number; at: string; via: string }[]
  /** Raw config lines the vendor accepts but does not model; echoed into running-config. */
  extraConfig: string[]
  /** Syslog buffer shown by "show logging". */
  log: { t: number; msg: string }[]
  /** Messages logged before the buffer started (for "N messages logged" counters). */
  logBase?: number
  /** Last saved config (startup); undefined = never diverged from boot. */
  startup?: ConfigSnapshot
  /** Vendor-specific persistent data (Junos candidate and rollbacks, NX-OS checkpoints, ...). */
  vendor: Record<string, unknown>
  /** SSH software version the server announces after `SSH-2.0-` (fingerprinting), e.g. `Cisco-1.25`. */
  sshIdent?: string
  /** Scenario ids applied to this device (scenarios are idempotent). */
  scenarios: string[]
  /**
   * Spanning tree as observed, when something other than this bridge is root (stp-root-moved).
   * Absent: this bridge is root for every VLAN (the vendors' default rendering).
   */
  stp?: { vlans: number[]; rootPriority: number; rootMac: string; rootPort: string; rootCost: number; changedAt: number; changes: number }
  /** First-hop redundancy groups (HSRP on Cisco, VRRP elsewhere), rendered by scenarios/extra.ts. */
  fhrp?: FhrpGroup[]
  /** SNMP sysLocation (rendered by scenarios/extra.ts where the vendor lacks it). */
  snmpLocation?: string
}

export interface FhrpGroup {
  proto: 'hsrp' | 'vrrp'
  iface: string
  group: number
  vip: string
  priority: number
  preempt: boolean
  state: 'Active' | 'Standby' | 'Master' | 'Backup' | 'Init'
  /** The other router's address and priority. */
  peer: string
  peerPriority: number
  /** Interface tracked for a priority decrement, and the decrement. */
  track?: { iface: string; decrement: number }
  /** State changes since boot, and when the last one happened. */
  transitions: number
  lastChange: number
}

export function logEvent(d: Device, msg: string, t = clockNow(d)): void {
  d.log.push({ t, msg })
  if (d.log.length > 500) d.log.shift()
}

export const isUp = (i: Iface): boolean => i.adminUp && i.linkUp && !i.errDisabled

export const findIfaceByName = (d: Device, name: string): Iface | undefined => d.interfaces.find((i) => i.name === name || i.short === name)

/** Why a BGP session is not established, or undefined when it can establish. */
export function bgpBlocker(d: Device, n: BgpNeighbor): 'admin' | 'iface-admin' | 'link' | 'wrong-as' | 'auth' | 'filtered' | 'peer' | undefined {
  if (n.shutdown) return 'admin'
  const iface = d.interfaces.find((i) => i.name === n.via)
  if (!iface || !iface.adminUp) return 'iface-admin'
  if (!isUp(iface)) return 'link'
  if (n.peerAs !== undefined && n.peerAs !== n.remoteAs) return 'wrong-as'
  if (n.peerPassword !== undefined && n.peerPassword !== (n.password ?? '')) return 'auth'
  if (n.filteredBy && d.acls.some((a) => a.name === n.filteredBy)) return 'filtered'
  if (n.peerRefuses) return 'peer'
  return undefined
}

export function neighborState(d: Device, n: BgpNeighbor, t = clockNow(d)): 'Established' | 'Idle' | 'Active' | 'Idle (Admin)' {
  const b = bgpBlocker(d, n)
  if (b === 'admin') return 'Idle (Admin)'
  if (b === 'iface-admin') return 'Idle'
  if (b) return 'Active'
  return n.upSince !== undefined && n.upSince <= t ? 'Established' : 'Active'
}

/** Called after config changes and on a timer: bring BGP up a few seconds after its blocker clears. */
export function tickBgp(d: Device, t = clockNow(d)): void {
  for (const n of d.bgp) {
    const blocked = bgpBlocker(d, n)
    if (blocked) {
      if (n.upSince !== undefined) {
        n.upSince = undefined
        n.downSince = t
        if (n.upSince === undefined && blocked === 'wrong-as') logEvent(d, `%BGP-3-NOTIFICATION: sent to neighbor ${n.ip} passive 2/2 (peer in wrong AS) 2 bytes ${(n.peerAs ?? 0).toString(16).toUpperCase().padStart(4, '0')}`, t)
      }
      n.downSince ??= t
    } else if (n.upSince === undefined) {
      n.upSince = t + 4000 // establishes in ~4s
    }
  }
}

export function bgpUp(n: BgpNeighbor, t = Date.now()): boolean {
  return n.upSince !== undefined && n.upSince <= t
}

/** OSPF adjacency state derived from the model: absent (undefined) when the interface is down. */
export function ospfState(d: Device, n: OspfNeighbor): 'FULL' | 'EXSTART' | '2WAY' | undefined {
  const i = d.interfaces.find((x) => x.name === n.iface)
  if (!i || !isUp(i)) return undefined
  const cfg = d.ospf?.ifaces.find((x) => x.iface === n.iface)
  if (!cfg) return undefined
  // Hello/dead or area mismatch: hellos are dropped, the neighbor never appears.
  if (n.peerHello !== undefined && n.peerHello !== (cfg.hello ?? 10)) return undefined
  if (n.peerArea !== undefined && normArea(n.peerArea) !== normArea(cfg.area)) return undefined
  const mtu = i.mtu ?? 1500
  if (n.peerMtu !== undefined && n.peerMtu !== mtu && !cfg.mtuIgnore) return 'EXSTART'
  if (n.role === 'DROTHER' && n.pri !== 0 && cfg.networkType !== 'point-to-point') return '2WAY'
  return 'FULL'
}

/** "0" and "0.0.0.0" are the same area. */
export function normArea(a: string): string {
  if (/^\d+$/.test(a)) {
    const n = Number(a)
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  return a
}

const two = (n: number): string => String(n).padStart(2, '0')

/** Cisco table uptime: hh:mm:ss under a day, then 1d02h, then 5w6d, then 1y10w. */
export function uptime(fromMs: number, t = Date.now()): string {
  const s = Math.max(0, Math.floor((t - fromMs) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h < 24) return `${two(h)}:${two(m)}:${two(sec)}`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d${two(h % 24)}h`
  const weeks = Math.floor(days / 7)
  if (weeks < 52) return `${weeks}w${days % 7}d`
  return `${Math.floor(weeks / 52)}y${weeks % 52}w`
}

/** Spelled-out uptime ("5 weeks, 6 days, 7 hours, 12 minutes"), as in IOS show version. */
export function uptimeLong(fromMs: number, t = Date.now()): string {
  const mins = Math.max(0, Math.floor((t - fromMs) / 60000))
  const parts: [number, string][] = [
    [Math.floor(mins / (7 * 1440)), 'week'],
    [Math.floor((mins % (7 * 1440)) / 1440), 'day'],
    [Math.floor((mins % 1440) / 60), 'hour'],
    [mins % 60, 'minute']
  ]
  const first = parts.findIndex(([n]) => n > 0)
  return parts
    .slice(first < 0 ? 3 : first)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
    .join(', ')
}

/** Duplex the port actually runs at, given its config and the far end. */
export function resolvedDuplex(i: Iface): 'full' | 'half' {
  const mine = i.duplex ?? 'auto'
  const far = i.peer?.duplex ?? 'auto'
  if (mine !== 'auto') return mine
  // Autonegotiation against a hard-set far end falls back to half duplex.
  return far !== 'auto' ? 'half' : 'full'
}

export function farDuplex(i: Iface): 'full' | 'half' {
  const far = i.peer?.duplex ?? 'auto'
  if (far !== 'auto') return far
  return (i.duplex ?? 'auto') !== 'auto' ? 'half' : 'full'
}

export const duplexMismatch = (i: Iface): boolean => !!i.peer?.duplex && isUp(i) && resolvedDuplex(i) !== farDuplex(i)

/** Interface counters: traffic grows with time while up; a duplex mismatch grows CRC/late collisions. */
export function ifaceCounters(d: Device, i: Iface, t = clockNow(d)): Counters {
  const since = i.clearedAt ?? d.bootedAt
  const secs = Math.max(0, (t - since) / 1000)
  const up = isUp(i)
  const virtual = !i.speed || /^(Lo|Nu|lo|tunnel|loopback)/i.test(i.name)
  const seed = [...i.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  const inPps = up && !virtual ? 10 + (seed % 40) : 0
  const outPps = up && !virtual ? 8 + ((seed >>> 4) % 30) : 0
  const e = i.errors ?? {}
  const c: Counters = {
    inPkts: Math.floor(inPps * secs * 0.6),
    inBytes: Math.floor(inPps * secs * 0.6 * 118),
    outPkts: Math.floor(outPps * secs * 0.6),
    outBytes: Math.floor(outPps * secs * 0.6 * 126),
    inErrors: e.inErrors ?? 0,
    crc: e.crc ?? 0,
    frame: e.frame ?? 0,
    overrun: e.overrun ?? 0,
    ignored: e.ignored ?? 0,
    runts: e.runts ?? 0,
    giants: e.giants ?? 0,
    outErrors: e.outErrors ?? 0,
    collisions: e.collisions ?? 0,
    lateCollisions: e.lateCollisions ?? 0,
    deferred: e.deferred ?? 0,
    resets: e.resets ?? 0,
    inBps: inPps * 8 * 118,
    outBps: outPps * 8 * 126,
    inPps,
    outPps
  }
  if (i.crcRate && up) {
    const from = Math.max(i.faultSince ?? since, since)
    const mins = Math.max(1, (t - from) / 60000)
    c.crc += Math.floor(mins * i.crcRate)
    c.inErrors += Math.floor(mins * i.crcRate * 1.1)
  }
  if (duplexMismatch(i)) {
    const from = Math.max(i.faultSince ?? since, since)
    const mins = Math.max(1, (t - from) / 60000)
    if (resolvedDuplex(i) === 'half') {
      // We run half, the far end full: we see late collisions; the far end sees CRC/runts.
      c.collisions += Math.floor(mins * 37)
      c.lateCollisions += Math.floor(mins * 11)
      c.deferred += Math.floor(mins * 5)
      c.crc += Math.floor(mins * 3)
      c.inErrors += Math.floor(mins * 3)
    } else {
      // We run full, the far end half: CRC errors and runts on our receive side.
      c.crc += Math.floor(mins * 23)
      c.runts += Math.floor(mins * 9)
      c.frame += Math.floor(mins * 2)
      c.inErrors += Math.floor(mins * 34)
    }
  }
  return c
}

// ---------------------------------------------------------------- config snapshots

/** Keys of Device that are configuration (snapshotted for startup, checkpoints, sessions, rollback). */
const CONFIG_KEYS = [
  'hostname',
  'localAs',
  'routerId',
  'interfaces',
  'vlans',
  'vrfs',
  'bgp',
  'ospf',
  'staticRoutes',
  'acls',
  'routeMaps',
  'prefixLists',
  'services',
  'motd',
  'extraConfig'
] as const

export type ConfigSnapshot = Pick<Device, (typeof CONFIG_KEYS)[number]> & { takenAt: number }

export function snapshot(d: Device): ConfigSnapshot {
  const s: Record<string, unknown> = { takenAt: clockNow(d) }
  for (const k of CONFIG_KEYS) s[k] = structuredClone(d[k])
  return s as ConfigSnapshot
}

/** Interface fields that are operational state, kept across a config restore. */
const IFACE_OPER = ['linkUp', 'mac', 'peer', 'errors', 'clearedAt', 'faultSince', 'lastChange', 'errDisabled', 'media', 'crcRate'] as const
/** BGP neighbor fields that are operational state or far-end truth. */
const BGP_OPER = ['peerAs', 'peerPassword', 'peerRefuses', 'upSince', 'downSince', 'routerId', 'routes', 'msgRcvd', 'msgSent', 'prefixes'] as const

/** Replace the device configuration with a snapshot, keeping operational state (links, counters, peers). */
export function restore(d: Device, s: ConfigSnapshot): void {
  const ifs = structuredClone(s.interfaces)
  for (const i of ifs) {
    const cur = d.interfaces.find((x) => x.name === i.name)
    if (!cur) continue
    for (const k of IFACE_OPER) (i as unknown as Record<string, unknown>)[k] = structuredClone(cur[k])
  }
  const bgp = structuredClone(s.bgp)
  for (const n of bgp) {
    const cur = d.bgp.find((x) => x.ip === n.ip)
    if (!cur) continue
    for (const k of BGP_OPER) (n as unknown as Record<string, unknown>)[k] = structuredClone(cur[k])
  }
  const ospf = s.ospf ? structuredClone(s.ospf) : undefined
  if (ospf && d.ospf) ospf.neighbors = structuredClone(d.ospf.neighbors)
  const rec = d as unknown as Record<string, unknown>
  for (const k of CONFIG_KEYS) rec[k] = structuredClone(s[k])
  d.interfaces = ifs
  d.bgp = bgp
  if (ospf) d.ospf = ospf
  tickBgp(d)
}

/** A throwaway device carrying a snapshot's config (for rendering startup-config, checkpoints, diffs). */
export function deviceFrom(d: Device, s: ConfigSnapshot): Device {
  const copy = structuredClone({ ...d, startup: undefined }) as Device
  restore(copy, s)
  return copy
}

// ---------------------------------------------------------------- factories

export { makeIosDevice } from './devices/ios.ts'
export { makeEosDevice } from './devices/eos.ts'
