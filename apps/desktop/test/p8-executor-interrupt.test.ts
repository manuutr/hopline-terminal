import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEosDevice, makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { execute } from '../src/session-host/executor'
import { interruptKeys } from '../src/shared/cli'
import { fakeTab } from './helpers'

/**
 * Phase 8 review H2 (interrupt): IOS ignores Ctrl-C during a ping or traceroute; its break is
 * Ctrl-Shift-6 (`\x1e`). The simulator's IOS ping prints one `!` per 60 ms, queues Ctrl-C as
 * type-ahead and stops only on `\x1e`, like the real thing.
 */

const opts = { timeoutMs: 5000, capBytes: 512 * 1024 }
let ios: RunningSim
let eos: RunningSim
beforeAll(async () => {
  ios = await startSim({ device: makeIosDevice(), port: 0 })
  eos = await startSim({ device: makeEosDevice(), port: 0 })
})
afterAll(async () => {
  await ios.close()
  await eos.close()
})

describe('a command that outlives its timeout is stopped with the platform break key', () => {
  it('IOS: a long ping is stopped at the timeout and the next command runs normally', async () => {
    const { tab, client } = await fakeTab(ios.port)
    const sent: string[] = []
    const send = tab.send.bind(tab)
    tab.send = (d: string) => (sent.push(d), send(d))
    const started = Date.now()
    const r = await execute(tab, 'iosxe', 'ping 10.0.0.2 repeat 100000', { ...opts, timeoutMs: 800 })
    expect(r.status).toBe('timeout')
    // Stopped: the device printed its summary and the prompt came back.
    expect(r.output).toMatch(/Success rate is \d+ percent/)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(tab.lock).toBeNull()
    // The next command is not refused and gets its own output.
    const next = await execute(tab, 'iosxe', 'show clock', opts)
    expect(next.error).toBeUndefined()
    expect(next.status).toBe('ok')
    expect(next.output).not.toMatch(/!!!|Success rate/)
    expect(next.output).toMatch(/\d\d:\d\d:\d\d/)
    // By Ctrl-Shift-6, the IOS break.
    expect(sent).toContain('\x1e')
    client.end()
  })

  it('EOS: Ctrl-C stops it (no break sequence is sent where the platform has none)', async () => {
    const { tab, client } = await fakeTab(eos.port)
    const sent: string[] = []
    const send = tab.send.bind(tab)
    tab.send = (d: string) => (sent.push(d), send(d))
    const r = await execute(tab, 'eos', 'ping 10.0.0.1 repeat 100000', { ...opts, timeoutMs: 800 })
    expect(r.status).toBe('timeout')
    expect(sent).toContain('\x03')
    expect(sent).not.toContain('\x1e')
    const next = await execute(tab, 'eos', 'show version', opts)
    expect(next.status).toBe('ok')
    expect(next.output).toMatch(/Arista/)
    client.end()
  })
})

describe('interruptKeys', () => {
  it('IOS family: Ctrl-Shift-6 first, then Ctrl-C (not in configuration mode, where Ctrl-C ends the mode)', () => {
    for (const p of ['ios', 'iosxe', 'c9800', 'iosxr', 'asa'] as const) {
      expect(interruptKeys(p, 'exec')).toEqual(['\x1e', '\x03'])
      expect(interruptKeys(p, 'config')).toEqual(['\x1e'])
    }
  })
  it('elsewhere Ctrl-C only', () => {
    for (const p of ['nxos', 'eos', 'junos', 'panos', 'fortios', 'aoscx', 'vrp', 'auto'] as const) expect(interruptKeys(p, 'exec')).toEqual(['\x03'])
  })
})
