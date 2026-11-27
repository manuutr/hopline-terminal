/**
 * Which doc transcripts are golden fixtures, how to replay them, and every known delta between
 * the doc and the simulator (each one is reported, never silently normalised away).
 *
 * Regenerate fixtures after editing the docs: `node packages/simulator/scripts/extract-goldens.ts`.
 */
import type { GoldenEntry } from './harness.ts'
import { eos } from './eos.ts'
import { nxos } from './nxos.ts'
import { junos } from './junos.ts'
import { panos } from './panos.ts'
import { fortios } from './fortios.ts'
import { iosxr } from './iosxr.ts'
import { asa } from './asa.ts'
import { aireos } from './aireos.ts'
import { c9800 } from './c9800.ts'
import { aoscx } from './aoscx.ts'
import { vrp } from './vrp.ts'
import { routeros } from './routeros.ts'

const IOS = 'docs/research/cli-cisco-ios.md'

export const ios: GoldenEntry[] = [
  {
    id: 'prompts',
    platform: 'ios',
    doc: IOS,
    heading: '1. Prompts',
    mode: 'elided',
    trimEnd: true,
    prepare: (d) => {
      d.vendor['loginPrivilege'] = 1
    },
    inputs: ['enable\r', 'admin\r', 'configure terminal\r', 'interface Gi1/0/2\r', 'exit\r', 'router bgp 65001\r', 'address-family ipv4\r', 'end\r'],
    deltas: [{ doc: 'User Access Verification\n\nUsername: netops\nPassword:\n', sim: '...\n', why: 'The Username:/Password: login belongs to the SSH/Telnet server, not the CLI session.' }]
  },
  { id: 'help-partial', platform: 'ios', doc: IOS, heading: '3. Help and completion', block: 0, mode: 'exact' },
  { id: 'help-configure', platform: 'ios', doc: IOS, heading: '3. Help and completion', block: 1, mode: 'exact', trimEnd: true },
  { id: 'errors', platform: 'ios', doc: IOS, heading: '3. Help and completion', block: 2, mode: 'exact' },
  { id: 'save', platform: 'ios', doc: IOS, heading: '5. Config model', block: 1, mode: 'exact', trimEnd: true, inputs: ['copy running-config startup-config\r', '\r', 'write memory\r'] },
  { id: 'reload', platform: 'ios', doc: IOS, heading: '5. Config model', block: 3, mode: 'exact', trimEnd: true, inputs: ['reload\r', 'n\r'] },
  {
    id: 'archive',
    platform: 'ios',
    doc: IOS,
    heading: '5. Config model',
    block: 4,
    mode: 'elided',
    setup: ['configure terminal'],
    deltas: []
  },
  {
    id: 'configure-replace',
    platform: 'ios',
    doc: IOS,
    heading: '5. Config model',
    block: 5,
    mode: 'exact',
    trimEnd: true,
    setup: ['archive config'],
    inputs: ['configure replace flash:archive/core-sw1-1\r', 'Y\r']
  },
  {
    id: 'revert-timer',
    platform: 'ios',
    doc: IOS,
    heading: '5. Config model',
    block: 6,
    mode: 'exact',
    inputs: ['configure terminal revert timer 5\r', 'end\r', 'configure confirm\r'],
    deltas: [
      { doc: 'core-sw1(config)#...\n', sim: '', why: 'The doc elides the config lines typed under the timer.' },
      { doc: 'core-sw1-Nov-24-14-10-02.123-0', sim: 'core-sw1-Nov-24-11-02-11.123-0', why: 'The backup name embeds the clock; the doc sample was taken at 14:10:02, the lab clock is 11:02:11.' }
    ]
  },
  {
    id: 'show-ip-int-brief',
    platform: 'ios',
    doc: IOS,
    heading: 'show ip interface brief',
    mode: 'exact',
    deltas: [{ doc: 'GigabitEthernet1/0/2   10.0.0.1        YES NVRAM ', sim: 'GigabitEthernet1/0/2   10.0.0.1        YES manual', why: 'e2e (terminal.spec) expects Gi1/0/2 as "YES manual administratively down": it was re-addressed since boot.' }]
  },
  { id: 'show-ip-bgp-summary', platform: 'ios', doc: IOS, heading: 'show ip bgp summary', mode: 'exact' },
  { id: 'show-ip-ospf-neighbor', platform: 'ios', doc: IOS, heading: 'show ip ospf neighbor', mode: 'exact' },
  { id: 'show-ip-route', platform: 'ios', doc: IOS, heading: 'show ip route (IOS', mode: 'exact' },
  { id: 'show-mac-address-table', platform: 'ios', doc: IOS, heading: 'show mac address-table', mode: 'exact' },
  { id: 'show-ip-arp', platform: 'ios', doc: IOS, heading: 'show ip arp', mode: 'exact' },
  { id: 'show-cdp-neighbors', platform: 'ios', doc: IOS, heading: 'show cdp neighbors', mode: 'exact' },
  { id: 'show-lldp-neighbors', platform: 'ios', doc: IOS, heading: 'show lldp neighbors', mode: 'exact' },
  { id: 'show-version', platform: 'ios', doc: IOS, heading: 'show version (IOS-XE', mode: 'elided', prepare: (d) => {
    // Full doc layout; the lab default omits the notices and license table so it fits one screen.
    d.vendor['showVersionFull'] = true
  } },
  { id: 'show-logging', platform: 'ios', doc: IOS, heading: 'show logging', mode: 'exact' },
  {
    id: 'show-running-config',
    platform: 'ios',
    doc: IOS,
    heading: 'show running-config (excerpt)',
    mode: 'excerpt',
    deltas: [{ doc: 'Current configuration : 9874 bytes\n', sim: '...\n', why: 'The byte count follows the rendered config; the doc excerpt is shorter than the full config.' }]
  }
]

export const manifest: GoldenEntry[] = [...ios, ...eos, ...nxos, ...junos, ...panos, ...fortios, ...iosxr, ...asa, ...aireos, ...c9800, ...aoscx, ...vrp, ...routeros]
