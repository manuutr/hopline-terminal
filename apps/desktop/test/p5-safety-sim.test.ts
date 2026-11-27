import { afterEach, describe, expect, it } from 'vitest'
import type { PlatformId } from '@hopline/cli-model'
import { makeDevice, makeEosDevice, makeIosDevice, runtime, startSim, type Device, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEvent, AuditRow, Settings } from '@shared/types'
import type { ExecResultMsg } from '@shared/host-protocol'
import { policyBlocked } from '@shared/policy-deny'
import { Agent } from '../src/main/agent/agent'
import { STATE_UNKNOWN } from '../src/main/agent/changes'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { ExecOpts, TabControl } from '../src/main/host/client'
import type { ChatMessage, LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'
import { detectPrompt, execute } from '../src/session-host/executor'
import { bindingRefusal, hostRefusal, netRefusal, readOnlyRefusal } from '../src/session-host/guard-check'
import { fakeTab } from './helpers'

/**
 * Phase 5 safety review (H1–H3, M4, L1–L4) against the simulator, with the same harness as
 * safety-net-sim.test.ts: the real executor behind the session host's own checks, plus the team
 * policy check `SessionHostClient.exec` makes and a fault hook that changes what one command
 * returns (a commit that ran but reports a timeout, a check read that times out, a device timer
 * that fires at a chosen moment). The rule under test: the card and the audit never claim a state
 * the device is not in.
 */

type Call = { name: string; input: unknown }

class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted'
  results: string[][] = []
  constructor(private script: Call[][]) {}
  async turn(req: TurnRequest): Promise<TurnResult> {
    const last = req.messages.at(-1)
    const res = last?.role === 'user' ? last.parts.filter((p) => p.type === 'tool_result').map((p) => (p as { content: string }).content) : []
    if (res.length) this.results.push(res)
    const step = this.script.shift()
    if (!step) {
      req.onText('Done.')
      return { message: { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }, stop: 'end' }
    }
    return { message: { role: 'assistant', parts: step.map((c, i) => ({ type: 'tool_call' as const, id: `c${this.results.length}_${i}`, name: c.name, input: c.input })) }, stop: 'tool_use' } as TurnResult & { message: ChatMessage }
  }
}

type Tab = Awaited<ReturnType<typeof fakeTab>>['tab']
/** Return a result instead of (or after) running the command; `run` executes it on the device for real. */
type Fault = (command: string, run: () => Promise<ExecResultMsg>) => Promise<ExecResultMsg> | undefined

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const timeout = (r: ExecResultMsg): ExecResultMsg => ({ ...r, status: 'timeout', error: 'timed out after 30000 ms' })

interface Env {
  sim: RunningSim
  tabs: Tab[]
  agent: Agent
  provider: ScriptedProvider
  events: AgentEvent[]
  sent: { command: string; net: boolean; hosts?: readonly string[]; tabId: string; at: number }[]
  audit: AuditLog
  fault: { fn?: Fault }
  close(): void
}

const envs: Env[] = []
afterEach(() => {
  for (const e of envs.splice(0)) e.close()
})

