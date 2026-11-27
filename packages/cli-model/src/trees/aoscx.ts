import { B, C, D, N, R, type Entry, type TreeSource } from '../dsl'
import type { ArgRule } from '../types'
import { CISCO_HELP } from './help'

/** HPE Aruba AOS-CX (docs/research/cli-aruba-aoscx.md). Industry-standard CLI, Cisco-like. */

/** `show logging -f` / `show events -f` follow the log like `tail -f`: they never end (Phase 8 A-L6). */
const follows: ArgRule = (args) => (args.includes('-f') ? { risk: 'config', reason: '"-f" follows the log and never ends; run it yourself, not through the assistant' } : undefined)

const SHOW: Entry[] = [
  N('show', 'Show information', { container: true }),
  R('show {logging|events} ...', undefined, { rule: follows }),
  R('show {version|system ...|interface ...|vlan ...|ip ...|ipv6 ...|bgp ...|ospf ...|ospfv3 ...|lldp ...|lacp ...|mac-address-table ...|arp ...|running-config ...|startup-config ...|environment ...|module ...|vsx ...|vrf ...|spanning-tree ...|ntp ...|clock|users|uptime|boot-history ...|capacities ...|capacities-status ...|resources ...|aaa ...|ssh ...|snmp ...|copp ...|qos ...|access-list ...|policy ...|class ...|vrrp ...|evpn ...|vxlan ...|mvrp ...|loop-protect ...|poe ...|power-over-ethernet ...|checkpoint ...|config ...|core-dump ...|dhcp-relay ...|dhcpv4-snooping ...|lldp ...|neighbor ...|port-access ...|ubt ...|vsf ...|vlan ...|history|sessions|crypto ...} ...'),
  R('show interface brief ...'),
  R('show ip route [{vrf <vrf>|all-vrfs}] ...'),
  R('show bgp {all|ipv4|ipv6|l2vpn} ...'),
  R('show lldp neighbor-info [<if>] ...'),
  C('show tech ...', undefined, { reason: 'show tech is very long and CPU-heavy; run it only with approval' })
]

const EXEC: Entry[] = [
  ...SHOW,
  B('alias ...', undefined, { reason: 'aliases run stored CLI and can shadow commands' }),
  ...['boot', 'erase', 'copy', 'start-shell', 'diag', 'diagnostics', 'debug-shell', 'delete', 'reload', 'ssh', 'telnet', 'zeroize', 'rename', 'mkdir', 'rmdir', 'checkpoint', 'vsx', 'vsf', 'factory-reset'].map((h) =>
    B(`${h} ...`, undefined, { reason: `"${h}" is on the deny-list` })
  ),
  R('checkpoint diff ...', 'Compare checkpoints'),
  C('copy running-config startup-config', 'Save the running configuration'),
  C('write memory', 'Save the running configuration'),
  R('ping <host> ...'),
  R('ping6 <host> ...'),
  R('traceroute <host> ...'),
  C('configure [terminal]', 'Enter configuration mode', { enters: 'config' }),
  C('page', 'Turn paging on'),
  C('no page', 'Turn paging off'),
  C('terminal-monitor ...'),
  C('clear ...'),
  C('clear {interface ...|counters ...|ip ospf statistics ...} ...'),
  D('clear {bgp|ip ospf neighbor|arp|mac-address-table|ip route|ipv6 neighbors|vsx ...|lacp ...} ...', undefined, { reason: 'resets protocol or forwarding state' }),
  C('debug ...', undefined, { reason: 'debugging can load the CPU' }),
  C('no debug ...'),
  C('exit'),
  C('end')
]

const PIPE: Entry[] = [R('include <regex>', 'Include lines that match'), R('exclude <regex>', 'Exclude lines that match'), R('begin <regex>', 'Begin with the line that matches'), R('count', 'Count lines'), B('redirect ...', undefined, { reason: 'writes a file' })]

const COMMON: Entry[] = [
  C('do', 'Run an exec command', { exec: 'exec', container: true }),
  C('end', 'Exit configuration mode', { leaves: true }),
  C('exit', 'Exit this mode', { leaves: true })
]

const CONFIG: Entry[] = [
  ...COMMON,
  C('no ...'),
  // Phase 8 M1: an alias runs stored CLI (`alias x reload`).
  B('alias ...', undefined, { reason: 'aliases run stored CLI and can shadow commands' }),
  C('hostname <name>'),
  C('interface <if>', 'Select an interface', { enters: 'config-if' }),
  C('interface {vlan|lag|loopback|tunnel} <word>', undefined, { enters: 'config-if' }),
  D('no interface ...', undefined, { reason: 'removes an interface' }),
  C('vlan <vlans>', undefined, { enters: 'config-vlan' }),
  D('no vlan ...', undefined, { reason: 'removes VLANs and drops their traffic' }),
  C('router {bgp <asn>|ospf <n> ...|ospfv3 <n> ...|pim ...}', undefined, { enters: 'config-router' }),
  D('no router ...', undefined, { reason: 'removes a routing process' }),
  C('vrf <vrf>', undefined, { enters: 'config-vrf' }),
  C('{ip|ipv6|ntp|logging|snmp-server|ssh|https-server|lldp|spanning-tree|access-list|class|policy|qos|vsx|evpn|aaa|radius-server|tacacs-server|banner|clock|user-group|dhcp-server|loop-protect|port-access|mvrp} ...'),
  D('{user|aaa|vsx|https-server|ssh} ...', undefined, { reason: 'changes management access or the VSX pair' }),
  B('{boot|erase|checkpoint rollback|profile} ...', undefined, { reason: 'boot, erase, rollback or switch profile changes' })
]

const IF: Entry[] = [
  ...COMMON,
  C('no ...'),
  D('shutdown', undefined, { reason: 'shuts the interface down: if the session runs over it, access is lost' }),
  C('{description|ip|ipv6|vlan|lag|mtu|speed|routing|lldp|spanning-tree|vrrp|qos|apply|loop-protect|poe|power-over-ethernet} ...'),
  D('vlan trunk allowed <vlans>', undefined, { reason: '"vlan trunk allowed" replaces the list unless all VLANs are named' }),
  D('no routing', undefined, { reason: 'changes the interface between routed and switched and removes its IP' }),
  D('vrf attach <vrf>', undefined, { reason: 'moving an interface into a VRF removes its IP addresses' })
]

const SUB: Entry[] = [...COMMON, C('no ...')]
const help = CISCO_HELP

export const AOSCX_TREES = {
  exec: { entries: EXEC, help, priority: { '': { sh: 'show', conf: 'configure' } } },
  config: { entries: CONFIG, help, priority: { '': { int: 'interface' } } },
  'config-if': { entries: IF, help },
  'config-vlan': { entries: SUB, help },
  'config-router': { entries: SUB, help },
  'config-vrf': { entries: SUB, help },
  pipe: { entries: PIPE, help, priority: { '': { i: 'include', e: 'exclude', b: 'begin' } } }
} satisfies Record<string, TreeSource>
