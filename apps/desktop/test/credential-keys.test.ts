import { createHash, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { describe, expect, it } from 'vitest'
import { generateEd25519 } from '../../../packages/simulator/src/index.ts'
import { inspectKey } from '../src/main/vault/keys'

const fp = (pub: Buffer) => 'SHA256:' + createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')
const pubOf = (text: string, pass?: string) => {
  const k = ssh2.utils.parseKey(text, pass)
  if (k instanceof Error) throw k
  return (Array.isArray(k) ? k[0]! : k).getPublicSSH()
}

describe('inspectKey', () => {
  it('OpenSSH: plain and encrypted; the fingerprint is readable without the passphrase', () => {
    const plain = generateEd25519({ comment: 'me@laptop' })
    expect(inspectKey(plain.private)).toEqual({ format: 'openssh', keyType: 'ssh-ed25519', fingerprint: fp(pubOf(plain.private)), encrypted: false, comment: 'me@laptop' })
    const enc = generateEd25519({ passphrase: 'pp' }) // retries around an ssh2 keygen bug
    const want = fp(pubOf(enc.private, 'pp'))
    expect(inspectKey(enc.private)).toMatchObject({ format: 'openssh', keyType: 'ssh-ed25519', fingerprint: want, encrypted: true })
    expect(inspectKey(enc.private, 'pp')).toMatchObject({ fingerprint: want, encrypted: true })
    expect(() => inspectKey(enc.private, 'wrong')).toThrow(/Wrong passphrase/)
  })

  it('PEM (PKCS#1, PKCS#8, encrypted)', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    expect(inspectKey(pkcs1)).toMatchObject({ format: 'pem', keyType: 'ssh-rsa', encrypted: false, fingerprint: fp(pubOf(pkcs1)) })
    const encPem = privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pem-pass' }).toString()
    // Encrypted PEM hides the public key: no fingerprint until the passphrase is given.
    expect(inspectKey(encPem)).toMatchObject({ format: 'pem', keyType: 'ssh-rsa', fingerprint: null, encrypted: true })
    expect(inspectKey(encPem, 'pem-pass')).toMatchObject({ fingerprint: fp(pubOf(pkcs1)), encrypted: true })
  })

  it('refuses public keys, junk and huge files', () => {
    const k = generateEd25519()
    expect(() => inspectKey(k.public)).toThrow(/public key/)
    expect(() => inspectKey('hello')).toThrow(/Not a supported private key/)
    expect(() => inspectKey('x'.repeat(70_000))).toThrow(/too large/)
  })
})
