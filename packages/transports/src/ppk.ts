import ssh2, { type ParsedKey } from 'ssh2'
import { argon2d as nobleArgon2d, argon2i as nobleArgon2i, argon2id as nobleArgon2id } from '@noble/hashes/argon2.js'
import * as nodeCrypto from 'node:crypto'
import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
const argon2Sync = (nodeCrypto as { argon2Sync?: typeof nodeCrypto.argon2Sync }).argon2Sync

/**
 * PuTTY private key files (PPK v2 and v3, PuTTY manual appendix C) → OpenSSH private key text.
 *
 * ssh2 only reads PPK v2 RSA/DSA keys. This reads v2 and v3 for RSA, DSA, ECDSA and Ed25519,
 * verifies the MAC (which is also how a wrong passphrase shows), and re-encodes the key as an
 * unencrypted "openssh-key-v1" key that ssh2 parses. The result is a decrypted private key: keep
 * it in memory or under the vault, never on disk in clear.
 */
export interface PpkInfo {
  version: 2 | 3
  keyType: string
  encrypted: boolean
  comment: string
  /** SSH wire-format public key (always readable, even when the private part is encrypted). */
  publicBlob: Buffer
}

export class PpkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PpkError'
  }
}

export const isPpk = (text: string): boolean => /^PuTTY-User-Key-File-[23]:/.test(text.trimStart())

interface Parsed extends PpkInfo {
  encryption: string
  headers: Map<string, string>
  privateBlob: Buffer
  mac: Buffer
  /** Encrypted v3 only, validated against PPK_ARGON2_LIMITS. */
  kdf?: Kdf
}

interface Kdf {
  algo: 'argon2id' | 'argon2i' | 'argon2d'
  memory: number
  passes: number
  parallelism: number
  salt: Buffer
}

function parse(text: string): Parsed {
  const lines = text.replace(/\r\n?/g, '\n').trimStart().split('\n')
  const headers = new Map<string, string>()
  let pub: Buffer | null = null
  let priv: Buffer | null = null
  let version: 2 | 3 | null = null
  let keyType = ''
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):\s?(.*)$/.exec(lines[i]!)
    if (!m) continue
    const [, k, v] = m as unknown as [string, string, string]
    if (/^PuTTY-User-Key-File-([23])$/.test(k)) {
      version = Number(k.slice(-1)) as 2 | 3
      keyType = v.trim()
      continue
    }
    if (k === 'Public-Lines' || k === 'Private-Lines') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new PpkError('Invalid PPK file')
      const b = Buffer.from(lines.slice(i + 1, i + 1 + n).join(''), 'base64')
      if (k === 'Public-Lines') pub = b
      else priv = b
      i += n
      continue
    }
    headers.set(k, v.trim())
  }
  if (!version || !keyType || !pub || !priv || !headers.has('Private-MAC') || !headers.has('Encryption')) throw new PpkError('Invalid PPK file')
  const encryption = headers.get('Encryption')!
  if (encryption !== 'none' && encryption !== 'aes256-cbc') throw new PpkError(`Unsupported PPK encryption ${encryption}`)
  // Checked here, not at derivation time, so every entry point (ppkInfo too) rejects a hostile file.
  const kdf = version === 3 && encryption !== 'none' ? parseKdf(headers) : undefined
  return {
    kdf,
    version,
    keyType,
    encryption,
    encrypted: encryption !== 'none',
    comment: headers.get('Comment') ?? '',
    publicBlob: pub,
    privateBlob: priv,
    mac: Buffer.from(headers.get('Private-MAC')!, 'hex'),
    headers
  }
}

export function ppkInfo(text: string): PpkInfo {
  const { version, keyType, encrypted, comment, publicBlob } = parse(text)
  return { version, keyType, encrypted, comment, publicBlob }
}

const str = (b: Buffer | string): Buffer => {
  const body = typeof b === 'string' ? Buffer.from(b) : b
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  return Buffer.concat([len, body])
}

/** Reads consecutive SSH strings/mpints, returning the raw bytes of each (without the length). */
function reader(b: Buffer) {
  let o = 0
  return {
    next(): Buffer {
      if (o + 4 > b.length) throw new PpkError('Truncated PPK key data')
      const n = b.readUInt32BE(o)
      if (o + 4 + n > b.length) throw new PpkError('Truncated PPK key data')
      const v = b.subarray(o + 4, o + 4 + n)
      o += 4 + n
      return v
    }
  }
}

