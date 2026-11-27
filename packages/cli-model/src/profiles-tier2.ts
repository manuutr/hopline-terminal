import type { FingerprintSignal, ModeDef, PlatformProfile } from './types'

/**
 * Tier 2/3 profiles that start from the IOS-XE profile shape (`base`):
 * HPE Aruba AOS-CX and Huawei VRP. Sources: docs/research/cli-aruba-aoscx.md and
 * docs/research/cli-huawei-vrp.md (most strings there are marked unverified).
 */

const sub = (id: ModeDef['id'], match: RegExp, description: string): ModeDef => ({ id, level: 'sub-config', description, match, fallback: ['config'] })

const FP_AOSCX: FingerprintSignal[] = [
  { kind: 'showVersion', re: /ArubaOS-CX|AOS-CX|^Version\s+: [A-Z]{2}\.\d+\.\d+/m, weight: 0.95, version: /^Version\s+: (\S+)/m, note: 'ArubaOS-CX version block [unverified layout]' },
  { kind: 'banner', re: /ArubaOS-CX|Aruba Networks|HPE Aruba/i, weight: 0.5, note: 'Aruba banner' }
]

const FP_VRP: FingerprintSignal[] = [
  { kind: 'showVersion', re: /Huawei Versatile Routing Platform Software|VRP \(R\) software/, weight: 0.95, version: /VRP \(R\) software, Version ([\d.]+)/, model: /^(?:HUAWEI|Quidway) (\S+)/m, note: '"Huawei Versatile Routing Platform" (display version)' },
  { kind: 'sshServerVersion', re: /^SSH-[\d.]+-HUAWEI/i, weight: 0.7, note: 'HUAWEI SSH server [unverified]' },
  { kind: 'prompt', re: /^<[\w.\-]+>\s?$/, weight: 0.6, note: '<host> user-view prompt' },
  { kind: 'prompt', re: /^\[~?\*?[\w.\-]+(?:-[\w./:-]+)?\]\s?$/, weight: 0.5, note: '[host] system-view prompt' }
]

const withoutLineClear = ({ lineClear: _, ...keys }: PlatformProfile['keys']): PlatformProfile['keys'] => keys
/** Ctrl-Shift-6 is the IOS break; AOS-CX and VRP stop a ping or traceroute with Ctrl-C ("press CTRL_C to break"). */
const withoutBreak = ({ breakSeq: _, ...keys }: PlatformProfile['keys']): PlatformProfile['keys'] => keys

