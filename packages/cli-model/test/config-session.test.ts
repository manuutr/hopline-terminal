import { describe, expect, it } from 'vitest'
import { CONFIG_SESSIONS, PLATFORM_IDS, PROFILES, resolve } from '../src'

describe('config sessions', () => {
  it.each(PLATFORM_IDS.map((p) => [p]))('%s: every wrapper line is a modelled config command in the mode it is typed in', (p) => {
    const s = CONFIG_SESSIONS[p]
    const modes = PROFILES[p].modes.map((m) => m.id)
    expect(modes).toContain(s.linesFrom)
    for (const line of s.enter) {
      const r = resolve(p, 'exec', line)
      expect(r.status, `${p} "${line}"`).toBe('ok')
      expect(r.risk, `${p} "${line}"`).toBe('config')
      expect(r.enters, `${p} "${line}" enters config`).toBe('config')
    }
    // FortiOS `abort` is typed inside an open `config …` block.
    const inConfig = s.enter.length || s.blocks ? 'config' : s.linesFrom
    for (const line of [...s.commit, ...s.exit, ...s.abort]) {
      const r = resolve(p, inConfig, line)
      expect(r.status, `${p} "${line}"`).toBe('ok')
      expect(r.risk, `${p} "${line}"`).toBe('config')
    }
    // The last line typed in the normal path leaves configuration mode.
    const last = [...s.commit, ...s.exit].at(-1)
    if (s.enter.length) expect(last && resolve(p, 'config', last).leaves, `${p}: "${last}" leaves`).toBe(true)
    // The discard sequence ends by leaving configuration mode (FortiOS: one block per abort).
    const lastAbort = s.abort.at(-1)
    if (lastAbort) expect(resolve(p, inConfig, lastAbort).leaves, `${p}: abort "${lastAbort}" leaves`).toBe(true)
    // A commit model that cannot discard says what is left behind.
    if (s.candidate && !s.abort.length) expect(s.leftover).toBeTruthy()
  })

  it('commit-model platforms commit; Cisco-style ones apply line by line', () => {
    const commits = PLATFORM_IDS.filter((p) => CONFIG_SESSIONS[p].commit.length)
    expect(commits.sort()).toEqual(['iosxr', 'junos', 'panos', 'vrp'])
    // Review H4: a private candidate, never the shared one.
    expect(CONFIG_SESSIONS.junos.enter).toEqual(['configure private'])
    expect(CONFIG_SESSIONS.vrp.enter).toEqual(['system-view'])
    expect(CONFIG_SESSIONS.asa.enter).toEqual(['configure terminal'])
    expect(CONFIG_SESSIONS.fortios.blocks).toBe(true)
    expect(CONFIG_SESSIONS.vrp.commitWhen?.test('[~HUAWEI]')).toBe(true)
    expect(CONFIG_SESSIONS.vrp.commitWhen?.test('[HUAWEI]')).toBe(false)
  })
})
