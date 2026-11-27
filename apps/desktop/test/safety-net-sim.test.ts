import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlatformId } from '@hopline/cli-model'
import { makeDevice, makeEosDevice, makeIosDevice, runtime, startSim, type Device, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEvent, AuditRow, Settings } from '@shared/types'
import { Agent } from '../src/main/agent/agent'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { TabControl } from '../src/main/host/client'
import type { ChatMessage, LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'
import { detectPrompt, execute } from '../src/session-host/executor'
import { bindingRefusal, hostRefusal, netRefusal, readOnlyRefusal } from '../src/session-host/guard-check'
import { fakeTab } from './helpers'

/**
 * Proposals v2 against the simulator, one platform safety net each (ARCHITECTURE §6.3): IOS-XE
 * archive + configure replace, NX-OS checkpoint, EOS configure session + commit timer, Junos
 * commit confirmed. The agent runs with a scripted model; every exec goes through the session
 * host's own checks (hostRefusal for the agent's lines, netRefusal for the app-owned net lines),
 * then the real executor, so a net line the host would refuse fails here too.
 */

type Call = { name: string; input: unknown }

class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted'
  results: string[][] = []
  constructor(private script: Call[][]) {}
  async turn(req: TurnRequest): Promise<TurnResult> {
    const last = req.messages.at(-1)
    const res = last?.role === "user" ? last.parts.filter((p) => p.type === "tool_result").map((p) => (p as { content: string }).content) : []
    if (res.length) this.results.push(res)
    const step = this.script.shift()
    if (!step) {
      req.onText('Done.')
      return { message: { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }, stop: 'end' }
    }
    return { message: { role: 'assistant', parts: step.map((c, i) => ({ type: 'tool_call' as const, id: `c${this.results.length}_${i}`, name: c.name, input: c.input })) }, stop: 'tool_use' } as TurnResult & { message: ChatMessage }
  }
}

/** A TabControl that applies the session host's checks before the real executor. */
function hostChecked(tab: Awaited<ReturnType<typeof fakeTab>>['tab'], platform: PlatformId, sent: { command: string; net: boolean }[]): TabControl {
  return {
    get: (id) => (id === tab.tabId ? tab : undefined),
    exec: async (_t, command, kind, opts) => {
      const ro = readOnlyRefusal(kind, false)
      const refusal = ro ?? (opts.net ? netRefusal(command, platform, kind, tab.tail, opts.hosts) : (bindingRefusal(kind, opts.hosts) ?? hostRefusal(command, platform, kind, tab.tail, opts.ack, opts.hosts)))
      if (refusal) return { status: 'error', output: '', durationMs: 0, bytes: 0, error: refusal }
      sent.push({ command, net: !!opts.net })
      return execute(tab, platform, command, { timeoutMs: 8000, capBytes: 512 * 1024, allowConfig: kind !== 'read' && opts.allowConfig })
    },
    mode: async () => detectPrompt(tab.tail, platform).mode,
    prompt: async () => {
      const p = detectPrompt(tab.tail, platform)
      return { mode: p.mode, prompt: p.prompt, hostname: p.hostname }
    }
  }
}

interface Case {
  platform: PlatformId
  device: () => Device
  name: string
  commands: string[]
  rollback: string[]
  verify: { command: string; expect: string }[]
  show: string
}

const CASES: Case[] = [
  {
    platform: 'iosxe',
    device: makeIosDevice,
    name: 'core-sw1',
    commands: ['interface Gi1/0/2', 'description hopline-net-test'],
    rollback: ['interface Gi1/0/2', 'no description'],
    verify: [{ command: 'show interfaces description', expect: 'Gi1/0/2 shows hopline-net-test' }],
    show: 'show running-config interface Gi1/0/2'
  },
  {
    platform: 'nxos',
    device: () => makeDevice('nxos'),
    name: 'leaf1',
    commands: ['interface Ethernet1/1', 'description hopline-net-test'],
    rollback: ['interface Ethernet1/1', 'no description'],
    verify: [{ command: 'show interface description', expect: 'Eth1/1 shows hopline-net-test' }],
    show: 'show running-config interface Ethernet1/1'
  },
  {
    platform: 'eos',
    device: makeEosDevice,
    name: 'dist-eos1',
    commands: ['interface Ethernet1', 'description hopline-net-test'],
    rollback: ['interface Ethernet1', 'no description'],
    verify: [{ command: 'show interfaces description', expect: 'Et1 shows hopline-net-test' }],
    show: 'show running-config interfaces Ethernet1'
  },
  {
    platform: 'junos',
    device: () => makeDevice('junos'),
    name: 'edge-r1',
    commands: ['set system location building hopline-net-test'],
    rollback: ['delete system location'],
    verify: [{ command: 'show configuration system', expect: 'location building hopline-net-test' }],
    show: 'show configuration system'
  }
]