async function setup(platform: PlatformId, device: () => Device, name: string, script: Call[][], opts: { policy?: Record<string, string[]>; tabs?: number; onEvent?: (e: AgentEvent, env: Env) => void } = {}): Promise<Env> {
  const sim = await startSim({ device: device(), port: 0 })
  const tabs: Tab[] = []
  const clients: { end(): void }[] = []
  for (let i = 0; i < (opts.tabs ?? 1); i++) {
    const { tab, client } = await fakeTab(sim.port, 1000, { platform, name })
    tab.tabId = `tab-${i + 1}`
    for (let j = 0; j < 300 && detectPrompt(tab.tail, platform).mode === 'unknown'; j++) await sleep(10)
    tabs.push(tab)
    clients.push(client)
  }
  const sent: Env['sent'] = []
  const fault: Env['fault'] = {}
  const rules = opts.policy ?? {}
  const byId = (id: string) => tabs.find((t) => t.tabId === id)
  const term: TabControl = {
    get: (id) => byId(id),
    exec: async (t, command, kind, o: ExecOpts) => {
      const tab = byId(t.tabId)!
      // SessionHostClient.exec: the team policy on every send path, then the session host's checks.
      const denied = policyBlocked(rules, platform, command)
      if (denied) return { status: 'error', output: '', durationMs: 0, bytes: 0, error: `refused: ${denied}` }
      const ro = readOnlyRefusal(kind, false)
      const refusal = ro ?? (o.net ? netRefusal(command, platform, kind, tab.tail, o.hosts) : (bindingRefusal(kind, o.hosts) ?? hostRefusal(command, platform, kind, tab.tail, o.ack, o.hosts)))
      if (refusal) return { status: 'error', output: '', durationMs: 0, bytes: 0, error: refusal }
      sent.push({ command, net: !!o.net, hosts: o.hosts, tabId: tab.tabId, at: Date.now() })
      const real = () => execute(tab, platform, command, { timeoutMs: 8000, capBytes: 512 * 1024, allowConfig: kind !== 'read' && o.allowConfig })
      return (await fault.fn?.(command, real)) ?? real()
    },
    mode: async (t) => detectPrompt(byId(t.tabId)!.tail, platform).mode,
    prompt: async (t) => {
      const p = detectPrompt(byId(t.tabId)!.tail, platform)
      return { mode: p.mode, prompt: p.prompt, hostname: p.hostname }
    },
    policyRules: rules
  }
  const db = openDb(':memory:')
  const audit = new AuditLog(db)
  const provider = new ScriptedProvider(script)
  const events: AgentEvent[] = []
  const settings = { get: () => ({ aiReadOnly: false, commandTimeoutMs: 8000, outputCapBytes: 512 * 1024 }) as Partial<Settings> } as unknown as SettingsService
  let env!: Env
  const agent = new Agent({
    term,
    settings,
    audit,
    provider: async () => provider,
    emit: (e) => {
      events.push(e)
      opts.onEvent?.(e, env)
    }
  })
  env = {
    sim,
    tabs,
    agent,
    provider,
    events,
    sent,
    audit,
    fault,
    close: () => {
      agent.dispose?.()
      for (const c of clients) c.end()
      sim.close()
    }
  }
  envs.push(env)
  return env
}

const changes = (env: Env, proposalId?: string) => env.events.filter((e): e is Extract<AgentEvent, { type: 'change' }> => e.type === 'change' && (!proposalId || e.proposalId === proposalId))
const lastChange = (env: Env, proposalId?: string) => changes(env, proposalId).at(-1)
const rows = (env: Env): AuditRow[] => env.audit.list().reverse()
const until = async (what: () => unknown, ms = 20_000) => {
  for (let t = 0; t < ms / 10; t++) {
    if (what()) return
    await sleep(10)
  }
  throw new Error('condition not reached')
}
const runDone = (env: Env, n = 1) => until(() => env.events.filter((e) => e.type === 'done').length >= n)
const show = async (env: Env, platform: PlatformId, command: string) => (await execute(env.tabs[0]!, platform, command, { timeoutMs: 8000, capBytes: 512 * 1024 })).output

const JUNOS = { platform: 'junos' as const, device: () => makeDevice('junos'), name: 'edge-r1' }
const junosChange = (token: string, extra: Record<string, unknown> = {}): Call => ({
  name: 'propose_config_change',
  input: { commands: [`set system location building ${token}`], rationale: 'test', rollback: ['delete system location'], verify: [{ command: 'show configuration system', expect: `location building ${token}` }], ...extra }
})
const NXOS = { platform: 'nxos' as const, device: () => makeDevice('nxos'), name: 'leaf1' }
const nxosChange = (token: string, extra: Record<string, unknown> = {}): Call => ({
  name: 'propose_config_change',
  input: { commands: ['interface Ethernet1/1', `description ${token}`], rationale: 'test', rollback: ['interface Ethernet1/1', 'no description'], verify: [{ command: 'show interface description', expect: token }], ...extra }
})
/** Approve every card as soon as it shows. */
const approveAll = (e: AgentEvent, env: Env) => {
  if (e.type === 'proposal') setTimeout(() => env.agent.decide(e.proposalId, true), 10)
}
const awaitingOf = (env: Env, proposalId?: string) => until(() => changes(env, proposalId).some((c) => c.phase === 'awaiting' || c.phase === 'unknown'))
const proposalIds = (env: Env) => env.events.filter((e): e is Extract<AgentEvent, { type: 'proposal' }> => e.type === 'proposal').map((e) => e.proposalId)

