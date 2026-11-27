import { B, C, D, N, R, type Entry, type TreeSource } from '../dsl'

/**
 * Cisco AireOS wireless LAN controllers (docs/research/cli-cisco-aireos.md). There is no
 * separate configuration mode for most work: `config ...` typed at the top prompt applies at
 * once, so nothing under `config` is read. `save config` writes NVRAM.
 */

const EXEC: Entry[] = [
  N('show', 'Display configuration and status', { container: true }),
  R('show sysinfo', 'System information (version, uptime)'),
  R('show {inventory|boot|time|load-balancing|license ...|redundancy ...|port ...|interface ...|wlan ...|client ...|ap ...|advanced ...|network ...|mobility ...|radius ...|tacacs ...|acl ...|cpu|memory ...|msglog|traplog|logging|stats ...|switchconfig|serial|run-config ...|running-config|802.11a ...|802.11b ...|802.11h ...|rogue ...|arp ...|route ...|dhcp ...|ipv6 ...|local-auth ...|mesh ...|flexconnect ...|cdp ...|lldp ...|ntp-keys|snmpversion|snmpcommunity|sessions|loginsession|mgmtuser|netuser ...|nmsp ...|certificate ...|custom-web ...|guest-lan ...|wps ...|qos ...|media-stream ...} ...'),
  C('show tech-support', undefined, { reason: 'show tech-support is very long and CPU-heavy; run it only with approval' }),
  R('show client {summary|detail <mac>|ap ...|username ...|wlan ...} ...', 'Wireless clients'),
  R('show ap {summary|config ...|join ...|uptime|image ...|cdp ...|crash-file|stats ...|channel ...|wlan ...|inventory ...|auto-rf ...|tcpmss ...|core-dump ...} ...', 'Access points'),
  R('show wlan {summary|<n>} ...', 'WLANs'),
  R('show interface {summary|detailed <word>} ...'),
  C('show run-config', 'Full configuration and status (very long)', { reason: '"show run-config" takes minutes and asks to continue' }),
  R('show run-config commands ...'),
  R('ping <host> ...'),
  C('grep {include|exclude} ...', 'Run a command and filter its output', { reason: 'the quoted inner command is not checked' }),
  N('config', 'Configure switch options and settings (applies at once)', { container: true }),
  C('config ...', undefined, { reason: '"config" commands apply at once' }),
  C('config paging {enable|disable}', 'Turn paging of long output on or off'),
  D('config {wlan|ap|802.11a|802.11b|802.11h|interface|port|mobility|radius|network|advanced|redundancy|mesh|flexconnect|qos|dhcp|acl|route|rogue} ...', undefined, { reason: 'changes radio, WLAN or network state for live clients' }),
  C('config {sysname|location|contact|time ...|logging ...|ntp ...|snmp ...|mgmtuser ...|netuser ...|syslog ...|prompt ...|session ...|serial ...} ...'),
  D('config ap reset ...', undefined, { reason: 'reboots an access point' }),
  D('config {mgmtuser|client|exclusionlist|netuser} ...', undefined, { reason: 'changes management users or disconnects and excludes clients' }),
  D('config {wlan disable|802.11a disable|802.11b disable} ...', undefined, { reason: 'turns a WLAN or radio band off' }),
  B('config {boot|certificate ...|passwd-cleartext|interface delete|licensing|redundancy mode|mgmtuser delete ...} ...', undefined, { reason: 'changes the boot image, certificates, licensing or the management access' }),
  C('save config', 'Save the configuration to NVRAM'),
  B('{reset|clear config|transfer|debug|restart|linktest} ...', undefined, { reason: 'resets the controller, erases its configuration, transfers files or debugs' }),
  B('reset', undefined, { reason: 'resets the controller' }),
  B('clear ...', undefined, { reason: 'clear commands erase configuration, logs or statistics' }),
  C('clear stats ...', 'Clear statistics'),
  B('clear {config|ap-config ...|ap-eventlog ...|locp-stats ...|transfer ...|webimage ...|webmessage ...|login-banner ...} ...', undefined, { reason: 'erases configuration' }),
  D('clear {client ...|arp ...|lwapp ...|ext-webauth-url ...} ...', undefined, { reason: 'disconnects clients or flushes state' }),
  C('logout'),
  C('exit')
]

const PIPE: Entry[] = []

export const AIREOS_TREES = {
  exec: { entries: EXEC, help: {} },
  config: { entries: [C('exit', 'Leave configuration mode', { leaves: true }), C('paging ...')], help: {} },
  pipe: { entries: PIPE, help: {} }
} satisfies Record<string, TreeSource>
