import type { FleetBudget, FleetEvent, FleetReport, LaneStatus } from '@shared/fleet'
import type { AuditRow, Session } from '@shared/types'
import type { AuditLog } from '../db/audit'
import type { TabControl } from '../host/client'
import { NetworkPrivacy } from '../llm/network-privacy'
import { AgentLoop, type ToolCallContext, type ToolResult, type ToolSet } from '../agent/loop'
import type { LlmProvider, ToolSpec, TurnRequest, TurnResult } from '../llm/types'
import type { SettingsService } from '../settings'
import { meteredProvider, TokenMeter, WARN_AT } from './budget'
import { Ledger } from './ledger'
import { LanePool, Semaphore } from './pool'
import { coordinatorSystemPrompt } from './prompts'
import { failedReport, frameReport, reportShown } from './report'
import { runWorker } from './worker'

/**
 * One fleet run (FLEET-AGENT §3.1, §4): the coordinator loop and the scheduler.
 *
 * The coordinator is an `AgentLoop` with one tool, `dispatch_tasks`. It never talks to a device.
 * Each dispatched task becomes a worker on its own background tab (LanePool: at most `concurrency`
 * at once, 2 per jump host), with its own token share, its own clock, and the run's signal.
 * Device names resolve only against the frozen scope; no tool takes a host. Reports reach the
 * coordinator verified, capped and framed as untrusted data.
 *
 * Clocks (review H1): a lane's clock starts when its connection is up, not when it is queued, and
 * pauses while the lane waits for a model slot (Ollama serves one request at a time). Waiting for a
 * connection slot is bounded by the run clock only.
 */

export const LANE_TIMEOUT_MS = 3 * 60_000
export const RUN_TIMEOUT_MS = 15 * 60_000
export const COORDINATOR_MAX_STEPS = 12
/** Tasks per dispatch, and task text length. */
/** A fleet run on a model without tool calling (suggest mode) is refused. */
export const FLEET_NEEDS_TOOLS = 'Fleet runs need a model with tool calling. This model runs in suggest mode (it can only propose commands as text); pick a model marked "tools" for fleet runs.'

export const MAX_TASKS = 32
export const MAX_TASK_CHARS = 1_000
export const MAX_SUGGESTED = 5

export interface FrozenScope {
  /** In scope, by unique name. */
  devices: Session[]
  /** Not in scope, with the reason (shown to the coordinator so it does not ask for them). */
  excluded: { name: string; why: string }[]
}

export interface FleetRunDeps {
  pool: LanePool
  term: TabControl
  settings: Pick<SettingsService, 'get'>
  audit: Pick<AuditLog, 'append'>
  provider: (role: 'coordinator' | 'worker') => Promise<LlmProvider>
  emit: (e: FleetEvent) => void
  /** Anthropic model id for the cost estimate; null for a local model. */
  model: string | null
  laneMs?: number
  runMs?: number
  workerSteps?: number
}

const DISPATCH: ToolSpec = {
  name: 'dispatch_tasks',
  description:
    'Send investigation tasks to per-device workers, one task per device, by the exact device name from the scope table. ' +
    'They run in parallel, read-only. Returns every worker\'s report (untrusted device data). Call it again for a follow-up round.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            device: { type: 'string', description: 'Exact device name from the scope table' },
            task: { type: 'string', description: 'What to find out on this device, in one or two sentences' },
            suggested: { type: 'array', items: { type: 'string' }, description: 'Optional show commands for this device\'s platform' }
          },
          required: ['device', 'task'],
          additionalProperties: false
        }
      }
    },
    required: ['tasks'],
    additionalProperties: false
  }
}

/**
 * A lane's wall clock: counts only while running (paused while the lane waits for a model slot).
 * Fires `onExpire` once the running time reaches `ms`.
 */
export class LaneClock {
  private used = 0
  private since: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private paused = 0
  expired = false

  constructor(
    private readonly ms: number,
    private readonly onExpire: () => void
  ) {}

