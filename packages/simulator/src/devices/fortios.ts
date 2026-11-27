/**
 * fgt-edge1: FortiGate-VM64 on FortiOS 7.4.4, AS 65020, router-id 10.255.0.20, VDOMs disabled
 * (docs/research/cli-fortinet-fortios.md lab topology and section 6 samples). The second ISP peer
 * 198.51.100.9 sits on port4, which is administratively down, so the session stays Idle.
 */
import type { Device, Iface } from '../state.ts'

const DAY = 86400_000
const H = 3600_000
const M = 60_000

/** A config table row: field name -> value as `show` prints it (strings quoted). */
export type FRecord = [string, string][]

export interface FortiSession {
  proto: number
  protoState: string
  src: string
  sport: number
  dst: string
  dport: number
  start: number
  timeout: number
  policy: number
  devIn: number
  devOut: number
  gwy: string
  orgBytes: number
  orgPkts: number
  replyBytes: number
  replyPkts: number
  serial: string
}

export interface FortiData {
  /** Interface fields the shared model has no slot for (type, vdom, role, snmp-index, ...). */
  ifExtra: Record<string, FRecord>
  /** Kernel ifindex per interface (diagnose output). */
  ifIndex: Record<string, number>
  policies: { id: number; rec: FRecord }[]
  addresses: { name: string; rec: FRecord }[]
  console: { output: 'more' | 'standard' }
  ospfRoutes: { prefix: string; mask: number; via: string; iface: string; cost: number }[]
  sessions: FortiSession[]
  arpDiag: Record<string, string>
  /** Port MAC per neighbour chassis id (upper-case colon form), when it differs from the chassis id. */
  lldpMac: Record<string, string>
  /** Counter for generated policy/address UUIDs. */
  uuidSeq: number
}

