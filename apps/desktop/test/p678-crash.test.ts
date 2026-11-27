import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SECRET_KEYWORDS } from '@hopline/guard'
import { NO_LOCKS, type PolicyLocks } from '@shared/policy'
import type { Settings } from '@shared/types'
import { scrubText } from '../src/main/crash/scrub'
import { CrashReporting, DUMP_RETENTION_DAYS, ensurePrivateDir, MAX_TESTS_PER_RUN, type CrashDeps } from '../src/main/crash/service'

/** Phase 6–8 review: crash reporting (M2, M6, L4, L5). */

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 25)

function reporter(s: Partial<Settings> = {}, over: Partial<CrashDeps> = {}, locks: PolicyLocks = NO_LOCKS) {
  const sent: string[] = []
  const rows: { kind: string; destination: string; bytes: number; status?: number | null }[] = []
  const dumps = mkdtempSync(join(tmpdir(), 'hopline-dumps-'))
  let settings = { crashReports: true, crashReportDsn: 'http://abcdef0123456789@127.0.0.1:1/42', updateChannel: 'stable', ...s } as Settings
  const deps: CrashDeps = {
    settings: () => settings,
    locks: () => locks,
    known: () => [],
    version: '0.7.0',
    builtInDsn: '',
    fetch: async (url) => (sent.push(url), { status: 200, headers: { get: () => null } }),
    dumpsDir: () => dumps,
    confirm: async () => true,
    now: () => NOW,
    egress: (e) => {
      const row: (typeof rows)[number] = { ...e }
      rows.push(row)
      return (status) => void (row.status = status)
    },
    ...over
  }
  return { r: new CrashReporting(deps), sent, rows, dumps, set: (p: Partial<Settings>) => (settings = { ...settings, ...p }) }
}

function dump(dir: string, name: string, ageDays: number): string {
  const sub = join(dir, 'completed')
  mkdirSync(sub, { recursive: true })
  const p = join(sub, `${name}.dmp`)
  writeFileSync(p, 'MDMP memory')
  const t = (NOW - ageDays * DAY) / 1000
  utimesSync(p, t, t)
  return p
}

describe('M2: native dumps do not outlive the opt-in', () => {
  it('turning crash reports off deletes every dump', () => {
    const { r, dumps, set } = reporter()
    const a = dump(dumps, 'aaaa-1', 0)
    const b = dump(dumps, 'bbbb-2', 1)
    r.apply()
    expect(r.listDumps().map((d) => d.id).sort()).toEqual(['aaaa-1', 'bbbb-2'])
    set({ crashReports: false })
    r.apply()
    expect(existsSync(a) || existsSync(b)).toBe(false)
    expect(r.listDumps()).toEqual([])
  })

  it('the policy forbidding reports deletes them too', () => {
    const { r, dumps } = reporter({}, {}, { ...NO_LOCKS, crashReportsDisabled: true })
    const a = dump(dumps, 'aaaa-1', 0)
    r.apply()
    expect(existsSync(a)).toBe(false)
  })

  it(`opted in, dumps older than ${DUMP_RETENTION_DAYS} days are deleted at startup, newer ones kept owner-only`, () => {
    const { r, dumps } = reporter()
    const old = dump(dumps, 'old-1', DUMP_RETENTION_DAYS + 1)
    const fresh = dump(dumps, 'fresh-1', DUMP_RETENTION_DAYS - 1)
    r.apply()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(fresh).mode & 0o777).toBe(0o600)
  })

  it('dumps written after an opt-out in the same run go at the next sweep (quit / next start)', () => {
    const { r, dumps, set } = reporter()
    set({ crashReports: false })
    r.apply()
    const late = dump(dumps, 'late-1', 0)
    expect(r.sweepDumps()).toBe(1)
    expect(existsSync(late)).toBe(false)
  })

  it('"Delete all" removes every dump', () => {
    const { r, dumps } = reporter()
    dump(dumps, 'a-1', 0)
    dump(dumps, 'b-2', 0)
    expect(r.deleteAllDumps()).toBe(2)
    expect(r.listDumps()).toEqual([])
  })

  it('the dumps folder is created owner-only (0700)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hopline-cd-')), 'Crashpad')
    ensurePrivateDir(dir)
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
    // An existing, too-open folder is tightened.
    if (process.platform !== 'win32') {
      const open = mkdtempSync(join(tmpdir(), 'hopline-cd2-'))
      ensurePrivateDir(open)
      expect(statSync(open).mode & 0o777).toBe(0o700)
    }
  })
})

