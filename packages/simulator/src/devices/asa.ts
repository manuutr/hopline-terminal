/**
 * asa-edge1: Cisco ASAv (ASAv30), ASA 9.18(3)56; port names match the lab (Gi0/0 outside to pe1, Gi0/1 inside to core-sw1). No research doc exists for this platform.
 * nameif lives in `Iface.zone`; security levels, access-group bindings and the saved
 * (startup) config text live in `d.vendor.asa` (plain data).
 */
import { logEvent, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export interface AsaData {
  /** nameif -> security level. */
  levels: Record<string, number>
  /** `access-group ACL in|out interface NAME`. */
  groups: { acl: string; dir: 'in' | 'out'; iface: string }[]
  conn: { inUse: number; most: number }
  xlate: { inUse: number; most: number }
  /** Saved config text (`write memory`); undefined = never saved since boot (running = startup). */
  startup?: string
  lastChange?: { t: number; by: string }
}

export function makeAsaDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const gi = (n: number, rest: Partial<Iface>): Iface => ({
    name: `GigabitEthernet0/${n}`,
    short: `Gi0/${n}`,
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '1000',
    mac: `00a3.8e5b.110${n}`,
    ...rest
  })
  const asa: AsaData = {
    levels: { outside: 0, inside: 100, dmz: 50, management: 0 },
    groups: [
      { acl: 'OUTSIDE-IN', dir: 'in', iface: 'outside' },
      { acl: 'DMZ-IN', dir: 'in', iface: 'dmz' }
    ],
    conn: { inUse: 42, most: 1337 },
    xlate: { inUse: 12, most: 210 }
  }
  const d: Device = {
    platform: 'asa',
    hostname: 'asa-edge1',
    model: 'ASAv',
    serial: '9A6LJ0VQ3NE',
    version: '9.18(3)56',
    bootedAt: ago(41 * DAY + 7 * 3600_000 + 12 * 60_000),
    localAs: 0,
    routerId: '203.0.113.2',
    user: 'netops',
    interfaces: [
      gi(0, { ip: '203.0.113.2', mask: 29, zone: 'outside', description: 'to ISP' }),
      gi(1, { ip: '10.20.0.1', mask: 24, zone: 'inside', description: 'to core-sw1' }),
      gi(2, { ip: '172.16.50.1', mask: 24, zone: 'dmz', description: 'DMZ servers' }),
      gi(3, { adminUp: false, linkUp: false }),
      { name: 'Management0/0', short: 'Ma0/0', ip: '192.168.99.41', mask: 24, zone: 'management', adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '00a3.8e5b.11ff' }
    ],
    vlans: [],
    vrfs: [],
    bgp: [],
    mac: [],
    lldp: [],
    arp: [
      { ip: '203.0.113.1', mac: '0011.2233.4401', iface: 'GigabitEthernet0/0', age: 12 },
      { ip: '10.20.0.2', mac: '00a3.d14f.0114', iface: 'GigabitEthernet0/1', age: 30 },
      { ip: '172.16.50.10', mac: '0050.5694.0a10', iface: 'GigabitEthernet0/2', age: 2 },
      { ip: '172.16.50.11', mac: '0050.5694.0a11', iface: 'GigabitEthernet0/2', age: 7 },
      { ip: '192.168.99.1', mac: '00a3.d14f.0063', iface: 'Management0/0', age: 1 }
    ],
    staticRoutes: [
      { prefix: '0.0.0.0', mask: 0, nextHop: '203.0.113.1' },
      { prefix: '10.0.0.0', mask: 8, nextHop: '10.20.0.2' }
    ],
    acls: [
      {
        name: 'OUTSIDE-IN',
        type: 'extended',
        entries: [
          { seq: 1, action: 'permit', text: 'tcp any host 172.16.50.10 eq https', hits: 48211 },
          { seq: 2, action: 'permit', text: 'tcp any host 172.16.50.11 eq smtp', hits: 912 },
          { seq: 3, action: 'permit', text: 'icmp any any echo-reply', hits: 301 },
          { seq: 4, action: 'deny', text: 'ip any any log', hits: 17 }
        ]
      },
      {
        name: 'DMZ-IN',
        type: 'extended',
        entries: [
          { seq: 1, action: 'permit', text: 'udp 172.16.50.0 255.255.255.0 any eq domain', hits: 5531 },
          { seq: 2, action: 'deny', text: 'ip 172.16.50.0 255.255.255.0 10.0.0.0 255.0.0.0', hits: 44 },
          { seq: 3, action: 'permit', text: 'tcp 172.16.50.0 255.255.255.0 any eq https', hits: 2210 }
        ]
      }
    ],
    routeMaps: [],
    prefixLists: [],
    services: {},
    cpu: {
      load: [3, 4, 4],
      processes: [
        { pid: 1, name: 'DATAPATH-0-1471', pct: 2 },
        { pid: 2, name: 'DATAPATH-1-1472', pct: 1 },
        { pid: 3, name: 'CP Processing', pct: 0 },
        { pid: 4, name: 'SSH', pct: 0 },
        { pid: 5, name: 'Logger', pct: 0 },
        { pid: 6, name: 'ARP Thread', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    logBase: 4012,
    vendor: { asa },
    // [unverified, from memory] ASA 9.x announces "SSH-2.0-Cisco-1.25".
    sshIdent: 'Cisco-1.25',
    scenarios: []
  }
  logEvent(d, '%ASA-6-302013: Built inbound TCP connection 5521 for outside:198.51.100.7/40000 (198.51.100.7/40000) to dmz:172.16.50.10/443 (172.16.50.10/443)', ago(60_000))
  logEvent(d, '%ASA-4-106023: Deny tcp src outside:198.51.100.9/51515 dst dmz:172.16.50.12/22 by access-group "OUTSIDE-IN" [0x9c0d1e2f, 0x0]', ago(30_000))
  return d
}
