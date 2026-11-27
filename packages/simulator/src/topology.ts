/**
 * The topology lab: every platform's lab device wired into one network whose CDP/LLDP, ARP, BGP
 * and OSPF agree at both ends of every link. The tables below are the whole topology; `buildLab`
 * turns them into devices (renaming/cloning, renumbering AS, addressing links, writing neighbor
 * tables) and `labPorts` assigns sequential SSH/Telnet ports.
 *
 *            pe1 (IOS-XR, AS 64500, transit PE)
 *        /      |        |         \
 *   edge-r1   fw1    fgt-edge1    asa1 (outside)
 *    (Junos)  (PAN)   (Forti) --- mt-br1 (RouterOS branch)
 *       |       |        |          |
 *   core-sw1 ===== core-sw2 --- leaf1 (NX-OS), hw-agg1 (VRP), wlc1 (AireOS)
 *    |   |  \      |   |
 *    | wlc-9800  dist-eos1 / dist-eos2 (EOS) --- acc-cx1 (AOS-CX)
 */
import { makeDevice } from './devices/index.ts'
import { tickBgp, type Device, type Iface, type LldpNeighbor, type SimPlatform } from './state.ts'

export interface LabNode {
  name: string
  platform: SimPlatform
  role: string
  /** BGP AS in the lab (renumbered so every AS is unique except the iBGP core pair). */
  as?: number
  /** Loopback / router ID, for the second instance of a platform. */
  loopback?: string
  /** Static routes to point at a lab neighbor (the device's own next hops are not in the lab). */
  routesVia?: { prefix: string; via: string }[]
}

export interface LabLink {
  a: [string, string]
  b: [string, string]
  /** Routed link: a gets the first host, b the second. Omit for a layer-2 trunk. */
  net?: string
  bgp?: boolean
  ospf?: boolean
}

export const LAB_NODES: LabNode[] = [
  { name: 'core-sw1', platform: 'ios', role: 'core (IOS-XE)', as: 65001 },
  { name: 'core-sw2', platform: 'ios', role: 'core (IOS-XE)', as: 65001, loopback: '10.255.0.3' },
  { name: 'dist-eos1', platform: 'eos', role: 'distribution (EOS)', as: 65010 },
  { name: 'dist-eos2', platform: 'eos', role: 'distribution (EOS)', as: 65011, loopback: '10.255.0.12' },
  { name: 'leaf1', platform: 'nxos', role: 'aggregation (NX-OS)', as: 65030 },
  { name: 'edge-r1', platform: 'junos', role: 'edge router (Junos)', as: 65000 },
  { name: 'fw1', platform: 'panos', role: 'edge firewall (PAN-OS)', as: 65020 },
  { name: 'fgt-edge1', platform: 'fortios', role: 'edge firewall (FortiOS)', as: 65021 },
  { name: 'asa1', platform: 'asa', role: 'edge firewall (ASA)', routesVia: [{ prefix: '0.0.0.0/0', via: 'pe1' }, { prefix: '10.0.0.0/8', via: 'core-sw1' }] },
  { name: 'pe1', platform: 'iosxr', role: 'provider edge (IOS-XR)', as: 64500 },
  { name: 'wlc-9800', platform: 'c9800', role: 'wireless controller (C9800)' },
  { name: 'wlc1', platform: 'aireos', role: 'wireless controller (AireOS)' },
  { name: 'acc-cx1', platform: 'aoscx', role: 'access switch (AOS-CX)' },
  { name: 'hw-agg1', platform: 'vrp', role: 'aggregation (Huawei VRP)', as: 65040 },
  { name: 'mt-br1', platform: 'routeros', role: 'branch router (RouterOS)', as: 65050 }
]