function keys(p: Parsed, passphrase: string | undefined): { cipherKey: Buffer; iv: Buffer; macKey: Buffer; hash: 'sha1' | 'sha256' } {
  const pass = Buffer.from(passphrase ?? '', 'utf8')
  if (p.version === 2) {
    const cipherKey = Buffer.concat([
      createHash('sha1').update(Buffer.from([0, 0, 0, 0])).update(pass).digest(),
      createHash('sha1').update(Buffer.from([0, 0, 0, 1])).update(pass).digest()
    ]).subarray(0, 32)
    const macKey = createHash('sha1').update('putty-private-key-file-mac-key').update(p.encrypted ? pass : Buffer.alloc(0)).digest()
    return { cipherKey, iv: Buffer.alloc(16), macKey, hash: 'sha1' }
  }
  if (!p.encrypted) return { cipherKey: Buffer.alloc(0), iv: Buffer.alloc(0), macKey: Buffer.alloc(0), hash: 'sha256' }
  const { algo, salt, ...o } = p.kdf!
  const out = argon2(algo, pass, salt, o)
  return { cipherKey: out.subarray(0, 32), iv: out.subarray(32, 48), macKey: out.subarray(48, 80), hash: 'sha256' }
}

/**
 * Argon2 cost caps for PPK v3. PuTTY's defaults are 8 MiB with passes auto-tuned to about 100 ms;
 * these leave room for tuned keys while a hostile file can't make us allocate gigabytes or spin for
 * minutes (Electron runs the pure-JS fallback, at roughly 1 s per 64 MiB pass). The memory × passes
 * budget is what bounds the work; the passes cap only has to stay above what PuTTYgen picks.
 */
export const PPK_ARGON2_LIMITS = {
  /** KiB (256 MiB). */
  maxMemoryKiB: 256 * 1024,
  /** PuTTYgen's auto-tuning steps through Fibonacci numbers (…, 21, 34, 55): 32 would reject default keys made on fast machines. */
  maxPasses: 64,
  maxParallelism: 16,
  /** Memory × passes, in KiB·passes (1 GiB·pass). */
  maxMemoryTimesPasses: 1024 * 1024
} as const

const ARGON2_ALGOS = new Map([
  ['Argon2id', 'argon2id'],
  ['Argon2i', 'argon2i'],
  ['Argon2d', 'argon2d']
] as const)

/** Read and bound the v3 key-derivation headers. Error messages never say "passphrase": that word means "ask for one". */
function parseKdf(headers: Map<string, string>): Kdf {
  const name = headers.get('Key-Derivation') ?? ''
  const algo = ARGON2_ALGOS.get(name as 'Argon2id')
  if (!algo) throw new PpkError(`Unsupported PPK key derivation ${name || '(none)'}`)
  const int = (k: string) => {
    const v = headers.get(k) ?? ''
    if (!/^\d{1,10}$/.test(v)) throw new PpkError(`Unsupported PPK key derivation: invalid ${k}`)
    return Number(v)
  }
  const memory = int('Argon2-Memory')
  const passes = int('Argon2-Passes')
  const parallelism = int('Argon2-Parallelism')
  const saltHex = headers.get('Argon2-Salt') ?? ''
  const L = PPK_ARGON2_LIMITS
  const over = (what: string) => new PpkError(`Unsupported PPK key derivation: ${what} is over Hopline's limit`)
  if (parallelism < 1) throw new PpkError('Unsupported PPK key derivation: invalid Argon2-Parallelism')
  if (passes < 1) throw new PpkError('Unsupported PPK key derivation: invalid Argon2-Passes')
  // Argon2 needs at least 8 KiB per lane.
  if (memory < 8 * parallelism) throw new PpkError('Unsupported PPK key derivation: invalid Argon2-Memory')
  if (parallelism > L.maxParallelism) throw over(`parallelism ${parallelism} (max ${L.maxParallelism})`)
  if (memory > L.maxMemoryKiB) throw over(`memory ${memory} KiB (max ${L.maxMemoryKiB} KiB)`)
  if (passes > L.maxPasses) throw over(`${passes} passes (max ${L.maxPasses})`)
  if (memory * passes > L.maxMemoryTimesPasses) throw over(`memory × passes ${memory * passes} KiB (max ${L.maxMemoryTimesPasses} KiB)`)
  if (!/^(?:[0-9a-f]{2}){8,64}$/i.test(saltHex)) throw new PpkError('Unsupported PPK key derivation: invalid Argon2-Salt')
  return { algo, memory, passes, parallelism, salt: Buffer.from(saltHex, 'hex') }
}

/**
 * Argon2 with an 80-byte tag. Node's OpenSSL build has it natively; Electron's BoringSSL does not
 * ("Argon2 algorithm not supported"), so fall back to the audited pure-JS @noble/hashes version.
 */
