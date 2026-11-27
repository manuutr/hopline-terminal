/** fortios golden fixtures (see harness.ts for the entry shape). */
import type { GoldenEntry } from './harness.ts'
import type { FortiData } from '../../src/devices/fortios.ts'

const DOC = 'docs/research/cli-fortinet-fortios.md'
const base = { platform: 'fortios' as const, doc: DOC }

export const fortios: GoldenEntry[] = [
  { ...base, id: 'prompts', heading: '1. Prompts', block: 0, mode: 'exact', trimEnd: true },
  {
    ...base,
    id: 'help',
    heading: '3. Help and completion',
    block: 1,
    mode: 'excerpt',
    trimEnd: true,
    inputs: ['get router info ?', '\x15', 'config system interface\r', 'edit port1\r', 'set status ?'],
    deltas: [
      {
        doc: 'bgp           Show BGP information.\n...\n',
        sim: 'bgp           Show BGP information.\n',
        why: 'The doc elides the rest of the list and jumps to a second, unrelated snippet; the replay erases the redisplayed line (Ctrl-U) and enters port1 via `config system interface` / `edit port1`, which excerpt mode allows between the two.'
      }
    ]
  },
  {
    ...base,
    id: 'errors',
    heading: 'Error formats',
    block: 0,
    mode: 'exact',
    trimEnd: true,
    prepare: (d) => {
      const f = d.vendor['fortiData'] as FortiData
      f.addresses = f.addresses.filter((a) => a.name !== 'LAN-NET')
    },
  },
  { ...base, id: 'get-system-status', heading: '6.1 ', mode: 'exact' },
  {
    ...base,
    id: 'get-system-interface-physical',
    heading: '6.2 ',
    mode: 'exact',
    deltas: [
      {
        doc: '        FEC_cap: none\n    ==[port10]',
        sim: '        FEC_cap: none\n    ==[port3]\n        mode: static\n        ip: 10.20.0.1 255.255.255.0\n        ipv6: ::/0\n        status: up\n        speed: 10000Mbps (Duplex: full)\n        FEC: none\n        FEC_cap: none\n    ==[port4]\n        mode: static\n        ip: 0.0.0.0 0.0.0.0\n        ipv6: ::/0\n        status: down\n        speed: n/a\n        FEC: none\n        FEC_cap: none\n    ==[port10]',
        why: 'The doc sample skips port3 (the LAN port it lists in 6.3) and port4; the lab has both, and port4 is admin-down so it shows the documented down form.'
      }
    ]
  },
  {
    ...base,
    id: 'get-system-interface',
    heading: '6.3 ',
    mode: 'excerpt',
    inputs: ['get system interface\r'],
    deltas: [
      { doc: 'type: physical   ...\n== [ port2 ]', sim: 'type: physical   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    explicit-web-proxy: disable    explicit-ftp-proxy: disable    proxy-captive-portal: disable    mtu-override: disable    wccp: disable    drop-overlapped-fragment: disable    drop-fragment: disable\n== [ port2 ]', why: 'The doc truncates each line with `...`; the simulator prints the full line.' },
      { doc: 'type: physical   ...\n== [ port3 ]', sim: 'type: physical   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    explicit-web-proxy: disable    explicit-ftp-proxy: disable    proxy-captive-portal: disable    mtu-override: disable    wccp: disable    drop-overlapped-fragment: disable    drop-fragment: disable\n== [ port3 ]', why: 'As above.' },
      { doc: 'type: physical   ...\n== [ vlan100 ]', sim: 'type: physical   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    explicit-web-proxy: disable    explicit-ftp-proxy: disable    proxy-captive-portal: disable    mtu-override: disable    wccp: disable    drop-overlapped-fragment: disable    drop-fragment: disable\n== [ vlan100 ]', why: 'As above (port4 and port10 sit between port3 and vlan100; excerpt mode allows them).' },
      { doc: 'type: vlan   ...', sim: 'type: vlan   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    explicit-web-proxy: disable    explicit-ftp-proxy: disable    proxy-captive-portal: disable    mtu-override: disable    wccp: disable    drop-overlapped-fragment: disable    drop-fragment: disable', why: 'As above.' }
    ]
  },
  {
    ...base,
    id: 'routing-table-all',
    heading: '6.4 ',
    mode: 'exact',
    deltas: [
      {
        doc: 'B       10.10.20.0/24 [20/0] via 10.0.2.2, port2, 2d03h11m\nC       10.0.2.0/30 is directly connected, port2',
        sim: 'C       10.0.2.0/30 is directly connected, port2\nB       10.10.10.0/24 [20/0] via 10.0.2.2, port2, 2d03h11m\nB       10.10.20.0/24 [20/0] via 10.0.2.2, port2, 2d03h11m',
        why: 'FortiOS sorts the RIB by numeric prefix, so 10.0.2.0/30 comes before 10.10.10.0/24; the adapted doc sample lists it after.'
      },
      { doc: 'B*      0.0.0.0/0 [20/0] via 203.0.113.1, port1, 2d03h10m\nB       10.10.10.0/24 [20/0] via 10.0.2.2, port2, 2d03h11m\n', sim: 'B*      0.0.0.0/0 [20/0] via 203.0.113.1, port1, 2d03h10m\n', why: 'Second half of the reorder above.' }
    ]
  },
  { ...base, id: 'bgp-summary', heading: '6.5 ', mode: 'exact' },
  { ...base, id: 'bgp-neighbors', heading: '6.6 ', mode: 'elided' },
  { ...base, id: 'ospf-neighbor', heading: '6.7 ', mode: 'exact' },
  { ...base, id: 'system-arp', heading: '6.8 ', block: 0, mode: 'exact' },
  {
    ...base,
    id: 'diagnose-arp-list',
    heading: '6.8 ',
    block: 1,
    mode: 'exact',
    deltas: [{ doc: 'update=3159 ref=2', sim: 'update=3159 ref=2\nindex=3 ifname=port1 203.0.113.1 00:0c:29:aa:01:01 state=00000002 use=10 confirm=10 update=60 ref=2', why: 'The doc sample lists two of the three ARP entries that `get system arp` shows; the simulator lists the ISP next hop on port1 too.' }]
  },
  { ...base, id: 'performance-status', heading: '6.9 ', mode: 'exact' },
  { ...base, id: 'session-list', heading: '6.10 ', mode: 'exact' },
  { ...base, id: 'lldprx-summary', heading: '6.12 ', block: 2, mode: 'exact' },
  { ...base, id: 'show-excerpts', heading: '6.12 ', block: 3, mode: 'exact' }
]
