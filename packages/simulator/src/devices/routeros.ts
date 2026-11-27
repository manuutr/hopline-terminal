/**
 * mt-br1: MikroTik RB5009UG+S+IN, RouterOS 7.14.3 (stable), branch router AS 65010 with eBGP to
 * core-sw1 (AS 65001) over ether1 and to a backup ISP over ether2. Values are plausible lab
 * values [unverified, from memory].
 */
import { logEvent, snapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export interface RosVendor {
  /** VLAN interfaces: name -> { vid, parent }. */
  vlanIfs: Record<string, { vid: number; parent: string }>
  /** Bridge ports: interface -> bridge. */
  bridgePorts: Record<string, string>
  /** BGP connection names by peer IP. */
  bgpNames: Record<string, string>
}

export function makeRouterosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const eth = (n: number, rest: Partial<Iface>): Iface => ({
    name: `ether${n}`,
    short: `ether${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '1000',
    mac: `48a9.8a11.22${String(n).padStart(2, '0')}`,
    media: 'RJ45',
    ...rest
  })
  const vendor: RosVendor = {
    vlanIfs: { vlan10: { vid: 10, parent: 'bridge' } },
    bridgePorts: { ether3: 'bridge', ether4: 'bridge', ether5: 'bridge' },
    bgpNames: { '10.0.6.1': 'core-sw1', '198.51.100.1': 'isp-backup' }
  }
  const d: Device = {
    platform: 'routeros',
    hostname: 'mt-br1',
    model: 'RB5009UG+S+',
    serial: 'HCQ08A1B2C3',
    version: '7.14.3',
    bootedAt: ago(30 * DAY + 3 * 3600_000 + 12 * 60_000 + 5_000),
    localAs: 65010,
    routerId: '10.255.0.30',
    user: 'admin',
    interfaces: [
      eth(1, { ip: '10.0.6.2', mask: 30, description: 'uplink to core-sw1' }),
      eth(2, { ip: '198.51.100.2', mask: 30, description: 'isp-backup' }),
      eth(3, { mode: 'access' }),
      eth(4, { mode: 'access' }),
      eth(5, { mode: 'access', linkUp: false }),
      eth(6, { adminUp: false }),
      eth(7, { linkUp: false }),
      eth(8, {}),
      { name: 'sfp-sfpplus1', short: 'sfp-sfpplus1', adminUp: true, linkUp: false, mode: 'routed', speed: '10G', mac: '48a9.8a11.2209', media: 'SFP+' },
      { name: 'bridge', short: 'bridge', ip: '192.168.88.1', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '48a9.8a11.2203' },
      { name: 'vlan10', short: 'vlan10', ip: '10.20.10.1', mask: 24, vlan: 10, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '48a9.8a11.2203' },
      { name: 'lo', short: 'lo', ip: '10.255.0.30', mask: 32, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '0000.0000.0000' }
    ],
    vlans: [{ id: 10, name: 'vlan10' }],
    vrfs: [],
    bgp: [
      {
        ip: '10.0.6.1',
        remoteAs: 65001,
        description: 'core-sw1',
        via: 'ether1',
        prefixes: 3,
        upSince: ago(30 * DAY + 3 * 3600_000),
        routerId: '10.255.0.1',
        msgRcvd: 44120,
        msgSent: 44102,
        routes: [
          { prefix: '10.10.0.0', mask: 16 },
          { prefix: '10.255.0.1', mask: 32 },
          { prefix: '172.16.0.0', mask: 16 }
        ]
      },
      {
        ip: '198.51.100.1',
        remoteAs: 64496,
        description: 'isp-backup',
        via: 'ether2',
        prefixes: 1,
        upSince: ago(6 * DAY + 5 * 3600_000),
        routerId: '198.51.100.1',
        msgRcvd: 9120,
        msgSent: 9133,
        routes: [{ prefix: '0.0.0.0', mask: 0 }]
      }
    ],
    ospf: {
      process: 'default-v2',
      routerId: '10.255.0.30',
      ifaces: [{ iface: 'ether1', area: '0', networkType: 'point-to-point' }],
      neighbors: [{ routerId: '10.255.0.1', ip: '10.0.6.1', iface: 'ether1', pri: 1, area: '0', role: '-', peerMtu: 1500, upSince: ago(30 * DAY + 3 * 3600_000) }]
    },
    mac: [],
    lldp: [{ local: 'ether1', device: 'core-sw1', port: 'Gi1/0/46', caps: 'B,R', ip: '10.255.0.1', platform: 'C9300-48P' }],
    arp: [
      { ip: '10.0.6.1', mac: '00a3.d14f.012e', iface: 'ether1', age: 1 },
      { ip: '198.51.100.1', mac: '0050.56aa.0101', iface: 'ether2', age: 2 },
      { ip: '192.168.88.254', mac: 'dc2c.6e10.0001', iface: 'bridge', age: 0 }
    ],
    staticRoutes: [{ prefix: '0.0.0.0', mask: 0, nextHop: '10.0.6.1', ad: 1 }],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { ssh: true, winbox: true, api: false },
    cpu: {
      load: [2, 2, 2],
      processes: [
        { pid: 1, name: 'networking', pct: 1 },
        { pid: 2, name: 'routing', pct: 1 },
        { pid: 3, name: 'management', pct: 0 },
        { pid: 4, name: 'ethernet', pct: 0 },
        { pid: 5, name: 'firewall', pct: 0 },
        { pid: 6, name: 'ssh', pct: 0 },
        { pid: 7, name: 'winbox', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    vendor: { routeros: vendor },
    sshIdent: 'ROSSSH',
    scenarios: []
  }
  logEvent(d, 'ether7 link down', t - 5 * 3600_000)
  d.startup = snapshot(d)
  return d
}
