import { describe, expect, it } from 'vitest'
import { redact } from '../src'

const secretsGone = (input: string, ...secrets: string[]) => {
  const { text, count } = redact(input)
  for (const s of secrets) expect(text).not.toContain(s)
  expect(count).toBeGreaterThan(0)
  return text
}

// Phase 4 safety review (M6): a key cut off by the output cap or a slice must not reach the model.
describe('redact: private keys cut off at either end (Phase 4 M6)', () => {
  const body = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw\n7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxKLxoS2tFc\nzGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo9z+40RQzuVaE'
  const secrets = ['MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw', '7onLRnrq0', 'zGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW']
  it('a BEGIN line with no END (the output cap cut it): redacted to the end', () => {
    const t = secretsGone(`crypto pki import\n-----BEGIN RSA PRIVATE KEY-----\n${body}`, ...secrets)
    expect(t).toBe('crypto pki import\n-----BEGIN RSA PRIVATE KEY----- <redacted>')
  })
  it('an END line with no BEGIN (a tail kept by a slice): redacted back to the start of the run', () => {
    const t = secretsGone(`${body.slice(20)}\n-----END RSA PRIVATE KEY-----\nrouter# `, ...secrets.map((s) => s.slice(-20)))
    expect(t).toBe('<redacted>\n-----END RSA PRIVATE KEY-----\nrouter# ')
  })
  it('headless with PEM headers and text before the run: the run and its headers go', () => {
    const t = secretsGone(`show crypto key\n\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,1A2B\n${body}\n-----END ENCRYPTED PRIVATE KEY-----`, ...secrets)
    expect(t).toBe('show crypto key\n\n<redacted>\n-----END ENCRYPTED PRIVATE KEY-----')
  })
  it('FortiOS set private-key "… cut before its closing quote', () => {
    secretsGone(`config vpn certificate local\n    edit "srv"\n        set private-key "-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}`, ...secrets)
    const t = secretsGone(`        set private-key "${body}`, ...secrets)
    expect(t).toBe('        set private-key <redacted>')
  })
  it('FortiOS headless tail ending in the closing quote', () => {
    secretsGone(`${body}\n-----END ENCRYPTED PRIVATE KEY-----"\n    next\nend`, ...secrets)
  })
  it('complete blocks still redact as before, and a later cut block too', () => {
    const t = secretsGone(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nx\n-----BEGIN PRIVATE KEY-----\n${body}`, ...secrets)
    expect(t).toBe('-----BEGIN PRIVATE KEY----- <redacted> -----END PRIVATE KEY-----\nx\n-----BEGIN PRIVATE KEY----- <redacted>')
  })
  it('stays fast on long base64 runs with and without an END line', () => {
    const big = Array(20000).fill('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=').join('\n')
    const t0 = Date.now()
    redact(big + '\n-----END X-----')
    redact(big + '\n-----END PRIVATE KEY-----\n' + big + '\n-----END PRIVATE KEY-----')
    redact('-----BEGIN PRIVATE KEY-----\n' + big)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
