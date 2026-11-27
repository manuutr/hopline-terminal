import { describe, expect, it } from 'vitest'
import { redact } from '../src'

const secretsGone = (input: string, ...secrets: string[]) => {
  const { text, count } = redact(input)
  for (const s of secrets) expect(text).not.toContain(s)
  expect(count).toBeGreaterThan(0)
  return text
}

// Phase 3 security review (H3): every one of these leaked the secret value before.
describe('redact: review H3 regressions (multi-token types, vendor ciphertext)', () => {
  const cases: [string, ...string[]][] = [
    ['ntp authentication-key 1 md5 121A0C0411045D5679 7', '121A0C0411045D5679'],
    ['    set password ENC SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa1JX0sBuKIo/3Xx4Q4vL5T9/M=', 'SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa1JX0sBuKIo'],
    ['    set psksecret ENC LMPzM2tmFkVAZyJ6oFR0aR+Iqg==', 'LMPzM2tmFkVAZyJ6oFR0aR'],
    ['    set passwd ENC Myjw9D8sUv5n8M3bvXKVMrq', 'Myjw9D8sUv5n8M3bvXKVMrq'],
    [' local-user admin password irreversible-cipher $1c$O[4BTCx!+L$N[1YM;%0w<Ky)b7#pl5B!_SC>/~uz#{5~`^a!*;$', 'O[4BTCx', 'N[1YM', '%0w<Ky)b7', 'pl5B!_SC', 'uz#{5~'],
    [' snmp-agent community read cipher %^%#JvZ%Z!f1:7~eWR6p\\l4PLwbv,M_dlQ3$h*Z=fE|0%^%#', 'JvZ%Z!f1', 'eWR6p', 'dlQ3$h'],
    [' snmp-agent community write simple Pl41nC0mm', 'Pl41nC0mm'],
    [' pre-shared-key cipher %^%#abcdef%^%#', 'abcdef'],
    [' password cipher %@%@Old#Style;Cipher%@%@', 'Old#Style', 'Cipher'],
    ['user admin group administrators password ciphertext AQBapaGL1SJTdq52XiE0GcZB', 'AQBapaGL1SJTdq52XiE0GcZB'],
    [' security wpa akm psk set-key ascii 0 MyWlanPassphrase', 'MyWlanPassphrase'],
    [' security wpa psk set-key ascii 8 Q[XfVbM_ZEXOMbOJfAVBMgfM', 'XfVbM_ZEXOMbOJfAVBMgfM'],
    [' security wpa psk set-key ascii 0 MyCleartextPSK', 'MyCleartextPSK'],
    ['username bob privilege 15 password 0 Cleartext123', 'Cleartext123'],
    ['snmp-server host 10.1.1.1 version 2c MyCommunity', 'MyCommunity'],
    ['snmp-server host 10.1.1.1 MyV1Community', 'MyV1Community'],
    ['snmp-server host 10.1.1.1 traps version 2c TrapComm udp-port 162', 'TrapComm'],
    ['snmp-server host 10.1.1.1 informs version 3 priv v3user', 'v3user'],
    ['set network ike gateway gw1 authentication pre-shared-key key -AQ==abcdEFGH', 'abcdEFGH'],
    ['tacacs-server host 1.1.1.1 key 0 tacsecret', 'tacsecret'],
    ['set system login user bob authentication encrypted-password "$6$abc$def"', '$abc$def'],
    ['radius server R1\n address ipv4 1.1.1.1\n key 7 0822455D0A16', '0822455D0A16'],
    ['snmp-server user u1 g1 v3 auth sha AuthPass123 priv aes 128 PrivPass123', 'AuthPass123', 'PrivPass123'],
    ['snmp-server user admin network-admin auth md5 0x1234abcd priv 0x5678ef01 localizedkey', '0x1234abcd', '0x5678ef01'],
    ['crypto isakmp key Sup3rS3cret address 0.0.0.0', 'Sup3rS3cret'],
    ['ip ospf message-digest-key 1 md5 7 0822455D0A16', '0822455D0A16'],
    [' set pre-shared-key "abc def"', 'abc def'],
    ['config radius auth add 1 10.0.0.1 1812 ascii RadSecret', 'RadSecret'],
    ['enable password level 15 Cleartext', 'Cleartext'],
    ['wpa-psk ascii 0 cleartext', 'cleartext'],
    ['neighbor 1.1.1.1 password Clear', 'Clear'],
    ['key chain K\n key 1\n  key-string 7 0822455D0A16', '0822455D0A16'],
    ['snmp-server community public RO', 'public'],
    ['ikev2 local-authentication pre-shared-key cisco123', 'cisco123'],
    ['pre-shared-key local 0 cisco123', 'cisco123'],
    ['username admin secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0', 'hx5rVt7rPNoS4wqbXKX7m0'],
    ['snmp-agent usm-user v3 u1 authentication-mode sha cipher %^%#xx%^%#', 'xx%^'],
    ['snmp-agent usm-user v3 u1 authentication-mode sha Pl4inAuthKey', 'Pl4inAuthKey'],
    ['set auth-password-ascii SECRET', 'SECRET'],
    ['license smart token abcdefTOKEN123', 'abcdefTOKEN123'],
    ['set apikey xyz', 'xyz'],
    ['set private-key ENC abc', 'ENC abc'],
    [' local-user admin password simple Hu4weiPlain', 'Hu4weiPlain'],
    ['    set key ENC 7Ky8WzM1xQ2r==', '7Ky8WzM1xQ2r'],
    ['authentication-key "$9$abc.DEF/ghi"; ## SECRET-DATA', 'abc.DEF/ghi']
  ]
  it.each(cases)('%s', (input, ...secrets) => {
    secretsGone(input, ...secrets)
  })

  it('keeps the keywords and type tokens readable', () => {
    expect(redact(' security wpa psk set-key ascii 8 Q[XfVbM_ZEXOMbOJfAVBMgfM').text).toBe(' security wpa psk set-key ascii 8 <redacted>')
    expect(redact('ntp authentication-key 1 md5 121A0C0411045D5679 7').text).toBe('ntp authentication-key 1 md5 <redacted> 7')
    expect(redact('    set password ENC SH2nlSm9QL9tapcHPX=').text).toBe('    set password ENC <redacted>')
    expect(redact('key chain K\n key 1\n  key-string 7 0822455D0A16').text).toBe('key chain K\n key 1\n  key-string 7 <redacted>')
    expect(redact('snmp-server host 10.1.1.1 version 2c MyCommunity').text).toBe('snmp-server host 10.1.1.1 version 2c <redacted>')
  })

  it('is idempotent on the new forms', () => {
    for (const [input] of cases) {
      const once = redact(input).text
      expect(redact(once).text).toBe(once)
    }
  })

  it('stays linear on long adversarial lines', () => {
    const lines = [
      'password '.repeat(12_000),
      'password 7 '.repeat(9_000),
      'set-key ascii 8 '.repeat(6_000),
      '%^%#'.repeat(25_000),
      '%^%#' + 'x'.repeat(100_000),
      '$1c$' + '$'.repeat(100_000),
      'ENC '.repeat(25_000),
      'snmp-server host 1.1.1.1 '.repeat(4_000),
      'snmp-server host 1.1.1.1 traps traps traps traps traps traps '.repeat(1_500),
      'config radius auth add 1 1.1.1.1 1 '.repeat(3_000),
      ' key '.repeat(20_000),
      'auth sha x priv '.repeat(6_000)
    ]
    for (const l of lines) {
      const t = performance.now()
      redact(l)
      redact(l.replace(/ /g, '\n'))
      expect(performance.now() - t).toBeLessThan(500)
    }
  })
})
