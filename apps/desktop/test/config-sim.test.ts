import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { PlatformId } from '@hopline/cli-model'
import { promptUser } from '@shared/cli'
import { checkProposal, runConfig, type RunDeps } from '../src/main/agent/config-apply'
import { detectPrompt, execute } from '../src/session-host/executor'
import { fakeTab } from './helpers'

/** Two admins on one simulated device; returns a tab ready at its exec prompt. */
async function open(sim: RunningSim, platform: PlatformId) {
  const t = await fakeTab(sim.port, 1000, { platform })
  for (let i = 0; i < 300 && detectPrompt(t.tab.tail, platform).mode === 'unknown'; i++) await new Promise((r) => setTimeout(r, 10))
  return t
}

function deps(tab: Awaited<ReturnType<typeof open>>['tab'], platform: PlatformId): RunDeps {
  return {
    platform,
    exec: (line, kind) => execute(tab, platform, line, { timeoutMs: 5000, capBytes: 256 * 1024, allowConfig: kind !== 'read' }),
    report: (_l, _k, r) => r.output,
    prompt: async () => {
      const p = detectPrompt(tab.tail, platform)
      return { mode: p.mode, prompt: p.prompt, hostname: p.hostname }
    }
  }
}

const typed = (tab: Awaited<ReturnType<typeof open>>['tab'], platform: PlatformId, line: string) => execute(tab, platform, line, { timeoutMs: 5000, capBytes: 256 * 1024, allowConfig: true })

describe('Junos: private candidate only (review H4, simulator)', { timeout: 30_000 }, () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeDevice('junos'), port: 0 })
  })
  afterAll(() => sim.close())

  it('another admin with uncommitted shared changes: configure private is refused, nothing is applied, and their work is not committed', async () => {
    const other = await open(sim, 'junos')
    await typed(other.tab, 'junos', 'configure')
    await typed(other.tab, 'junos', 'set system host-name EVIL-HALF-DONE')

    const me = await open(sim, 'junos')
    const c = checkProposal('junos', ['set system location building b2'])
    if (!('plan' in c)) throw new Error(c.reason)
    const r = await runConfig(deps(me.tab, 'junos'), c, ['set system location building b2'])
    expect(r).toMatchObject({ applied: false, partial: false, atExec: true })
    expect(r.reason).toMatch(/another administrator has uncommitted changes/)

    const shown = await execute(me.tab, 'junos', 'show configuration system', { timeoutMs: 5000, capBytes: 256 * 1024 })
    expect(shown.output).not.toMatch(/EVIL-HALF-DONE|building b2/)
    other.client.end()
    me.client.end()
  })

  it('a clean shared database: the private commit applies only this change', async () => {
    const other = await open(sim, 'junos')
    // The first test left the shared candidate dirty (as Junos does after a disconnect): discard it.
    await typed(other.tab, 'junos', 'configure')
    await typed(other.tab, 'junos', 'rollback 0')
    await typed(other.tab, 'junos', 'exit configuration-mode')
    const me = await open(sim, 'junos')
    const c = checkProposal('junos', ['set system location building b2'])
    if (!('plan' in c)) throw new Error(c.reason)
    const r = await runConfig(deps(me.tab, 'junos'), c, ['set system location building b2'])
    expect(r.reason ?? '').toBe('')
    expect(r).toMatchObject({ applied: true, atExec: true })
    const shown = await execute(me.tab, 'junos', 'show configuration system', { timeoutMs: 5000, capBytes: 256 * 1024 })
    expect(shown.output).toMatch(/building b2/)
    other.client.end()
    me.client.end()
  })
})

describe('PAN-OS: pending changes stop the run; the commit is partial to this admin (review H4, simulator)', { timeout: 30_000 }, () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeDevice('panos'), port: 0 })
  })
  afterAll(() => sim.close())

  it('uncommitted changes in the candidate: refused before configure, nothing committed', async () => {
    const other = await open(sim, 'panos')
    await typed(other.tab, 'panos', 'configure')
    await typed(other.tab, 'panos', 'set address evil-host ip-netmask 203.0.113.66/32')

    const me = await open(sim, 'panos')
    const user = promptUser(detectPrompt(me.tab.tail, 'panos').prompt)
    expect(user).toBe('admin')
    const lines = ['set deviceconfig system login-banner "Authorised use only"']
    const c = checkProposal('panos', lines, { user })
    if (!('plan' in c)) throw new Error(c.reason)
    expect(c.plan.commit).toEqual(['commit partial admin admin'])
    const r = await runConfig(deps(me.tab, 'panos'), c, lines)
    expect(r).toMatchObject({ applied: false, partial: false, atExec: true })
    expect(r.reason).toMatch(/already has uncommitted changes/)

    const running = await execute(me.tab, 'panos', 'show config running', { timeoutMs: 5000, capBytes: 512 * 1024 })
    expect(running.output).not.toMatch(/evil-host/)
    await typed(other.tab, 'panos', 'exit')
    other.client.end()
    me.client.end()
  })

  it('a clean candidate: the pre-check passes through the real executor, and the partial commit applies the change', async () => {
    const other = await open(sim, 'panos')
    await typed(other.tab, 'panos', 'configure')
    await typed(other.tab, 'panos', 'revert config')
    await typed(other.tab, 'panos', 'exit')
    const me = await open(sim, 'panos')
    const lines = ['set deviceconfig system login-banner hopline-test-banner']
    const c = checkProposal('panos', lines, { user: promptUser(detectPrompt(me.tab.tail, 'panos').prompt) })
    if (!('plan' in c)) throw new Error(c.reason)
    const r = await runConfig(deps(me.tab, 'panos'), c, lines)
    expect(r.reason ?? '').toBe('')
    expect(r).toMatchObject({ applied: true, atExec: true })
    const running = await execute(me.tab, 'panos', 'show config running', { timeoutMs: 5000, capBytes: 512 * 1024 })
    expect(running.output).toMatch(/hopline-test-banner/)
    other.client.end()
    me.client.end()
  })
})
