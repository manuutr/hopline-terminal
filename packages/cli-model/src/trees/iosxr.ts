import { B, C, D, N, R, SHELL_FILTERS, type Entry, type TreeSource } from '../dsl'
import { CISCO_HELP } from './help'

/**
 * Cisco IOS-XR (docs/research/cli-cisco-iosxr.md). Two-stage configuration: changes go to a
 * target configuration and only take effect on `commit`. `admin` runs a command in admin
 * (System Admin / calvados) mode; `run` and `bash` open the Linux shell.
 */

const SHOW: Entry[] = [
  N('show', 'Show running system information', { container: true }),
  R('show version ...'),
  R('show running-config ...', 'Current operating configuration'),
  R('show running-config formal ...', 'Configuration as one line per statement'),
  R('show configuration {commit {list|changes} ...|failed ...|running ...|history ...|persistent ...|merge ...|sessions ...|inconsistency ...|lock ...} ...'),
  R('show configuration', 'Uncommitted changes in this session'),
  R('show interfaces [{brief|summary|description|<if>}] ...'),
  R('show interfaces <if> {brief|description|accounting|detail} ...'),
  R('show ipv4 {interface [{brief|<if>}]|vrf ...|traffic ...|access-lists ...|prefix-list ...} ...'),
  R('show ipv6 {interface [{brief|<if>}]|neighbors ...|vrf ...|route ...|access-lists ...} ...'),
  R('show ip interface brief ...'),
  R('show route [{vrf {<vrf>|all}}] [{ipv4|ipv6}] [{unicast|multicast}] [{<ip>|<prefix>|summary|bgp|ospf ...|isis ...|static|connected|local|longer-prefixes ...}] ...'),
  R('show route summary ...'),
  R('show bgp [{vrf {<vrf>|all}}] [{ipv4|ipv6|vpnv4|vpnv6|l2vpn ...|all}] [{unicast|multicast|labeled-unicast|evpn|vpls|all}] [{summary|neighbors ...|<prefix>|<ip>|regexp ...|community ...|advertised ...|update-group ...|process ...}] ...', 'BGP information'),
  R('show bgp summary ...'),
  R('show bgp neighbors [<nbr>] [{advertised-routes|received routes|routes|detail|brief}] ...'),
  R('show ospf [<tag>] [{vrf <vrf>}] [{neighbor ...|interface ...|database ...|summary|route ...}] ...'),
  R('show ospfv3 ...'),
  R('show isis [instance <word>] [{adjacency|database ...|neighbors|interface ...|route ...|topology ...}] ...'),
  R('show mpls {ldp ...|forwarding ...|label ...|traffic-eng ...|interfaces ...} ...'),
  R('show segment-routing ...'),
  R('show rsvp ...'),
  R('show l2vpn ...'),
  R('show evpn ...'),
  R('show bfd ...'),
  R('show arp [{vrf <vrf>}] [<if>] ...'),
  R('show lldp [{neighbors [{detail|<if>}]|interface ...|traffic}] ...'),
  R('show cdp [{neighbors [{detail|<if>}]}] ...'),
  R('show bundle [{brief|<word>}] ...'),
  R('show lacp ...'),
  R('show vrf {all|<vrf>} ...'),
  R('show platform ...', 'Platform and line card state'),
  R('show inventory ...'),
  R('show environment ...'),
  R('show redundancy ...'),
  R('show processes {cpu ...|memory ...|blocked ...|<word>} ...'),
  R('show memory {summary ...|heap ...} ...'),
  R('show logging [{last <n>|process <word>|<word>}] ...'),
  R('show clock ...'),
  R('show users ...'),
  R('show ntp {associations ...|status} ...'),
  R('show controllers ...'),
  R('show policy-map ...'),
  R('show access-lists ...'),
  R('show prefix-set ...'),
  R('show rpl ...', 'Routing policy language objects'),
  R('show install {active|committed|inactive|request|log ...|summary|package ...} ...'),
  R('show license ...'),
  R('show hw-module ...'),
  R('show pim ...'),
  R('show igmp ...'),
  R('show mrib ...'),
  R('show ethernet ...'),
  R('show l2vpn bridge-domain ...'),
  R('show filesystem ...'),
  R('show context ...'),
  R('show watchdog ...'),
  R('show tcp ...'),
  R('show udp ...'),
  R('show hsrp ...'),
  R('show vrrp ...'),
  R('show cef ...'),
  R('show adjacency ...'),
  R('show telemetry ...'),
  R('show netconf-yang ...'),
  R('show history ...'),
  R('show terminal'),
  R('show alarms ...'),
  R('show drops ...'),
  R('show bfd ...'),
  R('show isis ...'),
  C('show tech-support ...', 'Collect troubleshooting data', { reason: 'show tech-support writes archives to the disk and loads the CPU' }),
  B('show logging {follow ...}', undefined, { reason: 'never terminates' })
]

