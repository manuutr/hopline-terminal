import { describe, expect, it } from 'vitest'
import type { AgentEvent, Session, Settings } from '@shared/types'
import type { ExecResultMsg, PromptInfo } from '@shared/host-protocol'
import { Agent, PROPOSAL_CLOSED } from '../src/main/agent/agent'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { AgentTab, ExecKind, ExecOpts, TabControl } from '../src/main/host/client'
import type { LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'

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

/** A tab control without a device: records what would be sent, answers with a fixed prompt. */
function control(platform: Session['platform'], prompt: () => PromptInfo) {
  const session = { id: 's1', name: 'dev', host: '10.0.0.1', platform } as unknown as Session
  const tab: AgentTab = { tabId: 't1', session }
  const sent: { command: string; kind: ExecKind; opts: ExecOpts }[] = []
  const ctl: TabControl = {
    get: (id) => (id === 't1' ? tab : undefined),
    exec: async (_t, command, kind, opts): Promise<ExecResultMsg> => {
      sent.push({ command, kind, opts })
      return { status: 'ok', output: '', durationMs: 1, bytes: 0 }
    },
    mode: async () => prompt().mode,
    prompt: async () => prompt()
  }
  return { ctl, sent, session }
}

function run(script: Call[][], ctl: TabControl, prefs: Partial<Settings> = {}, onEvent?: (e: AgentEvent, agent: Agent) => void) {
  const provider = new Scripted(script)
  const audit = new AuditLog(openDb(':memory:'))
  const events: AgentEvent[] = []
  const settings = { get: () => ({ aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, ...prefs }) } as unknown as SettingsService
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

const at = (prompt: string, hostname: string, mode: PromptInfo['mode'] = 'exec'): PromptInfo => ({ mode, prompt, hostname })

describe('agent (review fixes)', () => {
  it('C1 pipe bypasses never reach the device, in read-only mode or not', async () => {
    for (const aiReadOnly of [true, false]) {
      const { ctl, sent } = control('eos', () => at('dist-eos1#', 'dist-eos1'))
      const cmds = ['show running-config | sort --o=/mnt/flash/startup-config', "show running-config | sort '-o' /mnt/flash/startup-config", 'show version | sort --compress=bash', 'show logging | head -n 100 /mnt/flash/startup-config']
      const r = run([cmds.map((command) => ({ name: 'run_show_command', input: { command, reason: 'x' } }))], ctl, { aiReadOnly })
      await r.done
      expect(sent).toEqual([])
      expect(r.provider.results[0]!.every((t) => /^BLOCKED/.test(t))).toBe(true)
    }
  })

  it('read-only mode: disruptive commands and Junos "configure private" via run_show_command send nothing', async () => {
    const ios = control('iosxe', () => at('core-sw1#', 'core-sw1'))
    const r = run([[{ name: 'run_show_command', input: { command: 'clear ip bgp *', reason: 'x' } }, { name: 'run_show_command', input: { command: 'reload', reason: 'x' } }]], ios.ctl, { aiReadOnly: true })
    await r.done
    expect(ios.sent).toEqual([])
    expect(r.provider.results[0]!.every((t) => /^(REFUSED|BLOCKED)/.test(t))).toBe(true)

    const j = control('junos', () => at('admin@mx1> ', 'mx1'))
    const r2 = run([[{ name: 'run_show_command', input: { command: 'configure private', reason: 'x' } }]], j.ctl, { aiReadOnly: false })
    await r2.done
    expect(j.sent).toEqual([])
    expect(r2.provider.results[0]![0]).toMatch(/^(REFUSED|BLOCKED)/)
  })

  it('at most 8 tool calls run per turn; the rest get an error result', async () => {
    const { ctl, sent } = control('iosxe', () => at('sw1#', 'sw1'))
    const r = run([Array.from({ length: 10 }, () => ({ name: 'run_show_command', input: { command: 'show version', reason: 'x' } }))], ctl)
    await r.done
    expect(sent).toHaveLength(8)
    expect(r.provider.results[0]).toHaveLength(10)
    expect(r.provider.results[0]!.slice(8).every((t) => /at most 8 tool calls/.test(t))).toBe(true)
  })

  it('a proposal closed by cancel emits proposal-closed, and deciding it afterwards is an error', async () => {
    const { ctl } = control('iosxe', () => at('sw1#', 'sw1'))
    let pid = ''
    const r = run([[{ name: 'propose_config_change', input: { commands: ['hostname x'], rationale: 'x', rollback: ['hostname sw1'], verify: [{ command: 'show version', expect: 'x' }] } }]], ctl, { aiReadOnly: false }, (e, agent) => {
      if (e.type === 'proposal') {
        pid = e.proposalId
        setTimeout(() => agent.cancel(e.runId), 5)
      }
    })
    await r.done
    expect(r.events.find((e) => e.type === 'proposal-closed')).toMatchObject({ proposalId: pid, reason: 'cancelled' })
    expect(() => r.agent.decide(pid, true)).toThrow(PROPOSAL_CLOSED)
  })

  it('an approval does not run when the prompt shows another device (nested ssh), and every line is bound to the hostname', async () => {
    let host = 'r1'
    const { ctl, sent } = control('ios', () => at(`${host}#`, host))
    const r = run([[{ name: 'propose_config_change', input: { commands: ['interface Gi0/1', 'description x'], rationale: 'x', rollback: ['interface Gi0/1', 'no description'], verify: [{ command: 'show interfaces description', expect: 'x' }] } }]], ctl, { aiReadOnly: false }, (e, agent) => {
      if (e.type === 'proposal') {
        host = 'OTHER-ROUTER'
        setTimeout(() => agent.decide(e.proposalId, true), 5)
      }
    })
    await r.done
    expect(sent).toEqual([])
    expect(r.provider.results[0]![0]).toMatch(/REFUSED: the device changed/)

    const ok = control('ios', () => at('r1(config)#', 'r1', 'config'))
    const prompts: PromptInfo[] = [at('r1#', 'r1'), at('r1#', 'r1')]
    const ctl2: TabControl = { ...ok.ctl, prompt: async () => prompts.shift() ?? at('r1(config)#', 'r1', 'config') }
    const r2 = run([[{ name: 'propose_config_change', input: { commands: ['hostname r2'], rationale: 'x', rollback: ['hostname r1'], verify: [{ command: 'show version', expect: 'r2' }] } }]], ctl2, { aiReadOnly: false }, (e, agent) => {
      if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true), 5)
    })
    await r2.done
    // IOS classic has no device net: the change, then the verify read.
    expect(ok.sent.map((s) => s.command)).toEqual(['configure terminal', 'hostname r2', 'end', 'show version'])
    // Every change line is bound to the hostname at proposal time, plus the one the proposal sets.
    const changeLines = ok.sent.filter((s) => s.kind !== 'read')
    expect(changeLines.every((s) => JSON.stringify(s.opts.hosts) === JSON.stringify(['r1', 'r2']))).toBe(true)
    expect(changeLines.some((s) => s.opts.net)).toBe(false)
  })

  it('each tool call uses the platform stored now, not the one the run started with', async () => {
    const { ctl, session } = control('ios', () => at('mx1>', 'mx1'))
    const r = run(
      [[{ name: 'run_show_command', input: { command: 'show system uptime', reason: 'x' } }], [{ name: 'run_show_command', input: { command: 'show system uptime', reason: 'x' } }]],
      ctl,
      {},
      (e) => {
        if (e.type === 'step' && e.status !== 'running') (session as { platform: string }).platform = 'junos'
      }
    )
    await r.done
    expect(r.provider.results[0]![0]).toMatch(/^REFUSED/)
    expect(r.provider.results[1]![0]).not.toMatch(/^(REFUSED|BLOCKED)/)
  })
})
