import { randomUUID } from 'node:crypto'
import type { FleetBudget, FleetEvent, FleetInfo, FleetMentionRequest, FleetMentionResult, FleetScopePreview, FleetScopeSpec, FleetStartRequest } from '@shared/fleet'
import type { Settings } from '@shared/types'
import type { AuditLog } from '../db/audit'
import type { TabControl } from '../host/client'
import type { LlmProvider } from '../llm/types'
import { clampBudget, DEFAULT_TOKEN_BUDGET } from './budget'
import { clampConcurrency, LanePool, MAX_FLEET_CONCURRENCY, type BackgroundHost } from './pool'
import { FleetRun, LANE_TIMEOUT_MS, RUN_TIMEOUT_MS, type FrozenScope } from './run'
import { resolveMentions } from './mentions'
import { exclusion, FleetScope, MAX_FLEET_DEVICES, type ScopeRepo } from './scope'

/**
 * Fleet runs for the windows that start them (FLEET-AGENT §3). A scope is resolved and stored here
 * under an id (10-minute TTL, once), so the renderer starts a run with `{scopeId, question}` and can
 * never hand main a device list. Events go to the owner window only; a window that reloads or
 * closes stops its runs.
 */

const SCOPE_TTL_MS = 10 * 60_000
export const MAX_ACTIVE_RUNS = 2
export const MAX_QUESTION_CHARS = 4_000
export const DEFAULT_CONCURRENCY = 4
export const MAX_ACTIVE_WALKS = 2

export interface FleetServiceDeps {
  host: BackgroundHost & TabControl
  repo: ScopeRepo
  settings: { get(): Settings }
  audit: Pick<AuditLog, 'append'>
  provider: (role: 'coordinator' | 'worker') => Promise<LlmProvider>
  emit: (owner: object, e: FleetEvent) => void
  /** Tests: shorter wall clocks. */
  limits?: { laneMs?: number; runMs?: number; workerSteps?: number }
  /** The team policy's caps (docs/POLICY.md): concurrency and token budget never go above them. */
  policy?: () => { fleetMaxConcurrency: number | null; fleetMaxTokenBudget: number | null; aiOff: string | null }
}

interface StoredScope {
  owner: object
  preview: FleetScopePreview
  at: number
}

export class FleetService {
  private scopes = new Map<string, StoredScope>()
  /** Scope walks in progress, one per window (a new one replaces it; the window closing stops it). */
  private walks = new Map<object, AbortController>()
  private runs = new Map<string, { owner: object; run: FleetRun }>()

  constructor(private readonly d: FleetServiceDeps) {}

  info(): FleetInfo {
    return { maxDevices: MAX_FLEET_DEVICES, maxConcurrency: this.maxConcurrency(), defaults: this.defaults() }
  }

  private maxConcurrency(): number {
    return Math.min(MAX_FLEET_CONCURRENCY, this.d.policy?.().fleetMaxConcurrency ?? MAX_FLEET_CONCURRENCY)
  }