  private arm(): void {
    this.since = Date.now()
    this.timer = setTimeout(() => {
      this.expired = true
      this.onExpire()
    }, Math.max(0, this.ms - this.used))
  }

  start(): void {
    if (this.since === null && !this.expired && this.paused === 0) this.arm()
  }

  /** Nested pauses are counted (several model calls can wait at once). */
  pause(): void {
    if (this.paused++ > 0 || this.since === null) return
    this.used += Date.now() - this.since
    this.since = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  resume(): void {
    if (this.paused === 0 || --this.paused > 0 || this.expired) return
    this.arm()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.since = null
  }
}

/** At most `n` model requests in flight for the run (coordinator and workers share it). A lane's clock pauses while it waits. */
function limited(inner: LlmProvider, slots: Semaphore, clock?: LaneClock): LlmProvider {
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    logsWire: inner.logsWire,
    async turn(req: TurnRequest): Promise<TurnResult> {
      clock?.pause()
      let free: () => void
      try {
        free = await slots.acquire(req.signal)
      } finally {
        clock?.resume()
      }
      try {
        return await inner.turn(req)
      } finally {
        free()
      }
    }
  }
}

const statusOf = (r: FleetReport): LaneStatus => r.status
const key = (name: string): string => name.trim().toLowerCase()
/** A lane's budget account: by session id, so no device name can collide with "coordinator" (review L2). */
export const accountOf = (s: Pick<Session, 'id'>): string => `lane:${s.id}`

const AUDIT_DECISION: Partial<Record<LaneStatus, AuditRow['decision']>> = { timeout: 'timeout', cancelled: 'cancelled', error: 'error' }

export class FleetRun {
  readonly ledger = new Ledger()
  readonly meter: TokenMeter
  private readonly abort = new AbortController()
  private readonly byName = new Map<string, Session>()
  private readonly startedAt = Date.now()
  private workerSeq = 0
  private llmSlots: Semaphore | null = null
  /** Lanes running now, by session id (a device is never worked on by two workers at once). */
  private readonly busy = new Map<string, AbortController>()
  /** Lanes the user stopped, by session id. */
  private readonly userStopped = new Set<string>()
  private runTimedOut = false
  status: 'running' | 'done' | 'cancelled' | 'error' = 'running'
  private readonly privacy = new NetworkPrivacy()
  readonly reports = new Map<string, FleetReport>()

  constructor(
    readonly runId: string,
    readonly question: string,
    readonly scope: FrozenScope,
    readonly budget: FleetBudget,
    private readonly d: FleetRunDeps
  ) {
    for (const s of scope.devices) {
      this.byName.set(key(s.name), s)
      this.byName.set(key(this.privacy.addSession(s)), s)
    }
    for (const s of scope.excluded) this.privacy.remember(s.name, 'device')
    this.meter = new TokenMeter(budget.tokens, d.model, (usage) => this.d.emit({ runId, type: 'usage', usage, elapsedMs: Date.now() - this.startedAt }))
  }

  get signal(): AbortSignal {
    return this.abort.signal
  }

  /** Stop everything: every lane's signal aborts, every executor sends Ctrl-C, every background tab closes. */
  cancel(by: 'user' | 'window' | 'quit' = 'user'): void {
    if (this.status === 'running') {
      this.status = 'cancelled'
      this.auditRun('cancelled', by === 'user' ? 'stopped by the user' : by === 'quit' ? 'the app quit' : 'the window closed or reloaded')
    }
    this.abort.abort()
  }

  /** Stop one lane (the user, from its column). The run goes on; the coordinator gets a "stopped" report. */
  cancelLane(name: string): boolean {
    const s = this.byName.get(key(name))
    const ctl = s && this.busy.get(s.id)
    if (!s || !ctl) return false
    this.userStopped.add(s.id)
    ctl.abort()
    return true
  }

  private ev(e: FleetEvent extends infer T ? (T extends { runId: string } ? Omit<T, 'runId'> : never) : never): void {
    this.d.emit({ runId: this.runId, ...e } as FleetEvent)
  }

