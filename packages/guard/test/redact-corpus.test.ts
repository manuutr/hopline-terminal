import { describe, expect, it } from 'vitest'
import { redact } from '../src'

// The simulator is loaded at run time (vitest), not type-checked under the guard's tsconfig: its
// sources use `.ts` import paths, which only the simulator's own tsconfig allows.
type SimPlatform = string
interface SimDevice {
  bgp: { password?: string }[]
}
interface SimShell {
  start(): void
  idle(): Promise<void>
  input(s: string): void
}
interface SimModule {
  makeDevice(p: SimPlatform): SimDevice
  platforms(): SimPlatform[]
  Shell: new (d: SimDevice, io: { write(s: string): void; close(): void }, rows: number) => SimShell
}
const SIM_PATH = '../../simulator/src/index.ts'
const { makeDevice, platforms, Shell } = (await import(/* @vite-ignore */ SIM_PATH)) as SimModule

/**
 * H3 redaction corpus: the configuration every simulator platform prints, plus hand-written vendor
 * snippets (docs/research/cli-*.md) for secret forms the simulator does not render.
 *
 * Ground truth is the literal secret values the simulator seeds (copied from its source) or that
 * this test injects into the device state; it is never derived from the redactor's own patterns.
 */

/** Secrets the simulator's renderers print verbatim (packages/simulator/src/vendors/*). */
const SEEDED: Record<SimPlatform, string[]> = {
  ios: ['X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM', 'e7Hj5Rm2pZkT0vYc8NwL3fXa9uIq6sDgOyBhKnM1', 'n3tw0rkRO', 'pr1vRW', '104D000A0618'],
  nxos: ['$5$Hopline$sim'],
  iosxr: ['e7Hj5Rm2pZkT0vYc8NwL3fXa9uIq6sDgOyBhKnM1'],
  junos: ['$6$REDACTED'],
  c9800: ['XfVbM_ZEXOMbOJfAVBMgfM'],
  aoscx: ['AQBapZ1vF4c7pQ1rUq8Hn2xK']
}

/** Injected into every BGP neighbor; the renderers that print neighbor passwords must not leak it. */
const BGP_SECRET = 'SimBgpS3cretQz'
const PRINTS_BGP_PASSWORD: SimPlatform[] = ['ios', 'nxos', 'iosxr', 'eos']

const CONFIG_COMMANDS: Record<SimPlatform, string[]> = {
  junos: ['show configuration', 'show configuration | display set'],
  panos: ['show config running'],
  fortios: ['show'],
  vrp: ['display current-configuration'],
  aireos: ['show run-config commands'],
  routeros: ['/export']
}

async function configOf(p: SimPlatform): Promise<string> {
  const d = makeDevice(p)
  for (const n of d.bgp) n.password = BGP_SECRET
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, 100000)
  sh.start()
  await sh.idle()
  let all = ''
  for (const c of CONFIG_COMMANDS[p] ?? ['show running-config']) {
    out = ''
    sh.input(c + '\r')
    await sh.idle()
    await new Promise((r) => setTimeout(r, 5))
    all += out.replace(/\r/g, '') + '\n'
  }
  return all
}

describe('redaction corpus: every simulator platform', () => {
  it.each(platforms())('%s running configuration', async (p) => {
    const raw = await configOf(p)
    expect(raw.length).toBeGreaterThan(300)
    const truth = [...(SEEDED[p] ?? []), ...(PRINTS_BGP_PASSWORD.includes(p) ? [BGP_SECRET] : [])]
    const red = redact(raw).text
    for (const s of truth) {
      // Non-vacuous: the secret really is in what the device printed.
      expect(raw, `${p} should print ${s}`).toContain(s)
      expect(red, `${p} leaked ${s}`).not.toContain(s)
    }
    // A neighbor password the platform does not print must not appear either way.
    expect(red).not.toContain(BGP_SECRET)
  })
})