describe('H1: one open change per device session', { timeout: 60_000 }, () => {
  it('Junos: a second proposal is refused while the first waits; rolling back the first undoes only the first', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('S2-A')], [junosChange('S2-B')]], { onEvent: approveAll })
    env.agent.start({ tabId: 'tab-1', prompt: 'change A' })
    await awaitingOf(env)
    // The model is still inside run 1 (report_verification would wait); end it, the card stays open.
    await runDone(env)
    const [a] = proposalIds(env)
    env.agent.start({ tabId: 'tab-1', prompt: 'change B' })
    await runDone(env, 2)
    expect(env.provider.results.at(-1)![0]).toMatch(/^REFUSED: another change is still open on this device/)
    expect(proposalIds(env)).toHaveLength(1)
    expect(env.sent.some((s) => s.command.includes('S2-B'))).toBe(false)
    await env.agent.changeAction(a!, 'rollback')
    expect(lastChange(env, a)).toMatchObject({ phase: 'rolled-back', message: expect.stringMatching(/checked with "show system commit"/) })
    const conf = await show(env, 'junos', 'show configuration system')
    expect(conf).not.toMatch(/S2-A|S2-B/)
    expect(runtime(env.sim.device).pending('junos-commit-confirm')).toBe(false)
    // The change's own commit carries its comment; the rollback's commit carries `-undo`.
    expect(env.sent.some((s) => /^commit confirmed 5 comment hopline-[0-9a-f]{8}$/.test(s.command) && s.net)).toBe(true)
    expect(env.sent.some((s) => /^commit comment hopline-[0-9a-f]{8}-undo and-quit$/.test(s.command) && s.net)).toBe(true)
  })

  it('two cards approved one after the other (two tabs, one session): the second is refused at apply and its card says why', async () => {
    const ids: string[] = []
    const env = await setup(NXOS.platform, NXOS.device, NXOS.name, [[nxosChange('first')], [nxosChange('second')]], {
      tabs: 2,
      onEvent: (e, en) => {
        if (e.type !== 'proposal') return
        ids.push(e.proposalId)
        // Both cards are shown before either is approved; then both are approved back to back.
        if (ids.length === 2) setTimeout(() => ids.forEach((id) => en.agent.decide(id, true)), 10)
      }
    })
    env.agent.start({ tabId: 'tab-1', prompt: 'first' })
    await until(() => ids.length === 1)
    env.agent.start({ tabId: 'tab-2', prompt: 'second' })
    await until(() => changes(env, ids[1]).some((c) => c.phase === 'failed') && changes(env, ids[0]).some((c) => c.phase === 'awaiting'))
    expect(lastChange(env, ids[1])).toMatchObject({ phase: 'failed', message: expect.stringMatching(/^Another change is open on this device/), actions: [] })
    expect(env.sent.some((s) => s.command === 'description second')).toBe(false)
    expect(rows(env).filter((r) => r.command === 'description second').map((r) => r.decision)).toEqual(['refused'])
  })
})

