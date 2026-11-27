import { createDiffieHellmanGroup, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import ssh2 from 'ssh2'
import { describe, expect, it } from 'vitest'
import { dsaVerify, modInv, modPow, parseDsaSignature, parseSshDssBlob, validDsaKey, verifySshDss } from '../src/legacy/dsa.ts'
import { installDsaVerifier, LEGACY, legacyAlgorithms, legacyNegotiated, OAKLEY_GROUP2_PRIME } from '../src/legacy/index.ts'
import { agentCandidates, ONEPASSWORD_LINUX_SOCK, WINDOWS_OPENSSH_PIPE } from '../src/ssh-agent.ts'
import { generateDsaHostKey } from './fixtures/dsa.ts'

const { utils } = ssh2

function dsaKey(): { ssh: Buffer; parsed: ssh2.ParsedKey; pem: string } {
  const pem = generateDsaHostKey()
  const k = utils.parseKey(pem)
  if (k instanceof Error) throw k
  const parsed = Array.isArray(k) ? k[0]! : k
  return { ssh: parsed.getPublicSSH(), parsed, pem }
}

describe('Oakley group 2 prime', () => {
  it('equals the modp2 group OpenSSL knows (plain Node)', () => {
    expect(OAKLEY_GROUP2_PRIME.equals(createDiffieHellmanGroup('modp2').getPrime())).toBe(true)
    expect(OAKLEY_GROUP2_PRIME.length).toBe(128)
  })
})

describe('BigInt DSA verifier', () => {
  it('agrees with OpenSSL on valid and tampered signatures', () => {
    for (let i = 0; i < 4; i++) {
      const { ssh, parsed } = dsaKey()
      const data = Buffer.from(`exchange hash ${i}`)
      const der = parsed.sign(data) as Buffer // OpenSSL-made DER signature
      expect(verifySshDss(ssh, data, der)).toBe(true)
      expect(verifySshDss(ssh, Buffer.from('other data'), der)).toBe(false)
      const bad = Buffer.from(der)
      bad[bad.length - 2]! ^= 0x40
      expect(verifySshDss(ssh, data, bad)).toBe(false)
    }
  })

  it('accepts the raw 40-byte SSH signature form too', () => {
    const { ssh, parsed } = dsaKey()
    const data = Buffer.from('raw form')
    const sig = parseDsaSignature(parsed.sign(data) as Buffer)!
    const raw = Buffer.concat([sig.r, sig.s].map((n) => Buffer.from(n.toString(16).padStart(40, '0'), 'hex')))
    expect(raw.length).toBe(40)
    expect(verifySshDss(ssh, data, raw)).toBe(true)
  })

  it('verifies signatures made by node:crypto directly, and only for the right key', () => {
    const { ssh, pem } = dsaKey()
    const data = Buffer.from('hello')
    const der = sign('sha1', data, createPrivateKey(pem))
    expect(verifySshDss(ssh, data, der)).toBe(true)
    const { privateKey: unrelated } = generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 })
    expect(verifySshDss(ssh, data, sign('sha1', data, unrelated))).toBe(false)
  })

  it('rejects out-of-range r/s and bad domain parameters', () => {
    const { ssh, parsed } = dsaKey()
    const key = parseSshDssBlob(ssh)!
    expect(validDsaKey(key)).toBe(true)
    const data = Buffer.from('x')
    const sig = parseDsaSignature(parsed.sign(data) as Buffer)!
    expect(dsaVerify(key, data, sig)).toBe(true)
    expect(dsaVerify(key, data, { r: 0n, s: sig.s })).toBe(false)
    expect(dsaVerify(key, data, { r: sig.r, s: key.q })).toBe(false)
    expect(dsaVerify(key, data, { r: sig.r + key.q, s: sig.s })).toBe(false)
    expect(validDsaKey({ ...key, g: 1n })).toBe(false)
    expect(validDsaKey({ ...key, y: key.p })).toBe(false)
    expect(validDsaKey({ ...key, q: key.q + 2n })).toBe(false)
    expect(validDsaKey({ ...key, p: 23n })).toBe(false)
  })

  it('rejects malformed blobs and signatures', () => {
    expect(parseSshDssBlob(Buffer.from('nonsense'))).toBeNull()
    expect(parseDsaSignature(Buffer.from([0x30, 0x03, 0x02, 0x01]))).toBeNull()
    expect(parseDsaSignature(Buffer.from([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01]))).toBeNull() // negative r
  })

  it('modInv and modPow are correct on small numbers', () => {
    expect(modPow(4n, 13n, 497n)).toBe(445n)
    expect(modInv(3n, 11n)).toBe(4n)
    expect(modInv(6n, 9n)).toBeNull()
  })
})

