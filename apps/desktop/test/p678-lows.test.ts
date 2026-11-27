import { seedDevelopmentSessions } from '../src/main/lab'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NO_LOCKS } from '@shared/policy'
import type { Settings } from '@shared/types'
import { parsePlist, parseThemeFile, THEME_FILE_MAX_BYTES } from '@shared/theme-file'
import { UpdateService, type UpdaterBackend } from '../src/main/update/service'
import { ScrollbackStore } from '../src/main/store/scrollback'
import { DataKey, type KeyStore } from '../src/main/vault/datakey'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { LAB_FOLDER, LAB_SETTING, SimulatorLab } from '../src/main/lab'
import { flushAll, registerFlush } from '../src/renderer/src/lib/save-queue'

/** Phase 6–8 review: the Lows (L1, L3, L7, L8, L9, L11). */

const require = createRequire(import.meta.url)
const tmp = mkdtempSync(join(tmpdir(), 'hopline-p678-'))
const labs: SimulatorLab[] = []
afterAll(async () => {
  await Promise.all(labs.map((l) => l.stop()))
  rmSync(tmp, { recursive: true, force: true })
})

describe('L1: "Restart and install" closes the door before it counts', () => {
  it('new sessions are refused from the moment the install is accepted, and allowed again when it is refused', async () => {
    const calls: string[] = []
    let open = 0
    let frozen = false
    const b = {
      channel: null,
      allowPrerelease: false,
      allowDowngrade: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: async () => ({ updateInfo: { version: '0.8.0' }, isUpdateAvailable: true }),
      downloadUpdate: async () => [],
      quitAndInstall: () => void calls.push(`install frozen=${frozen}`),
      on: () => b
    } as unknown as UpdaterBackend
    const svc = new UpdateService({
      backend: () => b,
      settings: () => ({ updateAutoCheck: true, updateChannel: 'stable', privacyReviewed: true }) as Settings,
      locks: () => NO_LOCKS,
      version: '0.7.0',
      mode: () => 'auto',
      openSessions: () => (calls.push(`count frozen=${frozen}`), open),
      freeze: (on) => (frozen = on),
      emit: () => undefined,
      releaseUrl: () => null,
      dev: false,
      installOnQuit: false
    })
    await svc.check(true)
    open = 1
    expect(svc.restart()).toEqual({ ok: false, reason: 'sessions', open: 1 })
    expect(frozen).toBe(false)
    open = 0
    expect(svc.restart()).toEqual({ ok: true })
    // Counted while frozen, installed while frozen, still frozen afterwards.
    expect(calls).toEqual(['count frozen=true', 'count frozen=true', 'install frozen=true'])
    expect(frozen).toBe(true)
  })

  it('the session host refuses to open a tab or a background connection while an install starts', async () => {
    const src = (await import('node:fs')).readFileSync(join(__dirname, '../src/main/host/client.ts'), 'utf8')
    const opens = src.match(/if \(this\.installingUpdate\) throw new Error\('Hopline Terminal is restarting to install an update'\)/g) ?? []
    expect(opens).toHaveLength(2)
  })
})

describe('L3: theme import is linear and capped', () => {
  it('254 KB of "<a" is refused by size, and 60 KB of it parses (fails) quickly', () => {
    expect(() => parseThemeFile('x.itermcolors', '<plist>' + '<a'.repeat(127000))).toThrow(/too large/)
    const t0 = performance.now()
    expect(() => parsePlist('<plist>' + '<a'.repeat(30000))).toThrow()
    expect(() => parsePlist('<plist>' + '<a b'.repeat(15000))).toThrow()
    expect(performance.now() - t0).toBeLessThan(500)
  })
  it('the cap is 64 KB and a real file still reads', () => {
    expect(THEME_FILE_MAX_BYTES).toBe(64 * 1024)
    const ok = parsePlist('<?xml version="1.0"?><plist version="1.0"><dict><key>Ansi 0 Color</key><dict><key>Red Component</key><real>0.5</real></dict></dict></plist>') as Record<string, Record<string, number>>
    expect(ok['Ansi 0 Color']!['Red Component']).toBe(0.5)
  })
})

