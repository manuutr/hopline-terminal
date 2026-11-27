import { FP_CISCO } from './fingerprints'
import type { ModeDef, PlatformProfile } from './types'

/**
 * Profiles for the Cisco platforms beyond IOS/IOS-XE/NX-OS. Each starts from the IOS-XE
 * profile (`base`) and overrides what differs. Sources: docs/research/cli-cisco-*.md.
 */

const sub = (id: ModeDef['id'], match: RegExp, description: string): ModeDef => ({ id, level: 'sub-config', description, match, fallback: ['config'] })

const withoutLineClear = ({ lineClear: _, ...keys }: PlatformProfile['keys']): PlatformProfile['keys'] => keys

export function ciscoProfiles(base: PlatformProfile): Pick<Record<string, PlatformProfile>, 'iosxr' | 'asa' | 'c9800' | 'aireos' | 'ciscosb' | 'ftd'> {
  const iosxr: PlatformProfile = {
    ...base,
    id: 'iosxr',
    label: 'Cisco IOS-XR',
    fingerprint: FP_CISCO.iosxr,
    modes: [
      { id: 'exec', level: 'exec', description: 'EXEC (RP/0/RP0/CPU0:host#)' },
      { id: 'config', level: 'config', description: 'Global configuration (target configuration; changes apply on commit)' },
      sub('config-if', /^config-(?:if|subif)/, 'Interface configuration'),
      sub('config-router', /^config-(?:bgp|ospf|isis|router|static|rpl|pim|igmp)/, 'Routing protocol configuration'),
      sub('config-vrf', /^config-vrf/, 'VRF configuration'),
      sub('config-acl', /^config-(?:ipv4|ipv6)-acl/, 'Access-list configuration')
    ],
    promptRegex: /^(?:RP|LC)\/\d+\/[\w]+\/CPU\d+:[\w.\-]+(?:\([\w.\-/: ]+\))?# ?$/,
    confirmPatterns: [...base.confirmPatterns, /Uncommitted changes found, commit them before exiting\(yes\/no\/cancel\)\?\s*\[cancel\]:\s*$/i],
    pipes: {
      filters: ['include', 'exclude', 'begin', 'utility', 'file'],
      quoteAware: false,
      unknown: 'error'
    },
    quotes: false,
    interfaces: {
      ...base.interfaces,
      types: [
        { full: 'GigabitEthernet', short: ['Gi'] },
        { full: 'TenGigE', short: ['Te'] },
        { full: 'TwentyFiveGigE', short: ['TF'] },
        { full: 'FortyGigE', short: ['Fo'] },
        { full: 'HundredGigE', short: ['Hu'] },
        { full: 'FourHundredGigE', short: ['FH'] },
        { full: 'Bundle-Ether', short: ['BE'] },
        { full: 'Loopback', short: ['Lo'] },
        { full: 'MgmtEth', short: ['Mg'] },
        { full: 'BVI', short: ['BV'] },
        { full: 'tunnel-te', short: ['tt'] },
        { full: 'Null', short: ['Nu'] }
      ],
      numbering: /^\d+(?:\/\d+){0,4}(?:\.\d+)?$/
    },
    live: {
      interfaces: { command: 'show ipv4 interface brief', ttlSeconds: 120 },
      vrfs: { command: 'show vrf all', ttlSeconds: 300 },
      'bgp-neighbors': { command: 'show bgp summary', ttlSeconds: 120 },
      'ospf-neighbors': { command: 'show ospf neighbor', ttlSeconds: 120 }
    }
  }

  const asa: PlatformProfile = {
    ...base,
    id: 'asa',
    label: 'Cisco ASA',
    fingerprint: FP_CISCO.asa,
    modes: [
      { id: 'user', level: 'user', description: 'Unprivileged (>)', fallback: ['exec'] },
      { id: 'exec', level: 'exec', description: 'Privileged (#); multiple-context prompts are host/context#' },
      { id: 'config', level: 'config', description: 'Global configuration' },
      sub('config-if', /^config-(?:if|subif)/, 'Interface configuration'),
      sub('config-router', /^config-router/, 'Routing protocol configuration')
    ],
    pager: { pattern: /<--- More --->\s*$/, text: '<--- More --->', disable: ['terminal pager 0'], keys: { line: '\r', page: ' ', quit: 'q' } },
    errors: {
      ...base.errors,
      invalid: /^ERROR: % Invalid input detected at '\^' marker\./m,
      incomplete: /^ERROR: % Incomplete command/m,
      ambiguous: /^ERROR: % Ambiguous command/m,
      other: [/^ERROR: /m, /^%?\s*Command authorization failed/im],
      samples: {
        invalid: "asa1# show intrface\n          ^\nERROR: % Invalid input detected at '^' marker.",
        ambiguous: 'asa1# sh c\nERROR: % Ambiguous command:  "sh c"',
        incomplete: 'asa1# show route vrf\nERROR: % Incomplete command'
      }
    },
    // ASA runs privileged exec commands (reload, copy, delete, format, changeto) typed in config mode.
    configInheritsExec: true,
    // `ssh <net> <mask> <if>` / `telnet …` in config mode are management access lists.
    configShadowsExec: ['ssh', 'telnet'],
    pipes: {
      filters: ['include', 'exclude', 'begin', 'grep', 'redirect', 'append'],
      quoteAware: false,
      unknown: 'error',
      regexRest: ['include', 'exclude', 'begin', 'grep'],
      writers: ['redirect', 'append']
    },
    live: {
      interfaces: { command: 'show interface ip brief', ttlSeconds: 120 },
      acls: { command: 'show access-list', ttlSeconds: 300 }
    }
  }

  const c9800: PlatformProfile = {
    ...base,
    id: 'c9800',
    label: 'Cisco Catalyst 9800 WLC',
    fingerprint: FP_CISCO.c9800
  }

  const ciscosb: PlatformProfile = {
    ...base,
    // Ctrl-U erasing the line is unverified here: the executor checks the echo only.
    keys: withoutLineClear(base.keys),
    id: 'ciscosb',
    label: 'Cisco SG/CBS switch',
    fingerprint: FP_CISCO.ciscosb,
    pager: { pattern: /More: <space>,\s+Quit: q or CTRL\+Z, One line: <return>\s*$/, text: 'More: <space>,  Quit: q or CTRL+Z, One line: <return> ', disable: ['terminal datadump'], keys: { line: '\r', page: ' ', quit: 'q' } },
    errors: {
      ...base.errors,
      invalid: /^% Unrecognized command/m,
      other: [...base.errors.other, /^% bad parameter value/m, /^% missing mandatory parameter/m]
    }
  }

  const aireos: PlatformProfile = {
    ...base,
    // Ctrl-U erasing the line is unverified here: the executor checks the echo only.
    keys: withoutLineClear(base.keys),
    id: 'aireos',
    label: 'Cisco AireOS WLC',
    depth: 'read-only',
    promptStyle: 'aireos',
    fingerprint: FP_CISCO.aireos,
    probe: 'show sysinfo',
    modes: [
      { id: 'exec', level: 'exec', description: '(Cisco Controller) > — config commands apply at once' },
      { id: 'config', level: 'config', description: '(Cisco Controller) config>' }
    ],
    promptRegex: /^\([^)]+\) (?:config(?: [\w-]+)*)?> ?$/,
    pager: { pattern: /--More-- or \(q\)uit\s*$/, text: '--More-- or (q)uit', disable: ['config paging disable'], keys: { line: '\r', page: ' ', quit: 'q' } },
    errors: {
      // `Incorrect usage` in any wording (a missing argument as well as an unknown word).
      invalid: /^Incorrect usage\b/m,
      ambiguous: /^Ambiguous command/m,
      incomplete: /^Incomplete command/m,
      other: [/^Error:/m, /^Request failed/m, /^(?:Permission denied|Insufficient privilege)/im],
      caret: 'none',
      samples: {
        invalid: "(Cisco Controller) >show sysinf\n\nIncorrect usage. Use the '?' or <TAB> key to list commands.",
        ambiguous: '(Cisco Controller) >sh c\nAmbiguous command',
        incomplete: '(Cisco Controller) >show ap\nIncomplete command'
      }
    },
    confirmPatterns: [/\(y\/[nN]\)\s*\??\s*$/, /\(y\/n\)\s*\[[yn]\]\s*$/i],
    pipes: { filters: [], quoteAware: false, unknown: 'error' },
    execFromConfig: null,
    live: {}
  }

  const ftd: PlatformProfile = {
    ...base,
    // Ctrl-U erasing the line is unverified here: the executor checks the echo only.
    keys: withoutLineClear(base.keys),
    id: 'ftd',
    label: 'Cisco FTD',
    promptStyle: 'bare',
    fingerprint: FP_CISCO.ftd,
    depth: 'read-only',
    modes: [
      { id: 'exec', level: 'exec', description: 'Restricted CLI (>)' },
      { id: 'config', level: 'config', description: 'Not used: configure commands apply at once' }
    ],
    promptRegex: /^> ?$/,
    pager: { pattern: /--More--\s*$|<--- More --->\s*$/, text: '--More--', disable: [], keys: { line: '\r', page: ' ', quit: 'q' } },
    pipes: {
      filters: ['include', 'exclude', 'begin', 'grep'],
      quoteAware: false,
      unknown: 'error',
      regexRest: ['include', 'exclude', 'begin', 'grep'],
      writers: ['redirect', 'append']
    },
    execFromConfig: null,
    live: {}
  }

  return { iosxr, asa, c9800, aireos, ciscosb, ftd }
}
