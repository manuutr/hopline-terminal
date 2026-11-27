import { argon2Sync, createCipheriv, createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { describe, expect, it } from 'vitest'
import { argon2, isPpk, parsePrivateKey, PPK_ARGON2_LIMITS, PpkError, ppkInfo, ppkToOpenSsh } from '../src/ppk'

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8')
const one = (k: ReturnType<typeof parsePrivateKey>) => {
  if (k instanceof Error) throw k
  return Array.isArray(k) ? k[0]! : k
}

// ---------------------------------------------------------------- a PPK writer, from the PuTTY manual (appendix C)
const str = (b: Buffer | string) => {
  const body = typeof b === 'string' ? Buffer.from(b) : b
  const n = Buffer.alloc(4)
  n.writeUInt32BE(body.length)
  return Buffer.concat([n, body])
}
const mpint = (b64url: string) => {
  let b = Buffer.from(b64url, 'base64url')
  while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
  return str(b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b)
}

type Kind = 'rsa' | 'ed25519' | 'ecdsa'
function material(kind: Kind): { type: string; pub: Buffer; priv: Buffer } {
  if (kind === 'rsa') {
    const j = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
    return { type: 'ssh-rsa', pub: Buffer.concat([str('ssh-rsa'), mpint(j.e!), mpint(j.n!)]), priv: Buffer.concat([mpint(j.d!), mpint(j.p!), mpint(j.q!), mpint(j.qi!)]) }
  }
  if (kind === 'ed25519') {
    const j = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
    return { type: 'ssh-ed25519', pub: Buffer.concat([str('ssh-ed25519'), str(Buffer.from(j.x!, 'base64url'))]), priv: str(Buffer.from(j.d!, 'base64url')) }
  }
  const j = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
  const q = Buffer.concat([Buffer.from([4]), Buffer.from(j.x!, 'base64url'), Buffer.from(j.y!, 'base64url')])
  return { type: 'ecdsa-sha2-nistp256', pub: Buffer.concat([str('ecdsa-sha2-nistp256'), str('nistp256'), str(q)]), priv: mpint(j.d!) }
}

function writePpk(version: 2 | 3, m: { type: string; pub: Buffer; priv: Buffer }, passphrase?: string, comment = 'test-key'): string {
  const enc = passphrase ? 'aes256-cbc' : 'none'
  // Pad the private blob to the cipher block size (PuTTY pads even unencrypted v3 keys).
  const padLen = passphrase || version === 3 ? (16 - (m.priv.length % 16)) % 16 : 0
  const plain = Buffer.concat([m.priv, randomBytes(padLen)])
  const pass = Buffer.from(passphrase ?? '')
  let cipherKey: Buffer, iv: Buffer, macKey: Buffer
  const kdfLines: string[] = []
  if (version === 2) {
    cipherKey = Buffer.concat([createHash('sha1').update(Buffer.from([0, 0, 0, 0])).update(pass).digest(), createHash('sha1').update(Buffer.from([0, 0, 0, 1])).update(pass).digest()]).subarray(0, 32)
    iv = Buffer.alloc(16)
    macKey = createHash('sha1').update('putty-private-key-file-mac-key').update(pass).digest()
  } else if (passphrase) {
    const salt = randomBytes(16)
    const out = argon2Sync('argon2id', { message: pass, nonce: salt, parallelism: 1, tagLength: 80, memory: 8192, passes: 3 })
    ;[cipherKey, iv, macKey] = [out.subarray(0, 32), out.subarray(32, 48), out.subarray(48)]
    kdfLines.push('Key-Derivation: Argon2id', 'Argon2-Memory: 8192', 'Argon2-Passes: 3', 'Argon2-Parallelism: 1', `Argon2-Salt: ${salt.toString('hex')}`)
  } else {
    ;[cipherKey, iv, macKey] = [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)]
  }
  const mac = createHmac(version === 2 ? 'sha1' : 'sha256', macKey).update(Buffer.concat([str(m.type), str(enc), str(comment), str(m.pub), str(plain)])).digest('hex')
  let privOut = plain
  if (passphrase) {
    const c = createCipheriv('aes-256-cbc', cipherKey, iv)
    c.setAutoPadding(false)
    privOut = Buffer.concat([c.update(plain), c.final()])
  }
  const lines = (b: Buffer) => b.toString('base64').match(/.{1,64}/g)!
  const pubLines = lines(m.pub)
  const privLines = lines(privOut)
  return [
    `PuTTY-User-Key-File-${version}: ${m.type}`,
    `Encryption: ${enc}`,
    `Comment: ${comment}`,
    `Public-Lines: ${pubLines.length}`,
    ...pubLines,
    ...kdfLines,
    `Private-Lines: ${privLines.length}`,
    ...privLines,
    `Private-MAC: ${mac}`,
    ''
  ].join('\r\n')
}

/** The converted key must sign, and its public half must be the PPK's public blob. */
function assertUsable(text: string, pub: Buffer) {
  const k = one(parsePrivateKey(text))
  expect(k.isPrivateKey()).toBe(true)
  expect(k.getPublicSSH()).toEqual(pub)
  const data = Buffer.from('hopline')
  expect(k.verify(data, k.sign(data))).toBe(true)
}

