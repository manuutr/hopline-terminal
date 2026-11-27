/**
 * hw-agg1: Huawei CloudEngine CE6881-48S6CQ, VRP V200R019C10 (VRP 8.191), AS 65001, aggregation
 * switch below core-sw1 (iBGP + OSPF area 0 over 10GE1/0/1). Two-stage config (candidate +
 * `commit`). Values are plausible lab values [unverified, from memory].
 */
import { logEvent, snapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export function makeVrpDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const ge = (n: number, rest: Partial<Iface>): Iface => ({
    name: `10GE1/0/${n}`,
    short: `10GE1/0/${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'access',
    vlan: 1,
    speed: '10G',
    mac: `0c4b.7d21.00${String(n).padStart(2, '0')}`,
    media: '10G-SFP+',
    ...rest
  })
  const d: Device = {
    platform: 'vrp',
    hostname: 'hw-agg1',
    model: 'CE6881-48S6CQ',
    serial: '2102350DLS10K8000123',
    version: 'V200R019C10SPC800',
    bootedAt: ago(23 * DAY + 4 * 3600_000 + 51 * 60_000),
    localAs: 65001,
    routerId: '10.255.0.20',
    user: 'admin',
    interfaces: [
      { name: 'MEth0/0/0', short: 'MEth0/0/0', ip: '192.168.99.24', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '0c4b.7d21.0000', media: 'RJ45' },
      ge(1, { ip: '10.0.4.2', mask: 30, description: 'uplink to core-sw1 Gi1/0/47', mode: 'routed', vlan: undefined }),
      ge(2, { ip: '10.0.5.1', mask: 30, description: 'to dc-fw1 (AS65100)', mode: 'routed', vlan: undefined }),
      ge(3, { description: 'server-rack-A', vlan: 10 }),
      ge(4, { description: 'trunk to acc-sw3', mode: 'trunk', vlan: undefined, trunkAllowed: [10, 20, 30] }),
      ge(5, { linkUp: false }),
      ge(6, { adminUp: false, description: 'spare' }),
      { name: 'Vlanif10', short: 'Vlanif10', ip: '10.10.10.4', mask: 24, description: 'USERS', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '0c4b.7d21.0a0a' },
      { name: 'Vlanif20', short: 'Vlanif20', ip: '10.10.20.4', mask: 24, description: 'PRINTERS', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '0c4b.7d21.0a14' },
      { name: 'LoopBack0', short: 'LoopBack0', ip: '10.255.0.20', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '' },
      { name: 'NULL0', short: 'NULL0', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '' }
    ],
    vlans: [
      { id: 1, name: '' },
      { id: 10, name: 'USERS' },
      { id: 20, name: 'PRINTERS' },
      { id: 30, name: 'WIFI' }
    ],
    vrfs: [],
    bgp: [
      {
        ip: '10.0.4.1',
        remoteAs: 65001,
        description: 'core-sw1',
        via: '10GE1/0/1',
        prefixes: 3,
        upSince: ago(23 * DAY + 4 * 3600_000),
        routerId: '10.255.0.1',
        msgRcvd: 48211,
        msgSent: 48190,
        routes: [
          { prefix: '0.0.0.0', mask: 0 },
          { prefix: '10.10.30.0', mask: 24 },
          { prefix: '172.16.0.0', mask: 16 }
        ]
      },
      {
        ip: '10.0.5.2',
        remoteAs: 65100,
        description: 'dc-fw1',
        via: '10GE1/0/2',
        prefixes: 2,
        upSince: ago(9 * DAY + 2 * 3600_000),
        routerId: '10.255.100.1',
        msgRcvd: 19012,
        msgSent: 19044,
        routes: [
          { prefix: '10.100.0.0', mask: 16 },
          { prefix: '10.101.0.0', mask: 16 }
        ]
      }
    ],
    ospf: {
      process: '1',
      routerId: '10.255.0.20',
      ifaces: [
        { iface: '10GE1/0/1', area: '0', networkType: 'point-to-point' },
        { iface: 'LoopBack0', area: '0', passive: true }
      ],
      neighbors: [{ routerId: '10.255.0.1', ip: '10.0.4.1', iface: '10GE1/0/1', pri: 1, area: '0', role: '-', peerMtu: 1500, upSince: ago(23 * DAY + 4 * 3600_000) }]
    },
    mac: [
      { vlan: 10, mac: '00e0.fc12.3401', port: '10GE1/0/3' },
      { vlan: 10, mac: '3c22.fb81.9e02', port: '10GE1/0/4' },
      { vlan: 20, mac: '0017.c8a1.33f1', port: '10GE1/0/4' }
    ],
    lldp: [
      { local: '10GE1/0/1', device: 'core-sw1', port: 'Gi1/0/47', caps: 'B,R', holdtime: 104, ip: '10.255.0.1' },
      { local: '10GE1/0/2', device: 'dc-fw1', port: 'ethernet1/3', caps: 'R', holdtime: 98 },
      { local: '10GE1/0/4', device: 'acc-sw3', port: 'GE0/0/24', caps: 'B', holdtime: 117 }
    ],
    arp: [
      { ip: '10.0.4.1', mac: '00a3.d14f.012f', iface: '10GE1/0/1', age: 12 },
      { ip: '10.0.5.2', mac: '001b.17a0.0103', iface: '10GE1/0/2', age: 7 },
      { ip: '10.10.10.57', mac: 'aabb.cc00.0110', iface: 'Vlanif10', age: 3 }
    ],
    staticRoutes: [{ prefix: '0.0.0.0', mask: 0, nextHop: '10.0.4.1', ad: 60 }],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { lldp: true, stelnet: true },
    cpu: {
      load: [9, 8, 8],
      processes: [
        { pid: 1, name: 'VPR', pct: 2 },
        { pid: 2, name: 'BGP', pct: 1 },
        { pid: 3, name: 'OSPF', pct: 0 },
        { pid: 4, name: 'IFPDT', pct: 1 },
        { pid: 5, name: 'SNMP', pct: 0 },
        { pid: 6, name: 'LLDP', pct: 0 },
        { pid: 7, name: 'SOCK', pct: 1 },
        { pid: 8, name: 'FTPS', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    vendor: {},
    sshIdent: 'HUAWEI-1.5',
    scenarios: []
  }
  logEvent(d, 'IFNET/2/linkDown_active(l):CID=0x807a0405;The interface status changes. (ifName=10GE1/0/5, AdminStatus=UP, OperStatus=DOWN, Reason=The physical link is down)', t - 2 * 3600_000)
  d.startup = snapshot(d)
  d.startup.takenAt = t - 3 * DAY
  return d
}