const NET_KIND: Record<string, string> = { iosxe: 'archive', nxos: 'checkpoint', eos: 'session-timer', junos: 'commit-confirmed' }

for (const k of CASES) {
  describe(`safety net on ${k.platform} (simulator)`, { timeout: 60_000 }, () => {
    let sim: RunningSim
    beforeAll(async () => {
      sim = await startSim({ device: k.device(), port: 0 })
    })
    afterAll(() => sim.close())

    /** One proposal: approve, then `decide` on the applied change (confirm, rollback, or a device expiry first). */
    async function flow(decide: 'confirm' | 'rollback' | 'expire', extra: Record<string, unknown> = {}) {
      // Each flow writes its own token, so an earlier confirmed flow cannot make a rollback look applied.
      const token = `hopline-${decide.slice(0, 2)}-${Math.random().toString(36).slice(2, 7)}`
      const tag = (s: string) => s.replace('hopline-net-test', token)
      const { tab, client } = await fakeTab(sim.port, 1000, { platform: k.platform, name: k.name })
      for (let i = 0; i < 300 && detectPrompt(tab.tail, k.platform).mode === 'unknown'; i++) await new Promise((r) => setTimeout(r, 10))
      const db = openDb(':memory:')
      const audit = new AuditLog(db)
      const sent: { command: string; net: boolean }[] = []
      const verified = decide !== 'rollback'
      const provider = new ScriptedProvider([
        [{ name: 'propose_config_change', input: { commands: k.commands.map(tag), rationale: 'test', rollback: k.rollback, verify: k.verify.map((v) => ({ ...v, expect: tag(v.expect) })), ...extra } }],
        [{ name: 'report_verification', input: { verified, summary: verified ? 'the description shows' : 'the description is missing' } }]
      ])
      const events: AgentEvent[] = []
      const settings = { get: () => ({ aiReadOnly: false, commandTimeoutMs: 8000, outputCapBytes: 512 * 1024 }) as Partial<Settings> } as unknown as SettingsService
      let resolveDone!: () => void
      const done = new Promise<void>((r) => (resolveDone = r))
      const errors: string[] = []
      const agent: Agent = new Agent({
        term: hostChecked(tab, k.platform, sent),
        settings,
        audit,
        provider: async () => provider,
        emit: (e) => {
          events.push(e)
          if (e.type === 'proposal') setTimeout(() => agent.decide(e.proposalId, true), 10)
          if (e.type === 'change' && e.phase === 'awaiting' && e.judgement) {
            setTimeout(() => {
              if (decide === 'expire') {
                // The device's own timer runs out before anyone confirms.
                expect(runtime(sim.device).fire(k.platform === 'junos' ? 'junos-commit-confirm' : 'eos-commit-')).toBe(1)
              }
              agent.changeAction(e.proposalId, decide === 'rollback' ? 'rollback' : 'confirm').catch((x: Error) => errors.push(x.message))
            }, 10)
          }
          if (e.type === 'done') resolveDone()
        }
      })
      agent.start({ tabId: 'tab-1', prompt: 'describe the port' })
      await done
      const shown = await execute(tab, k.platform, k.show, { timeoutMs: 8000, capBytes: 512 * 1024 })
      client.end()
      const rows = audit.list().reverse()
      return { provider, events, sent, rows, shown: shown.output, errors, live: shown.output.includes(token), commands: k.commands.map(tag) }
    }

    const last = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'change' }> => e.type === 'change').at(-1)!
    const netRows = (rows: AuditRow[]) => rows.filter((r) => r.source === 'safety-net')

    it('approve, verify passes, confirm: the change is kept and every step is audited', async () => {
      const r = await flow('confirm')
      expect(r.errors).toEqual([])
      const card = r.events.find((e) => e.type === 'proposal')!
      expect(card).toMatchObject({ net: { kind: NET_KIND[k.platform] }, rollback: k.rollback, verify: k.verify.map((v) => ({ command: v.command, expect: expect.any(String) })) })
      expect(r.provider.results[0]![0]).toMatch(/^APPLIED \(approved by /)
      expect(r.provider.results[0]![0]).toMatch(/Verification output/)
      expect(r.provider.results[1]![0]).toMatch(/CONFIRMED/)
      expect(last(r.events)).toMatchObject({ phase: 'confirmed' })
      expect(r.live).toBe(true)
      // Net lines were sent as net verdicts and accepted by the host checks; the agent's lines were not.
      expect(r.sent.filter((s) => s.net).length).toBeGreaterThan(0)
      for (const c of r.commands) expect(r.sent.find((s) => s.command === c)?.net).toBe(false)
      expect(r.rows.filter((x) => x.decision === 'error' || x.decision === 'refused')).toEqual([])
      expect(r.rows.some((x) => x.decision === 'verified' && x.command === 'report_verification')).toBe(true)
      expect(r.rows.at(-1)).toMatchObject({ source: 'safety-net', decision: 'confirmed' })
      expect(netRows(r.rows).length).toBeGreaterThan(0)
      if (k.platform === 'junos') expect(runtime(sim.device).pending('junos-commit-confirm')).toBe(false)
      if (k.platform === 'eos') expect(Object.keys((sim.device.vendor as { eos: { sessions: object } }).eos.sessions).some((n) => runtime(sim.device).pending(`eos-commit-${n}`))).toBe(false)
      if (k.platform === 'nxos') expect((sim.device.vendor as { nxos?: { checkpoints: { name: string }[] } }).nxos?.checkpoints.some((c) => c.name.startsWith('hopline-')) ?? false).toBe(false)
    })

    it('verify fails, the user rolls back: the device is back to its previous configuration', async () => {
      const r = await flow('rollback')
      expect(r.errors).toEqual([])
      expect(r.provider.results[1]![0]).toMatch(/ROLLED BACK/)
      expect(last(r.events)).toMatchObject({ phase: 'rolled-back', judgement: { verified: false } })
      expect(r.live).toBe(false)
      expect(r.rows.some((x) => x.decision === 'not-verified')).toBe(true)
      expect(r.rows.at(-1)).toMatchObject({ source: 'safety-net', decision: 'rolled-back' })
      // The rollback is app-owned: the deny-listed commands ran only as net lines.
      const rb = r.sent.filter((s) => /configure replace|rollback|configure session .* abort/.test(s.command))
      expect(rb.length).toBeGreaterThan(0)
      expect(rb.filter((s) => !s.net)).toEqual([])
    })

    if (k.platform === 'junos' || k.platform === 'eos')
      it('the device timer expires before a confirm: Hopline detects the device rolled back and reports it', async () => {
        const r = await flow('expire')
        expect(r.provider.results[1]![0]).toMatch(/rolled the change back by itself/)
        expect(last(r.events)).toMatchObject({ phase: 'expired' })
        expect(r.live).toBe(false)
        expect(r.rows.at(-1)).toMatchObject({ source: 'safety-net', decision: 'expired', approver: null })
        // Nothing was confirmed after the expiry.
        const confirmLines = k.platform === 'junos' ? ['commit and-quit'] : [/configure session hopline-[0-9a-f]{8} commit$/]
        const after = r.sent.slice(r.sent.findIndex((s) => /show system commit|show configuration sessions/.test(s.command) && s !== r.sent[0]))
        for (const c of confirmLines) expect(after.some((s) => (typeof c === 'string' ? s.command === c : c.test(s.command)))).toBe(false)
      })
  })
}
