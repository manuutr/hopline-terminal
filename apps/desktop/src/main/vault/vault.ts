import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { VaultInfo, VaultMode } from '@shared/types'
import { DataKey } from './datakey'
import { DEFAULT_SCRYPT, unwrapKey, wrapKey, WrongPasswordError, type ScryptParams, type WrappedKey } from './kdf'

/** The OS keychain as the vault sees it (safeStorage in the app, a fake in tests and e2e). */
export interface Keychain {
  /** False on Linux without a keyring (basic_text) or when the OS refuses. */
  available(): Promise<boolean>
  backend(): string
  seal(plain: Buffer): Promise<Buffer>
  unseal(sealed: Buffer): Promise<Buffer>
}

export interface VaultDeps {
  settings: { getSetting(k: string): string | undefined; setSetting(k: string, v: string | null): void }
  keychain: Keychain
  kdf?: ScryptParams
  now?: () => number
  /**
   * Polled by the auto-lock timer: true while the OS reports the screen as locked. Covers systems
   * where no lock-screen event fires (Linux), as far as the OS reports it at all.
   */
  screenLocked?: () => boolean
}

const K = {
  mode: 'vault_mode',
  sealed: 'data_key_sealed',
  master: 'data_key_master',
  autoLock: 'vault_autolock_min'
} as const

export const MIN_PASSWORD = 8
const DEFAULT_AUTOLOCK_MIN = 15
/** Wrong master passwords allowed in a row before each further one adds a delay (P8 C-L6). */
const FREE_TRIES = 5
const MAX_BACKOFF_MS = 5 * 60_000

/**
 * Owns the data key (DEK) and how it is protected at rest:
 * - keychain: sealed with the OS keychain (safeStorage); always unlocked.
 * - master:   wrapped with a scrypt key from the master password; locked at startup, after
 *             `autoLockMin` idle minutes, or on demand. Locking drops the key from memory.
 * - session:  never persisted; secrets saved this run are gone after a restart.
 * Switching modes re-wraps the same DEK, so nothing encrypted under it is lost.
 *
 * Events: 'change' (VaultInfo) whenever mode or lock state changes; 'ephemeral' when a session-mode
 * start means every secret blob on disk was written under a key that no longer exists.
 */
export class Vault extends EventEmitter {
  readonly key = new DataKey()
  private mode: VaultMode = 'session'
  private chosen = false
  private keychainOk = false
  private brokenKeychain = false
  private lastActivity = 0
  private timer: ReturnType<typeof setInterval> | null = null
  /** Wrong master passwords in a row, and when the next try is allowed (P8 C-L6). */
  private failures = 0
  private blockedUntil = 0

  constructor(private readonly deps: VaultDeps) {
    super()
  }

  private get s() {
    return this.deps.settings
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
  private master(): WrappedKey | null {
    const raw = this.s.getSetting(K.master)
    if (!raw) return null
    try {
      return JSON.parse(raw) as WrappedKey
    } catch {
      // A damaged record still means "the user chose a master password": stay locked, never fall
      // back to session mode (unwrapKey reports it as unsupported).
      return {} as WrappedKey
    }
  }

  /**
   * Every master-password check goes through here. After FREE_TRIES wrong passwords in a row, each
   * further one makes the next try wait (1 s, doubling, at most 5 min), kept in main: a compromised
   * renderer can't guess online faster than that (P8 C-L6). A right password resets the count.
   */
  private async unwrapChecked(w: WrappedKey, password: string): Promise<Buffer> {
    const wait = this.blockedUntil - this.now()
    if (wait > 0) throw new Error(`Too many wrong master passwords. Try again in ${Math.ceil(wait / 1000)} s.`)
    try {
      const k = await unwrapKey(w, password)
      this.failures = 0
      this.blockedUntil = 0
      return k
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        this.failures++
        if (this.failures >= FREE_TRIES) this.blockedUntil = this.now() + Math.min(1000 * 2 ** (this.failures - FREE_TRIES), MAX_BACKOFF_MS)
      }
      throw e
    }
  }

  /** Master mode: check `current` against the stored record (always, even while unlocked). Caller zeroes the result. */
  private async verifyCurrent(current: string | undefined, what: string): Promise<Buffer> {
    const w = this.master()
    if (!w) throw new Error('No master password is set')
    if (!current) throw new Error(`Enter your current master password to ${what}`)
    return this.unwrapChecked(w, current)
  }

  /** Put an unwrapped/unsealed key in memory and wipe the caller's copy. */
  private adopt(k: Buffer): void {
    try {
      this.key.setKey(k)
    } finally {
      k.fill(0)
    }
  }

