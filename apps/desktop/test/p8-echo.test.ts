import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDevice, makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { echoVerdict, LineEditor, type EchoOptions } from '../src/session-host/line-editor'
import { execute } from '../src/session-host/executor'
import { hostExpanded } from '../src/session-host/guard-check'
import { lineClearKey } from '../src/shared/cli'
import { fakeTab } from './helpers'

/** Phase 8 review A-L2 (completed words must be the guard's expansion) and A-L3 (hidden text right of the cursor). */

const J: EchoOptions = { prompt: 'admin@r1> ', completeOnSpace: true }

describe('A-L2: on Junos and PAN-OS a completed word must be the guard\'s word', () => {
  it('the review repro: a completion to a different word is a mismatch once the expansion is known', () => {
    expect(echoVerdict('show sys sto', 'show system-x storage', { ...J, expanded: 'show system storage' })).toMatchObject({ state: 'mismatch', why: 'wrong' })
    expect(echoVerdict('show route', 'show route-x', { ...J, expanded: 'show route' })).toMatchObject({ state: 'mismatch' })
    // Without the expansion only the prefix rule applies (what the review found).
    expect(echoVerdict('show sys sto', 'show system-x storage', J).state).toBe('ok')
  })

  it('the right completion, typed-out words and a partial echo still pass', () => {
    const o = { ...J, expanded: 'show system storage' }
    expect(echoVerdict('show sys sto', 'show system storage', o).state).toBe('ok')
    expect(echoVerdict('show system storage', 'show system storage', o).state).toBe('ok')
    expect(echoVerdict('show sys sto', 'show system st', o).state).toBe('pending')
    expect(echoVerdict('show sys sto', 'show sys', o).state).toBe('pending')
    expect(echoVerdict('sh sys info', 'show system info', { prompt: 'admin@fw1> ', completeOnSpace: true, expanded: 'show system info' }).state).toBe('ok')
  })

  it('an expansion with a different number of words falls back to the prefix rule', () => {
    expect(echoVerdict('set interfaces ge-0/0/1 description x', 'set interfaces ge-0/0/1 description x', { ...J, expanded: 'set interfaces ge-0/0/1' }).state).toBe('ok')
  })

  it('the host computes the expansion it checks against', () => {
    expect(hostExpanded('show sys sto', 'junos', 'read', 'admin@r1> ')).toBe('show system storage')
    expect(hostExpanded('sh sys info', 'panos', 'read', 'admin@fw1> ')).toBe('show system info')
    expect(hostExpanded('show x', 'auto', 'read', '')).toBe('')
  })
})

describe('A-L3: IOS-family line clear goes to the end of the line first', () => {
  it('the echo alone cannot see text right of the cursor (the review case), so the clear key must', () => {
    // The device line is `show run | redirect flash:x` with the cursor after `show run`: an
    // echo of exactly the command still reads as ok.
    expect(echoVerdict('show run', 'show run', { prompt: 'core-sw1#' }).state).toBe('ok')
    for (const p of ['ios', 'iosxe', 'iosxr', 'asa', 'nxos', 'eos'] as const) expect(lineClearKey(p)).toBe('\x05\x15')
    // Junos and PAN-OS erase the whole line with Ctrl-U.
    for (const p of ['junos', 'panos'] as const) expect(lineClearKey(p)).toBe('\x15')
  })

  it('after Ctrl-E draws the hidden tail and Ctrl-U erases it, the editor sees a blank line', () => {
    const tail = ' | redirect flash:x'
    const ed = new LineEditor({ prompt: 'core-sw1#' }).feed(tail + '\b'.repeat(tail.length) + ' '.repeat(tail.length) + '\b'.repeat(tail.length))
    expect(ed.blank()).toBe(true)
  })
})

describe('against the simulator', { timeout: 30_000 }, () => {
  let ios: RunningSim
  let junos: RunningSim
  beforeAll(async () => {
    ios = await startSim({ device: makeIosDevice(), port: 0 })
    junos = await startSim({ device: makeDevice('junos'), port: 0 })
  })
  afterAll(async () => {
    await ios.close()
    await junos.close()
  })

  it('IOS: text right of the cursor behind a bare prompt is found and erased; nothing is typed, the next command runs', async () => {
    const { tab, raw, client } = await fakeTab(ios.port)
    // Text on the device line with the cursor moved left over its tail (Ctrl-B), the left part erased...
    const hidden = ' | redirect flash:x'
    raw.send('show run' + hidden + '\x02'.repeat(hidden.length) + '\x15')
    await new Promise((r) => setTimeout(r, 200))
    const sent: string[] = []
    const send = tab.send.bind(tab)
    tab.send = (d: string) => (sent.push(d), send(d))
    // ...and a screen that shows a bare prompt (a forged prompt line in a log message).
    raw.tail += '\r\ncore-sw1#'
    // Use the production quiet period here. SSH can coalesce the cursor movement
    // and erase replies for longer than the 40 ms fast path used by fakeTab.
    const options = { timeoutMs: 5000, capBytes: 512 * 1024, quietMs: 250 }
    const r = await execute(tab, 'iosxe', 'show clock', options)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/held text the screen did not show \("\|redirectflash:x"\)/)
    expect(sent).toEqual(['\x05\x15'])
    const next = await execute(tab, 'iosxe', 'show clock', options)
    expect(next.status).toBe('ok')
    expect(next.output).toMatch(/\d\d:\d\d:\d\d/)
    client.end()
  })

  it('Junos: an abbreviated command runs with the host\'s expansion', async () => {
    const { tab, client } = await fakeTab(junos.port, 24, { platform: 'junos' })
    const r = await execute(tab, 'junos', 'show sys sto', { timeoutMs: 5000, capBytes: 512 * 1024, expanded: hostExpanded('show sys sto', 'junos', 'read', tab.tail) })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe('ok')
    client.end()
  })
})
