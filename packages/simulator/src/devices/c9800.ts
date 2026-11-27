/**
 * wlc-9800: Catalyst 9800-40 wireless controller, IOS-XE 17.9.4a. No research doc exists for this
 * platform; layouts are from memory of real 17.x controllers and marked `[unverified, from memory]`
 * in the vendor module. APs and clients live in `d.vendor.c9800` (plain data).
 *
 * The APs are the ones core-sw1 sees over CDP (AP-3F-East on core-sw1 Gi1/0/6, 10.10.30.20) and
 * join the controller's wireless management interface Vlan100 over the Te0/0/0 trunk.
 */
import { logEvent, snapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export interface C9800Ap {
  name: string
  model: string
  /** Ethernet MAC (dotted). */
  mac: string
  radioMac: string
  ip: string
  location: string
  slots: number
  country: string
  /** Joined since (ms epoch). */
  joinedAt: number
}

export interface C9800Client {
  mac: string
  ap: string
  wlan: number
  ip: string
  protocol: string
  method: string
  user?: string
  vlan: number
}

export interface C9800Wlan {
  id: number
  profile: string
  ssid: string
  security: string
  shutdown?: boolean
  vlan?: number
}

export interface C9800Data {
  aps: C9800Ap[]
  clients: C9800Client[]
  wlans: C9800Wlan[]
  /** Wireless management interface (CAPWAP source). */
  wmi: string
  /** Physical uplinks; APs stay joined while at least one is up. */
  uplinks: string[]
}

export function makeC9800Device(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const te = (n: number, rest: Partial<Iface>): Iface => ({
    name: `TenGigabitEthernet0/0/${n}`,
    short: `Te0/0/${n}`,
    adminUp: true,
    linkUp: false,
    mode: 'trunk',
    speed: '10G',
    mac: `00a3.8e7c.0${n}0${n}`,
    media: 'SFP-10GBase-SR',
    ...rest
  })
  const c9800: C9800Data = {
    wmi: 'Vlan100',
    uplinks: ['TenGigabitEthernet0/0/0', 'TenGigabitEthernet0/0/1'],
    wlans: [
      { id: 1, profile: 'CORP-WLAN', ssid: 'CORP', security: '[WPA2][802.1x][AES]', vlan: 30 },
      { id: 2, profile: 'GUEST-WLAN', ssid: 'Guest', security: '[WPA2][PSK][AES]', vlan: 40 },
      { id: 3, profile: 'IOT-WLAN', ssid: 'iot', security: '[WPA2][PSK][AES]', vlan: 30, shutdown: true }
    ],
    aps: [
      { name: 'AP-3F-East', model: 'C9120AXI-B', mac: 'f4db.e6a0.1c11', radioMac: 'f4db.e6b1.2c40', ip: '10.10.30.20', location: '3F East', slots: 2, country: 'US', joinedAt: ago(12 * DAY) },
      { name: 'AP-3F-West', model: 'C9120AXI-B', mac: 'f4db.e6a0.1d22', radioMac: 'f4db.e6b1.3d80', ip: '10.10.30.21', location: '3F West', slots: 2, country: 'US', joinedAt: ago(12 * DAY) },
      { name: 'AP-2F-Lobby', model: 'C9130AXI-B', mac: '70d3.79c2.0a33', radioMac: '70d3.79d4.1be0', ip: '10.10.30.22', location: '2F Lobby', slots: 3, country: 'US', joinedAt: ago(3 * DAY) }
    ],
    clients: [
      { mac: '3c22.fb12.aa01', ap: 'AP-3F-East', wlan: 1, ip: '10.10.30.112', protocol: '11ax(5)', method: 'Dot1x', user: 'alice', vlan: 30 },
      { mac: '9c3d.cf44.0b17', ap: 'AP-3F-East', wlan: 1, ip: '10.10.30.131', protocol: '11ac', method: 'Dot1x', user: 'bob', vlan: 30 },
      { mac: 'a4c3.f0d1.77e2', ap: 'AP-3F-West', wlan: 2, ip: '10.10.40.57', protocol: '11n(2.4)', method: 'None', vlan: 40 },
      { mac: 'dc71.96aa.3e09', ap: 'AP-2F-Lobby', wlan: 2, ip: '10.10.40.61', protocol: '11ax(5)', method: 'None', vlan: 40 }
    ]
  }
  const d: Device = {
    platform: 'c9800',
    hostname: 'wlc-9800',
    model: 'C9800-40-K9',
    serial: 'TTM23180Q2C',
    version: '17.9.4a',
    bootedAt: ago(41 * DAY + 7 * 3600_000 + 12 * 60_000),
    localAs: 0,
    routerId: '10.10.100.5',
    user: 'netops',
    interfaces: [
      te(0, { description: 'uplink to core-sw1 Te1/1/1', linkUp: true, trunkAllowed: [30, 40, 100] }),
      te(1, { description: 'uplink to core-sw1 Te1/1/2 (standby)', linkUp: true, trunkAllowed: [30, 40, 100] }),
      te(2, { adminUp: false }),
      te(3, { adminUp: false }),
      { name: 'GigabitEthernet0', short: 'Gi0', ip: '192.168.99.61', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '1000', mac: '00a3.8e7c.00ff', vrf: 'Mgmt-intf', ipMethod: 'NVRAM', media: 'RJ45' },
      { name: 'Vlan1', short: 'Vl1', adminUp: false, linkUp: true, mode: 'routed', speed: '', mac: '00a3.8e7c.0b01', ipMethod: 'unset' },
      { name: 'Vlan100', short: 'Vl100', ip: '10.10.100.5', mask: 24, description: 'Wireless Management', adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '00a3.8e7c.0b64', ipMethod: 'NVRAM' }
    ],
    vlans: [
      { id: 1, name: 'default' },
      { id: 30, name: 'WIFI' },
      { id: 40, name: 'GUEST' },
      { id: 100, name: 'WLC-MGMT' }
    ],
    vrfs: [{ name: 'Mgmt-intf', rd: '', interfaces: [] }],
    bgp: [],
    mac: [],
    lldp: [{ local: 'Te0/0/0', device: 'core-sw1', port: 'Te1/1/1', caps: 'B,R', cdp: true, platform: 'C9300-48P', holdtime: 151, ip: '10.255.0.1' }],
    arp: [
      { ip: '10.10.100.1', mac: '00a3.d14f.0a64', iface: 'Vlan100', age: 2 },
      { ip: '192.168.99.1', mac: '00a3.d14f.0063', iface: 'GigabitEthernet0', age: 5 }
    ],
    staticRoutes: [
      { prefix: '0.0.0.0', mask: 0, nextHop: '10.10.100.1' },
      { prefix: '0.0.0.0', mask: 0, nextHop: '192.168.99.1', vrf: 'Mgmt-intf' }
    ],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { 'domain-lookup': false, 'http-server': true, cdp: true, lldp: false },
    cpu: {
      load: [4, 5, 5],
      processes: [
        { pid: 1, name: 'Chunk Manager', pct: 0 },
        { pid: 85, name: 'IOSD ipc task', pct: 1 },
        { pid: 132, name: 'IP Input', pct: 0 },
        { pid: 301, name: 'wncd_0', pct: 2 },
        { pid: 302, name: 'wncmgrd', pct: 1 },
        { pid: 412, name: 'SNMP ENGINE', pct: 0 },
        { pid: 523, name: 'HTTP CORE', pct: 0 }
      ]
    },
    extraConfig: [],
    log: [],
    logBase: 87,
    vendor: { c9800 },
    // [unverified, from memory] IOS-XE controllers announce the same SSH ident as IOS-XE switches.
    sshIdent: 'Cisco-1.25',
    scenarios: []
  }
  logEvent(d, '%CAPWAPAC_SMGR_TRACE_MESSAGE-5-AP_JOIN_DISJOIN: Chassis 1 R0/0: wncd: AP Event: AP Name: AP-2F-Lobby, MAC: 70d3.79d4.1be0 Joined', ago(3 * DAY))
  logEvent(d, '%SYS-5-CONFIG_I: Configured from console by netops on vty0 (10.10.10.50)', ago(2 * 3600_000))
  d.startup = snapshot(d)
  return d
}
