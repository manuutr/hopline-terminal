import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

/**
 * Password-based key wrapping (D5). A master password never encrypts data directly: scrypt turns
 * it into a key-encryption key that wraps the 32-byte data key (DEK). Changing the password or the
 * vault mode re-wraps the DEK; nothing else is re-encrypted.
 */
export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** ~128 MiB and roughly 250-400 ms on a 2024 laptop. Recorded with every wrap, so it can change later. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

/** Bounds for params read from disk or from an import file: never let a file make us allocate gigabytes. */
export function checkParams(p: ScryptParams): ScryptParams {
  const pow2 = Number.isInteger(Math.log2(p.N))
  if (!pow2 || p.N < 2 ** 10 || p.N > 2 ** 20 || p.r < 1 || p.r > 32 || p.p < 1 || p.p > 4 || 128 * p.N * p.r > 1024 * 1024 * 1024)
    throw new Error('unsupported key-derivation parameters')
  return p
}

/**
 * Tighter bounds for an export file's header, which anyone can write: at most 2^18 (256 MiB with
 * r=8), r exactly 8, p at most 2. Hopline itself writes N=2^17, r=8, p=1.
 */
export function checkFileParams(p: ScryptParams): ScryptParams {
  checkParams(p)
  if (p.N > 2 ** 18 || p.r !== 8 || p.p > 2) throw new Error('unsupported key-derivation parameters')
  return p
}

/** scrypt → 64 bytes: the first half encrypts, the second half only computes the verifier. */
export function derive(password: string, salt: Buffer, params: ScryptParams): Promise<{ enc: Buffer; mac: Buffer }> {
  const { N, r, p } = checkParams(params)
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFC'), salt, 64, { N, r, p, maxmem: 128 * N * r + 32 * 1024 * 1024 }, (e, out) =>
      e ? reject(e) : resolve({ enc: out.subarray(0, 32), mac: out.subarray(32) })
    )
  )
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong master password')
    this.name = 'WrongPasswordError'
  }
}

/** What is stored for master-password mode. All binary fields are base64. */
export interface WrappedKey {
  v: 1
  kdf: 'scrypt'
  params: ScryptParams
  salt: string
  /** HMAC(macKey, "hopline-vault-verifier"): tells a wrong password from a damaged record. */
  verifier: string
  iv: string
  tag: string
  wrapped: string
}

const VERIFIER_LABEL = 'hopline-vault-verifier'
const WRAP_AAD = Buffer.from('hopline-dek-wrap-v1')

export async function wrapKey(dek: Buffer, password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<WrappedKey> {
  if (dek.length !== 32) throw new Error('data key must be 32 bytes')
  const salt = randomBytes(16)
  const { enc, mac } = await derive(password, salt, params)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', enc, iv)
  c.setAAD(WRAP_AAD)
  const wrapped = Buffer.concat([c.update(dek), c.final()])
  const verifier = createHmac('sha256', mac).update(VERIFIER_LABEL).digest('base64')
  enc.fill(0)
  mac.fill(0)
  return {
    v: 1,
    kdf: 'scrypt',
    params: { ...params },
    salt: salt.toString('base64'),
    verifier,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    wrapped: wrapped.toString('base64')
  }
}

/** Throws WrongPasswordError for a wrong password, a plain Error for a corrupt record. */
export async function unwrapKey(w: WrappedKey, password: string): Promise<Buffer> {
  if (w?.v !== 1 || w.kdf !== 'scrypt') throw new Error('unsupported vault record')
  const { enc, mac } = await derive(password, Buffer.from(w.salt, 'base64'), w.params)
  const expect = Buffer.from(w.verifier, 'base64')
  const got = createHmac('sha256', mac).update(VERIFIER_LABEL).digest()
  mac.fill(0)
  try {
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw new WrongPasswordError()
    try {
      const d = createDecipheriv('aes-256-gcm', enc, Buffer.from(w.iv, 'base64'))
      d.setAAD(WRAP_AAD)
      d.setAuthTag(Buffer.from(w.tag, 'base64'))
      return Buffer.concat([d.update(Buffer.from(w.wrapped, 'base64')), d.final()])
    } catch {
      throw new Error('The vault record is damaged (password verified, data key does not decrypt)')
    }
  } finally {
    enc.fill(0)
  }
}
