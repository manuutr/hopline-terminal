import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { policyBlocked } from '@shared/policy-deny'
import { adminPolicyPath, decodePolicy, FAIL_CLOSED, loadPolicy, parsePolicy, POLICY_ENV, suspiciousKey, windowsProgramData } from '../src/main/policy/policy'
import { analyze } from '../src/main/productivity/runner'
import { policyRefusal } from '../src/session-host/guard-check'

/** Phase 5 safety review L7: team policy loading. */

const dir = mkdtempSync(join(tmpdir(), 'hopline-p5-policy-'))
const NOWHERE = join(dir, 'no-admin', 'policy.json')
const put = (name: string, data: string | Uint8Array) => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

describe('Windows admin path (L7)', () => {
  it('comes from the registry, not the ProgramData environment variable', () => {
    const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders\r\n    Common AppData    REG_SZ    D:\\ProgramData\r\n\r\n'
    expect(windowsProgramData(() => reg)).toBe('D:\\ProgramData')
    expect(adminPolicyPath('win32', () => 'D:\\ProgramData')).toBe('D:\\ProgramData\\Hopline\\policy.json')
  })
  it('falls back to C:\\ProgramData when the registry cannot be read or looks wrong', () => {
    expect(
      windowsProgramData(() => {
        throw new Error('no reg.exe')
      })
    ).toBe('C:\\ProgramData')
    expect(windowsProgramData(() => 'Common AppData    REG_SZ    %ProgramData%')).toBe('C:\\ProgramData')
    expect(windowsProgramData(() => 'Common AppData    REG_SZ    \\\\server\\share')).toBe('C:\\ProgramData')
  })
  it('ignores the environment on every OS', () => {
    const before = process.env['ProgramData']
    process.env['ProgramData'] = 'C:\\x'
    try {
      expect(adminPolicyPath('win32', () => 'C:\\ProgramData')).toBe('C:\\ProgramData\\Hopline\\policy.json')
      expect(adminPolicyPath('linux')).toBe('/etc/hopline/policy.json')
    } finally {
      if (before === undefined) delete process.env['ProgramData']
      else process.env['ProgramData'] = before
    }
  })
})

describe('policy file contents (L7)', () => {
  it.skipIf(process.platform === 'win32')('a dangling symlink at the admin path fails closed (HOPLINE_POLICY is not used)', () => {
    const link = join(dir, 'dangling.json')
    symlinkSync(join(dir, 'gone.json'), link)
    const user = put('user.json', JSON.stringify({ version: 1, name: 'user' }))
    expect(loadPolicy({ adminPath: link, env: { [POLICY_ENV]: user } })).toMatchObject({ state: 'invalid', source: link })
  })

  it('__proto__, constructor and prototype keys fail closed', () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      const p = parsePolicy(`{"version":1,"blockedCommands":{"${k}":["show running-config"]}}`, '/p.json')
      expect(p, k).toMatchObject({ state: 'invalid', error: `the key "${k}" is not allowed` })
      expect(p.locks).toEqual(FAIL_CLOSED)
    }
  })

  it('a duplicate key fails closed, at any depth', () => {
    expect(parsePolicy('{"version":1,"readOnly":true,"readOnly":false}', '/p.json')).toMatchObject({ state: 'invalid', error: 'the key "readOnly" appears twice in one object' })
    expect(parsePolicy('{"version":1,"blockedCommands":{"iosxe":["a"],"iosxe":[]}}', '/p.json')).toMatchObject({ state: 'invalid', error: expect.stringMatching(/"iosxe" appears twice/) })
    expect(suspiciousKey('{"a":{"b":1},"c":{"b":2},"d":["x","x"],"e":"a\\"b","f":"a\\"b"}')).toBeNull()
  })

  it('accepts UTF-8 with a BOM and UTF-16 with a BOM; invalid bytes fail closed', () => {
    const json = JSON.stringify({ version: 1, name: 'bom', readOnly: true })
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])
    const be = Buffer.from(le)
    be.swap16()
    for (const [name, data] of [
      ['utf8bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)])],
      ['utf16le.json', le],
      ['utf16be.json', be]
    ] as const)
      expect(loadPolicy({ adminPath: put(name, data), env: {} }), name).toMatchObject({ state: 'active', name: 'bom' })
    expect(decodePolicy(Buffer.from(json))).toBe(json)
    expect(loadPolicy({ adminPath: put('bad.json', Buffer.from([0x7b, 0xc3, 0x28, 0x7d])), env: {} })).toMatchObject({ state: 'invalid', error: 'not valid UTF-8 or UTF-16 text' })
  })
})

describe('an invalid policy blocks every command Hopline sends (L7)', () => {
  const rules = parsePolicy('{', '/etc/hopline/policy.json').locks.blockedCommands
  it('snippets, send-to-many and backups (analyze, client.exec) refuse reads too', () => {
    expect(analyze('iosxe', ['show version'], { policy: rules })).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/policy file is invalid/) })
    expect(policyBlocked(rules, 'junos', 'show configuration')).toMatch(/policy file is invalid/)
  })
  it('the session host refuses them too, on an identified or not yet identified device', () => {
    expect(policyRefusal(rules, 'iosxe', 'show clock')).toMatch(/policy file is invalid/)
    expect(policyRefusal(rules, 'auto', 'show version')).toMatch(/policy file is invalid/)
  })
  it('no policy and an active policy are unchanged', () => {
    expect(loadPolicy({ adminPath: NOWHERE, env: {} }).locks.blockedCommands).toEqual({})
    expect(policyBlocked(parsePolicy('{"version":1}', '/p.json').locks.blockedCommands, 'iosxe', 'show version')).toBeNull()
  })
})
