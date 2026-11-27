import type { FleetUsage } from '@shared/fleet'
import type { LlmProvider, TurnRequest, TurnResult } from '../llm/types'

/**
 * Token budget for a fleet run (FLEET-AGENT §4.2). The coordinator keeps 25%; the rest is split
 * evenly over the lanes dispatched. Usage comes from the provider (`TurnResult.usage`); a provider
 * that reports none is estimated at 4 characters per token, so a budget always binds.
 *
 * Units: the meter counts "input-equivalent" tokens: uncached input 1x, cache reads 0.1x, cache
 * writes 1.25x, output 5x (the ratios of every listed model's price). The run header shows this same
 * figure against the budget, so 100% there is 100% here.
 *
 * Enforcement (review M2): before each turn, the request is estimated (characters / 4, plus an
 * output reserve) and refused if it would not fit the account's share. The first refusal is not
 * fatal: the account enters its closing phase, at most GRACE_TURNS more turns told to finish (a
 * worker: call submit_report; the coordinator: write the answer from the reports it has), while its
 * tool set refuses everything but the closing tool (the tools stay declared: a request whose
 * history holds tool calls must define tools). After that, every turn is refused. The overshoot is
 * bounded by those closing turns.
 *
 * Deviation from the design: metering is a provider wrapper here (`meteredProvider`) instead of an
 * `onUsage` hook in `llm/safe.ts`, so the shared redaction door is untouched. `AgentLoop` still
 * wraps whatever it is given in `safeProvider`, so every request is redacted after metering sees it.
 */

export const DEFAULT_TOKEN_BUDGET = 400_000
export const MIN_TOKEN_BUDGET = 20_000
export const MAX_TOKEN_BUDGET = 4_000_000
export const COORDINATOR_SHARE = 0.25
export const WARN_AT = 0.8
/** Output tokens assumed for a turn that has not happened yet (the pre-turn estimate). */
export const OUTPUT_RESERVE = 1_000
export const OUTPUT_WEIGHT = 5
export const CACHE_READ_WEIGHT = 0.1
export const CACHE_WRITE_WEIGHT = 1.25
/** Turns an account may take after its share is spent, to close (submit its report, or answer). */
export const GRACE_TURNS = 2

/**
 * USD per million tokens: [input, output, cache read]. Cache writes (5-minute) cost 1.25x input.
 * First-party API list prices as of 2026-11 (claude-api reference); other platforms differ, and an
 * unlisted model shows tokens only.
 */
export const PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 1],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1]
}

export class BudgetExceeded extends Error {
  constructor(what: string) {
    super(`The token budget for ${what} is used up.`)
    this.name = 'BudgetExceeded'
  }
}

export function estimateTokens(req: Pick<TurnRequest, 'system' | 'messages' | 'tools'>): number {
  let n = req.system.length + JSON.stringify(req.tools).length
  for (const m of req.messages)
    for (const p of m.parts) n += p.type === 'text' ? p.text.length : p.type === 'tool_result' ? p.content.length : JSON.stringify(p.input ?? null).length + p.name.length
  return Math.ceil(n / 4)
}

export function clampBudget(n: number | undefined): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TOKEN_BUDGET
  return Math.min(Math.max(v, MIN_TOKEN_BUDGET), MAX_TOKEN_BUDGET)
}

export interface TurnUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Input-equivalent tokens of one turn. */
export const weigh = (u: TurnUsage): number => Math.ceil(u.input + (u.cacheRead ?? 0) * CACHE_READ_WEIGHT + (u.cacheWrite ?? 0) * CACHE_WRITE_WEIGHT + u.output * OUTPUT_WEIGHT)

/** One run's meter: totals for the header, and a share per account (`coordinator`, `lane:<sessionId>`). */
export class TokenMeter {
  private inTok = 0
  private outTok = 0
  private cacheRead = 0
  private cacheWrite = 0
  private total_ = 0
  private used = new Map<string, number>()
  private shares = new Map<string, number>()
  /** Accounts in their closing phase, with the turns they have left. */
  private grace = new Map<string, number>()

  constructor(
    readonly total: number,
    /** Anthropic model id, or null for a local model. */
    private readonly model: string | null,
    private readonly onChange?: (u: FleetUsage) => void,
    /** The coordinator's share; 1 for a single-account meter (the chat assistant's per-run budget). */
    coordinatorShare = COORDINATOR_SHARE
  ) {
    this.shares.set('coordinator', Math.floor(total * coordinatorShare))
  }