describe('ssh2 integration of the shims', () => {
  it('installs the ssh-dss verifier once and routes ParsedKey.verify through it', () => {
    expect(installDsaVerifier()).toBe(true)
    expect(installDsaVerifier()).toBe(true)
    const { parsed } = dsaKey()
    const data = Buffer.from('via ParsedKey')
    expect(parsed.verify(data, parsed.sign(data) as Buffer)).toBe(true)
    expect(parsed.verify(Buffer.from('nope'), parsed.sign(data) as Buffer)).toBe(false)
  })

  it('leaves other key types on the native path', () => {
    installDsaVerifier()
    const kp = utils.generateKeyPairSync('ecdsa', { bits: 256 })
    const key = utils.parseKey(kp.private) as ssh2.ParsedKey
    const data = Buffer.from('ecdsa')
    expect(key.verify(data, key.sign(data) as Buffer)).toBe(true)
  })

  it('appends only algorithms this runtime supports, after the modern defaults', () => {
    const a = legacyAlgorithms({ group1: true, dss: true }) as unknown as Record<string, { append: string[]; prepend: string[] }>
    expect(a['kex']!.append).toEqual(expect.arrayContaining(['diffie-hellman-group1-sha1', 'diffie-hellman-group14-sha1']))
    expect(a['serverHostKey']!.append).toContain('ssh-dss')
    expect(a['kex']!.prepend).toEqual([])
    for (const k of ['kex', 'serverHostKey', 'cipher', 'hmac']) {
      for (const alg of a[k]!.append) expect([...LEGACY.kex, ...LEGACY.serverHostKey, ...LEGACY.cipher, ...LEGACY.hmac]).toContain(alg)
    }
  })

  it('fails closed: no group1 / ssh-dss when a shim is unavailable', () => {
    const a = legacyAlgorithms({ group1: false, dss: false }) as unknown as Record<string, { append: string[] }>
    expect(a['kex']!.append).not.toContain('diffie-hellman-group1-sha1')
    expect(a['serverHostKey']!.append).not.toContain('ssh-dss')
  })

  it('names legacy algorithms in a negotiated set', () => {
    const cs = { cipher: 'aes128-gcm@openssh.com', mac: '' }
    expect(legacyNegotiated({ kex: 'curve25519-sha256', serverHostKey: 'ssh-ed25519', cs, sc: cs })).toEqual([])
    expect(
      legacyNegotiated({ kex: 'diffie-hellman-group1-sha1', serverHostKey: 'ssh-dss', cs: { cipher: '3des-cbc', mac: 'hmac-md5' }, sc: { cipher: '3des-cbc', mac: 'hmac-md5' } })
    ).toEqual(['diffie-hellman-group1-sha1', 'ssh-dss', '3des-cbc', 'hmac-md5'])
  })
})

describe('agent discovery', () => {
  const none = () => false
  it('prefers SSH_AUTH_SOCK on every OS', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const c = await agentCandidates({ platform, env: { SSH_AUTH_SOCK: '/tmp/a.sock' }, home: '/home/u', exists: none, launchctlSock: async () => undefined })
      expect(c[0]).toEqual({ path: '/tmp/a.sock', source: 'SSH_AUTH_SOCK' })
    }
  })

  it('Windows: OpenSSH/1Password pipe when present, then Pageant', async () => {
    expect(await agentCandidates({ platform: 'win32', env: {}, exists: (p) => p === WINDOWS_OPENSSH_PIPE })).toEqual([
      { path: WINDOWS_OPENSSH_PIPE, source: 'openssh-pipe' },
      { path: 'pageant', source: 'pageant' }
    ])
    expect(await agentCandidates({ platform: 'win32', env: {}, exists: none })).toEqual([{ path: 'pageant', source: 'pageant' }])
  })

  it('macOS: launchctl (Dock-launched apps) and the 1Password socket', async () => {
    const c = await agentCandidates({
      platform: 'darwin',
      env: {},
      home: '/Users/u',
      exists: () => true,
      launchctlSock: async () => '/private/tmp/com.apple.launchd.x/Listeners'
    })
    expect(c.map((x) => x.source)).toEqual(['launchctl', '1password'])
    expect(c[1]!.path).toBe('/Users/u/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock')
  })

  it('Linux: the 1Password socket when it exists', async () => {
    const c = await agentCandidates({ platform: 'linux', env: {}, home: '/home/u', exists: (p) => p.endsWith(ONEPASSWORD_LINUX_SOCK) })
    expect(c).toEqual([{ path: '/home/u/.1password/agent.sock', source: '1password' }])
    expect(await agentCandidates({ platform: 'linux', env: {}, home: '/home/u', exists: none })).toEqual([])
  })
})