  private auditRun(decision: AuditRow['decision'], reason: string): void {
    this.d.audit.append({ sessionId: null, sessionName: '(fleet run)', host: '', source: 'fleet', command: '(run)', kind: 'read', decision, reason, approver: null, durationMs: Date.now() - this.startedAt, bytes: null, redactions: null, runId: this.runId, lane: null })
  }

  private auditLane(s: Session, command: string, decision: AuditRow['decision'], reason: string): void {
    this.d.audit.append({ sessionId: s.id, sessionName: s.name, host: s.host, source: 'fleet', command, kind: 'read', decision, reason: reason.slice(0, 500), approver: null, durationMs: null, bytes: null, redactions: null, runId: this.runId, lane: s.name })
  }

  private async provider(role: 'coordinator' | 'worker', account: string, clock?: LaneClock): Promise<LlmProvider> {
    const inner = await this.d.provider(role)
    // Suggest mode (a model without tool calling) can't dispatch or run anything on its own.
    if (inner.capabilities?.tools === false) throw new Error(FLEET_NEEDS_TOOLS)
    // A local model: one request per parallel lane, no extra (Ollama defaults to 1 lane, review M1;
    // a user who raised it has a server that takes parallel requests). Cloud: one more for the coordinator.
    this.llmSlots ??= new Semaphore(inner.id === 'ollama' ? this.budget.concurrency : this.budget.concurrency + 1)
    const note =
      role === 'coordinator'
        ? 'the token budget for this run is used up. Do not dispatch again: write the final answer now from the reports you have, and say which devices were not checked.'
        : 'this lane\'s token budget is used up. Call submit_report now with what you have; run no more commands.'
    return meteredProvider(limited(inner, this.llmSlots, clock), this.meter, account, {
      label: role === 'coordinator' ? 'the coordinator' : this.nameOf(account),
      closingNote: note,
      onClosing: () => {
        this.ev({ type: 'note', text: role === 'coordinator' ? 'The token budget is used up: the coordinator is writing its answer from the reports it has.' : `The token budget for ${account === 'coordinator' ? 'the coordinator' : this.nameOf(account)} is used up: it is closing with a report.` })
      }
    })
  }

  private nameOf(account: string): string {
    return this.scope.devices.find((s) => accountOf(s) === account)?.name ?? account
  }

  /** Run the coordinator to its answer. Resolves when the run is over (done, cancelled, timed out, error). */
  async run(): Promise<void> {
    const runMs = this.d.runMs ?? RUN_TIMEOUT_MS
    const runTimer = setTimeout(() => {
      this.ev({ type: 'note', text: `The run reached its ${Math.round(runMs / 60_000)}-minute limit and was stopped.` })
      this.runTimedOut = true
      if (this.status === 'running') {
        this.status = 'error'
        this.auditRun('timeout', `the run reached its ${Math.round(runMs / 1000)} s limit`)
      }
      this.abort.abort()
    }, runMs)
    this.ev({
      type: 'run',
      status: 'running',
      question: this.question,
      devices: [...this.scope.devices.map((s) => ({ name: s.name, platform: s.platform })), ...this.scope.excluded.map((e) => ({ name: e.name, platform: 'auto' as const, excluded: e.why }))],
      budget: this.budget,
      startedAt: this.startedAt
    })
    let error: string | undefined
    try {
      const loop = new AgentLoop(
        { messages: [], privacy: this.privacy },
        {
          provider: () => this.provider('coordinator', 'coordinator'),
          system: () => coordinatorSystemPrompt(this.scope.devices.map((s) => ({ name: s.name, platform: s.platform, tags: s.tags })), this.scope.excluded),
          tools: this.coordinatorTools(),
          emit: (e) => {
            if (e.type === 'text') this.ev({ type: 'text', text: e.text })
          },
          maxIterations: COORDINATOR_MAX_STEPS,
          meta: { source: 'fleet', lane: 'coordinator' }
        }
      )
      const done = await loop.run(this.question, { runId: this.runId, signal: this.abort.signal })
      error = done.error
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      clearTimeout(runTimer)
      this.abort.abort()
      this.d.pool.closeAll()
    }
    if (this.status === 'running') {
      this.status = error ? 'error' : 'done'
      if (error) this.auditRun('error', error)
    }
    this.ev({ type: 'run', status: this.status, ...(error && this.status !== 'cancelled' ? { error } : {}), question: this.question, devices: [], budget: this.budget, startedAt: this.startedAt })
  }

