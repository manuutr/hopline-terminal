import { FP } from './fingerprints'
import { ciscoProfiles } from './profiles-cisco'
import { tier2Profiles } from './profiles-tier2'
import type { ModeDef, PlatformId, PlatformProfile } from './types'

/**
 * Platform profiles: everything about a vendor CLI that is not the command tree.
 * Strings come from docs/research/cli-*.md; see the per-platform files for citations and
 * confidence tags. Where research left something unverified the best-known value is used.
 */

const CISCO_SUBMODES: ModeDef[] = [
  { id: 'config-if', level: 'sub-config', description: 'Interface configuration', match: /^config-(?:if|subif)/, fallback: ['config'] },
  { id: 'config-router', level: 'sub-config', description: 'Routing protocol configuration', match: /^config-router/, fallback: ['config'] },
  { id: 'config-vlan', level: 'sub-config', description: 'VLAN configuration', match: /^config-vlan/, fallback: ['config'] },
  { id: 'config-line', level: 'sub-config', description: 'Line configuration', match: /^config-(?:line|console)/, fallback: ['config'] },
  { id: 'config-acl', level: 'sub-config', description: 'Access-list configuration', match: /^config-(?:ext-nacl|std-nacl|acl|ipv6-acl)/, fallback: ['config'] },
  { id: 'config-route-map', level: 'sub-config', description: 'Route-map configuration', match: /^config-route-map/, fallback: ['config'] },
  { id: 'config-vrf', level: 'sub-config', description: 'VRF configuration', match: /^config-vrf/, fallback: ['config'] }
]

const IOS_CONFIRM = [
  /\[confirm\]\s*$/i,
  /\[yes\/no\]:?\s*$/i,
  /\?\s*\[(?:yes|no)\]:?\s*$/i,
  /filename \[[^\]]*\]\?\s*$/i,
  /\[(?:y\/n|yes\/no)\]\??\s*$/i
]

