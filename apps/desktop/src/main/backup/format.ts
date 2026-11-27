import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { checkFileParams, derive, DEFAULT_SCRYPT, type ScryptParams } from '../vault/kdf'

/**
 * The .hopline file (D3): one JSON header line, then AES-256-GCM over the gzipped JSON payload.
 *
 *   {"format":"hopline-export","version":1,"kdf":{"name":"scrypt","N":131072,"r":8,"p":1},"salt":"…","iv":"…","createdAt":…}\n
 *   <ciphertext><16-byte GCM tag>
 *
 * The key comes from the passphrase via scrypt. The header line is the GCM AAD, so changing any
 * of it (KDF params, salt, date) fails authentication just like changing the ciphertext.
 */
export const FORMAT = 'hopline-export'
export const VERSION = 1
export const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_PLAIN_BYTES = 256 * 1024 * 1024
export const MIN_PASSPHRASE = 8

export interface FileHeader {
  format: typeof FORMAT
  version: number
  kdf: { name: 'scrypt' } & ScryptParams
  salt: string
  iv: string
  createdAt: number
}

export class BadPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase, or the file was changed after it was exported')
    this.name = 'BadPassphraseError'
  }
}

export async function sealFile(payload: unknown, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters`)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const header: FileHeader = { format: FORMAT, version: VERSION, kdf: { name: 'scrypt', ...params }, salt: salt.toString('base64'), iv: iv.toString('base64'), createdAt: Date.now() }
  const line = Buffer.from(JSON.stringify(header) + '\n')
  const { enc, mac } = await derive(passphrase, salt, params)
  mac.fill(0)
  const c = createCipheriv('aes-256-gcm', enc, iv)
  c.setAAD(line)
  const body = Buffer.concat([c.update(gzipSync(JSON.stringify(payload))), c.final(), c.getAuthTag()])
  enc.fill(0)
  return Buffer.concat([line, body])
}

/** Parse and sanity-check the header without the passphrase (file picker preview). */
export function readHeader(file: Buffer): { header: FileHeader; line: Buffer; body: Buffer } {
  if (file.length > MAX_FILE_BYTES) throw new Error('This file is too large to be a Hopline Terminal export')
  const nl = file.indexOf(0x0a)
  if (nl < 0 || nl > 4096) throw new Error('Not a Hopline Terminal export file')
  const line = file.subarray(0, nl + 1)
  let h: FileHeader
  try {
    h = JSON.parse(line.toString('utf8')) as FileHeader
  } catch {
    throw new Error('Not a Hopline Terminal export file')
  }
  if (h?.format !== FORMAT) throw new Error('Not a Hopline Terminal export file')
  if (h.version !== VERSION) throw new Error(`This export was made by a newer Hopline Terminal (format v${h.version})`)
  if (h.kdf?.name !== 'scrypt' || typeof h.salt !== 'string' || typeof h.iv !== 'string') throw new Error('Unsupported export encryption')
  checkFileParams({ N: h.kdf.N, r: h.kdf.r, p: h.kdf.p })
  const body = file.subarray(nl + 1)
  if (body.length < 17) throw new Error('The export file is truncated')
  return { header: h, line, body }
}

export async function openFile(file: Buffer, passphrase: string): Promise<{ header: FileHeader; payload: unknown }> {
  const { header, line, body } = readHeader(file)
  const { enc, mac } = await derive(passphrase, Buffer.from(header.salt, 'base64'), header.kdf)
  mac.fill(0)
  let zipped: Buffer
  try {
    const d = createDecipheriv('aes-256-gcm', enc, Buffer.from(header.iv, 'base64'))
    d.setAAD(line)
    d.setAuthTag(body.subarray(body.length - 16))
    zipped = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
  } catch {
    throw new BadPassphraseError()
  } finally {
    enc.fill(0)
  }
  const json = gunzipSync(zipped, { maxOutputLength: MAX_PLAIN_BYTES }).toString('utf8')
  return { header, payload: JSON.parse(json) as unknown }
}
