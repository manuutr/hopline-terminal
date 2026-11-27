import { describe, expect, it } from 'vitest'
import { classify } from '@hopline/guard'
import { contextChangeLine } from '@shared/cli'
import { newKey, sign, verify } from '@shared/verdict'
import { hostRefusal } from '../src/session-host/guard-check'
import { analyze } from '../src/main/productivity/runner'

/** Phase 8 review, workstream A Lows (AUDIT.md §0g). */

describe('A-L1: the exec deny-list holds at a configuration prompt', () => {
  it('main and the host refuse an unmodelled exec-only deny-listed line in a config block', () => {
    expect(classify('execute reboot', 'fortios', { mode: 'config' }).kind).toBe('blocked')
    expect(classify('exe factoryreset', 'fortios', { mode: 'config' }).kind).toBe('blocked')
    expect(hostRefusal('execute reboot', 'fortios', 'config', 'FGT1 (global) # ', undefined, ['FGT1'])).toMatch(/refused by session host/)
    expect(hostRefusal('request system reboot', 'junos', 'config', 'admin@r1# ', undefined, ['r1'])).toMatch(/refused by session host/)
  })
  it('a modelled config line keeps its config meaning', () => {
    expect(classify('crypto pki trustpoint TP1', 'iosxe', { mode: 'config' }).kind).toBe('config')
    expect(hostRefusal('crypto pki trustpoint TP1', 'iosxe', 'config', 'r1(config)#', undefined, ['r1'])).toBeNull()
  })
})

describe('A-L4: context changes', () => {
  it('EOS cli vrf and Junos set cli logical-system switch the context', () => {
    expect(contextChangeLine('eos', 'cli vrf blue')).toBe(true)
    expect(contextChangeLine('eos', 'cli vr blue')).toBe(true)
    expect(contextChangeLine('junos', 'set cli logical-system ls1')).toBe(true)
    expect(contextChangeLine('eos', 'show vrf')).toBe(false)
  })
  it('inside a configuration plan they are refused', () => {
    expect(analyze('eos', ['hostname x', 'cli vrf x']).kind).not.toBe('config')
  })
})

describe('A-L5: verdict tokens are exactly body.sig, with only signed fields', () => {
  const key = newKey()
  const v = { tabId: 't', command: 'show version', kind: 'read' as const, platform: 'iosxe' as const }
  it('a valid token verifies; a third part or an unsigned field does not', () => {
    const tok = sign(key, v)
    expect(verify(key, tok, 't', 'show version')).not.toBeNull()
    expect(verify(key, `${tok}.x`, 't', 'show version')).toBeNull()
    const [body, sig] = tok.split('.')
    const extra = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), x: 1 })).toString('base64url')
    expect(verify(key, `${extra}.${sig}`, 't', 'show version')).toBeNull()
  })
})

describe('A-L6 / A-L7 decisions', () => {
  it.each([
    ['asa', 'exec', 'debug all', 'blocked'],
    ['fortios', 'exec', 'diagnose sys flash format', 'blocked'],
    ['ftd', 'exec', 'restart', 'blocked'],
    ['iosxe', 'config', 'no boot system', 'blocked'],
    ['asa', 'exec', 'failover reload-standby', 'disruptive'],
    ['fortios', 'exec', 'execute ha failover set 1', 'disruptive'],
    ['fortios', 'exec', 'execute log delete-all', 'disruptive'],
    ['junos', 'config', 'rollback 1', 'disruptive'],
    ['aoscx', 'exec', 'show logging -f', 'config'],
    ['aoscx', 'exec', 'show events -f', 'config'],
    ['aoscx', 'exec', 'show logging -r', 'read'],
    ['fortios', 'exec', 'diagnose test authserver ldap srv user pass', 'config']
  ] as const)('%s %s: %s → %s', (p, mode, line, want) => expect(classify(line, p, { mode }).kind).toBe(want))
})
