/** nxos golden fixtures (see harness.ts for the entry shape). */
import type { GoldenEntry } from './harness.ts'

const DOC = 'docs/research/cli-cisco-nxos.md'

export const nxos: GoldenEntry[] = [
  { id: 'routing-context', platform: 'nxos', doc: DOC, heading: 'Routing-context (VRF-scoped EXEC)', mode: 'exact' },
  { id: 'help-partial', platform: 'nxos', doc: DOC, heading: '3. Help and completion', block: 0, mode: 'exact' },
  {
    id: 'help-show-ip',
    platform: 'nxos',
    doc: DOC,
    heading: '3. Help and completion',
    block: 1,
    mode: 'elided',
    deltas: [
      {
        doc: '  ospf            Display OSPF information\n',
        sim: '  ospf            Display OSPF information\n  prefix-list     Display prefix-list information\n',
        why: 'The doc lists a selection of keywords before its closing `...`; the simulator also implements `show ip prefix-list`, which sorts between ospf and route.'
      }
    ]
  },
  {
    id: 'errors',
    platform: 'nxos',
    doc: DOC,
    heading: '3. Help and completion',
    block: 3,
    mode: 'exact',
    // The doc notes that the `sh ip bgp summ` example assumes `feature bgp` is disabled.
    prepare: (d) => {
      d.services['feature-bgp'] = false
    }
  },
  {
    id: 'show-feature',
    platform: 'nxos',
    doc: DOC,
    heading: '5. Config model',
    block: 0,
    mode: 'elided',
    inputs: [' show feature\r'],
    deltas: [
      { doc: 'Feature Name', sim: 'leaf1# show feature\nFeature Name', why: 'The ntc-templates capture has no command line; the replay types `show feature`.' },
      { doc: 'bgp                    1          disabled', sim: 'bgp                    1          enabled', why: 'leaf1 runs BGP to the spines (its running-config sample has `feature bgp`); the capture came from a switch without it.' },
      { doc: 'eigrp                  1          disabled', sim: 'eigrp                  1          disabled\n...', why: 'The capture stops after five features; the simulator lists the rest of the feature table.' }
    ]
  },
  { id: 'configure-terminal', platform: 'nxos', doc: DOC, heading: '5. Config model', block: 1, mode: 'exact' },
  { id: 'copy-run-start', platform: 'nxos', doc: DOC, heading: '5. Config model', block: 2, mode: 'exact' },
  { id: 'checkpoint-rollback', platform: 'nxos', doc: DOC, heading: '5. Config model', block: 3, mode: 'exact' },
  {
    id: 'config-session-summary',
    platform: 'nxos',
    doc: DOC,
    heading: '5. Config model',
    block: 4,
    mode: 'elided',
    user: 'ntc',
    setup: ['configure session ACL-SESSION1', 'end'],
    inputs: [' show configuration session summary\r'],
    deltas: [
      {
        doc: 'Session Manager Database:',
        sim: '...\nleaf1# show configuration session summary\nSession Manager Database:',
        why: 'The ntc-templates capture has no command line. The replay creates the session first (as user ntc), and `...` covers that setup.'
      }
    ]
  },
  {
    id: 'confirm-prompts',
    platform: 'nxos',
    doc: DOC,
    heading: '5. Config model',
    block: 5,
    mode: 'exact',
    inputs: [' write erase\r', 'y\r', ' reload\r', 'y\r'],
    deltas: [
      {
        doc: 'leaf1# reload\n',
        sim: 'leaf1# reload\n!!!WARNING! there is unsaved configuration!!!\n',
        why: 'After `write erase` the running config is no longer saved, so NX-OS warns before the reload prompt; the doc shows the two prompts as separate examples.'
      },
      { doc: '(y/n)?  [n] y', sim: '(y/n)?  [n] y\n%% [simulator] reload acknowledged. The simulator never reboots.', why: 'A real switch drops the session and reboots; the simulator stays up and says so.' }
    ]
  },
  { id: 'show-interface-brief', platform: 'nxos', doc: DOC, heading: 'show interface brief', mode: 'exact' },
  { id: 'show-ip-interface-brief-vrf-all', platform: 'nxos', doc: DOC, heading: 'show ip interface brief vrf all', mode: 'exact' },
  { id: 'show-bgp-ipv4-unicast-summary', platform: 'nxos', doc: DOC, heading: 'show bgp ipv4 unicast summary', mode: 'exact' },
  { id: 'show-ip-ospf-neighbors', platform: 'nxos', doc: DOC, heading: 'show ip ospf neighbors', mode: 'exact' },
  {
    id: 'show-ip-route',
    platform: 'nxos',
    doc: DOC,
    heading: 'show ip route',
    mode: 'exact',
    deltas: [
      {
        doc: '10.255.0.20/32, ubest/mbest: 2/0, attached\n    *via 10.255.0.20, Lo0, [0/0], 3d22h, local\n    *via 10.255.0.20, Lo0, [0/0], 3d22h, direct\n10.255.0.101/32, ubest/mbest: 1/0\n    *via 10.0.2.0, Eth1/49, [110/41], 3d22h, ospf-UNDERLAY, intra\n10.100.0.0/16, ubest/mbest: 1/0\n    *via 10.0.2.0, [20/0], 3d22h, bgp-65020, external, tag 65100',
        sim: '10.100.0.0/16, ubest/mbest: 1/0\n    *via 10.0.2.0, [20/0], 3d22h, bgp-65020, external, tag 65100\n10.255.0.20/32, ubest/mbest: 2/0, attached\n    *via 10.255.0.20, Lo0, [0/0], 3d22h, local\n    *via 10.255.0.20, Lo0, [0/0], 3d22h, direct\n10.255.0.101/32, ubest/mbest: 1/0\n    *via 10.0.2.0, Eth1/49, [110/41], 3d22h, ospf-UNDERLAY, intra',
        why: 'The hand-written sample lists the BGP route last. The simulator sorts the RIB by prefix in numeric order, as NX-OS does, so 10.100.0.0/16 comes before 10.255.x.'
      }
    ]
  },
  { id: 'show-mac-address-table', platform: 'nxos', doc: DOC, heading: 'show mac address-table', mode: 'exact' },
  { id: 'show-ip-arp-vrf-all', platform: 'nxos', doc: DOC, heading: 'show ip arp', mode: 'exact' },
  { id: 'show-cdp-neighbors', platform: 'nxos', doc: DOC, heading: 'show cdp neighbors', mode: 'exact' },
  { id: 'show-lldp-neighbors', platform: 'nxos', doc: DOC, heading: 'show lldp neighbors', mode: 'exact' },
  { id: 'show-version', platform: 'nxos', doc: DOC, heading: 'show version', mode: 'exact' },
  { id: 'show-logging-last', platform: 'nxos', doc: DOC, heading: 'show logging logfile (excerpt)', mode: 'exact' },
  { id: 'show-running-config', platform: 'nxos', doc: DOC, heading: 'show running-config (short excerpt)', mode: 'excerpt' }
]