describe('H2/L2/L3: a timer net is never reported confirmed unless the device shows it', { timeout: 60_000 }, () => {
  it('H2: the device timer fired and the check read times out: Confirm sends nothing, the card says state unknown, the audit too', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('H2')]], { onEvent: approveAll })
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    const [id] = proposalIds(env)
    expect(runtime(env.sim.device).fire('junos-commit-confirm')).toBe(1)
    env.fault.fn = (c, run) => (c === 'show system commit' ? run().then(timeout) : undefined)
    const before = env.sent.length
    await expect(env.agent.changeAction(id!, 'confirm')).rejects.toThrow(STATE_UNKNOWN)
    expect(env.sent.slice(before).map((s) => s.command)).toEqual(['show system commit'])
    expect(lastChange(env, id)).toMatchObject({ phase: 'unknown', message: expect.stringContaining(STATE_UNKNOWN), actions: ['confirm', 'rollback'] })
    expect(rows(env).some((r) => r.decision === 'confirmed')).toBe(false)
    expect(rows(env).at(-1)).toMatchObject({ decision: 'unknown' })
    // The device answers again: the same Confirm now reports what really happened.
    env.fault.fn = undefined
    await env.agent.changeAction(id!, 'confirm')
    expect(lastChange(env, id)).toMatchObject({ phase: 'expired' })
    expect(env.sent.some((s) => /-ok and-quit$/.test(s.command))).toBe(false)
    expect(await show(env, 'junos', 'show configuration system')).not.toMatch(/H2/)
  })

  it('L2: the device timer fires between the check and the confirm commit: reported expired, never confirmed', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('L2')]], { onEvent: approveAll })
    let commitAt = 0
    env.fault.fn = (c, run) => {
      if (/^commit confirmed/.test(c)) commitAt = Date.now()
      // A slow verify read: the deadline must still count from the commit, not from the card.
      if (c === 'show configuration system') return sleep(1500).then(run)
      return undefined
    }
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    const [id] = proposalIds(env)
    const deadline = changes(env, id).find((c) => c.phase === 'awaiting')!.deadline!
    expect(deadline - commitAt).toBeGreaterThanOrEqual(5 * 60_000 - 50)
    expect(deadline - commitAt).toBeLessThan(5 * 60_000 + 1000)
    env.fault.fn = (c, run) => {
      if (c !== 'configure private') return undefined
      runtime(env.sim.device).fire('junos-commit-confirm')
      return run()
    }
    await env.agent.changeAction(id!, 'confirm')
    expect(lastChange(env, id)).toMatchObject({ phase: 'expired', message: expect.stringMatching(/before the confirm took.*NOT in effect/) })
    expect(rows(env).some((r) => r.decision === 'confirmed')).toBe(false)
    expect(await show(env, 'junos', 'show configuration system')).not.toMatch(/L2/)
  })

  it("L3: another admin's plain commit confirmed the change: Hopline Terminal says state unknown, not rolled back or confirmed", async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('L3')]], { onEvent: approveAll, tabs: 2 })
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    const [id] = proposalIds(env)
    // Another admin (the second session) commits something else: Junos takes it as the confirmation.
    const other = env.tabs[1]!
    for (const line of ['configure', 'set system location floor 3', 'commit and-quit']) await execute(other, 'junos', line, { timeoutMs: 8000, capBytes: 512 * 1024, allowConfig: true })
    expect(runtime(env.sim.device).pending('junos-commit-confirm')).toBe(false)
    const before = env.sent.length
    await expect(env.agent.changeAction(id!, 'rollback')).rejects.toThrow(STATE_UNKNOWN)
    // Nothing sent after the check: `rollback 1` would now undo the other admin's commit.
    expect(env.sent.slice(before).map((s) => s.command)).toEqual(['show system commit'])
    expect(lastChange(env, id)).toMatchObject({ phase: 'unknown' })
    expect(rows(env).some((r) => r.decision === 'rolled-back' || r.decision === 'expired' || r.decision === 'confirmed')).toBe(false)
    expect(await show(env, 'junos', 'show configuration system')).toMatch(/L3/)
  })
})

