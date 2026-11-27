/**
 * core-sw1: Catalyst C9300-48P, IOS-XE 17.9.4a, AS 65001. Values follow the samples in
 * docs/research/cli-cisco-ios.md §6 so the golden transcripts replay against model state.
 */
import { logEvent, snapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export function makeIosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const gi = (n: string, rest: Partial<Iface>): Iface => ({
    name: `GigabitEthernet${n}`,
    short: `Gi${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'access',
    speed: '1000',
    mac: `00a3.d14f.01${n.split('/').at(-1)!.padStart(2, '0')}`,
    media: '10/100/1000BaseTX',
    ...rest
  })
  const d: Device = {
    platform: 'ios',
    hostname: 'core-sw1',
    model: 'C9300-48P',
    serial: 'FOC2231X0AB',
    version: '17.9.4a',
    // 5 weeks, 6 days, 7 hours, 12 minutes (show version sample).
    bootedAt: ago(41 * DAY + 7 * 3600_000 + 12 * 60_000),
    localAs: 65001,
    routerId: '10.255.0.1',
    user: 'netops',
    interfaces: [
      { name: 'Vlan1', short: 'Vl1', adminUp: false, linkUp: true, mode: 'routed', speed: '', mac: '00a3.d14f.0180', ipMethod: 'NVRAM' },
      { name: 'Vlan10', short: 'Vl10', ip: '10.10.10.1', mask: 24, description: 'USERS', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00a3.d14f.0a0a', ipMethod: 'NVRAM' },
      { name: 'Vlan20', short: 'Vl20', ip: '10.10.20.1', mask: 24, description: 'PRINTERS', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00a3.d14f.0a14', ipMethod: 'NVRAM' },
      { name: 'Vlan30', short: 'Vl30', ip: '10.10.30.1', mask: 24, description: 'WIFI', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00a3.d14f.0a1e', ipMethod: 'NVRAM' },
      { name: 'GigabitEthernet0/0', short: 'Gi0/0', ip: '192.168.99.21', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '00a3.d14f.0100', vrf: 'Mgmt-vrf', ipMethod: 'NVRAM', media: 'RJ45' },
      gi('1/0/1', { ip: '10.0.0.5', mask: 30, description: 'uplink to edge-r1', mode: 'routed', ipMethod: 'NVRAM' }),
      // Re-addressed from the console 3 hours ago, hence "manual" (the e2e suite relies on it).
      gi('1/0/2', { ip: '10.0.0.1', mask: 30, description: 'uplink to isp-r2 (AS65002)', adminUp: false, mode: 'routed', ipMethod: 'manual' }),
      gi('1/0/3', { description: 'printer-3F', vlan: 20, speed: '100' }),
      gi('1/0/4', { linkUp: false, vlan: 10, speed: 'auto' }),
      gi('1/0/5', { description: 'desk 3F-14', vlan: 10 }),
      gi('1/0/6', { description: 'AP-3F-East', vlan: 30 }),
      gi('1/0/48', { description: 'trunk to dist-eos1', mode: 'trunk', trunkAllowed: [10, 20, 30], mac: '00a3.d14f.0130' }),
      { name: 'Loopback0', short: 'Lo0', ip: '10.255.0.1', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '', ipMethod: 'NVRAM' }
    ],
    vlans: [
      { id: 1, name: 'default' },
      { id: 10, name: 'USERS' },
      { id: 20, name: 'PRINTERS' },
      { id: 30, name: 'WIFI' }
    ],
    vrfs: [
      { name: 'MGMT', rd: '65001:99', interfaces: [] },
      { name: 'Mgmt-vrf', rd: '', interfaces: [] }
    ],
    bgp: [
      {
        ip: '10.0.0.6',
        remoteAs: 65000,
        description: 'edge-r1',
        via: 'GigabitEthernet1/0/1',
        prefixes: 12,
        upSince: ago(41 * DAY + 3 * 3600_000),
        routerId: '10.255.0.2',
        routeMapIn: 'RM-EDGE-IN',
        msgRcvd: 61234,
        msgSent: 61190,
        password: '13061E010803',
        routes: [
          { prefix: '10.255.0.2', mask: 32 },
          { prefix: '172.16.0.0', mask: 16 },
          { prefix: '172.16.8.0', mask: 22 }
        ]
      },
      { ip: '10.0.0.2', remoteAs: 65002, description: 'isp-r2', via: 'GigabitEthernet1/0/2', prefixes: 0, downSince: ago(3 * 3600_000 + 2 * 60_000 + 11_000), password: '13061E010803', routeMapOut: 'RM-ISP-OUT' }
    ],
    ospf: {
      process: '1',
      routerId: '10.255.0.1',
      ifaces: [
        { iface: 'GigabitEthernet1/0/1', area: '0', networkType: 'point-to-point' },
        { iface: 'Vlan10', area: '0' }
      ],
      neighbors: [
        { routerId: '10.255.0.2', ip: '10.0.0.6', iface: 'GigabitEthernet1/0/1', pri: 0, area: '0', role: '-', peerMtu: 1500 },
        { routerId: '10.255.0.11', ip: '10.10.10.2', iface: 'Vlan10', pri: 1, area: '0', role: 'DR', peerMtu: 1500 },
        { routerId: '10.255.0.12', ip: '10.10.10.3', iface: 'Vlan10', pri: 1, area: '0', role: 'DROTHER', peerMtu: 1500 }
      ]
    },
    mac: [
      { vlan: 0, mac: '0100.0ccc.cccc', port: 'CPU', type: 'STATIC' },
      { vlan: 0, mac: 'ffff.ffff.ffff', port: 'CPU', type: 'STATIC' },
      { vlan: 1, mac: '00a3.d14f.0180', port: 'Vl1', type: 'STATIC' },
      { vlan: 10, mac: '3c22.fb81.9e02', port: 'Gi1/0/48' },
      { vlan: 10, mac: 'aabb.cc00.0110', port: 'Gi1/0/5' },
      { vlan: 20, mac: '0017.c8a1.33f0', port: 'Gi1/0/3' },
      { vlan: 30, mac: 'aabb.cc00.0230', port: 'Gi1/0/48' },
      { vlan: 30, mac: 'f4db.e6a0.1c11', port: 'Gi1/0/6' }
    ],
    lldp: [
      { local: 'Gi1/0/1', device: 'edge-r1.lab', port: 'Gi0/0/0', caps: 'R', cdp: true, platform: 'ISR4431/K9', holdtime: 157, ip: '10.0.0.6', sysDescr: 'Cisco IOS Software [Bengaluru], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.6.5' },
      { local: 'Gi1/0/2', device: 'isp-r2', port: 'xe-0/0/1', caps: 'R', ip: '10.0.0.2' },
      { local: 'Gi1/0/6', device: 'AP-3F-East', port: 'Gig 0', caps: 'T B I', cdp: true, noLldp: true, platform: 'C9120AXI-B', holdtime: 122, ip: '10.10.30.20' },
      { local: 'Gi1/0/48', device: 'dist-eos1', port: 'Ethernet48', caps: 'B,R', ip: '10.255.0.10' }
    ],
    arp: [
      { ip: '10.0.0.6', mac: '3c22.fb81.0006', iface: 'GigabitEthernet1/0/1', age: 12 },
      { ip: '10.0.0.2', mac: '3c22.fb81.0002', iface: 'GigabitEthernet1/0/2', age: 40 },
      { ip: '10.10.10.57', mac: 'aabb.cc00.0110', iface: 'Vlan10', age: 3 },
      { ip: '10.10.20.31', mac: '0017.c8a1.33f0', iface: 'Vlan20', age: 0 },
      { ip: '10.10.30.112', mac: 'f4db.e6a0.1c11', iface: 'Vlan30', age: 1 }
    ],
    staticRoutes: [{ prefix: '0.0.0.0', mask: 0, nextHop: '10.0.0.6' }],
    acls: [
      {
        name: 'EDGE-IN',
        type: 'extended',
        entries: [
          { seq: 10, action: 'permit', text: 'tcp any host 10.255.0.1 eq bgp', hits: 48211 },
          { seq: 20, action: 'deny', text: 'ip any any log', hits: 17 }
        ]
      },
      {
        name: 'MGMT-ONLY',
        type: 'standard',
        entries: [
          { seq: 10, action: 'permit', text: '10.10.10.0 0.0.0.255', hits: 912 },
          { seq: 20, action: 'permit', text: '192.168.99.0 0.0.0.255', hits: 5 },
          { seq: 30, action: 'deny', text: 'any log', hits: 3 }
        ]
      },
      { name: '99', type: 'standard', entries: [{ seq: 10, action: 'permit', text: '10.255.255.0 0.0.0.255' }] }
    ],
    routeMaps: [
      { name: 'RM-EDGE-IN', entries: [{ seq: 10, action: 'permit', match: ['ip address prefix-list PL-EDGE-IN'], set: ['local-preference 200'], hits: 12 }] },
      {
        name: 'RM-ISP-OUT',
        entries: [
          { seq: 10, action: 'permit', match: ['ip address prefix-list PL-OUR-AGGREGATES'], set: [] },
          { seq: 20, action: 'deny', match: [], set: [] }
        ]
      }
    ],
    prefixLists: [
      {
        name: 'PL-EDGE-IN',
        entries: [
          { seq: 5, action: 'permit', prefix: '172.16.0.0/12', le: 24 },
          { seq: 10, action: 'permit', prefix: '10.255.0.0/16', ge: 32 },
          { seq: 15, action: 'deny', prefix: '0.0.0.0/0', le: 32 }
        ]
      },
      { name: 'PL-OUR-AGGREGATES', entries: [{ seq: 5, action: 'permit', prefix: '10.10.0.0/16' }] }
    ],
    services: { 'domain-lookup': false, 'http-server': false, cdp: true, lldp: true },
    cpu: {
      load: [3, 4, 4],
      processes: [
        { pid: 1, name: 'Chunk Manager', pct: 0 },
        { pid: 85, name: 'IOSD ipc task', pct: 1 },
        { pid: 132, name: 'IP Input', pct: 1 },
        { pid: 211, name: 'BGP Router', pct: 0 },
        { pid: 233, name: 'OSPF-1 Hello', pct: 0 },
        { pid: 412, name: 'SNMP ENGINE', pct: 0 },
        { pid: 523, name: 'HTTP CORE', pct: 0 },
        { pid: 611, name: 'CDP Protocol', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    logBase: 209,
    vendor: {},
    sshIdent: 'Cisco-1.25',
    scenarios: []
  }
  const l = t - 3 * 3600_000
  logEvent(d, '%SYS-5-CONFIG_I: Configured from console by netops on vty0 (10.10.10.50)', l)
  logEvent(d, '%LINK-5-CHANGED: Interface GigabitEthernet1/0/2, changed state to administratively down', l + 1984)
  logEvent(d, '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/2, changed state to down', l + 2984)
  logEvent(d, '%BGP-5-ADJCHANGE: neighbor 10.0.0.2 Down Interface flap', l + 3485)
  logEvent(d, '%BGP_SESSION-5-ADJCHANGE: neighbor 10.0.0.2 IPv4 Unicast topology base removed from session  Interface flap', l + 3585)
  // Saved before the console change three hours ago: Gi1/0/2 was still up in startup.
  d.startup = snapshot(d)
  d.startup.interfaces.find((i) => i.short === 'Gi1/0/2')!.adminUp = true
  d.startup.takenAt = t - 3 * 3600_000 - 80 * 60_000
  return d
}