export function tier2Profiles(base: PlatformProfile): Pick<Record<string, PlatformProfile>, 'aoscx' | 'vrp'> {
  const aoscx: PlatformProfile = {
    ...base,
    keys: withoutBreak(base.keys),
    id: 'aoscx',
    label: 'HPE Aruba AOS-CX',
    depth: 'read-only',
    vendor: 'HPE Aruba',
    fingerprint: FP_AOSCX,
    modes: [
      { id: 'exec', level: 'exec', description: 'Manager (#)' },
      { id: 'user', level: 'user', description: 'Operator (>)', fallback: ['exec'] },
      { id: 'config', level: 'config', description: 'Global configuration' },
      sub('config-if', /^config-(?:if|lag-if|if-vlan|loopback-if)/, 'Interface configuration'),
      sub('config-vlan', /^config-vlan/, 'VLAN configuration'),
      sub('config-router', /^config-(?:bgp|ospf|router)/, 'Routing protocol configuration'),
      sub('config-vrf', /^config-vrf/, 'VRF configuration')
    ],
    pager: { pattern: /-- MORE --, next page: Space, next line: Enter, quit: Control-C\s*$/, text: '-- MORE --, next page: Space, next line: Enter, quit: Control-C', disable: ['no page'], keys: { line: '\r', page: ' ', quit: '\x03' } },
    errors: {
      ...base.errors,
      invalid: /^% Command incomplete\.|^Invalid input: /m,
      incomplete: /^% Command incomplete\./m,
      ambiguous: /^% Ambiguous command/m,
      samples: { invalid: 'sw1# show intrface\nInvalid input: intrface', ambiguous: 'sw1# sh c\n% Ambiguous command', incomplete: 'sw1# show ip\n% Command incomplete.' }
    },
    pipes: { filters: ['include', 'exclude', 'begin', 'count', 'redirect'], quoteAware: false, unknown: 'error' },
    // `show` and other manager commands are accepted in config contexts [unverified]: classify a
    // config line against the exec tree too (stricter either way).
    configInheritsExec: true,
    // `ssh server vrf mgmt`, the `vsx` context: configuration commands, not the exec client/actions.
    configShadowsExec: ['ssh', 'vsx'],
    interfaces: {
      types: [
        { full: 'vlan', short: ['vl'] },
        { full: 'lag', short: ['la'] },
        { full: 'loopback', short: ['lo'] },
        { full: 'mgmt', short: ['mg'] }
      ],
      numbering: /^\d+(?:\/\d+){0,2}$/,
      spaceBetween: true
    },
    live: {
      interfaces: { command: 'show interface brief', ttlSeconds: 120 },
      vlans: { command: 'show vlan', ttlSeconds: 120 },
      vrfs: { command: 'show vrf', ttlSeconds: 300 }
    }
  }

  const vrp: PlatformProfile = {
    ...base,
    // Ctrl-U erasing the line is unverified here: the executor checks the echo only.
    keys: withoutBreak(withoutLineClear(base.keys)),
    id: 'vrp',
    label: 'Huawei VRP',
    depth: 'read-only',
    vendor: 'Huawei',
    promptStyle: 'vrp',
    fingerprint: FP_VRP,
    probe: 'display version',
    modes: [
      { id: 'exec', level: 'exec', description: 'User view (<host>)' },
      { id: 'config', level: 'config', description: 'System view ([host])' },
      sub('config-if', /^(?:GigabitEthernet|XGigabitEthernet|10GE|25GE|40GE|100GE|Ethernet|Eth-Trunk|Vlanif|LoopBack|Tunnel|MEth|NULL)/i, 'Interface view'),
      sub('config-vlan', /^vlan/i, 'VLAN view'),
      sub('config-router', /^(?:bgp|ospf|isis)/i, 'Routing protocol view'),
      sub('config-vrf', /^vpn-instance/i, 'VPN instance view')
    ],
    promptRegex: /^(?:<[\w.\-]+>|\[~?\*?[\w.\-]+(?:-[\w./:-]+)?\]) ?$/,
    pager: { pattern: /\s*---- More ----\s*$/, text: '  ---- More ----', disable: ['screen-length 0 temporary'], keys: { line: '\r', page: ' ', quit: 'q' } },
    errors: {
      invalid: /^Error: Unrecognized command found at '\^' position\./m,
      ambiguous: /^Error: Ambiguous command found at '\^' position\./m,
      incomplete: /^Error: Incomplete command found at '\^' position\./m,
      other: [/^Error: /m],
      caret: 'first-failing-char',
      samples: {
        invalid: "<HUAWEI> display intrface\n                ^\nError: Unrecognized command found at '^' position.",
        ambiguous: "<HUAWEI> dis i\n            ^\nError: Ambiguous command found at '^' position.",
        incomplete: "<HUAWEI> display ip\n                  ^\nError: Incomplete command found at '^' position."
      }
    },
    confirmPatterns: [/\[Y\/N\]:?\s*$/i, /\(y\/n\)\[[yn]\]:?\s*$/i, /\[Y\(yes\)\/N\(no\)\/C\(cancel\)\]:?\s*$/i],
    pipes: { filters: ['include', 'exclude', 'begin', 'count'], quoteAware: false, unknown: 'error' },
    execFromConfig: null,
    // `display`, `save` and other user-view commands run in every view [unverified]: classify a
    // system-view line against the user-view tree too (stricter either way).
    configInheritsExec: true,
    // `stelnet server enable`: the server setting, not the client.
    configShadowsExec: ['stelnet'],
    interfaces: {
      types: [
        { full: 'GigabitEthernet', short: ['GE'] },
        { full: 'XGigabitEthernet', short: ['XGE'] },
        { full: '10GE', short: [] },
        { full: '25GE', short: [] },
        { full: '40GE', short: [] },
        { full: '100GE', short: [] },
        { full: 'Eth-Trunk', short: ['Eth-T'] },
        { full: 'Vlanif', short: ['Vlanif'] },
        { full: 'LoopBack', short: ['Loop'] },
        { full: 'MEth', short: [] },
        { full: 'NULL', short: [] }
      ],
      numbering: /^\d+(?:\/\d+){0,3}(?:\.\d+)?$/,
      spaceBetween: false
    },
    live: {
      interfaces: { command: 'display interface brief', ttlSeconds: 120 },
      vlans: { command: 'display vlan', ttlSeconds: 120 },
      'bgp-neighbors': { command: 'display bgp peer', ttlSeconds: 120 },
      'ospf-neighbors': { command: 'display ospf peer brief', ttlSeconds: 120 }
    }
  }
  return { aoscx, vrp }
}