const BLOCKED_HEADS = ['reload', 'run', 'bash', 'install', 'hw-module', 'format', 'delete', 'erase', 'mkdir', 'rmdir', 'copy', 'cfs', 'upgrade', 'process', 'crypto', 'telnet', 'ssh', 'rollback', 'monitor', 'attach', 'shell', 'scp', 'sftp', 'config-register', 'redundancy', 'factory-reset', 'zapdisk', 'save']

const EXEC: Entry[] = [
  ...SHOW,
  ...BLOCKED_HEADS.map((h) => B(`${h} ...`, undefined, { reason: `"${h}" is on the deny-list` })),
  C('admin', 'Run a command in admin mode', { exec: 'exec', container: true }),
  // Phase 8 M1: exec "utility" runs Unix programs on the router filesystem (the pipe form is modelled
  // separately); aliases and EEM policies run stored CLI.
  B('utility ...', 'Unix-style utilities', { reason: 'exec "utility" runs Unix programs on the router filesystem' }),
  B('{alias|event} ...', undefined, { reason: 'aliases and EEM policies run stored CLI as a privileged user' }),
  R('ping [{vrf <vrf>}] [{ipv4|ipv6}] <host> ...', 'Send echo messages'),
  R('traceroute [{vrf <vrf>}] [{ipv4|ipv6}] <host> ...', 'Trace route to destination'),
  C('ping', undefined, { reason: 'bare "ping" starts an interactive dialog' }),
  R('dir ...', 'List files on a filesystem'),
  R('pwd'),
  C('more ...', undefined, { reason: 'more can read raw config files that hold secrets' }),
  C('configure', 'Enter configuration mode', { enters: 'config' }),
  C('configure {terminal|exclusive}', undefined, { enters: 'config' }),
  C('terminal ...', 'Set terminal line parameters'),
  C('terminal {length <0-512>|width <0-512>|monitor|exec ...}'),
  C('clear ...', 'Reset functions'),
  C('clear counters [{all|<if>}]', 'Clear counters', { confirm: [{ prompt: /Clear "show interface" counters on all interfaces \[confirm\]\s*$/i, answer: '\r', description: 'Enter to confirm clearing interface counters' }] }),
  D('clear bgp ...', 'Clear BGP connections', { reason: 'a hard BGP reset drops sessions and traffic' }),
  C('clear bgp [{vrf {<vrf>|all}}] [{ipv4|ipv6|vpnv4|all}] [{unicast|all}] {*|<nbr>} soft [{in|out}]', 'Soft reconfiguration'),
  D('clear {ospf|ospfv3|isis|mpls|route|arp-cache|logging|lldp|lacp|l2vpn|bfd|pim|igmp|cef|adjacency|ipv4|ipv6} ...', undefined, { reason: 'resets protocol or forwarding state' }),
  B('clear configuration ...', undefined, { reason: '"clear configuration commits/inconsistency" removes commit history or forces state' }),
  D('clear line ...', undefined, { reason: 'kills sessions, possibly this one' }),
  C('debug ...', undefined, { reason: 'debugging can load the CPU' }),
  C('undebug ...'),
  C('exit'),
  C('end')
]

const PIPE: Entry[] = [
  R('include <regex>', 'Include lines that match'),
  R('exclude <regex>', 'Exclude lines that match'),
  R('begin <regex>', 'Begin with the line that matches'),
  N('utility', 'Unix-style utilities', { container: true }),
  R('utility {egrep|fgrep} ...', 'grep the output', { rule: SHELL_FILTERS.grep }),
  R('utility head ...', 'First lines', { rule: SHELL_FILTERS.head }),
  R('utility tail ...', 'Last lines', { rule: SHELL_FILTERS.tail }),
  R('utility wc ...', 'Count lines, words or characters', { rule: SHELL_FILTERS.wc }),
  R('utility sort ...', 'Sort lines', { rule: SHELL_FILTERS.sort }),
  R('utility uniq ...', 'Drop repeated lines', { rule: SHELL_FILTERS.uniq }),
  B('utility {cut|sed|awk|tee|xargs|less|more|script|scp} ...', undefined, { reason: 'this utility can write files or run commands' }),
  B('utility ...', undefined, { reason: 'unknown utility' }),
  B('file ...', 'Save output to a file', { reason: '"| file" writes output to the disk' }),
  B('xml ...', undefined, { reason: 'not modelled' })
]

