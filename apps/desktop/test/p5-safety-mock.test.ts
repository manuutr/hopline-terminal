import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Session, Settings } from '@shared/types'
import type { ExecResultMsg, PromptInfo } from '@shared/host-protocol'
import { promptState } from '@shared/cli'
import { policyBlocked } from '@shared/policy-deny'
import { SAFETY_NETS } from '@hopline/cli-model'
import { Agent } from '../src/main/agent/agent'
import { STATE_UNKNOWN } from '../src/main/agent/changes'
import { checkProposal, runConfig, type CheckedProposal, type LineKind } from '../src/main/agent/config-apply'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { AgentTab, ExecKind, ExecOpts, TabControl } from '../src/main/host/client'
import type { LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'
import { GuardedRunner } from '../src/main/productivity/runner'

/**
 * Phase 5 safety review, the findings that need no device (or a scripted one): M2 (the host
 * binding follows the approved lines), L6 (a disruptive rollback after an approved rename), L10
 * (refused decisions and actions are audited), H2 (an unreadable expiry check is "state unknown",
 * retried, never "rolled back"), and H3 in runConfig (a commit that did not report back is
 * uncertain, never "not committed"). The simulator flows are in p5-safety-sim.test.ts.
 */

type Call = { name: string; input: unknown }

class Scripted implements LlmProvider {
  readonly id = 'scripted'
  results: string[][] = []
  constructor(private script: Call[][]) {}
  async turn(req: TurnRequest): Promise<TurnResult> {
    const last = req.messages.at(-1)
    const res = last?.role === 'user' ? last.parts.filter((p) => p.type === 'tool_result').map((p) => (p as { content: string }).content) : []
    if (res.length) this.results.push(res)
    const step = this.script.shift()
    if (!step) return { message: { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }, stop: 'end' }
    return { message: { role: 'assistant', parts: step.map((c, i) => ({ type: 'tool_call' as const, id: `c${this.results.length}_${i}`, name: c.name, input: c.input })) }, stop: 'tool_use' }
  }
}

/** A scripted device: the prompt follows configuration mode and the hostname the lines set. */
function control(platform: Session['platform'], hostname: string, outputs: Record<string, (() => string | ExecResultMsg) | string> = {}) {
  const session = { id: 's1', name: 'dev', host: '10.0.0.1', platform } as unknown as Session
  const sent: { command: string; kind: ExecKind; opts: ExecOpts }[] = []
  let inConfig = false
  let name = hostname
  let open = true
  const current = (): PromptInfo => ({ mode: inConfig ? 'config' : 'exec', prompt: inConfig ? `${name}(config)#` : `${name}#`, hostname: name })
  const ctl: TabControl = {
    get: (id) => (id === 't1' && open ? ({ tabId: 't1', session } as AgentTab) : undefined),
    exec: async (_t, command, kind, opts): Promise<ExecResultMsg> => {
      sent.push({ command, kind, opts })
      const o = outputs[command]
      const v = typeof o === 'function' ? o() : (o ?? '')
      if (typeof v !== 'string') return v
      if (/^(configure terminal|configure session \S+)$/.test(command)) inConfig = true
      else if (/^(end|abort|commit timer .*)$/.test(command)) inConfig = false
      const h = /^hostname (\S+)$/.exec(command)
      if (h) name = h[1]!
      return { status: 'ok', output: v, durationMs: 1, bytes: v.length }
    },
    mode: async () => current().mode,
    prompt: async () => current()
  }
  return { ctl, sent, close: () => (open = false) }
}

function run(script: Call[][], ctl: TabControl, onEvent?: (e: AgentEvent, agent: Agent) => void, prefs: Partial<Settings> = {}) {
  const provider = new Scripted(script)
  const audit = new AuditLog(openDb(':memory:'))
  const events: AgentEvent[] = []
  const s = { aiReadOnly: false, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, ...prefs }
  const settings = { get: () => s } as unknown as SettingsService
  let agent!: Agent
  const done = new Promise<void>((resolve) => {
    agent = new Agent({
      term: ctl,
      settings,
      audit,
      provider: async () => provider,
      emit: (e) => {
        events.push(e)
        onEvent?.(e, agent)
        if (e.type === 'done') resolve()
      }
    })
  })
  agent.start({ tabId: 't1', prompt: 'go' })
  return { agent, provider, events, done, audit }
}

const lastChange = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'change' }> => e.type === 'change').at(-1)
const proposalOf = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: 'proposal' }> => e.type === 'proposal')!

afterEach(() => vi.useRealTimers())

