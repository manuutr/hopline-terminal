import { describe, expect, it } from 'vitest'
import { classify, PLATFORM_LABELS, PLATFORMS, type Platform } from '../src'

const kind = (cmd: string, p: Platform = 'ios') => classify(cmd, p).kind

describe('read-only allow-list', () => {
  it.each([
    'show ip interface brief',
    'sh ip int br',
    'show running-config',
    'show ip bgp summary | include 10.0.0',
    'sh run | i hostname',
    'show interfaces | section GigabitEthernet0/1',
    'show mac address-table | count dynamic',
    'show ver | be Cisco',
    'ping 10.0.0.2',
    'traceroute 8.8.8.8'
  ])('ios: %s → read', (cmd) => expect(kind(cmd)).toBe('read'))

  it.each([
    'show ip bgp summary | json',
    'show interface status | grep connected',
    'show version | no-more',
    'sh vlan | egrep active'
  ])('nxos: %s → read', (cmd) => expect(kind(cmd, 'nxos')).toBe('read'))

  it.each(['show ip bgp summary | json', 'show interfaces status | nz', 'sh ver', 'show vrrp', 'show vrrp brief', 'show port-security', 'show port-security interface Ethernet11'])('eos: %s → read', (cmd) =>
    expect(kind(cmd, 'eos')).toBe('read')
  )

  it.each([
    'show interfaces terse',
    'show route | match 10.0.0',
    'show configuration | display set',
    'show bgp summary | no-more',
    'ping 10.0.0.2 count 5',
    'ping 10.0.0.2 rapid'
  ])('junos: %s → read', (cmd) => expect(kind(cmd, 'junos')).toBe('read'))

  it('returns the trimmed command to send', () => {
    expect(classify('   show version  ', 'ios').command).toBe('show version')
  })
})

describe('hard deny-list', () => {
  it.each([
    'reload',
    'reload in 5',
    'rel',
    'reload cancel',
    'write erase',
    'wr er',
    'write er',
    'erase startup-config',
    'erase nvram:',
    'format flash:',
    'delete flash:config.text',
    'del /force flash:*',
    'configure replace flash:old.cfg',
    'conf rep flash:x',
    'configure memory',
    'copy startup-config running-config',
    'copy tftp: flash:',
    'squeeze flash:',
    'debug all',
    'debug a',
    'tclsh',
    'guestshell run bash',
    'install add file bootflash:x.bin activate commit',
    'telnet 10.9.9.9',
    'ssh -l admin 10.9.9.9',
    'test crash',
    'request platform software package clean'
  ])('ios: %s → blocked', (cmd) => expect(kind(cmd)).toBe('blocked'))

  it.each([
    'reload',
    'run bash',
    'bash',
    'python',
    'write erase',
    'delete bootflash:nxos.bin',
    'init-system',
    'rollback running-config checkpoint x',
    'configure replace bootflash:x',
    'echo hi > bootflash:x'
  ])('nxos: %s → blocked', (cmd) => expect(kind(cmd, 'nxos')).toBe('blocked'))

  it.each(['reload now', 'bash', 'bash sudo rm -rf /', 'zerotouch cancel', 'write erase now', 'boot system flash:x.swi'])(
    'eos: %s → blocked',
    (cmd) => expect(kind(cmd, 'eos')).toBe('blocked')
  )

  it.each([
    'request system reboot',
    'request system zeroize',
    'request system software add x.tgz',
    'req sys reb',
    'start shell',
    'start shell sh',
    'restart routing',
    'file delete /var/tmp/x',
    'op myscript'
  ])('junos: %s → blocked', (cmd) => expect(kind(cmd, 'junos')).toBe('blocked'))
})

