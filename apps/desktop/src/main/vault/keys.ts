import { createHash } from 'node:crypto'
import { isPpk, parsePrivateKey, ppkInfo } from '@hopline/transports/src/ppk.ts'
import type { KeyImportInfo } from '@shared/types'

export const MAX_KEY_BYTES = 64 * 1024

export type KeyInspection = Omit<KeyImportInfo, 'token' | 'file'>

const fingerprint = (blob: Buffer): string => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')

/** OpenSSH "openssh-key-v1" files keep the public key in clear: readable without the passphrase. */
function opensshPublic(text: string): { blob: Buffer; type: string } | null {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(text)
  if (!m) return null
  const b = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64')
  const magic = 'openssh-key-v1\0'
  if (b.subarray(0, magic.length).toString('latin1') !== magic) return null
  let o = magic.length
  const next = (): Buffer => {
    const n = b.readUInt32BE(o)
    const v = b.subarray(o + 4, o + 4 + n)
    o += 4 + n
    return v
  }
  try {
    next() // cipher
    next() // kdf
    next() // kdf options
    if (b.readUInt32BE(o) < 1) return null
    o += 4
    const blob = next()
    const type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString()
    return { blob: Buffer.from(blob), type }
  } catch {
    return null
  }
}

/**
 * Read a private key (OpenSSH, PEM PKCS#1/PKCS#8, PPK v2/v3) and describe it.
 * An encrypted key without its passphrase is accepted: the fingerprint comes from the public half
 * when the format exposes it, and the passphrase is asked for at connect time.
 * Throws a user-facing Error for anything that isn't a usable private key, or a wrong passphrase.
 */
export function inspectKey(text: string, passphrase?: string): KeyInspection {
  if (Buffer.byteLength(text) > MAX_KEY_BYTES) throw new Error('That file is too large to be a private key')
  const pass = passphrase || undefined
  const ppk = isPpk(text) ? ppkInfo(text) : null
  const format: KeyImportInfo['format'] = ppk ? (ppk.version === 3 ? 'ppk3' : 'ppk2') : /BEGIN OPENSSH PRIVATE KEY/.test(text) ? 'openssh' : 'pem'
  const parsed = parsePrivateKey(text, pass)
  if (!(parsed instanceof Error)) {
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    if (!key || !key.isPrivateKey()) throw new Error('That file holds a public key. Pick the private key (the file without .pub).')
    const encrypted = ppk ? ppk.encrypted : opensshEncrypted(text) || /ENCRYPTED/.test(text)
    return { format, keyType: key.type, fingerprint: fingerprint(key.getPublicSSH()), encrypted, comment: key.comment || ppk?.comment || '' }
  }
  const needsPass = /passphrase|encrypted|bad decrypt|integrity|bad key mac/i.test(parsed.message)
  if (!needsPass) throw new Error(`Not a supported private key: ${parsed.message}`)
  if (pass) throw new Error('Wrong passphrase for this key')
  // Encrypted, no passphrase: describe what is readable without it.
  if (ppk) return { format, keyType: ppk.keyType, fingerprint: fingerprint(ppk.publicBlob), encrypted: true, comment: ppk.comment }
  const pub = opensshPublic(text)
  if (pub) return { format, keyType: pub.type, fingerprint: fingerprint(pub.blob), encrypted: true, comment: '' }
  const pemType = /BEGIN (RSA|DSA|EC) PRIVATE KEY/.exec(text)?.[1]
  return { format, keyType: pemType === 'RSA' ? 'ssh-rsa' : pemType === 'DSA' ? 'ssh-dss' : pemType === 'EC' ? 'ecdsa' : 'unknown', fingerprint: null, encrypted: true, comment: '' }
}

function opensshEncrypted(text: string): boolean {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END/.exec(text)
  if (!m) return false
  const b = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64')
  const o = 'openssh-key-v1\0'.length
  if (b.length < o + 4) return false
  const n = b.readUInt32BE(o)
  return b.subarray(o + 4, o + 4 + n).toString() !== 'none'
}
