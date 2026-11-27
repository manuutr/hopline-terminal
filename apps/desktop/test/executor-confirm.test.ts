import { describe, expect, it } from 'vitest'
import { execute, type ExecTarget } from '../src/session-host/executor'
import { typingAdapter, withoutEcho } from './typing'

/** A scripted device: each write is answered by `reply(data)` on the next tick. */
function scripted(reply: (data: string) => string | undefined): ExecTarget & { sent: string[] } {
  let tap: ((t: string) => void) | null = null
  const sent: string[] = []
  const typed = typingAdapter()
  return {
    connected: true,
    tail: 'core-sw1#',
    lock: null,
    sent,
    addTap(fn) {
      tap = fn
      return () => (tap = null)
    },
    send(data) {
      const k = typed(data)
      if (!k) return
      if ('echo' in k) return void setTimeout(() => tap?.(k.echo), 1)
      sent.push(k.send)
      const out = reply(k.send)
      if (out !== undefined) setTimeout(() => tap?.(withoutEcho(out, k.echoed)), 5)
    }
  }
}

const opts = { timeoutMs: 2000, capBytes: 64 * 1024 }

describe('bound confirmation answers', () => {
  it('answers the default-destination question for copy run start with Enter', async () => {
    const tab = scripted((d) =>
      d === 'copy running-config startup-config\r'
        ? 'copy running-config startup-config\r\nDestination filename [startup-config]? '
        : d === '\r'
          ? '\r\nBuilding configuration...\r\n[OK]\r\ncore-sw1#'
          : undefined
    )
    const r = await execute(tab, 'iosxe', 'copy running-config startup-config', opts)
    expect(r.status).toBe('ok')
    expect(tab.sent).toEqual(['copy running-config startup-config\r', '\r'])
  })

  it('cancels an unexpected question instead of answering it', async () => {
    const tab = scripted((d) =>
      d === 'clear ip bgp * soft\r' ? 'clear ip bgp * soft\r\nProceed with reload? [confirm]' : d === '\x03' ? '\r\ncore-sw1#' : undefined
    )
    const r = await execute(tab, 'iosxe', 'clear ip bgp * soft', opts)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/confirmation refused/)
    expect(tab.sent).toEqual(['clear ip bgp * soft\r', '\x03'])
  })

  it('clear counters gets its [confirm] answered once', async () => {
    const tab = scripted((d) =>
      d === 'clear counters\r'
        ? 'clear counters\r\nClear "show interface" counters on all interfaces [confirm]'
        : d === '\r'
          ? '\r\ncore-sw1#'
          : undefined
    )
    const r = await execute(tab, 'iosxe', 'clear counters', opts)
    expect(r.status).toBe('ok')
    expect(tab.sent).toEqual(['clear counters\r', '\r'])
  })
})
