/**
 * TEST-ONLY DSA host keys, generated fresh on every run (nothing is checked in).
 *
 * Node can generate DSA keys but only exports them as PKCS#8, while ssh2's key parser wants the
 * traditional OpenSSL `-----BEGIN DSA PRIVATE KEY-----` form (SEQUENCE { 0, p, q, g, y, x }).
 * This converts between the two with a tiny DER reader/writer. Plain Node only: Electron's
 * BoringSSL cannot generate DSA keys at all.
 */
import { generateKeyPairSync } from 'node:crypto'

interface Tlv {
  tag: number
  body: Buffer
  next: number
}

function readTlv(buf: Buffer, pos: number): Tlv {
  const tag = buf[pos]!
  let len = buf[pos + 1]!
  let off = pos + 2
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = (len << 8) | buf[off + i]!
    off += n
  }
  return { tag, body: buf.subarray(off, off + len), next: off + len }
}

function children(body: Buffer): Tlv[] {
  const out: Tlv[] = []
  for (let pos = 0; pos < body.length; ) {
    const t = readTlv(body, pos)
    out.push(t)
    pos = t.next
  }
  return out
}

function encLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), encLen(body.length), body])

function intBytes(n: bigint): Buffer {
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let b = Buffer.from(hex, 'hex')
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return b
}

const big = (b: Buffer): bigint => BigInt('0x' + (b.toString('hex') || '0'))

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n
  let b = base % mod
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod
    b = (b * b) % mod
  }
  return r
}

/** A fresh 1024-bit DSA key (the only size `ssh-dss` permits) as a traditional PEM. */
export function generateDsaHostKey(): string {
  const { privateKey } = generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 })
  const der = privateKey.export({ type: 'pkcs8', format: 'der' })
  const [, algId, octet] = children(readTlv(der, 0).body)
  const [, params] = children(algId!.body)
  const [p, q, g] = children(params!.body).map((t) => big(t.body)) as [bigint, bigint, bigint]
  const x = big(readTlv(octet!.body, 0).body)
  const y = modPow(g, x, p)
  const seq = tlv(0x30, Buffer.concat([0n, p, q, g, y, x].map((n) => tlv(0x02, intBytes(n)))))
  const b64 = seq.toString('base64').replace(/.{1,64}/g, '$&\n')
  return `-----BEGIN DSA PRIVATE KEY-----\n${b64}-----END DSA PRIVATE KEY-----\n`
}
