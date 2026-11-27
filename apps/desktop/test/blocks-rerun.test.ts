import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { rerunBlock } from '../src/main/blocks/rerun'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { SettingsService } from '../src/main/settings'
import { fakeTab, localControl } from './helpers'

let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
afterAll(() => sim.close())

async function setup(platform: 'iosxe' | 'auto' = 'iosxe') {
  const { tab, client, raw } = await fakeTab(sim.port, 24, { platform: platform as 'iosxe' })
  const sent: string[] = []
  const orig = raw.send
  raw.send = (d: string) => (sent.push(d), orig(d))
  const audit = new AuditLog(openDb(':memory:'))
  const settings = { get: () => ({ commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) } as unknown as SettingsService
  return { d: { term: localControl(tab), audit, settings }, audit, client, sent }
}

describe('re-run a command block', () => {
  it('runs a read through the executor and audits it', async () => {
    const { d, audit, client, sent } = await setup()
    const r = await rerunBlock(d, 'tab-1', 'sh ip int br')
    expect(r).toMatchObject({ action: 'ran', status: 'ok' })
    expect(sent.join('')).toContain('sh')
    const row = audit.list()[0]!
    expect(row).toMatchObject({ source: 'user', kind: 'read', decision: 'executed' })
    expect(row.reason).toMatch(/command block/)
    client.end()
  })

  it('never sends a config or disruptive command: insert only, audited, nothing written', async () => {
    const { d, audit, client, sent } = await setup()
    for (const cmd of ['configure terminal', 'reload', 'clear ip bgp *', 'write erase']) {
      const r = await rerunBlock(d, 'tab-1', cmd)
      expect(r.action).toBe('insert')
    }
    expect(sent).toEqual([])
    const rows = audit.list()
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.decision === 'inserted' && r.source === 'user')).toBe(true)
    client.end()
  })

  it('strips control characters a faked block could carry, and refuses an unknown platform', async () => {
    const { d, client, sent } = await setup('auto')
    const r = await rerunBlock(d, 'tab-1', 'show version\r\nreload\x1b[2K')
    expect(r).toMatchObject({ action: 'insert' })
    // eslint-disable-next-line no-control-regex
    expect(r.action === 'insert' && /[\x00-\x1f]/.test(r.command)).toBe(false)
    expect(sent).toEqual([])
    await expect(rerunBlock(d, 'nope', 'show version')).rejects.toThrow(/No such tab/)
    client.end()
  })
})
