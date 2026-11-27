import { B, C, D, forbidsWord, N, R, type Entry, type TreeSource } from '../dsl'
import { abbreviates } from '../words'
import { bareDelete } from './junos'

/** Palo Alto PAN-OS trees at read-only depth (docs/research/cli-paloalto-panos.md). */

const noFollow = forbidsWord('follow', '"follow" never terminates')

const EXEC: Entry[] = [
  N('show', 'Show operational information', { container: true }),
  R('show system {info|resources|disk-space|software status|state ...|environmentals ...|statistics ...|masterkey-properties|files|logdb-quota|setting ...} ...', 'Show system information'),
  B('show system resources follow ...', undefined, { reason: '"follow" never terminates' }),
  R('show interface {all|hardware|logical|management|<if>} ...', 'Show interface information'),
  R('show routing {route|fib|protocol {bgp {summary|peer ...|loc-rib ...}|ospf {neighbor|area|interface|lsdb} ...|redist ...}|summary|resource|interface} ...'),
  R('show advanced-routing {route|fib|bgp {summary|peer ...|route ...}|ospf {neighbor ...|interface ...}|logical-router ...} ...'),
  R('show arp {all|<if>} ...'),
  R('show mac {all|<if>} ...'),
  R('show lldp {neighbors|local|counters|config} ...'),
  R('show high-availability {state|all|state-synchronization|link-monitoring|path-monitoring|interface ...} ...'),
  R('show session {info|all ...|id <n>|meter ...|rematch ...} ...'),
  R('show counter {global ...|interface ...|management-server} ...'),
  R('show running {security-policy|nat-policy|pbf-policy|qos-policy|application-override-policy|decryption-policy|tunnel ...|ippool ...|resource-monitor ...} ...'),
  R('show jobs {all|id <n>|pending|processed} ...'),
  R('show log ...', 'Show logs', { rule: noFollow }),
  R('show config {diff|running ...|candidate ...|pushed-template ...|saved ...|audit ...|merged ...} ...'),
  R('show vpn {ike-sa|ipsec-sa|flow|gateway|tunnel} ...'),
  R('show admins [all] ...'),
  R('show clock ...'),
  R('show user ...'),
  R('show zone-protection ...'),
  R('show dos-protection ...'),
  R('show global-protect-gateway ...'),
  R('show dhcp ...'),
  R('show dns-proxy ...'),
  R('show ntp'),
  R('show qos ...'),
  R('show neighbor ...'),
  R('show object ...'),
  R('show plugins ...'),
  R('show panorama-status'),
  R('show device-certificate ...'),
  R('show statistics ...'),
  R('show threat ...'),
  R('show url-cloud ...'),
  R('show cli {info|...}'),
  R('show vm-monitor ...'),
  R('show wildfire ...'),
  R('show management-clients'),
  // Count (PAN-OS ping never stops without one), size and timeout: probe.ts (via the guard).
  R('ping ...', 'Ping hosts and networks'),
  R('traceroute ...', 'Print the route packets take to network host'),
  R('test {security-policy-match|nat-policy-match|routing fib-lookup|pbf-policy-match|decryption-policy-match|qos-policy-match|dns-proxy ...|url ...|custom-url ...} ...', 'Read-only policy and lookup tests'),
  C('test ...'),
  D('test vpn ...', undefined, { reason: 'initiates IKE/IPsec negotiation' }),
  D('test arp ...', undefined, { reason: '"test arp gratuitous" sends gratuitous ARP on the wire' }),
  R('grep ...'),
  R('ls ...'),
  R('find ...'),
  R('diff ...'),
  C('less ...', undefined, { reason: '"less" is interactive' }),
  ...['debug', 'delete', 'scp', 'tftp', 'ftp', 'ssh', 'schedule', 'tail', 'view-pcap'].map((h) => B(`${h} ...`, undefined, { reason: `"${h}" is on the deny-list` })),
  B('request ...', 'Make system-level requests', { reason: 'request commands restart, upgrade, license or reset the firewall' }),
  R('request {license info|system software info|system software check|content upgrade check|content upgrade info|anti-virus upgrade info|anti-virus upgrade check|wildfire upgrade info|global-protect-client software info}'),
  B('request high-availability ...', undefined, { reason: 'forces an HA state change' }),
  C('clear ...'),
  C('clear counter ...'),
  D('clear {session|log|routing|high-availability|arp|mac|dns-cache|advanced-routing} ...', undefined, { reason: 'drops sessions, logs or routing state' }),
  C('set ...'),
  C('set cli {pager {on|off}|scripting-mode {on|off}|config-output-format ...|terminal ...|op-command-xml-output ...|timeout ...}'),
  B('set cli confirmation-prompt ...', undefined, { reason: 'removes the device safety confirmations' }),
  B('set {password|system|clock|session|management-server} ...', undefined, { reason: 'changes device-wide state' }),
  C('set system setting target-vsys ...'),
  C('configure', 'Manipulate software configuration information', { enters: 'config' }),
  C('exit'),
  C('quit')
]

const CONFIG: Entry[] = [
  C('run', 'Run an operational-mode command', { exec: 'exec', container: true }),
  C('set ...'),
  C('set network interface ...', undefined, { rule: (args) => (args.some((a, i) => abbreviates('link-state', a, 2) && abbreviates('down', args[i + 1] ?? '')) ? { risk: 'disruptive', reason: 'shuts the interface down: if the session runs over it, access is lost' } : undefined) }),
  C('delete ...', undefined, { rule: bareDelete }),
  D('delete {network|rulebase|deviceconfig|shared|vsys|zone} ...', undefined, { reason: 'deletes a whole configuration branch' }),
  C('edit ...'),
  C('up'),
  C('top'),
  C('rename ...'),
  C('move ...'),
  C('copy ...'),
  C('clone ...'),
  C('override ...'),
  R('show ...'),
  R('check ...'),
  C('validate ...'),
  C('commit ...'),
  B('commit force ...', undefined, { reason: '"commit force" overrides locks and validation' }),
  B('load ...', undefined, { reason: 'loads a configuration file' }),
  B('revert ...', undefined, { reason: 'reverts the candidate configuration' }),
  C('save ...'),
  C('exit', undefined, { leaves: true }),
  C('quit', undefined, { leaves: true })
]

const PIPE: Entry[] = [R('match <regex>', 'Only show lines that match'), R('except <regex>', 'Hide lines that match')]

const HELP: Record<string, string> = {
  show: 'Show operational information',
  system: 'Show system information',
  interface: 'Show interface information',
  routing: 'Show routing information',
  session: 'Show session information',
  request: 'Make system-level requests',
  test: 'Test the configuration',
  configure: 'Manipulate software configuration information',
  match: 'Only show lines that match',
  except: 'Hide lines that match'
}

export const PANOS_TREES = {
  exec: { entries: EXEC, help: HELP },
  config: { entries: CONFIG, help: HELP },
  pipe: { entries: PIPE, help: HELP }
} satisfies Record<string, TreeSource>
