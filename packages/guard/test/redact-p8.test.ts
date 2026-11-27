import { describe, expect, it } from 'vitest'
import { redact, REDACT_RULES, REDACTED } from '../src'

/**
 * Phase 8 security review, H1 / D-M1. Ground truth is the literal secret in each line (hand
 * labelled from the review's redaction-miss table and the fix list), never the redactor's own
 * patterns. Each row: [platform, input, secrets that must be gone, context that must survive].
 */
type Row = [platform: string, input: string, secrets: string[], keep: string[]]

/** The review's 65-row redaction-miss table (Appendix D), in order. `⏎` in the table is `\n` here. */
const MISS_TABLE: Row[] = [
  ['ios', 'tacacs-server host 10.1.1.2 key TacKey99', ['TacKey99'], ['tacacs-server host 10.1.1.2 key']],
  ['ios', 'radius-server host 10.1.1.3 auth-port 1812 acct-port 1813 key RadKey99', ['RadKey99'], ['10.1.1.3', 'acct-port 1813 key']],
  ['ios', '  pre-shared-key address 1.2.3.4 key PskAddr1', ['PskAddr1'], ['pre-shared-key address 1.2.3.4 key']],
  ['ios', ' standby 1 authentication HsrpTxt1', ['HsrpTxt1'], ['standby 1 authentication']],
  ['ios', ' vrrp 1 authentication text VrrpTxt1', ['VrrpTxt1'], ['vrrp 1 authentication text']],
  ['ios', ' ip nhrp authentication NhrpPw1', ['NhrpPw1'], ['ip nhrp authentication']],
  ['ios', 'archive\n path scp://user:ScpUrlPw1@10.0.0.9/cfg', ['ScpUrlPw1'], ['scp://user:', '@10.0.0.9/cfg']],
  ['ios', 'copy running-config ftp://admin:FtpUrl2@10.0.0.9/', ['FtpUrl2'], ['ftp://admin:', '@10.0.0.9/']],
  ['ios', 'key config-key password-encrypt MasterK1', ['MasterK1'], ['key config-key password-encrypt']],
  ['ios', ' glbp 1 authentication text GlbpPw1', ['GlbpPw1'], ['glbp 1 authentication text']],
  ['ios', ' authentication text RipPw1', ['RipPw1'], ['authentication text']],
  ['junos', 'set system login user ops authentication plain-text-password-value JunPlainV', ['JunPlainV'], ['user ops authentication']],
  ['junos', 'set wlan ... wpa-personal key ascii-text JunWifi1', ['JunWifi1'], ['wpa-personal key ascii-text']],
  ['eos', '   vrrp 1 authentication text EosVrrp', ['EosVrrp'], ['vrrp 1 authentication text']],
  ['panos', 'set mgt-config users admin phash fnRL/G5lXVMug', ['fnRL/G5lXVMug'], ['users admin phash']],
  ['panos', '<bind-password>PanXmlBindPlain</bind-password>', ['PanXmlBindPlain'], ['<bind-password>', '</bind-password>']],
  ['panos', 'admin@fw> request license api-key set key PanApiKey12345', ['PanApiKey12345'], ['admin@fw> request license api-key set key']],
  ['fortios', '    set key FortiTacPlain', ['FortiTacPlain'], ['set key']],
  ['fortios', '    set priv-pwd FortiSnmpPriv', ['FortiSnmpPriv'], ['set priv-pwd']],
  ['fortios', '    set md5-keys 1 FortiMd5k', ['FortiMd5k'], ['set md5-keys 1']],
  ['asa', 'snmp-server host inside 10.1.1.1 community AsaComm version 2c', ['AsaComm'], ['snmp-server host inside 10.1.1.1 community', 'version 2c']],
  ['asa', 'failover key AsaFoKey1', ['AsaFoKey1'], ['failover key']],
  ['asa', 'failover key hex 0x12345678abcd', ['12345678abcd'], ['failover key hex']],
  ['aoscx', 'radius-server host 10.1.1.1 key plaintext CxRadPlain', ['CxRadPlain'], ['10.1.1.1 key plaintext']],
  ['aoscx', 'tacacs-server host 10.1.1.1 key plaintext CxTacPlain', ['CxTacPlain'], ['10.1.1.1 key plaintext']],
  ['vrp', ' hwtacacs-server shared-key VrpTacPlain', ['VrpTacPlain'], ['hwtacacs-server shared-key']],
  ['vrp', ' radius-server shared-key cipher VrpRadC', ['VrpRadC'], ['radius-server shared-key cipher']],
  ['generic', 'Password: hunter2', ['hunter2'], ['Password:']],
  ['generic', 'export ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ['AAAAAAAAAAAAAAAA', 'sk-ant-api03'], ['export ANTHROPIC_API_KEY=']],
  ['generic', 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk" https://x', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abcdefghijk'], ['Authorization: Bearer', 'https://x']],
  ['generic', 'curl -u admin:CurlPw1 https://10.0.0.1/api', ['CurlPw1'], ['curl -u admin:', 'https://10.0.0.1/api']],
  ['generic', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI', 'bPxRfiCYEXAMPLEKEY'], ['aws_secret_access_key =']],
  ['generic', 'AKIAIOSFODNN7EXAMPLE', ['AKIAIOSFODNN7EXAMPLE'], []],
  ['generic', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ['aaaaaaaaaaaaaaaaaaaa'], []],
  ['generic', 'netbox token = 0123456789abcdef0123456789abcdef01234567', ['0123456789abcdef0123456789abcdef01234567'], ['netbox token =']],
  ['generic', 'x-api-key: sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', ['BBBBBBBBBBBBBBBB'], ['x-api-key:']],
  ['generic', 'PASSWORD=EnvPw1', ['EnvPw1'], ['PASSWORD=']],
  ['generic', 'password=EqPw1', ['EqPw1'], ['password=']],
  ['generic', 'password: "ColonPw1"', ['ColonPw1'], ['password:']],
  ['generic', '"password":"JsonPw1"', ['JsonPw1'], ['"password":']],
  ['generic', 'secret:YamlSec1', ['YamlSec1'], ['secret:']],
  ['mikrotik', '/user add name=admin password=MtPw1 group=full', ['MtPw1'], ['name=admin', 'group=full']],
  ['mikrotik', '/interface wireless security-profiles set default wpa2-pre-shared-key=MtWifi1', ['MtWifi1'], ['security-profiles set default wpa2-pre-shared-key=']],
  ['mikrotik', '/ip ipsec peer add secret=MtIpsec1', ['MtIpsec1'], ['/ip ipsec peer add secret=']],
  ['aireos', 'config mgmtuser add admin AireMgmtPw read-write', ['AireMgmtPw'], ['config mgmtuser add admin', 'read-write']],
  ['aireos', 'config snmp community create AireComm', ['AireComm'], ['config snmp community create']],
  ['linux', 'mysql -u root -pMyPw1', ['MyPw1'], ['mysql -u root -p']],
  ['linux', 'sshpass -p SshpassPw ssh admin@1.1.1.1', ['SshpassPw'], ['sshpass -p', 'ssh admin@1.1.1.1']],
  ['ios', 'crypto keyring KR\n  pre-shared-key address 203.0.113.5 key Kr1ngPsk', ['Kr1ngPsk'], ['crypto keyring KR', 'address 203.0.113.5 key']],
  ['ios', '  pre-shared-key address 0.0.0.0 0.0.0.0 key Kr2ngPsk', ['Kr2ngPsk'], ['address 0.0.0.0 0.0.0.0 key']],
  ['ios', '  pre-shared-key hostname peer.example.com key Kr3ngPsk', ['Kr3ngPsk'], ['hostname peer.example.com key']],
  ['ios', 'tacacs-server host 10.1.1.2 single-connection key TacKeySc', ['TacKeySc'], ['10.1.1.2 single-connection key']],
  ['ios', 'archive\n path ftp://bkp:ArchPw@10.0.0.9/$h', ['ArchPw'], ['ftp://bkp:', '@10.0.0.9/$h']],
  ['procurve', 'password manager user-name admin plaintext PcMgr1', ['PcMgr1'], ['password manager user-name admin plaintext']],
  ['procurve', 'password manager user-name "admin" sha1 "4f4cfa1a0e3cb16b6bd0f6a7c1bd8a7f4c1b2c3d"', ['4f4cfa1a0e3cb16b6bd0f6a7c1bd8a7f4c1b2c3d'], ['user-name "admin" sha1']],
  ['procurve', 'radius-server host 10.1.1.1 key "PcRad1"', ['PcRad1'], ['radius-server host 10.1.1.1 key']],
  ['vyos', "set service snmp community 'VyComm' authorization ro", ['VyComm'], ['set service snmp community', 'authorization ro']],
  [
    'routeros',
    '/interface wireless security-profiles\nset [ find default=yes ] authentication-types=wpa2-psk mode=dynamic-keys supplicant-identity=MikroTik wpa2-pre-shared-key=RosWifi1',
    ['RosWifi1'],
    ['authentication-types=wpa2-psk mode=dynamic-keys supplicant-identity=MikroTik']
  ],
  ['routeros', '/ppp secret\nadd name=vpnuser password=RosPpp1 profile=default', ['RosPpp1'], ['/ppp secret\nadd name=vpnuser', 'profile=default']],
  ['routeros', '/ip ipsec identity\nadd peer=p1 secret=RosIpsec1', ['RosIpsec1'], ['add peer=p1']],
  ['routeros', '/radius\nadd address=10.0.0.1 secret=RosRad1 service=login', ['RosRad1'], ['address=10.0.0.1', 'service=login']],
  ['routeros', '/snmp community\nset [ find default=yes ] name=RosComm', ['RosComm'], ['/snmp community\nset [ find default=yes ] name=']],
  ['routeros', '/interface wifi security\nadd name=sec1 passphrase=RosWifi7', ['RosWifi7'], ['add name=sec1']],
  ['xr', 'key chain K\n key 1\n  key-string password 0822455D0A16', ['0822455D0A16'], ['key chain K\n key 1\n  key-string password']],
  ['junos', 'set system archival configuration archive-sites "scp://bkp:JunUrlPw@10.0.0.9/cfg"', ['JunUrlPw'], ['scp://bkp:', '@10.0.0.9/cfg']]
]

/** The fix list (lead's brief): forms beyond the table, some of which already passed. */
const FIX_LIST: Row[] = [
  // keyring and AAA servers
  ['ios', '  pre-shared-key address 10.0.0.1 key 0 KrTyped0', ['KrTyped0'], ['address 10.0.0.1 key 0']],
  ['ios', '  pre-shared-key address ipv6 2001:db8::1/128 key Kr6Psk', ['Kr6Psk'], ['2001:db8::1/128']],
  ['ios', 'tacacs-server host 10.1.1.2 port 49 timeout 5 key 7 0822455D0A16', ['0822455D0A16'], ['port 49 timeout 5 key 7']],
  ['nxos', 'radius-server host 10.1.1.9 key 7 "NxRadKey" authentication accounting', ['NxRadKey'], ['10.1.1.9 key 7', 'authentication accounting']],
  ['eos', 'tacacs-server host 10.1.1.4 vrf MGMT key 7 070C285F4D06', ['070C285F4D06'], ['vrf MGMT key 7']],
  ['procurve', 'tacacs-server host 10.1.1.1 key "PcTac1"', ['PcTac1'], ['10.1.1.1 key']],
  // FHRP, NHRP, RIP, routing protocol auth
  ['ios', ' standby 10 authentication text HsrpT10', ['HsrpT10'], ['standby 10 authentication text']],
  ['ios', ' standby 1 authentication md5 key-string 7 104D000A0618', ['104D000A0618'], ['authentication md5 key-string 7']],
  ['nxos', ' vrrp 2\n  authentication text NxVrrp2', ['NxVrrp2'], ['authentication text']],
  ['eos', '   vrrp 1 peer authentication text EosPeer1', ['EosPeer1'], ['peer authentication text']],
  ['ios', ' ip rip authentication mode text', [], ['ip rip authentication mode text']],
  ['ios', ' ip ospf authentication-key OspfKey1', ['OspfKey1'], ['ip ospf authentication-key']],
  ['ios', ' ip ospf message-digest-key 1 md5 OspfMd5', ['OspfMd5'], ['message-digest-key 1 md5']],
  ['ios', ' ipv6 ospf authentication ipsec spi 256 md5 0123456789ABCDEF0123456789ABCDEF', ['0123456789ABCDEF0123456789ABCDEF'], ['ipsec spi 256 md5']],
  ['ios', ' neighbor 10.0.0.2 password BgpPlain1', ['BgpPlain1'], ['neighbor 10.0.0.2 password']],
  ['ios', ' area-password IsisArea1', ['IsisArea1'], ['area-password']],
  ['ios', ' domain-password IsisDom1', ['IsisDom1'], ['domain-password']],
  ['ios', ' isis password IsisIf1 level-1', ['IsisIf1'], ['isis password', 'level-1']],
  // URL userinfo
  ['ios', 'copy tftp://u:TftpPw1@10.0.0.9/f flash:', ['TftpPw1'], ['tftp://u:', '@10.0.0.9/f flash:']],
  ['linux', 'sftp://ops:SftpPw1@files.example.com/x', ['SftpPw1'], ['sftp://ops:', '@files.example.com/x']],
  ['generic', 'https://api:HttpsPw1@netbox.example.com/api/', ['HttpsPw1'], ['https://api:', '@netbox.example.com/api/']],
  ['generic', 'http://u:HttpPw1@10.0.0.5:8080/', ['HttpPw1'], ['http://u:', '@10.0.0.5:8080/']],
  // VTP
  ['ios', 'VTP Password: VtpPw77', ['VtpPw77'], ['VTP Password:']],
  ['ios', 'vtp password VtpCfg1', ['VtpCfg1'], ['vtp password']],
  // SNMP
  ['ios', 'snmp-server community N3wC0mm RO 10', ['N3wC0mm'], ['snmp-server community', 'RO 10']],
  ['nxos', 'snmp-server community NxComm group network-operator', ['NxComm'], ['group network-operator']],
  ['eos', 'snmp-server community EosComm ro', ['EosComm'], ['snmp-server community']],
  ['ios', 'snmp-server user u1 G1 v3 auth sha AuthPw1 priv aes 256 PrivPw1', ['AuthPw1', 'PrivPw1'], ['snmp-server user u1 G1 v3 auth sha', 'priv aes 256']],
  ['nxos', 'snmp-server user ops network-admin auth sha NxAuth1 priv aes-128 NxPriv1', ['NxAuth1', 'NxPriv1'], ['snmp-server user ops network-admin auth sha']],
  ['eos', 'snmp-server user ops G v3 auth sha512 EosAuth1 priv aes256 EosPriv1', ['EosAuth1', 'EosPriv1'], ['snmp-server user ops G v3 auth sha512']],
  ['asa', 'snmp-server host inside 10.1.1.1 version 3 AsaV3User', ['AsaV3User'], ['snmp-server host inside 10.1.1.1 version 3']],
  ['eos', 'snmp-server host 10.1.1.1 vrf MGMT version 2c EosTrap1', ['EosTrap1'], ['snmp-server host 10.1.1.1 vrf MGMT version 2c']],
  ['vyos', 'set service snmp community "VyComm2" authorization rw', ['VyComm2'], ['authorization rw']],
  ['aireos', 'config snmp v3user create ops rw hmacsha aescfb128 AireAuthK AirePrivK', ['AireAuthK', 'AirePrivK'], ['config snmp v3user create ops rw hmacsha aescfb128']],
  // enable, key chains, wireless
  ['ios', 'enable secret Cleartext9', ['Cleartext9'], ['enable secret']],
  ['ios', 'enable secret 9 $9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM', ['X.HsgL6x1il0', 'nhEmQVczB7dqsO'], ['enable secret 9']],
  ['ios', 'enable password 7 0822455D0A16', ['0822455D0A16'], ['enable password 7']],
  ['ios', 'enable password level 15 EnLvl15', ['EnLvl15'], ['enable password level 15']],
  ['ios', 'enable algorithm-type scrypt secret EnScrypt1', ['EnScrypt1'], ['enable algorithm-type scrypt secret']],
  ['asa', 'enable password 8Ry2YjIyt7RRXU24 encrypted', ['8Ry2YjIyt7RRXU24'], ['enable password']],
  ['ios', 'key chain K\n key 1\n  key-string Plain1', ['Plain1'], ['key chain K\n key 1\n  key-string']],
  ['xr', 'key chain K\n key 1\n  key-string clear XrClear1', ['XrClear1'], ['key-string clear']],
  ['ios', ' wpa-psk ascii 0 WlanPsk1', ['WlanPsk1'], ['wpa-psk ascii 0']],
  // Junos
  ['junos', 'set system root-authentication encrypted-password "$6$abcdefgh$JunRootHash"', ['JunRootHash', 'abcdefgh'], ['set system root-authentication encrypted-password']],
  ['junos', 'set system login user ops authentication encrypted-password "$1$Ab$JunMd5Hash"', ['JunMd5Hash'], ['user ops authentication encrypted-password']],
  ['junos', 'set protocols ospf area 0 interface ge-0/0/0.0 authentication md5 1 key "$9$JunOspfKey"', ['JunOspfKey'], ['interface ge-0/0/0.0 authentication md5 1 key']],
  ['junos', 'set protocols bgp group IBGP authentication-key "$9$JunBgpKey"', ['JunBgpKey'], ['set protocols bgp group IBGP authentication-key']],
  ['junos', 'authentication-key PlainJunKey;', ['PlainJunKey'], ['authentication-key']],
  // FortiOS
  ['fortios', '        set password ENC SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa1JX0sBuKIo', ['SH2nlSm9QL9tapcHPXIqAXvX7vBJuuqu22hpa1JX0sBuKIo'], ['set password ENC']],
  ['fortios', '        set psksecret FortiPskPlain', ['FortiPskPlain'], ['set psksecret']],
  ['fortios', '        set psksecret ENC LMPzM2tmFkVAZyJ6oFR0aR+Iqg==', ['LMPzM2tmFkVAZyJ6oFR0aR'], ['set psksecret ENC']],
  ['fortios', '        set key ENC 7Ky8WzM1xQ2r==', ['7Ky8WzM1xQ2r'], ['set key ENC']],
  ['fortios', '        set auth-pwd FortiSnmpAuth', ['FortiSnmpAuth'], ['set auth-pwd']],
  ['fortios', '        set md5-key FortiMd5One', ['FortiMd5One'], ['set md5-key']],
  // PAN-OS
  ['panos', 'set mgt-config users admin phash $1$abcdefgh$PanMd5Hash', ['PanMd5Hash'], ['users admin phash']],
  ['panos', '<phash>fnRL/G5lXVMug</phash>', ['fnRL/G5lXVMug'], ['<phash>', '</phash>']],
  ['panos', 'request license api-key set key PanApi2', ['PanApi2'], ['request license api-key set key']],
  // ASA, VRP, IOS master key, AireOS
  ['asa', 'failover key 0 AsaFoKey0', ['AsaFoKey0'], ['failover key 0']],
  ['asa', 'failover ipsec pre-shared-key AsaFoPsk', ['AsaFoPsk'], ['failover ipsec pre-shared-key']],
  ['vrp', ' hwtacacs-server shared-key cipher %^%#VrpCipherTac%^%#', ['VrpCipherTac'], ['hwtacacs-server shared-key cipher']],
  ['ios', 'key config-key password-encrypt 7 0822455D0A16', ['0822455D0A16'], ['key config-key password-encrypt']],
  ['aireos', 'config netuser add guest GuestPw1 wlan 1 userType guest lifetime 86400', ['GuestPw1'], ['config netuser add guest', 'wlan 1']],
  ['aireos', 'config mgmtuser password admin AireNewPw', ['AireNewPw'], ['config mgmtuser password admin']],
  // RouterOS
  ['routeros', '/system identity set name=core-rtr1', [], ['/system identity set name=core-rtr1']],
  ['routeros', '/snmp community add name=RosCommAdd addresses=10.0.0.0/8', ['RosCommAdd'], ['addresses=10.0.0.0/8']],
  ['routeros', '/SNMP COMMUNITY\nadd NaMe="example community"\n/interface\nset NAME=loopback', ['example community'], ['NaMe=<redacted>', 'NAME=loopback']],
  ['routeros', '/snmp community\nadd name=RosComm2\n/ip address\nadd address=10.0.0.1/24 interface=ether1 name=keepme', ['RosComm2'], ['name=keepme', 'interface=ether1']],
  ['routeros', '/interface wireless security-profiles add name=p1 wpa-pre-shared-key=RosWpa1', ['RosWpa1'], ['name=p1']],
  // generic and Linux
  ['generic', 'api_key: GenApi1', ['GenApi1'], ['api_key:']],
  ['generic', '{"username":"ops","password":"JsonPw2","host":"10.0.0.1"}', ['JsonPw2'], ['"username":"ops"', '"host":"10.0.0.1"']],
  ['generic', 'Authorization: Basic YWRtaW46aHVudGVyMg==', ['YWRtaW46aHVudGVyMg'], ['Authorization: Basic']],
  ['generic', 'Authorization: Token 0123456789abcdef0123456789abcdef', ['0123456789abcdef0123456789abcdef'], ['Authorization: Token']],
  ['generic', 'curl -H "x-api-key: plainApiKey99" https://api.example.com', ['plainApiKey99'], ['https://api.example.com']],
  ['generic', 'curl -s -k --user admin:CurlPw2 https://10.0.0.1/', ['CurlPw2'], ['--user admin:', 'https://10.0.0.1/']],
  ['linux', 'mysqldump -h 10.0.0.5 -u backup -pDumpPw1 inventory', ['DumpPw1'], ['-h 10.0.0.5 -u backup -p', 'inventory']],
  ['linux', 'sshpass -pAttachedPw ssh admin@10.0.0.1', ['AttachedPw'], ['ssh admin@10.0.0.1']],
  ['generic', 'ANTHROPIC_API_KEY=sk-ant-api03-zZ9_xY8-wV7uT6sR5qP4oN3mL2kJ1iH0gF', ['zZ9_xY8-wV7uT6sR5qP4oN3mL2kJ1iH0gF'], ['ANTHROPIC_API_KEY=']],
  ['generic', 'access key id AKIAIOSFODNN7EXAMPLE in use', ['AKIAIOSFODNN7EXAMPLE'], ['access key id', 'in use']],
  ['generic', 'token ghp_0123456789abcdefghijABCDEFGHIJ012345', ['ghp_0123456789abcdefghij'], []]
]

/** Lines that hold no secret: the redactor must leave them byte-identical and count nothing. */
const CLEAN: string[] = [
  '  Community: 65000:100 65000:200',
  'aaa authentication login default group tacacs+ local',
  ' ip ospf authentication message-digest',
  ' ip rip authentication key-chain RIPKEYS',
  ' standby 1 authentication md5 key-chain HSRP-KC',
  'crypto isakmp policy 10\n authentication pre-share',
  'service password-encryption',
  'GigabitEthernet0/1     10.0.0.1        YES manual up                    up',
  '/system identity set name=core-rtr1',
  'cp -pr /a /b',
  'docker ps',
  'interface ge-0/0/0\n description "uplink to core: 10.0.0.1"'
]

const leaks = (out: string, secrets: string[]) => secrets.filter((s) => out.includes(s))

describe('H1 / D-M1: the review\'s 65-row redaction-miss table', () => {
  it('has all 65 rows', () => expect(MISS_TABLE).toHaveLength(65))
  it.each(MISS_TABLE.map((r, i) => [i + 1, ...r] as const))('row %i (%s): %j', (_n, _p, input, secrets, keep) => {
    for (const s of secrets) expect(input, 'non-vacuous').toContain(s)
    const r = redact(input)
    expect(leaks(r.text, secrets)).toEqual([])
    for (const k of keep) expect(r.text).toContain(k)
    expect(r.count).toBeGreaterThan(0)
    expect(r.text).toContain(REDACTED)
  })
})

describe('H1 / D-M1: the fix list', () => {
  it.each(FIX_LIST)('%s: %j', (_p, input, secrets, keep) => {
    for (const s of secrets) expect(input, 'non-vacuous').toContain(s)
    const r = redact(input)
    expect(leaks(r.text, secrets)).toEqual([])
    for (const k of keep) expect(r.text).toContain(k)
    if (secrets.length) expect(r.count).toBeGreaterThan(0)
  })
})

describe('H1 / D-M1: no secret, no change', () => {
  it.each(CLEAN)('%j', (input) => {
    const r = redact(input)
    expect(r.text).toBe(input)
    expect(r.count).toBe(0)
  })
})

describe('H1 / D-M1: the qualifier word is never what gets redacted', () => {
  it.each([
    ['  pre-shared-key address 203.0.113.5 key Kr1ngPsk', '  pre-shared-key address 203.0.113.5 key <redacted>'],
    ['  pre-shared-key hostname peer.example.com key Kr3ngPsk', '  pre-shared-key hostname peer.example.com key <redacted>'],
    ['password manager user-name admin plaintext PcMgr1', 'password manager user-name admin plaintext <redacted>'],
    ['admin@fw> request license api-key set key PanApiKey12345', 'admin@fw> request license api-key set key <redacted>'],
    ['snmp-server host inside 10.1.1.1 community AsaComm version 2c', 'snmp-server host inside 10.1.1.1 community <redacted> version 2c'],
    ['  key-string password 0822455D0A16', '  key-string password <redacted>'],
    ['/ppp secret\nadd name=vpnuser password=RosPpp1 profile=default', '/ppp secret\nadd name=vpnuser password=<redacted> profile=default']
  ])('%j', (input, want) => {
    const r = redact(input)
    expect(r.text).toBe(want)
    expect(r.count).toBe(1)
  })
  it('a keyword followed only by a qualifier word redacts nothing and counts nothing', () => {
    for (const input of ['pre-shared-key address 1.2.3.4', 'password manager', 'secret set']) {
      const r = redact(input)
      expect(r).toEqual({ text: input, count: 0 })
    }
  })
})

describe('H1 / D-M1: ruleset properties', () => {
  it('every rule has an id, a description and a matcher; ids are unique', () => {
    const ids = REDACT_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of REDACT_RULES) {
      expect(r.description.length).toBeGreaterThan(10)
      expect(!!r.re !== !!r.apply).toBe(true)
      if (r.re) expect(r.re.global).toBe(true)
    }
  })
  it('is idempotent and counts nothing the second time', () => {
    for (const [, input] of [...MISS_TABLE, ...FIX_LIST]) {
      const once = redact(input).text
      expect(redact(once)).toEqual({ text: once, count: 0 })
    }
  })
  it('the whole corpus as one text loses every secret too', () => {
    const rows = [...MISS_TABLE, ...FIX_LIST]
    const out = redact(rows.map((r) => r[1]).join('\n')).text
    expect(leaks(out, rows.flatMap((r) => r[2]))).toEqual([])
  })
})

describe('H1 / D-M1: linear on adversarial input', () => {
  const MB = 1024 * 1024
  const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB)
  const units = [
    'tacacs-server host x ',
    'radius-server host 1.1.1.1 key ',
    'pre-shared-key address 1.1.1.1 ',
    'standby 1 authentication ',
    'authentication text ',
    'snmp-server host inside 1.1.1.1 ',
    'snmp-server host 1.1.1.1 vrf a traps ',
    'curl -u ',
    'curl x ',
    'mysql mysql ',
    'sshpass -x ',
    'a://b:c',
    'x://',
    'password=',
    'password:"',
    'aws_secret_access_key_x_y',
    'Authorization: ',
    'Bearer ',
    'set key ',
    'config mgmtuser add ',
    'config snmp v3user create a b c d ',
    '/snmp community name=',
    'eyJaaaaaaaaa.',
    'sk-ant-',
    'password manager user-name ',
    'key-string password ',
    'a.a.a.a.',
    '%^%#',
    '-----BEGIN PRIVATE KEY-----\n',
    'auth sha x priv '
  ]
  it.each(units)('1 MB of %j redacts in well under a second', (unit) => {
    for (const text of [fill(unit), fill(unit.replace(/ /g, '\n'))]) {
      const t = performance.now()
      redact(text)
      expect(performance.now() - t).toBeLessThan(400)
    }
  })
})


it.each(['AQ.' + 'a_b-'.repeat(10), 'AIza' + 'A'.repeat(35), 'sk-proj-' + 'a_b-'.repeat(10)])(
  'redacts a complete cloud credential pasted without a label (%#)', key => {
    expect(redact('copy ' + key).text).toBe('copy ' + REDACTED)
  }
)
