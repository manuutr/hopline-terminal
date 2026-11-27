import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEosDevice, makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { detectPrompt, execute } from '../src/session-host/executor'
import { fakeTab } from './helpers'

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

describe('detectPrompt', () => {
  it.each([
    ['core-sw1#', 'exec'],
    ['core-sw1>', 'user'],
    ['core-sw1(config)#', 'config'],
    ['dist-eos1(config-if-Et1)#', 'config'],
    ['--More--', 'unknown'],
    ['Password:', 'unknown']
  ] as const)('%s → %s', (line, mode) => expect(detectPrompt(`banner\r\n${line}`, 'ios').mode).toBe(mode))
  it('junos op vs config', () => {
    expect(detectPrompt('admin@mx1>', 'junos').mode).toBe('exec')
    expect(detectPrompt('admin@mx1#', 'junos').mode).toBe('config')
  })
  it('reports a half-typed line', () => expect(detectPrompt('core-sw1#show ver', 'ios').pending).toBe('show ver'))
})

describe('execute against the simulator', () => {
  it('captures output between echo and prompt', async () => {
    const { tab, client } = await fakeTab(ios.port)
    const r = await execute(tab, 'iosxe', 'show ip bgp summary', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/10\.0\.0\.2\s+4\s+65002/)
    expect(r.output).not.toMatch(/core-sw1#/)
    expect(r.output.split('\n')[0]).not.toMatch(/show ip bgp summary/)
    client.end()
  })

  it('pages through --More-- automatically (no terminal length 0)', async () => {
    const { tab, client } = await fakeTab(ios.port, 24)
    const r = await execute(tab, 'iosxe', 'show running-config', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/hostname core-sw1/)
    expect(r.output).toMatch(/line vty 0 15/)
    expect(r.output).not.toMatch(/--More--/)
    client.end()
  })

  it('refuses when the user has a half-typed command', async () => {
    const { tab, raw, client } = await fakeTab(ios.port)
    raw.send('show ver')
    await new Promise((r) => setTimeout(r, 150))
    const r = await execute(tab, 'iosxe', 'show clock', opts)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/partially typed/)
    client.end()
  })

  it('refuses read-only commands from config mode', async () => {
    const { tab, raw, client } = await fakeTab(ios.port)
    raw.send('configure terminal\r')
    await new Promise((r) => setTimeout(r, 200))
    const r = await execute(tab, 'iosxe', 'show clock', opts)
    expect(r.error).toMatch(/configuration mode/)
    raw.send('end\r')
    client.end()
  })

  it('releases the lock and reports timeout', async () => {
    const { tab, client } = await fakeTab(ios.port)
    const r = await execute(tab, 'iosxe', 'ping 192.0.2.1', { ...opts, timeoutMs: 200 })
    expect(r.status).toBe('timeout')
    expect(tab.lock).toBeNull()
    client.end()
  })

  it('works on EOS', async () => {
    const { tab, client } = await fakeTab(eos.port)
    const r = await execute(tab, 'eos', 'show version', opts)
    expect(r.status).toBe('ok')
    expect(r.output).toMatch(/Arista/)
    client.end()
  })

  it('runs after an "@ai " line was cleared with Ctrl-U (terminal @ai capture)', async () => {
    const { tab, raw, client } = await fakeTab(ios.port)
    raw.send('@ai ')
    await new Promise((r) => setTimeout(r, 100))
    raw.send('\x15')
    await new Promise((r) => setTimeout(r, 150))
    const r = await execute(tab, 'iosxe', 'show clock', opts)
    expect(r.error).toBeUndefined()
    expect(r.status).toBe('ok')
    client.end()
  })
})
