import { describe, expect, it } from 'vitest'
import { scrubText } from '../src/main/crash/scrub'

/**
 * Phase 8 security review D-L7: the crash scrubber's gaps. `scrubText` runs the guard's shared
 * redaction ruleset (`redact()`) and then its own extras; each line below survived it before.
 * Every line is tried bare and embedded mid-message, the way an exception would quote it.
 */
const DL7: [string, string][] = [
  [' standby 1 authentication HsrpTxt1', 'HsrpTxt1'],
  [' vrrp 1 authentication text VrrpTxt1', 'VrrpTxt1'],
  [' glbp 1 authentication text GlbpPw1', 'GlbpPw1'],
  [' authentication text RipPw1', 'RipPw1'],
  [' ip nhrp authentication NhrpPw1', 'NhrpPw1'],
  ['failover key AsaFoKey1', 'AsaFoKey1'],
  ['failover key hex 0x12345678abcd', '12345678abcd'],
  ['    set key FortiTacPlain', 'FortiTacPlain'],
  ['    set md5-keys 1 FortiMd5k', 'FortiMd5k'],
  [' hwtacacs-server shared-key VrpTacPlain', 'VrpTacPlain'],
  ['set wlan ... wpa-personal key ascii-text JunWifi1', 'JunWifi1'],
  ['key config-key password-encrypt MasterK1', 'MasterK1'],
  ['set mgt-config users admin phash fnRL/G5lXVMug', 'fnRL/G5lXVMug'],
  ['config mgmtuser add admin AireMgmtPw read-write', 'AireMgmtPw'],
  ['curl -u admin:CurlPw1 https://10.0.0.1/api', 'CurlPw1'],
  ['mysql -u root -pMyPw1', 'MyPw1'],
  ['sshpass -p SshpassPw ssh admin@1.1.1.1', 'SshpassPw'],
  // The first lines of the multi-line table rows, and a few more single-line forms.
  ['set [ find default=yes ] authentication-types=wpa2-psk mode=dynamic-keys wpa2-pre-shared-key=RosWifi1', 'RosWifi1'],
  ['request license api-key set key PanApiKey12345', 'PanApiKey12345'],
  ['snmp-server host inside 10.1.1.1 community AsaComm version 2c', 'AsaComm'],
  ['VTP Password: VtpPw77', 'VtpPw77'],
  ['  key-string password 0822455D0A16', '0822455D0A16']
]

const s = (t: string) => scrubText(t, { known: [] })

describe('D-L7: crash scrubber gaps are closed by the shared ruleset', () => {
  it.each(DL7)('%j', (line, secret) => {
    expect(line).toContain(secret)
    for (const msg of [line, `Error: ${line.trim()}`, `Command failed: ${line.trim()} (exit 1)`, `write EPIPE while sending "${line.trim()}" to the host`]) {
      expect(s(msg), msg).not.toContain(secret)
    }
  })
  it('a plain error stays readable', () => {
    expect(s("TypeError: Cannot read properties of undefined (reading 'map')")).toBe("TypeError: Cannot read properties of undefined (reading 'map')")
  })
})