describe('M2: the host binding follows the approved lines only', () => {
  it('NX-OS: an unticked "hostname evil-core" never reaches the binding; after the apply it is the prompt hostname', async () => {
    const { ctl, sent } = control('nxos', 'leaf1')
    const r = run(
      [[{ name: 'propose_config_change', input: { commands: ['hostname evil-core', 'interface Ethernet1/1', 'description x'], rationale: 'x', rollback: ['interface Ethernet1/1', 'no description'], verify: [{ command: 'show interface description', expect: 'x' }] } }]],
      ctl,
      (e, agent) => {
        if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true, 'user', undefined, [1, 2]), 5)
      }
    )
    await r.done
    const configs = sent.filter((s) => s.kind !== 'read')
    expect(configs.length).toBeGreaterThan(0)
    for (const s of configs) expect(s.opts.hosts, s.command).not.toContain('evil-core')
    expect(sent.some((s) => s.command === 'hostname evil-core')).toBe(false)
    // Confirm runs bound to leaf1 only (and the cleanup line).
    const before = sent.length
    await r.agent.changeAction(proposalOf(r.events).proposalId, 'confirm')
    for (const s of sent.slice(before)) expect(s.opts.hosts).toEqual(['leaf1'])
  })
})

describe('L6: a disruptive rollback after an approved rename', () => {
  it.each([
    ['the rollback keeps the new name', ['interface Gi0/1', 'shutdown'], 'r2'],
    ['the rollback renames back first', ['hostname r1', 'interface Gi0/1', 'shutdown'], 'r1']
  ])('IOS, %s: the disruptive rollback line carries the hostname its prompt shows', async (_name, rollback, ack) => {
    const { ctl, sent } = control('ios', 'r1')
    const r = run(
      [[{ name: 'propose_config_change', input: { commands: ['hostname r2', 'interface Gi0/1', 'no shutdown'], rationale: 'x', rollback, verify: [{ command: 'show ip interface brief', expect: 'up' }] } }]],
      ctl,
      (e, agent) => {
        if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true, 'user', 'r1'), 5)
      }
    )
    await r.done
    const id = proposalOf(r.events).proposalId
    expect(sent.find((s) => s.command === 'no shutdown')!.opts.ack).toBe('r1')
    await r.agent.changeAction(id, 'rollback')
    const shut = sent.find((s) => s.command === 'shutdown')!
    expect(shut.opts.ack).toBe(ack)
    expect(shut.opts.hosts).toEqual(expect.arrayContaining(['r1', 'r2']))
    expect(lastChange(r.events)).toMatchObject({ phase: 'rolled-back' })
  })
})

describe('L10: refused decisions and actions are audited', () => {
  it('a wrong typed hostname and a bad line index are audited as refused approvals; the card stays open', async () => {
    const { ctl } = control('ios', 'r1')
    const errors: string[] = []
    const r = run([[{ name: 'propose_config_change', input: { commands: ['interface Gi0/1', 'shutdown'], rationale: 'x', rollback: ['interface Gi0/1', 'no shutdown'], verify: [{ command: 'show ip interface brief', expect: 'down' }] } }]], ctl, (e, agent) => {
      if (e.type !== 'proposal') return
      setTimeout(() => {
        for (const f of [() => agent.decide(e.proposalId, true, 'user', 'r9'), () => agent.decide(e.proposalId, true, 'user', 'r1', [7])])
          try {
            f()
          } catch (x) {
            errors.push((x as Error).message)
          }
        agent.decide(e.proposalId, false)
      }, 5)
    })
    await r.done
    expect(errors).toEqual([expect.stringMatching(/Type the device hostname "r1"/), 'A ticked line is not part of this proposal'])
    const refused = r.audit.list().filter((x) => x.decision === 'refused' && x.reason?.startsWith('approval refused'))
    expect(refused).toHaveLength(2)
  })

  it('confirm on a closed session is refused and audited; the change stays open', async () => {
    const { ctl, close } = control('nxos', 'leaf1')
    const r = run([[{ name: 'propose_config_change', input: { commands: ['interface Ethernet1/1', 'description x'], rationale: 'x', rollback: ['interface Ethernet1/1', 'no description'], verify: [{ command: 'show interface description', expect: 'x' }] } }]], ctl, (e, agent) => {
      if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true), 5)
    })
    await r.done
    close()
    await expect(r.agent.changeAction(proposalOf(r.events).proposalId, 'confirm')).rejects.toThrow('The session is closed')
    expect(r.audit.list()[0]).toMatchObject({ command: '(confirm)', decision: 'refused', reason: expect.stringMatching(/session is closed/) })
  })
})

