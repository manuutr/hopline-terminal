/**
 * leaf1: Nexus N9K-C93180YC-FX, NX-OS 10.3(4a), AS 65020. Values follow the fixture table and the
 * samples in docs/research/cli-cisco-nxos.md §6, so the golden transcripts replay against model
 * state rather than canned strings.
 */
import { logEvent, snapshot, type Device, type Iface } from '../state.ts'

const S = 1000
const M = 60 * S
const H = 60 * M
const DAY = 24 * H

export function makeNxosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  // show version: "Kernel uptime is 3 day(s), 22 hour(s), 59 minute(s), 33 second(s)".
  const bootedAt = ago(3 * DAY + 22 * H + 59 * M + 33 * S)
  const eth = (n: string, rest: Partial<Iface>): Iface => ({
    name: `Ethernet${n}`,
    short: `Eth${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'access',
    vlan: 1,
    speed: '25G',
    mac: `00de.fb20.01${n.split('/').at(-1)!.padStart(2, '0')}`,
    media: '25G',
    ...rest
  })
  const d: Device = {
    platform: 'nxos',
    hostname: 'leaf1',
    model: 'N9K-C93180YC-FX',
    serial: 'FDO23260XYZ',
    version: '10.3(4a)',
    bootedAt,
    localAs: 65020,
    routerId: '10.255.0.20',
    user: 'admin',
    interfaces: [
      { name: 'mgmt0', short: 'mgmt0', ip: '192.168.100.20', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '00de.fb20.0000', vrf: 'management' },
      eth('1/1', { vlan: 100 }),
      eth('1/2', { vlan: 100 }),
      eth('1/3', { vlan: 200, linkUp: false }),
      eth('1/47', { mode: 'trunk', vlan: undefined, nativeVlan: 1, trunkAllowed: [100, 200], channelGroup: 10, description: 'dist-eos1 Ethernet45' }),
      eth('1/48', { mode: 'trunk', vlan: undefined, nativeVlan: 1, trunkAllowed: [100, 200], channelGroup: 10, description: 'dist-eos1 Ethernet46' }),
      eth('1/49', { mode: 'routed', vlan: undefined, ip: '10.0.2.1', mask: 31, description: 'spine1 Ethernet1/1', speed: '100G', mtu: 9216, media: '100G' }),
      eth('1/50', { mode: 'routed', vlan: undefined, ip: '10.0.2.3', mask: 31, description: 'spine2 Ethernet1/1', speed: '100G', mtu: 9216, adminUp: false, media: '100G', lastChange: ago(21 * H + 21 * M + 53 * S) }),
      { name: 'port-channel10', short: 'Po10', adminUp: true, linkUp: true, mode: 'trunk', nativeVlan: 1, trunkAllowed: [100, 200], speed: '25G', mac: '00de.fb20.0147', description: 'dist-eos1' },
      { name: 'loopback0', short: 'Lo0', ip: '10.255.0.20', mask: 32, description: 'router-id / BGP source', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '' },
      { name: 'Vlan100', short: 'Vlan100', ip: '10.20.100.1', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00de.fb20.0001', vrf: 'TENANT-A' },
      { name: 'Vlan200', short: 'Vlan200', ip: '10.20.200.1', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00de.fb20.0001', vrf: 'TENANT-A' }
    ],
    vlans: [
      { id: 1, name: 'default' },
      { id: 100, name: 'DB' },
      { id: 200, name: 'APP' }
    ],
    vrfs: [
      { name: 'management', rd: '', interfaces: ['mgmt0'] },
      { name: 'TENANT-A', rd: 'auto', interfaces: ['Vlan100', 'Vlan200'] }
    ],
    bgp: [
      {
        ip: '10.0.2.0',
        remoteAs: 65100,
        description: 'spine1',
        via: 'Ethernet1/49',
        prefixes: 12,
        upSince: bootedAt + 3 * M + 21 * S,
        routerId: '10.255.0.101',
        msgRcvd: 5531,
        msgSent: 5472,
        routeMapOut: 'RM-SPINE-OUT',
        updateSource: 'loopback0',
        routes: [{ prefix: '10.100.0.0', mask: 16 }]
      },
      { ip: '10.0.2.2', remoteAs: 65100, description: 'spine2', via: 'Ethernet1/50', prefixes: 0, shutdown: true, downSince: ago(19 * H + 21 * M + 26 * S), routerId: '10.255.0.102', updateSource: 'loopback0' }
    ],
    ospf: {
      process: 'UNDERLAY',
      routerId: '10.255.0.20',
      ifaces: [
        { iface: 'Ethernet1/49', area: '0.0.0.0', networkType: 'point-to-point' },
        { iface: 'Ethernet1/50', area: '0.0.0.0', networkType: 'point-to-point' },
        { iface: 'loopback0', area: '0.0.0.0' }
      ],
      neighbors: [
        { routerId: '10.255.0.101', ip: '10.0.2.0', iface: 'Ethernet1/49', pri: 1, area: '0.0.0.0', role: '-', peerMtu: 9216, upSince: bootedAt + 3 * M + 13 * S },
        { routerId: '10.255.0.102', ip: '10.0.2.2', iface: 'Ethernet1/50', pri: 1, area: '0.0.0.0', role: '-', peerMtu: 9216 }
      ]
    },
    mac: [
      { vlan: 100, mac: '0050.56a1.0101', port: 'Eth1/1' },
      { vlan: 100, mac: '0050.56a1.0102', port: 'Eth1/2' },
      { vlan: 200, mac: '0050.56a1.0203', port: 'Po10' },
      { vlan: 100, mac: '00de.fb20.0001', port: 'sup-eth1(R)', type: 'STATIC' }
    ],
    lldp: [
      { local: 'Eth1/49', device: 'spine1', port: 'Ethernet1/1', caps: 'BR', holdtime: 120, sysDescr: 'Cisco Nexus Operating System (NX-OS) Software 10.3(4a)', ip: '10.255.0.101' },
      { local: 'Eth1/47', device: 'dist-eos1', port: 'Ethernet45', caps: 'BR', holdtime: 120, sysDescr: 'Arista Networks EOS version 4.31.2F running on an Arista DCS-7050SX3-48YC8', ip: '10.255.0.10' },
      { local: 'Eth1/48', device: 'dist-eos1', port: 'Ethernet46', caps: 'BR', holdtime: 120, sysDescr: 'Arista Networks EOS version 4.31.2F running on an Arista DCS-7050SX3-48YC8', ip: '10.255.0.10' }
    ],
    arp: [
      // Ages are minutes (fractional): show ip arp prints them as hh:mm:ss.
      { ip: '10.0.2.0', mac: '00de.fb65.0101', iface: 'Ethernet1/49', age: 764 / 60 },
      { ip: '192.168.100.1', mac: '0000.0c9f.f001', iface: 'mgmt0', age: 250 / 60 },
      { ip: '10.20.100.11', mac: '0050.56a1.0101', iface: 'Vlan100', age: 62 / 60 },
      { ip: '10.20.100.12', mac: '0050.56a1.0102', iface: 'Vlan100', age: 57 / 60 }
    ],
    staticRoutes: [{ prefix: '0.0.0.0', mask: 0, nextHop: '192.168.100.1', vrf: 'management' }],
    acls: [
      {
        name: 'ACL-MGMT-IN',
        type: 'extended',
        entries: [
          { seq: 10, action: 'permit', text: 'tcp 192.168.100.0/24 any eq 22', hits: 1832 },
          { seq: 20, action: 'deny', text: 'ip any any log', hits: 4 }
        ]
      }
    ],
    routeMaps: [{ name: 'RM-SPINE-OUT', entries: [{ seq: 10, action: 'permit', match: ['ip address prefix-list PL-LOOPBACKS'], set: [] }] }],
    prefixLists: [{ name: 'PL-LOOPBACKS', entries: [{ seq: 5, action: 'permit', prefix: '10.255.0.0/16', ge: 32 }] }],
    services: {
      'feature-bash-shell': true,
      'feature-ospf': true,
      'feature-bgp': true,
      'feature-interface-vlan': true,
      'feature-lacp': true,
      'feature-lldp': true,
      cdp: true
    },
    cpu: {
      load: [3, 4, 4],
      processes: [
        { pid: 1, name: 'init', pct: 0 },
        { pid: 4321, name: 'sysmgr', pct: 0 },
        { pid: 11002, name: 'netstack', pct: 1 },
        { pid: 11234, name: 'ospf', pct: 0 },
        { pid: 11502, name: 'bgp', pct: 1 },
        { pid: 11630, name: 'lldp', pct: 0 },
        { pid: 11688, name: 'cdpd', pct: 0 },
        { pid: 12010, name: 'snmpd', pct: 0 },
        { pid: 12455, name: 'nginx', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    vendor: {
      // NX-OS CDP neighbors: device-id is hostname(serial) and differs from the LLDP system name.
      cdp: [
        { local: 'Eth1/49', device: 'spine1(FDO24120AB1)', holdtime: 133, caps: 'R S I s', platform: 'N9K-C9364C', port: 'Eth1/1' },
        { local: 'mgmt0', device: 'mgmt-sw1', holdtime: 179, caps: 'S I', platform: 'WS-C3850-48T', port: 'Gig1/0/20' }
      ],
      ospfRoutes: [{ prefix: '10.255.0.101', mask: 32, via: '10.0.2.0', metric: 41 }],
      nxosLastChange: ago(2 * H + 47 * M + 9 * S)
    },
    scenarios: []
  }
  logEvent(d, '%ETHPORT-5-IF_UP: Interface Ethernet1/49 is up in mode routed', bootedAt + 3 * M)
  logEvent(d, '%OSPF-5-ADJCHANGE:  ospf-UNDERLAY [11234]  Nbr 10.255.0.101 on Ethernet1/49 went FULL', bootedAt + 3 * M + 13 * S)
  logEvent(d, '%BGP-5-ADJCHANGE:  bgp-65020 [11502] (default) neighbor 10.0.2.0 Up ', bootedAt + 3 * M + 21 * S)
  logEvent(d, '%ETHPORT-5-IF_ADMIN_DOWN: Interface Ethernet1/50 is admin down (Administratively down)', ago(21 * H + 21 * M + 53 * S))
  logEvent(d, '%BGP-5-ADJCHANGE:  bgp-65020 [11502] (default) neighbor 10.0.2.2 Down - sent:  administratively shutdown', ago(21 * H + 21 * M + 53 * S))
  logEvent(d, '%VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by admin on 192.168.100.5@pts/0', ago(2 * H + 47 * M + 9 * S))
  d.startup = snapshot(d)
  d.startup.takenAt = ago(2 * H + 40 * M)
  return d
}
