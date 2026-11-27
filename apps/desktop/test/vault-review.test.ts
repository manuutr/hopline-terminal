import { describe, expect, it } from 'vitest'
import { readHeader, sealFile } from '../src/main/backup/format'
import { checkFileParams, WrongPasswordError } from '../src/main/vault/kdf'
import { Vault, type Keychain } from '../src/main/vault/vault'

/**
 * Review findings #1, #5, #9, #12 and #17 (vault). Inputs are the reviewer's repros.
 */
const FAST = { N: 2 ** 10, r: 8, p: 1 }

function profile(m = new Map<string, string>(), kc: Partial<Keychain> = {}, extra: { screenLocked?: () => boolean; now?: () => number } = {}) {
  const keychain: Keychain = { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b), ...kc }
  const vault = new Vault({ settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) }, keychain, kdf: FAST, ...extra })
  return { vault, m }
}

describe('#1 re-keying needs the current master password, even while unlocked', () => {
  it('setMode(master) with a new password is refused without (or with a wrong) current password', async () => {
    const { vault } = profile()
    await vault.init()
    await vault.setMode('master', { password: 'correct-horse' })
    expect(vault.info()).toMatchObject({ mode: 'master', locked: false })
    // The reviewer's repro: an unlocked vault re-keyed by whoever sits at the renderer.
    await expect(vault.setMode('master', { password: 'attacker-pw' })).rejects.toThrow(/current master password/)
    await expect(vault.setMode('master', { password: 'attacker-pw', current: 'not-the-password' })).rejects.toBeInstanceOf(WrongPasswordError)
    vault.lock()
    await expect(vault.unlock('attacker-pw')).rejects.toBeInstanceOf(WrongPasswordError)
    await vault.unlock('correct-horse')
    // With the right one it works (a re-wrap of the same key).
    const blob = await vault.key.encrypt(Buffer.from('kept'), 'a')
    await vault.setMode('master', { password: 'second-horse', current: 'correct-horse' })
    vault.lock()
    await vault.unlock('second-horse')
    expect((await vault.key.decrypt(blob, 'a')).toString()).toBe('kept')
  })

  it('setMode(session) needs the password, then the confirmation; declining keeps the wrapped key', async () => {
    const { vault, m } = profile()
    await vault.init()
    await vault.setMode('master', { password: 'correct-horse' })
    await expect(vault.setMode('session')).rejects.toThrow(/current master password/)
    expect(m.has('data_key_master')).toBe(true)
    let asked = 0
    const no = async () => (asked++, false)
    // Wrong password: refused before any dialog.
    await expect(vault.setMode('session', { current: 'wrong-horse', confirm: no })).rejects.toBeInstanceOf(WrongPasswordError)
    expect(asked).toBe(0)
    expect(await vault.setMode('session', { current: 'correct-horse', confirm: no })).toMatchObject({ mode: 'master' })
    expect(asked).toBe(1)
    expect(m.has('data_key_master')).toBe(true)
    await vault.setMode('session', { current: 'correct-horse', confirm: async () => true })
    expect(vault.info().mode).toBe('session')
    expect([...m.keys()].filter((k) => k.startsWith('data_key'))).toEqual([])
  })

  it('auto-lock changes need the current password; turning it off is confirmed', async () => {
    const { vault } = profile()
    await vault.init()
    await vault.setMode('master', { password: 'correct-horse' })
    await expect(vault.setAutoLock(0)).rejects.toThrow(/current master password/)
    await expect(vault.setAutoLock(0, { current: 'wrong-horse' })).rejects.toBeInstanceOf(WrongPasswordError)
    expect(vault.autoLockMin()).toBe(15)
    expect((await vault.setAutoLock(0, { current: 'correct-horse', confirm: async () => false })).autoLockMin).toBe(15)
    expect((await vault.setAutoLock(30, { current: 'correct-horse', confirm: async () => false })).autoLockMin).toBe(30)
    expect((await vault.setAutoLock(0, { current: 'correct-horse', confirm: async () => true })).autoLockMin).toBe(0)
  })
})

describe('#5 a v0.2.0 profile (sealed key, no vault_mode) with the keyring down', () => {
  it('stays keychain mode, locked and broken: no ephemeral wipe, no session mode', async () => {
    const sealed = Buffer.alloc(32, 7).toString('base64')
    const { vault, m } = profile(new Map([['data_key_sealed', sealed]]), { available: async () => false })
    let eph = 0
    vault.on('ephemeral', () => eph++)
    await vault.init()
    expect(vault.info()).toMatchObject({ mode: 'keychain', locked: true, chosen: true, keychainBroken: true, persistent: true })
    expect(eph).toBe(0)
    // The reviewer's follow-up: setting a master password now would delete the old key. Refused.
    await expect(vault.setMode('master', { password: 'password123' })).rejects.toThrow(/keychain/)
    expect(m.get('data_key_sealed')).toBe(sealed)
  })

  it('unseals normally once the keyring is back', async () => {
    const m = new Map([['data_key_sealed', Buffer.alloc(32, 7).toString('base64')]])
    const { vault } = profile(m)
    await vault.init()
    expect(vault.info()).toMatchObject({ mode: 'keychain', locked: false, keychainBroken: false })
    expect(m.get('vault_mode')).toBe('keychain')
  })
})