  async init(): Promise<void> {
    this.keychainOk = await this.deps.keychain.available().catch(() => false)
    const stored = this.s.getSetting(K.mode) as VaultMode | undefined
    // A persisted master-password record wins over everything: the user chose it.
    if (this.master()) {
      this.mode = 'master'
      this.chosen = true
    } else if (stored === 'session') {
      this.mode = 'session'
      this.chosen = true
      this.key.setKey(randomBytes(32))
      this.emit('ephemeral')
    } else if (this.keychainOk) {
      this.mode = 'keychain'
      this.chosen = true
      const sealed = this.s.getSetting(K.sealed)
      if (sealed) {
        try {
          this.adopt(await this.deps.keychain.unseal(Buffer.from(sealed, 'base64')))
        } catch (e) {
          // The keyring answers but won't unseal (denied, reset, wrong login): locked, never wiped.
          console.warn('[hopline] the OS keychain could not unseal the data key:', (e as Error).message)
          this.brokenKeychain = true
        }
      } else {
        const fresh = randomBytes(32)
        this.s.setSetting(K.sealed, (await this.deps.keychain.seal(fresh)).toString('base64'))
        this.adopt(fresh)
      }
      this.s.setSetting(K.mode, 'keychain')
    } else if ((stored === 'keychain' || stored === undefined) && this.s.getSetting(K.sealed)) {
      // The keychain worked before and doesn't now: keep everything on disk, stay locked, never wipe.
      // No vault_mode at all is a v0.2.0 profile, which only ever had keychain mode: same thing,
      // never "no choice made yet" (that path would discard the data key).
      this.mode = 'keychain'
      this.chosen = true
      this.brokenKeychain = true
    } else {
      // No keyring and no choice made yet: session-only until the user sets a master password.
      this.mode = 'session'
      this.chosen = false
      this.key.setKey(randomBytes(32))
      this.emit('ephemeral')
    }
    this.lastActivity = this.now()
  }

  info(): VaultInfo {
    return {
      mode: this.mode,
      locked: !this.key.unlocked,
      chosen: this.chosen,
      keychainAvailable: this.keychainOk,
      keychainBroken: this.brokenKeychain,
      backend: this.deps.keychain.backend(),
      autoLockMin: this.autoLockMin(),
      persistent: this.mode !== 'session'
    }
  }

  private changed(): void {
    this.emit('change', this.info())
  }

  autoLockMin(): number {
    const v = Number(this.s.getSetting(K.autoLock) ?? DEFAULT_AUTOLOCK_MIN)
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_AUTOLOCK_MIN
  }

  /**
   * Master mode: needs the current password even while unlocked (an unattended unlocked app must
   * not be able to switch auto-lock off). `confirm` runs after that check, only to turn it off.
   */
  async setAutoLock(min: number, opts: { current?: string; confirm?: () => Promise<boolean> } = {}): Promise<VaultInfo> {
    const v = Math.max(0, Math.min(24 * 60, Math.round(min)))
    if (this.mode === 'master') {
      ;(await this.verifyCurrent(opts.current, 'change auto-lock')).fill(0)
      if (v === 0 && this.autoLockMin() !== 0 && opts.confirm && !(await opts.confirm())) return this.info()
    }
    this.s.setSetting(K.autoLock, String(v))
    this.changed()
    return this.info()
  }

  async unlock(password: string): Promise<VaultInfo> {
    const w = this.master()
    if (!w) throw new Error('No master password is set')
    if (!this.key.unlocked) this.adopt(await this.unwrapChecked(w, password))
    this.lastActivity = this.now()
    this.changed()
    return this.info()
  }

  /** Master mode only. Open sessions keep running: their credentials already live in the session host. */
  lock(): VaultInfo {
    if (this.mode === 'master' && this.key.unlocked) {
      this.key.lock()
      this.changed()
    }
    return this.info()
  }

  /** User activity (renderer input, vault use): pushes the auto-lock deadline back. */
  touch(): void {
    this.lastActivity = this.now()
  }

  /** Call periodically: locks once the vault has been idle for autoLockMin minutes. */
  tick(): void {
    const min = this.autoLockMin()
    if (this.mode !== 'master' || !this.key.unlocked) return
    if ((min > 0 && this.now() - this.lastActivity >= min * 60_000) || this.deps.screenLocked?.()) this.lock()
  }