describe('M6: the scrubber covers dotless hosts and every secret keyword the guard knows', () => {
  const s = (t: string) => scrubText(t, { known: [] })
  it('the review table', () => {
    expect(s('connect ECONNREFUSED core-sw1:22')).toBe('connect ECONNREFUSED <host>:<port>')
    expect(s('Timed out connecting core-sw1 port 22')).not.toContain('core-sw1')
    expect(s('vrf CUSTOMER_ACME not found on PE1')).not.toMatch(/CUSTOMER_ACME|PE1/)
    expect(s('tacacs key Sup3rS3cret')).not.toContain('Sup3rS3cret')
    expect(s('pre-shared-key cisco123 for peer')).not.toContain('cisco123')
  })
  it('bare "key X", radius, isakmp and ciphertext blobs', () => {
    for (const t of ['radius-server key R4diusK3y', 'crypto isakmp key Isak0mpK3y address 0.0.0.0', 'key Pl41nK3y', 'set-key ascii 8 Fl4tK3y', 'authentication-key 1 md5 Md5K3yX', 'got %^%#Hu4w3iC1ph3r%^%# back', 'hash $1c$Zz9YyXx$ seen']) {
      expect(s(t), t).not.toMatch(/R4diusK3y|Isak0mpK3y|Pl41nK3y|Fl4tK3y|Md5K3yX|Hu4w3iC1ph3r|Zz9YyXx/)
    }
  })
  it.each(SECRET_KEYWORDS.map((k) => [k]))('guard keyword %s: the value after it never survives', (k) => {
    // A literal instance of the keyword (regex source → text): drop lookarounds, take one branch.
    const dropLookarounds = (src: string): string => {
      let out = ''
      for (let i = 0; i < src.length; i++) {
        if (src.startsWith('(?=', i) || src.startsWith('(?!', i)) {
          let depth = 0
          for (; i < src.length; i++) {
            if (src[i] === '\\') i++
            else if (src[i] === '(') depth++
            else if (src[i] === ')' && --depth === 0) break
          }
        } else out += src[i]
      }
      return out
    }
    // A keyword that only counts before an algorithm ("authentication-mode md5 X") gets one.
    const suffix = /\(\?=\\s\+\(\?:md5/.test(k) ? ' md5' : ''
    const word = (dropLookarounds(k) + suffix)
      .replace(/\\s\+/g, ' ')
      .replace(/\(\?:([^|)]+)[^)]*\)/g, '$1')
      .replace(/\[\\w-\]\*/g, '')
      .replace(/\\/g, '')
    expect(s(`failed: ${word} Zq8SecretValue9 end`)).not.toContain('Zq8SecretValue9')
  })
  it('still useful: plain errors and times are kept', () => {
    expect(s("TypeError: Cannot read properties of undefined (reading 'map')")).toBe("TypeError: Cannot read properties of undefined (reading 'map')")
    expect(s('timeout at 12:30 after 3 tries')).toContain('12:30')
  })
})

describe('L4: "Send a test crash" is capped per run', () => {
  it(`at most ${MAX_TESTS_PER_RUN} test reports, whatever the renderer asks`, async () => {
    const { r, sent } = reporter()
    r.apply()
    for (let i = 0; i < MAX_TESTS_PER_RUN + 5; i++) await r.sendTest()
    expect(sent.length).toBe(MAX_TESTS_PER_RUN)
  })
})

describe('L5: crash reports and dumps appear in "What left this machine"', () => {
  it('one metadata-only row per report and per dump, with the destination and status', async () => {
    const { r, rows, dumps } = reporter()
    r.apply()
    await r.sendTest()
    dump(dumps, 'send-1', 0)
    expect((await r.sendDump('send-1')).ok).toBe(true)
    expect(rows.map((x) => [x.kind, x.destination, x.status])).toEqual([
      ['report', '127.0.0.1:1', 200],
      ['dump', '127.0.0.1:1', 200]
    ])
    expect(rows.every((x) => x.bytes > 0)).toBe(true)
    expect(readdirSync(join(dumps, 'completed'))).toEqual([])
  })
})