const CONFIG_COMMON: Entry[] = [
  C('do', 'Run an exec command', { exec: 'exec', container: true }),
  C('end', 'Exit configuration mode (asks to commit)', { leaves: true }),
  C('exit', 'Exit from this submode', { leaves: true }),
  C('abort', 'Discard uncommitted changes and exit', { leaves: true }),
  R('show ...', 'Show the target configuration'),
  C('root', 'Exit to the global configuration mode'),
  C('commit [{comment <line>|label <word>|confirmed [<30-65535>]|show-error|best-effort}] ...', 'Commit the target configuration'),
  B('commit replace ...', 'Replace the running configuration', { reason: '"commit replace" replaces the whole running configuration' }),
  D('load ...', 'Load a file into the target configuration', { reason: 'loads configuration from a file' }),
  B('load {rollback|commit} ...', undefined, { reason: 'loads an old commit into the target configuration' }),
  C('clear', 'Clear the uncommitted changes'),
  B('save ...', 'Save the configuration to a file', { reason: 'writes a file' }),
  B('{hw-module|install|config-register|boot|redundancy} ...', undefined, { reason: 'boot, install and hardware changes need a maintenance window' }),
  D('rollback ...', undefined, { reason: 'rolls the configuration back' })
]

const CONFIG: Entry[] = [
  ...CONFIG_COMMON,
  C('no ...', 'Negate a command'),
  C('hostname <name>'),
  C('interface <if>', 'Select an interface to configure', { enters: 'config-if' }),
  C('interface {Loopback|Bundle-Ether|BVI|tunnel-te|tunnel-ip} <word>', undefined, { enters: 'config-if' }),
  D('no interface ...', undefined, { reason: 'removes an interface and its configuration' }),
  C('router {bgp <asn>|ospf <word>|ospfv3 <word>|isis <word>|static|pim|igmp|hsrp|vrrp}', undefined, { enters: 'config-router' }),
  D('no router ...', undefined, { reason: 'removes a routing process' }),
  C('vrf <vrf>', undefined, { enters: 'config-vrf' }),
  D('no vrf ...', undefined, { reason: 'removes a VRF' }),
  C('{route-policy|prefix-set|community-set|as-path-set|extcommunity-set} ...', 'Routing policy'),
  C('{ipv4|ipv6} access-list <acl> ...', undefined, { enters: 'config-acl' }),
  C('{logging|ntp|snmp-server|line|domain|ssh|telemetry|netconf-yang|grpc|l2vpn|mpls|segment-routing|evpn|multicast-routing|lldp|cdp|policy-map|class-map|banner|clock|tacacs-server|radius-server|aaa|username|group|taskgroup|usergroup|explicit-path|rsvp|bfd|key|control-plane|xml|http|cef} ...'),
  D('{username|aaa|taskgroup|usergroup} ...', undefined, { reason: 'changes who can log in' }),
  B('{hw-module|install|config-register|boot|redundancy} ...', undefined, { reason: 'boot, install and hardware changes need a maintenance window' }),
  B('{alias|event} ...', undefined, { reason: 'aliases and EEM policies run stored CLI as a privileged user' })
]

const SUB: Entry[] = [...CONFIG_COMMON, C('no ...')]

const IF: Entry[] = [
  ...CONFIG_COMMON,
  C('no ...'),
  D('shutdown', 'Shut down the interface', { reason: 'shuts the interface down: if the session runs over it, access is lost' }),
  C('description <line>'),
  C('{ipv4|ipv6|mtu|bundle|encapsulation|load-interval|carrier-delay|service-policy|lldp|cdp|bfd|l2transport|negotiation|speed|duplex|flow-control|dampening|rewrite} ...'),
  D('vrf <vrf>', undefined, { reason: 'moving an interface into a VRF removes its IP addresses' })
]

const help = CISCO_HELP

export const IOSXR_TREES = {
  exec: { entries: EXEC, help, priority: { '': { sh: 'show', conf: 'configure' }, configure: { t: 'terminal' } } },
  config: { entries: CONFIG, help, priority: { '': { int: 'interface' } } },
  'config-if': { entries: IF, help, priority: { '': { sh: 'shutdown', desc: 'description' } } },
  'config-router': { entries: SUB, help },
  'config-vrf': { entries: SUB, help },
  'config-acl': { entries: SUB, help },
  pipe: { entries: PIPE, help, priority: { '': { i: 'include', e: 'exclude', b: 'begin', u: 'utility' } } }
} satisfies Record<string, TreeSource>
