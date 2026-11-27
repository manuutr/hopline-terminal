/**
 * fw1: PA-VM on PAN-OS 11.1.6, AS 65020, legacy routing engine, virtual router `default`
 * (docs/research/cli-paloalto-panos.md lab topology and section 6 samples). Values the doc pins
 * byte-for-byte (route ages, ARP TTLs, job ids) are set relative to the factory clock `t`.
 */
import type { Device, Iface } from '../state.ts'

const DAY = 86400_000
const H = 3600_000
const M = 60_000

/** Plain vendor data (d.vendor.panos): everything PAN-OS shows that the shared model has no field for. */
export interface PanosRule {
  name: string
  from: string[]
  to: string[]
  source: string[]
  destination: string[]
  application: string[]
  service: string[]
  action: string
  description?: string
  disabled?: boolean
}

export interface PanosSession {
  id: number
  vsys: number
  app: string
  state: string
  type: string
  flag: string
  proto: number
  src: string
  sport: number
  from: string
  natSrc: string
  natSport: number
  dst: string
  dport: number
  to: string
  natDst: string
  natDport: number
  /** Matched rule and start time (ms epoch). */
  rule: string
  start: number
}

export interface PanosJob {
  id: number
  type: string
  enq: number
  deq: number
  done: number
  status: string
  result: string
  details?: string
}

export interface PanosData {
  /** Interface ids (`show interface all` id column). */
  ifIds: Record<string, number>
  /** Aggregate members (shown under `aggregation groups`). */
  aeMembers: Record<string, string[]>
  /** Interface management profile per interface. */
  mgmtProfile: Record<string, string>
  /** OSPF-learned prefixes (installed while the adjacency is full). */
  ospfRoutes: { prefix: string; mask: number; via: string; iface: string; metric: number }[]
  /** BGP prefixes advertised to each peer. */
  advertised: Record<string, number>
  rules: PanosRule[]
  addresses: { name: string; ipNetmask?: string; fqdn?: string; description?: string }[]
  sessions: PanosSession[]
  counters: { name: string; value: number; rate: number; severity: string; category: string; aspect: string; description: string }[]
  lastCounterSample: number
  jobs: PanosJob[]
  nextJob: number
  arpTtl: Record<string, number>
  macTtl: Record<string, number>
  lldpPortDescr: Record<string, string>
  mgmt: { ip: string; mask: string; gw: string; mac: string }
  ha: { peer: string; localState: string; peerState: string; since: number }
}