export const LAB_LINKS: LabLink[] = [
  { a: ['core-sw1', 'GigabitEthernet1/0/1'], b: ['edge-r1', 'ge-0/0/1'], net: '10.0.0.4/30', bgp: true, ospf: true },
  { a: ['pe1', 'GigabitEthernet0/0/0/0'], b: ['edge-r1', 'ge-0/0/0'], net: '203.0.113.0/30', bgp: true },
  { a: ['core-sw1', 'GigabitEthernet1/0/48'], b: ['dist-eos1', 'Ethernet48'] },
  { a: ['core-sw1', 'GigabitEthernet1/0/47'], b: ['dist-eos2', 'Ethernet48'] },
  { a: ['core-sw2', 'GigabitEthernet1/0/48'], b: ['dist-eos1', 'Ethernet47'] },
  { a: ['core-sw2', 'GigabitEthernet1/0/47'], b: ['dist-eos2', 'Ethernet47'] },
  { a: ['core-sw1', 'GigabitEthernet1/0/45'], b: ['core-sw2', 'GigabitEthernet1/0/45'], net: '10.0.0.8/30', bgp: true, ospf: true },
  { a: ['core-sw2', 'GigabitEthernet1/0/1'], b: ['fw1', 'ethernet1/2'], net: '10.0.0.12/30', bgp: true },
  { a: ['pe1', 'GigabitEthernet0/0/0/1'], b: ['fw1', 'ethernet1/1'], net: '203.0.113.4/30', bgp: true },
  { a: ['core-sw2', 'GigabitEthernet1/0/2'], b: ['fgt-edge1', 'port2'], net: '10.0.0.16/30', bgp: true },
  { a: ['pe1', 'GigabitEthernet0/0/0/2'], b: ['fgt-edge1', 'port1'], net: '203.0.113.8/30', bgp: true },
  { a: ['core-sw1', 'GigabitEthernet1/0/46'], b: ['asa1', 'GigabitEthernet0/1'], net: '10.0.0.20/30' },
  { a: ['pe1', 'GigabitEthernet0/0/0/3'], b: ['asa1', 'GigabitEthernet0/0'], net: '203.0.113.12/30' },
  { a: ['core-sw1', 'GigabitEthernet1/0/44'], b: ['wlc-9800', 'GigabitEthernet1'] },
  { a: ['core-sw2', 'GigabitEthernet1/0/44'], b: ['wlc1', '1'] },
  { a: ['core-sw2', 'GigabitEthernet1/0/43'], b: ['leaf1', 'Ethernet1/49'], net: '10.0.0.24/30', bgp: true },
  { a: ['dist-eos2', 'Ethernet10'], b: ['acc-cx1', '1/1/49'] },
  { a: ['core-sw2', 'GigabitEthernet1/0/42'], b: ['hw-agg1', '10GE1/0/1'], net: '10.0.0.28/30', bgp: true },
  { a: ['fgt-edge1', 'port3'], b: ['mt-br1', 'ether1'], net: '10.0.0.32/30', bgp: true }
]

export interface Lab {
  nodes: (LabNode & { device: Device })[]
  links: LabLink[]
  device(name: string): Device
}

// ------------------------------------------------------------------ helpers

const CDP: SimPlatform[] = ['ios', 'nxos', 'iosxr', 'c9800', 'aireos']
const CISCO_SHORT: SimPlatform[] = ['ios', 'c9800', 'nxos', 'iosxr', 'asa']

const ipNum = (s: string): number => s.split('.').reduce((a, o) => a * 256 + Number(o), 0)
const sameNet = (a: string, b: string, len: number): boolean => len === 0 || Math.floor(ipNum(a) / 2 ** (32 - len)) === Math.floor(ipNum(b) / 2 ** (32 - len))
const ipStr = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.')

function hosts(net: string): [string, string, number] {
  const [base, len] = net.split('/')
  const n = ipNum(base!)
  return [ipStr(n + 1), ipStr(n + 2), Number(len)]
}