export function makeFortiosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const port = (n: number, extra: Partial<Iface>): Iface => ({
    name: `port${n}`,
    short: `port${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '10G',
    mac: `00:0c:29:4f:2e:${String(n).padStart(2, '0')}`,
    allowaccess: ['ping'],
    lastChange: ago(2 * DAY),
    ...extra
  })
  const phys = (snmp: number, more: FRecord = []): FRecord => [['vdom', '"root"'], ['type', 'physical'], ...more, ['snmp-index', String(snmp)]]
  const forti: FortiData = {
    ifExtra: {
      port1: phys(1, [['role', 'wan']]),
      port2: phys(2, [['lldp-reception', 'enable']]),
      port3: phys(3, [['role', 'lan']]),
      port4: phys(4, [['role', 'wan']]),
      port10: phys(10),
      vlan100: [['vdom', '"root"'], ['type', 'vlan'], ['role', 'lan'], ['snmp-index', '11'], ['interface', '"port3"'], ['vlanid', '100']]
    },
    ifIndex: { port1: 3, port2: 4, port3: 5, port4: 6, port10: 12, vlan100: 14 },
    policies: [
      {
        id: 10,
        rec: [['name', '"LAN-to-core"'], ['uuid', '2c6b1d7e-5f1a-51ef-6f3a-1a2b3c4d5e6f'], ['srcintf', '"port3"'], ['dstintf', '"port2"'], ['action', 'accept'], ['srcaddr', '"LAN-NET"'], ['dstaddr', '"all"'], ['schedule', '"always"'], ['service', '"ALL"'], ['logtraffic', 'all']]
      },
      {
        id: 20,
        rec: [['name', '"LAN-to-WAN"'], ['uuid', '3d7c2e8f-6a2b-51ef-7a4b-2b3c4d5e6f70'], ['srcintf', '"port3"'], ['dstintf', '"port1"'], ['action', 'accept'], ['srcaddr', '"LAN-NET"'], ['dstaddr', '"all"'], ['schedule', '"always"'], ['service', '"ALL"'], ['nat', 'enable']]
      }
    ],
    addresses: [
      { name: 'LAN-NET', rec: [['uuid', '1a5b0c6d-4e09-51ef-5e29-0f1a2b3c4d5e'], ['subnet', '10.20.0.0 255.255.255.0']] },
      { name: 'all', rec: [['uuid', '0f4a9b5c-3df8-51ef-4d18-fe0a1b2c3d4e']] }
    ],
    console: { output: 'more' },
    ospfRoutes: [{ prefix: '10.255.0.1', mask: 32, via: '10.0.2.2', iface: 'port2', cost: 2 }],
    sessions: [
      { proto: 6, protoState: '01', src: '10.20.0.50', sport: 51514, dst: '10.10.10.5', dport: 443, start: ago(42_000), timeout: 3600, policy: 10, devIn: 5, devOut: 4, gwy: '10.0.2.2/10.20.0.50', orgBytes: 4120, orgPkts: 31, replyBytes: 18230, replyPkts: 29, serial: '002b1aec' },
      { proto: 17, protoState: '01', src: '10.20.0.51', sport: 53122, dst: '8.8.8.8', dport: 53, start: ago(12_000), timeout: 180, policy: 20, devIn: 5, devOut: 3, gwy: '203.0.113.1/10.20.0.51', orgBytes: 74, orgPkts: 1, replyBytes: 90, replyPkts: 1, serial: '002b1af3' }
    ],
    arpDiag: { '10.0.2.2': 'state=00000002 use=32 confirm=670 update=212 ref=6', '10.20.0.50': 'state=00000002 use=0 confirm=0 update=3159 ref=2' },
    lldpMac: { '00:1E:BD:4A:10:00': '00:1E:BD:4A:10:01' },
    uuidSeq: 1
  }
  const d: Device = {
    platform: 'fortios',
    hostname: 'fgt-edge1',
    model: 'FortiGate-VM64',
    serial: 'FGVM08TM24000123',
    version: '7.4.4',
    bootedAt: ago(2 * DAY + 3 * H + 14 * M + 30_000),
    localAs: 65020,
    routerId: '10.255.0.20',
    user: 'admin',
    interfaces: [
      port(1, { ip: '203.0.113.2', mask: 30 }),
      port(2, { ip: '10.0.2.1', mask: 30, alias: 'to-core-sw1' }),
      port(3, { ip: '10.20.0.1', mask: 24, allowaccess: ['ping', 'https', 'ssh'] }),
      port(4, { adminUp: false }),
      port(10, { ip: '192.168.1.99', mask: 24, speed: '1000', allowaccess: ['ping', 'https', 'ssh'] }),
      { name: 'vlan100', short: 'vlan100', ip: '10.20.100.1', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00:0c:29:4f:2e:03', vlan: 100, allowaccess: ['ping'], lastChange: ago(2 * DAY) }
    ],
    vlans: [],
    vrfs: [],
    bgp: [
      { ip: '10.0.2.2', remoteAs: 65001, description: 'core-sw1', via: 'port2', prefixes: 5, upSince: ago(2 * DAY + 3 * H + 11 * M + 5_000), routerId: '10.255.0.1', msgRcvd: 48211, msgSent: 48230, routes: [{ prefix: '10.10.10.0', mask: 24 }, { prefix: '10.10.20.0', mask: 24 }] },
      { ip: '203.0.113.1', remoteAs: 64500, description: 'ISP1', via: 'port1', prefixes: 1, upSince: ago(2 * DAY + 3 * H + 10 * M + 5_000), routerId: '203.0.113.1', msgRcvd: 9120, msgSent: 9131, routes: [{ prefix: '0.0.0.0', mask: 0 }] },
      { ip: '198.51.100.9', remoteAs: 64501, description: 'ISP2', via: 'port4', prefixes: 0, msgRcvd: 0, msgSent: 0 }
    ],
    ospf: {
      process: '0',
      routerId: '10.255.0.20',
      ifaces: [{ iface: 'port2', area: '0.0.0.0', networkType: 'point-to-point' }],
      neighbors: [{ routerId: '10.255.0.1', ip: '10.0.2.2', iface: 'port2', pri: 1, area: '0.0.0.0', role: '-', upSince: ago(1 * H + 12 * M + 33_000) }]
    },
    mac: [],
    lldp: [{ local: 'port2', device: 'core-sw1', port: 'Gi1/0/1', chassisId: '00:1E:BD:4A:10:00', caps: 'B,R', holdtime: 120 }],
    arp: [
      { ip: '10.0.2.2', mac: '00:1e:bd:4a:10:01', iface: 'port2', age: 0 },
      { ip: '10.20.0.50', mac: '3c:9b:d6:66:52:ab', iface: 'port3', age: 2 },
      { ip: '203.0.113.1', mac: '00:0c:29:aa:01:01', iface: 'port1', age: 0 }
    ],
    staticRoutes: [],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { ssh: true, https: true },
    cpu: {
      load: [1, 1, 1],
      processes: [
        { pid: 172, name: 'ipsengine', pct: 0.6 },
        { pid: 153, name: 'httpsd', pct: 0.2 },
        { pid: 160, name: 'snmpd', pct: 0.1 },
        { pid: 141, name: 'bgpd', pct: 0.1 }
      ]
    },
    extraConfig: [],
    log: [],
    vendor: { fortiData: forti },
    sshIdent: 'aVxqWnRb',
    scenarios: []
  }
  return d
}
