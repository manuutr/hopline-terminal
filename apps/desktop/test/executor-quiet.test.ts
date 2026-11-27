import { describe, expect, it } from 'vitest'
import { execute, type ExecTarget } from '../src/session-host/executor'
import { typingAdapter, withoutEcho } from './typing'

/**
 * Review R2-H1 / R2-Low 6: prompt-shaped text inside output (a fake prompt, a fake `--More--`)
 * must not end the capture or make the executor send keys. A prompt counts only when it is still
 * the tail after the quiet period.
 */

type Chunk = [delayMs: number, text: string]

/** A scripted device: each write is answered by a timed sequence of chunks. */
function device(prompt: string, reply: (data: string) => Chunk[] | undefined) {
  const taps = new Set<(t: string) => void>()
  const sent: string[] = []
  const typed = typingAdapter()
  let last = Date.now() - 10_000
  const t = {
    connected: true,
    tail: `banner\r\n${prompt}`,
    lock: null as ExecTarget['lock'],
    sent,
    addTap(fn: (t: string) => void) {
      taps.add(fn)
      return () => taps.delete(fn)
    },
    observed: () => ({ quietMs: Date.now() - last }),
    emit(text: string) {
      last = Date.now()
      t.tail = (t.tail + text).slice(-16384)
      for (const f of [...taps]) f(text)
    },
    send(data: string) {
      const k = typed(data)
      if (!k) return
      if ('echo' in k) return void setTimeout(() => t.emit(k.echo), 1)
      sent.push(k.send)
      let at = 0
      for (const [i, [d, text]] of (reply(k.send) ?? []).entries()) {
        at += d
        const out = i === 0 ? withoutEcho(text, k.echoed) : text
        setTimeout(() => t.emit(out), at)
      }
    }
  }
  return t
}

const opts = { timeoutMs: 3000, capBytes: 64 * 1024, quietMs: 120 }

/** The reviewer's traceroute: a fake prompt, a 300 ms pause, then the rest. */
const traceroute = (fake: string): Chunk[] => [
  [3, 'traceroute 192.0.2.9\r\nType escape sequence to abort.\r\n  1 '],
  [5, fake],
  [300, ' 10.0.0.1 1 msec\r\n  2 192.0.2.9 2 msec\r\ncore-sw1#']
]

describe('executor waits for a quiet prompt (R2-H1)', () => {
  it.each([
    ['carriage return', 'x\rcore-sw1#'],
    ['backspaces', 'xyz\b\b\b\b\b\bcore-sw1#'],
    ['erase line', 'x\x1b[2K\x1b[1Gcore-sw1#']
  ])('a fake prompt after %s does not end the capture; the next command gets only its own output', async (_name, fake) => {
    const tab = device('core-sw1#', (d) =>
      d === 'traceroute 192.0.2.9\r' ? traceroute(fake) : d === 'show clock\r' ? [[3, 'show clock\r\n*10:00:00.000 UTC Mon Nov 24 2026\r\ncore-sw1#']] : undefined
    )
    const r = await execute(tab, 'iosxe', 'traceroute 192.0.2.9', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/2 192\.0\.2\.9 2 msec/)
    const next = await execute(tab, 'iosxe', 'show clock', opts)
    expect(next.status).toBe('ok')
    expect(next.output).toMatch(/10:00:00/)
    expect(next.output).not.toMatch(/msec/)
  })

  it('a prompt on its own line followed by more output within the quiet period is not the end', async () => {
    const tab = device('core-sw1#', (d) =>
      d === 'show logging\r'
        ? [
            [3, 'show logging\r\nfirst\r\ncore-sw1#'],
            [60, '\r\nsecond\r\ncore-sw1#']
          ]
        : undefined
    )
    const r = await execute(tab, 'iosxe', 'show logging', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/second/)
  })

  it('does not start while the device is still sending, and starts once it is quiet', async () => {
    const tab = device('core-sw1#', (d) => (d === 'show clock\r' ? [[3, 'show clock\r\n*10:00:00.000 UTC\r\ncore-sw1#']] : undefined))
    // Log lines still arriving every 40 ms for ~200 ms (ending at the prompt), with the prompt as tail in between.
    for (let i = 0; i < 5; i++) setTimeout(() => tab.emit(`\r\n%LINK-3-UPDOWN: x${i}\r\ncore-sw1#`), i * 40)
    const t0 = Date.now()
    const r = await execute(tab, 'iosxe', 'show clock', opts)
    expect(r.status).toBe('ok')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(160 + opts.quietMs - 20)
    expect(tab.sent[0]).toBe('show clock\r')
  })

  it('refuses when the line never goes quiet', async () => {
    const tab = device('core-sw1#', () => undefined)
    const iv = setInterval(() => tab.emit('\r\n%SYS-5: tick\r\ncore-sw1#'), 20)
    await new Promise((res) => setTimeout(res, 50))
    const r = await execute(tab, 'iosxe', 'show clock', { ...opts, timeoutMs: 400 })
    clearInterval(iv)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/still sending/)
    expect(tab.sent).toEqual([])
  })
})