function findIface(d: Device, name: string): Iface | undefined {
  const n = name.toLowerCase()
  return d.interfaces.find((i) => i.name.toLowerCase() === n || i.short.toLowerCase() === n)
}

/** The device's interface, created from a sibling of the same type when the lab needs another port. */
function ensureIface(d: Device, name: string): Iface {
  const hit = findIface(d, name)
  if (hit) return hit
  const stem = name.replace(/\d+$/, '')
  const sib = d.interfaces.find((i) => i.name.replace(/\d+$/, '') === stem && i.speed !== '') ?? d.interfaces.find((i) => /\d/.test(i.name) && i.speed !== '' && !i.vrf && !i.ip)
  if (!sib) throw new Error(`topology: ${d.hostname} has no interface like ${name}`)
  const num = /(\d+)$/.exec(name)?.[1] ?? ''
  const short = sib.short === sib.name ? name : sib.short.replace(/\d+$/, num)
  const i: Iface = { ...structuredClone(sib), name, short, description: undefined, ip: undefined, mask: undefined, vrf: undefined, vlan: sib.mode === 'access' ? sib.vlan : undefined, errDisabled: undefined, peer: undefined, errors: undefined, faultSince: undefined, channelGroup: undefined, trunkAllowed: undefined, linkUp: true, adminUp: true }
  d.interfaces.splice(d.interfaces.indexOf(sib) + 1, 0, i)
  return i
}

/** How a device names its own port in LLDP tables: short form if its table already uses it. */
function localName(d: Device, i: Iface): string {
  if (i.short === i.name) return i.name
  if (d.lldp.some((n) => d.interfaces.some((x) => x.short === n.local && x.short !== x.name))) return i.short
  return CISCO_SHORT.includes(d.platform) ? i.short : i.name
}

/** How a neighbor shows a remote port: Cisco IOS-style devices advertise the short form. */
const remoteName = (d: Device, i: Iface): string => (d.platform === 'ios' || d.platform === 'c9800' ? i.short : i.name)

const loopbackOf = (d: Device): string | undefined => d.interfaces.find((i) => /^(loopback|lo)\d*$/i.test(i.name) && i.ip)?.ip ?? d.routerId

const capsOf = (role: string): string => (/switch|core|distribution|aggregation/.test(role) ? 'B,R' : /controller/.test(role) ? 'B' : 'R')

function chassisMac(d: Device): string {
  const raw = (d.interfaces.find((i) => i.mac)?.mac ?? '000000000000').replace(/[^0-9a-f]/gi, '').padStart(12, '0')
  return raw.match(/../g)!.join(':')
}

function rename(d: Device, n: LabNode): void {
  d.hostname = n.name
  if (n.loopback) {
    const lo = d.interfaces.find((i) => /^(loopback|lo)\d*$/i.test(i.name) && i.ip)
    if (lo) lo.ip = n.loopback
    d.routerId = n.loopback
    if (d.ospf) d.ospf.routerId = n.loopback
    // A second instance keeps the platform's look but none of the first one's neighbors.
    d.bgp = []
    if (d.ospf) d.ospf.neighbors = []
    d.lldp = []
    d.arp = []
    d.mac = []
    d.serial = d.serial.slice(0, -2) + '02'
    for (const i of d.interfaces) if (i.mac) i.mac = i.mac.replace(/(..)$/, (m) => ((parseInt(m, 16) + 0x40) % 256).toString(16).padStart(2, '0'))
    for (const i of d.interfaces) {
      if (!i.ip || i === lo || i.vrf || i.mask === undefined || i.mask >= 32) continue
      if (/^vlan/i.test(i.name)) i.ip = i.ip.replace(/\.(\d+)$/, (_m, o: string) => `.${Number(o) + 1}`)
      else if (i.speed !== '') {
        i.ip = undefined
        i.mask = undefined
      }
    }
  }
}

// ------------------------------------------------------------------ build

