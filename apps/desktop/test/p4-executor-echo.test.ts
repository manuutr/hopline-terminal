import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDevice, makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { detectPrompt, echoState, execute, type ExecTarget } from '../src/session-host/executor'
import { fakeTab } from './helpers'

/**
 * Phase 4 review M8 (BACKLOG P2): an Esc the user sent leaves an invisible meta prefix on the
 * line, which ate the first character of the next guarded command (`show version` ran as `how
 * version` and was reported ok). The executor now clears the line with the profile's key, types the
 * command, checks the echo, and presses Enter only when it matches.
 */

const opts = { timeoutMs: 3000, capBytes: 256 * 1024 }

describe('echoState', () => {
  it('matches the exact echo, and refuses a lost first character at once', () => {
    expect(echoState('show version', 'show version')).toBe('ok')
    expect(echoState('show version', 'show ver')).toBe('pending')
    expect(echoState('show version', 'how version')).toBe('mismatch')
    expect(echoState('show version', 'h')).toBe('mismatch')
    expect(echoState('show version', 'show version extra')).toBe('mismatch')
  })
  it('accepts Junos complete-on-space (only there) and a late clear-key redraw, ignores colour', () => {
    expect(echoState('sh int terse', 'show interfaces terse', { prompt: 'admin@r1> ', completeOnSpace: true })).toBe('ok')
    expect(echoState('sh int terse', 'show interfaces terse')).toBe('mismatch')
    expect(echoState('show version', '\rcore-sw1#\x1b[Kshow version', { prompt: 'core-sw1#' })).toBe('ok')
    // Backspaces into the prompt cannot be followed (fix-round review E1): never ok.
    expect(echoState('show version', '\b \b\x1b[Kshow version')).toBe('mismatch')
    expect(echoState('show version', '\x1b[1mshow\x1b[0m version')).toBe('ok')
  })
  it('a long line the device scrolls (`$` and backspaces) is ok only when every character was shown (fix-round E1)', () => {
    const cmd = 'show running-config | include ^interface GigabitEthernet1/0/1 description uplink-to-core'
    // A window that starts 10 characters in, after 70 were shown, covers the rest.
    expect(echoState(cmd, `${cmd.slice(0, 70)}${'\b'.repeat(70)}$${cmd.slice(11)}`)).toBe('ok')
    // The old prefix shortcut: 70 matching characters and an unchecked rest are not enough.
    expect(echoState(cmd, `${cmd.slice(0, 70)}\b\b\b\b$${cmd.slice(10)}`)).not.toBe('ok')
  })
})

/** A device whose line editor eats the first key after an Esc and has no working clear key. */
function eatsFirstKey(prompt = 'core-sw1#'): ExecTarget & { sent: string[] } {
  let tap: ((t: string) => void) | null = null
  let line = ''
  let armed = true
  const sent: string[] = []
  const t = {
    connected: true,
    tail: `\r\n${prompt}`,
    lock: null as ExecTarget['lock'],
    sent,
    addTap(fn: (t: string) => void) {
      tap = fn
      return () => (tap = null)
    },
    send(data: string) {
      sent.push(data)
      let echo = ''
      for (const ch of data) {
        if (armed) {
          armed = false
          continue
        }
        if (ch === '\r') {
          echo += `\r\n% Invalid input detected at '^' marker.\r\n${prompt}`
          line = ''
        } else if (ch === '\x7f') {
          if (line) (line = line.slice(0, -1), (echo += '\b \b'))
        } else if (ch < ' ') {
          // Other control keys (Ctrl-E, Ctrl-U) do nothing here.
        } else {
          line += ch
          echo += ch
        }
      }
      if (echo) setTimeout(() => ((t.tail += echo), tap?.(echo)), 2)
    }
  }
  return t
}

describe('the executor never presses Enter on a wrong echo', () => {
  it('a lost first character: the line is cleared, no Enter, and the result is an error', async () => {
    // FTD has no clear key in its profile: the echo check alone must catch it.
    const tab = eatsFirstKey('> ')
    const r = await execute(tab, 'ftd', 'show version', { ...opts, quietMs: 30 })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/echoed "how version"/)
    expect(tab.sent.join('')).not.toContain('\r')
    expect(tab.sent.at(-1)).toMatch(/^\x7f+$/)
  })
  it('with a clear key, the clear key absorbs the stray prefix and the command runs as typed', async () => {
    const tab = eatsFirstKey()
    const sent: string[] = []
    const send = tab.send.bind(tab)
    tab.send = (d) => {
      sent.push(d)
      // The device answers the command line once it has seen Enter.
      send(d)
    }
    const r = await execute(tab, 'iosxe', 'show version', { ...opts, quietMs: 30 })
    expect(sent[0]).toBe('\x05\x15')
    expect(sent[1]).toBe('show version')
    expect(sent[2]).toBe('\r')
    // This fake device rejects every line; what matters is that it got the whole command.
    expect(r.output).toMatch(/Invalid input/)
  })
})

describe('against the simulator: an Esc from the user, then a guarded command', { timeout: 30_000 }, () => {
  let ios: RunningSim
  let vrp: RunningSim
  beforeAll(async () => {
    ios = await startSim({ device: makeIosDevice(), port: 0 })
    vrp = await startSim({ device: makeDevice('vrp'), port: 0 })
  })
  afterAll(() => {
    ios.close()
    vrp.close()
  })

  it('IOS: Ctrl+U absorbs the Esc prefix, and "show version" runs whole', async () => {
    const { tab, raw, client } = await fakeTab(ios.port)
    try {
      raw.send('\x1b') // the user's Esc reaches the device
      await new Promise((r) => setTimeout(r, 80))
      const r = await execute(tab, 'iosxe', 'show version', opts)
      expect(r.error ?? '').toBe('')
      expect(r.status).toBe('ok')
      expect(r.output).toMatch(/Cisco IOS/)
      expect(r.output).not.toMatch(/Invalid input/)
    } finally {
      client.end()
    }
  })

  it('VRP (no clear key in the profile): the eaten character is caught, the line is cleared and nothing runs', async () => {
    const { tab, raw, client } = await fakeTab(vrp.port, 24, { platform: 'vrp' })
    for (let i = 0; i < 300 && detectPrompt(tab.tail, 'vrp').mode === 'unknown'; i++) await new Promise((r) => setTimeout(r, 10))
    const sent: string[] = []
    const orig = raw.send
    raw.send = (d: string) => (sent.push(d), orig(d))
    try {
      orig('\x1b')
      await new Promise((r) => setTimeout(r, 80))
      const r = await execute(tab, 'vrp', 'display version', opts)
      expect(r.status).toBe('error')
      expect(r.error).toMatch(/Enter was not pressed/)
      expect(sent.join('')).not.toContain('\r')
      // The line is clean again: the next command runs.
      await new Promise((r) => setTimeout(r, 80))
      const next = await execute(tab, 'vrp', 'display version', opts)
      expect(next.status).toBe('ok')
      expect(next.output).toMatch(/VRP/)
    } finally {
      client.end()
    }
  })
})
