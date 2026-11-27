import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Bulk data (scrollback, config backups, exports) and secrets are encrypted with AES-256-GCM under
 * one random data key. Only that 32-byte key is sealed by the OS keychain or wrapped with a master
 * password, so large blobs never go through the keychain and the key can be re-wrapped without
 * re-encrypting anything.
 */
const VERSION = 1

export interface KeyStore {
  /** The sealed data key, if one was created before. */
  load(): Buffer | null
  save(sealed: Buffer): void
  seal(plain: Buffer): Promise<Buffer>
  unseal(sealed: Buffer): Promise<Buffer>
}

/** The key is not in memory (master-password vault locked). Callers degrade: prompt, skip or ask to unlock. */
export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked. Unlock it with your master password.')
    this.name = 'VaultLockedError'
  }
}

export const isLocked = (e: unknown): boolean => e instanceof VaultLockedError

export class DataKey {
  private key: Promise<Buffer> | null = null

  /**
   * With a store, the key is loaded (or created once) on first use: OS keychain mode.
   * Without one, the key exists only after `setKey`, and use before that throws VaultLockedError.
   */
  constructor(private readonly store?: KeyStore) {}

  private get(): Promise<Buffer> {
    if (this.key) return this.key
    const store = this.store
    if (!store) return Promise.reject(new VaultLockedError())
    this.key = (async () => {
      const sealed = store.load()
      if (sealed) return store.unseal(sealed)
      const fresh = randomBytes(32)
      store.save(await store.seal(fresh))
      return fresh
    })().catch((e) => {
      this.key = null
      throw e
    })
    return this.key
  }

  /** Put an unwrapped key in memory (unlock). */
  setKey(key: Buffer): void {
    if (key.length !== 32) throw new Error('data key must be 32 bytes')
    this.key = Promise.resolve(Buffer.from(key))
  }

  /** Drop the key from memory. Without a store, every use after this throws VaultLockedError. */
  lock(): void {
    const k = this.key
    this.key = null
    void k?.then((b) => b.fill(0)).catch(() => {})
  }

  get unlocked(): boolean {
    return this.key !== null || !!this.store
  }

  /** Main process only: the raw key, to re-wrap it for another vault mode. Never log or send it. */
  async raw(): Promise<Buffer> {
    return Buffer.from(await this.get())
  }

  /** version(1) | iv(12) | tag(16) | ciphertext. `aad` binds the blob to its purpose/owner. */
  async encrypt(plain: Buffer, aad: string): Promise<Buffer> {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', await this.get(), iv)
    c.setAAD(Buffer.from(aad))
    const body = Buffer.concat([c.update(plain), c.final()])
    return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body])
  }

  async decrypt(blob: Buffer, aad: string): Promise<Buffer> {
    if (blob.length < 29 || blob[0] !== VERSION) throw new Error('unsupported encrypted blob')
    const d = createDecipheriv('aes-256-gcm', await this.get(), blob.subarray(1, 13))
    d.setAAD(Buffer.from(aad))
    d.setAuthTag(blob.subarray(13, 29))
    return Buffer.concat([d.update(blob.subarray(29)), d.final()])
  }
}

/** Process-lifetime key store for tests: nothing persists, nothing is sealed. */
export function memoryKeyStore(): KeyStore {
  let sealed: Buffer | null = null
  return { load: () => sealed, save: (b) => void (sealed = b), seal: async (p) => p, unseal: async (b) => b }
}
