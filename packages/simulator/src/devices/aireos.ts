/**
 * wlc1: Cisco 5520 Wireless LAN Controller (AIR-CT5520-K9), AireOS 8.10.185.0. Management on
 * VLAN 10 (10.10.10.5) behind core-sw1, client VLAN 30 (`wifi-users`). APs, WLANs and clients
 * live in `d.vendor.aireos` (plain data). Values are plausible lab values [unverified, from memory].
 */
import { snapshot, type Device, type Iface } from '../state.ts'

const DAY = 86400_000

export interface WlcAp {
  name: string
  model: string
  mac: string
  ip: string
  location: string
  adminUp: boolean
  /** Joined to the controller. */
  joined: boolean
  slots: number
  serial: string
}

export interface WlcWlan {
  id: number
  profile: string
  ssid: string
  enabled: boolean
  iface: string
  security: string
}

export interface WlcClient {
  mac: string
  ap: string
  wlan: number
  ip: string
  user?: string
  protocol: string
  slot: number
  rssi: number
}

export interface AireosVendor {
  prompt: string
  aps: WlcAp[]
  wlans: WlcWlan[]
  clients: WlcClient[]
}

export function makeAireosDevice(t = Date.now()): Device {
  const ago = (ms: number): number => t - ms
  const port = (n: number, rest: Partial<Iface> = {}): Iface => ({
    name: String(n),
    short: String(n),
    adminUp: true,
    linkUp: true,
    mode: 'trunk',
    speed: '10G',
    mac: `00a3.8e12.34${String(n).padStart(2, '0')}`,
    media: '10GBase-SR',
    ...rest
  })
  const logical = (name: string, ip: string, mask: number, vlan: number | undefined, rest: Partial<Iface> = {}): Iface => ({
    name,
    short: name,
    ip,
    mask,
    ...(vlan !== undefined ? { vlan } : {}),
    adminUp: true,
    linkUp: true,
    mode: 'routed',
    speed: '',
    mac: '00a3.8e12.3400',
    ...rest
  })
  const vendor: AireosVendor = {
    prompt: 'Cisco Controller',
    aps: [
      { name: 'AP-3F-East', model: 'AIR-AP3802I-B-K9', mac: 'f4db.e6a0.1c00', ip: '10.10.30.20', location: '3F East', adminUp: true, joined: true, slots: 2, serial: 'FCW2211N0AB' },
      { name: 'AP-3F-West', model: 'AIR-AP3802I-B-K9', mac: 'f4db.e6a0.2d00', ip: '10.10.30.21', location: '3F West', adminUp: true, joined: true, slots: 2, serial: 'FCW2211N0AC' },
      { name: 'AP-Lobby', model: 'C9120AXI-B', mac: '3c41.0e5b.7700', ip: '10.10.30.22', location: 'Lobby', adminUp: true, joined: true, slots: 3, serial: 'FJC2322M1XY' }
    ],
    wlans: [
      { id: 1, profile: 'CORP', ssid: 'CORP', enabled: true, iface: 'management', security: '[WPA2][Auth(802.1X)]' },
      { id: 2, profile: 'GUEST', ssid: 'GUEST-WIFI', enabled: true, iface: 'wifi-users', security: '[WPA2][Auth(PSK)]' },
      { id: 3, profile: 'IOT', ssid: 'iot', enabled: false, iface: 'wifi-users', security: '[WPA2][Auth(PSK)]' }
    ],
    clients: [
      { mac: 'f4db.e6a0.1c11', ap: 'AP-3F-East', wlan: 1, ip: '10.10.10.112', user: 'jdoe', protocol: '802.11ac(5 GHz)', slot: 1, rssi: -58 },
      { mac: '9c5c.f9a1.0302', ap: 'AP-3F-East', wlan: 2, ip: '10.10.30.141', protocol: '802.11n(2.4 GHz)', slot: 0, rssi: -66 },
      { mac: 'a483.e7c2.4410', ap: 'AP-3F-West', wlan: 1, ip: '10.10.10.118', user: 'asmith', protocol: '802.11ac(5 GHz)', slot: 1, rssi: -61 },
      { mac: '28cf.e912.5a6b', ap: 'AP-Lobby', wlan: 2, ip: '10.10.30.150', protocol: '802.11ax(5 GHz)', slot: 1, rssi: -55 },
      { mac: '60f8.1d33.0c9e', ap: 'AP-Lobby', wlan: 2, ip: '10.10.30.151', protocol: '802.11ax(5 GHz)', slot: 1, rssi: -70 }
    ]
  }
  const d: Device = {
    platform: 'aireos',
    hostname: 'wlc1',
    model: 'AIR-CT5520-K9',
    serial: 'FCH2134V0XY',
    version: '8.10.185.0',
    bootedAt: ago(23 * DAY + 4 * 3600_000 + 51 * 60_000 + 6_000),
    localAs: 0,
    routerId: '10.10.10.5',
    user: 'admin',
    interfaces: [
      port(1, { description: 'to core-sw1 Te1/1/1' }),
      port(2, { description: 'to core-sw1 Te1/1/2' }),
      port(3, { linkUp: false }),
      port(4, { linkUp: false }),
      logical('management', '10.10.10.5', 24, 10),
      logical('service-port', '192.168.99.25', 24, undefined, { mac: '00a3.8e12.34ff' }),
      logical('virtual', '192.0.2.1', 32, undefined),
      logical('wifi-users', '10.10.30.5', 24, 30)
    ],
    vlans: [
      { id: 10, name: 'management' },
      { id: 30, name: 'wifi-users' }
    ],
    vrfs: [],
    bgp: [],
    mac: [],
    lldp: [],
    arp: [{ ip: '10.10.10.1', mac: '00a3.d14f.0a0a', iface: 'management', age: 1 }],
    staticRoutes: [{ prefix: '0.0.0.0', mask: 0, nextHop: '10.10.10.1' }],
    acls: [],
    routeMaps: [],
    prefixLists: [],
    services: { http: false, https: true, telnet: false, ssh: true },
    cpu: {
      load: [3, 3, 3],
      processes: [
        { pid: 1, name: 'reaperWatcher', pct: 0 },
        { pid: 2, name: 'osapiReaper', pct: 0 },
        { pid: 3, name: 'apfMsConnTask', pct: 1 },
        { pid: 4, name: 'capwapPingSocketTask', pct: 0 },
        { pid: 5, name: 'dot1xMsgTask', pct: 0 },
        { pid: 6, name: 'emWeb', pct: 0 },
        { pid: 7, name: 'snmpTask', pct: 1 },
        { pid: 8, name: 'rrmMonitorTask', pct: 1 }
      ]
    },
    extraConfig: [],
    log: [],
    vendor: { aireos: vendor },
    sshIdent: 'Cisco-1.25',
    scenarios: []
  }
  d.log.push({ t: ago(2 * 3600_000), msg: '*apfMsConnTask_5: %APF-6-CLIENT_ASSOC: Client f4:db:e6:a0:1c:11 associated to AP AP-3F-East' })
  d.startup = snapshot(d)
  return d
}