export function makePanosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const linkSince = ago(12 * DAY)
  const eth = (n: number, extra: Partial<Iface>): Iface => ({
    name: `ethernet1/${n}`,
    short: `ethernet1/${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '1000',
    mac: `00:50:56:8a:10:0${n}`,
    lastChange: linkSince,
    ...extra
  })
  const virt = (name: string, mac: string, extra: Partial<Iface> = {}): Iface => ({ name, short: name, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac, lastChange: linkSince, ...extra })
  const panos: PanosData = {
    ifIds: { 'ethernet1/1': 16, 'ethernet1/2': 17, 'ethernet1/3': 18, 'ethernet1/4': 19, 'ethernet1/3.100': 256, ae1: 64, vlan: 1, loopback: 3, 'loopback.1': 257, tunnel: 4, 'tunnel.1': 258 },
    aeMembers: { ae1: ['ethernet1/5', 'ethernet1/6'] },
    mgmtProfile: { 'ethernet1/1': 'allow-ping', 'ethernet1/2': 'allow-ping' },
    ospfRoutes: [
      { prefix: '10.10.10.0', mask: 24, via: '10.0.3.5', iface: 'ethernet1/2', metric: 10 },
      { prefix: '10.10.20.0', mask: 24, via: '10.0.3.5', iface: 'ethernet1/2', metric: 10 },
      { prefix: '10.255.0.1', mask: 32, via: '10.0.3.5', iface: 'ethernet1/2', metric: 11 }
    ],
    advertised: { '10.0.3.1': 6, '10.0.3.5': 2 },
    rules: [
      { name: 'trust-to-untrust', from: ['trust'], to: ['untrust'], source: ['any'], destination: ['any'], application: ['ssl', 'web-browsing'], service: ['application-default'], action: 'allow' },
      { name: 'dmz-web-out', from: ['dmz'], to: ['untrust'], source: ['dmz-net'], destination: ['any'], application: ['ssl', 'web-browsing'], service: ['application-default'], action: 'allow' },
      { name: 'dmz-dns-out', from: ['dmz'], to: ['untrust'], source: ['dmz-net'], destination: ['8.8.8.8', '8.8.4.4'], application: ['dns'], service: ['application-default'], action: 'allow' },
      { name: 'deny-dmz-to-trust', from: ['dmz'], to: ['trust'], source: ['any'], destination: ['any'], application: ['any'], service: ['any'], action: 'deny' }
    ],
    addresses: [{ name: 'dmz-net', ipNetmask: '10.100.0.0/24', description: 'DMZ servers' }],
    sessions: [
      { id: 35299, vsys: 1, app: 'ssl', state: 'ACTIVE', type: 'FLOW', flag: 'NS', proto: 6, src: '10.100.0.10', sport: 52648, from: 'dmz', natSrc: '10.0.3.2', natSport: 19044, dst: '93.184.216.34', dport: 443, to: 'untrust', natDst: '93.184.216.34', natDport: 443, rule: 'dmz-web-out', start: ago(42_000) },
      { id: 35301, vsys: 1, app: 'dns-base', state: 'ACTIVE', type: 'FLOW', flag: 'NS', proto: 17, src: '10.100.0.11', sport: 40112, from: 'dmz', natSrc: '10.0.3.2', natSport: 23811, dst: '8.8.8.8', dport: 53, to: 'untrust', natDst: '8.8.8.8', natDport: 53, rule: 'dmz-dns-out', start: ago(3_000) }
    ],
    counters: [
      { name: 'pkt_recv', value: 1832, rate: 33, severity: 'info', category: 'packet', aspect: 'pktproc', description: 'Packets received' },
      { name: 'pkt_sent', value: 1710, rate: 30, severity: 'info', category: 'packet', aspect: 'pktproc', description: 'Packets transmitted' },
      { name: 'flow_ipv6_disabled', value: 3, rate: 0, severity: 'drop', category: 'flow', aspect: 'parse', description: 'Packets dropped: IPv6 disabled on interface' },
      { name: 'flow_policy_deny', value: 12, rate: 0, severity: 'drop', category: 'flow', aspect: 'session', description: 'Session setup: denied by policy' },
      { name: 'flow_host_service_deny', value: 4, rate: 0, severity: 'drop', category: 'flow', aspect: 'mgmt', description: 'Device management session denied' }
    ],
    lastCounterSample: ago(55_446),
    jobs: [
      { id: 409, type: 'Validate', enq: Date.UTC(2026, 10, 23, 22, 14, 50), deq: Date.UTC(2026, 10, 23, 22, 14, 50), done: Date.UTC(2026, 10, 23, 22, 15, 18), status: 'FIN', result: 'OK', details: 'Configuration is valid' },
      { id: 410, type: 'Downld', enq: Date.UTC(2026, 10, 24, 1, 0, 7), deq: Date.UTC(2026, 10, 24, 1, 0, 7), done: Date.UTC(2026, 10, 24, 1, 0, 19), status: 'FIN', result: 'OK' },
      { id: 411, type: 'FqdnRefresh', enq: Date.UTC(2026, 10, 24, 8, 30, 2), deq: Date.UTC(2026, 10, 24, 8, 30, 2), done: Date.UTC(2026, 10, 24, 8, 30, 9), status: 'FIN', result: 'OK' },
      { id: 412, type: 'Commit', enq: Date.UTC(2026, 10, 24, 9, 5, 12), deq: Date.UTC(2026, 10, 24, 9, 5, 12), done: Date.UTC(2026, 10, 24, 9, 5, 41), status: 'FIN', result: 'OK', details: 'Configuration committed successfully' }
    ],
    nextJob: 413,
    arpTtl: { '10.0.3.1': 1712, '10.0.3.5': 1544, '10.100.0.10': 903, '10.100.0.11': 2 },
    macTtl: { '00:50:56:8a:30:01': 1778, '00:50:56:8a:30:02': 1796 },
    lldpPortDescr: { 'ethernet1/2': 'to-fw1' },
    mgmt: { ip: '10.255.10.10', mask: '255.255.255.0', gw: '10.255.10.1', mac: '00:50:56:8a:10:00' },
    ha: { peer: 'fw2', localState: 'active', peerState: 'passive', since: ago(12 * DAY) }
  }
  const d: Device = {
    platform: 'panos',
    hostname: 'fw1',
    model: 'PA-VM',
    serial: '007954000123456',
    version: '11.1.6',
    bootedAt: ago(12 * DAY + 3 * H + 41 * M + 7_000),
    localAs: 65020,
    routerId: '10.255.0.20',
    user: 'admin',
    interfaces: [
      eth(1, { ip: '10.0.3.2', mask: 30, zone: 'untrust', description: 'to edge-r1' }),
      eth(2, { ip: '10.0.3.6', mask: 30, zone: 'trust' }),
      eth(3, {}),
      virt('ethernet1/3.100', '00:50:56:8a:10:03', { ip: '10.100.0.1', mask: 24, zone: 'dmz', vlan: 100 }),
      eth(4, { linkUp: false }),
      virt('ae1', '00:50:56:8a:10:40'),
      virt('vlan', '00:50:56:8a:10:01'),
      virt('loopback', '00:50:56:8a:10:03'),
      virt('loopback.1', '00:50:56:8a:10:03', { ip: '10.255.0.20', mask: 32, zone: 'trust' }),
      virt('tunnel', '00:50:56:8a:10:04'),
      virt('tunnel.1', '00:50:56:8a:10:04', { ip: '169.254.10.1', mask: 30, zone: 'vpn' })
    ],
    vlans: [{ id: 10, name: 'l2-lab' }],
    vrfs: [],
    bgp: [
      { ip: '10.0.3.1', remoteAs: 65000, description: 'edge-r1', via: 'ethernet1/1', prefixes: 1, upSince: ago(86012_000), routerId: '10.255.0.2', msgRcvd: 1462, msgSent: 1470, routes: [{ prefix: '0.0.0.0', mask: 0 }] },
      { ip: '10.0.3.5', remoteAs: 65001, description: 'core-sw1', via: 'ethernet1/2', prefixes: 5, upSince: ago(86020_000), routerId: '10.255.0.1', msgRcvd: 1488, msgSent: 1475, routes: [] }
    ],
    ospf: {
      process: '0',
      routerId: '10.255.0.20',
      ifaces: [
        { iface: 'ethernet1/2', area: '0.0.0.0', networkType: 'point-to-point' },
        { iface: 'loopback.1', area: '0.0.0.0', passive: true }
      ],
      neighbors: [{ routerId: '10.255.0.1', ip: '10.0.3.5', iface: 'ethernet1/2', pri: 1, area: '0.0.0.0', role: '-', upSince: ago(86020_000) }]
    },
    mac: [
      { vlan: 10, mac: '00:50:56:8a:30:01', port: 'ethernet1/7' },
      { vlan: 10, mac: '00:50:56:8a:30:02', port: 'ethernet1/8' }
    ],
    lldp: [
      {
        local: 'ethernet1/2',
        device: 'core-sw1',
        port: 'Gi1/0/47',
        chassisId: '70:0f:6a:b2:30:00',
        caps: 'B,R',
        holdtime: 120,
        sysDescr: 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a'
      }
    ],
    arp: [
      { ip: '10.0.3.1', mac: '2c:6b:f5:a1:00:01', iface: 'ethernet1/1', age: 1 },
      { ip: '10.0.3.5', mac: '70:0f:6a:b2:30:30', iface: 'ethernet1/2', age: 4 },
      { ip: '10.100.0.10', mac: '00:50:56:8a:20:0a', iface: 'ethernet1/3.100', age: 14 },
      { ip: '10.100.0.11', mac: '', iface: 'ethernet1/3.100', age: 0 }
    ],
    staticRoutes: [{ prefix: '172.16.0.0', mask: 16, nextHop: '169.254.10.2', name: 'to-branch', ad: 10 }],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { ssh: true, https: true },
    cpu: {
      load: [4, 3, 3],
      processes: [
        { pid: 3412, name: 'mgmtsrvr', pct: 0.8 },
        { pid: 3398, name: 'devsrvr', pct: 0.4 },
        { pid: 3520, name: 'routed', pct: 0.2 },
        { pid: 3601, name: 'useridd', pct: 0.1 }
      ]
    },
    extraConfig: [],
    log: [
      { t: Date.UTC(2026, 10, 24, 9, 5, 41), msg: 'general  Commit job 412 succeeded by admin' },
      { t: Date.UTC(2026, 10, 24, 9, 1, 2), msg: 'auth     User admin logged in via SSH from 10.10.10.50' }
    ],
    vendor: { panosData: panos },
    sshIdent: 'PaloAltoNetworks_0.2',
    scenarios: []
  }
  return d
}
