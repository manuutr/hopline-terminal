import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_LOCKS, type PolicyLocks } from '@shared/policy'
import type { UpdateMode, UpdateStatus } from '@shared/privacy'
import type { Settings } from '@shared/types'
import { UpdateService, type UpdaterBackend } from '../src/main/update/service'

/** A stand-in for electron-updater: records what the service asked of it. */
function fakeBackend(latest: string | null, opts: { failCheck?: boolean; failDownload?: boolean } = {}) {
  const listeners: Record<string, ((x: never) => void)[]> = {}
  const calls = { check: 0, download: 0, install: [] as [boolean | undefined, boolean | undefined][] }
  const b: UpdaterBackend & { calls: typeof calls; emitProgress: (p: number) => void } = {
    channel: null,
    allowPrerelease: true,
    allowDowngrade: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    calls,
    async checkForUpdates() {
      calls.check++
      if (opts.failCheck) throw new Error('net::ERR_NAME_NOT_RESOLVED\n<html>long body</html>')
      return latest ? { updateInfo: { version: latest }, isUpdateAvailable: latest !== '0.7.0' } : { updateInfo: { version: '0.7.0' }, isUpdateAvailable: false }
    },
    async downloadUpdate() {
      calls.download++
      for (const cb of listeners['download-progress'] ?? []) cb({ percent: 42.4 } as never)
      if (opts.failDownload) throw new Error('sha512 checksum mismatch')
      return ['/tmp/x']
    },
    quitAndInstall(a, b2) {
      calls.install.push([a, b2])
    },
    on(ev: string, cb: (x: never) => void) {
      ;(listeners[ev] ??= []).push(cb)
      return b
    },
    emitProgress(p) {
      for (const cb of listeners['download-progress'] ?? []) cb({ percent: p } as never)
    }
  }
  return b
}

const baseSettings = { updateAutoCheck: true, updateChannel: 'stable', privacyReviewed: true } as Settings

function service(o: { backend?: ReturnType<typeof fakeBackend>; settings?: Partial<Settings>; locks?: Partial<PolicyLocks>; mode?: UpdateMode; open?: number; dev?: boolean } = {}) {
  const backend = o.backend ?? fakeBackend('0.8.0')
  let built = 0
  const emitted: UpdateStatus[] = []
  const s = { ...baseSettings, ...o.settings }
  let open = o.open ?? 0
  const svc = new UpdateService({
    backend: () => (built++, backend),
    settings: () => s,
    locks: () => ({ ...NO_LOCKS, ...o.locks }),
    version: '0.7.0',
    mode: () => o.mode ?? 'auto',
    openSessions: () => open,
    emit: (x) => emitted.push(x),
    releaseUrl: (v) => `https://github.com/o/r/releases/tag/v${v}`,
    dev: !!o.dev,
    installOnQuit: false,
    firstDelayMs: 1000,
    intervalMs: 5000
  })
  return { svc, backend, emitted, built: () => built, settings: s, setOpen: (n: number) => (open = n) }
}

afterEach(() => vi.useRealTimers())

describe('UpdateService: when it may check (D8)', () => {
  it('nothing is checked before the privacy screen was answered; "Check now" still works', async () => {
    const t = service({ settings: { privacyReviewed: false } })
    expect(t.svc.status().state).toEqual({ kind: 'off', reason: 'consent' })
    expect((await t.svc.check(false)).state.kind).toBe('off')
    expect(t.built()).toBe(0)
    expect((await t.svc.check(true)).state).toEqual({ kind: 'ready', version: '0.8.0' })
  })

  it('the team policy blocks every check, "Check now" included, without building the updater', async () => {
    const t = service({ locks: { updatesDisabled: true } })
    expect((await t.svc.check(true)).state).toEqual({ kind: 'off', reason: 'policy' })
    expect(t.svc.status().managed.disabled).toBe(true)
    expect(t.built()).toBe(0)
  })

  it('automatic checks off: the schedule never fires, a manual check does', async () => {
    vi.useFakeTimers()
    const t = service({ settings: { updateAutoCheck: false } })
    t.svc.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.backend.calls.check).toBe(0)
    expect(t.svc.status().state).toEqual({ kind: 'off', reason: 'setting' })
    await t.svc.check(true)
    expect(t.backend.calls.check).toBe(1)
  })

  it('a dev build never checks', async () => {
    const t = service({ dev: true })
    expect((await t.svc.check(true)).state).toEqual({ kind: 'off', reason: 'dev' })
    expect(t.built()).toBe(0)
  })

  it('on schedule: shortly after start, then on the interval', async () => {
    vi.useFakeTimers()
    const t = service({ backend: fakeBackend(null) })
    t.svc.start()
    expect(t.backend.calls.check).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.backend.calls.check).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.backend.calls.check).toBe(2)
    t.svc.stop()
  })
})