describe('H2: an unreadable expiry check is never reported as a rollback', () => {
  it('EOS: the check read fails at the deadline: state unknown (audited), retried with a backoff, then the real outcome', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let mode: 'fail' | 'gone' | 'pending' = 'pending'
    const name = () => sent.find((s) => s.command.startsWith('configure session '))!.command.split(' ')[2]!
    const { ctl, sent } = control('eos', 'dist-eos1', {
      'show configuration sessions': () =>
        mode === 'fail' ? { status: 'timeout', output: '', durationMs: 5000, bytes: 0, error: 'timed out' } : mode === 'pending' ? `  Name          State\n  ${name()} pendingCommitTimer  admin` : '  Name          State\n'
    })
    const r = run([[{ name: 'propose_config_change', input: { commands: ['interface Ethernet1', 'description x'], rationale: 'x', rollback: ['interface Ethernet1', 'no description'], verify: [{ command: 'show interfaces description', expect: 'x' }], confirm_minutes: 1 } }]], ctl, (e, agent) => {
      if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true), 5)
    })
    await vi.advanceTimersByTimeAsync(50)
    await r.done
    mode = 'fail'
    await vi.advanceTimersByTimeAsync(60_000 + 10_000)
    expect(lastChange(r.events)).toMatchObject({ phase: 'unknown', message: expect.stringContaining(STATE_UNKNOWN), actions: ['confirm', 'rollback'] })
    expect(r.audit.list()[0]).toMatchObject({ decision: 'unknown' })
    expect(r.audit.list().some((x) => x.decision === 'expired')).toBe(false)
    const checks = () => sent.filter((s) => s.command === 'show configuration sessions').length
    const n = checks()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(checks()).toBe(n + 1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checks()).toBe(n + 2)
    // Readable again and still pending: back to the countdown.
    mode = 'pending'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastChange(r.events)).toMatchObject({ phase: 'awaiting', actions: ['confirm', 'rollback'] })
    mode = 'gone'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastChange(r.events)).toMatchObject({ phase: 'expired', actions: [] })
  })

  it('the timer expires after the tab closed: state unknown, not "the device rolled back"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { ctl, sent, close } = control('eos', 'dist-eos1', {
      'show configuration sessions': () => `  Name          State\n  ${sent.find((s) => s.command.startsWith('configure session '))!.command.split(' ')[2]!} pendingCommitTimer  admin`
    })
    const r = run([[{ name: 'propose_config_change', input: { commands: ['interface Ethernet1', 'description x'], rationale: 'x', rollback: ['interface Ethernet1', 'no description'], verify: [{ command: 'show interfaces description', expect: 'x' }], confirm_minutes: 1 } }]], ctl, (e, agent) => {
      if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true), 5)
    })
    await vi.advanceTimersByTimeAsync(50)
    await r.done
    close()
    await vi.advanceTimersByTimeAsync(60_000 + 10_000)
    expect(lastChange(r.events)).toMatchObject({ phase: 'unknown', actions: [], message: expect.stringContaining(STATE_UNKNOWN) })
    expect(r.audit.list()[0]).toMatchObject({ decision: 'unknown' })
  })
})