/** Vendor config lines from docs/research for secret forms the simulator does not render. */
const SNIPPETS: Record<string, [string, string[]]> = {
  'fortios admin/vpn': [
    [
      'config system admin',
      '    edit "admin"',
      '        set password ENC SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa1JX0sBuKIo/3Xx4Q4vL5T9/M=',
      '    next',
      'end',
      'config vpn ipsec phase1-interface',
      '    edit "to-hq"',
      '        set psksecret ENC LMPzM2tmFkVAZyJ6oFR0aR+Iqg==',
      '    next',
      'end',
      'config user local',
      '    edit "bob"',
      '        set passwd ENC Myjw9D8sUv5n8M3bvXKVMrq',
      '    next',
      'end',
      'config system api-user',
      '    edit "auto"',
      '        set api-key ENC SH2zzApiKeyBase64Value==',
      '    next',
      'end'
    ].join('\n'),
    ['SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa1JX0sBuKIo', 'LMPzM2tmFkVAZyJ6oFR0aR', 'Myjw9D8sUv5n8M3bvXKVMrq', 'SH2zzApiKeyBase64Value']
  ],
  'vrp aaa/snmp': [
    [
      'aaa',
      ' local-user admin password irreversible-cipher $1c$O[4BTCx!+L$N[1YM;%0w<Ky)b7#pl5B!_SC>/~uz#{5~`^a!*;$',
      ' local-user ops password cipher %^%#Hk2!x9;Q{z#%^%#',
      '#',
      'snmp-agent community read cipher %^%#JvZ%Z!f1:7~eWR6p\\l4PLwbv,M_dlQ3$h*Z=fE|0%^%#',
      'snmp-agent usm-user v3 u1 authentication-mode sha cipher %^%#AuThK3y%^%#',
      'ike peer HQ',
      ' pre-shared-key cipher %^%#PsK!v4lue%^%#',
      'ntp-service authentication-keyid 1 authentication-mode md5 cipher %^%#NtPk3y%^%#'
    ].join('\n'),
    ['O[4BTCx', 'Hk2!x9', 'JvZ%Z!f1', 'AuThK3y', 'PsK!v4lue', 'NtPk3y']
  ],
  'panos': [
    [
      'set mgt-config users admin phash $5$abcdefgh$ZYXWVUTSRQ',
      'set network ike gateway gw1 authentication pre-shared-key key -AQ==abcdEFGHijkl=',
      'set shared server-profile snmptrap T1 version v2c server s1 community MyTrapComm'
    ].join('\n'),
    ['ZYXWVUTSRQ', 'abcdEFGHijkl']
  ],
  'aireos': [
    ['config radius auth add 1 10.0.0.1 1812 ascii RadSecret', 'config wlan security wpa akm psk set-key ascii Wl4nPassPhrase 2', 'config snmp community create MyRoComm'].join('\n'),
    ['RadSecret', 'Wl4nPassPhrase']
  ],
  'asa': [
    ['enable password 8Ry2YjIyt7RRXU24 encrypted', 'username admin password Hu8Jk7Gf encrypted privilege 15', 'tunnel-group 1.2.3.4 ipsec-attributes', ' ikev1 pre-shared-key Asa!Psk', ' ikev2 remote-authentication pre-shared-key AsaRemote9'].join('\n'),
    ['8Ry2YjIyt7RRXU24', 'Hu8Jk7Gf', 'Asa!Psk', 'AsaRemote9']
  ],
  'nxos': [
    ['snmp-server user admin network-admin auth md5 0x1a2b3c4d5e priv 0x9f8e7d6c5b localizedkey', 'snmp-server host 10.1.1.1 traps version 2c NxTrapComm', 'tacacs-server key 7 "N3xusTac"', 'feature tacacs+'].join('\n'),
    ['0x1a2b3c4d5e', '0x9f8e7d6c5b', 'NxTrapComm', 'N3xusTac']
  ],
  'junos': [
    ['set system radius-server 10.0.0.5 secret "$9$h0ZSyKvMLX7-dsY"', 'set protocols bgp group IBGP authentication-key "$9$Qq3/9tOBEyKvLx"', 'set security ike policy P pre-shared-key ascii-text "$9$aB1cD2eF3g"'].join('\n'),
    ['h0ZSyKvMLX7-dsY', 'Qq3/9tOBEyKvLx', 'aB1cD2eF3g']
  ],
  'aoscx': [
    ['snmpv3 user ops auth sha auth-pass ciphertext AQBapXyZ1234567890ab priv aes priv-pass ciphertext AQBapQwErTy0987654', 'radius-server host 10.0.0.9 key ciphertext AQBapRaDiUs11223344'].join('\n'),
    ['AQBapXyZ1234567890ab', 'AQBapQwErTy0987654', 'AQBapRaDiUs11223344']
  ],
  'ios wireless/ntp': [
    ['ntp authentication-key 1 md5 121A0C0411045D5679 7', 'snmp-server host 10.1.1.1 version 2c MyCommunity', 'dot11 ssid GUEST', ' wpa-psk ascii 0 GuestCleartext', 'license smart token abcdefTOKEN123'].join('\n'),
    ['121A0C0411045D5679', 'MyCommunity', 'GuestCleartext', 'abcdefTOKEN123']
  ]
}

describe('redaction corpus: vendor snippets', () => {
  it.each(Object.entries(SNIPPETS))('%s', (_name, [text, secrets]) => {
    const red = redact(text).text
    for (const s of secrets) expect(red).not.toContain(s)
  })
})
