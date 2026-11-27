import { PLATFORM_IDS, type PlatformId } from '@hopline/cli-model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { liveValues, makeDevice, startSim, type RunningSim, type SimPlatform } from '../../../packages/simulator/src/index.ts'
import { HARVESTED, LiveHarvest, liveSourcesFor, parseLive, safeValue, screenMode, suggest } from '../src/renderer/src/lib/autocomplete'
import { execute } from '../src/session-host/executor'
import { fakeTab } from './helpers'

describe('suggest', () => {
  it('ghosts the unique completion of the word being typed, by platform and mode', () => {
    expect(suggest('iosxe', 'exec', 'sh').ghost).toBe('ow')
    expect(suggest('iosxe', 'exec', 'show ip int').ghost).toBe('erface')
    expect(suggest('junos', 'exec', 'show inter').ghost).toBe('faces')
    expect(suggest('iosxe', 'config', 'interf').ghost).toBe('ace')
    // Ambiguous: no ghost, but the candidates with their help.
    const s = suggest('iosxe', 'exec', 'show i')
    expect(s.ghost).toBe('')
    expect(s.candidates.length).toBeGreaterThan(1)
    expect(s.candidates.every((c) => typeof c.help === 'string')).toBe(true)
    // After a space: what comes next (arguments, keywords), no ghost.
    expect(suggest('iosxe', 'config', 'vlan ').candidates.some((c) => c.kind === 'param')).toBe(true)
    expect(suggest('iosxe', 'exec', '').candidates).toEqual([])
  })

  it('completes learned values (interfaces) with the platform abbreviations', () => {
    const live = { interfaces: ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2', 'Vlan10'] }
    expect(suggest('iosxe', 'exec', 'show interfaces Vl', live).ghost).toBe('an10')
    expect(suggest('iosxe', 'exec', 'show interfaces Gi', live).candidates.filter((c) => c.kind === 'value').map((c) => c.text)).toEqual(['GigabitEthernet1/0/1', 'GigabitEthernet1/0/2'])
  })

  it('is fast enough to run on every keystroke, on every platform (budget: 16 ms per key, end to end)', () => {
    const lines = ['s', 'sh', 'show ', 'show ip ', 'show ip int', 'show interfaces ', 'conf', 'show running-config | i', 'display ver', 'get sys']
    for (const p of PLATFORM_IDS) suggest(p, 'exec', 'show') // warm the compiled trees
    const times: number[] = []
    for (const p of PLATFORM_IDS)
      for (const l of lines) {
        const t = performance.now()
        suggest(p, 'exec', l)
        times.push(performance.now() - t)
      }
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95)]!
    expect(p95, `p95 ${p95.toFixed(2)} ms`).toBeLessThan(4)
  })
})

describe('live values: passive harvest', () => {
  it('only the platform listing commands are harvested, in any abbreviation, never piped', () => {
    expect(liveSourcesFor('iosxe', 'exec', 'sh ip int br')).toEqual(['interfaces'])
    expect(liveSourcesFor('iosxe', 'exec', 'show vlan brief')).toEqual(['vlans'])
    expect(liveSourcesFor('iosxe', 'exec', 'show ip interface brief | i up')).toEqual([])
    expect(liveSourcesFor('iosxe', 'exec', 'show version')).toEqual([])
    expect(liveSourcesFor('eos', 'exec', 'show interfaces status')).toEqual(['interfaces'])
  })

  it('hostile device output never yields a value that would type anything but a name', () => {
    const evil = [
      'Gi1/0/1;reload           unassigned      YES unset  up                    up',
      'Gi1/0/2 \x1b]0;pwn\x07       unassigned      YES unset  up                    up',
      'Gi1/0/3\rreload',
      'Gi1/0/4|include x',
      'Gi1/0/5‮reload',
      'GigabitEthernet1/0/6     10.0.0.1        YES manual up                    up',
      'reload',
      '"Gi1/0/7"'
    ].join('\r\n')
    // Terminal escapes are stripped before parsing; a CR splits a line. What is left is a plain name.
    expect(parseLive('iosxe', 'interfaces', evil)).toEqual(['Gi1/0/2', 'Gi1/0/3', 'GigabitEthernet1/0/6'])
    for (const v of ['a b', 'x;y', 'x|y', 'x\ty', 'x\u0007', '', 'x'.repeat(80), '1;']) for (const s of HARVESTED) expect(safeValue(s, v), `${s} ${JSON.stringify(v)}`).toBe(false)
    expect([safeValue('vlans', '4095'), safeValue('vlans', '0'), safeValue('vlans', '4094')]).toEqual([false, false, true])
    expect(parseLive('iosxe', 'vlans', '10   users   active\r\n4095 bad\r\n20;reload x\r\n')).toEqual(['10'])
    expect(parseLive('iosxe', 'bgp-neighbors', '10.0.0.2  4 65002\r\n10.0.0.999 4 1\r\n')).toEqual(['10.0.0.2'])
  })
})

describe('harvest from the simulator output matches what the device has', () => {
  const sims: Partial<Record<SimPlatform, RunningSim>> = {}
  beforeAll(async () => {
    for (const p of ['ios', 'eos'] as const) sims[p] = await startSim({ device: makeDevice(p), port: 0 })
  })
  afterAll(async () => {
    for (const s of Object.values(sims)) await s!.close()
  })

  it.each([
    ['ios', 'iosxe'],
    ['eos', 'eos']
  ] as [SimPlatform, PlatformId][])('%s', async (simP, p) => {
    const sim = sims[simP]!
    const truth = liveValues(sim.device)
    const { raw, client } = await fakeTab(sim.port, 200, { platform: p })
    const h = new LiveHarvest(() => p)
    const listing = async (line: string) => {
      h.ran(line, 'exec')
      const r = await execute(raw as never, p, line, { timeoutMs: 5000, capBytes: 512 * 1024 })
      // The harvester sees the device's raw output up to the next prompt.
      h.output(`${line}\r\n${r.output}\r\n${raw.tail.split(/\r?\n/).at(-1)}`)
      return r
    }
    const names = new Set(truth.interfaces.flatMap((i) => [i.name, i.short]))
    for (const src of HARVESTED) {
      const cmd = (await import('@hopline/cli-model')).PROFILES[p].live[src]?.command
      if (cmd) await listing(cmd)
    }
    expect(h.values.interfaces?.length).toBeGreaterThan(3)
    for (const v of h.values.interfaces ?? []) expect(names.has(v), v).toBe(true)
    // IOS also lists its reserved VLANs (1002-1005); every configured one is learned.
    for (const v of truth.vlans) expect(h.values.vlans ?? []).toContain(String(v.id))
    if (truth.bgpNeighbors.length && h.values['bgp-neighbors']) for (const v of h.values['bgp-neighbors']) expect(truth.bgpNeighbors.map((n) => n.ip)).toContain(v)
    for (const v of h.values.vrfs ?? []) expect(truth.vrfs, v).toContain(v)
    client.end()
  })
})

describe('screenMode', () => {
  it('reads the mode from the prompt (Junos [edit] above it)', () => {
    expect(screenMode('iosxe', 'x\r\ncore-sw1(config-if)#')?.mode).toBe('config-if')
    expect(screenMode('junos', '\r\n[edit]\r\nadmin@mx1# ')?.mode).toBe('config')
    expect(screenMode('iosxe', ' --More-- ')).toBeNull()
  })
})
