import { describe, expect, it } from 'vitest'
import { redact } from '../src'

// Phase 4 fix-round review K1 and K3.

const PPK3 = [
  'PuTTY-User-Key-File-3: ssh-rsa',
  'Encryption: none',
  'Comment: rsa-key-20261125',
  'Public-Lines: 2',
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQC7pubPUBLICPART0000000000000000000000000',
  'PUBLICPART1111111111111111111111111111111111111111111111111111111111',
  'Private-Lines: 4',
  'AAABAQCSECRETKEYLINE0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'SECRETKEYLINE1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'SECRETKEYLINE2CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  'SECRETKEYLINE3DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  'Private-MAC: 8f3c2b1a0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a'
].join('\n')
const PPK2 = PPK3.replace('PuTTY-User-Key-File-3', 'PuTTY-User-Key-File-2')
const SECRET_PIECES = ['SECRETKEYLINE0', 'SECRETKEYLINE1', 'SECRETKEYLINE2', 'SECRETKEYLINE3', '8f3c2b1a0d9e8f7a']

/** 12-character windows of the private lines (and the MAC value) that survive in the text. */
const leaked = (text: string): string[] => {
  const out: string[] = []
  const secretLines = PPK3.split('\n').slice(7).map((l) => l.replace(/^Private-MAC: /, ''))
  for (const line of secretLines) for (let i = 0; i + 12 <= line.length; i += 6) if (text.includes(line.slice(i, i + 12))) out.push(line.slice(i, i + 12))
  return out
}

describe('K1: PuTTY .ppk keys are redacted, whole or cut', () => {
  it('a whole v3 and v2 file keeps the public part and loses everything from Private-Lines on', () => {
    for (const f of [PPK3, PPK2]) {
      const r = redact(`router# more flash:id.ppk\n${f}\nrouter# `)
      for (const s of SECRET_PIECES) expect(r.text).not.toContain(s)
      expect(r.text).toContain('Public-Lines: 2')
      expect(r.text).toContain('Private-Lines: <redacted>')
      expect(r.count).toBeGreaterThan(0)
    }
  })
  for (const pct of [20, 50, 80]) {
    it(`cut at ${pct}%, head kept and tail kept: nothing secret survives`, () => {
      const at = Math.floor((PPK3.length * pct) / 100)
      expect(leaked(redact(PPK3.slice(0, at)).text)).toEqual([])
      expect(leaked(redact(PPK3.slice(at)).text)).toEqual([])
    })
  }
  it('a tail that starts inside the private lines: the run before Private-MAC and the MAC go', () => {
    const tail = PPK3.slice(PPK3.indexOf('SECRETKEYLINE1') + 5)
    expect(redact(tail).text).toBe('<redacted>\nPrivate-MAC: <redacted>')
  })
})

describe('K3: PAN-OS XML secrets', () => {
  it('<phash> with a crypt hash: the closing tag survives', () => {
    const r = redact('<entry name="admin"><phash>$1$abcdefgh$SECRETHASHVALUE0123</phash></entry>')
    expect(r.text).toBe('<entry name="admin"><phash><redacted></phash></entry>')
  })
  it('<phash>, <private-key> and <key> values without $ are redacted', () => {
    const r = redact(
      '<phash>fnRL/G5lXVMug</phash>\n<private-key>-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBSECRETBODY\n-----END ENCRYPTED PRIVATE KEY-----\n</private-key>\n<key>plainPSKsecret</key>'
    )
    expect(r.text).not.toMatch(/fnRL|SECRETBODY|plainPSKsecret/)
    expect(r.text).toContain('</phash>')
    expect(r.text).toContain('</private-key>')
    expect(r.text).toContain('</key>')
  })
  it('a value cut before its closing tag runs to the end; public elements stay', () => {
    expect(redact('<private-key>MIIBCUTOFFSECRET').text).toBe('<private-key><redacted>')
    expect(redact('<public-key>ssh-rsa AAAApublic</public-key>').text).toContain('AAAApublic')
    expect(redact('<hostname>PA-VM</hostname>').text).toBe('<hostname>PA-VM</hostname>')
  })
})