  /** A local model (Ollama) serves one request at a time: 1 lane unless the user raises it for this run. */
  private defaults(concurrency?: number, tokens = DEFAULT_TOKEN_BUDGET): FleetBudget {
    const fallback = this.d.settings.get().aiProvider === 'ollama' ? 1 : DEFAULT_CONCURRENCY
    const p = this.d.policy?.()
    const max = this.maxConcurrency()
    const budget = p?.fleetMaxTokenBudget ? Math.min(clampBudget(tokens), p.fleetMaxTokenBudget) : clampBudget(tokens)
    return { tokens: budget, runMs: this.d.limits?.runMs ?? RUN_TIMEOUT_MS, laneMs: this.d.limits?.laneMs ?? LANE_TIMEOUT_MS, concurrency: Math.min(clampConcurrency(concurrency ?? Math.min(fallback, max), fallback), max) }
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, s] of this.scopes) if (now - s.at > SCOPE_TTL_MS) this.scopes.delete(id)
  }

  /** Resolve a scope (a topology seed walks CDP/LLDP: guarded reads, audited as `fleet`). Nothing else is sent. */
  async scope(spec: FleetScopeSpec, owner: object, order?: string[]): Promise<FleetScopePreview> {
    this.expire()
    const scopeId = randomUUID()
    this.walks.get(owner)?.abort()
    this.walks.delete(owner)
    if (spec.topology && this.walks.size >= MAX_ACTIVE_WALKS) throw new Error(`At most ${MAX_ACTIVE_WALKS} topology walks at a time`)
    const ctl = new AbortController()
    this.walks.set(owner, ctl)
    const pool = new LanePool(this.d.host, DEFAULT_CONCURRENCY)
    const resolver = new FleetScope({ repo: this.d.repo, pool, term: this.d.host, settings: this.d.settings, audit: this.d.audit })
    try {
      const r = await resolver.resolve(spec, ctl.signal, `scope-${scopeId.slice(0, 8)}`)
      if (!r.devices.length) throw new Error('No devices in that scope')
      // Mentions: the current tab's session first, then the mentioned ones in the order typed.
      if (order?.length) {
        const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length)
        r.devices = r.devices.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d.sessionId) - rank(b.d.sessionId) || a.i - b.i).map((x) => x.d)
      }
      const preview: FleetScopePreview = { scopeId, ...r, budget: this.defaults(), limits: { maxDevices: MAX_FLEET_DEVICES, maxConcurrency: this.maxConcurrency() } }
      this.scopes.set(scopeId, { owner, preview, at: Date.now() })
      return preview
    } finally {
      pool.closeAll()
      if (this.walks.get(owner) === ctl) this.walks.delete(owner)
    }
  }

  /**
   * "@ai … @edge-r1" (F11): resolve the mentions in the user's text against saved sessions, then the
   * scope they name through the normal scope path (exclusions, caps, a stored preview). Nothing
   * runs: the user starts the run from the preview. With an unknown or ambiguous mention there is
   * no preview, only the errors to fix.
   */
  async mentions(req: FleetMentionRequest, owner: object): Promise<FleetMentionResult> {
    const r = resolveMentions(req.text, req.sessionId, this.d.repo)
    if (!r.mentions) throw new Error('Mention a device with @name')
    const base = { question: r.question.slice(0, MAX_QUESTION_CHARS), spec: r.spec, errors: r.errors, current: r.current }
    if (r.errors.length) return { ...base, preview: null }
    const preview = await this.scope(r.spec, owner, r.spec.sessions)
    return { ...base, preview }
  }

  /** Start a run on a stored scope (once). Events arrive on `fleet:event`. */
  start(req: FleetStartRequest, owner: object): { runId: string } {
    this.expire()
    const stored = this.scopes.get(req.scopeId)
    if (!stored || stored.owner !== owner) throw new Error('This scope expired; pick the devices again')
    const settings = this.d.settings.get()
    const off = this.d.policy?.().aiOff
    if (off) throw new Error(off)
    if (!settings.aiConfigured) throw new Error('Connect a model first (Assistant panel)')
    const question = req.question.trim().slice(0, MAX_QUESTION_CHARS)
    if (!question) throw new Error('Ask a question first')
    if ([...this.runs.values()].filter((r) => r.run.status === 'running').length >= MAX_ACTIVE_RUNS) throw new Error(`At most ${MAX_ACTIVE_RUNS} fleet runs at a time`)
    // The user's selection: a subset of the preview. Topology matches (opt-in) count only when ticked.
    // A bad selection does not use the scope up: the user can fix it and start again.
    const known = new Set(stored.preview.devices.map((d) => d.sessionId))
    if (req.sessionIds?.some((id) => !known.has(id))) throw new Error('That device is not in the resolved scope: resolve it again')
    const picked = new Set(req.sessionIds ?? stored.preview.devices.filter((d) => !d.optIn).map((d) => d.sessionId))
    // Excluded devices are always listed ("not in this run"); ticking only picks among the runnable ones.
    const selected = stored.preview.devices.filter((d) => picked.has(d.sessionId) || (d.excluded && !d.optIn))
    if (selected.filter((d) => !d.excluded).length > MAX_FLEET_DEVICES) throw new Error(`Select at most ${MAX_FLEET_DEVICES} devices for one run`)
    this.scopes.delete(req.scopeId)
    // Freeze: the sessions as stored now, re-checked (a session edited since the preview may no longer qualify).
    const frozen: FrozenScope = { devices: [], excluded: [] }
    for (const dev of selected) {
      const s = this.d.repo.getSession(dev.sessionId)
      const why = dev.excluded ?? (s ? exclusion(s, this.d.repo) : 'the session was deleted')
      if (!s || why) frozen.excluded.push({ name: dev.name, why: why ?? 'unavailable' })
      else if (s.name !== dev.name) frozen.excluded.push({ name: dev.name, why: 'the session was renamed since the scope was picked' })
      else frozen.devices.push(s)
    }
    if (!frozen.devices.length) throw new Error(selected.length ? 'None of these devices can be reached in a fleet run' : 'Select at least one device')
    const budget = this.defaults(req.concurrency, req.tokenBudget ?? stored.preview.budget.tokens)
    const runId = randomUUID()
    const run = new FleetRun(runId, question, frozen, budget, {
      pool: new LanePool(this.d.host, budget.concurrency),
      term: this.d.host,
      settings: this.d.settings,
      audit: this.d.audit,
      provider: this.d.provider,
      emit: (e) => this.d.emit(owner, e),
      model: settings.aiProvider === 'anthropic' ? settings.aiModel : null,
      laneMs: budget.laneMs,
      runMs: budget.runMs,
      workerSteps: this.d.limits?.workerSteps
    })
    this.runs.set(runId, { owner, run })
    void run.run().finally(() => {
      // Keep finished runs briefly for a late cancel; they hold no connections.
      setTimeout(() => this.runs.delete(runId), 60_000).unref?.()
    })
    return { runId }
  }

  cancel(runId: string, owner: object): void {
    const r = this.runs.get(runId)
    if (r && r.owner === owner) r.run.cancel('user')
  }

  /** Stop one lane of a run (the user, from its column). */
  cancelLane(runId: string, lane: string, owner: object): boolean {
    const r = this.runs.get(runId)
    return !!r && r.owner === owner && r.run.cancelLane(lane)
  }

  /** A window closed or reloaded: stop what it started (runs and scope walks) and forget its scopes. */
  cancelFor(owner: object): void {
    for (const r of this.runs.values()) if (r.owner === owner) r.run.cancel('window')
    this.walks.get(owner)?.abort()
    this.walks.delete(owner)
    for (const [id, s] of this.scopes) if (s.owner === owner) this.scopes.delete(id)
  }

  /** The app is quitting: stop every run and walk (each lane gets Ctrl-C and its tab closes). */
  cancelAll(): void {
    for (const r of this.runs.values()) r.run.cancel('quit')
    for (const c of this.walks.values()) c.abort()
    this.walks.clear()
    this.scopes.clear()
  }

  /** Test hook. */
  get(runId: string): FleetRun | undefined {
    return this.runs.get(runId)?.run
  }
}