describe('executor pages only at a quiet pager prompt (R2-Low 6)', () => {
  it('a --More-- inside the output sends no key', async () => {
    const tab = device('core-sw1#', (d) =>
      d === 'show logging\r'
        ? [
            [3, 'show logging\r\nline one --More--'],
            [20, '\r\nline two\r\ncore-sw1#']
          ]
        : undefined
    )
    const r = await execute(tab, 'iosxe', 'show logging', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/line two/)
    expect(tab.sent).toEqual(['show logging\r'])
  })

  it('a real pager prompt still gets the page key', async () => {
    const tab = device('core-sw1#', (d) =>
      d === 'show run\r' ? [[3, 'show run\r\nhostname core-sw1\r\n --More-- ']] : d === ' ' ? [[3, '\r          \rend\r\ncore-sw1#']] : undefined
    )
    const r = await execute(tab, 'iosxe', 'show run', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/end/)
    expect(tab.sent).toEqual(['show run\r', ' '])
  })

  it('after an interrupt that lands at the prompt, no quit key is left behind', async () => {
    const tab = device('core-sw1#', (d) =>
      d === 'show logging\r'
        ? [
            [3, 'show logging\r\n'],
            [3, 'x'.repeat(2000) + ' --More-- ']
          ]
        : d === '\x1e'
          ? [[3, '\r\ncore-sw1#']]
          : undefined
    )
    const r = await execute(tab, 'iosxe', 'show logging', { ...opts, capBytes: 1024 })
    expect(r.status).toBe('capped')
    await new Promise((res) => setTimeout(res, opts.quietMs * 3))
    // The IOS break only: the pager prompt was never the quiet tail after it, so no `q` (or Ctrl-C) reached the user's prompt.
    expect(tab.sent).toEqual(['show logging\r', '\x1e'])
    expect(tab.lock).toBeNull()
  })

  it('a pager prompt that is still the quiet tail after an interrupt gets the quit key', async () => {
    const tab = device('core-sw1#', (d) =>
      d === 'show logging\r'
        ? [[3, 'show logging\r\n' + 'x'.repeat(2000) + '\r\n --More-- ']]
        : d === 'q'
          ? [[3, '\r          \r\ncore-sw1#']]
          : undefined
    )
    const r = await execute(tab, 'iosxe', 'show logging', { ...opts, capBytes: 1024 })
    expect(r.status).toBe('capped')
    expect(tab.sent).toEqual(['show logging\r', '\x1e', 'q'])
  })

  it('H2: a command no break key stops leaves the session marked "still running" until a prompt is back', async () => {
    const tab = device('core-sw1#', (d) =>
      d === 'ping 10.0.0.2 repeat 100000\r' ? [[3, 'ping 10.0.0.2 repeat 100000\r\nType escape sequence to abort.\r\n!!!!!']] : d === 'show clock\r' ? [[3, 'show clock\r\n*10:00:00.000 UTC Wed Nov 25 2026\r\ncore-sw1#']] : undefined
    )
    const r = await execute(tab, 'iosxe', 'ping 10.0.0.2 repeat 100000', { ...opts, timeoutMs: 200 })
    expect(r.status).toBe('timeout')
    // Ctrl-Shift-6, then Ctrl-C (exec mode), each given time to bring the prompt back.
    expect(tab.sent).toEqual(['ping 10.0.0.2 repeat 100000\r', '\x1e', '\x03'])
    expect(r.error).toMatch(/Ctrl-Shift-6, then Ctrl-C and no prompt came back/)
    // The user gets the input back; Hopline types nothing until the prompt is back.
    expect(tab.lock).toBeNull()
    const refused = await execute(tab, 'iosxe', 'show clock', opts)
    expect(refused.error).toMatch(/previous command \("ping 10\.0\.0\.2 repeat 100000"\) may still be running/)
    expect(tab.sent).toHaveLength(3)
    // The user stops it; the prompt is back, and the next command runs.
    tab.emit('\r\nSuccess rate is 100 percent (5/5)\r\ncore-sw1#')
    await new Promise((res) => setTimeout(res, opts.quietMs * 2))
    const ok = await execute(tab, 'iosxe', 'show clock', opts)
    expect(ok.status).toBe('ok')
    expect(ok.output).toMatch(/10:00:00/)
  }, 10_000)

  it('H2: in configuration mode IOS gets only the break key (a queued Ctrl-C would end the mode)', async () => {
    const tab = device('core-sw1(config)#', (d) => (d === 'do ping 10.0.0.2 repeat 100000\r' ? [[3, 'do ping 10.0.0.2 repeat 100000\r\nType escape sequence to abort.\r\n!!!!!']] : d === '\x1e' ? [[3, '\r\nSuccess rate is 100 percent (5/5)\r\ncore-sw1(config)#']] : undefined))
    const r = await execute(tab, 'iosxe', 'do ping 10.0.0.2 repeat 100000', { ...opts, timeoutMs: 200, allowConfig: true })
    expect(r.status).toBe('timeout')
    expect(tab.sent).toEqual(['do ping 10.0.0.2 repeat 100000\r', '\x1e'])
    expect(r.output).toMatch(/Success rate/)
  })
})
