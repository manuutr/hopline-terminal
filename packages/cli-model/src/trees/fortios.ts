import { B, C, D, N, R, type Entry, type TreeSource } from '../dsl'
import type { ArgRule } from '../types'

/**
 * Fortinet FortiOS trees at read-only depth (docs/research/cli-fortinet-fortios.md).
 * `execute` and `diagnose` hold both everyday reads and destructive actions, so they are
 * classified at the second token or deeper; anything not listed under them needs approval.
 */

const snifferCount: ArgRule = (args) =>
  // diagnose sniffer packet <if> '<filter>' <verbose> <count> [a|l]: without a count it never ends.
  args.length >= 4 && /^[1-9]\d*$/.test(args[3]!) ? undefined : { risk: 'blocked', reason: 'a packet sniffer without a count never terminates' }

const EXEC: Entry[] = [
  R('get ...', 'Get dynamic and system information'),
  R('get system {status|performance status|interface [physical]|arp|ha status|session status|global|admin ...|dns|ntp ...} ...'),
  R('get router info {routing-table {all|database|details ...|bgp|ospf|connected|static}|bgp {summary|neighbors [<ip> [{advertised-routes|received-routes|routes}]]|network ...}|ospf {neighbor [all]|interface|status|database ...}|bfd neighbor|kernel} ...'),
  R('get vpn ipsec tunnel {summary|details|name <word>} ...'),
  R('get hardware {nic <if>|status|memory|cpu} ...'),
  R('show ...', 'Show configuration'),
  C('show dns lookup ...', undefined, { reason: 'an explicit DNS lookup needs approval' }),
  R('show {system|firewall|router|vpn|user|log|switch-controller|wireless-controller} ...'),
  R('tree ...', 'Display the command tree'),
  C('config ...', 'Configure objects', { enters: 'config' }),
  C('config {system|firewall|router|vpn|user|log|vdom|global} ...', undefined, { enters: 'config' }),
  // Phase 8 M1: auto-scripts and CLI-script automation actions run stored CLI (`execute reboot`) on a timer or trigger.
  B('config system {auto-script|automation-action} ...', undefined, { reason: 'auto-scripts and automation actions run stored CLI (including deny-listed execute commands)' }),
  C('exit'),
  B('fnsysctl ...', 'Shell-like file commands', { reason: 'fnsysctl runs file operations on the box' }),
  B('sudo ...', undefined, { reason: 'runs a command in another VDOM or global context' }),
  B('alias ...', undefined, { reason: 'aliases run stored command sets' }),
  N('execute', 'Execute static commands', { container: true }),
  C('execute ...', 'Execute static commands'),
  R('execute {ping|ping6|traceroute|tracert6} <host> ...', 'Reachability test'),
  C('execute {ping-options|ping6-options|traceroute-options} ...'),
  R('execute log {display|filter ...} ...'),
  R('execute {time|date}', 'Show the system time or date'),
  R('execute dhcp lease-list ...'),
  B(
    'execute {reboot|shutdown|factoryreset|factoryreset2|factoryreset-shutdown|factoryreset-for-central-management|formatlogdisk|erase-disk|disk|restore|cfg|batch|config-transaction|revision|backup|usb-disk|tac|ssh|telnet|set-next-reboot|central-mgmt|update-now|upd-vd-license|wireless-controller|fortiguard-log ...|vpn certificate ...|ha manage ...} ...',
    undefined,
    { reason: 'execute command reboots, wipes, restores, exports or pivots' }
  ),
  B('execute {date|time} <word> ...', undefined, { reason: 'changes the system clock' }),
  D('execute router {clear ...|restart} ...', undefined, { reason: 'flaps routing' }),
  D('execute log {delete|delete-all|delete-logs ...} ...', undefined, { reason: 'destroys logs' }),
  D('execute ha {synchronize ...|failover ...|disconnect ...} ...', undefined, { reason: 'disrupts the HA cluster' }),
  D('execute vpn sslvpn del-tunnel ...', undefined, { reason: 'kicks VPN users' }),
  N('diagnose', 'Diagnose facility', { container: true }),
  C('diagnose ...', 'Diagnose facility'),
  R('diagnose sys session {list|stat|full-stat|list-expectation} ...'),
  C('diagnose sys session filter ...', 'Set the session list filter'),
  R('diagnose sys {vd list|ha {checksum ...|status|history read}|sdwan ...|virtual-wan-link ...|link-monitor ...|top-summary ...|ntp status|cmdb info|flash list|device list} ...'),
  B('diagnose sys {top|mpstat|top-mem} ...', undefined, { reason: 'interactive display that runs until "q"' }),
  R('diagnose ip {arp list|route list|address list|rtcache list|proute list} ...'),
  R('diagnose netlink {interface list|brctl ...|aggregate ...|device list} ...'),
  R('diagnose lldprx {neighbor ...|port ...} ...'),
  R('diagnose vpn {ike gateway list|tunnel list|ike stats ...} ...'),
  R('diagnose firewall {iprope list ...|ipmac list|proute list} ...'),
  R('diagnose hardware deviceinfo {nic|disk} ...'),
  R('diagnose debug {crashlog read|info|report} ...'),
  R('diagnose switch-controller switch-info ...'),
  // Phase 8 A-L7: it sends the typed user name and password to the server; whatever the model puts there leaves.
  C('diagnose test authserver ...', undefined, { reason: 'sends a typed credential to an authentication server' }),
  C('diagnose debug {flow ...|reset|disable|console ...|cli ...} ...'),
  D('diagnose debug {enable|application ...} ...', undefined, { reason: 'debug output loads the CPU and persists after logout' }),
  D('diagnose sys session clear ...', undefined, { reason: 'clears the whole session table unless a filter is set' }),
  B('diagnose sys kill ...', undefined, { reason: 'kills daemons' }),
  B('diagnose sys flash format ...', undefined, { reason: 'formats the flash' }),
  D('diagnose sys ha reset-uptime ...', undefined, { reason: 'triggers an HA failover' }),
  D('diagnose vpn {tunnel flush|ike gateway {clear|flush}|ike restart} ...', undefined, { reason: 'tears down VPN tunnels' }),
  B('diagnose {test|hardware test|disktest|fdsm ...} ...', undefined, { reason: 'tests restart daemons or stress hardware' }),
  // Phase 8 A-L7: it sends the typed user name and password to the server; whatever the model puts there leaves.
  C('diagnose test authserver ...', undefined, { reason: 'sends a typed credential to an authentication server' }),
  D('diagnose sniffer packet ...', 'Packet capture', { rule: snifferCount, reason: 'packet capture loads the CPU' })
]