  startAutoLock(everyMs = 15_000): void {
    this.timer ??= setInterval(() => this.tick(), everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Switch how the DEK is protected. The DEK itself stays the same (re-wrap only).
   * - from master (to anything, including a new master password): always needs `current`, which is
   *   verified against the stored record even while unlocked.
   * - to master: needs `password` (new).
   * - to keychain: needs a working keychain.
   * - to session: the wrapped copies are deleted; secrets survive only until quit.
   * `confirm` runs after every check and before anything changes; false leaves everything as it was.
   */
  async setMode(to: VaultMode, opts: { password?: string; current?: string; confirm?: () => Promise<boolean> } = {}): Promise<VaultInfo> {
    if (this.brokenKeychain) throw new Error('The OS keychain that protects your data key is not available right now')
    if (to === 'master' && (!opts.password || opts.password.length < MIN_PASSWORD)) throw new Error(`The master password needs at least ${MIN_PASSWORD} characters`)
    let dek: Buffer
    if (this.mode === 'master') {
      dek = await this.verifyCurrent(opts.current, 'change how secrets are protected')
      if (!this.key.unlocked) this.key.setKey(dek)
    } else dek = await this.key.raw()
    try {
      if (to === 'keychain' && !(await this.deps.keychain.available())) throw new Error('No secure OS keychain on this machine')
      if (opts.confirm && !(await opts.confirm())) return this.info()
      if (to === 'master') {
        const w = await wrapKey(dek, opts.password!, this.deps.kdf ?? DEFAULT_SCRYPT)
        this.s.setSetting(K.master, JSON.stringify(w))
        this.s.setSetting(K.sealed, null)
      } else if (to === 'keychain') {
        this.s.setSetting(K.sealed, (await this.deps.keychain.seal(dek)).toString('base64'))
        this.s.setSetting(K.master, null)
      } else {
        this.s.setSetting(K.sealed, null)
        this.s.setSetting(K.master, null)
      }
      this.s.setSetting(K.mode, to)
      this.mode = to
      this.chosen = true
      this.lastActivity = this.now()
    } finally {
      dek.fill(0)
    }
    this.changed()
    return this.info()
  }

  /** Broken keychain: try to unseal again (the keyring was unlocked, the daemon came back…). */
  async retryKeychain(): Promise<VaultInfo> {
    if (!this.brokenKeychain) return this.info()
    const sealed = this.s.getSetting(K.sealed)
    this.keychainOk = await this.deps.keychain.available().catch(() => false)
    if (!sealed) throw new Error('No sealed data key is stored')
    if (!this.keychainOk) {
      this.changed()
      throw new Error(`The OS keychain is still not available (${this.deps.keychain.backend()})`)
    }
    try {
      this.adopt(await this.deps.keychain.unseal(Buffer.from(sealed, 'base64')))
    } catch (e) {
      throw new Error(`The OS keychain still cannot unseal the data key: ${(e as Error).message}`)
    }
    this.brokenKeychain = false
    this.mode = 'keychain'
    this.chosen = true
    this.s.setSetting(K.mode, 'keychain')
    this.lastActivity = this.now()
    this.changed()
    return this.info()
  }

  /**
   * Broken keychain, give up on it: a fresh data key under a new master password. Everything
   * encrypted under the old key (stored passwords, keys, passphrases, the API key, NetBox token,
   * sync passphrase, terminal history) is unreadable from here on; 'ephemeral' tells main to drop it.
   * Sessions, folders, settings and host keys are kept.
   */
  async resetToMaster(password: string, confirm?: () => Promise<boolean>): Promise<VaultInfo> {
    if (!this.brokenKeychain) throw new Error('The OS keychain works: switch modes in Settings → Security instead')
    if (password.length < MIN_PASSWORD) throw new Error(`The master password needs at least ${MIN_PASSWORD} characters`)
    if (confirm && !(await confirm())) return this.info()
    const fresh = randomBytes(32)
    try {
      this.s.setSetting(K.master, JSON.stringify(await wrapKey(fresh, password, this.deps.kdf ?? DEFAULT_SCRYPT)))
      this.s.setSetting(K.sealed, null)
      this.s.setSetting(K.mode, 'master')
      this.key.setKey(fresh)
    } finally {
      fresh.fill(0)
    }
    this.mode = 'master'
    this.chosen = true
    this.brokenKeychain = false
    this.lastActivity = this.now()
    this.emit('ephemeral')
    this.changed()
    return this.info()
  }

  async changePassword(current: string, next: string): Promise<VaultInfo> {
    const w = this.master()
    if (!w || this.mode !== 'master') throw new Error('No master password is set')
    if (next.length < MIN_PASSWORD) throw new Error(`The master password needs at least ${MIN_PASSWORD} characters`)
    // Always verify the current password, even when unlocked: an unattended unlocked app can't be re-keyed.
    const dek = await this.unwrapChecked(w, current)
    try {
      this.s.setSetting(K.master, JSON.stringify(await wrapKey(dek, next, this.deps.kdf ?? DEFAULT_SCRYPT)))
      if (!this.key.unlocked) this.key.setKey(dek)
    } finally {
      dek.fill(0)
    }
    this.changed()
    return this.info()
  }
}

export { WrongPasswordError }