  private coordinatorTools(): ToolSet {
    return {
      specs: [DISPATCH],
      call: (name, input, ctx) => {
        if (name === 'dispatch_tasks') return this.dispatch(input, ctx)
        const n = String(name).slice(0, 64)
        this.d.audit.append({ sessionId: null, sessionName: '(coordinator)', host: '', source: 'fleet', command: n, kind: 'unknown', decision: 'refused', reason: `unknown coordinator tool ${n}`, approver: null, durationMs: null, bytes: null, redactions: null, runId: this.runId, lane: null })
        return Promise.resolve({ text: `REFUSED: unknown tool ${n}. Your only tool is dispatch_tasks.`, isError: true })
      }
    }
  }

  /** Audit a coordinator request that is refused for a device (out of scope, quoting output, duplicate, empty). */
  private refuseName(name: string, reason: string, s?: Session): void {
    this.d.audit.append({ sessionId: s?.id ?? null, sessionName: name.slice(0, 64) || '(none)', host: s?.host ?? '', source: 'fleet', command: 'dispatch_tasks', kind: 'unknown', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null, runId: this.runId, lane: name.slice(0, 64) })
  }

  private async dispatch(input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    if (this.meter.closing('coordinator')) {
      this.refuseName('(coordinator)', 'dispatch after the token budget was used up')
      return { text: 'REFUSED: the token budget is used up. Write the final answer now from the reports you have.', isError: true }
    }
    const raw = (input as { tasks?: unknown })?.tasks
    if (!Array.isArray(raw) || !raw.length) return { text: 'ERROR: tasks must be a non-empty array of {device, task}.', isError: true }
    const out: string[] = []
    const jobs: { session: Session; task: string; suggested: string[] }[] = []
    const seen = new Set<string>()
    for (const t of raw.slice(0, MAX_TASKS)) {
      const o = (t ?? {}) as { device?: unknown; task?: unknown; suggested?: unknown }
      const name = typeof o.device === 'string' ? o.device.trim() : ''
      const session = this.byName.get(key(name))
      if (!session) {
        const why = 'not a device in this run\'s scope (the scope is frozen; there is no tool that takes a host)'
        this.refuseName(name, why)
        out.push(`REFUSED for "${name.slice(0, 64).replace(/[<>"]/g, '_')}": ${why}.`)
        continue
      }
      if (seen.has(session.id) || this.busy.has(session.id)) {
        this.refuseName(session.name, 'one task per device at a time', session)
        out.push(`REFUSED for ${session.name}: one task per device at a time.`)
        continue
      }
      const task = typeof o.task === 'string' ? o.task.trim().slice(0, MAX_TASK_CHARS) : ''
      if (!task) {
        this.refuseName(session.name, 'the task is empty', session)
        out.push(`REFUSED for ${session.name}: the task is empty.`)
        continue
      }
      const suggested = Array.isArray(o.suggested) ? o.suggested.filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 200)).filter(Boolean).slice(0, MAX_SUGGESTED) : []
      // Workers never see other devices' output: a task that quotes another device's report is sent back.
      const copied = this.ledger.copiedFrom([task, ...suggested].join('\n'), session.name)
      if (copied) {
        this.refuseName(session.name, `the task quotes ${copied}'s device output`, session)
        out.push(`REFUSED for ${session.name}: the task quotes output from ${copied}. Workers never see other devices' output: describe what to check in your own words.`)
        continue
      }
      seen.add(session.id)
      jobs.push({ session, task, suggested })
    }
    if (jobs.length) {
      this.meter.allot(jobs.map((j) => accountOf(j.session)))
      this.ev({ type: 'plan', tasks: jobs.map((j) => ({ device: j.session.name, task: j.task })) })
      const reports = await Promise.all(jobs.map((j) => this.lane(j.session, j.task, j.suggested, ctx.signal)))
      for (const [i, j] of jobs.entries()) {
        const framed = frameReport(j.session.name, reports[i]!.report, reports[i]!.status)
        this.ledger.recordShown(j.session.name, reportShown(reports[i]!.report))
        out.push(framed)
      }
    }
    if (this.meter.fraction('coordinator') >= WARN_AT) out.push('[Hopline Terminal: your token budget is nearly used. Write the final answer now; do not dispatch again.]')
    return { text: out.join('\n\n'), isError: !jobs.length }
  }

  /** One lane: wait for a slot, connect in the background, run the worker, always close the tab. */
  private async lane(session: Session, task: string, suggested: string[], runSignal: AbortSignal): Promise<{ report: FleetReport; status: LaneStatus }> {
    const lane = session.name
    const account = accountOf(session)
    const worker = `${lane}#${++this.workerSeq}`
    const laneCtl = new AbortController()
    this.busy.set(session.id, laneCtl)
    this.userStopped.delete(session.id)
    const laneMs = this.d.laneMs ?? LANE_TIMEOUT_MS
    const clock = new LaneClock(laneMs, () => laneCtl.abort())
    const signal = AbortSignal.any([runSignal, laneCtl.signal])
    const set = (status: LaneStatus, extra: { reason?: string; report?: FleetReport; background?: boolean } = {}) => this.ev({ type: 'lane', lane, status, task, ...extra })
    set('queued')
    let lease: Awaited<ReturnType<LanePool['acquire']>> | undefined
    const finish = (report: FleetReport, status: LaneStatus, reason?: string) => {
      this.reports.set(lane, report)
      // Every lane that ends without a report of its own is audited (review M5).
      const decision = AUDIT_DECISION[status]
      if (decision) this.auditLane(session, '(lane)', decision, reason ?? report.flags[0] ?? status)
      set(status, { report, ...(reason ? { reason } : {}) })
      return { report, status }
    }
    const stopped = () => {
      if (clock.expired || this.runTimedOut) {
        const why = clock.expired ? `timed out after ${Math.round(laneMs / 1000)} s` : 'the run reached its time limit'
        return finish(failedReport(why), 'timeout', why)
      }
      const why = this.userStopped.has(session.id) ? 'stopped by the user' : 'the run was stopped'
      return finish(failedReport(why), 'cancelled', why)
    }
    try {
      try {
        lease = await this.d.pool.acquire(session, signal, () => set('connecting', { background: true }))
      } catch (e) {
        if (signal.aborted) return stopped()
        const why = `could not connect: ${e instanceof Error ? e.message : String(e)}`
        return finish(failedReport(why), 'error', why)
      }
      // The lane's clock starts now: queueing for a connection slot does not count against it.
      clock.start()
      set('running', { background: true })
      const out = await runWorker(
        lease.tab,
        {
          term: this.d.term,
          settings: this.d.settings,
          audit: this.d.audit,
          ledger: this.ledger,
          privacy: this.privacy,
          runId: this.runId,
          lane,
          worker,
          task: [task, ...suggested].join('\n'),
          step: (step) => this.ev({ type: 'step', lane, step }),
          budgetNote: () => (this.meter.fraction(account) >= WARN_AT ? 'your token budget is nearly used: submit your report now' : null),
          closing: () => this.meter.closing(account),
          provider: () => this.provider('worker', account, clock),
          maxSteps: this.d.workerSteps
        },
        task,
        suggested,
        signal
      )
      if (signal.aborted && !out.report.findings.length) return stopped()
      return finish(out.report, out.error ? 'error' : statusOf(out.report), out.error)
    } catch (e) {
      if (signal.aborted) return stopped()
      const why = e instanceof Error ? e.message : String(e)
      return finish(failedReport(why), 'error', why)
    } finally {
      clock.stop()
      lease?.release()
      this.busy.delete(session.id)
    }
  }
}
