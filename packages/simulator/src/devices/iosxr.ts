/**
 * pe1: ASR 9000 PE router, IOS XR 7.9.2 (64-bit eXR), AS 65100. No research doc exists for this
 * platform; values are chosen to fit the lab (edge-r1 is the Junos edge, AS 65000).
 *
 * Gi0/0/0/0  eBGP to edge-r1 (Established)
 * Gi0/0/0/1  eBGP transit to isp-r3, AS 64510: no light on the fibre, so the session is Active
 * Gi0/0/0/2  OSPF area 0 + iBGP (loopbacks) to pe2
 * Gi0/0/0/3  VRF CUST-A customer edge
 * Gi0/0/0/4  unused, shut (XR physical ports come up shut when unconfigured)
 */
import { logEvent, snapshot, type Device, type Iface } from '../state.ts'
import type { XrStore } from '../vendors/iosxr/config.ts'

const DAY = 86400_000

export function makeIosxrDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const gi = (n: number, rest: Partial<Iface>): Iface => ({
    name: `GigabitEthernet0/0/0/${n}`,
    short: `Gi0/0/0/${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '1000',
    mac: `008a.96c3.4${n}0${n}`,
    media: '1000BASE-LX',
    lastChange: ago(41 * DAY),
    ...rest
  })
  const d: Device = {
    platform: 'iosxr',
    hostname: 'pe1',
    model: 'ASR-9901',
    serial: 'FOC2316N1A8',
    version: '7.9.2',
    bootedAt: ago(41 * DAY + 7 * 3600_000 + 12 * 60_000),
    localAs: 65100,
    routerId: '10.255.1.1',
    user: 'netops',
    interfaces: [
      { name: 'Loopback0', short: 'Lo0', ip: '10.255.1.1', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '' },
      { name: 'MgmtEth0/RSP0/CPU0/0', short: 'Mg0/RSP0/CPU0/0', ip: '192.168.99.31', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '008a.96c3.40ff', vrf: 'MGMT', media: '1000BASE-T' },
      gi(0, { ip: '10.1.0.1', mask: 30, description: 'uplink to edge-r1 (AS65000)' }),
      gi(1, { ip: '198.51.100.1', mask: 30, description: 'transit isp-r3 (AS64510)', linkUp: false, lastChange: ago(3 * 3600_000 + 2 * 60_000) }),
      gi(2, { ip: '10.1.0.9', mask: 30, description: 'core to pe2' }),
      gi(3, { ip: '10.100.0.1', mask: 30, description: 'CUST-A CE', vrf: 'CUST-A' }),
      gi(4, { adminUp: false, linkUp: false })
    ],
    vlans: [],
    vrfs: [
      { name: 'CUST-A', rd: '65100:100', interfaces: [] },
      { name: 'MGMT', rd: '', interfaces: [] }
    ],
    bgp: [
      {
        ip: '10.1.0.2',
        remoteAs: 65000,
        description: 'edge-r1',
        via: 'GigabitEthernet0/0/0/0',
        prefixes: 3,
        upSince: ago(41 * DAY + 3 * 3600_000),
        routerId: '10.255.0.2',
        routeMapIn: 'EDGE-IN',
        routeMapOut: 'PASS',
        msgRcvd: 61234,
        msgSent: 61190,
        routes: [
          { prefix: '172.16.0.0', mask: 16 },
          { prefix: '172.16.8.0', mask: 22 },
          { prefix: '10.255.0.2', mask: 32 }
        ]
      },
      {
        ip: '198.51.100.2',
        remoteAs: 64510,
        description: 'isp-r3',
        via: 'GigabitEthernet0/0/0/1',
        prefixes: 0,
        downSince: ago(3 * 3600_000 + 2 * 60_000 + 11_000),
        routeMapIn: 'PASS',
        routeMapOut: 'PASS'
      },
      {
        ip: '10.255.1.2',
        remoteAs: 65100,
        description: 'pe2 (iBGP)',
        via: 'GigabitEthernet0/0/0/2',
        updateSource: 'Loopback0',
        prefixes: 2,
        upSince: ago(41 * DAY + 2 * 3600_000),
        routerId: '10.255.1.2',
        msgRcvd: 60112,
        msgSent: 60108,
        routes: [
          { prefix: '10.200.0.0', mask: 16 },
          { prefix: '10.201.0.0', mask: 24 }
        ]
      }
    ],
    ospf: {
      process: '1',
      routerId: '10.255.1.1',
      ifaces: [
        { iface: 'Loopback0', area: '0', passive: true },
        { iface: 'GigabitEthernet0/0/0/2', area: '0', networkType: 'point-to-point', cost: 10 }
      ],
      neighbors: [{ routerId: '10.255.1.2', ip: '10.1.0.10', iface: 'GigabitEthernet0/0/0/2', pri: 1, area: '0', role: '-', peerMtu: 1500, upSince: ago(41 * DAY + 2 * 3600_000) }]
    },
    mac: [],
    lldp: [
      { local: 'Gi0/0/0/0', device: 'edge-r1', port: 'ge-0/0/2', caps: 'R', ip: '10.1.0.2', holdtime: 120, chassisId: '2c6b.f5a1.0002' },
      { local: 'Gi0/0/0/2', device: 'pe2', port: 'GigabitEthernet0/0/0/2', caps: 'R', cdp: true, platform: 'cisco ASR-9901', ip: '10.1.0.10', holdtime: 120, chassisId: '008a.96c3.9900' }
    ],
    arp: [
      { ip: '10.1.0.2', mac: '2c6b.f5a1.0002', iface: 'GigabitEthernet0/0/0/0', age: 81 },
      { ip: '10.1.0.10', mac: '008a.96c3.9902', iface: 'GigabitEthernet0/0/0/2', age: 15 },
      { ip: '10.100.0.2', mac: '5c5a.c7e1.0b01', iface: 'GigabitEthernet0/0/0/3', age: 3 },
      { ip: '192.168.99.1', mac: '00a3.d14f.0063', iface: 'MgmtEth0/RSP0/CPU0/0', age: 1 }
    ],
    staticRoutes: [
      { prefix: '0.0.0.0', mask: 0, nextHop: '10.1.0.2' },
      { prefix: '0.0.0.0', mask: 0, nextHop: '192.168.99.1', vrf: 'MGMT' }
    ],
    acls: [
      {
        name: 'MGMT-ONLY',
        type: 'extended',
        entries: [
          { seq: 10, action: 'permit', text: 'ipv4 192.168.99.0 0.0.0.255 any', hits: 912 },
          { seq: 20, action: 'deny', text: 'ipv4 any any log', hits: 3 }
        ]
      }
    ],
    // IOS XR route-policies (RPL): each policy is one entry whose `set` holds the raw RPL lines.
    routeMaps: [
      { name: 'PASS', entries: [{ seq: 10, action: 'permit', match: [], set: ['pass'] }] },
      { name: 'EDGE-IN', entries: [{ seq: 10, action: 'permit', match: [], set: ['if destination in PS-EDGE then', '  set local-preference 200', '  pass', 'endif'] }] }
    ],
    // prefix-sets.
    prefixLists: [
      {
        name: 'PS-EDGE',
        entries: [
          { seq: 10, action: 'permit', prefix: '172.16.0.0/12', le: 24 },
          { seq: 20, action: 'permit', prefix: '10.255.0.0/16', ge: 32 }
        ]
      }
    ],
    services: { cdp: true, lldp: true },
    cpu: {
      load: [3, 3, 3],
      processes: [
        { pid: 1, name: 'init', pct: 0 },
        { pid: 263, name: 'ifmgr', pct: 0 },
        { pid: 346, name: 'bgp', pct: 1 },
        { pid: 371, name: 'ospf', pct: 0 },
        { pid: 402, name: 'ipv4_rib', pct: 0 },
        { pid: 455, name: 'snmpd', pct: 0 },
        { pid: 512, name: 'sshd_child_handler', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    logBase: 1290,
    vendor: { ospfRoutes: [{ prefix: '10.255.1.2', mask: 32, via: '10.1.0.10' }] },
    // [unverified, from memory] IOS XR's server announces "SSH-2.0-Cisco-2.0".
    sshIdent: 'Cisco-2.0',
    scenarios: []
  }
  logEvent(d, 'ifmgr[263]: %PKT_INFRA-LINK-3-UPDOWN : Interface GigabitEthernet0/0/0/1, changed state to Down', ago(3 * 3600_000 + 2 * 60_000 + 12_000))
  logEvent(d, 'bgp[1080]: %ROUTING-BGP-5-ADJCHANGE : neighbor 198.51.100.2 Down - Interface flap (VRF: default) (AS: 64510)', ago(3 * 3600_000 + 2 * 60_000 + 11_000))
  // Commit history: two earlier commits; the second changed the edge-r1 description.
  const after = snapshot(d)
  after.takenAt = ago(2 * DAY)
  const before = structuredClone(after)
  before.interfaces.find((i) => i.short === 'Gi0/0/0/0')!.description = 'to edge-r1'
  before.takenAt = ago(9 * DAY)
  const first = structuredClone(before)
  first.interfaces.find((i) => i.short === 'Gi0/0/0/3')!.description = undefined
  const store: XrStore = {
    seq: 1000000002,
    commits: [
      { id: '1000000002', user: 'netops', line: 'vty0:node0_RSP0_CPU0', client: 'CLI', t: ago(2 * DAY), before, after },
      { id: '1000000001', user: 'netops', line: 'vty1:node0_RSP0_CPU0', client: 'CLI', t: ago(9 * DAY), before: first, after: before }
    ],
    lastChange: { t: ago(2 * DAY), by: 'netops' }
  }
  d.vendor['iosxr'] = store
  return d
}
