import { describe, expect, it } from 'vitest'
import { execute } from '../src/session-host/executor'
import { lineTab } from './line-editors'

/**
 * Phase 4 fix-round review E1–E6 against fake line-editor devices: the executor presses Enter only
 * on a fully verified echo, verifies the clear phase and the abandon, and flags a line that may
 * still hold unsent text.
 */
const opts = { timeoutMs: 3000, capBytes: 256 * 1024, quietMs: 30 }
const ACL = 'ip route 10.20.30.0 255.255.255.0 192.168.100.1 name to-branch-office-17 track 100'
const LONG = 'show interfaces | include line protocol|Last input|CRC|input errors|output errors'
const enterPressed = (sent: string[]) => sent.some((s) => s.includes('\r'))

describe('E1: a dropped character on a scrolled line never runs', () => {
  for (const form of ['bs', 'cr'] as const)
    for (const chunk of [1, 1000])
      it(`IOS $ scrolling (${form}, ${chunk === 1 ? '1-byte chunks' : 'whole'}): a full echo runs, one dropped character does not`, async () => {
        const good = lineTab({ width: 70, form, chunk })
        const r = await execute(good, 'iosxe', ACL, { ...opts, allowConfig: true })
        expect(r.error ?? '').toBe('')
        expect(r.status).toBe('ok')
        expect(good.dev.ran).toEqual([ACL])
        // E5: the output starts after the echoed line, even though the echo scrolled.
        expect(r.output).toBe(`output of ${ACL}`)
        // B7: the result names the prompt hostname it was typed at.
        expect(r.hostname).toBe('core-sw1')

        const bad = lineTab({ width: 70, form, chunk, drop: 72 })
        const b = await execute(bad, 'iosxe', ACL, { ...opts, allowConfig: true })
        expect(b.status).toBe('error')
        expect(b.error).toMatch(/Enter was not pressed/)
        expect(enterPressed(bad.sent)).toBe(false)
        expect(bad.dev.ran).toEqual([])
        // Ctrl-U erased the line and the emulator saw it empty again: no "typed, not sent".
        expect(b.typedNotSent).toBeUndefined()
        expect(bad.dev.line).toBe('')
        expect(bad.unsent()).toBeNull()
      })
})

describe('E2: legitimate redraws run', () => {
  it('readline wrap at the terminal width', async () => {
    const tab = lineTab({ prompt: 'core-sw1# ', wrapCols: 80, cols: 80 })
    const r = await execute(tab, 'iosxe', LONG, opts)
    expect(r.error ?? '').toBe('')
    expect(tab.dev.ran).toEqual([LONG])
    expect(r.output).toBe(`output of ${LONG}`)
  })
  it('logging synchronous: a log line mid-echo and the line redrawn', async () => {
    const tab = lineTab({ logAfter: 5, logSync: true })
    const r = await execute(tab, 'iosxe', 'show version', opts)
    expect(r.error ?? '').toBe('')
    expect(tab.dev.ran).toEqual(['show version'])
  })
  it('a log line mid-echo without a redraw: not sent, with a reason about the interruption, not a timeout', async () => {
    const tab = lineTab({ logAfter: 5 })
    const r = await execute(tab, 'iosxe', 'show version', { ...opts, timeoutMs: 1200 })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/interrupted the echo/)
    expect(r.error).not.toMatch(/no prompt/)
    expect(enterPressed(tab.sent)).toBe(false)
  })
  it('a narrow pane (12 input columns, CR form) and 1-byte chunks', async () => {
    const tab = lineTab({ width: 12, form: 'cr', chunk: 1 })
    const r = await execute(tab, 'iosxe', LONG, opts)
    expect(r.error ?? '').toBe('')
    expect(tab.dev.ran).toEqual([LONG])
  })
})