export function buildLab(t = Date.now(), nodes: LabNode[] = LAB_NODES, links: LabLink[] = LAB_LINKS): Lab {
  const built = nodes.map((n) => {
    const device = makeDevice(n.platform, t)
    if (device.hostname !== n.name || n.loopback) rename(device, n)
    if (n.as !== undefined && device.localAs !== n.as) {
      // iBGP peers follow the renumbered AS.
      for (const b of device.bgp) if (b.remoteAs === device.localAs) b.remoteAs = n.as
      device.localAs = n.as
    }
    return { ...n, device }
  })
  const by = new Map(built.map((n) => [n.name, n]))
  const get = (name: string): LabNode & { device: Device } => {
    const n = by.get(name)
    if (!n) throw new Error(`topology: unknown node ${name}`)
    return n
  }
  for (const l of links) {
    const A = get(l.a[0])
    const B = get(l.b[0])
    const ia = ensureIface(A.device, l.a[1])
    const ib = ensureIface(B.device, l.b[1])
    for (const i of [ia, ib]) {
      i.adminUp = true
      i.linkUp = true
      i.errDisabled = undefined
      i.lastChange ??= t - 3 * 86400_000
    }
    ia.description ??= `${B.name}:${remoteName(B.device, ib)}`
    ib.description ??= `${A.name}:${remoteName(A.device, ia)}`
    if (l.net) {
      const [ha, hb, len] = hosts(l.net)
      for (const [i, ip] of [[ia, ha], [ib, hb]] as const) {
        i.ip = ip
        i.mask = len
        i.mode = 'routed'
        i.vlan = undefined
        i.vrf = undefined
        if (i.ipMethod) i.ipMethod = 'NVRAM'
      }
    } else {
      for (const [d, i] of [[A.device, ia], [B.device, ib]] as const) if (i.mode === 'access' && /switch|core|distribution/.test(by.get(d.hostname)!.role)) i.mode = 'trunk'
    }
    neighbor(A, ia, B, ib, l, t)
    neighbor(B, ib, A, ia, l, t)
  }
  // Neighbors and static next hops that the lab re-addressing cut off are dropped / re-pointed.
  for (const n of built) {
    const d = n.device
    const onLink = (ip: string): boolean => d.interfaces.some((i) => i.ip && i.mask !== undefined && i.mask < 32 && sameNet(ip, i.ip, i.mask))
    const relinked = new Set(links.flatMap((l) => [l.a, l.b]).filter(([x]) => x === n.name).map(([, p]) => p))
    d.bgp = d.bgp.filter((b) => !relinked.has(b.via) || onLink(b.ip))
    if (d.ospf) d.ospf.neighbors = d.ospf.neighbors.filter((o) => !relinked.has(o.iface) || onLink(o.ip))
    // Static routes whose next hop the re-addressing cut off are dropped, then re-pointed if asked.
    if (relinked.size) d.staticRoutes = d.staticRoutes.filter((r) => onLink(r.nextHop) || !d.interfaces.some((i) => relinked.has(i.name)))
    for (const r of n.routesVia ?? []) {
      const l = links.find((x) => (x.a[0] === n.name && x.b[0] === r.via) || (x.b[0] === n.name && x.a[0] === r.via))
      const peer = l && (l.a[0] === r.via ? l.a : l.b)
      const ip = peer && by.get(peer[0])!.device.interfaces.find((i) => i.name === peer[1])?.ip
      const [prefix, len] = r.prefix.split('/')
      if (ip) d.staticRoutes = [...d.staticRoutes.filter((x) => !(x.prefix === prefix && x.mask === Number(len))), { prefix: prefix!, mask: Number(len), nextHop: ip }]
    }
  }
  // Pre-existing (doc) BGP neighbors that point at a lab device get that device's AS.
  const owner = new Map<string, LabNode & { device: Device }>()
  for (const n of built) for (const i of n.device.interfaces) if (i.ip) owner.set(i.ip, n)
  for (const n of built) {
    for (const b of n.device.bgp) {
      const o = owner.get(b.ip)
      if (o && o !== n && o.device.localAs) {
        b.remoteAs = o.device.localAs
        b.peerAs = undefined
        b.description ??= o.name
      }
    }
    delete n.device.vendor['junos']
    tickBgp(n.device, t)
  }
  return { nodes: built, links, device: (name) => get(name).device }
}

