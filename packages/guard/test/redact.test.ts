import { describe, expect, it } from 'vitest'
import { redact, REDACTED } from '../src'

const secretsGone = (input: string, ...secrets: string[]) => {
  const { text, count } = redact(input)
  for (const s of secrets) expect(text).not.toContain(s)
  expect(count).toBeGreaterThan(0)
  return text
}

describe('redact: Cisco IOS / IOS-XE', () => {
  it('enable secret hash', () => {
    const t = secretsGone('enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0', 'hx5rVt7rPNoS4wqbXKX7m0')
    expect(t).toContain(`enable secret 5 ${REDACTED}`)
  })
  it('username secret type 9', () =>
    secretsGone('username admin privilege 15 secret 9 $9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM', 'X.HsgL6x1il0'))
  it('type 7 passwords', () => secretsGone('username bob password 7 0822455D0A16', '0822455D0A16'))
  it('BGP neighbor password', () => secretsGone(' neighbor 10.0.0.2 password 7 13061E010803', '13061E010803'))
  it('SNMP community', () => {
    const t = secretsGone('snmp-server community s3cr3tRO RO\nsnmp-server community pr1v RW 10', 's3cr3tRO', 'pr1v')
    expect(t).toContain('RO')
  })
  it('SNMPv3 auth and priv keys', () =>
    secretsGone('snmp-server user u1 grp v3 auth sha AuthPass123 priv aes 128 PrivPass456', 'AuthPass123', 'PrivPass456'))
  it('TACACS server key block', () => secretsGone('tacacs server T1\n address ipv4 10.1.1.1\n key 7 104D000A0618', '104D000A0618'))
  it('legacy tacacs-server key', () => secretsGone('tacacs-server key MyTacKey', 'MyTacKey'))
  it('radius-server key', () => secretsGone('radius-server key 7 02050D480809', '02050D480809'))
  it('key chain key-string', () => {
    const t = secretsGone('key chain OSPF\n key 1\n  key-string 7 070C285F4D06', '070C285F4D06')
    expect(t).toContain('key chain OSPF')
  })
  it('OSPF message-digest-key', () =>
    secretsGone(' ip ospf message-digest-key 1 md5 7 0822455D0A16', '0822455D0A16'))
  it('ISAKMP pre-shared key', () => secretsGone('crypto isakmp key VpnKey!23 address 203.0.113.1', 'VpnKey!23'))
  it('PEM private key', () =>
    secretsGone('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA'))
})

describe('redact: Arista EOS', () => {
  it('sha512 secret', () =>
    secretsGone('username admin privilege 15 role network-admin secret sha512 $6$abc$DEFghiJKL', 'DEFghiJKL'))
})

describe('redact: Juniper Junos', () => {
  it('encrypted-password', () =>
    secretsGone('        encrypted-password "$6$Ab$Cd.Ef/Gh"; ## SECRET-DATA', 'Cd.Ef/Gh'))
  it('authentication-key', () => secretsGone('authentication-key "$9$abcDEF123"; ## SECRET-DATA', 'abcDEF123'))
  it('pre-shared-key ascii-text', () => secretsGone('pre-shared-key ascii-text "$9$zzzYYY"; ## SECRET-DATA', 'zzzYYY'))
  it('set-style SNMP community', () => secretsGone('set snmp community p4ssC0mm authorization read-only', 'p4ssC0mm'))
  it('hierarchical SNMP community', () => secretsGone('snmp {\n    community p4ssC0mm {\n', 'p4ssC0mm'))
})

describe('redact: leaves troubleshooting output intact', () => {
  it.each([
    'Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n10.0.0.2        4 65002       0       0        1    0    0 never    Idle',
    'GigabitEthernet0/1     10.0.0.1        YES manual up                    up',
    '  Community: 65000:100 65000:200',
    'Vlan  Mac Address       Type        Ports\n  10  aabb.cc00.0110    DYNAMIC     Gi0/2'
  ])('%#', (input) => {
    const r = redact(input)
    expect(r.text).toBe(input)
    expect(r.count).toBe(0)
  })
})

describe('redact: idempotent and type-preserving', () => {
  it('keeps the encryption type on TACACS key lines and counts each secret once', () => {
    const r = redact('tacacs server T1\n key 7 104D000A0618')
    expect(r.text).toContain(' key 7 <redacted>')
    expect(r.count).toBe(1)
  })
  it('redacting twice changes nothing', () => {
    const once = redact('enable secret 9 $9$abc\n key 7 0822\nsnmp-server community x RO').text
    expect(redact(once).text).toBe(once)
  })
})
