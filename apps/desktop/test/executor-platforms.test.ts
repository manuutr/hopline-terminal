import { describe, expect, it } from 'vitest'
import { execute, type ExecTarget } from '../src/session-host/executor'
import { typingAdapter, withoutEcho } from './typing'

/** A scripted device: each write is answered by `reply(data)` shortly after. */
function scripted(prompt: string, reply: (data: string) => string | undefined): ExecTarget & { sent: string[] } {
  let tap: ((t: string) => void) | null = null
  const sent: string[] = []
  const typed = typingAdapter()
  const t = {
    connected: true,
    tail: `banner\r\n${prompt}`,
    lock: null,
    sent,
    addTap(fn: (t: string) => void) {
      tap = fn
      return () => (tap = null)
    },
    send(data: string) {
      const k = typed(data)
      if (!k) return
      const emit = (out: string, ms: number) =>
        setTimeout(() => {
          t.tail += out
          tap?.(out)
        }, ms)
      if ('echo' in k) return void emit(k.echo, 1)
      sent.push(k.send)
      const out = reply(k.send)
      if (out !== undefined) emit(withoutEcho(out, k.echoed), 3)
    }
  }
  return t as ExecTarget & { sent: string[] }
}

const opts = { timeoutMs: 2000, capBytes: 64 * 1024 }

describe('executor on non-Cisco prompts', () => {
  it('Junos: pages through ---(more)--- with space and stops at user@host>', async () => {
    const tab = scripted('admin@mx1> ', (d) =>
      d === 'show interfaces terse\r'
        ? 'show interfaces terse\r\nge-0/0/0 up up\r\n---(more 50%)---'
        : d === ' '
          ? '\r                         \rge-0/0/1 up down\r\n\r\nadmin@mx1> '
          : undefined
    )
    const r = await execute(tab, 'junos', 'show interfaces terse', opts)
    expect(r.status).toBe('ok')
    expect(tab.sent).toEqual(['show interfaces terse\r', ' '])
    expect(r.output).toMatch(/ge-0\/0\/0 up up[\s\S]*ge-0\/0\/1 up down/)
    expect(r.output).not.toMatch(/more|admin@mx1/)
  })

  it('Junos: configure enters [edit] and the edit line is not part of the output', async () => {
    const tab = scripted('admin@mx1> ', (d) => (d === 'configure\r' ? 'configure\r\nEntering configuration mode\r\n\r\n[edit]\r\nadmin@mx1# ' : undefined))
    const r = await execute(tab, 'junos', 'configure', { ...opts, allowConfig: true })
    expect(r.status).toBe('ok')
    expect(r.output.trim()).toBe('Entering configuration mode')
  })

  it('FortiOS: "host # " prompts, including a config context', async () => {
    const tab = scripted('FGT # ', (d) => (d === 'config system interface\r' ? 'config system interface\r\n\r\nFGT (interface) # ' : undefined))
    const r = await execute(tab, 'fortios', 'config system interface', { ...opts, allowConfig: true })
    expect(r.status).toBe('ok')
  })

  it('VRP: <host> to [~host]', async () => {
    const tab = scripted('<HUAWEI>', (d) => (d === 'system-view\r' ? 'system-view\r\nEnter system view, return user view with return command.\r\n[~HUAWEI]' : undefined))
    const r = await execute(tab, 'vrp', 'system-view', { ...opts, allowConfig: true })
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/Enter system view/)
  })

  it('IOS-XR: the node prefix is part of the prompt', async () => {
    const tab = scripted('RP/0/RP0/CPU0:xr1#', (d) => (d === 'show clock\r' ? 'show clock\r\n12:00:00.000 UTC Mon Nov 25 2026\r\nRP/0/RP0/CPU0:xr1#' : undefined))
    const r = await execute(tab, 'iosxr', 'show clock', opts)
    expect(r).toMatchObject({ status: 'ok', output: '12:00:00.000 UTC Mon Nov 25 2026' })
  })

  it('an output line that looks like another host prompt does not end the command', async () => {
    const tab = scripted('core-sw1#', (d) =>
      d === 'show run | include banner\r' ? 'show run | include banner\r\nedge-r1#\r\n' : undefined
    )
    const p = execute(tab, 'iosxe', 'show run | include banner', { ...opts, timeoutMs: 300 })
    const r = await p
    expect(r.status).toBe('timeout')
  })

  it('auto: runs at any idle prompt but answers no device question', async () => {
    const tab = scripted('core-sw1#', (d) => (d === 'show version\r' ? 'show version\r\nReally? [confirm]' : d === '\x03' ? '\r\ncore-sw1#' : undefined))
    const r = await execute(tab, 'auto', 'show version', opts)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/nothing is answered on an unidentified device/)
    expect(tab.sent).toEqual(['show version\r', '\x03'])
  })

  it('refuses at a login or password prompt', async () => {
    for (const p of ['Username: ', 'Password: ']) {
      const tab = scripted(p, () => undefined)
      const r = await execute(tab, 'auto', 'show version', opts)
      expect(r.status).toBe('error')
      expect(tab.sent).toEqual([])
    }
  })
})

describe('leave questions after a change (review M3, H2)', () => {
  it('VRP: "return" with uncommitted changes is answered N (discard) and ends at the user view', async () => {
    const tab = scripted('[~HUAWEI-interface]', (d) =>
      d === 'return\r'
        ? 'return\r\nWarning: Uncommitted configurations found. Are you sure to commit them before exiting? [Y(yes)/N(no)/C(cancel)]:'
        : d === 'N\r'
          ? 'N\r\n<HUAWEI>'
          : undefined
    )
    const r = await execute(tab, 'vrp', 'return', { ...opts, allowConfig: true })
    expect(tab.sent).toEqual(['return\r', 'N\r'])
    expect(r.status).toBe('ok')
    expect(tab.tail.endsWith('<HUAWEI>')).toBe(true)
  })

  it('IOS-XR: "end" asking about uncommitted changes is never answered: it is cancelled with Ctrl+C and the line fails', async () => {
    const tab = scripted('RP/0/RP0/CPU0:xr1(config)#', (d) => (d === 'end\r' ? 'end\r\nUncommitted changes found, commit them before exiting(yes/no/cancel)? [cancel]:' : undefined))
    const r = await execute(tab, 'iosxr', 'end', { ...opts, timeoutMs: 800, allowConfig: true })
    expect(tab.sent.some((x) => /^y/i.test(x))).toBe(false)
    // The question is cancelled with Ctrl+C (XR stays in config mode), and the line is an error, so
    // runConfig treats the leave as failed and discards with "abort".
    expect(tab.sent).toEqual(['end\r', '\x03'])
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/not an approved answer for "end"/)
  })
})