function neighbor(A: LabNode & { device: Device }, ia: Iface, B: LabNode & { device: Device }, ib: Iface, l: LabLink, t: number): void {
  const d = A.device
  const local = localName(d, ia)
  d.lldp = d.lldp.filter((n) => n.local !== local && n.local !== ia.name && n.local !== ia.short)
  const entry: LldpNeighbor = {
    local,
    device: B.name,
    port: remoteName(B.device, ib),
    caps: capsOf(B.role),
    ip: loopbackOf(B.device) ?? ib.ip ?? '',
    holdtime: 120,
    platform: B.device.model,
    chassisId: chassisMac(B.device),
    parent: '-',
    sysDescr: `${B.role} ${B.device.model} ${B.device.version}`
  }
  if (CDP.includes(d.platform) && CDP.includes(B.device.platform)) entry.cdp = true
  d.lldp.push(entry)
  if (!l.net || !ib.ip) return
  d.arp = d.arp.filter((a) => a.ip !== ib.ip)
  d.arp.push({ ip: ib.ip, mac: ib.mac || chassisMac(B.device), iface: ia.name, age: 0 })
  if (l.bgp && d.localAs && B.device.localAs) {
    let n = d.bgp.find((x) => x.ip === ib.ip)
    if (!n) {
      n = { ip: ib.ip, remoteAs: B.device.localAs, via: ia.name, prefixes: 1, ...(d.platform === 'iosxr' ? { routeMapIn: 'PASS', routeMapOut: 'PASS' } : {}), upSince: t - 2 * 86400_000, routerId: B.device.routerId, msgRcvd: 3120, msgSent: 3101, routes: [{ prefix: loopbackOf(B.device) ?? ib.ip, mask: 32 }] }
      d.bgp.push(n)
    }
    n.remoteAs = B.device.localAs
    n.peerAs = undefined
    n.via = ia.name
    n.description = B.name
    n.shutdown = undefined
  }
  if (l.ospf && d.ospf && B.device.ospf) {
    if (!d.ospf.ifaces.some((o) => o.iface === ia.name)) d.ospf.ifaces.push({ iface: ia.name, area: d.ospf.ifaces[0]?.area ?? '0', networkType: 'point-to-point' })
    if (!d.ospf.neighbors.some((o) => o.ip === ib.ip)) d.ospf.neighbors.push({ routerId: B.device.ospf.routerId ?? B.device.routerId ?? ib.ip, ip: ib.ip, iface: ia.name, pri: 0, area: d.ospf.ifaces[0]?.area ?? '0', role: '-', upSince: t - 2 * 86400_000 })
  }
}

export interface LabPort {
  name: string
  platform: SimPlatform
  role: string
  ssh: number
  telnet: number
}

/** Sequential ports: SSH base+0..n-1, Telnet base+100+0..n-1. */
export function labPorts(lab: Lab, base = 2220): LabPort[] {
  return lab.nodes.map((n, k) => ({ name: n.name, platform: n.platform, role: n.role, ssh: base + k, telnet: base + 100 + k }))
}

export function portTable(ports: LabPort[], host = '127.0.0.1'): string {
  const rows = ports.map((p) => `${p.name.padEnd(11)}${p.platform.padEnd(10)}${p.role.padEnd(30)}${String(p.ssh).padEnd(7)}${String(p.telnet).padEnd(8)}ssh admin@${host} -p ${p.ssh}`)
  return ['Device     Platform  Role                          SSH    Telnet  Connect', ...rows].join('\n')
}
