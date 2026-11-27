/**
 * Minimal DSA signature *verifier* (FIPS 186-4 section 4.7) for `ssh-dss` server host keys.
 *
 * Electron's BoringSSL has no DSA: `crypto.verify` throws ERR_OSSL_EVP_UNSUPPORTED_ALGORITHM and
 * `crypto.createVerify(...).verify` silently returns false. We only ever *verify* a server's
 * signature over the exchange hash (we never sign with DSA), and every input is public, so a
 * BigInt implementation has no secret-dependent timing to worry about.
 */
import { createHash } from 'node:crypto'

export interface DsaPublicKey {
  p: bigint
  q: bigint
  g: bigint
  y: bigint
}

const toBig = (b: Buffer): bigint => (b.length === 0 ? 0n : BigInt('0x' + b.toString('hex')))

export function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    e >>= 1n
    b = (b * b) % mod
  }
  return result
}

/** Modular inverse by the extended Euclidean algorithm; null when gcd(a, m) != 1. */
export function modInv(a: bigint, m: bigint): bigint | null {
  let [oldR, r] = [((a % m) + m) % m, m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  if (oldR !== 1n) return null
  return ((oldS % m) + m) % m
}

/** Parse the SSH wire blob `string "ssh-dss", mpint p, mpint q, mpint g, mpint y`. */
export function parseSshDssBlob(blob: Buffer): DsaPublicKey | null {
  let pos = 0
  const read = (): Buffer | null => {
    if (pos + 4 > blob.length) return null
    const len = blob.readUInt32BE(pos)
    pos += 4
    if (pos + len > blob.length) return null
    const out = blob.subarray(pos, pos + len)
    pos += len
    return out
  }
  const type = read()
  if (!type || type.toString('latin1') !== 'ssh-dss') return null
  const parts: bigint[] = []
  for (let i = 0; i < 4; i++) {
    const v = read()
    if (!v) return null
    parts.push(toBig(v))
  }
  if (pos !== blob.length) return null
  const [p, q, g, y] = parts as [bigint, bigint, bigint, bigint]
  return { p, q, g, y }
}

/**
 * Signature as ssh2 hands it to `verify()`: either DER `SEQUENCE { INTEGER r, INTEGER s }`
 * (ssh2 converts the 40-byte SSH form) or the raw 40-byte `r || s`.
 */
export function parseDsaSignature(sig: Buffer): { r: bigint; s: bigint } | null {
  if (sig.length === 40) return { r: toBig(sig.subarray(0, 20)), s: toBig(sig.subarray(20)) }
  let pos = 0
  const readLen = (): number | null => {
    const first = sig[pos++]
    if (first === undefined) return null
    if (first < 0x80) return first
    const n = first & 0x7f
    if (n === 0 || n > 2) return null
    let len = 0
    for (let i = 0; i < n; i++) {
      const b = sig[pos++]
      if (b === undefined) return null
      len = (len << 8) | b
    }
    return len
  }
  const readInt = (): bigint | null => {
    if (sig[pos++] !== 0x02) return null
    const len = readLen()
    if (len === null || len === 0 || pos + len > sig.length) return null
    const v = sig.subarray(pos, pos + len)
    pos += len
    if (v[0]! & 0x80) return null // negative
    return toBig(v)
  }
  if (sig[pos++] !== 0x30) return null
  const seqLen = readLen()
  if (seqLen === null || pos + seqLen !== sig.length) return null
  const r = readInt()
  const s = readInt()
  if (r === null || s === null || pos !== sig.length) return null
  return { r, s }
}

/** Sanity checks on domain parameters so a hostile key can't make verification meaningless. */
export function validDsaKey(k: DsaPublicKey): boolean {
  const pBits = bitLength(k.p)
  const qBits = bitLength(k.q)
  if (pBits < 1024 || pBits > 3072) return false
  if (qBits !== 160 && qBits !== 224 && qBits !== 256) return false
  if ((k.p & 1n) === 0n || (k.q & 1n) === 0n) return false
  if ((k.p - 1n) % k.q !== 0n) return false
  if (k.g <= 1n || k.g >= k.p || k.y <= 1n || k.y >= k.p) return false
  // g and y must lie in the order-q subgroup.
  return modPow(k.g, k.q, k.p) === 1n && modPow(k.y, k.q, k.p) === 1n
}

/** Verify a DSA signature over `data` hashed with SHA-1 (the only hash `ssh-dss` defines). */
export function dsaVerify(key: DsaPublicKey, data: Buffer, sig: { r: bigint; s: bigint }): boolean {
  const { p, q, g, y } = key
  const { r, s } = sig
  if (!validDsaKey(key)) return false
  if (r <= 0n || r >= q || s <= 0n || s >= q) return false
  const digest = createHash('sha1').update(data).digest()
  // z = leftmost min(N, outlen) bits of the hash; SHA-1 is 160 bits and N >= 160.
  const z = toBig(digest)
  const w = modInv(s, q)
  if (w === null) return false
  const u1 = (z * w) % q
  const u2 = (r * w) % q
  const v = ((modPow(g, u1, p) * modPow(y, u2, p)) % p) % q
  return v === r
}

/** Convenience: verify straight from ssh2's inputs (SSH public blob + DER/raw signature). */
export function verifySshDss(publicSsh: Buffer, data: Buffer, signature: Buffer): boolean {
  const key = parseSshDssBlob(publicSsh)
  const sig = parseDsaSignature(signature)
  return key !== null && sig !== null && dsaVerify(key, data, sig)
}