export function argon2(algo: 'argon2id' | 'argon2i' | 'argon2d', pass: Buffer, salt: Buffer, o: { parallelism: number; memory: number; passes: number }, native = true): Buffer {
  if (native && typeof argon2Sync === 'function') {
    try {
      return argon2Sync(algo, { message: pass, nonce: salt, parallelism: o.parallelism, tagLength: 80, memory: o.memory, passes: o.passes })
    } catch {
      // Not in this crypto build: use the JS implementation below.
    }
  }
  const f = { argon2id: nobleArgon2id, argon2i: nobleArgon2i, argon2d: nobleArgon2d }[algo]
  return Buffer.from(f(pass, salt, { t: o.passes, m: o.memory, p: o.parallelism, dkLen: 80 }))
}

/** Decrypt and verify. Throws a PpkError whose message mentions "passphrase" when one is needed or wrong. */
function decryptPrivate(p: Parsed, passphrase: string | undefined): Buffer {
  if (p.encrypted && !passphrase) throw new PpkError('Encrypted PPK private key detected, but no passphrase given')
  const k = keys(p, passphrase)
  let plain = p.privateBlob
  if (p.encrypted) {
    if (plain.length % 16) throw new PpkError('Invalid PPK private data length')
    const d = createDecipheriv('aes-256-cbc', k.cipherKey, k.iv)
    d.setAutoPadding(false)
    plain = Buffer.concat([d.update(plain), d.final()])
  }
  const mac = createHmac(k.hash, k.macKey)
    .update(Buffer.concat([str(p.keyType), str(p.encryption), str(p.comment), str(p.publicBlob), str(plain)]))
    .digest()
  if (mac.length !== p.mac.length || !timingSafeEqual(mac, p.mac))
    throw new PpkError(p.encrypted ? 'Wrong passphrase for PPK private key (bad key MAC)' : 'PPK private key is corrupt (bad MAC)')
  return plain
}

/** The private fields in OpenSSH order for the private section of an openssh-key-v1 file. */
function opensshFields(keyType: string, pub: Buffer, priv: Buffer): Buffer[] {
  const P = reader(pub)
  const S = reader(priv)
  if (P.next().toString() !== keyType) throw new PpkError('PPK public key type mismatch')
  switch (true) {
    case keyType === 'ssh-rsa': {
      const e = P.next()
      const n = P.next()
      const [d, p, q, iqmp] = [S.next(), S.next(), S.next(), S.next()]
      return [n, e, d, iqmp, p, q]
    }
    case keyType === 'ssh-dss': {
      const [p, q, g, y] = [P.next(), P.next(), P.next(), P.next()]
      return [p, q, g, y, S.next()]
    }
    case keyType.startsWith('ecdsa-sha2-'): {
      const curve = P.next()
      const point = P.next()
      return [curve, point, S.next()]
    }
    case keyType === 'ssh-ed25519': {
      const pk = P.next()
      const seed = S.next()
      if (pk.length !== 32 || seed.length !== 32) throw new PpkError('Invalid Ed25519 key in PPK file')
      return [pk, Buffer.concat([seed, pk])]
    }
    default:
      throw new PpkError(`Unsupported PPK key type ${keyType}`)
  }
}

/** Convert a PPK v2/v3 private key to unencrypted OpenSSH private key text. */
export function ppkToOpenSsh(text: string, passphrase?: string): string {
  const p = parse(text)
  const plain = decryptPrivate(p, passphrase)
  const fields = opensshFields(p.keyType, p.publicBlob, plain)
  const check = randomBytes(4)
  let section = Buffer.concat([check, check, str(p.keyType), ...fields.map(str), str(p.comment)])
  const pad = (8 - (section.length % 8)) % 8
  section = Buffer.concat([section, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])
  const nkeys = Buffer.alloc(4)
  nkeys.writeUInt32BE(1)
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(Buffer.alloc(0)), nkeys, str(p.publicBlob), str(section)])
  const b64 = body.toString('base64').replace(/.{1,70}/g, '$&\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`
}

/**
 * ssh2's parseKey, plus PPK v2/v3 for every key type. Returns an Error (never throws) like ssh2,
 * with "passphrase" in the message when the key is encrypted and the passphrase is missing or wrong.
 */
export function parsePrivateKey(text: string, passphrase?: string): ParsedKey | ParsedKey[] | Error {
  if (isPpk(text)) {
    try {
      return ssh2.utils.parseKey(ppkToOpenSsh(text, passphrase))
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }
  return ssh2.utils.parseKey(text, passphrase)
}