describe('PPK', () => {
  it('reads real PuTTY v2 files, matching ssh2’s own PPK parser', () => {
    for (const [f, pass] of [
      ['ppk_rsa.ppk', undefined],
      ['ppk_rsa_enc.ppk', 'node.js'],
      ['ppk_dsa_enc.ppk', 'node.js']
    ] as const) {
      const text = fixture(f)
      expect(isPpk(text)).toBe(true)
      const native = one(ssh2.utils.parseKey(text, pass))
      const ours = one(parsePrivateKey(text, pass))
      expect(ours.getPublicSSH()).toEqual(native.getPublicSSH())
      expect(ours.type).toBe(native.type)
      const data = Buffer.from('x')
      expect(native.verify(data, ours.sign(data))).toBe(true)
    }
  })

  for (const version of [2, 3] as const)
    for (const kind of ['rsa', 'ed25519', 'ecdsa'] as const)
      it(`v${version} ${kind}: unencrypted and encrypted`, () => {
        const m = material(kind)
        const plain = writePpk(version, m)
        assertUsable(ppkToOpenSsh(plain), m.pub)
        const enc = writePpk(version, m, 'pp-secret')
        const info = ppkInfo(enc)
        expect(info).toMatchObject({ version, keyType: m.type, encrypted: true, comment: 'test-key' })
        expect(info.publicBlob).toEqual(m.pub)
        // Missing and wrong passphrases are reported in words loadKey's retry loop recognises.
        expect(String(parsePrivateKey(enc))).toMatch(/passphrase/)
        expect(String(parsePrivateKey(enc, 'wrong'))).toMatch(/passphrase/)
        assertUsable(ppkToOpenSsh(enc, 'pp-secret'), m.pub)
      })

  it('rejects tampering and hostile key-derivation parameters', () => {
    const m = material('ed25519')
    const t = writePpk(3, m)
    const flipped = t.replace(/Private-MAC: (.)/, (_, c: string) => `Private-MAC: ${c === '0' ? '1' : '0'}`)
    expect(() => ppkToOpenSsh(flipped)).toThrow(/corrupt/)
    const enc = writePpk(3, m, 'pw').replace(/Argon2-Memory: \d+/, 'Argon2-Memory: 99999999')
    expect(() => ppkToOpenSsh(enc, 'pw')).toThrow(/Unsupported/)
    expect(() => ppkToOpenSsh('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n')).toThrow(/Invalid/)
  })

  describe('caps Argon2 cost in every entry point, before deriving anything', () => {
    const enc = writePpk(3, material('ed25519'), 'pw')
    const set = (text: string, header: string, value: string) => text.replace(new RegExp(`${header}: .*`), `${header}: ${value}`)
    const hostile: [string, string, string, RegExp][] = [
      ['memory over 256 MiB', 'Argon2-Memory', String(256 * 1024 + 1), /memory/],
      ['4 GiB of memory', 'Argon2-Memory', String(4 * 1024 * 1024), /memory/],
      ['passes over 64', 'Argon2-Passes', '65', /passes/],
      ['parallelism over 16', 'Argon2-Parallelism', '17', /parallelism/],
      // Each under its own cap, but 256 MiB × 5 passes is over the 1 GiB·pass budget.
      ['memory × passes over budget', 'Argon2-Memory', String(256 * 1024), /memory × passes/],
      ['non-integer memory', 'Argon2-Memory', '8192.5', /invalid/],
      ['exponent notation', 'Argon2-Passes', '1e1', /invalid/],
      ['zero passes', 'Argon2-Passes', '0', /invalid/],
      ['prototype key as algorithm', 'Key-Derivation', 'constructor', /key derivation/]
    ]
    it.each(hostile)('%s', (_, header, value, why) => {
      let text = set(enc, header, value)
      if (_ === 'memory × passes over budget') text = set(text, 'Argon2-Passes', '5')
      const t = performance.now()
      for (const run of [() => ppkInfo(text), () => ppkToOpenSsh(text, 'pw')]) {
        expect(run).toThrow(PpkError)
        expect(run).toThrow(/Unsupported PPK key derivation/)
        expect(run).toThrow(why)
        // "passphrase" would make the key loader ask for one again instead of failing.
        expect(run).not.toThrow(/passphrase/)
      }
      for (const pass of [undefined, 'pw']) {
        const r = parsePrivateKey(text, pass)
        expect(r).toBeInstanceOf(PpkError)
        expect(String(r)).toMatch(/Unsupported PPK key derivation/)
      }
      // No KDF ran: 256 MiB × 5 passes would take seconds.
      expect(performance.now() - t).toBeLessThan(100)
    })
    it('still reads keys at PuTTY defaults', () => {
      expect(ppkInfo(enc)).toMatchObject({ version: 3, encrypted: true })
      // PuTTYgen's auto-tuned pass counts on fast machines.
      for (const n of ['34', '55']) expect(ppkInfo(set(enc, 'Argon2-Passes', n))).toMatchObject({ encrypted: true })
      expect(PPK_ARGON2_LIMITS).toEqual({ maxMemoryKiB: 262144, maxPasses: 64, maxParallelism: 16, maxMemoryTimesPasses: 1048576 })
    })
  })
})

describe('argon2 fallback', () => {
  // Electron's BoringSSL has no Argon2: the app uses the JS implementation. It must agree with OpenSSL.
  it('the JS implementation matches native argon2 for id, i and d', () => {
    const pass = Buffer.from('pässwörd')
    const salt = Buffer.from('0eba57ab5bafb3ccab3f025ff8c977b7', 'hex')
    for (const algo of ['argon2id', 'argon2i', 'argon2d'] as const) {
      const o = { parallelism: 2, memory: 256, passes: 3 }
      expect(argon2(algo, pass, salt, o, false).toString('hex')).toBe(argon2(algo, pass, salt, o).toString('hex'))
    }
  })
})
