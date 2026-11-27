import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ScrollbackStore } from '../src/main/store/scrollback'
import { DataKey, type KeyStore } from '../src/main/vault/datakey'

/** Test keystore: "seals" with XOR so we can check the key is never stored in clear. */
function memStore(): KeyStore & { sealed: Buffer | null } {
  const s = {
    sealed: null as Buffer | null,
    load: () => s.sealed,
    save: (b: Buffer) => void (s.sealed = b),
    seal: async (p: Buffer) => Buffer.from(p.map((x) => x ^ 0xaa)),
    unseal: async (b: Buffer) => Buffer.from(b.map((x) => x ^ 0xaa))
  }
  return s
}

const dir = mkdtempSync(join(tmpdir(), 'sb-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('DataKey', () => {
  it('round-trips, binds to the AAD, and survives a restart', async () => {
    const ks = memStore()
    const k = new DataKey(ks)
    const blob = await k.encrypt(Buffer.from('hello'), 'a')
    expect((await k.decrypt(blob, 'a')).toString()).toBe('hello')
    await expect(k.decrypt(blob, 'b')).rejects.toThrow()
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1]! ^= 1
    await expect(k.decrypt(tampered, 'a')).rejects.toThrow()
    // A new process loads the same sealed key.
    expect((await new DataKey(ks).decrypt(blob, 'a')).toString()).toBe('hello')
  })
})

describe('ScrollbackStore', () => {
  it('saves encrypted, loads back, trims huge buffers, and clears', async () => {
    const store = new ScrollbackStore(dir, new DataKey(memStore()))
    await store.save('s1', 'core-sw1#show version\r\nSECRET-LOOKING-TEXT\r\n')
    const raw = readFileSync(join(dir, 's1.hsb'))
    expect(raw.includes(Buffer.from('SECRET-LOOKING-TEXT'))).toBe(false)
    expect((await store.load('s1'))?.data).toContain('SECRET-LOOKING-TEXT')
    await store.save('s2', 'x'.repeat(9 * 1024 * 1024) + 'END')
    const big = await store.load('s2')
    expect(big?.data.length).toBe(8 * 1024 * 1024)
    expect(big?.data.endsWith('END')).toBe(true)
    await store.clear('s1')
    expect(await store.load('s1')).toBeNull()
    expect(readdirSync(dir)).toEqual(['s2.hsb'])
  })
  it('treats corrupt files and bad ids safely', async () => {
    const store = new ScrollbackStore(dir, new DataKey(memStore()))
    writeFileSync(join(dir, 'bad.hsb'), 'garbage')
    expect(await store.load('bad')).toBeNull()
    await expect(store.save('../etc/passwd', 'x')).rejects.toThrow('bad session id')
  })
})
