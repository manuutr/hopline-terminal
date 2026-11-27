/** edge-r1: vMX, Junos 22.4R3.25, AS 65000 (docs/research/cli-juniper-junos.md lab table and §6.2). */
import type { Device, Iface } from '../state.ts'

const DAY = 86400_000
const H = 3600_000
const M = 60_000

export function makeJunosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const linkSince = ago(3 * DAY + 4 * H + 13 * M + 40_000)
  const ge = (n: number, extra: Partial<Iface>): Iface => ({
    name: `ge-0/0/${n}`,
    short: `ge-0/0/${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '1000',
    mac: `00:05:86:71:2c:0${n}`,
    lastChange: linkSince,
    ...extra
  })
  const d: Device = {
    platform: 'junos',
    hostname: 'edge-r1',
    model: 'vmx',
    serial: 'VM5F0A1C3D2E',
    version: '22.4R3.25',
    bootedAt: ago(3 * DAY + 4 * H + 16 * M),
    localAs: 65000,
    routerId: '10.255.0.2',
    user: 'netops',
    interfaces: [
      ge(0, { ip: '203.0.113.2', mask: 30, description: 'TRANSIT-A', units: [0] }),
      ge(1, { ip: '10.0.0.6', mask: 30, description: 'core-sw1:Gi1/0/1', units: [0] }),
      ge(2, { adminUp: false, linkUp: true }),
      { name: 'fxp0', short: 'fxp0', ip: '192.168.100.11', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '00:05:86:71:2c:ff', vrf: 'mgmt_junos', units: [0], lastChange: linkSince },
      { name: 'lo0', short: 'lo0', ip: '10.255.0.2', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '', units: [0], lastChange: ago(3 * DAY + 4 * H + 13 * M + 41_000) }
    ],
    vlans: [],
    vrfs: [{ name: 'mgmt_junos', rd: '', interfaces: ['fxp0'] }],
    bgp: [
      {
        ip: '10.0.0.5',
        remoteAs: 65001,
        description: 'CORE',
        via: 'ge-0/0/1',
        prefixes: 3,
        upSince: ago(3 * DAY + 4 * H + 12 * M + 55_000),
        routerId: '10.255.0.1',
        msgRcvd: 5321,
        msgSent: 5307,
        // The doc's show route has only the default from this peer although 3 prefixes are counted.
        routes: [{ prefix: '0.0.0.0', mask: 0 }]
      },
      { ip: '203.0.113.1', remoteAs: 64500, description: 'TRANSIT', via: 'ge-0/0/0', prefixes: 0, downSince: ago(3 * DAY + 4 * H + 13 * M + 40_000), routeMapOut: 'TRANSIT-OUT' }
    ],
    ospf: {
      process: '0',
      routerId: '10.255.0.2',
      ifaces: [
        { iface: 'ge-0/0/1', area: '0.0.0.0', networkType: 'point-to-point' },
        { iface: 'lo0', area: '0.0.0.0', passive: true }
      ],
      neighbors: [{ routerId: '10.255.0.1', ip: '10.0.0.5', iface: 'ge-0/0/1', pri: 1, area: '0.0.0.0', role: '-', upSince: ago(3 * DAY + 4 * H + 12 * M + 58_000) }]
    },
    mac: [],
    lldp: [
      { local: 'fxp0', parent: '-', device: 'oob-sw1', port: 'Gi0/12', chassisId: '00:1b:54:aa:10:00', caps: 'B' },
      { local: 'ge-0/0/1', parent: '-', device: 'core-sw1', port: 'Gi1/0/1', chassisId: '00:0c:29:5e:a1:00', caps: 'B,R' }
    ],
    arp: [
      { ip: '10.0.0.5', mac: '00:0c:29:5e:a1:47', iface: 'ge-0/0/1', age: 0 },
      { ip: '192.168.100.1', mac: '00:00:5e:00:01:0a', iface: 'fxp0', age: 0 },
      { ip: '203.0.113.1', mac: '2c:6b:f5:10:44:01', iface: 'ge-0/0/0', age: 0 }
    ],
    staticRoutes: [],
    acls: [],
    routeMaps: [],
    prefixLists: [{ name: 'OUR-AGG', entries: [{ seq: 5, action: 'permit', prefix: '198.51.100.0/24' }] }],
    services: { ssh: true },
    cpu: {
      load: [3, 3, 3],
      processes: [
        { pid: 5123, name: 'rpd', pct: 0.4 },
        { pid: 6120, name: 'mib2d', pct: 0.1 },
        { pid: 7703, name: 'mgd', pct: 0.2 },
        { pid: 4301, name: 'chassisd', pct: 0.3 },
        { pid: 4410, name: 'snmpd', pct: 0.1 }
      ]
    },
    extraConfig: [],
    log: [
      { t: Date.UTC(2026, 10, 24, 9, 10, 2), msg: 'mib2d[6120]: SNMP_TRAP_LINK_DOWN: ifIndex 528, ifAdminStatus down(2), ifOperStatus down(2), ifName ge-0/0/2' },
      { t: Date.UTC(2026, 10, 24, 9, 11, 47), msg: 'rpd[5123]: BGP_NEIGHBOR_STATE_CHANGED: BGP peer 203.0.113.1 (External AS 64500) changed state from Established to Idle (event HoldTime) (instance master)' },
      { t: Date.UTC(2026, 10, 24, 9, 12, 15), msg: 'sshd[7701]: Accepted publickey for netops from 192.168.100.50 port 51522 ssh2' },
      { t: Date.UTC(2026, 10, 24, 9, 12, 31), msg: "mgd[7703]: UI_DBASE_LOGIN_EVENT: User 'netops' entering configuration mode" },
      { t: Date.UTC(2026, 10, 24, 9, 14, 5), msg: "mgd[7703]: UI_COMMIT: User 'netops' requested 'commit' operation (comment: spare desc)" },
      { t: Date.UTC(2026, 10, 24, 9, 14, 9), msg: "mgd[7703]: UI_DBASE_LOGOUT_EVENT: User 'netops' exiting configuration mode" }
    ],
    vendor: {
      /** Seed for the set-line config (vendors/junos/conf.ts builds the rest from the model). */
      junosSeed: {
        groups: [
          { name: 'CORE', type: 'external', peerAs: 65001, neighbors: ['10.0.0.5'] },
          { name: 'TRANSIT', type: 'external', export: 'TRANSIT-OUT', peerAs: 64500, neighbors: ['203.0.113.1'] }
        ],
        policy: [
          'policy-options policy-statement TRANSIT-OUT term AGG from prefix-list OUR-AGG',
          'policy-options policy-statement TRANSIT-OUT term AGG then accept',
          'policy-options policy-statement TRANSIT-OUT term REST then reject'
        ],
        ospfRoutes: [{ prefix: '10.255.0.1', mask: 32, via: '10.0.0.5', metric: 1 }]
      }
    },
    sshIdent: 'OpenSSH_7.5',
    scenarios: []
  }
  return d
}
