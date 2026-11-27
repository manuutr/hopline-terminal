/// <reference path="./ssh2-internals.d.ts" />
/**
 * Legacy SSH algorithms that ssh2 advertises but that break under Electron's BoringSSL.
 *
 * - `diffie-hellman-group1-sha1`: ssh2 calls `crypto.createDiffieHellmanGroup('modp2')`, and
 *   BoringSSL has no named modp2 group ("Unknown DH group"). We hook the connection's key-exchange
 *   slot and pre-seed the exchange with `createDiffieHellman(<explicit Oakley group 2 prime>, 2)`,
 *   which BoringSSL supports. This is per connection, with no global `crypto` mutation, and it runs
 *   the same way in Node and Electron.
 * - `ssh-dss` host keys: BoringSSL has no DSA (`crypto.verify` throws and `createVerify` returns
 *   false). We wrap ssh2's shared key prototype so `ssh-dss` signatures go through a small BigInt
 *   verifier (./dsa.ts). It is installed once, idempotently, and only after a self-test passes.
 *
 * Both shims fail closed. If ssh2's internals don't look the way we expect, the algorithm is simply
 * not offered, instead of being negotiated and then crashing inside ssh2's socket handler.
 */
import { createDiffieHellman } from 'node:crypto'
import { Duplex } from 'node:stream'
import ssh2 from 'ssh2'
import type { Algorithms, Client } from 'ssh2'
import constants from 'ssh2/lib/protocol/constants.js'
import { verifySshDss } from './dsa.ts'

/** RFC 2409 section 6.2 (Oakley Group 2), the group `diffie-hellman-group1-sha1` uses (RFC 4253 8.1). */
export const OAKLEY_GROUP2_PRIME = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF',
  'hex'
)

/** Counters so tests and the Electron smoke script can prove the shims ran (not native code). */
export const legacyStats = { group1Exchanges: 0, dssVerifications: 0 }

// A public ssh-dss key and its signature over SELFTEST_DATA (generated once, in Node, from a
// throwaway key). It is used to prove the patched verifier works end-to-end before ssh-dss is offered.
const SELFTEST_PUB =
  'ssh-dss AAAAB3NzaC1kc3MAAACBAMY2GN47ByUqMeS4G3fPp7TxKygkZdnXiOqN1Hzqp/QrTUkm4Z/Iodoq1NGlu52Pp0LbcAu6rAgXqpR9J75pxf3wE5v3+IiXQ7+0HGaIsDkAdOkhzU0hxU0dzDy4ZC86LpXj144fB2KI5YcuNoEciA5o6+jcqGoe2jlaiZ1VPJUfAAAAFQCW9+DD7BE5A5SCSrT05Crqv5s2SwAAAIA5i4IETDzE3o5ahGbbNmE2vIQYonzfQ3o7t5I9SLSiKFAIy/x6ippeKKj7yO+5dcFdEPcF6Wj+s65bCNq3PdZN8n1sIG17eWye03qLEh+3RZ5GLGnGqZDv93SKJmnCML4mWbdOgKOENlrgQw6TCFL14q+6vb6KHXGIZFSdivKulQAAAIAVeK5MeAnphzroNE7pZ+LGTbojj++QGr7Iy8kXrOWH3cCEq9tTsQdHxHuFkJFZ2sVe0HNjdOTlKDNPeaWK2mrtdaaEKv8psrZNFmZX1D0I2nadGeH+MxuKIuY2QtHmFdZKAyRs/xcMVR04mclPkqJuFDkwcREFDAGVYCgM2Mgl9Q=='
const SELFTEST_SIG = 'MC0CFAvba8ILFjGhcIRZGeEM/0XspFkhAhUAgitexkmrnrq7Rwqb/Xbona17woE='
const SELFTEST_DATA = 'hopline ssh-dss self-test'

const PATCHED = Symbol.for('hopline.ssh-dss-verifier')

type VerifyFn = (this: KeyLike, data: Buffer, signature: Buffer, algo?: string) => boolean | Error
interface KeyLike {
  type: string
  getPublicSSH(): Buffer
}
interface KeyProto {
  verify: VerifyFn
  getPublicSSH: () => Buffer
  [PATCHED]?: true
}

let dssReady: boolean | undefined

/** Route ssh-dss signature verification through the BigInt verifier. Idempotent. */
export function installDsaVerifier(): boolean {
  if (dssReady !== undefined) return dssReady
  dssReady = false
  try {
    const parsed = ssh2.utils.parseKey(SELFTEST_PUB)
    if (parsed instanceof Error) return false
    const sample = (Array.isArray(parsed) ? parsed[0] : parsed) as unknown as KeyLike & { verify: VerifyFn }
    const proto = Object.getPrototypeOf(sample) as KeyProto | null
    if (!proto || typeof proto.verify !== 'function' || typeof proto.getPublicSSH !== 'function') return false
    if (!proto[PATCHED]) {
      const original = proto.verify
      proto.verify = function verify(this: KeyLike, data, signature, algo) {
        if (this.type === 'ssh-dss' && (!algo || algo === 'sha1')) {
          legacyStats.dssVerifications++
          return verifySshDss(this.getPublicSSH(), data, signature)
        }
        return original.call(this, data, signature, algo)
      }
      proto[PATCHED] = true
    }
    const data = Buffer.from(SELFTEST_DATA)
    const sig = Buffer.from(SELFTEST_SIG, 'base64')
    const good = sample.verify(data, sig) === true
    const tampered = Buffer.from(sig)
    tampered[tampered.length - 1]! ^= 1
    const bad = sample.verify(data, tampered) === false
    legacyStats.dssVerifications -= 2
    dssReady = good && bad
  } catch {
    dssReady = false
  }
  return dssReady
}