describe('H3: a commit that did not report back is never "nothing was changed"', { timeout: 60_000 }, () => {
  it('Junos: the commit confirmed ran on the device but timed out for Hopline Terminal: the change stays open, pending, with its undo', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('H3a')]], { onEvent: approveAll })
    env.fault.fn = (c, run) => (/^commit confirmed/.test(c) ? run().then(timeout) : undefined)
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    const text = env.provider.results[0]![0]!
    expect(text).not.toMatch(/Nothing was changed|NOT APPLIED/)
    expect(text).toMatch(/device shows this change's commit waiting for confirmation/)
    const [id] = proposalIds(env)
    expect(lastChange(env, id)).toMatchObject({ phase: 'awaiting', actions: ['confirm', 'rollback'] })
    // The discard lines ran (they drop only the uncommitted candidate): the commit is still live and pending.
    expect(env.sent.map((s) => s.command)).toContain('rollback 0')
    expect(runtime(env.sim.device).pending('junos-commit-confirm')).toBe(true)
    expect(await show(env, 'junos', 'show configuration system')).toMatch(/H3a/)
    env.fault.fn = undefined
    await env.agent.changeAction(id!, 'rollback')
    expect(lastChange(env, id)).toMatchObject({ phase: 'rolled-back' })
    expect(await show(env, 'junos', 'show configuration system')).not.toMatch(/H3a/)
  })

  it('EOS: the commit timer ran but timed out for Hopline Terminal: the discard cannot reach the committed session; the change stays open', async () => {
    const env = await setup('eos', makeEosDevice, 'dist-eos1', [[{ name: 'propose_config_change', input: { commands: ['interface Ethernet1', 'description h3-eos'], rationale: 'x', rollback: ['interface Ethernet1', 'no description'], verify: [{ command: 'show interfaces description', expect: 'h3-eos' }] } }]], { onEvent: approveAll })
    env.fault.fn = (c, run) => (/^commit timer/.test(c) ? run().then(timeout) : undefined)
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    expect(env.provider.results[0]![0]).toMatch(/device shows this change's commit waiting for confirmation/)
    expect(env.sent.some((s) => s.command === 'abort')).toBe(false)
    const [id] = proposalIds(env)
    expect(lastChange(env, id)).toMatchObject({ phase: 'awaiting' })
    expect(await show(env, 'eos', 'show running-config interfaces Ethernet1')).toMatch(/h3-eos/)
    env.fault.fn = undefined
    await env.agent.changeAction(id!, 'rollback')
    expect(lastChange(env, id)).toMatchObject({ phase: 'rolled-back' })
    expect(await show(env, 'eos', 'show running-config interfaces Ethernet1')).not.toMatch(/h3-eos/)
  })

  it('Junos: the commit line never reached the device: the history proves it, so "nothing was changed" is said with the check', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('H3b')]], { onEvent: approveAll })
    env.fault.fn = (c) => (/^commit confirmed/.test(c) ? Promise.resolve({ status: 'timeout', output: '', durationMs: 30000, bytes: 0, error: 'timed out' }) : undefined)
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await runDone(env)
    expect(env.provider.results[0]![0]).toMatch(/^NOT APPLIED: .*"show system commit" shows this change's commit is not on the device, so nothing was changed/)
    expect(lastChange(env)).toMatchObject({ phase: 'failed' })
  })

  it('without a device check (rollback lines): the card says state unknown, audited unknown, and the undo is still offered', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('H3c', { safety_net: 'rollback_lines' })]], { onEvent: approveAll })
    env.fault.fn = (c, run) => (c === 'commit and-quit' ? run().then(timeout) : undefined)
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    const text = env.provider.results[0]![0]!
    expect(text).toMatch(/^UNCERTAIN \(approved by /)
    expect(text).not.toMatch(/Nothing was changed/)
    const [id] = proposalIds(env)
    expect(lastChange(env, id)).toMatchObject({ phase: 'unknown', message: expect.stringContaining(STATE_UNKNOWN), actions: ['confirm', 'rollback'] })
    expect(rows(env).some((r) => r.decision === 'unknown' && r.reason?.includes(STATE_UNKNOWN))).toBe(true)
    expect(await show(env, 'junos', 'show configuration system')).toMatch(/H3c/)
    // A rollback line that fails leaves it unknown: never "Applied, waiting for your decision".
    env.fault.fn = (c) => (c === 'delete system location' ? Promise.resolve({ status: 'error', output: '', durationMs: 0, bytes: 0, error: 'connection reset' }) : undefined)
    await env.agent.changeAction(id!, 'rollback')
    expect(lastChange(env, id)).toMatchObject({ phase: 'unknown', message: expect.stringMatching(/^Rollback stopped/), actions: ['confirm', 'rollback'] })
    // The rollback lines still undo it; the card says what ran, not what the device holds.
    env.fault.fn = undefined
    await env.agent.changeAction(id!, 'rollback')
    expect(lastChange(env, id)).toMatchObject({ phase: 'rolled-back', message: expect.stringMatching(/did not read the configuration back/) })
    expect(await show(env, 'junos', 'show configuration system')).not.toMatch(/H3c/)
  })
})

