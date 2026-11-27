import { B, C, D, N, R, type Entry, type TreeSource } from '../dsl'
import { CISCO_HELP } from './help'
import { CONFIRM_COPY_RUN_START } from './ios'

/**
 * Cisco ASA (docs/research/cli-cisco-asa.md). Multiple-context mode adds `changeto`, which
 * switches the session to another context: a state change, never read. `packet-tracer` only
 * simulates a packet through the policy and is read-only.
 */

const SHOW: Entry[] = [
  N('show', 'Show running system information', { container: true }),
  R('show version ...'),
  R('show running-config ...', 'Current operating configuration'),
  R('show running-config all ...'),
  R('show startup-config ...'),
  R('show interface [{ip brief|<if>|summary|detail|stats}] ...'),
  R('show interface ip brief ...'),
  R('show nameif ...'),
  R('show ip address ...'),
  R('show route [{<ip>|<prefix>|summary|bgp|ospf|static|connected|management-only}] ...'),
  R('show bgp [{summary|neighbors ...|<ip>|<prefix>}] ...'),
  R('show ospf {neighbor|interface|database} ...'),
  R('show conn [{count|all|detail|address ...|port ...|protocol ...|state ...|long}] ...', 'Active connections'),
  R('show xlate [{count|detail|global ...|local ...}] ...', 'NAT translations'),
  R('show nat [{detail|divert-table|pool|translated ...}] ...'),
  R('show access-list [<acl>] ...', 'ACL entries with hit counts'),
  R('show local-host [{all|<ip>|brief|detail}] ...'),
  R('show failover [{state|history|interface|statistics|details|exec ...|config-sync ...}] ...', 'Failover status'),
  R('show cluster ...'),
  R('show context [{detail|count|<word>}] ...', 'Security contexts'),
  R('show mode', 'Single or multiple context mode'),
  R('show firewall', 'Routed or transparent mode'),
  R('show crypto {ipsec sa ...|ikev1 sa ...|ikev2 sa ...|isakmp sa ...|ca certificates ...|key mypubkey ...|accelerator ...} ...'),
  R('show vpn-sessiondb [{summary|anyconnect|l2l|webvpn|detail ...|index <n>}] ...'),
  R('show asp {drop ...|table ...} ...'),
  R('show service-policy ...'),
  R('show threat-detection ...'),
  R('show arp ...'),
  R('show mac-address-table ...'),
  R('show cpu [{usage|detailed|profile}] ...'),
  R('show memory [{detail|top-usage ...}] ...'),
  R('show processes ...'),
  R('show blocks ...'),
  R('show traffic ...'),
  R('show perfmon ...'),
  R('show logging [{queue|setting|message ...}] ...'),
  R('show clock ...'),
  R('show users ...'),
  R('show ssh [sessions] ...'),
  R('show inventory ...'),
  R('show environment ...'),
  R('show module ...'),
  R('show hardware ...'),
  R('show license ...'),
  R('show activation-key ...'),
  R('show capture [<word>] ...', 'Captured packets (read-only display)'),
  R('show object-group ...'),
  R('show object ...'),
  R('show aaa-server ...'),
  R('show ntp {associations|status} ...'),
  R('show dhcpd ...'),
  R('show sla ...'),
  R('show track ...'),
  R('show monitor-interface ...'),
  C('show tech-support ...', 'Collect troubleshooting data', { reason: 'show tech-support is very long and CPU-heavy; run it only with approval' }),
  R('show configuration ...'),
  R('show checksum'),
  R('show history'),
  R('show ipv6 ...'),
  R('show dns ...'),
  C('show dns lookup ...', undefined, { reason: 'an explicit DNS lookup needs approval' }),
  R('show webvpn ...'),
  R('show snmp-server ...'),
  R('show flash ...'),
  R('show disk0: ...')
]

const BLOCKED_HEADS = ['reload', 'erase', 'format', 'delete', 'rename', 'mkdir', 'rmdir', 'fsck', 'session', 'upgrade', 'crashinfo', 'shell', 'telnet', 'ssh', 'boot', 'redundancy', 'cluster', 'call-home', 'app-agent', 'hw-module', 'migrate', 'tclsh']

