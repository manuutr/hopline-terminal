import { describe, expect, it } from 'vitest'
import { canonicalize, isIpLiteral, matchWord, probeOf, resolve, type ModeId, type PlatformId } from '../src'

const risk = (p: PlatformId, line: string, mode: ModeId = 'exec') => resolve(p, mode, line).risk

describe('canonicalize (Phase 8 H3)', () => {
  it('expands the head and strips do/run wrappers like the guard', () => {
    expect(canonicalize('iosxe', 'exec', 'pi 10.0.0.1 rep 5').head).toEqual(['ping'])
    expect(canonicalize('iosxe', 'exec', 'do do ping 10.0.0.1').head).toEqual(['ping'])
    expect(canonicalize('iosxe', 'config', 'do ping evil.example').head).toEqual(['ping'])
    expect(canonicalize('iosxe', 'config', 'do-exec ping evil.example').head).toEqual(['ping'])
    expect(canonicalize('fortios', 'exec', 'exe ping evil.example')).toMatchObject({ head: ['execute', 'ping'], rest: ['evil.example'] })
    expect(canonicalize('iosxe', 'exec', 'ping 10.0.0.1 rep 5 | i x').rest).toEqual(['10.0.0.1', 'rep', '5'])
  })
  it('matchWord: exact wins, else a unique prefix; several are ambiguous', () => {
    expect(matchWord(['repeat', 'size'], 'rep')).toEqual({ word: 'repeat' })
    expect(matchWord(['size', 'source'], 's')).toEqual({ ambiguous: ['size', 'source'] })
    expect(matchWord(['ping', 'ping6'], 'ping')).toEqual({ word: 'ping' })
    expect(matchWord(['size'], 'x')).toBeNull()
  })
})

describe('probes: caps on every platform (Phase 8 H2)', () => {
  it.each([
    ['iosxe', 'ping 10.0.0.1', 'read'],
    ['iosxe', 'ping 10.0.0.1 repeat 10 size 1500 timeout 5', 'read'],
    ['iosxe', 'ping 10.0.0.1 repeat 11', 'config'],
    ['iosxe', 'ping 10.0.0.1 rep 2147483647 si 18024 ti 0', 'config'],
    ['iosxe', 'ping 10.0.0.1 s 100', 'config'], // ambiguous (size, source)
    ['iosxe', 'ping 10.0.0.1 data DEAD', 'config'],
    ['iosxe', 'ping 10.0.0.1 sweep-max 2000', 'config'], // unknown option
    ['iosxe', 'traceroute 10.0.0.1 ttl 1 30 probe 3 timeout 2', 'read'],
    ['iosxe', 'traceroute 10.0.0.1 ttl 1 255', 'config'],
    ['nxos', 'ping 10.0.0.1 count unlimited', 'config'],
    ['nxos', 'ping 10.0.0.1 coun 5 vrf management', 'read'],
    ['asa', 'ping inside 10.0.0.1 repeat 5', 'read'],
    ['asa', 'ping inside 10.0.0.1 repeat 50', 'config'],
    ['asa', 'sh dns look example.test', 'config'],
    ['ftd', 'show dns lookup example.test', 'config'],
    ['fortios', 'show dns lookup example.test', 'config'],
    ['junos', 'ping 10.0.0.1', 'config'], // never stops without a count
    ['junos', 'ping 10.0.0.1 rapid', 'read'],
    ['junos', 'ping 10.0.0.1 count 5 wait 1', 'read'],
    ['panos', 'ping host 10.0.0.1', 'config'],
    ['panos', 'ping count 5 host 10.0.0.1', 'read'],
    ['vrp', 'ping -c 5 -t 2000 10.0.0.1', 'read'],
    ['vrp', 'ping -c 5 -t 9000 10.0.0.1', 'config'], // VRP -t is in milliseconds
    ['fortios', 'execute ping 10.0.0.1', 'read'],
    ['fortios', 'execute ping 10.0.0.1 extra', 'config'],
    ['aoscx', 'ping 10.0.0.1 repetitions 5', 'read']
  ] as const)('%s: %s → %s', (p, line, want) => expect(risk(p, line)).toBe(want))

  it('reports targets and canonical options', () => {
    const p = probeOf('iosxe', 'exec', 'pi vrf MGMT 10.0.0.1 rep 5 so lo0')!
    expect(p).toMatchObject({ verb: 'ping', head: 'ping', targets: ['10.0.0.1'], problems: [] })
    expect(p.options.map((o) => o.word)).toEqual(['vrf', 'repeat', 'source'])
    expect(probeOf('asa', 'exec', 'ping inside 10.0.0.1')).toMatchObject({ leading: 'inside', targets: ['10.0.0.1'] })
    expect(probeOf('panos', 'exec', 'ping count 5 host evil.example')!.targets).toEqual(['evil.example'])
    expect(probeOf('iosxe', 'exec', 'show version')).toBeNull()
  })

  it('IP literals', () => {
    for (const ok of ['10.0.0.1', '2001:db8::1', '::1', '[fe80::1]', '::ffff:10.0.0.1', '1:2:3:4:5:6:7:8']) expect(isIpLiteral(ok), ok).toBe(true)
    for (const bad of ['10.0.0', '10.0.0.256', 'evil.example', '1leak.attacker.example', '10.0.0.1/24', 'dead:beef', '1::2::3', 'deadbeef', '192.0.2.1::', '[192.0.2.1]']) expect(isIpLiteral(bad), bad).toBe(false)
  })
})

describe('deny-list gaps (Phase 8 M1)', () => {
  it.each([
    ['iosxe', 'config', 'no crypto pki trustpoint TP-self-signed-1'],
    ['iosxe', 'config', 'no license boot level'],
    ['iosxe', 'config', 'no redundancy'],
    ['iosxe', 'config', 'no event manager applet x'],
    ['iosxe', 'config', 'default alias exec x'],
    ['iosxe', 'config', 'do-exec reload'],
    ['nxos', 'exec', 'run-script bootflash:x'],
    ['iosxr', 'exec', 'utility mv disk0:a disk0:b'],
    ['iosxr', 'config', 'alias x reload'],
    ['asa', 'config', 'action 1 cli command "reload noconfirm"'],
    ['eos', 'exec', 'redundancy force-switchover'],
    ['fortios', 'exec', 'config system auto-script'],
    ['panos', 'exec', 'request system software in']
  ] as const)('%s %s: %s is blocked', (p, mode, line) => expect(risk(p, line, mode)).toBe('blocked'))

  it('negations the trees list themselves keep their own risk', () => {
    expect(risk('iosxe', 'no shutdown', 'config-if')).toBe('config')
    expect(risk('iosxe', 'no ip domain lookup', 'config')).toBe('config')
    expect(risk('iosxe', 'no logging console', 'config')).toBe('config')
  })

  it('an abbreviation under a deny-listed head only escalates a would-be read', () => {
    expect(risk('iosxe', 'copy run start')).toBe('config')
    expect(risk('panos', 'request system software info')).toBe('read')
    expect(risk('panos', 'request system software in')).toBe('blocked')
  })
})