const cisco = (id: 'ios' | 'iosxe', label: string): PlatformProfile => ({
  id,
  label,
  promptStyle: 'cisco',
  fingerprint: FP[id],
  probe: 'show version',
  vendor: 'Cisco',
  depth: 'full',
  modes: [
    { id: 'user', level: 'user', description: 'User EXEC (>)', fallback: ['exec'] },
    { id: 'exec', level: 'exec', description: 'Privileged EXEC (#)' },
    { id: 'config', level: 'config', description: 'Global configuration' },
    ...CISCO_SUBMODES
  ],
  promptRegex: /^[\w.\-/:]+(?:\([\w.\-/: ]+\))?[>#] ?$/,
  pager: { pattern: /\s*--More--\s*$/, text: ' --More-- ', disable: ['terminal length 0'], keys: { line: '\r', page: ' ', quit: 'q' } },
  errors: {
    invalid: /^% Invalid input detected at '\^' marker\./m,
    ambiguous: /^% Ambiguous command:\s+".*"/m,
    incomplete: /^% Incomplete command\./m,
    // Authorization (AAA/TACACS+ command authorization, privilege): the command did not run.
    other: [/^% Unrecognized command/m, /^% Bad IP address or host name/m, /^% Unknown command or computer name/m, /^% Type "show \?" for a list of subcommands/m, /^%\s*Error/m, /^%?\s*Command authorization failed/im, /^% Authorization failed/m, /^% Permission denied/m, /^% Access denied/m],
    caret: 'first-failing-char',
    samples: {
      invalid: "core-sw1#show ip intrface brief\n                    ^\n% Invalid input detected at '^' marker.",
      ambiguous: 'core-sw1#sh c\n% Ambiguous command:  "sh c"',
      incomplete: 'core-sw1#clock set 13:32:00\n% Incomplete command.'
    }
  },
  confirmPatterns: IOS_CONFIRM,
  pipes: {
    filters: ['include', 'exclude', 'begin', 'section', 'count', 'redirect', 'append', 'tee', 'format'],
    quoteAware: false,
    unknown: 'error',
    // One filter per line: `show int | include line protocol|Last input` is a single regex.
    regexRest: ['include', 'exclude', 'begin', 'section', 'count'],
    writers: ['redirect', 'append', 'tee', 'format']
  },
  abbreviation: { prefixes: true, objectNames: 'abbreviated' },
  execFromConfig: 'do',
  configInheritsExec: false,
  quotes: false,
  // Ctrl-E (end of line) before Ctrl-U: IOS Ctrl-U erases only left of the cursor, so text to the right
  // that the screen does not show would survive it (Phase 8 review A-L3).
  keys: { ctrlZ: 'end', ctrlC: 'end', ctrlR: 'redraw', breakSeq: '\x1e', lineClear: '\x05\x15' },
  completion: { tab: 'unique-only', space: false, helpFormat: 'cisco' },
  interfaces: {
    types: [
      { full: 'GigabitEthernet', short: ['Gi', 'Gig'] },
      { full: 'FastEthernet', short: ['Fa', 'Fas'] },
      { full: 'TenGigabitEthernet', short: ['Te', 'Ten'] },
      { full: 'TwentyFiveGigE', short: ['Twe'] },
      { full: 'TwoGigabitEthernet', short: ['Tw'] },
      { full: 'FiveGigabitEthernet', short: ['Fi'] },
      { full: 'FortyGigabitEthernet', short: ['Fo'] },
      { full: 'HundredGigE', short: ['Hu'] },
      { full: 'AppGigabitEthernet', short: ['Ap'] },
      { full: 'Ethernet', short: ['Et', 'Eth'] },
      { full: 'Port-channel', short: ['Po'] },
      { full: 'Loopback', short: ['Lo'] },
      { full: 'Vlan', short: ['Vl'] },
      { full: 'Tunnel', short: ['Tu'] },
      { full: 'Null', short: ['Nu'] },
      { full: 'Serial', short: ['Se'] },
      { full: 'BDI', short: ['BD'] },
      { full: 'Dialer', short: ['Di'] },
      { full: 'Virtual-Template', short: ['Vt'] },
      { full: 'Virtual-Access', short: ['Vi'] }
    ],
    numbering: /^\d+(?:\/\d+){0,3}(?:\.\d+)?(?::\d+)?$/,
    spaceBetween: true
  },
  live: {
    interfaces: { command: 'show ip interface brief', ttlSeconds: 120 },
    vlans: { command: 'show vlan brief', ttlSeconds: 120 },
    vrfs: { command: 'show vrf', ttlSeconds: 300 },
    'bgp-neighbors': { command: 'show ip bgp summary', ttlSeconds: 120 },
    'ospf-neighbors': { command: 'show ip ospf neighbor', ttlSeconds: 120 },
    'route-maps': { command: 'show route-map', ttlSeconds: 300 },
    'prefix-lists': { command: 'show ip prefix-list', ttlSeconds: 300 },
    acls: { command: 'show ip access-lists', ttlSeconds: 300 }
  }
})

const nxos: PlatformProfile = {
  id: 'nxos',
  promptStyle: 'nxos',
  fingerprint: FP.nxos,
  probe: 'show version',
  label: 'Cisco NX-OS',
  vendor: 'Cisco',
  depth: 'full',
  modes: [{ id: 'exec', level: 'exec', description: 'EXEC (#)' }, { id: 'config', level: 'config', description: 'Global configuration' }, ...CISCO_SUBMODES],
  promptRegex: /^[\w.\-/:]+(?:%[\w.\-]+)?(?:\([\w.\-/: ]+\))?# ?$/,
  pager: { pattern: /--More--\s*$/, text: '--More--', disable: ['terminal length 0'], perCommand: '| no-more', keys: { line: '\r', page: ' ', quit: 'q' } },
  errors: {
    invalid: /^% Invalid (?:command|input detected) at '\^' marker\./m,
    ambiguous: /^% Ambiguous command/m,
    incomplete: /^% Incomplete command/m,
    other: [/^% Invalid (?:number|parameter|range|interface)/m, /^% Permission denied/m, /^%?\s*Command authorization failed/im, /^% Authorization failed/m],
    caret: 'token-start',
    samples: {
      invalid: "leaf1# show interfaces brief\n            ^\n% Invalid command at '^' marker.",
      ambiguous: "leaf1# s ver\n       ^\n% Ambiguous command at '^' marker.",
      incomplete: "leaf1# show ip\n              ^\n% Incomplete command at '^' marker."
    }
  },
  confirmPatterns: [/\(y\/n\)\s*\??\s*(?:\[[yn]\])?\s*$/i, /\[confirm\]\s*$/i, /\[(?:yes|no)\]\s*$/i],
  pipes: {
    filters: ['include', 'exclude', 'begin', 'section', 'count', 'grep', 'egrep', 'head', 'last', 'wc', 'no-more', 'json', 'json-pretty', 'xml', 'sort', 'uniq', 'cut', 'tr', 'human', 'diff', 'vsh', 'email', 'python', 'tee', 'append', 'redirect', 'sed', 'awk', 'perl', 'less'],
    quoteAware: true,
    unknown: 'error',
    quotesUnverified: true,
    writers: ['vsh', 'email', 'python', 'tee', 'append', 'redirect', 'upload', 'sed', 'awk', 'perl', 'sscp', 'less', 'source', 'bash']
  },
  abbreviation: { prefixes: true, objectNames: 'abbreviated' },
  execFromConfig: 'do',
  // NX-OS runs exec commands (show, copy, delete, reload) typed in configuration mode.
  configInheritsExec: true,
  configShadowsExec: ['feature'],
  quotes: true,
  // Ctrl-E, then Ctrl-U (erases left of the cursor only), as on IOS.
  keys: { ctrlZ: 'end', ctrlC: 'clear-line', ctrlR: 'redraw', lineClear: '\x05\x15' },
  completion: { tab: 'list-on-ambiguous', space: false, helpFormat: 'cisco' },
  structured: { suffix: '| json', format: 'json' },
  interfaces: {
    types: [
      { full: 'Ethernet', short: ['Eth', 'e'] },
      { full: 'port-channel', short: ['Po'] },
      { full: 'loopback', short: ['Lo'] },
      { full: 'Vlan', short: [] },
      { full: 'mgmt', short: [] },
      { full: 'Tunnel', short: [] },
      { full: 'nve', short: [] }
    ],
    numbering: /^\d+(?:\/\d+){0,2}(?:\.\d+)?$/,
    spaceBetween: true
  },
  live: {
    interfaces: { command: 'show interface brief', structured: 'show interface brief | json', ttlSeconds: 120 },
    vlans: { command: 'show vlan brief', structured: 'show vlan brief | json', ttlSeconds: 120 },
    vrfs: { command: 'show vrf', structured: 'show vrf | json', ttlSeconds: 300 },
    'bgp-neighbors': { command: 'show bgp ipv4 unicast summary vrf all', structured: 'show bgp ipv4 unicast summary vrf all | json', ttlSeconds: 120 },
    'ospf-neighbors': { command: 'show ip ospf neighbors vrf all', ttlSeconds: 120 },
    'route-maps': { command: 'show route-map', structured: 'show route-map | json', ttlSeconds: 300 },
    'prefix-lists': { command: 'show ip prefix-list', ttlSeconds: 300 },
    acls: { command: 'show ip access-lists summary', ttlSeconds: 300 },
    checkpoints: { command: 'show checkpoint summary', ttlSeconds: 300 }
  }
}

const eosSub = CISCO_SUBMODES.map((m) => ({ ...m, match: m.id === 'config-acl' ? /^config-(?:acl|ip-acl|ipv6-acl)/ : m.match }))

const eos: PlatformProfile = {
  id: 'eos',
  promptStyle: 'cisco',
  fingerprint: FP.eos,
  probe: 'show version',
  label: 'Arista EOS',
  vendor: 'Arista',
  depth: 'full',
  modes: [
    { id: 'user', level: 'user', description: 'Unprivileged EXEC (>)', fallback: ['exec'] },
    { id: 'exec', level: 'exec', description: 'Privileged EXEC (#)' },
    // EOS config modes inherit exec commands: `reload` works in (config)# without `do`.
    { id: 'config', level: 'config', description: 'Global configuration', fallback: ['exec'] },
    ...eosSub
  ],
  promptRegex: /^[\w.\-/:]+(?:\([\w.\-/:, ]+\))*[>#] ?$/,
  pager: { pattern: /\s*--More--\s*$/, text: ' --More-- ', disable: ['terminal length 0'], perCommand: '| no-more', keys: { line: '\r', page: ' ', quit: 'q' } },
  errors: {
    invalid: /^% Invalid input(?: \(at token \d+: '[^']*'\))?/m,
    ambiguous: /^% Ambiguous command/m,
    incomplete: /^% Incomplete command/m,
    other: [/^% Unavailable command/m, /^% Cannot commit/m, /^% Authorization denied/m, /^% Invalid input \(privileged mode required\)/m, /^%?\s*Command authorization failed/im, /^% Permission denied/m],
    caret: 'none',
    samples: {
      invalid: "dist-eos1#show ip bgp sumary\n% Invalid input (at token 3: 'sumary')",
      ambiguous: 'dist-eos1#con\n% Ambiguous command',
      incomplete: 'dist-eos1#show ip\n% Incomplete command'
    }
  },
  confirmPatterns: [/\[confirm\]\s*$/i, /\[y\/n\]\??\s*$/i, /\(y\/n\)\s*\??\s*$/i, /\[yes\/no\]:?\s*$/i],
  // Any word after `|` that is not an EOS modifier runs as a Linux command.
  pipes: { filters: ['include', 'exclude', 'begin', 'section', 'json', 'no-more', 'nz'], quoteAware: false, unknown: 'shell' },
  abbreviation: { prefixes: true, objectNames: 'abbreviated' },
  execFromConfig: 'do',
  configInheritsExec: true,
  quotes: false,
  // Ctrl-E, then Ctrl-U (erases left of the cursor only), as on IOS.
  keys: { ctrlZ: 'end', ctrlC: 'clear-line', ctrlR: 'search', lineClear: '\x05\x15' },
  completion: { tab: 'list-on-ambiguous', space: false, helpFormat: 'cisco' },
  structured: { suffix: '| json', format: 'json' },
  interfaces: {
    types: [
      { full: 'Ethernet', short: ['Et', 'eth'] },
      { full: 'Port-Channel', short: ['Po'] },
      { full: 'Loopback', short: ['Lo'] },
      { full: 'Vlan', short: ['Vl'] },
      { full: 'Management', short: ['Ma'] },
      { full: 'Vxlan', short: ['Vx'] },
      { full: 'Tunnel', short: ['Tu'] },
      { full: 'Null', short: [] }
    ],
    numbering: /^\d+(?:\/\d+){0,2}(?:\.\d+)?(?:[-,][\d/,-]+)?$/,
    spaceBetween: true
  },
  live: {
    interfaces: { command: 'show interfaces status', structured: 'show interfaces status | json', ttlSeconds: 120 },
    vlans: { command: 'show vlan', structured: 'show vlan | json', ttlSeconds: 120 },
    vrfs: { command: 'show vrf', structured: 'show vrf | json', ttlSeconds: 300 },
    'bgp-neighbors': { command: 'show ip bgp summary vrf all', structured: 'show ip bgp summary vrf all | json', ttlSeconds: 120 },
    'ospf-neighbors': { command: 'show ip ospf neighbor', structured: 'show ip ospf neighbor | json', ttlSeconds: 120 },
    'route-maps': { command: 'show route-map', structured: 'show route-map | json', ttlSeconds: 300 },
    'prefix-lists': { command: 'show ip prefix-list', ttlSeconds: 300 },
    acls: { command: 'show ip access-lists summary', structured: 'show ip access-lists | json', ttlSeconds: 300 },
    'config-sessions': { command: 'show configuration sessions', ttlSeconds: 60 }
  }
}

const junos: PlatformProfile = {
  id: 'junos',
  promptStyle: 'junos',
  fingerprint: FP.junos,
  probe: 'show version',
  label: 'Juniper Junos',
  vendor: 'Juniper',
  depth: 'full',
  modes: [
    { id: 'exec', level: 'exec', description: 'Operational mode (user@host>)' },
    { id: 'config', level: 'config', description: 'Configuration mode ([edit] user@host#)' }
  ],
  promptRegex: /^(?:[\w.\-]+@)?[\w.\-]+(?::[\w-]+)?[>#] ?$/,
  pager: {
    pattern: /---\(more(?: \d+%)?\)---\s*$/,
    text: '---(more)---',
    disable: ['set cli screen-length 0'],
    perCommand: '| no-more',
    keys: { line: '\r', page: ' ', quit: 'q' }
  },
  errors: {
    invalid: /^(?:syntax error(?:, expecting [^\n]*)?\.?|unknown command\.)$/m,
    ambiguous: /^'[^']+' is ambiguous\./m,
    incomplete: /^syntax error, expecting <[^>]+>/m,
    other: [/^error: /m, /^warning: statement not found/m, /^Warning: missing mandatory statement/m],
    caret: 'token-end',
    samples: {
      invalid: 'netops@edge-r1> show foo\n                     ^\nsyntax error, expecting <command>: foo',
      ambiguous: "root> show sy\n            ^\n'sy' is ambiguous.\nPossible completions:",
      incomplete: 'user@host# set protocols ospf area\n                                ^\nsyntax error, expecting <identifier>'
    }
  },
  confirmPatterns: [/\[yes,no\]\s*\((?:yes|no)\)\s*$/i],
  pipes: {
    filters: ['match', 'except', 'count', 'no-more', 'display', 'find', 'last', 'trim', 'resolve', 'compare', 'hold', 'save', 'append', 'tee', 'refresh', 'request'],
    quoteAware: true,
    unknown: 'error'
  },
  abbreviation: { prefixes: true, objectNames: 'full' },
  execFromConfig: 'run',
  configInheritsExec: false,
  quotes: true,
  keys: { ctrlZ: 'none', ctrlC: 'clear-line', ctrlR: 'search', lineClear: '\x15' },
  completion: { tab: 'unique-only', space: true, helpFormat: 'junos' },
  structured: { suffix: '| display json', format: 'json' },
  interfaces: {
    types: [],
    numbering: /^$/,
    spaceBetween: false,
    fullName:
      /^(?:(?:fe|ge|xe|et|mge|gr|ip|lt|vt|vcp)-[\d*[\]-]+\/[\d*[\]-]+\/[\d*[\]-]+(?::\d+)?|(?:ae|reth|fab)[\d*]+|lo0|irb|vlan|(?:fxp|em|me)\d|st0|vme|[a-z]+-\*|[a-z]+\*)(?:\.[\d*]+)?$/i
  },
  live: {
    interfaces: { command: 'show interfaces terse', structured: 'show interfaces terse | display json', ttlSeconds: 120 },
    vlans: { command: 'show vlans', ttlSeconds: 120 },
    vrfs: { command: 'show route instance', ttlSeconds: 300 },
    'bgp-neighbors': { command: 'show bgp summary', structured: 'show bgp summary | display json', ttlSeconds: 120 },
    'ospf-neighbors': { command: 'show ospf neighbor', ttlSeconds: 120 },
    'policy-statements': { command: 'show configuration policy-options | display set | match policy-statement', ttlSeconds: 300 },
    'prefix-lists': { command: 'show configuration policy-options | display set | match prefix-list', ttlSeconds: 300 },
    'firewall-filters': { command: 'show configuration firewall | display set', ttlSeconds: 300 },
    zones: { command: 'show security zones terse', ttlSeconds: 300 }
  }
}

const panos: PlatformProfile = {
  id: 'panos',
  promptStyle: 'panos',
  fingerprint: FP.panos,
  probe: 'show system info',
  label: 'Palo Alto PAN-OS',
  vendor: 'Palo Alto Networks',
  depth: 'read-only',
  modes: [
    { id: 'exec', level: 'exec', description: 'Operational mode (admin@fw>)' },
    { id: 'config', level: 'config', description: 'Configuration mode ([edit] admin@fw#)' }
  ],
  promptRegex: /^[\w.\-]+@[\w.\-]+?(?:-vsys\d+)?(?:\([a-z-]+\))?[>#] ?$/,
  // Pager string unresolved in research: less-style "lines 1-24" or "--more--".
  pager: { pattern: /(?:lines \d+-\d+(?:\/\d+)?(?: \(END\))?|--more--)\s*$/i, text: 'lines 1-24 ', disable: ['set cli pager off'], keys: { line: '\r', page: ' ', quit: 'q' } },
  errors: {
    invalid: /^(?:Unknown command: \S+|Invalid syntax\.)/m,
    ambiguous: /^(?:Ambiguous command|Invalid syntax\.)/m,
    incomplete: /^(?:Incomplete command|Invalid syntax\.)/m,
    other: [/^Server error ?: /m, /^Error: (?:Permission denied|Insufficient privileges|You do not have permission)/im],
    caret: 'none',
    samples: { invalid: 'admin@fw1> shwo\nUnknown command: shwo', ambiguous: 'admin@fw1> s\nInvalid syntax.', incomplete: 'admin@fw1> show\nInvalid syntax.' }
  },
  confirmPatterns: [/\(y or n\)\s*$/i],
  pipes: { filters: ['match', 'except'], quoteAware: true, unknown: 'error' },
  abbreviation: { prefixes: false, objectNames: 'full' },
  execFromConfig: 'run',
  configInheritsExec: false,
  quotes: true,
  keys: { ctrlZ: 'none', ctrlC: 'clear-line', ctrlR: 'none', lineClear: '\x15' },
  completion: { tab: 'unique-only', space: true, helpFormat: 'panos' },
  interfaces: {
    types: [],
    numbering: /^$/,
    spaceBetween: false,
    fullName: /^(?:ethernet\d+\/\d+(?:\.\d+)?|ae\d+(?:\.\d+)?|(?:loopback|tunnel|vlan|sdwan)(?:\.\d+)?|ha[1-4](?:-[ab])?|hsci|dedicated-ha[12]|management)$/
  },
  live: {
    interfaces: { command: 'show interface logical', ttlSeconds: 120 },
    vrfs: { command: 'show routing route', ttlSeconds: 300 },
    'bgp-neighbors': { command: 'show routing protocol bgp summary', ttlSeconds: 120 },
    'ospf-neighbors': { command: 'show routing protocol ospf neighbor', ttlSeconds: 120 },
    zones: { command: 'show interface logical', ttlSeconds: 300 }
  }
}

const fortios: PlatformProfile = {
  id: 'fortios',
  promptStyle: 'fortios',
  fingerprint: FP.fortios,
  probe: 'get system status',
  label: 'Fortinet FortiOS',
  vendor: 'Fortinet',
  depth: 'read-only',
  modes: [
    { id: 'exec', level: 'exec', description: 'Top level (host # )' },
    { id: 'config', level: 'config', description: 'Inside a config table or entry (host (ctx) # )' }
  ],
  promptRegex: /^[\w.\-]+ (?:\([^)]+\) )?[#$] ?$/,
  pager: { pattern: /--More--\s*$/, text: '--More--', disable: [], keys: { line: '\r', page: ' ', quit: 'q' } },
  errors: {
    invalid: /^(?:command parse error before '[^']*'|Unknown action 0)/im,
    ambiguous: /^command parse error before '[^']*'/im,
    incomplete: /^command parse error before '[^']*'/im,
    other: [/^value parse error before /m, /^Command fail\. Return code -?\d+/m, /^entry not found in datasource/m, /MUST be set\./m],
    caret: 'none',
    samples: {
      invalid: "fgt-edge1 (10) # set bogus 1\ncommand parse error before 'bogus'\nCommand fail. Return code -61",
      ambiguous: "fgt-edge1 (policy) # e\ncommand parse error before 'e'\nCommand fail. Return code -61",
      incomplete: "fgt-edge1 # get router info\ncommand parse error before 'info'\nCommand fail. Return code -61"
    }
  },
  confirmPatterns: [/\(y\/n\)\s*$/i],
  pipes: { filters: ['grep'], quoteAware: true, unknown: 'error' },
  abbreviation: { prefixes: true, objectNames: 'full' },
  execFromConfig: null,
  configInheritsExec: false,
  quotes: true,
  keys: { ctrlZ: 'none', ctrlC: 'abort-or-disconnect', ctrlR: 'none' },
  completion: { tab: 'cycle', space: false, helpFormat: 'fortios' },
  interfaces: { types: [], numbering: /^$/, spaceBetween: false, opaque: true },
  live: {
    interfaces: { command: 'get system interface', ttlSeconds: 120 },
    vlans: { command: 'show system interface | grep -f "set vlanid"', ttlSeconds: 300 },
    'bgp-neighbors': { command: 'get router info bgp summary', ttlSeconds: 120 },
    'ospf-neighbors': { command: 'get router info ospf neighbor', ttlSeconds: 120 },
    'route-maps': { command: 'show router route-map', ttlSeconds: 300 },
    'prefix-lists': { command: 'show router prefix-list', ttlSeconds: 300 },
    acls: { command: 'show router access-list', ttlSeconds: 300 },
    zones: { command: 'show system zone', ttlSeconds: 300 },
    'address-objects': { command: 'show firewall address', ttlSeconds: 300 }
  }
}

const iosxe = cisco('iosxe', 'Cisco IOS-XE')

export const PROFILES: Readonly<Record<PlatformId, PlatformProfile>> = {
  ios: cisco('ios', 'Cisco IOS'),
  iosxe,
  nxos,
  ...ciscoProfiles(iosxe),
  ...tier2Profiles(iosxe),
  eos,
  junos,
  panos,
  fortios
}