const EXEC: Entry[] = [
  ...SHOW,
  ...BLOCKED_HEADS.map((h) => B(`${h} ...`, undefined, { reason: `"${h}" is on the deny-list` })),
  // Phase 8 M1: EEM on ASA (IOS, NX-OS and EOS block it too).
  B('{event|alias} ...', undefined, { reason: 'EEM applets and aliases run stored CLI as a privileged user' }),
  R('packet-tracer input <word> {tcp|udp|icmp|rawip|sctp} ...', 'Simulate a packet through the policy (read-only)'),
  R('ping [<word>] <host> ...', 'Send echo messages'),
  C('ping', undefined, { reason: 'bare "ping" starts an interactive dialog' }),
  R('traceroute <host> ...'),
  R('dir ...', 'List files'),
  R('pwd'),
  C('more ...', undefined, { reason: 'more can read raw config files that hold secrets' }),
  B('changeto ...', 'Change to another security context', { reason: '"changeto" switches this session to another context: every later command would run where nothing was checked or approved' }),
  C('configure terminal', 'Configure from the terminal', { enters: 'config' }),
  B('configure {net|memory|http|factory-default|session} ...', undefined, { reason: 'loads, merges or factory-resets the configuration' }),
  C('write [memory]', 'Write the running configuration to memory'),
  R('write terminal', 'Show the running configuration'),
  D('write standby', undefined, { reason: 'overwrites the standby unit configuration' }),
  B('write {erase|net} ...', undefined, { reason: '"write erase"/"write net" erase or export the configuration' }),
  B('copy ...', undefined, { reason: 'copy can overwrite files or merge into the running config' }),
  C('copy running-config startup-config', 'Save the running configuration', { confirm: [CONFIRM_COPY_RUN_START] }),
  N('failover', 'Failover exec commands', { container: true }),
  D('failover {active|exec ...|reload-standby|reset ...} ...', undefined, { reason: 'changes or reloads the failover pair' }),
  D('no failover active ...', undefined, { reason: 'forces a failover' }),
  B('failover exec ...', undefined, { reason: '"failover exec" runs an unchecked command on the peer unit' }),
  C('clear ...', 'Reset functions'),
  C('clear {counters|access-list <acl> counters|traffic|asp drop|threat-detection ...|interface ...} ...', 'Clear counters'),
  D('clear {conn|xlate|local-host|arp|crypto ...|vpn-sessiondb ...|ipsec sa ...|isakmp sa ...|route ...|logging buffer|nat ...|bgp ...|ospf ...} ...', undefined, { reason: 'drops connections, sessions or routing state' }),
  B('clear {configure|config} ...', 'Clear configuration', { reason: '"clear configure all" wipes the running configuration' }),
  D('capture ...', 'Capture packets', { reason: 'packet capture uses device memory and CPU' }),
  D('{vpn-sessiondb logoff|shun} ...', undefined, { reason: 'logs VPN users off or shuns hosts' }),
  B('connect ...', undefined, { reason: '"connect fxos" leaves for the chassis shell' }),
  C('no capture ...'),
  C('debug ...', undefined, { reason: 'debugging can load the CPU' }),
  B('debug all ...', 'Enable all debugging', { reason: '"debug all" can halt the device' }),
  C('undebug ...'),
  C('terminal ...', 'Set terminal line parameters'),
  C('terminal {pager [lines] <0-2147483647>|width <0-511>|monitor|no monitor}'),
  C('test ...'),
  C('enable'),
  C('disable'),
  C('exit'),
  C('logout')
]

const PIPE: Entry[] = [
  R('include <regex>', 'Include lines that match'),
  R('exclude <regex>', 'Exclude lines that match'),
  R('begin <regex>', 'Begin with the line that matches'),
  R('grep [-v] <regex>', 'Include (or with -v exclude) lines that match'),
  B('redirect ...', undefined, { reason: 'writes output to a file' }),
  B('append ...', undefined, { reason: 'writes output to a file' })
]

const CONFIG_COMMON: Entry[] = [
  C('do', 'Run an exec command', { exec: 'exec', container: true }),
  C('end', 'Exit configuration mode', { leaves: true }),
  C('exit', 'Exit this mode', { leaves: true })
]

const CONFIG: Entry[] = [
  ...CONFIG_COMMON,
  C('no ...'),
  // Phase 8 M1: EEM applets and their `action … cli command` lines run CLI as a privileged user.
  B('{event|alias} ...', undefined, { reason: 'EEM applets and aliases run stored CLI as a privileged user' }),
  B('action ...', undefined, { reason: 'an EEM action runs CLI as a privileged user' }),
  C('hostname <name>'),
  C('interface <if>', 'Select an interface', { enters: 'config-if' }),
  D('no interface ...', undefined, { reason: 'removes an interface' }),
  C('{access-list|object|object-group|nat|route|logging|ntp|snmp-server|crypto|tunnel-group|group-policy|webvpn|dns|dhcpd|class-map|policy-map|service-policy|ssh|http|telnet|aaa-server|banner|clock|names|name|timeout|mtu|icmp|threat-detection|sla|track} ...'),
  C('router {ospf <n>|bgp <asn>|eigrp <n>}', undefined, { enters: 'config-router' }),
  D('{access-group|no access-group|no nat|no route} ...', undefined, { reason: 'rebinds or removes policy for live traffic' }),
  D('{username|aaa|enable password} ...', undefined, { reason: 'changes who can log in' }),
  D('{failover|no failover} ...', undefined, { reason: 'changes the failover pair' }),
  B('{clear configure|configure factory-default|boot|config-register|firewall transparent|mode|context|admin-context|crypto key zeroize} ...', undefined, { reason: 'wipes configuration, changes the boot or firewall mode, or contexts' }),
  B('clear ...', undefined, { reason: '"clear configure" in config mode wipes configuration' })
]

const IF: Entry[] = [
  ...CONFIG_COMMON,
  C('no ...'),
  D('shutdown', undefined, { reason: 'shuts the interface down: if the session runs over it, access is lost' }),
  C('{description|ip|ipv6|security-level|speed|duplex|mtu|vlan|channel-group|management-only|standby} ...'),
  D('nameif ...', undefined, { reason: 'renaming an interface rebinds every policy that uses the name' })
]

const SUB: Entry[] = [...CONFIG_COMMON, C('no ...')]

const help = CISCO_HELP

export const ASA_TREES = {
  exec: { entries: EXEC, help, priority: { '': { sh: 'show', wr: 'write', conf: 'configure' }, configure: { t: 'terminal' } } },
  config: { entries: CONFIG, help, priority: { '': { int: 'interface' } } },
  'config-if': { entries: IF, help },
  'config-router': { entries: SUB, help },
  pipe: { entries: PIPE, help, priority: { '': { i: 'include', e: 'exclude', b: 'begin', g: 'grep' } } }
} satisfies Record<string, TreeSource>
