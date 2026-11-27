import { B, C, D, forbidsWord, N, R, type Entry, type TreeSource } from '../dsl'
import { CISCO_HELP } from './help'
import { IOS_TREES } from './ios'

/**
 * Cisco platforms that reuse the IOS/IOS-XE trees with additions:
 * - Catalyst 9800 WLC (IOS-XE): wireless show commands, AP and client actions
 *   (docs/research/cli-cisco-c9800.md)
 * - Small Business SG/CBS switches: IOS-like, `terminal datadump` instead of `terminal length 0`
 *   (docs/research/cli-cisco-sb.md)
 * Entries merge into the IOS tree; on a conflict the higher risk wins.
 */

const extend = (base: TreeSource, extra: Entry[]): TreeSource => ({ ...base, entries: [...base.entries, ...extra] })

const WLC_EXEC: Entry[] = [
  R('show wireless {summary|client ...|stats ...|tag ...|profile ...|country ...|mobility ...|management trustpoint|dot11h ...|fabric ...|load ...|loadbalance ...|multicast ...|performance ...|rfid ...|urlfilter ...|wps ...|wgb ...} ...', 'Wireless status'),
  R('show wireless client summary ...', 'Associated clients'),
  R('show wireless client mac-address <mac> detail ...'),
  R('show ap {summary|config ...|name <word> ...|tag ...|cdp ...|join ...|uptime|status ...|dot11 ...|image ...|crash-file|auto-rf ...|rf-profile ...|link-encryption|led-flash ...|environment|lan port ...|filters ...|history ...|wlan ...|neighbor ...|cpu ...|memory ...|capwap ...|ethernet ...} ...', 'Access point status'),
  R('show wlan {summary|all|id <n>|name <word>|policy-profile ...} ...', 'WLANs'),
  R('show wireless profile policy {summary|detailed <word>} ...'),
  R('show ap dot11 {24ghz|5ghz|6ghz|dual-band} {summary|channel|txpower|load-info|coverage|network|monitor|cleanair ...|profile} ...'),
  R('show chassis ...'),
  R('show redundancy ...'),
  R('show install summary ...'),
  R('show logging profile wireless ...', 'Radioactive-trace and wireless logs', {
    rule: forbidsWord('to-file', '"to-file" writes the log to bootflash', 4)
  }),
  D('debug wireless ...', undefined, { reason: 'radioactive tracing writes ra_trace files to bootflash and loads the CPU' }),
  D('clear platform condition ...', undefined, { reason: 'removes debug conditions others may rely on' }),
  N('ap', 'Access point exec commands', { container: true }),
  D('ap name <word> {reset|reload} ...', undefined, { reason: 'reboots an access point and drops its clients' }),
  D('ap name <word> ...', undefined, { reason: 'changes access point state' }),
  D('ap {auth-list|image ...|join ...} ...', undefined, { reason: 'changes AP join or image state' }),
  D('wireless client mac-address <mac> deauthenticate ...', 'Deauthenticate a client', { reason: 'disconnects a wireless client' }),
  D('wireless ...', undefined, { reason: 'wireless exec commands change controller state' }),
  B('clear ap {config|tag ...} ...', undefined, { reason: 'resets access point configuration' }),
  D('clear wireless ...', undefined, { reason: 'clears wireless state for clients or APs' }),
  B('wireless config vwlc-ssc ...', undefined, { reason: 'regenerates the controller certificate' }),
  B('ap {image predownload|name <word> image predownload} ...', undefined, { reason: 'pushes a new image to access points' })
]

const WLC_CONFIG: Entry[] = [
  C('{wlan|wireless|ap|aaa|radius|dot11|wlan-profile} ...'),
  D('no wlan ...', undefined, { reason: 'removes a WLAN and disconnects its clients' }),
  D('wlan <word> <n> <word>', 'Create or edit a WLAN'),
  D('ap dot11 {24ghz|5ghz|6ghz} shutdown', undefined, { reason: 'turns a radio band off on every AP' }),
  B('wireless management ...', undefined, { reason: 'changes the wireless management trustpoint or interface; APs can stop joining' }),
  D('wireless profile policy <word> shutdown', undefined, { reason: 'disconnects every client on the policy profile' }),
  D('shutdown', undefined, { reason: 'in a WLAN or policy profile, disconnects its clients' })
]

export const C9800_TREES = {
  ...IOS_TREES,
  exec: extend(IOS_TREES.exec, WLC_EXEC),
  config: extend(IOS_TREES.config, WLC_CONFIG)
} satisfies Record<string, TreeSource>

const SB_EXEC: Entry[] = [
  R('show {system ...|interfaces status ...|interfaces counters ...|interfaces configuration ...|interfaces switchport ...|ports ...|bonjour ...|green-ethernet ...|cpu ...|users ...|sessions ...|lldp ...|mac address-table ...|vlan ...|spanning-tree ...|ip interface ...|ip route ...|ip ssh ...|logging ...|clock ...|version ...|inventory ...|running-config ...|startup-config ...|bootvar|stack ...|ip dhcp ...|power inline ...|env ...|sntp ...|snmp ...|arp ...|rmon ...} ...'),
  C('terminal datadump', 'Show all output without pausing'),
  C('terminal no datadump'),
  B('boot ...', undefined, { reason: 'changes the boot image' }),
  B('delete ...', undefined, { reason: 'deletes files, including the startup configuration' }),
  B('{restore|set system} ...', undefined, { reason: 'restores factory defaults or changes the system mode' }),
  C('write [memory]', 'Save the running configuration'),
  C('copy running-config startup-config')
]

export const SB_TREES = {
  ...IOS_TREES,
  exec: extend(IOS_TREES.exec, SB_EXEC)
} satisfies Record<string, TreeSource>

export const CISCO_EXTRA_HELP = CISCO_HELP