describe('#9 a keychain that fails to unseal', () => {
  it('is reported as broken (not a silent lock); retry works once the keyring answers', async () => {
    let fail = true
    const m = new Map([
      ['vault_mode', 'keychain'],
      ['data_key_sealed', Buffer.alloc(32, 9).toString('base64')]
    ])
    const { vault } = profile(m, {
      unseal: async (b) => {
        if (fail) throw new Error('keyring denied')
        return Buffer.from(b)
      }
    })
    await vault.init()
    expect(vault.info()).toMatchObject({ mode: 'keychain', locked: true, keychainBroken: true })
    await expect(vault.setMode('session')).rejects.toThrow(/keychain/)
    await expect(vault.retryKeychain()).rejects.toThrow(/keyring denied/)
    fail = false
    expect(await vault.retryKeychain()).toMatchObject({ mode: 'keychain', locked: false, keychainBroken: false })
    expect((await vault.key.raw()).equals(Buffer.alloc(32, 9))).toBe(true)
  })

  it('"switch to master password" starts over: confirmed, fresh key, old secrets dropped (ephemeral)', async () => {
    const m = new Map([
      ['vault_mode', 'keychain'],
      ['data_key_sealed', Buffer.alloc(32, 9).toString('base64')]
    ])
    const { vault } = profile(m, { unseal: async () => Promise.reject(new Error('keyring denied')) })
    let eph = 0
    vault.on('ephemeral', () => eph++)
    await vault.init()
    expect(await vault.resetToMaster('new-master-pw', async () => false)).toMatchObject({ keychainBroken: true })
    expect(eph).toBe(0)
    await expect(vault.resetToMaster('short')).rejects.toThrow(/at least/)
    expect(await vault.resetToMaster('new-master-pw', async () => true)).toMatchObject({ mode: 'master', locked: false, keychainBroken: false })
    expect(eph).toBe(1)
    expect(m.has('data_key_sealed')).toBe(false)
    expect((await vault.key.raw()).equals(Buffer.alloc(32, 9))).toBe(false)
    vault.lock()
    await vault.unlock('new-master-pw')
  })

  it('a damaged master-password record stays master and locked (never session mode)', async () => {
    const { vault } = profile(new Map([['data_key_master', '{not json']]))
    let eph = 0
    vault.on('ephemeral', () => eph++)
    await vault.init()
    expect(vault.info()).toMatchObject({ mode: 'master', locked: true, chosen: true })
    expect(eph).toBe(0)
    await expect(vault.unlock('anything-at-all')).rejects.toThrow(/unsupported/)
  })
})

describe('#12 scrypt parameters from an export header are capped', () => {
  it('N ≤ 2^18, r = 8, p ≤ 2', async () => {
    expect(() => checkFileParams({ N: 2 ** 17, r: 8, p: 1 })).not.toThrow()
    expect(() => checkFileParams({ N: 2 ** 18, r: 8, p: 2 })).not.toThrow()
    expect(() => checkFileParams({ N: 2 ** 19, r: 8, p: 1 })).toThrow(/parameters/)
    expect(() => checkFileParams({ N: 2 ** 17, r: 16, p: 1 })).toThrow(/parameters/)
    expect(() => checkFileParams({ N: 2 ** 17, r: 8, p: 3 })).toThrow(/parameters/)
    // A real file with hostile params in its header is refused before any key derivation.
    const file = await sealFile({ x: 1 }, 'passphrase-1', FAST)
    const nl = file.indexOf(0x0a)
    const header = JSON.parse(file.subarray(0, nl).toString()) as { kdf: Record<string, unknown> }
    header.kdf = { name: 'scrypt', N: 2 ** 20, r: 8, p: 4 }
    const hostile = Buffer.concat([Buffer.from(JSON.stringify(header)), file.subarray(nl)])
    expect(() => readHeader(hostile)).toThrow(/parameters/)
  })
})

describe('#17 auto-lock sees a locked screen where the OS reports it', () => {
  it('locks on the next tick while the screen is locked', async () => {
    let locked = false
    const { vault } = profile(new Map(), {}, { screenLocked: () => locked })
    await vault.init()
    await vault.setMode('master', { password: 'correct-horse' })
    vault.tick()
    expect(vault.info().locked).toBe(false)
    locked = true
    vault.tick()
    expect(vault.info().locked).toBe(true)
  })
})
