import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEvent, Settings } from '@shared/types'
import { Agent } from '../src/main/agent/agent'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { ChatMessage, LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'
import { fakeTab, localControl } from './helpers'

type Call = { name: string; input: unknown }
type Step = Call[] | 'throw' | 'max_tokens_with_tool'

/** A provider that plays back a fixed script of tool calls, then a final answer. */
class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted'
  seen: ChatMessage[][] = []
  constructor(private script: Step[]) {}
  async turn(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(structuredClone(req.messages))
    const step = this.script.shift()
    if (step === 'throw') throw new Error('network down')
    if (step === 'max_tokens_with_tool')
      return { message: { role: 'assistant', parts: [{ type: 'tool_call', id: 'cut', name: 'run_show_command', input: {} }] }, stop: 'max_tokens' }
    if (!step) {
      req.onText('Done.')
      return { message: { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }, stop: 'end' }
    }
    const parts = step.map((c, i) => ({ type: 'tool_call' as const, id: `call_${this.seen.length}_${i}`, name: c.name, input: c.input }))
    return { message: { role: 'assistant', parts }, stop: 'tool_use' }
  }
  /** The tool_result text the agent sent back after turn n (1-based). */
  resultAfter(n: number, idx = 0): string {
    const last = this.seen[n]!.at(-1)!
    const p = last.parts[idx]!
    return p.type === 'tool_result' ? p.content : ''
  }
}

/** Proposals v2: every proposal carries a rollback plan and verify commands. */
const RB = ['interface Gi1/0/2', 'shutdown']
const VF = [{ command: 'show interfaces status', expect: 'Gi1/0/2 connected' }]

let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
afterAll(() => sim.close())

async function setup(script: Step[], prefs: Partial<Settings> = {}, onProposal?: (agent: Agent, id: string) => void) {
  const { tab, client } = await fakeTab(sim.port)
  const db = openDb(':memory:')
  const audit = new AuditLog(db)
  const provider = new ScriptedProvider(script)
  const events: AgentEvent[] = []
  const settings = { get: () => ({ aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, ...prefs }) } as unknown as SettingsService
  let agent!: Agent
  const done = new Promise<AgentEvent>((resolve) => {
    agent = new Agent({
      term: localControl(tab),
      settings,
      audit,
      provider: async () => provider,
      emit: (e) => {
        events.push(e)
        if (e.type === 'proposal') setTimeout(() => onProposal?.(agent, e.proposalId), 20)
        if (e.type === 'done') resolve(e)
      }
    })
  })
  const next = () =>
    new Promise<AgentEvent>((resolve) => {
      const orig = agent['d'].emit
      agent['d'].emit = (e) => {
        orig(e)
        if (e.type === 'done') {
          agent['d'].emit = orig
          resolve(e)
        }
      }
    })
  return { agent, audit, provider, events, done, client, next }
}