describe('bypass attempts', () => {
  describe('abbreviations that are ambiguous with a blocked keyword', () => {
    it.each([
      ['r', 'ios'],
      ['re', 'ios'],
      ['e', 'ios'],
      ['d', 'ios'],
      ['s', 'ios'],
      ['b', 'eos'],
      ['r', 'nxos'],
      ['re', 'junos'],
      ['s', 'junos']
    ] as const)('%s (%s) → blocked', (cmd, p) => expect(kind(cmd, p)).toBe('blocked'))
  })

  describe('do / run prefix from config mode', () => {
    it('do reload is blocked', () => expect(kind('do reload')).toBe('blocked'))
    it('do wr er is blocked', () => expect(kind('do wr er')).toBe('blocked'))
    it('do show ... is read, sent without "do"', () => {
      const c = classify('do show ip route', 'ios')
      expect(c.kind).toBe('read')
      expect(c.command).toBe('show ip route')
    })
    it('junos run request system reboot is blocked', () =>
      expect(kind('run request system reboot', 'junos')).toBe('blocked'))
    it('bare do is blocked', () => expect(kind('do')).toBe('blocked'))
  })

  describe('pipes that write files or execute code', () => {
    it.each([
      ['show run | redirect flash:x', 'ios'],
      ['show run | red flash:x', 'ios'],
      ['show run | tee flash:x', 'ios'],
      ['show run | t flash:x', 'ios'],
      ['show run | append flash:x', 'ios'],
      ['show run | a flash:x', 'ios'],
      ['show tech | format x', 'ios'],
      ['show run | include x | redirect tftp://1.2.3.4/x', 'ios'],
      ['show run | vsh', 'nxos'],
      ['show run | email x@y', 'nxos'],
      ['show run | python', 'nxos'],
      ['show run | bash cat', 'eos'],
      ['show configuration | save /var/tmp/x', 'junos'],
      ['show route | refresh 1', 'junos'],
      ['show route | sa x', 'junos']
    ] as const)('%s (%s) → blocked', (cmd, p) => expect(kind(cmd, p)).toBe('blocked'))

    it('unknown pipe filters are blocked, not allowed', () =>
      expect(kind('show run | something-new')).toBe('blocked'))
    it('empty pipe segment is blocked', () => expect(kind('show run |')).toBe('blocked'))
    it('more than four pipes is blocked (NX-OS chains pipes)', () =>
      expect(kind('show run | i a | i b | i c | i d | i e', 'nxos')).toBe('blocked'))
    // Behaviour change: on IOS the first regex filter takes the rest of the line, so `|` after it
    // is regex alternation, not another pipe.
    it('IOS: | inside an include regex is alternation', () => {
      expect(kind('show interfaces GigabitEthernet1/0/4 | include line protocol|Last input', 'iosxe')).toBe('read')
      expect(kind('show run | i a | i b | i c | i d | i e')).toBe('read')
    })
    it('IOS: a writer hidden after a regex is still blocked', () => {
      expect(kind('show run | i foo | redirect flash:x')).toBe('blocked')
      expect(kind('show run | i foo|tee flash:x')).toBe('blocked')
    })
  })

  describe('chaining, redirection and control characters', () => {
    it.each([
      'show version ; reload',
      'show version;reload',
      'show run > bootflash:x',
      'show run >> flash:x',
      'show version\nreload',
      'show version\rreload',
      'show version\r\nreload',
      'show\tversion',
      'show version\x03',
      'show version\x1b[2J',
      'show version\x7f',
      'show `reload`',
      'show $(reload)',
      'ѕhow version', // Cyrillic "ѕ"
      'show version '
    ])('%j → blocked', (cmd) => {
      for (const p of PLATFORMS) expect(kind(cmd, p)).toBe('blocked')
    })

    it('over-long commands are blocked', () => expect(kind('show ' + 'a'.repeat(600))).toBe('blocked'))
    it('empty command is blocked', () => expect(kind('   ')).toBe('blocked'))
  })

  describe('shell escapes', () => {
    it.each([
      ['bash', 'eos'],
      ['run bash', 'nxos'],
      ['guestshell', 'nxos'],
      ['start shell', 'junos'],
      ['tclsh', 'ios'],
      ['tclsh', 'iosxe'],
      ['python', 'nxos']
    ] as const)('%s (%s) → blocked', (cmd, p) => expect(kind(cmd, p)).toBe('blocked'))
  })

  it('case does not matter', () => {
    expect(kind('RELOAD')).toBe('blocked')
    expect(kind('Write Erase')).toBe('blocked')
    expect(kind('SHOW VERSION')).toBe('read')
  })
})

