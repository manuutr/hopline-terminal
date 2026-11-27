/**
 * dist-eos1: Arista DCS-7050SX3-48YC8, EOS 4.31.2F, AS 65010. Values follow the samples in
 * docs/research/cli-arista-eos.md §6 so the golden transcripts replay against model state.
 */
import { snapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000
const HOUR = 3600_000
const MIN = 60_000

export function makeEosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const et = (n: number, rest: Partial<Iface>): Iface => ({
    name: `Ethernet${n}`,
    short: `Et${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'access',
    vlan: 1,
    speed: '25G',
    mac: `2899.3a11.00${n.toString(16).padStart(2, '0')}`,
    media: '25GBASE-SR',
    ...rest
  })
  const d: Device = {
    platform: 'eos',
    hostname: 'dist-eos1',
    model: 'DCS-7050SX3-48YC8',
    serial: 'JPE19470123',
    version: '4.31.2F',
    // Uptime: 2 weeks, 3 days, 14 hours and 22 minutes (show version sample).
    bootedAt: ago(17 * DAY + 14 * HOUR + 22 * MIN + 31_000),
    localAs: 65010,
    routerId: '10.255.0.10',
    user: 'admin',
    interfaces: [
      et(1, { ip: '10.0.1.1', mask: 31, description: 'spine1', mode: 'routed', vlan: undefined }),
      et(2, { ip: '10.0.1.3', mask: 31, description: 'spine2', mode: 'routed', vlan: undefined, linkUp: false }),
      et(3, { linkUp: false, media: 'Not Present' }),
      et(10, { description: 'server-db01', vlan: 100, speed: '10G', media: '10GBASE-SR' }),
      et(11, { description: 'server-db02', vlan: 100, speed: '10G', media: '10GBASE-SR' }),
      et(48, { description: 'trunk to core-sw1', mode: 'trunk', vlan: undefined, speed: '1G', media: '1000BASE-T', mac: '2899.3a11.0030' }),
      { name: 'Loopback0', short: 'Lo0', ip: '10.255.0.10', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '', mtu: 65535 },
      { name: 'Management1', short: 'Ma1', ip: '192.168.255.21', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1G', mac: '2899.3a11.00ff', vrf: 'MGMT', media: '10/100/1000' },
      { name: 'Vlan100', short: 'Vl100', ip: '10.100.0.1', mask: 24, description: 'DB', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '2899.3a11.0064' }
    ],
    vlans: [
      { id: 1, name: 'default' },
      { id: 10, name: 'USERS' },
      { id: 100, name: 'DB' }
    ],
    vrfs: [{ name: 'MGMT', rd: '65010:99', interfaces: ['Management1'] }],
    bgp: [
      {
        ip: '10.0.1.0',
        remoteAs: 65100,
        description: 'spine1',
        via: 'Ethernet1',
        prefixes: 214,
        upSince: ago(17 * DAY + 12 * HOUR + 4 * MIN),
        routerId: '10.255.0.100',
        msgRcvd: 25871,
        msgSent: 23954,
        routes: [
          { prefix: '0.0.0.0', mask: 0 },
          { prefix: '10.20.0.0', mask: 16 },
          { prefix: '10.255.0.100', mask: 32 }
        ]
      },
      { ip: '10.0.1.2', remoteAs: 65100, description: 'spine2', via: 'Ethernet2', prefixes: 0, downSince: ago(5 * HOUR + 2 * MIN + 11_000) }
    ],
    mac: [
      { vlan: 10, mac: 'aabb.cc00.0110', port: 'Et48' },
      { vlan: 100, mac: '5254.0012.3456', port: 'Et10' },
      { vlan: 100, mac: '5254.0012.3457', port: 'Et11' }
    ],
    lldp: [
      { local: 'Et1', device: 'spine1', port: 'Ethernet7', caps: 'B,R', ip: '10.255.0.100', sysDescr: 'Arista Networks EOS version 4.31.2F running on an Arista DCS-7280SR3-48YC8' },
      { local: 'Et48', device: 'core-sw1', port: 'Gi1/0/48', caps: 'B,R', ip: '10.255.0.1', sysDescr: 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a' }
    ],
    // Ages are minutes (fractional: the EOS table prints h:mm:ss).
    arp: [
      { ip: '10.0.1.0', mac: '2899.3a22.0007', iface: 'Ethernet1', age: 72 / 60 },
      { ip: '10.100.0.21', mac: '5254.0012.3456', iface: 'Vlan100', age: 41 / 60 },
      { ip: '10.100.0.22', mac: '5254.0012.3457', iface: 'Vlan100', age: 182 / 60 }
    ],
    staticRoutes: [],
    acls: [
      {
        name: 'MGMT-SSH',
        type: 'standard',
        entries: [
          { seq: 10, action: 'permit', text: '10.10.10.0/24', hits: 314 },
          { seq: 20, action: 'deny', text: 'any log', hits: 2 }
        ]
      }
    ],
    routeMaps: [{ name: 'RM-SPINE-IN', entries: [{ seq: 10, action: 'permit', match: ['ip address prefix-list PL-SPINE-IN'], set: [] }] }],
    prefixLists: [{ name: 'PL-SPINE-IN', entries: [{ seq: 10, action: 'permit', prefix: '10.0.0.0/8', le: 32 }] }],
    services: { lldp: true },
    cpu: {
      load: [2, 2, 2],
      processes: [
        { pid: 1, name: 'systemd', pct: 0 },
        { pid: 2109, name: 'Sysdb', pct: 1 },
        { pid: 2231, name: 'ConfigAgent', pct: 0 },
        { pid: 2412, name: 'Ebra', pct: 0 },
        { pid: 2518, name: 'Ipfib', pct: 0 },
        { pid: 2633, name: 'Bgp', pct: 1 },
        { pid: 2741, name: 'Lldp', pct: 0 },
        { pid: 2855, name: 'StrataL3', pct: 1 }
      ]
    },
    extraConfig: [],
    log: [
      { t: ago(5 * HOUR), msg: 'Ebra: %LINEPROTO-5-UPDOWN: Line protocol on Interface Ethernet2 (spine2), changed state to down' },
      { t: ago(5 * HOUR - 900), msg: 'Bgp: %BGP-3-NOTIFICATION: sent to neighbor 10.0.1.2 (VRF default AS 65100) 6/6 (Cease/other configuration change) 0 bytes' },
      { t: ago(5 * HOUR - 1000), msg: 'Bgp: %BGP-5-ADJCHANGE: peer 10.0.1.2 (VRF default AS 65100) old state Established event Stop new state Idle' }
    ],
    vendor: {
      // Operational constants for tables the model does not carry.
      eosMacMoved: { 'aabb.cc00.0110': ago(2 * DAY + 3 * HOUR + 11 * MIN + 9_000), '5254.0012.3456': ago(17 * DAY + 12 * HOUR + 4 * MIN + 51_000), '5254.0012.3457': ago(5 * MIN + 5_000) },
      eosLldpStats: { changed: ago(2 * DAY + 3 * HOUR + 11 * MIN + 40_000), inserts: 4, deletes: 1, drops: 0, ageouts: 1 }
    },
    scenarios: []
  }
  d.startup = snapshot(d)
  d.startup.takenAt = ago(6 * HOUR)
  return d
}
