import { describe, expect, it } from 'vitest'
import { countCommands, getPlatform, PLATFORM_IDS, PROFILES, resolve, tokenize, type ModeId, type PlatformId, type Risk } from '../src'
import { RESEARCH_READS } from './research-reads'

const r = (p: PlatformId, line: string, mode: ModeId = 'exec') => resolve(p, mode, line)

describe('daily-use abbreviations resolve', () => {
  it.each([
    ['ios', 'sh ip b', 'show ip bgp'],
    ['ios', 'sh ip int br', 'show ip interface brief'],
    ['ios', 'show int status', 'show interfaces status'],
    ['ios', 'sh run', 'show running-config'],
    ['ios', 'show ip route vrf X', 'show ip route vrf X'],
    ['iosxe', 'sh ip bgp sum', 'show ip bgp summary'],
    ['iosxe', 'show bgp summary', 'show bgp summary'],
    ['eos', 'show bgp summary', 'show bgp summary'],
    ['nxos', 'show bgp all summary', 'show bgp all summary'],
    ['nxos', 'sh int br', 'show interface brief'],
    ['eos', 'sh ip b su', 'show ip bgp summary'],
    ['eos', 'show int status', 'show interfaces status'],
    ['junos', 'show interfaces terse', 'show interfaces terse'],
    ['junos', 'sh bgp su', 'show bgp summary'],
    ['panos', 'show system info', 'show system info'],
    ['fortios', 'get sys stat', 'get system status']
  ] as const)('%s: %s → %s', (p, line, expanded) => {
    const res = r(p, line)
    expect(res.status).toBe('ok')
    expect(res.risk).toBe('read')
    expect(res.expanded).toBe(expanded)
  })

  it('captures typed params', () => {
    expect(r('ios', 'show ip route vrf RED').params).toEqual({ vrf: 'RED' })
    expect(r('ios', 'show interfaces gi 1/0/1 status').params.interface).toBe('gi 1/0/1')
    expect(r('ios', 'clear ip bgp 10.0.0.6 soft in').params.neighbor).toBe('10.0.0.6')
  })

  it('expands pipes', () => {
    const res = r('ios', 'show run | i hostname')
    expect(res.expanded).toBe('show running-config | include hostname')
    expect(res.pipes).toHaveLength(1)
    expect(res.risk).toBe('read')
  })
})

describe('risk', () => {
  it.each([
    ['ios', 'exec', 'wr er', 'blocked'],
    ['ios', 'exec', 'wr', 'config'],
    ['ios', 'exec', 'copy run start', 'config'],
    ['ios', 'exec', 'copy start run', 'blocked'],
    ['ios', 'exec', 'clear ip bgp *', 'disruptive'],
    ['ios', 'exec', 'clear ip bgp * soft', 'config'],
    ['ios', 'exec', 'show run | redirect flash:x', 'blocked'],
    ['ios', 'config', 'do wr er', 'blocked'],
    ['ios', 'config-if', 'shutdown', 'disruptive'],
    ['ios', 'config-if', 'sw tr al vl 10', 'disruptive'],
    ['ios', 'config-if', 'switchport trunk allowed vlan add 10', 'config'],
    ['junos', 'exec', 'ping 1.1.1.1', 'config'],
    ['junos', 'exec', 'ping 1.1.1.1 count 5', 'read'],
    ['junos', 'exec', 'show route | hold', 'blocked'],
    ['junos', 'exec', 'show route | match "a|b"', 'read'],
    ['junos', 'config', 'run request system reboot', 'blocked'],
    ['junos', 'config', 'delete', 'blocked'],
    ['junos', 'config', 'delete interfaces ge-0/0/0 unit 0', 'config'],
    ['eos', 'exec', 'show version | grep x', 'read'],
    ['eos', 'exec', 'show version | count', 'blocked'],
    ['eos', 'exec', 'show logging | tail -f', 'blocked'],
    ['ios', 'exec', 'show logging | tail 30', 'blocked'],
    ['iosxe', 'exec', 'show interfaces Gi1/0/4 | include line protocol|Last input', 'read'],
    ['ios', 'exec', 'show run | i foo | redirect flash:x', 'blocked'],
    ['eos', 'exec', 'show ip bgp summary | json', 'read'],
    ['eos', 'exec', 'show logging follow', 'blocked'],
    ['fortios', 'exec', 'exe factoryreset', 'blocked'],
    ['fortios', 'exec', "diagnose sniffer packet any 'host 1.1.1.1' 4 10", 'disruptive'],
    ['fortios', 'exec', "diagnose sniffer packet any 'host 1.1.1.1' 4", 'blocked'],
    ['panos', 'exec', 'show system resources follow', 'blocked'],
    ['panos', 'exec', 'request restart system', 'blocked']
  ] as const)('%s %s: %s → %s', (p, mode, line, risk) => expect(r(p, line, mode).risk).toBe(risk as Risk))

  it('ambiguous prefixes report every candidate and take the worst risk', () => {
    const res = r('ios', 'rel')
    expect(res.status).toBe('ambiguous')
    expect(res.ambiguity?.candidates).toEqual(expect.arrayContaining(['release', 'reload']))
    expect(res.risk).toBe('blocked')
  })

  it('an unknown command is config (default-deny), never read', () => {
    const res = r('ios', 'frobnicate the switch')
    expect(res.status).toBe('invalid')
    expect(res.risk).toBe('config')
  })

  it('an incomplete read command is not read', () => expect(r('fortios', 'execute ping').risk).not.toBe('read'))

  it('unbalanced quotes block on quote-aware platforms', () => expect(r('junos', 'show route | match "abc').risk).toBe('blocked'))
})