describe('M4: the team policy cannot block a safety net after the change is live', { timeout: 60_000 }, () => {
  it('NX-OS: a policy blocking "rollback" refuses the proposal before the card; nothing is sent', async () => {
    const env = await setup(NXOS.platform, NXOS.device, NXOS.name, [[nxosChange('m4')]], { policy: { nxos: ['rollback'] }, onEvent: approveAll })
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await runDone(env)
    expect(env.provider.results[0]![0]).toMatch(/^BLOCKED: the checkpoint safety net needs "rollback running-config checkpoint hopline-[0-9a-f]{8}", which the team policy does not allow .*safety_net "rollback_lines"/)
    expect(proposalIds(env)).toEqual([])
    expect(env.sent).toEqual([])
  })

  it('Junos: a policy blocking the timer check refuses the proposal before the card', async () => {
    const env = await setup(JUNOS.platform, JUNOS.device, JUNOS.name, [[junosChange('m4j')]], { policy: { junos: ['show system commit'] }, onEvent: approveAll })
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await runDone(env)
    expect(env.provider.results[0]![0]).toMatch(/^BLOCKED: the commit confirmed safety net needs "show system commit"/)
    expect(env.sent).toEqual([])
  })
})

describe('L1: confirm and roll back cannot run at the same time', { timeout: 60_000 }, () => {
  it('NX-OS: both at once: one runs, the other is refused before anything is sent; the audit has one outcome', async () => {
    const env = await setup(NXOS.platform, NXOS.device, NXOS.name, [[nxosChange('l1')]], { onEvent: approveAll })
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await awaitingOf(env)
    await runDone(env)
    const [id] = proposalIds(env)
    const [c, r] = await Promise.allSettled([env.agent.changeAction(id!, 'confirm'), env.agent.changeAction(id!, 'rollback')])
    expect(c.status).toBe('fulfilled')
    expect(r).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Hopline Terminal is still working on this change' }) })
    expect(lastChange(env, id)).toMatchObject({ phase: 'confirmed' })
    const out = rows(env).filter((x) => ['confirmed', 'rolled-back', 'error'].includes(x.decision))
    expect(out.map((x) => x.decision)).toEqual(['confirmed'])
    expect(env.sent.some((s) => s.command.startsWith('rollback running-config'))).toBe(false)
  })
})

describe('L4: a later proposal cannot touch an open change\'s safety net', { timeout: 60_000 }, () => {
  it.each([
    ['nxos', NXOS, ['do no checkpoint hopline-0a1b2c3d'], /checkpoints are the safety net Hopline Terminal manages/],
    ['nxos', NXOS, ['do checkpoint hopline-0a1b2c3d'], /checkpoints are the safety net Hopline Terminal manages/],
    ['iosxe', { platform: 'iosxe' as const, device: makeIosDevice, name: 'core-sw1' }, ['archive', 'path flash:evil'], /archive configuration is the safety net/]
  ] as const)('%s: %j is blocked before any card', async (_p, k, commands, why) => {
    const env = await setup(k.platform, k.device, k.name, [[{ name: 'propose_config_change', input: { commands, rationale: 'x', rollback: ['no description'], verify: [{ command: 'show version', expect: 'x' }] } }]], { onEvent: approveAll })
    env.agent.start({ tabId: 'tab-1', prompt: 'go' })
    await runDone(env)
    expect(env.provider.results[0]![0]).toMatch(/^BLOCKED: /)
    expect(env.provider.results[0]![0]).toMatch(why)
    expect(proposalIds(env)).toEqual([])
    expect(env.sent).toEqual([])
  })
})
