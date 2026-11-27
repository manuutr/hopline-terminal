import { describe, expect, it, vi } from 'vitest'
import { highlightLine, StreamHighlighter } from '../src/renderer/src/lib/highlight'

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
/** Text painted with the given SGR color code. */
const painted = (s: string, color: number) => new RegExp(`\\x1b\\[${color}m${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\x1b\\[39m`)

describe('highlightLine', () => {
  it.each([
    ['GigabitEthernet1/0/2   10.0.0.1  YES manual up  up', 'GigabitEthernet1/0/2', 34],
    ['Gi1/0/5 is up', 'Gi1/0/5', 34],
    ['Port-channel10', 'Port-channel10', 34],
    ['Et1 connected', 'Et1', 34],
    ['ge-0/0/0.0 up', 'ge-0/0/0.0', 34],
    ['irb.10 up', 'irb.10', 34],
    ['neighbor 10.0.0.2 remote-as 65002', '10.0.0.2', 36],
    ['O    10.1.0.0/16 [110/2]', '10.1.0.0/16', 36],
    ['ipv6 address 2001:db8::1/64', '2001:db8::1/64', 36],
    ['  10  aabb.cc00.0110  DYNAMIC  Gi1/0/5', 'aabb.cc00.0110', 35],
    ['mac 00:1c:73:aa:bb:cc', '00:1c:73:aa:bb:cc', 35],
    ['10.0.0.2  4  65002  0  0  1  0  0 03:02:11 Idle', 'Idle', 31],
    ['Gi1/0/2  administratively down down', 'down', 31],
    ['Et3   notconnect   1', 'notconnect', 31],
    ['Gi1/0/1 is up, line protocol is up', 'up', 32],
    ['BGP state = Established, up for 1d', 'Established', 32],
    ['10.0.0.9 4 65009 0 0 1 0 0 never Active', 'Active', 33]
  ])('%s → colors %s', (line, token, color) => {
    const out = highlightLine(line, false)
    expect(out).toMatch(painted(token, color))
    expect(plain(out)).toBe(line)
  })

  it('column headers are not states', () => {
    expect(highlightLine('AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd', false)).not.toMatch(/\x1b\[3[123]m/)
  })

  it('dims unassigned and never', () => {
    expect(highlightLine('Gi1/0/3  unassigned  YES unset  up', false)).toMatch(/\x1b\[90munassigned\x1b\[39m/)
  })

  it('dims timestamps and leaves versions and plain numbers intact', () => {
    expect(highlightLine('12:00:01.123 UTC', false)).toBe('\x1b[90m12:00:01.123\x1b[39m UTC')
    for (const line of ['Version 17.9.4a', 'Cisco IOS XE Software, Version 17.09.04a'])
      expect(highlightLine(line, false)).toBe(line)
  })

  it('colors only non-zero error counters', () => {
    const out = highlightLine('     0 input errors, 5 CRC, 0 frame, 12 overrun', false)
    expect(plain(out)).toBe('     0 input errors, 5 CRC, 0 frame, 12 overrun')
    expect(out).toMatch(/\x1b\[31m5\x1b\[39m/)
    expect(out).toMatch(/\x1b\[31m12\x1b\[39m/)
    expect(out).not.toMatch(/\x1b\[31m0\x1b/)
  })

  it('colors "drops: N" counters only when non-zero', () => {
    const out = highlightLine('  Input queue: 0/375/0/0 (size/max/drops/flushes); Total output drops: 3', false)
    expect(out).toMatch(/Total output drops: \x1b\[1m\x1b\[31m3\x1b\[39m/)
    expect(highlightLine('Total output drops: 0', false)).toBe('Total output drops: 0')
  })

  it('prompts, device errors, comments and negations at line start', () => {
    expect(highlightLine('core-sw1#show ip int br', true)).toBe('\x1b[1mcore-sw1#\x1b[22mshow ip int br')
    expect(highlightLine('core-sw1(config-if)#', true)).toBe('\x1b[1mcore-sw1(config-if)#\x1b[22m')
    expect(highlightLine('% Invalid input detected at \'^\' marker.', true)).toMatch(/^\x1b\[31m%/)
    expect(highlightLine('!', true)).toBe('\x1b[90m!\x1b[39m')
    expect(highlightLine(' no shutdown', true)).toMatch(/^ \x1b\[31mno\x1b\[39m/)
    expect(highlightLine(' description uplink to isp-r2', true)).toBe(' description \x1b[90muplink to isp-r2\x1b[39m')
  })

  it('a prompt-like string mid-line is not a prompt', () => {
    expect(highlightLine('core-sw1#', false)).toBe('core-sw1#')
  })

  it('syslog severity', () => {
    expect(highlightLine('*Nov 24 03:02:11: %LINK-3-UPDOWN: Interface Gi1/0/2, changed state to down', true)).toMatch(/\x1b\[1m\x1b\[31m%LINK-3-UPDOWN/)
    expect(highlightLine('%SYS-5-CONFIG_I: Configured from console', true)).toMatch(/\x1b\[36m%SYS-5-CONFIG_I/)
    expect(highlightLine('%BGP-4-MSGDUMP: x', true)).toMatch(/\x1b\[33m%BGP-4-MSGDUMP/)
  })
})

describe('StreamHighlighter', () => {
  const make = (on = true) => {
    const out: string[] = []
    const h = new StreamHighlighter((s) => out.push(s), () => on)
    return { h, out, text: () => out.join('') }
  }

  it('never changes the visible text', () => {
    const { h, text } = make()
    const input = 'core-sw1#sh ip int br\r\nGigabitEthernet1/0/1   10.0.0.5   YES manual up   up\r\ncore-sw1#'
    h.push(input)
    h.flush()
    expect(plain(text())).toBe(input)
  })

  it('writes small interactive chunks immediately', () => {
    const { h, out } = make()
    h.push('s')
    h.push('h')
    expect(out).toEqual(['s', 'h'])
  })

  it('joins a token split across bulk chunks', async () => {
    vi.useFakeTimers()
    const { h, text } = make()
    h.push('x'.repeat(200) + '\r\nGigabitEther')
    h.push('net1/0/1 is up\r\n')
    expect(text()).toMatch(/\x1b\[34mGigabitEthernet1\/0\/1/)
    h.push('y'.repeat(200) + '\r\ncore-sw1#')
    vi.advanceTimersByTime(20)
    expect(plain(text())).toMatch(/core-sw1#$/)
    vi.useRealTimers()
  })

  it('passes through output that has its own colors, and full-screen apps', () => {
    const { h, out } = make()
    h.push('\x1b[01;34mdir\x1b[0m up 10.0.0.1')
    expect(out.at(-1)).toBe('\x1b[01;34mdir\x1b[0m up 10.0.0.1')
    h.push('\x1b[?1049h')
    h.push('Gi1/0/1 up')
    expect(out.at(-1)).toBe('Gi1/0/1 up')
    h.push('\x1b[?1049l')
    h.push('\r\nGi1/0/1 up')
    expect(out.at(-1)).toMatch(/\x1b\[34mGi1\/0\/1/)
  })

  it('keeps escape sequences intact and tracks line start across them', () => {
    const { h, text } = make()
    h.push('\x1b[2K\rcore-sw1#')
    expect(text()).toBe('\x1b[2K\r\x1b[1mcore-sw1#\x1b[22m')
  })

  it('does nothing when disabled', () => {
    const { h, out } = make(false)
    h.push('Gi1/0/1 up')
    expect(out).toEqual(['Gi1/0/1 up'])
  })

  it('steps aside during a flood and resumes when it calms down', () => {
    let t = 0
    const out: string[] = []
    const h = new StreamHighlighter((s) => out.push(s), () => true, () => t)
    const chunk = ('Gi1/0/1 up\r\n').repeat(10_000) // ~120 KB
    for (let i = 0; i < 20; i++) h.push(chunk) // 2.4 MB inside one window
    expect(h.flooding).toBe(true)
    expect(out.at(-1)).toBe(chunk)
    t += 1000
    h.push('Gi1/0/2 down\r\n')
    expect(out.at(-1)).toMatch(/\x1b\[34mGi1\/0\/2/)
  })
})

describe('highlighter speed', () => {
  it('keeps far ahead of real devices (> 8 MB/s of dense show output)', () => {
    const line = (i: number) => `GigabitEthernet1/0/${i % 48}   10.${(i >> 8) & 255}.${i & 255}.1   YES manual ${i % 7 ? 'up' : 'administratively down'}   up`
    const lines = Array.from({ length: 50_000 }, (_, i) => line(i))
    const mb = lines.reduce((a, l) => a + l.length, 0) / 1048576
    // Best of 5 after a JIT warm-up: a shared CI runner (notably Windows) can stall any single pass,
    // but a real regression (e.g. a backtracking regex) slows every pass, so the 8 MB/s bar stays.
    for (const l of lines.slice(0, 5_000)) highlightLine(l, false)
    let best = 0
    for (let run = 0; run < 5; run++) {
      const t = performance.now()
      for (const l of lines) highlightLine(l, false)
      best = Math.max(best, mb / ((performance.now() - t) / 1000))
    }
    expect(best).toBeGreaterThan(8)
  })
})
