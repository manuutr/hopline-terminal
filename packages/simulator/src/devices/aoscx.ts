/**
 * agg-cx1: Aruba CX 6300M access/aggregation switch, AOS-CX 10.12.1000. No research doc exists for
 * this platform. It is the OSPF neighbour core-sw1 sees on Vlan10 (router ID 10.255.0.11 at
 * 10.10.10.2) and trunks VLANs 10/20/30 up to core-sw1 on 1/1/49.
 * Checkpoints live in `d.vendor.aoscx` as config snapshots (plain data).
 */
import { logEvent, snapshot, type ConfigSnapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export interface CxCheckpoint {
  name: string
  type: 'checkpoint' | 'latest'
  writer: 'User' | 'System'
  t: number
  snap: ConfigSnapshot
}

export interface CxData {
  checkpoints: CxCheckpoint[]
  /** `checkpoint auto` pending: roll back to `snap` unless confirmed. */
  auto?: { snap: ConfigSnapshot; until: number }
}

export function makeAoscxDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const port = (n: number, rest: Partial<Iface>): Iface => ({
    name: `1/1/${n}`,
    short: `1/1/${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'access',
    vlan: 1,
    speed: '1000',
    mac: `38:21:c7:5a:01:${String(n).padStart(2, '0')}`,
    media: '1GbT',
    lastChange: ago(41 * DAY),
    ...rest
  })
  const d: Device = {
    platform: 'aoscx',
    hostname: 'agg-cx1',
    model: '6300M',
    serial: 'SG0ZKN30BX',
    version: 'FL.10.12.1000',
    bootedAt: ago(41 * DAY + 7 * 3600_000 + 12 * 60_000),
    localAs: 0,
    routerId: '10.255.0.11',
    user: 'admin',
    interfaces: [
      { name: 'mgmt', short: 'mgmt', ip: '192.168.99.51', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '38:21:c7:5a:00:ff', vrf: 'mgmt' },
      port(1, { description: 'desk-1', vlan: 10 }),
      port(2, { description: 'desk-2', vlan: 10, linkUp: false, speed: 'auto' }),
      port(3, { description: 'printer-2F', vlan: 20, speed: '100' }),
      port(4, { adminUp: false, linkUp: false }),
      port(5, { description: 'AP-2F-Lobby', vlan: 30 }),
      port(49, { description: 'uplink to core-sw1', mode: 'trunk', vlan: undefined, nativeVlan: 1, trunkAllowed: [10, 20, 30], speed: '10G', media: 'SFP+DA3' }),
      port(50, { description: 'uplink spare', mode: 'trunk', vlan: undefined, nativeVlan: 1, trunkAllowed: [10, 20, 30], speed: '10G', media: 'SFP+DA3', adminUp: false, linkUp: false }),
      { name: 'loopback0', short: 'loopback0', ip: '10.255.0.11', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '' },
      { name: 'vlan10', short: 'vlan10', ip: '10.10.10.2', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '38:21:c7:5a:0a:0a' },
      { name: 'vlan20', short: 'vlan20', ip: '10.10.20.2', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '38:21:c7:5a:0a:14' }
    ],
    vlans: [
      { id: 1, name: 'DEFAULT_VLAN_1' },
      { id: 10, name: 'USERS' },
      { id: 20, name: 'PRINTERS' },
      { id: 30, name: 'WIFI' }
    ],
    vrfs: [{ name: 'mgmt', rd: '', interfaces: [] }],
    bgp: [],
    ospf: {
      process: '1',
      routerId: '10.255.0.11',
      ifaces: [
        { iface: 'vlan10', area: '0.0.0.0' },
        { iface: 'loopback0', area: '0.0.0.0', passive: true }
      ],
      neighbors: [{ routerId: '10.255.0.1', ip: '10.10.10.1', iface: 'vlan10', pri: 1, area: '0.0.0.0', role: 'BDR', peerMtu: 1500, upSince: ago(41 * DAY) }]
    },
    mac: [
      { vlan: 10, mac: 'aa:bb:cc:00:01:10', port: '1/1/1' },
      { vlan: 20, mac: '00:17:c8:a1:33:f1', port: '1/1/3' },
      { vlan: 30, mac: '70:d3:79:c2:0a:33', port: '1/1/5' },
      { vlan: 10, mac: '00:a3:d1:4f:0a:0a', port: '1/1/49' }
    ],
    lldp: [
      { local: '1/1/49', device: 'core-sw1', port: 'Gi1/0/47', caps: 'B,R', ip: '10.255.0.1', holdtime: 120, chassisId: '00:a3:d1:4f:01:00', sysDescr: 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a' },
      { local: '1/1/5', device: 'AP-2F-Lobby', port: '70:d3:79:c2:0a:33', caps: 'B,W', ip: '10.10.30.22', holdtime: 120, chassisId: '70:d3:79:c2:0a:33' }
    ],
    arp: [
      { ip: '10.10.10.1', mac: '00:a3:d1:4f:0a:0a', iface: 'vlan10', age: 3 },
      { ip: '10.10.10.57', mac: 'aa:bb:cc:00:01:10', iface: 'vlan10', age: 1 },
      { ip: '10.10.20.31', mac: '00:17:c8:a1:33:f1', iface: 'vlan20', age: 9 }
    ],
    staticRoutes: [
      { prefix: '0.0.0.0', mask: 0, nextHop: '10.10.10.1' },
      { prefix: '0.0.0.0', mask: 0, nextHop: '192.168.99.1', vrf: 'mgmt' }
    ],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { lldp: true },
    cpu: {
      load: [5, 5, 5],
      processes: [
        { pid: 1, name: 'hpe-config', pct: 0 },
        { pid: 412, name: 'ops-switchd', pct: 2 },
        { pid: 515, name: 'hpe-routing', pct: 1 },
        { pid: 611, name: 'lldpd', pct: 0 },
        { pid: 702, name: 'ospfd', pct: 0 },
        { pid: 803, name: 'hpe-sysmond', pct: 1 },
        { pid: 911, name: 'ndmd', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    logBase: 532,
    vendor: { ospfRoutes: [{ prefix: '10.255.0.1', mask: 32, via: '10.10.10.1' }] },
    // [unverified, from memory] AOS-CX runs OpenSSH; the ident is an OpenSSH version string.
    sshIdent: 'OpenSSH_8.4',
    scenarios: []
  }
  logEvent(d, 'lldpd[611]: Event|1302|LOG_INFO|AMM|1/1|LLDP neighbor core-sw1 added on 1/1/49', ago(41 * DAY))
  logEvent(d, 'hpe-config[1]: Event|1301|LOG_INFO|AMM|1/1|Configuration changed by admin', ago(2 * 3600_000))
  d.startup = snapshot(d)
  d.startup.takenAt = ago(2 * DAY)
  const auto = snapshot(d)
  auto.takenAt = ago(2 * 3600_000)
  const cx: CxData = { checkpoints: [{ name: cpName(auto.takenAt), type: 'latest', writer: 'System', t: auto.takenAt, snap: auto }] }
  d.vendor['aoscx'] = cx
  return d
}

/** System checkpoint names: CPCyyyymmddhhmmss. [unverified, from memory] */
export function cpName(t: number): string {
  const x = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `CPC${x.getUTCFullYear()}${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}${p(x.getUTCHours())}${p(x.getUTCMinutes())}${p(x.getUTCSeconds())}`
}
