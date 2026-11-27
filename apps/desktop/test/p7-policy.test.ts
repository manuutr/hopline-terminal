import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NO_LOCKS, type PolicyLocks } from '@shared/policy'
import { FAIL_CLOSED, parsePolicy } from '../src/main/policy/policy'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { PolicyLockedError, SettingsService } from '../src/main/settings'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} } }))

const parse = (o: object) => parsePolicy(JSON.stringify({ version: 1, ...o }), '/etc/hopline/policy.json')

describe('policy: updates and crash reports (Phase 7)', () => {
  it('parses the new keys into locks', () => {
    const p = parse({ disableUpdates: true, updateChannel: 'stable', disableCrashReports: true, crashReportDsn: 'https://0123456789abcdef@glitchtip.acme.net/3' })
    expect(p.state).toBe('active')
    expect(p.locks).toMatchObject({ updatesDisabled: true, updateChannel: 'stable', crashReportsDisabled: true, crashReportDsn: 'https://0123456789abcdef@glitchtip.acme.net/3' })
  })

  it('a bad value or a typo fails closed, with updates and crash reports off', () => {
    for (const bad of [{ disableUpdates: 'yes' }, { updateChannel: 'nightly' }, { crashReportDsn: 'https://key:secret@sentry.io/1' }, { disableUpdate: true }]) {
      const p = parse(bad)
      expect(p.state, JSON.stringify(bad)).toBe('invalid')
      expect(p.locks).toMatchObject({ updatesDisabled: true, crashReportsDisabled: true, readOnly: true })
    }
    expect(FAIL_CLOSED).toMatchObject({ updatesDisabled: true, crashReportsDisabled: true })
  })

  it('without the keys nothing is fixed', () => {
    expect(parse({}).locks).toMatchObject({ updatesDisabled: false, updateChannel: null, crashReportsDisabled: false, crashReportDsn: null })
  })
})

describe('settings: the overlay and the locks for the new keys', () => {
  const make = (locks: PolicyLocks | null) => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'hopline-p7-')), 'h.db'))
    return new SettingsService(new Repo(db), undefined, undefined, () => locks)
  }

  it('defaults: updates checked (after the privacy screen), crash reports off', () => {
    expect(make(null).get()).toMatchObject({ updateAutoCheck: true, updateChannel: 'stable', crashReports: false, crashReportDsn: '', privacyReviewed: false })
  })

  it('the policy forces checks off, the channel and crash reports off; repeating them is fine, changing them is refused', () => {
    const s = make({ ...NO_LOCKS, updatesDisabled: true, updateChannel: 'stable', crashReportsDisabled: true })
    expect(s.get()).toMatchObject({ updateAutoCheck: false, updateChannel: 'stable', crashReports: false })
    // General › Save sends every field: the enforced values come back and are dropped, not stored.
    expect(() => s.update({ updateAutoCheck: false, updateChannel: 'stable', crashReports: false, theme: 'light' })).not.toThrow()
    expect(s.get().theme).toBe('light')
    expect(() => s.update({ updateAutoCheck: true })).toThrow(PolicyLockedError)
    expect(() => s.update({ updateChannel: 'beta' })).toThrow(PolicyLockedError)
    expect(() => s.update({ crashReports: true })).toThrow(PolicyLockedError)
  })

  it('the user choice survives a policy that is later removed', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'hopline-p7-')), 'h.db'))
    const repo = new Repo(db)
    new SettingsService(repo).update({ crashReports: true, updateChannel: 'beta' })
    expect(new SettingsService(repo, undefined, undefined, () => ({ ...NO_LOCKS, crashReportsDisabled: true, updateChannel: 'stable' })).get()).toMatchObject({ crashReports: false, updateChannel: 'stable' })
    expect(new SettingsService(repo).get()).toMatchObject({ crashReports: true, updateChannel: 'beta' })
  })
})