describe('E2: the echo deadline has its own error', () => {
  it('no echo within the deadline says so (not "no prompt after 3s")', async () => {
    const tab = lineTab({ echo: false })
    const r = await execute(tab, 'iosxe', 'show version', { ...opts, timeoutMs: 1000 })
    expect(r.error).toMatch(/did not echo the command within/)
    expect(r.error).not.toMatch(/no prompt/)
  })
})

describe('E2: the echo deadline counts from typing, not from the clear key', () => {
  it('a long clear phase (log lines, then the prompt) and a slow echo still run', async () => {
    const tab = lineTab()
    const send = tab.send.bind(tab)
    let first = true
    const t0 = Date.now()
    let typedAt = 0
    tab.send = (d: string) => {
      if (first && d.endsWith('\x15')) {
        first = false
        tab.sent.push(d)
        // Log lines every 15 ms for ~500 ms after the clear key (never quiet long enough to end the
        // clear phase), each followed by the prompt again.
        for (let i = 0; i < 34; i++) setTimeout(() => out(`\r\n%SYS-5-LOG: tick ${i}\r\ncore-sw1#`), i * 15)
        return
      }
      if (d === 'show version') {
        typedAt = Date.now() - t0
        tab.sent.push(d)
        tab.dev.line = d
        setTimeout(() => out(d), 700)
        return
      }
      send(d)
    }
    const taps = new Set<(t: string) => void>()
    const add = tab.addTap
    tab.addTap = (fn) => (taps.add(fn), add(fn))
    const out = (t: string) => {
      tab.tail += t
      for (const f of taps) f(t)
    }
    const r = await execute(tab, 'iosxe', 'show version', { ...opts, timeoutMs: 1000 })
    expect(r.error ?? '').toBe('')
    expect(tab.dev.ran).toEqual(['show version'])
    // The clear phase really was long: a deadline from the clear key (1000 ms) would have expired.
    expect(typedAt + 700).toBeGreaterThan(1100)
  })
})

describe('E3: abandon is verified; a line that may hold text is flagged and blocks the next command', () => {
  it('a device that never echoes and erases only with \\b: "typed, not sent", flagged, next command refused', async () => {
    const tab = lineTab({ prompt: '<HUAWEI>', echo: false, eraseKeys: ['\b'] })
    const r = await execute(tab, 'vrp', 'display version', { ...opts, timeoutMs: 1000 })
    expect(r.status).toBe('error')
    expect(r.typedNotSent).toBe(true)
    expect(r.error).toMatch(/typed, not sent/)
    expect(enterPressed(tab.sent)).toBe(false)
    // The device still holds it: exactly what the flag warns about.
    expect(tab.dev.line).toBe('display version')
    expect(tab.unsent()).toBe('display version')
    const sentBefore = tab.sent.length
    const next = await execute(tab, 'vrp', 'display clock', opts)
    expect(next.status).toBe('error')
    expect(next.error).toMatch(/may still hold "display version"/)
    expect(tab.sent.length).toBe(sentBefore)
  })
  it('a session known not to echo is refused before anything is typed', async () => {
    const tab = lineTab({ echoes: false })
    const r = await execute(tab, 'iosxe', 'show version', opts)
    expect(r.error).toMatch(/does not echo/)
    expect(tab.sent).toEqual([])
  })
})

describe('E4: the clear phase may only erase', () => {
  it('a device that shows Ctrl-U as ^U: nothing is typed, the run stops', async () => {
    const tab = lineTab({ ctrlU: 'literal' })
    const r = await execute(tab, 'iosxe', 'show version', opts)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/line-clear key reached the device's line as text \("\^U"\)/)
    expect(tab.sent.join('')).not.toContain('show version')
    expect(tab.dev.ran).toEqual([])
  })
  it('a clear key that does nothing visible on an empty line is fine', async () => {
    const tab = lineTab({ ctrlU: 'ignore' })
    const r = await execute(tab, 'iosxe', 'show version', opts)
    expect(r.error ?? '').toBe('')
    expect(tab.dev.ran).toEqual(['show version'])
  })
})
