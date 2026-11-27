import { describe, expect, it } from 'vitest'
import { globMatch, hostMatches, importSshConfig, parseHop } from '../src'
import { byName, expectNoneLost, fixture, warningsFor } from './helpers'

const text = fixture('ssh_config')
const result = importSshConfig(text)

describe('ssh_config', () => {
  it('loses no concrete Host alias', () => {
    // Independent count: tokens on Host lines that are not patterns or negations.
    const records = text
      .split('\n')
      .filter((l) => /^host\s/i.test(l.trim()))
      .flatMap((l) => (l.trim().slice(5).match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/"/g, '')))
      .filter((t) => !/[*?!]/.test(t))
    expect(records).toHaveLength(9)
    expectNoneLost(result, records)
    expect(result.sessions.filter((s) => s.source.format === 'ssh-config')).toHaveLength(9)
  })

  it('treats wildcard blocks as defaults, never sessions', () => {
    expect(result.sessions.some((s) => /[*?]/.test(s.name))).toBe(false)
  })

  it('applies first-obtained-value-wins across matching blocks', () => {
    const b = byName(result, 'bastion')
    expect(b).toMatchObject({ host: 'bastion.corp.example.net', username: 'jump', port: 22 })
    // ForwardAgent yes in the Host block beats "ForwardAgent no" in the trailing Host *.
    expect(b.options.ssh).toEqual({ agentForward: true })
    // IdentityFile accumulates, recorded in notes only.
    expect(b.notes).toBe('IdentityFile: ~/.ssh/id_ed25519\nIdentityFile: ~/.ssh/id_default')
  })

  it('expands %h, honours negated patterns and falls back to Host * defaults', () => {
    const c = byName(result, 'core-nxos-01')
    expect(c).toMatchObject({ host: 'core-nxos-01.dc1.example.net', username: 'netops', platform: 'nxos', jumpRef: 'bastion' })
    expect(byName(result, 'core-nxos-02').host).toBe('core-nxos-02.dc1.example.net')
    expect(byName(result, 'core-lab').username).toBe('default-user')
  })

  it('maps ProxyJump chains, creating sessions for literal hops', () => {
    const e = byName(result, 'edge-eos')
    expect(e).toMatchObject({ host: '10.1.1.1', port: 2222, platform: 'eos' })
    expect(e.jumpChain).toEqual(['admin@10.9.9.9:2200', 'bastion'])
    expect(byName(result, 'admin@10.9.9.9:2200')).toMatchObject({ host: '10.9.9.9', port: 2200, username: 'admin', tags: ['jump-host'] })
    expect(e.notes).toContain('LocalForward: 8443 127.0.0.1:443')
  })

  it('understands "ssh -W %h:%p host" ProxyCommands and warns on the rest without running them', () => {
    expect(byName(result, 'legacy-ios')).toMatchObject({ jumpRef: 'bastion', platform: 'ios' })
    const s = byName(result, 'socks-only')
    expect(s.jumpRef).toBeUndefined()
    expect(s.notes).toContain('ProxyCommand: nc -X 5 -x proxy.corp:1080 %h %p')
    expect(warningsFor(result, 'socks-only').join()).toMatch(/not run/)
  })

  it('never evaluates Match blocks and does not follow Include', () => {
    expect(result.sessions.some((s) => s.username === 'root')).toBe(false)
    expect(result.warnings.some((w) => w.item.startsWith('Match exec') && /never run/.test(w.message))).toBe(true)
    expect(result.warnings.some((w) => w.item.startsWith('Include'))).toBe(true)
  })

  it('accepts quoted aliases, Key=Value, case-insensitive keywords and unicode', () => {
    expect(byName(result, 'quoted alias').notes).toContain('IdentityFile: ~/.ssh/key with spaces')
    expect(byName(result, 'Ümlaut-rtr').host).toBe('10.7.7.7')
  })

  it('handles CRLF and a BOM', () => {
    const r = importSshConfig('﻿' + text.replace(/\n/g, '\r\n'))
    expect(r.sessions.map((s) => s.name)).toEqual(result.sessions.map((s) => s.name))
  })
})

describe('ssh_config helpers', () => {
  it('matches pattern lists like ssh', () => {
    expect(hostMatches(['core-*', '!core-lab'], 'core-1')).toBe(true)
    expect(hostMatches(['core-*', '!core-lab'], 'core-lab')).toBe(false)
    expect(hostMatches(['!core-lab'], 'x')).toBe(false)
    expect(hostMatches(['r?'], 'R1')).toBe(true)
  })
  it.each([
    ['*', 'anything', true],
    ['*', '', true],
    ['', '', true],
    ['', 'a', false],
    ['a*b*c', 'aXXbYYc', true],
    ['a*b*c', 'aXXbYY', false],
    ['*.example.com', 'core.example.com', true],
    ['*.example.com', 'coreXexample.com', false],
    ['r?.lab', 'r1.lab', true],
    ['r?.lab', 'r12.lab', false],
    ['**a', 'bba', true],
    ['a*', 'A', true],
    ['[a]+(x)', '[a]+(x)', true],
    ['[a]', 'a', false]
  ])('globMatch(%j, %j) → %s', (p, h, want) => expect(globMatch(p, h)).toBe(want))

  it('matches hostile patterns in linear time (ReDoS regression)', () => {
    // The reviewer's input froze the regex matcher for 111 s.
    const reviewer = 'Host ' + '*a'.repeat(25) + 'b\n  User x\nHost ' + 'a'.repeat(60) + '\n  HostName 10.0.0.1\n'
    // At the length cap (1024): 511 stars against a 1024-character alias, so the matcher really runs.
    const big = 'Host ' + '*a'.repeat(511) + 'b\n  User x\nHost ' + 'a'.repeat(1024) + '\n  HostName 10.0.0.2\n'
    for (const text of [reviewer, big]) {
      const t = performance.now()
      const r = importSshConfig(text)
      expect(performance.now() - t).toBeLessThan(50)
      expect(r.sessions).toHaveLength(1)
      expect(r.sessions[0]!.username).toBe('')
    }
    const host = 'a'.repeat(1024)
    const t = performance.now()
    expect(globMatch('*a'.repeat(511) + '*', host)).toBe(true)
    expect(globMatch('*' + 'a'.repeat(511) + 'b', host)).toBe(false)
    expect(globMatch('*a'.repeat(511) + 'b', host)).toBe(false)
    expect(performance.now() - t).toBeLessThan(50)
    // Over the cap: never matches, without doing the work.
    expect(globMatch('*', 'a'.repeat(1025))).toBe(false)
  })

  it('skips Host aliases over the length cap with a warning', () => {
    const r = importSshConfig(`Host ${'h'.repeat(1025)}\n  HostName 10.0.0.1\nHost ok\n  HostName 10.0.0.2\n`)
    expect(r.sessions.map((s) => s.name)).toEqual(['ok'])
    expect(r.warnings.map((w) => w.message)).toContain('Skipped: Host alias longer than 1024 characters')
  })
  it('parses hops', () => {
    expect(parseHop('admin@10.0.0.1:2200')).toEqual({ host: '10.0.0.1', port: 2200, user: 'admin' })
    expect(parseHop('ssh://[2001:db8::1]:22')).toEqual({ host: '2001:db8::1', port: 22, user: undefined })
    expect(parseHop('bastion')).toEqual({ host: 'bastion', port: undefined, user: undefined })
    expect(parseHop('host:99999')).toBeNull()
  })
})