describe('UpdateService: download in the background, never restart with sessions open', () => {
  it('auto mode downloads and ends "ready"; the updater is told not to download or restart on its own', async () => {
    const t = service()
    const s = await t.svc.check(true)
    expect(s.state).toEqual({ kind: 'ready', version: '0.8.0' })
    expect(t.backend.autoDownload).toBe(false)
    expect(t.backend.autoInstallOnAppQuit).toBe(false) // tests: installOnQuit false
    expect(t.emitted.map((e) => e.state.kind)).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(t.emitted.find((e) => e.state.kind === 'downloading' && e.state.percent === 42)).toBeTruthy()
    expect(t.backend.calls.install).toEqual([])
  })

  it('"Restart now" is refused while any session is open, and installs only with none', async () => {
    const t = service({ open: 2 })
    await t.svc.check(true)
    expect(t.svc.restart()).toEqual({ ok: false, reason: 'sessions', open: 2 })
    expect(t.backend.calls.install).toEqual([])
    t.setOpen(0)
    expect(t.svc.restart()).toEqual({ ok: true })
    expect(t.backend.calls.install).toEqual([[false, true]])
  })

  it('"Restart now" without an update ready does nothing', () => {
    const t = service()
    expect(t.svc.restart()).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('notify mode (deb/rpm, unsigned macOS) says what is new and never downloads', async () => {
    const t = service({ mode: 'notify' })
    expect((await t.svc.check(true)).state).toEqual({ kind: 'available', version: '0.8.0', url: 'https://github.com/o/r/releases/tag/v0.8.0' })
    expect(t.backend.calls.download).toBe(0)
  })

  it('up to date, and failures as one short line', async () => {
    expect((await service({ backend: fakeBackend(null) }).svc.check(true)).state.kind).toBe('current')
    expect((await service({ backend: fakeBackend('0.8.0', { failCheck: true }) }).svc.check(true)).state).toMatchObject({ kind: 'error', message: 'net::ERR_NAME_NOT_RESOLVED' })
    expect((await service({ backend: fakeBackend('0.8.0', { failDownload: true }) }).svc.check(true)).state).toMatchObject({ kind: 'error', message: 'sha512 checksum mismatch' })
  })

  it('a check while one runs, or with an update ready, does not start another', async () => {
    const t = service()
    const [a, b] = await Promise.all([t.svc.check(true), t.svc.check(true)])
    expect(a).toEqual(b)
    await t.svc.check(true)
    expect(t.backend.calls.check).toBe(1)
  })
})

describe('UpdateService: channels', () => {
  it('stable: no prereleases; beta: prereleases; never a downgrade either way', async () => {
    const t = service({ backend: fakeBackend(null) })
    await t.svc.check(true)
    expect(t.backend).toMatchObject({ channel: 'latest', allowPrerelease: false, allowDowngrade: false })
    t.settings.updateChannel = 'beta'
    t.svc.reconfigure()
    expect(t.backend).toMatchObject({ channel: 'beta', allowPrerelease: true, allowDowngrade: false })
  })

  it('a channel fixed by the policy is reported as managed', () => {
    expect(service({ locks: { updateChannel: 'stable' } }).svc.status().managed).toEqual({ disabled: false, channel: true })
  })
})