interface KexLike {
  groupName?: unknown
  _dh?: unknown
  _public?: unknown
}

/**
 * Hook one client's key-exchange slot so a negotiated group1 exchange uses the explicit prime.
 * Call right after `client.connect()`: ssh2 creates `client._protocol` synchronously there, and the
 * key exchange object is only assigned once the server's KEXINIT arrives (asynchronously).
 */
export function hookGroup1(client: Client): boolean {
  const proto = (client as unknown as { _protocol?: object })._protocol
  if (!proto) return false
  const desc = Object.getOwnPropertyDescriptor(proto, '_kex')
  if (!desc || !('value' in desc) || !desc.writable || !desc.configurable) return false
  let current: unknown = desc.value
  Object.defineProperty(proto, '_kex', {
    configurable: true,
    enumerable: desc.enumerable ?? true,
    get: () => current,
    set: (v: unknown) => {
      const kex = v as KexLike | undefined
      if (kex && kex.groupName === 'modp2' && !kex._dh) {
        const dh = createDiffieHellman(OAKLEY_GROUP2_PRIME, 2)
        kex._public = dh.generateKeys()
        kex._dh = dh
        legacyStats.group1Exchanges++
      }
      current = v
    }
  })
  return true
}

let group1Ready: boolean | undefined

/** Check once, on a throwaway client over a dead-end stream, that ssh2's internals match. */
export function group1HookAvailable(): boolean {
  if (group1Ready !== undefined) return group1Ready
  const client = new ssh2.Client()
  client.on('error', () => {})
  const sock = new Duplex({ read() {}, write(_c, _e, cb) { cb() } })
  try {
    client.connect({ sock, username: 'probe', readyTimeout: 0 })
    group1Ready = hookGroup1(client)
  } catch {
    group1Ready = false
  } finally {
    try {
      client.end()
    } catch {
      /* ignore */
    }
    sock.destroy()
  }
  return group1Ready
}

export interface LegacySupport {
  group1: boolean
  dss: boolean
}

export function legacySupport(): LegacySupport {
  return { group1: group1HookAvailable(), dss: installDsaVerifier() }
}

/** Legacy algorithms, appended after ssh2's modern defaults (lowest preference). */
export const LEGACY = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc', 'blowfish-cbc', 'arcfour256', 'arcfour128'],
  hmac: ['hmac-sha1', 'hmac-sha1-96', 'hmac-md5', 'hmac-md5-96']
} as const

/**
 * ssh2 `algorithms` that append the legacy lists, keeping only what this runtime supports (ssh2
 * throws on unsupported names, and e.g. blowfish exists in Electron but not in Node 24).
 */
export function legacyAlgorithms(support: LegacySupport = legacySupport()): Algorithms {
  const keep = (list: readonly string[], supported: string[]) => list.filter((a) => supported.includes(a))
  const kex = keep(LEGACY.kex, constants.SUPPORTED_KEX).filter((a) => support.group1 || a !== 'diffie-hellman-group1-sha1')
  const hostKey = keep(LEGACY.serverHostKey, constants.SUPPORTED_SERVER_HOST_KEY).filter((a) => support.dss || a !== 'ssh-dss')
  const op = <T>(append: T[]) => ({ append, prepend: [] as T[], remove: [] as T[] })
  return {
    kex: op(kex),
    serverHostKey: op(hostKey),
    cipher: op(keep(LEGACY.cipher, constants.SUPPORTED_CIPHER)),
    hmac: op(keep(LEGACY.hmac, constants.SUPPORTED_MAC))
  } as Algorithms
}

/** Names in a negotiated algorithm set that are legacy (for "legacy algorithm X negotiated" notices). */
export function legacyNegotiated(n: {
  kex: string
  srvHostKey?: string
  serverHostKey?: string
  cs: { cipher: string; mac: string }
  sc: { cipher: string; mac: string }
}): string[] {
  const all: readonly string[] = [...LEGACY.kex, ...LEGACY.serverHostKey, ...LEGACY.cipher, ...LEGACY.hmac]
  const names = [n.kex, n.srvHostKey ?? n.serverHostKey ?? '', n.cs.cipher, n.sc.cipher, n.cs.mac, n.sc.mac]
  return [...new Set(names.filter((a) => all.includes(a)))]
}
