import { B, C, D, N, R, type Entry, type TreeSource } from '../dsl'

/**
 * Huawei VRP (docs/research/cli-huawei-vrp.md). `display` instead of `show`; `system-view`
 * enters configuration (system view `[host]`), `quit` goes up one view and `return` back to the
 * user view `<host>`. `undo` negates.
 */

const DISPLAY: Entry[] = [
  N('display', 'Display information', { container: true }),
  R('display {version|device ...|interface ...|ip ...|ipv6 ...|bgp ...|ospf ...|isis ...|mpls ...|vlan ...|lldp ...|eth-trunk ...|mac-address ...|arp ...|current-configuration ...|saved-configuration ...|startup ...|alarm ...|logbuffer ...|trapbuffer ...|cpu-usage ...|memory-usage ...|clock|users ...|this ...|stp ...|vrrp ...|acl ...|route-policy ...|ip-prefix ...|patch-information|license ...|power ...|fan ...|temperature ...|esn|elabel ...|health ...|transceiver ...|counters ...|diagnostic-information ...|configuration ...|history-command|ssh ...|ntp ...|snmp-agent ...|vpn-instance ...|bfd ...|dhcp ...|qos ...|traffic ...|stack ...|css ...} ...'),
  R('display interface brief ...'),
  R('display ip interface brief ...'),
  R('display ip routing-table [{vpn-instance <vrf>|<ip>|statistics|protocol ...}] ...'),
  R('display bgp {peer|routing-table ...|vpnv4 ...|ipv6 ...} ...'),
  R('display ospf [<n>] {peer [brief]|interface ...|lsdb ...|routing ...|brief} ...'),
  C('display diagnostic-information ...', undefined, { reason: 'collects a large diagnostic dump; run it only with approval' })
]

const EXEC: Entry[] = [
  ...DISPLAY,
  ...['reboot', 'format', 'delete', 'undelete', 'reset', 'startup', 'copy', 'move', 'rename', 'mkdir', 'rmdir', 'ftp', 'tftp', 'sftp', 'scp', 'telnet', 'stelnet', 'patch', 'install', 'upgrade', 'rollback', 'fixdisk', 'license', 'schedule'].map((h) =>
    B(`${h} ...`, undefined, { reason: `"${h}" is on the deny-list` })
  ),
  B('reset saved-configuration', 'Erase the saved configuration', { reason: 'erases the startup configuration' }),
  D('reset {bgp|ospf|isis|arp|mac-address|ip ...|lldp ...|mpls ...} ...', undefined, { reason: 'resets protocol or forwarding state' }),
  C('reset counters ...', 'Clear interface counters'),
  C('reset {logbuffer|trapbuffer} ...', 'Clear a log buffer'),
  C('save [<file>]', 'Save the current configuration', { confirm: [{ prompt: /Are you sure to continue\?\s*\[Y\/N\]:?\s*$/i, answer: 'y\r', description: 'Y to save the configuration' }] }),
  R('ping <host> ...'),
  R('tracert <host> ...'),
  C('system-view', 'Enter the system view', { enters: 'config' }),
  C('screen-length 0 temporary', 'Disable paging for this session'),
  C('terminal ...'),
  C('debugging ...', undefined, { reason: 'debugging can load the CPU' }),
  C('undo debugging ...'),
  C('quit'),
  C('return')
]

const PIPE: Entry[] = [R('include <regex>', 'Include lines that match'), R('exclude <regex>', 'Exclude lines that match'), R('begin <regex>', 'Begin with the line that matches'), R('count', 'Count lines')]

const COMMON: Entry[] = [
  C('quit', 'Return to the upper view', { leaves: true }),
  C('return', 'Return to the user view', {
    leaves: true,
    // Two-stage mode with uncommitted changes: N discards them and leaves (the abort path; after a
    // successful commit nothing is uncommitted, so the question does not come up).
    confirm: [{ prompt: /Uncommitted configurations found.*\[Y\(yes\)\/N\(no\)\/C\(cancel\)\]:?\s*$/i, answer: 'N\r', description: 'discard the uncommitted changes and return to the user view' }]
  }),
  R('display ...', 'Display information'),
  C('commit', 'Commit the configuration (two-stage mode)')
]

const CONFIG: Entry[] = [
  ...COMMON,
  C('undo ...', 'Negate a command'),
  C('sysname <name>'),
  C('interface <if>', 'Enter the interface view', { enters: 'config-if' }),
  C('interface {Vlanif|LoopBack|Eth-Trunk|Tunnel|NULL} <word>', undefined, { enters: 'config-if' }),
  D('undo interface ...', undefined, { reason: 'removes an interface' }),
  C('vlan {<vlans>|batch ...}', undefined, { enters: 'config-vlan' }),
  D('undo vlan ...', undefined, { reason: 'removes VLANs and drops their traffic' }),
  C('{bgp <asn>|ospf [<n>] ...|isis [<n>]}', undefined, { enters: 'config-router' }),
  D('undo {bgp|ospf|isis} ...', undefined, { reason: 'removes a routing process' }),
  C('ip {vpn-instance <vrf>|route-static ...|ip-prefix ...|community-filter ...|as-path-filter ...} ...'),
  C('{acl|route-policy|ntp-service|info-center|snmp-agent|stelnet|ssh|aaa|user-interface|lldp|stp|vrrp|traffic ...|qos ...|dhcp ...|header ...|clock ...} ...'),
  D('{aaa|user-interface|local-user} ...', undefined, { reason: 'changes who can log in' }),
  B('{clear configuration|startup|set boot ...|license ...} ...', undefined, { reason: 'clears the configuration or changes the boot files' })
]

const IF: Entry[] = [...COMMON, C('undo ...'), D('shutdown', undefined, { reason: 'shuts the interface down: if the session runs over it, access is lost' }), C('{description|ip|ipv6|port|mtu|speed|duplex|stp|lldp|vrrp|eth-trunk|traffic-policy|qos} ...'), D('ip binding vpn-instance <vrf>', undefined, { reason: 'binding an interface to a VPN instance removes its IP addresses' })]
const SUB: Entry[] = [...COMMON, C('undo ...')]

export const VRP_TREES = {
  exec: { entries: EXEC, help: {}, priority: { '': { dis: 'display', sys: 'system-view' } } },
  config: { entries: CONFIG, help: {}, priority: { '': { int: 'interface' } } },
  'config-if': { entries: IF, help: {} },
  'config-vlan': { entries: SUB, help: {} },
  'config-router': { entries: SUB, help: {} },
  'config-vrf': { entries: SUB, help: {} },
  pipe: { entries: PIPE, help: {}, priority: { '': { i: 'include', e: 'exclude', b: 'begin' } } }
} satisfies Record<string, TreeSource>
