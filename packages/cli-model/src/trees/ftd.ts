import { B, C, D, N, R, type Entry, type TreeSource } from '../dsl'
import { CISCO_HELP } from './help'

/**
 * Cisco Firepower Threat Defense CLI at read-only depth (docs/research/cli-cisco-ftd.md). The
 * `>` prompt is a restricted CLI; `expert` (Linux shell), `system support diagnostic-cli`
 * (the ASA engine) and `connect fxos` leave it, so they are blocked. Most `configure` commands
 * apply at once.
 */

const EXEC: Entry[] = [
  N('show', 'Display information', { container: true }),
  R('show {version|running-config ...|interface ...|route ...|bgp ...|ospf ...|conn ...|xlate ...|nat ...|access-list ...|failover ...|high-availability ...|cluster ...|managers|network|network-static-routes|arp ...|cpu ...|memory ...|processes ...|blocks ...|traffic ...|asp ...|crypto ...|vpn-sessiondb ...|logging ...|clock|ntp ...|users|ssh-access-list|snmp-server ...|inventory|environment ...|disk|disk-manager|model|serial-number|kernel ...|snort ...|perfstats ...|capture ...|service-policy ...|threat-detection ...|dhcpd ...|dns ...|local-host ...|ipv6 ...|time|uptime|history ...|summary|counters ...|fxos ...|audit-log|database ...|eventing ...|ip ...|module ...|object-group ...|object ...|cluster-info ...|zone ...|identity ...} ...'),
  R('show interface ip brief ...'),
  C('show dns lookup ...', undefined, { reason: 'an explicit DNS lookup needs approval' }),
  C('show tech-support ...', undefined, { reason: 'show tech-support is very long and CPU-heavy; run it only with approval' }),
  R('packet-tracer input <word> {tcp|udp|icmp|rawip|sctp} ...', 'Simulate a packet through the policy (read-only)'),
  R('ping [{system}] <host> ...'),
  R('traceroute [{system}] <host> ...'),
  ...['expert', 'sudo', 'crashinfo', 'install', 'reboot', 'restart', 'shutdown', 'restore', 'upgrade', 'cluster', 'failover', 'capture-traffic', 'file', 'dir', 'copy', 'delete'].map((h) =>
    B(`${h} ...`, undefined, { reason: `"${h}" is on the deny-list` })
  ),
  D('capture ...', 'Capture packets', { reason: 'packet capture uses device memory and CPU' }),
  C('no capture ...'),
  N('system', 'System commands', { container: true }),
  B('system ...', undefined, { reason: 'system commands open other shells, restart processes or change access' }),
  B('system support diagnostic-cli', 'Enter the diagnostic (ASA) CLI', { reason: 'leaves the restricted CLI for the diagnostic engine' }),
  C('system generate-troubleshoot ...', 'Generate troubleshooting files', { reason: 'writes troubleshoot archives and loads the device' }),
  B('connect ...', undefined, { reason: '"connect fxos" leaves this CLI for the chassis shell' }),
  N('configure', 'Change settings (applies at once)', { container: true }),
  C('configure ...', undefined, { reason: 'configure commands apply at once' }),
  B('configure {manager ...|firewall ...|network ...|password|user ...|high-availability ...|log-events ...|disable-https-access|disable-ssh-access|https-access-list ...|ssh-access-list ...|cert-update ...|policy ...|raid ...|recovery-config ...|snort ...|coredump ...|flow-offload ...|inspection ...} ...', undefined, { reason: 'changes management, firewall mode, network or user access' }),
  D('configure {network ipv4 ...|network ipv6 ...|network static-routes ...}', undefined, { reason: 'changes management addressing' }),
  C('clear ...'),
  D('clear {conn|xlate|local-host|arp|crypto ...|vpn-sessiondb ...|route ...|logging ...} ...', undefined, { reason: 'drops connections, sessions or routing state' }),
  B('clear {configure|config} ...', undefined, { reason: 'wipes configuration' }),
  C('debug ...', undefined, { reason: 'debugging can load the CPU' }),
  C('undebug ...'),
  C('terminal ...'),
  C('exit'),
  C('logout')
]

const PIPE: Entry[] = [
  R('include <regex>', 'Include lines that match'),
  R('exclude <regex>', 'Exclude lines that match'),
  R('begin <regex>', 'Begin with the line that matches'),
  R('grep [-v] <regex>')
]

export const FTD_TREES = {
  exec: { entries: EXEC, help: CISCO_HELP },
  config: { entries: [C('exit', undefined, { leaves: true })], help: CISCO_HELP },
  pipe: { entries: PIPE, help: CISCO_HELP, priority: { '': { i: 'include', e: 'exclude', b: 'begin', g: 'grep' } } }
} satisfies Record<string, TreeSource>