describe('agent loop (scripted model, real simulator)', () => {
  it('runs read-only commands, blocks dangerous ones, redacts secrets, and audits everything', async () => {
    const { agent, audit, provider, events, done, client } = await setup([
      [{ name: 'run_show_command', input: { command: 'show ip bgp summary', reason: 'check peers' } }],
      [{ name: 'run_show_command', input: { command: 'reload', reason: 'try harder' } }],
      [{ name: 'run_show_command', input: { command: 'conf t', reason: 'sneaky' } }],
      [{ name: 'run_show_command', input: { command: 'show running-config', reason: 'secrets' } }]
    ])
    agent.start({ tabId: 'tab-1', prompt: 'Why is BGP to 10.0.0.2 down?' })
    const end = await done
    expect(end).toEqual({ type: 'done', runId: expect.any(String), tabId: 'tab-1' })

    expect(provider.resultAfter(1)).toMatch(/10\.0\.0\.2\s+4\s+65002/)
    expect(provider.resultAfter(2)).toMatch(/^BLOCKED: "reload" is on the deny-list/)
    expect(provider.resultAfter(3)).toMatch(/^REFUSED: .*propose_config_change/)
    const secrets = provider.resultAfter(4)
    expect(secrets).toMatch(/snmp-server community <redacted> RO/)
    expect(secrets).toMatch(/enable secret 9 <redacted>/)
    expect(secrets).toMatch(/key 7 <redacted>/)
    expect(secrets).not.toMatch(/n3tw0rkRO|pr1vRW|\$9\$|104D000A0618|13061E010803/)

    const rows = audit.list().reverse()
    expect(rows.map((r) => [r.command, r.decision])).toEqual([
      ['show ip bgp summary', 'executed'],
      ['reload', 'blocked'],
      ['conf t', 'refused'],
      ['show running-config', 'executed']
    ])
    expect(rows[3]!.redactions).toBeGreaterThan(0)
    expect(events.filter((e) => e.type === 'step' && e.status === 'blocked')).toHaveLength(1)
    client.end()
  })

  it('adds TextFSM rows (parsed from the redacted output) to a read with a template, not to a filtered one', async () => {
    const { agent, provider, done, client } = await setup([
      [{ name: 'run_show_command', input: { command: 'sh ip int br', reason: 'interfaces' } }],
      [{ name: 'run_show_command', input: { command: 'show ip interface brief', reason: 'filtered', filter: { grep: 'Vlan' } } }]
    ])
    agent.start({ tabId: 'tab-1', prompt: 'Which interfaces are down?' })
    await done
    const first = provider.resultAfter(1)
    expect(first).toMatch(/Vlan10/)
    expect(first).toMatch(/\[Hopline parsed this output with TextFSM template cisco_ios_show_ip_interface_brief\.textfsm: \d+ rows; tab-separated, same untrusted device data\]\n<device_output id="[0-9a-f]{12}" device="device-\d+-[a-f0-9]+" command="[^"]+" parsed="textfsm" untrusted="true">\nINTERFACE\tIP_ADDRESS\tSTATUS\tPROTO\nVlan1\tunassigned\tadministratively down\tdown/)
    expect(provider.resultAfter(2)).not.toMatch(/Hopline parsed/)
    client.end()
  })

  it('refuses config proposals in read-only mode', async () => {
    const { agent, audit, provider, done, client } = await setup([
      [{ name: 'propose_config_change', input: { commands: ['interface Gi1/0/2', 'no shutdown'], rationale: 'bring uplink up', rollback: RB, verify: VF } }]
    ])
    agent.start({ tabId: 'tab-1', prompt: 'fix it' })
    await done
    expect(provider.resultAfter(1)).toMatch(/^REFUSED: the assistant is in read-only mode/)
    expect(audit.list().every((r) => r.decision === 'refused')).toBe(true)
    client.end()
  })

  it('blocks a proposal containing a deny-listed line even when proposals are allowed', async () => {
    const { agent, provider, done, client } = await setup(
      [[{ name: 'propose_config_change', input: { commands: ['interface Gi1/0/2', 'do write erase'], rationale: 'x', rollback: RB, verify: VF } }]],
      { aiReadOnly: false }
    )
    agent.start({ tabId: 'tab-1', prompt: 'fix it' })
    await done
    expect(provider.resultAfter(1)).toMatch(/^BLOCKED: "do write erase"/)
    client.end()
  })

  it('read-only mode refuses disruptive commands and changes outright', async () => {
    const { agent, audit, provider, events, done, client } = await setup([
      [{ name: 'run_show_command', input: { command: 'clear ip bgp *', reason: 'reset peers' } }],
      [{ name: 'propose_config_change', input: { commands: ['interface Gi1/0/2', 'switchport trunk allowed vlan 10'], rationale: 'trim trunk', rollback: RB, verify: VF } }]
    ])
    agent.start({ tabId: 'tab-1', prompt: 'fix it' })
    await done
    expect(provider.resultAfter(1)).toMatch(/^REFUSED: .*not run in read-only mode/)
    expect(provider.resultAfter(2)).toMatch(/^REFUSED: the assistant is in read-only mode/)
    expect(events.some((e) => e.type === 'proposal')).toBe(false)
    expect(audit.list().map((r) => r.decision)).not.toContain('executed')
    expect(audit.list().some((r) => r.kind === 'disruptive')).toBe(true)
    client.end()
  })

  it('a disruptive command becomes a proposal approved only by typing the device hostname', async () => {
    const tries: string[] = []
    const { agent, audit, provider, events, done, client } = await setup(
      [[{ name: 'run_show_command', input: { command: 'clear ip bgp *', reason: 'reset peers' } }]],
      { aiReadOnly: false },
      (a, id) => {
        // A wrong (or missing) hostname is refused in main and the proposal stays open.
        for (const ack of [undefined, 'core-sw2', ''])
          try {
            a.decide(id, true, 'user', ack)
          } catch (e) {
            tries.push((e as Error).message)
          }
        a.decide(id, true, 'user', ' CORE-SW1 ')
      }
    )
    agent.start({ tabId: 'tab-1', prompt: 'reset bgp' })
    await done
    const card = events.find((e) => e.type === 'proposal')
    expect(card).toMatchObject({ commands: ['clear ip bgp *'], exec: true, disruptive: { confirm: 'core-sw1', reasons: [expect.stringMatching(/^"clear ip bgp \*": /)] } })
    expect(tries).toHaveLength(3)
    expect(tries[0]).toMatch(/Type the device hostname "core-sw1"/)
    expect(provider.resultAfter(1)).not.toMatch(/^(REFUSED|BLOCKED)/)
    const row = audit.list()[0]!
    expect(row).toMatchObject({ command: 'clear ip bgp *', kind: 'disruptive', decision: 'executed' })
    expect(row.approver).toBeTruthy()
    client.end()
  })

  it('turning read-only on while a card waits wins over the approval', async () => {
    for (const call of [
      { name: 'run_show_command', input: { command: 'clear ip bgp *', reason: 'reset' } },
      { name: 'propose_config_change', input: { commands: ['interface Gi1/0/2', 'no shutdown'], rationale: 'x', rollback: RB, verify: VF } }
    ]) {
      const prefs = { aiReadOnly: false }
      const { agent, audit, provider, done, client } = await setup([[call]], prefs, (a, id) => {
        prefs.aiReadOnly = true
        a.decide(id, true, 'user', 'core-sw1')
      })
      agent['d'].settings = { get: () => ({ commandTimeoutMs: 5000, outputCapBytes: 512 * 1024, ...prefs }) } as never
      agent.start({ tabId: 'tab-1', prompt: 'x' })
      await done
      expect(provider.resultAfter(1)).toMatch(/^REFUSED: .*read-only mode was turned on/)
      expect(audit.list().map((r) => r.decision)).not.toContain('executed')
      client.end()
    }
    expect(sim.device.interfaces.find((i) => i.short === 'Gi1/0/2')!.adminUp).toBe(false)
  })

  it('a change with a disruptive line runs only with the typed hostname; rejecting it changes nothing', async () => {
    const lines = ['interface Gi1/0/2', 'switchport trunk allowed vlan 10']
    const rejected = await setup([[{ name: 'propose_config_change', input: { commands: lines, rationale: 'trim trunk', rollback: RB, verify: VF } }]], { aiReadOnly: false }, (a, id) => a.decide(id, false))
    rejected.agent.start({ tabId: 'tab-1', prompt: 'trim' })
    await rejected.done
    expect(rejected.events.find((e) => e.type === 'proposal')).toMatchObject({ disruptive: { confirm: 'core-sw1' } })
    expect(rejected.audit.list().map((r) => [r.kind, r.decision])).toEqual([
      ['disruptive', 'rejected'],
      ['config', 'rejected']
    ])
    rejected.client.end()

    const { agent, audit, provider, done, client } = await setup([[{ name: 'propose_config_change', input: { commands: lines, rationale: 'trim trunk', rollback: RB, verify: VF } }]], { aiReadOnly: false }, (a, id) => a.decide(id, true, 'user', 'core-sw1'))
    agent.start({ tabId: 'tab-1', prompt: 'trim' })
    await done
    expect(provider.resultAfter(1)).toMatch(/^APPLIED/)
    const rows = audit.list().reverse()
    // IOS-XE: the archive net is armed first (app-owned, source safety-net), then the change, then the verify read.
    expect(rows.map((r) => [r.source, r.command, r.kind, r.decision])).toEqual([
      ['safety-net', 'show archive', 'read', 'executed'],
      ['safety-net', 'archive config', 'config', 'executed'],
      ['safety-net', 'show archive', 'read', 'executed'],
      ['agent', 'configure terminal', 'config', 'executed'],
      ['agent', 'interface Gi1/0/2', 'config', 'executed'],
      ['agent', 'switchport trunk allowed vlan 10', 'disruptive', 'executed'],
      ['agent', 'end', 'config', 'executed'],
      ['agent', 'show interfaces status', 'read', 'executed']
    ])
    client.end()
  })

  it('an unrecognised show command is refused with advice that is not propose_config_change', async () => {
    const { agent, provider, done, client } = await setup([[{ name: 'run_show_command', input: { command: 'show frobnicate everything', reason: 'x' } }]])
    agent.start({ tabId: 'tab-1', prompt: 'look' })
    await done
    expect(provider.resultAfter(1)).toMatch(/^REFUSED: .*recognises as read-only/)
    expect(provider.resultAfter(1)).not.toMatch(/propose_config_change/)
    client.end()
  })

  it('rejected proposals change nothing', async () => {
    const { agent, audit, provider, done, client } = await setup(
      [[{ name: 'propose_config_change', input: { commands: ['interface Gi1/0/2', 'no shutdown'], rationale: 'bring uplink up', rollback: RB, verify: VF } }]],
      { aiReadOnly: false },
      (a, id) => a.decide(id, false)
    )
    agent.start({ tabId: 'tab-1', prompt: 'fix it' })
    await done
    expect(provider.resultAfter(1)).toMatch(/REJECTED/)
    expect(sim.device.interfaces.find((i) => i.short === 'Gi1/0/2')!.adminUp).toBe(false)
    expect(audit.list().map((r) => r.decision)).toEqual(['rejected', 'rejected'])
    client.end()
  })

  it('approved proposals run exactly the stored lines and are audited with the approver', async () => {
    const { agent, audit, provider, done, client } = await setup(
      [[{ name: 'propose_config_change', input: { commands: ['interface Gi1/0/2', 'no shutdown'], rationale: 'bring uplink up', rollback: RB, verify: VF } }]],
      { aiReadOnly: false },
      (a, id) => a.decide(id, true)
    )
    agent.start({ tabId: 'tab-1', prompt: 'fix it' })
    await done
    expect(provider.resultAfter(1)).toMatch(/^APPLIED \(approved by /)
    expect(sim.device.interfaces.find((i) => i.short === 'Gi1/0/2')!.adminUp).toBe(true)
    const rows = audit.list().reverse()
    expect(rows.map((r) => r.command)).toEqual(['show archive', 'archive config', 'show archive', 'configure terminal', 'interface Gi1/0/2', 'no shutdown', 'end', 'show interfaces status'])
    expect(rows.every((r) => r.decision === 'executed')).toBe(true)
    // Every change line carries the approver; the reads do not need one.
    expect(rows.filter((r) => r.kind !== 'read').every((r) => r.approver)).toBe(true)
    // The model gets the verify output and is told to report its judgement; it cannot confirm.
    expect(provider.resultAfter(1)).toMatch(/Verification output \(untrusted device data\):\n### show interfaces status\nExpected: Gi1\/0\/2 connected/)
    expect(provider.resultAfter(1)).toMatch(/call report_verification/)
    // Device text reaches the model only inside the untrusted frame: verify output and net-line output.
    expect(provider.resultAfter(1)).toMatch(/Expected: Gi1\/0\/2 connected\n<device_output id="[0-9a-f]{12}" device="[^"]+" command="show interfaces status" untrusted="true">/)
    expect(provider.resultAfter(1)).toMatch(/<device_output id="[0-9a-f]{12}" device="[^"]+" command="archive config" untrusted="true">/)
    expect(provider.resultAfter(1)).toMatch(/Safety net: archive\./)
    client.end()
  })

  it('tags every event with its tab', async () => {
    const { agent, events, done, client } = await setup([[{ name: 'run_show_command', input: { command: 'show clock', reason: 'x' } }]])
    agent.start({ tabId: 'tab-1', prompt: 'time?' })
    await done
    expect(events.length).toBeGreaterThan(2)
    expect(events.every((e) => e.tabId === 'tab-1')).toBe(true)
    client.end()
  })

  it('a cancelled proposal is audited as cancelled, with no approver', async () => {
    let runId = ''
    const { agent, audit, done, client } = await setup(
      [[{ name: 'propose_config_change', input: { commands: ['interface Gi1/0/3', 'shutdown'], rationale: 'x', rollback: RB, verify: VF } }]],
      { aiReadOnly: false },
      (a) => a.cancel(runId)
    )
    runId = agent.start({ tabId: 'tab-1', prompt: 'fix it' }).runId
    await done
    const rows = audit.list()
    expect(rows.map((r) => [r.decision, r.reason, r.approver])).toEqual([
      ['rejected', 'run cancelled before approval', null],
      ['rejected', 'run cancelled before approval', null]
    ])
    expect(sim.device.interfaces.find((i) => i.short === 'Gi1/0/3')!.adminUp).toBe(true)
    client.end()
  })

  const valid = (msgs: ChatMessage[]) => {
    for (let i = 0; i < msgs.length; i++) {
      if (i > 0) expect(msgs[i]!.role).not.toBe(msgs[i - 1]!.role)
      const calls = msgs[i]!.parts.filter((p) => p.type === 'tool_call').map((p) => (p as { id: string }).id)
      if (calls.length) {
        const res = (msgs[i + 1]?.parts ?? []).filter((p) => p.type === 'tool_result').map((p) => (p as { id: string }).id)
        expect(res).toEqual(calls)
      }
    }
    expect(msgs[0]!.role).toBe('user')
  }

  it('F5b: the device gets the plain command; Hopline filters the redacted output before the model sees it', async () => {
    const { agent, audit, provider, events, done, client } = await setup([
      [{ name: 'run_show_command', input: { command: 'show logging', reason: 'recent logs', filter: { tail: 2 } } }],
      [{ name: 'run_show_command', input: { command: 'show running-config', reason: 'community', filter: { grep: 'community|secret', ignoreCase: true } } }],
      [{ name: 'run_show_command', input: { command: 'show running-config', reason: 'probe', filter: { grep: 'n3tw0rk', count: true } } }],
      [{ name: 'run_show_command', input: { command: 'show clock', reason: 'bad', filter: { tail: -1 } } }],
      [{ name: 'run_show_command', input: { command: 'reload', reason: 'nope', filter: { tail: 1 } } }]
    ])
    agent.start({ tabId: 'tab-1', prompt: 'logs?' })
    await done
    const tail = provider.resultAfter(1)
    expect(tail).toMatch(/^\[Hopline filter last 2 lines: showing last 2 of \d+ lines\]\n<device_output id="[0-9a-f]{12}" device="device-\d+-[a-f0-9]+" command="show logging" untrusted="true">\n/)
    // The note, the frame's open and close, and the two lines.
    expect(tail.split('\n')).toHaveLength(5)
    expect(tail).toMatch(/\n<\/device_output id="[0-9a-f]{12}">$/)
    const grep = provider.resultAfter(2)
    expect(grep).toMatch(/snmp-server community <redacted> RO/)
    expect(grep).not.toMatch(/n3tw0rkRO|hostname/)
    // Redaction runs before the filter: grep cannot be used as an oracle for a secret.
    expect(provider.resultAfter(3)).toMatch(/\n0\n<\/device_output id="[0-9a-f]{12}">$/)
    expect(provider.resultAfter(4)).toMatch(/^REFUSED: invalid filter: tail/)
    expect(provider.resultAfter(5)).toMatch(/^BLOCKED/)

    const rows = audit.list().reverse()
    expect(rows.map((r) => [r.command, r.decision])).toEqual([
      ['show logging', 'executed'],
      ['show running-config', 'executed'],
      ['show running-config', 'executed'],
      ['show clock', 'refused'],
      ['reload', 'blocked']
    ])
    expect(rows[0]!.reason).toBe('read-only; local filter: last 2 lines')
    const steps = events.filter((e) => e.type === 'step' && e.command === 'show logging')
    expect(steps.map((e) => (e as { filter?: string }).filter)).toEqual(['last 2 lines', 'last 2 lines'])
    expect((steps.at(-1) as { filterNote?: string }).filterNote).toMatch(/^showing last 2 of/)
    client.end()
  })

  it('guard refusals that suggest local filtering name the filter parameter', async () => {
    const { agent, provider, done, client } = await setup([[{ name: 'run_show_command', input: { command: 'show logging | tail 30', reason: 'x' } }]])
    agent.start({ tabId: 'tab-1', prompt: 'logs' })
    await done
    expect(provider.resultAfter(1)).toMatch(/filter the output locally.*"filter" parameter/)
    client.end()
  })

  it('keeps history valid after an API error mid-run', async () => {
    const { agent, provider, done, next, client } = await setup([[{ name: 'run_show_command', input: { command: 'show clock', reason: 'x' } }], 'throw'])
    agent.start({ tabId: 'tab-1', prompt: 'first' })
    expect((await done).type === 'done' && (await done as { error?: string }).error).toBe('network down')
    await new Promise((r) => setTimeout(r, 0)) // let the finished run release the tab, as an IPC round-trip would
    const second = next()
    agent.start({ tabId: 'tab-1', prompt: 'second' })
    await second
    valid(provider.seen.at(-1)!)
    client.end()
  })

  it('drops a tool call cut off by max_tokens so the next question still works', async () => {
    const { agent, provider, done, next, client } = await setup(['max_tokens_with_tool'])
    agent.start({ tabId: 'tab-1', prompt: 'first' })
    expect(((await done) as { error?: string }).error).toMatch(/cut off/)
    await new Promise((r) => setTimeout(r, 0)) // let the finished run release the tab, as an IPC round-trip would
    const second = next()
    agent.start({ tabId: 'tab-1', prompt: 'second' })
    await second
    const msgs = provider.seen.at(-1)!
    valid(msgs)
    expect(msgs.at(-1)!.parts).toEqual([{ type: 'text', text: 'second' }])
    client.end()
  })
})