describe('config (requires approval)', () => {
  it.each([
    'configure terminal',
    'conf t',
    'clear ip bgp * soft',
    'copy running-config startup-config',
    'copy run start',
    'write memory',
    'wr',
    'debug ip bgp',
    'terminal monitor',
    'undebug all',
    'no debug all',
    'some-unknown-command'
  ])('ios: %s → config', (cmd) => expect(kind(cmd)).toBe('config'))

  it.each(['configure', 'edit', 'clear bgp neighbor 10.0.0.2 soft', 'set cli screen-length 0'])('junos: %s → config', (cmd) =>
    expect(kind(cmd, 'junos')).toBe('config')
  )

  it('junos ping without count is not auto-run', () => expect(kind('ping 10.0.0.2', 'junos')).toBe('config'))

  it('never classifies an unknown command as read', () => {
    for (const p of PLATFORMS) expect(kind('frobnicate everything', p)).not.toBe('read')
  })
})

describe('disruptive (approval plus a second confirmation)', () => {
  it.each([
    ['clear ip bgp *', 'ios'],
    ['cl ip bg *', 'ios'],
    ['clear ip bgp 10.0.0.6', 'ios'],
    ['clear logging', 'ios'],
    ['clear bgp neighbor', 'junos'],
    ['clear bgp neighbor 10.0.0.2', 'junos'],
    ['clear ip bgp *', 'eos'],
    ['clear bgp all *', 'nxos']
  ] as const)('%s (%s) → disruptive', (cmd, p) => expect(kind(cmd, p)).toBe('disruptive'))
})

describe('every classification carries a reason', () => {
  it.each(['show version', 'reload', 'conf t', 'show run | tee x'])('%s', (cmd) => {
    expect(classify(cmd, 'ios').reason.length).toBeGreaterThan(5)
  })
})

describe('parsed base command and pipe stages', () => {
  it('IOS: one regex stage', () => {
    const c = classify('sh int Gi1/0/4 | i line protocol|Last input', 'iosxe')
    expect(c.base).toBe('show interfaces Gi1/0/4')
    expect(c.pipes).toEqual([{ name: 'include', args: ['line protocol|Last input'] }])
  })
  it('EOS: chained stages', () => {
    const c = classify('show logging | grep -i bgp | tail -n 30', 'eos')
    expect(c.kind).toBe('read')
    expect(c.pipes).toEqual([
      { name: 'grep', args: ['-i', 'bgp'] },
      { name: 'tail', args: ['-n', '30'] }
    ])
  })
  it('unknown pipes say what to use instead', () => {
    const c = classify('show logging | tail 30', 'ios')
    expect(c.kind).toBe('blocked')
    expect(c.reason).toMatch(/has no "\| tail".*\| include.*filter the output locally/)
  })
})

describe('platform labels', () => {
  it('match the cli-model profiles', async () => {
    const { PROFILES } = await import('@hopline/cli-model')
    for (const [p, label] of Object.entries(PLATFORM_LABELS)) expect(label).toBe(PROFILES[p as keyof typeof PROFILES].label)
  })
})

describe('unknown pipe hints are actionable', () => {
  it('explains that IOS-XR has no regex alternation', () =>
    expect(classify('show logging | include BGP|OSPF', 'iosxr').reason).toMatch(/new pipe at every "\|".*not regex alternation/))
  it('does not list an empty filter set', () => {
    const r = classify('show sysinfo | tail', 'aireos')
    expect(r.kind).toBe('blocked')
    expect(r.reason).toMatch(/no read-only output filters/)
    expect(r.reason).not.toMatch(/use ,/)
  })
})
