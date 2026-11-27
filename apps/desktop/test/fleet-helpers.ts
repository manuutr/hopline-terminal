import type { Session, SessionPlatform, Settings } from '@shared/types'
import { makeDevice, startSim, type Device, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentTab, ExecOpts, TabControl } from '../src/main/host/client'
import type { BackgroundHost } from '../src/main/fleet/pool'
import type { ChatMessage, LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import { hostRefusal } from '../src/session-host/guard-check'
import { fakeTab, localControl } from './helpers'

/**
 * Fleet test bed: simulator devices behind a fake session host that opens real SSH background
 * tabs (the executor runs in-process, as in the other agent tests), and a scripted LLM routed by
 * role (coordinator, or the worker for a named device), never by request order: lanes run in parallel.
 */

export interface SimDevice {
  name: string
  platform: SessionPlatform
  /** Simulator platform (defaults from `platform`). */
  sim?: Parameters<typeof makeDevice>[0]
  prep?: (d: Device) => void
  /** A device built elsewhere (the topology lab, an eval case); `sim` and the factory are skipped. */
  device?: Device
}

const SIM: Partial<Record<SessionPlatform, Parameters<typeof makeDevice>[0]>> = { iosxe: 'ios', ios: 'ios', eos: 'eos', nxos: 'nxos', junos: 'junos', iosxr: 'iosxr', panos: 'panos' }

export function session(name: string, platform: SessionPlatform, port: number, extra: Partial<Session> = {}): Session {
  return {
    id: `sess-${name}`,
    name,
    host: '127.0.0.1',
    port,
    protocol: 'ssh',
    platform,
    username: 'admin',
    credentialId: 'cred-1',
    folderId: null,
    logToFile: false,
    notes: '',
    options: {},
    tags: [],
    color: null,
    favorite: false,
    lastConnectedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra
  } as Session
}

export interface SimHost extends BackgroundHost, TabControl {
  sessions: Session[]
  sims: RunningSim[]
  /** Every command sent through exec, by device name. */
  sent: { device: string; command: string; kind: string }[]
  /** Raw keystrokes written to each device (Ctrl-C shows up here). */
  keys: Map<string, string[]>
  /** Commands the session-host re-check refused (they never reached the device). */
  hostRefused: { device: string; command: string; reason: string }[]
  opened: string[]
  closed: string[]
  close(tabId: string): void
  stop(): Promise<void>
}

export async function simHost(devices: SimDevice[], opts: { connectDelayMs?: number } = {}): Promise<SimHost> {
  const sims: RunningSim[] = []
  const sessions: Session[] = []
  for (const d of devices) {
    const dev = d.device ?? makeDevice(d.sim ?? SIM[d.platform] ?? 'ios')
    d.prep?.(dev)
    const sim = await startSim({ device: dev, port: 0 })
    sims.push(sim)
    sessions.push(session(d.name, d.platform, sim.port))
  }
  const tabs = new Map<string, { tab: AgentTab; control: TabControl; end: () => void; name: string; tail: () => string }>()
  let seq = 0
  const host: SimHost = {
    sessions,
    sims,
    sent: [],
    keys: new Map(),
    hostRefused: [],
    opened: [],
    closed: [],
    async openBackground(sessionId: string, signal?: AbortSignal) {
      const s = sessions.find((x) => x.id === sessionId)
      if (!s) throw new Error('unknown session')
      if (opts.connectDelayMs) await new Promise((r) => setTimeout(r, opts.connectDelayMs))
      if (signal?.aborted) throw new Error('stopped')
      const t = await fakeTab(s.port, 50, s)
      const tabId = `bg-${++seq}`
      t.raw.tabId = tabId
      const keys: string[] = []
      host.keys.set(s.name, keys)
      const send = t.raw.send
      t.raw.send = (d: string) => (keys.push(d), send(d))
      tabs.set(tabId, { tab: t.tab, control: localControl(t.tab), end: () => t.client.end(), name: s.name, tail: () => t.tab.tail })
      host.opened.push(s.name)
      return { tabId, session: s }
    },
    close(tabId: string) {
      const t = tabs.get(tabId)
      if (!t) return
      tabs.delete(tabId)
      host.closed.push(t.name)
      t.end()
    },
    get(tabId: string) {
      const t = tabs.get(tabId)
      return t && { tabId, session: t.tab.session }
    },
    exec(tab: AgentTab, command: string, kind, o: ExecOpts) {
      const t = tabs.get(tab.tabId)
      if (!t) return Promise.resolve({ status: 'error' as const, output: '', durationMs: 0, bytes: 0, error: 'tab closed' })
      // The session host's second enforcement point, as in session-host/index.ts: re-classify in the prompt's mode.
      const refusal = hostRefusal(command, t.tab.session.platform, kind as 'read' | 'config' | 'disruptive', t.tail(), o.ack, o.hosts)
      if (refusal) {
        host.hostRefused.push({ device: t.name, command, reason: refusal })
        return Promise.reject(new Error(refusal))
      }
      host.sent.push({ device: t.name, command, kind })
      return t.control.exec(t.tab, command, kind, o)
    },
    mode: (tab) => tabs.get(tab.tabId)!.control.mode(tab),
    prompt: (tab) => tabs.get(tab.tabId)!.control.prompt(tab),
    async stop() {
      for (const id of [...tabs.keys()]) host.close(id)
      await Promise.all(sims.map((s) => s.close()))
    }
  }
  return host
}

export const testSettings = (over: Partial<Settings> = {}) => ({ get: () => ({ aiReadOnly: true, aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', aiConfigured: true, commandTimeoutMs: 8000, outputCapBytes: 512 * 1024, ...over }) as Settings })

// ------------------------------------------------------------------ scripted, routed LLM

export type Call = { name: string; input: unknown }
/** A scripted turn: tool calls, a text answer, a turn that waits until cancelled, or a computed turn. */
export type Turn = { calls: Call[] } | { text: string } | 'hang' | 'throw' | ((req: TurnRequest) => Turn)

export interface SeenRequest {
  role: string
  system: string
  messages: ChatMessage[]
}

/** The last tool results the model received in this request. */
export function lastResults(req: { messages: ChatMessage[] }): string[] {
  const last = req.messages.at(-1)
  return (last?.parts ?? []).flatMap((p) => (p.type === 'tool_result' ? [p.content] : []))
}

export function roleOf(system: string): string {
  if (/fleet coordinator/.test(system)) return 'coordinator'
  const m = /Your device: (.+?) \(/.exec(system)
  return m ? m[1]! : 'unknown'
}

export class RoutedLlm implements LlmProvider {
  readonly id: string
  seen: SeenRequest[] = []
  constructor(
    private readonly scripts: Record<string, Turn[]>,
    o: { id?: string; usage?: (role: string) => { inputTokens: number; outputTokens: number } | undefined; delayMs?: number } = {}
  ) {
    this.id = o.id ?? 'scripted'
    this.usage = o.usage
    this.delayMs = o.delayMs ?? 0
  }
  private readonly delayMs: number
  private readonly usage?: (role: string) => { inputTokens: number; outputTokens: number } | undefined

  async turn(req: TurnRequest): Promise<TurnResult> {
    const role = req.meta?.lane?.trim() ?? roleOf(req.system)
    this.seen.push({ role, system: req.system, messages: structuredClone(req.messages) })
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    let step: Turn | undefined = this.scripts[role]?.shift()
    while (typeof step === 'function') step = step(req)
    const usage = this.usage?.(role)
    const u = usage ? { usage } : {}
    if (step === 'throw') throw new Error('model down')
    if (step === 'hang') {
      await new Promise<void>((_, reject) => {
        if (req.signal.aborted) return reject(new Error('Cancelled.'))
        req.signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true })
      })
    }
    if (!step || 'text' in (step as object)) {
      const text = step && typeof step === 'object' && 'text' in step ? step.text : 'Done.'
      req.onText(text)
      return { message: { role: 'assistant', parts: [{ type: 'text', text }] }, stop: 'end', ...u }
    }
    const calls = (step as { calls: Call[] }).calls
    return { message: { role: 'assistant', parts: calls.map((c, i) => ({ type: 'tool_call' as const, id: `${role}_${this.seen.length}_${i}`, name: c.name, input: c.input })) }, stop: 'tool_use', ...u }
  }

  requests(role: string): SeenRequest[] {
    return this.seen.filter((s) => s.role === role)
  }
}

export const show = (command: string, filter?: unknown): Call => ({ name: 'run_show_command', input: { command, reason: 'test', ...(filter ? { filter } : {}) } })
export const report = (r: { status?: string; findings?: string[]; evidence?: { command: string; lines: string[] }[]; confidence?: string; recommendations?: string[] }): Call => ({
  name: 'submit_report',
  input: { status: 'found', findings: [], evidence: [], confidence: 'medium', ...r }
})
export const dispatch = (tasks: { device: string; task: string; suggested?: string[] }[]): Call => ({ name: 'dispatch_tasks', input: { tasks } })

/** A worker turn that quotes the first output line matching `re` from its last tool result as evidence. */
export const reportFromOutput = (command: string, re: RegExp, extra: { forged?: string[]; finding?: string } = {}): Turn => (req) => {
  const out = lastResults(req).join('\n')
  const line = out.split('\n').find((l) => re.test(l)) ?? ''
  return { calls: [report({ findings: [extra.finding ?? `saw: ${line.trim().slice(0, 80)}`], evidence: [{ command, lines: [line, ...(extra.forged ?? [])] }] })] }
}