const CONFIG: Entry[] = [
  R('get ...', 'Get the current table or entry'),
  R('show ...', 'Show the configuration of the current table or entry'),
  C('set ...', 'Modify value'),
  D('set status down', 'Bring the interface administratively down', { reason: 'shuts the interface down: if the session runs over it, access is lost' }),
  C('unset ...', 'Set to default value'),
  C('edit <word>', 'Add or edit an entry'),
  C('next', 'Save changes to this entry and go to the parent table'),
  C('end', 'End and save last config', { leaves: true }),
  C('abort', 'End and discard last config', { leaves: true }),
  C('config ...', 'Configure a sub-table'),
  C('append ...'),
  C('select ...'),
  C('unselect ...'),
  C('clear ...'),
  C('rename ...'),
  C('move ...'),
  C('clone ...'),
  D('delete ...', 'Delete an entry', { reason: 'deletes an object (and anything that depends on it)' }),
  B('purge', 'Delete all entries in this table', { reason: '"purge" deletes the whole table and can lock you out' })
]

const PIPE: Entry[] = [R('grep ...', 'Filter output (-i -v -c -f -A n -B n)')]

const HELP: Record<string, string> = {
  get: 'Get dynamic and system information',
  show: 'Show configuration',
  execute: 'Execute static commands',
  diagnose: 'Diagnose facility',
  config: 'Configure objects',
  tree: 'Tree command',
  grep: 'Filter output',
  purge: 'Delete all entries in this table'
}

export const FORTIOS_TREES = {
  exec: { entries: EXEC, help: HELP },
  config: { entries: CONFIG, help: HELP },
  pipe: { entries: PIPE, help: HELP }
} satisfies Record<string, TreeSource>