describe('L7: the lab only touches its own objects', () => {
  it("a user's folder named like the lab, with a real device, is never repointed; their loopback key is kept", async () => {
    const repo = new Repo(openDb(':memory:'))
    repo.setSetting('seeded', '1')
    const theirs = repo.saveFolder({ name: LAB_FOLDER, parentId: null })
    const real = repo.saveSession({ name: 'core-sw1', folderId: theirs.id, host: '10.1.1.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: 'ops', credentialId: null, logToFile: false, notes: '', options: {} })
    const lab = new SimulatorLab(repo, join(tmp, 'lab_key_1'))
    labs.push(lab)
    const info = await lab.start()
    expect(repo.getSession(real.id)!.host).toBe('10.1.1.1')
    const labSessions = info.sessionIds.map((id) => repo.getSession(id)!)
    expect(labSessions.every((s) => s.folderId !== theirs.id && s.host === '127.0.0.1')).toBe(true)
    expect(JSON.parse(repo.getSetting(LAB_SETTING)!).sessions['core-sw1']).toBe(info.sessionIds[0])
    // A restart finds them again by id: nothing is duplicated.
    await lab.stop()
    const again = await lab.start()
    expect(again.sessionIds).toEqual(info.sessionIds)
  })

  it('a seeded lab is adopted by id; a key already trusted for a loopback port is never replaced', async () => {
    const repo = new Repo(openDb(':memory:'))
    await seedDevelopmentSessions(repo)
    const seeded = JSON.parse(repo.getSetting(LAB_SETTING)!) as { sessions: Record<string, string> }
    const lab = new SimulatorLab(repo, join(tmp, 'lab_key_2'))
    labs.push(lab)
    const info = await lab.start()
    expect(info.sessionIds[0]).toBe(seeded.sessions['core-sw1'])
    // Pretend the user trusted another key on the port the lab will try next: the lab moves.
    const port = repo.getSession(info.sessionIds[0]!)!.port
    await lab.stop()
    repo.removeHostKeys('127.0.0.1', port)
    repo.addHostKey('127.0.0.1', port, 'SHA256:theirs', 'user')
    const before = repo.hostKeys('127.0.0.1', port)
    await lab.start()
    expect(repo.hostKeys('127.0.0.1', port)).toEqual(before)
  })

  it('a port the user already trusts another key for is skipped: the lab binds another one', async () => {
    const repo = new Repo(openDb(':memory:'))
    await seedDevelopmentSessions(repo)
    const taken: number[] = []
    const real = repo.hostKeys.bind(repo)
    // The first port the lab looks at "belongs" to the user's own forward.
    repo.hostKeys = (host: string, port: number) => (taken.length === 0 && (taken.push(port), true)) || taken.includes(port) ? ['SHA256:theirs'] : real(host, port)
    const added: number[] = []
    const add = repo.addHostKey.bind(repo)
    repo.addHostKey = (h, p, fp, src, kt) => (added.push(p), add(h, p, fp, src, kt))
    const lab = new SimulatorLab(repo, join(tmp, 'lab_key_3'))
    labs.push(lab)
    const info = await lab.start()
    const ports = info.sessionIds.map((id) => repo.getSession(id)!.port)
    expect(ports).not.toContain(taken[0])
    expect(added).not.toContain(taken[0])
  })
})

describe('L9: the SignPath hook sends its token only to the API origin', () => {
  const { sameOrigin } = require('../scripts/signpath-sign.cjs') as { sameOrigin: (api: string, url: string, what: string) => string }
  const api = 'https://app.signpath.io/API/v1'
  it('same origin (absolute or relative) passes; anything else is refused', () => {
    expect(sameOrigin(api, 'https://app.signpath.io/API/v1/org/SigningRequests/1', 'x')).toBe('https://app.signpath.io/API/v1/org/SigningRequests/1')
    expect(sameOrigin(api, '/API/v1/org/SigningRequests/1', 'x')).toBe('https://app.signpath.io/API/v1/org/SigningRequests/1')
    expect(() => sameOrigin(api, 'https://evil.example/steal', 'signed artifact link')).toThrow(/refusing/)
    expect(() => sameOrigin(api, 'http://app.signpath.io/API/v1/x', 'x')).toThrow(/refusing/)
    expect(() => sameOrigin(api, 'https://app.signpath.io.evil.example/x', 'x')).toThrow(/refusing/)
  })
})

function memStore(): KeyStore {
  let sealed: Buffer | null = null
  return { load: () => sealed, save: (b: Buffer) => void (sealed = b), seal: async (p: Buffer) => Buffer.from(p), unseal: async (b: Buffer) => Buffer.from(b) }
}

describe('L11: scrollback saves are ordered, never share a temp file, and a clear wins', () => {
  it('the newest save wins even when an older, larger one is still compressing', async () => {
    const dir = join(tmp, 'sb1')
    const store = new ScrollbackStore(dir, new DataKey(memStore()))
    const big = 'x'.repeat(4_000_000)
    await Promise.all([store.save('s1', big), store.save('s1', 'newest'), store.save('s1', big + 'y')])
    await store.save('s1', 'last')
    expect((await store.load('s1'))!.data).toBe('last')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('a save in flight when the history is cleared does not bring it back', async () => {
    const dir = join(tmp, 'sb2')
    const store = new ScrollbackStore(dir, new DataKey(memStore()))
    await store.save('s2', 'old history')
    const inflight = store.save('s2', 'x'.repeat(2_000_000))
    await store.clear('s2')
    await inflight
    await store.idle()
    expect(await store.load('s2')).toBeNull()
    // Saving afterwards works again.
    await store.save('s2', 'after')
    expect((await store.load('s2'))!.data).toBe('after')
  })
})

describe('L8: a flush saves every tab now, busy or not', () => {
  it('flushAll runs every registered save and waits for it', async () => {
    const done: string[] = []
    const off1 = registerFlush('t1', async () => void done.push('t1'))
    registerFlush('t2', () => void done.push('t2'))
    await flushAll()
    expect(done.sort()).toEqual(['t1', 't2'])
    off1()
    done.length = 0
    await flushAll()
    expect(done).toEqual(['t2'])
  })
})

describe('L10 + addendum: reserved and safety keys are enforced in main, not only in the editor', () => {
  it('main drops reserved combos when a keymap is saved, and again when a hand-edited one is loaded', async () => {
    const { ProductivityStore } = await import('../src/main/productivity/store')
    const kv = new Map<string, string>()
    const store = new ProductivityStore({ getSetting: (k) => kv.get(k), setSetting: (k, v) => void (v === null ? kv.delete(k) : kv.set(k, v)) })
    const saved = store.setKeymap({ 'pane.splitRight': ['Ctrl+C', 'Tab', 'Mod+K'], 'palette.open': ['Enter', 'Escape', 'Esc', 'Return', 'Shift+Enter'] })
    expect(saved).toEqual({ 'pane.splitRight': ['Mod+K'], 'palette.open': [] })
    kv.set('keymap', JSON.stringify({ 'tab.close': ['Ctrl+Z', 'Alt+B', 'Ctrl+Shift+6', 'F6'] }))
    expect(store.keymap()).toEqual({ 'tab.close': ['F6'] })
  })
  it('the renderer filters what it loads the same way', async () => {
    const { withoutReserved } = await import('@shared/keymap-rules')
    expect(withoutReserved({ a: ['Enter', 'Escape', 'Mod+Alt+F', 'Ctrl+Alt+ArrowLeft'] }, false)).toEqual({ a: ['Mod+Alt+F', 'Ctrl+Alt+ArrowLeft'] })
  })
  it('AltGr typing a character is never a shortcut; a plain Ctrl+Alt+letter still is', async () => {
    const { altGrText } = await import('../src/renderer/src/lib/actions')
    const ev = (key: string, code: string, altGr: boolean) => ({ key, code, getModifierState: (k: string) => k === 'AltGraph' && altGr })
    expect(altGrText(ev('@', 'KeyQ', true))).toBe(true) // German AltGr+Q
    expect(altGrText(ev('{', 'Digit7', true))).toBe(true)
    expect(altGrText(ev('|', 'IntlBackslash', true))).toBe(true)
    expect(altGrText(ev('k', 'KeyK', true))).toBe(false)
    expect(altGrText(ev('@', 'KeyQ', false))).toBe(false)
    expect(altGrText(ev('ArrowLeft', 'ArrowLeft', true))).toBe(false)
  })
})