  /** Split what is left of the worker share over the accounts of newly dispatched lanes. */
  allot(accounts: string[]): void {
    if (!accounts.length) return
    const workerTotal = this.total - (this.shares.get('coordinator') ?? 0)
    const spentByWorkers = [...this.used.entries()].filter(([k]) => k !== 'coordinator').reduce((a, [, v]) => a + v, 0)
    const left = Math.max(0, workerTotal - spentByWorkers)
    const each = Math.floor(left / accounts.length)
    for (const l of accounts) this.shares.set(l, (this.used.get(l) ?? 0) + each)
  }

  share(account: string): number {
    return this.shares.get(account) ?? 0
  }

  spent(account: string): number {
    return this.used.get(account) ?? 0
  }

  /** Fraction of the account's share used (1 = all of it). */
  fraction(account: string): number {
    const s = this.share(account)
    return s > 0 ? this.spent(account) / s : 1
  }

  /** Whether a turn estimated at `tokens` (input-equivalent) still fits the account's share. */
  fits(account: string, tokens: number): boolean {
    return this.spent(account) + tokens <= this.share(account)
  }

  /** Whether the account's share is spent (it may only close now). */
  closing(account: string): boolean {
    return this.grace.has(account)
  }

  startClosing(account: string): void {
    if (!this.grace.has(account)) this.grace.set(account, GRACE_TURNS)
  }

  /** Take one closing turn; false when none are left. */
  takeGrace(account: string): boolean {
    const n = this.grace.get(account) ?? 0
    if (n <= 0) return false
    this.grace.set(account, n - 1)
    return true
  }

  add(account: string, u: TurnUsage): void {
    this.inTok += u.input
    this.outTok += u.output
    this.cacheRead += u.cacheRead ?? 0
    this.cacheWrite += u.cacheWrite ?? 0
    const w = weigh(u)
    this.total_ += w
    this.used.set(account, this.spent(account) + w)
    this.onChange?.(this.usage())
  }

  usage(): FleetUsage {
    const price = this.model ? PRICES[this.model] : undefined
    const costUsd = price ? (this.inTok * price[0] + this.outTok * price[1] + this.cacheRead * price[2] + this.cacheWrite * price[0] * CACHE_WRITE_WEIGHT) / 1_000_000 : null
    return { inputTokens: this.inTok, outputTokens: this.outTok, cacheReadTokens: this.cacheRead, cacheWriteTokens: this.cacheWrite, metered: this.total_, costUsd }
  }
}

export interface MeterOptions {
  /** How the account is named in errors ("the coordinator", a device name). */
  label: string
  /** What the closing turns are told. */
  closingNote: string
  /** Called once when the closing phase starts: the tool set then refuses all but its closing tool. */
  onClosing: () => void
  /**
   * The very first turn of the account does not fit its whole share (a long chat history against a
   * small budget): without this the run would start already closing and answer without looking
   * (review L1). The error it returns is thrown instead, before anything is sent.
   */
  firstTurnTooLarge?: (estimate: number, share: number) => Error
}

/** A provider whose every turn is charged to one account of a meter, and refused once its share is spent. */
export function meteredProvider(inner: LlmProvider, meter: TokenMeter, account: string, opts?: MeterOptions): LlmProvider {
  const what = opts?.label ?? (account === 'coordinator' ? 'the coordinator' : account)
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    logsWire: inner.logsWire,
    async turn(req: TurnRequest): Promise<TurnResult> {
      const estimate = estimateTokens(req) + OUTPUT_RESERVE * OUTPUT_WEIGHT
      if (!meter.closing(account) && !meter.fits(account, estimate)) {
        if (!opts) throw new BudgetExceeded(what)
        if (opts.firstTurnTooLarge && meter.spent(account) === 0) throw opts.firstTurnTooLarge(estimate, meter.share(account))
        meter.startClosing(account)
        opts.onClosing()
      }
      if (meter.closing(account)) {
        if (!opts || !meter.takeGrace(account)) throw new BudgetExceeded(what)
        req = { ...req, system: `${req.system}\n\n[Hopline: ${opts.closingNote}]` }
      }
      const r = await inner.turn(req)
      const output = r.usage?.outputTokens ?? Math.ceil(JSON.stringify(r.message.parts).length / 4)
      meter.add(account, { input: r.usage?.inputTokens ?? estimateTokens(req), output, cacheRead: r.usage?.cacheReadTokens, cacheWrite: r.usage?.cacheWriteTokens })
      return r
    }
  }
}
