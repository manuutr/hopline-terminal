/** eos golden fixtures (see harness.ts for the entry shape). */
import type { Device } from '../../src/state.ts'
import type { GoldenEntry } from './harness.ts'

const EOS = 'docs/research/cli-arista-eos.md'

const host = (name: string) => (d: Device): void => {
  d.hostname = name
  if (d.startup) d.startup.hostname = name
}

const REDRAW = 'EOS redraws the prompt and the typed line after `?`; the manual omits the redrawn prompt.'

/** §6.4 is a hypothetical OSPF underlay: Ethernet1 point-to-point to spine1 and a broadcast segment on Vlan10. */
function ospfUnderlay(d: Device): void {
  d.interfaces.push({ name: 'Vlan10', short: 'Vl10', ip: '10.10.10.2', mask: 24, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '2899.3a11.000a' })
  d.ospf = {
    process: '1',
    ifaces: [
      { iface: 'Ethernet1', area: '0.0.0.0', networkType: 'point-to-point' },
      { iface: 'Vlan10', area: '0.0.0.0' }
    ],
    neighbors: [
      { routerId: '10.255.0.100', ip: '10.0.1.0', iface: 'Ethernet1', pri: 0, area: '0.0.0.0', role: '-' },
      { routerId: '10.255.0.1', ip: '10.10.10.1', iface: 'Vlan10', pri: 1, area: '0.0.0.0', role: 'DR' }
    ]
  }
}

export const eos: GoldenEntry[] = [
  { id: 'terminal-length', platform: 'eos', doc: EOS, heading: '2. Paging', mode: 'exact', prepare: host('switch') },
  {
    id: 'help-user',
    platform: 'eos',
    doc: EOS,
    heading: '`?` help',
    block: 0,
    mode: 'exact',
    prepare: (d) => {
      host('switchName')(d)
      d.vendor['loginPrivilege'] = 1
    },
    deltas: [{ doc: 'zerotouch   ZeroTouch configuration', sim: 'zerotouch   ZeroTouch configuration\nswitchName> ', why: REDRAW }]
  },
  {
    id: 'help-partial',
    platform: 'eos',
    doc: EOS,
    heading: '`?` help',
    block: 1,
    mode: 'exact',
    prepare: host('switch'),
    deltas: [{ doc: 'diff  dir  disable', sim: 'diff  dir  disable\nswitch# di', why: REDRAW }]
  },
  {
    id: 'help-ping',
    platform: 'eos',
    doc: EOS,
    heading: '`?` help',
    block: 2,
    mode: 'exact',
    prepare: (d) => {
      host('switch')(d)
      d.vendor['loginPrivilege'] = 1
    },
    deltas: [
      {
        doc: 'WORD  Ping destination address or hostname\nip    IPv4 echo\nipv6  IPv6 echo\nmpls  Send echo messages for LSP\nvrf   Ping in a VRF',
        sim: '  WORD  Ping destination address or hostname\n  ip    IPv4 echo\n  ipv6  IPv6 echo\n  mpls  Send echo messages for LSP\n  vrf   Ping in a VRF\nswitch> ping ',
        why: 'This sample drops the two-space indent that every other `?` listing in the manual (EXEC list, OSPF and VM samples) carries; the simulator keeps one format. ' + REDRAW
      }
    ]
  },
  { id: 'errors', platform: 'eos', doc: EOS, heading: 'Error messages (exact strings)', mode: 'exact' },
  { id: 'commit-timer', platform: 'eos', doc: EOS, heading: 'Configuration sessions (candidate config)', block: 0, mode: 'exact', prepare: host('switch'), setup: ['configure session MySession'] },
  {
    id: 'session-diffs',
    platform: 'eos',
    doc: EOS,
    heading: 'Configuration sessions (candidate config)',
    block: 1,
    mode: 'exact',
    setup: ['configure session chg1', 'interface Ethernet2', 'shutdown', 'exit'],
    deltas: [{ doc: '@@ -61,6 +61,7 @@', sim: '@@ -22,6 +22,7 @@', why: 'Hunk line numbers depend on the length of the running-config; the lab config is shorter than the one the sample came from.' }]
  },
  { id: 'configure-replace', platform: 'eos', doc: EOS, heading: 'Replace / checkpoints / rollback', mode: 'exact', prepare: host('switch'), setup: ['configure'] },
  { id: 'show-ip-interface-brief', platform: 'eos', doc: EOS, heading: '6.1 `show', mode: 'exact' },
  { id: 'show-interfaces-status', platform: 'eos', doc: EOS, heading: '6.2 `show', mode: 'exact' },
  {
    id: 'show-ip-bgp-summary',
    platform: 'eos',
    doc: EOS,
    heading: '6.3 `show',
    mode: 'exact',
    deltas: [{ doc: '05:02:11 Idle', sim: '05:02:11 Active', why: 'spine2 is down because Ethernet2 has no link while the neighbor stays configured, so the model reports Active (connect retries), as sim.test.ts requires; Idle would need an admin shutdown.' }]
  },
  { id: 'show-ip-ospf-neighbor', platform: 'eos', doc: EOS, heading: '6.4 `show', mode: 'exact', prepare: ospfUnderlay },
  { id: 'show-ip-route', platform: 'eos', doc: EOS, heading: '6.5 `show', mode: 'exact' },
  { id: 'show-mac-address-table', platform: 'eos', doc: EOS, heading: '6.6 `show', mode: 'exact' },
  { id: 'show-ip-arp', platform: 'eos', doc: EOS, heading: '6.7 `show', mode: 'exact' },
  { id: 'show-lldp-neighbors', platform: 'eos', doc: EOS, heading: '6.8 `show', mode: 'exact' },
  { id: 'show-version', platform: 'eos', doc: EOS, heading: '6.9 `show', mode: 'exact' },
  { id: 'show-logging', platform: 'eos', doc: EOS, heading: '6.10 `show', mode: 'elided' },
  { id: 'show-running-config', platform: 'eos', doc: EOS, heading: '6.11 `show', mode: 'excerpt' },
  {
    id: 'show-version-json',
    platform: 'eos',
    doc: EOS,
    heading: '6.12 `| json`',
    mode: 'exact',
    deltas: [
      {
        doc: '"bootupTimestamp": 1762378800.0,\n    "uptime": 1512120.5,',
        sim: '"bootupTimestamp": 1793997580.4,\n    "uptime": 1520551.0,',
        why: 'The sample timestamps come from a 2025 clock and disagree with its own text `show version` uptime; the simulator derives both from the lab boot time (uptime 17d14h22m31s at the lab clock).'
      }
    ]
  }
]