describe('H3: runConfig never says "not committed" once a commit line was sent', () => {
  const plan = (platform: 'iosxr' | 'junos', commands: string[]) => checkProposal(platform, commands) as CheckedProposal
  function fake(platform: 'iosxr' | 'junos', result: (line: string) => Partial<ExecResultMsg> | undefined, config: (ran: string[]) => boolean) {
    const ran: string[] = []
    return {
      ran,
      deps: {
        platform,
        exec: async (line: string, _kind: LineKind | 'read'): Promise<ExecResultMsg> => {
          ran.push(line)
          return { status: 'ok', output: '', durationMs: 1, bytes: 1, ...result(line) }
        },
        report: (_l: string, _k: LineKind | 'read', r: ExecResultMsg) => r.output,
        prompt: async (): Promise<PromptInfo> => {
          const p = promptState(config(ran) ? (platform === 'junos' ? '[edit]\nadmin@r1# ' : 'RP/0/RP0/CPU0:r1(config)#') : platform === 'junos' ? 'admin@r1> ' : 'RP/0/RP0/CPU0:r1#', platform)
          return { mode: p.mode, prompt: p.prompt, hostname: p.hostname }
        }
      }
    }
  }

  it('Junos: the commit times out: uncertain, the uncommitted candidate is discarded, nothing claims "not committed"', async () => {
    const c = plan('junos', ['set system host-name x'])
    const f = fake('junos', (l) => (l === 'commit and-quit' ? { status: 'timeout', error: 'timed out' } : undefined), (ran) => ran.length > 0 && ran.at(-1) !== 'exit configuration-mode')
    const r = await runConfig(f.deps, c, ['set system host-name x'])
    expect(r).toMatchObject({ applied: false, uncertain: true, partial: false })
    expect(r.reason).toMatch(/may have reached the device/)
    expect(r.reason).not.toMatch(/not committed/)
    expect(f.ran).toEqual(['configure private', 'set system host-name x', 'commit and-quit', 'rollback 0', 'exit configuration-mode'])
  })

  it('IOS-XR: the commit went through, then "end" times out: uncertain ("probably live"), not "not committed"', async () => {
    const c = plan('iosxr', ['hostname x'])
    const f = fake('iosxr', (l) => (l === 'end' ? { status: 'timeout', error: 'timed out' } : undefined), (ran) => ran.length > 0)
    const r = await runConfig(f.deps, c, ['hostname x'])
    expect(r).toMatchObject({ applied: false, uncertain: true })
    expect(r.reason).toMatch(/after the commit: the change is probably live/)
  })

  it('a commit the device answers with an error is a known failure: not uncertain', async () => {
    const c = plan('junos', ['set system host-name x'])
    const f = fake('junos', (l) => (l === 'commit and-quit' ? { output: 'error: configuration check-out failed' } : undefined), (ran) => ran.length > 0 && ran.at(-1) !== 'exit configuration-mode')
    const r = await runConfig(f.deps, c, ['set system host-name x'])
    expect(r.applied).toBe(false)
    expect(r.uncertain).toBeUndefined()
    expect(r.reason).toMatch(/not committed/)
  })
})

describe('H3 on the snippet / send-to-many path', () => {
  it('Junos: a snippet whose commit times out is "state unknown", not an error that reads as nothing changed', async () => {
    const audit = new AuditLog(openDb(':memory:'))
    let inConfig = false
    const tab = { tabId: 't', session: { id: 's', name: 'edge-r1', host: 'h', platform: 'junos' } }
    const term = {
      get: () => tab,
      prompt: async () => (inConfig ? { mode: 'config' as const, prompt: '[edit]\nadmin@edge-r1# ', hostname: 'edge-r1' } : { mode: 'exec' as const, prompt: 'admin@edge-r1> ', hostname: 'edge-r1' }),
      exec: async (_t: unknown, command: string) => {
        if (command === 'configure private') inConfig = true
        if (command === 'exit configuration-mode') inConfig = false
        if (command === 'commit and-quit') return { status: 'timeout' as const, output: '', durationMs: 5000, bytes: 0, error: 'timed out' }
        return { status: 'ok' as const, output: '', durationMs: 1, bytes: 1 }
      }
    }
    const runner = new GuardedRunner({ term: term as never, settings: { get: () => ({ commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) } as never, audit })
    const a = await runner.analyze('t', ['set system location building b9'])
    const r = await runner.run('t', a!.analysis, { source: 'snippet', approved: true, hostname: 'edge-r1' })
    expect(r).toMatchObject({ status: 'partial', reason: expect.stringContaining(STATE_UNKNOWN) })
  })
})

describe('M3 x M4: blocking configuration dumps never blocks a safety net', () => {
  const NAME = 'hopline-0a1b2c3d'
  it.each([
    ['iosxe', ['show running-config', 'show startup-config']],
    ['iosxe', ['sh run']],
    ['nxos', ['show running-config']],
    ['nxos', ['show checkpoint']],
    ['eos', ['show running-config', 'show startup-config']],
    ['eos', ['show session-config']],
    ['junos', ['show configuration']],
    ['junos', ['show system rollback']]
  ] as const)('%s with %j: every net line and read still passes the policy', (platform, patterns) => {
    const spec = SAFETY_NETS[platform]!
    const session = spec.session(NAME, 5)
    const lines = [
      ...spec.arm(NAME),
      ...(spec.learn ? [spec.learn.command] : []),
      ...(spec.check ? [spec.check.command] : []),
      ...spec.sessionNetLines(NAME, 5),
      ...session.enter,
      ...session.exit,
      ...session.abort,
      ...spec.confirm(NAME),
      ...spec.rollback(NAME, 'flash:archive-1'),
      ...(spec.cleanup?.(NAME) ?? [])
    ]
    for (const l of lines) expect(policyBlocked({ [platform]: [...patterns] }, platform, l), l).toBeNull()
  })
})