describe('tokenize', () => {
  it('splits pipes and keeps quoted text', () => {
    const t = tokenize('show route | match "a | b"', true)
    expect(t.tokens.map((x) => x.text)).toEqual(['show', 'route', '|', 'match', 'a | b'])
    expect(t.unbalanced).toBe(false)
  })
  it('is not quote-aware where the device is not', () => {
    expect(tokenize('show run | i "a | b"', false).tokens.filter((x) => x.text === '|')).toHaveLength(2)
  })
})

describe('research coverage (§6 show commands, §8 live-value sources)', () => {
  for (const [p, cmds] of Object.entries(RESEARCH_READS) as [PlatformId, readonly string[]][]) {
    it(`${p}: ${cmds.length} commands resolve as read`, () => {
      const notRead = cmds.filter((c) => r(p, c).risk !== 'read').map((c) => `${c} → ${r(p, c).risk}: ${r(p, c).reason}`)
      expect(notRead).toEqual([])
    })
  }
})

describe('profiles and trees', () => {
  it('every platform has a profile, exec/config/pipe trees and consistent mode ids', () => {
    for (const p of PLATFORM_IDS) {
      const m = getPlatform(p)
      expect(PROFILES[p].id).toBe(p)
      for (const mode of ['exec', 'config', 'pipe'] as const) expect(m.tree(mode), `${p} ${mode}`).toBeDefined()
    }
  })

  it('command counts per platform (exec tree)', () => {
    const counts = Object.fromEntries(PLATFORM_IDS.map((p) => [p, countCommands(getPlatform(p).tree('exec')!)]))
    // Full depth for the four main platforms, read-only depth for PAN-OS and FortiOS.
    for (const p of ['ios', 'iosxe', 'nxos', 'eos'] as const) expect(counts[p]).toBeGreaterThan(400)
    expect(counts.junos).toBeGreaterThan(250)
    expect(counts.panos).toBeGreaterThan(100)
    expect(counts.fortios).toBeGreaterThan(100)
  })

  it('every runnable node has one-line help', () => {
    for (const p of PLATFORM_IDS)
      for (const mode of getPlatform(p).modes) {
        const tree = getPlatform(p).tree(mode)
        const walk = (n: NonNullable<typeof tree>, path: string): void => {
          for (const k of n.keywords) {
            expect(k.help, `${p} ${mode} ${path} ${k.word}`).toBeTruthy()
            expect(k.help).not.toMatch(/\n/)
            walk(k, `${path} ${k.word}`)
          }
          for (const c of n.params) walk(c, `${path} <${c.param?.label}>`)
        }
        if (tree) walk(tree, '')
      }
  })
})
