import { NetworkPrivacy } from '../llm/network-privacy'
import { frame, untrustedText } from './untrusted'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventBody, AgentRequest } from '@shared/types'
import type { AuditLog } from '../db/audit'
import type { LlmProvider } from '../llm/types'
import type { SettingsService } from '../settings'
import type { AgentTab as TermTab, TabControl } from '../host/client'
import { RecentOutput } from './copied'
import { meteredProvider, TokenMeter } from '../fleet/budget'
import { DeviceTools, type DeviceToolsDeps } from './device-tools'
import { AgentLoop, type Conversation, type ToolCallContext, type ToolResult, type ToolSet } from './loop'
import { Proposals, type DecisionWhy } from './proposals'
import { clampRunBudget, firstTurnTooLargeMessage } from './run-budget'
import { classifySuggestions, extractCommandBlocks, SUGGEST_RULES, SuggestionStore } from './suggest'
import { systemPrompt } from './system-prompt'

/**
 * The per-tab chat assistant: one persistent conversation per tab, at most one run per tab, and
 * the renderer's decisions on proposal cards. Each run is an `AgentLoop` over a `DeviceTools`
 * bound to the tab; proposals are kept in one `Proposals` broker so a decision (by id) reaches the
 * run that is waiting for it.
 */

export { PROPOSAL_CLOSED } from './proposals'

export interface AgentDeps {
  term: TabControl
  settings: SettingsService
  audit: AuditLog
  provider: () => Promise<LlmProvider>
  emit: (e: AgentEvent) => void
}

export class Agent {
  private conversations = new Map<string, Conversation>()
  private runs = new Map<string, AbortController>()
  private runByTab = new Map<string, string>()
  private tabByRun = new Map<string, string>()
  /** The tab of every proposal card (and the change that follows it), for the IPC ownership check. */
  private tabByProposal = new Map<string, string>()
  private readonly proposals: Proposals
  /** Recent redacted device output per tab, for the copied-line flag on proposal cards. */
  private recent = new Map<string, RecentOutput>()
  private readonly suggestions = new SuggestionStore()
  /** The tools' view of `d`, read at call time (so a replaced `d.settings` or `d.emit` applies at once). */
  private readonly tools: DeviceToolsDeps

  constructor(private readonly d: AgentDeps) {
    const self = this
    this.tools = {
      get term() {
        return self.d.term
      },
      get settings() {
        return self.d.settings
      },
      get audit() {
        return self.d.audit
      },
      emit: (e) => self.ev(e),
      recent: (tabId) => self.recentOf(tabId)
    }
    this.proposals = new Proposals(this.tools)
  }

  private privacyFor(tab: TermTab): NetworkPrivacy {
    const conv: Conversation = this.conversations.get(tab.tabId) ?? { messages: [] }
    conv.privacy ??= new NetworkPrivacy()
    conv.privacy.addSession(tab.session)
    this.conversations.set(tab.tabId, conv)
    return conv.privacy
  }

  private recentOf(tabId: string): RecentOutput {
    let r = this.recent.get(tabId)
    if (!r) this.recent.set(tabId, (r = new RecentOutput()))
    return r
  }

  private ev(e: AgentEventBody): void {
    const tabId = e.type === 'change' ? e.tabId : (this.tabByRun.get(e.runId) ?? '')
    // The tab is free once its run says done: a click that follows at once (a suggestion) may start.
    // A change event names its own tab: it can arrive after the run ended (a confirm from the card).
    if (e.type === 'done') this.release(e.runId, tabId)
    if ((e.type === 'proposal' || e.type === 'change') && tabId) this.tabByProposal.set(e.proposalId, tabId)
    this.d.emit({ ...e, tabId })
  }

  private release(runId: string, tabId: string): void {
    this.runs.delete(runId)
    if (this.runByTab.get(tabId) === runId) this.runByTab.delete(tabId)
    this.tabByRun.delete(runId)
  }

  /**
   * The tab an IPC request names, by what it sends (review L9): a run, a proposal or change card,
   * or a suggestion. Undefined when the id is unknown (the method itself then refuses).
   */
  tabOf(kind: 'run' | 'proposal' | 'suggestion', id: string): string | undefined {
    if (kind === 'run') return this.tabByRun.get(id)
    if (kind === 'proposal') return this.tabByProposal.get(id)
    return this.suggestions.peek(id)?.tabId
  }

  reset(tabId: string): void {
    this.conversations.delete(tabId)
    this.recent.delete(tabId)
    this.suggestions.dropTab(tabId)
  }

  /** The user's confirm or rollback of an applied change (the card); the model never calls this. */
  changeAction(proposalId: string, action: 'confirm' | 'rollback'): Promise<void> {
    return this.proposals.changes.act(proposalId, action)
  }

  /** Stop the changes' expiry timers (app quit). Devices keep their own timers. */
  dispose(): void {
    this.proposals.changes.dispose()
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort()
    for (const p of this.proposals.open()) if (this.runByTab.get(p.tabId) === runId) this.decide(p.id, false, 'cancelled')
  }

  /**
   * Approve or reject a proposal. The renderer sends only the id (and, for a disruptive one, the
   * hostname the user typed); the commands that run are the ones stored when the proposal was
   * made, so the UI cannot alter them. A disruptive approval whose hostname does not match is
   * refused and the proposal stays open.
   */
  decide(proposalId: string, approve: boolean, why: DecisionWhy = 'user', ack?: string, lines?: number[]): void {
    this.proposals.decide(proposalId, approve, why, ack, lines)
  }

  start(req: AgentRequest): { runId: string } {
    const tab = this.d.term.get(req.tabId)
    if (!tab) throw new Error('No such tab')
    return this.begin(req.tabId, (runId, signal) => this.loop(runId, tab, req, signal))
  }

  /** One run on a tab (a model run, or a clicked suggestion): the per-tab lock, cancellation and cleanup. */
  private begin(tabId: string, body: (runId: string, signal: AbortSignal) => Promise<void>): { runId: string } {
    if (this.runByTab.has(tabId)) throw new Error('The assistant is already working on this session')
    const runId = randomUUID()
    const ctrl = new AbortController()
    this.runs.set(runId, ctrl)
    this.runByTab.set(tabId, runId)
    this.tabByRun.set(runId, tabId)
    void body(runId, ctrl.signal)
      .catch((error: unknown) => this.ev({ type: 'done', runId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => this.release(runId, tabId))
    return { runId }
  }

  /**
   * Suggest mode: run one command the model suggested, by id (the renderer never sends the text).
   * It runs through `DeviceTools` like the model's own call, with the user as approver: a read runs
   * (guard, audit, redaction); a disruptive command or configuration lines open a proposal card.
   * The redacted result is added to the conversation, for the next question.
   */
  runSuggestion(suggestionId: string): { runId: string } {
    const peek = this.suggestions.peek(suggestionId)
    if (!peek) throw new Error('This suggestion is no longer available. Ask again.')
    if (this.runByTab.has(peek.tabId)) throw new Error('The assistant is already working on this session')
    const s = this.suggestions.take(suggestionId)
    if (!s) throw new Error('This suggestion is no longer available. Ask again.')
    const tab = this.d.term.get(s.tabId)
    if (!tab) throw new Error('No such tab')
    return this.begin(s.tabId, async (runId, signal) => {
      const tools = new DeviceTools(tab, { ...this.tools, privacy: this.privacyFor(tab) }, this.proposals)
      const ctx: ToolCallContext = { runId, signal, approver: 'user' }
      let error: string | undefined
      try {
        const reason = 'suggested by the model, run by the user'
        const r =
          s.kind === 'config'
            ? await tools.proposeSuggested(ctx, s.commands)
            : await tools.call('run_show_command', { command: s.commands[0]!, reason }, ctx)
        const conv = this.conversations.get(tab.tabId) ?? { messages: [] }
        this.conversations.set(tab.tabId, conv)
        const label = s.commands.length === 1 ? `\`${s.commands[0]}\`` : `these configuration lines:\n${s.commands.join('\n')}`
        // r.text is Hopline's own tool result (its device_output frames and notes): framed, not neutralised.
        const text = `[Hopline: the user ran your suggested ${label}. Result (untrusted device data):]\n${frame('terminal_output', r.text)}`
        const last = conv.messages.at(-1)
        if (last?.role === 'user') last.parts.push({ type: 'text', text })
        else conv.messages.push({ role: 'user', parts: [{ type: 'text', text }] })
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      this.ev(error === undefined ? { type: 'done', runId } : { type: 'done', runId, error })
    })
  }

  private async loop(runId: string, tab: TermTab, req: AgentRequest, signal: AbortSignal): Promise<void> {
    const privacy = this.privacyFor(tab)
    const conv = this.conversations.get(tab.tabId)!
    // A new question: the suggestions of the last answer can't be clicked any more.
    this.suggestions.dropTab(tab.tabId)

    let prompt = req.prompt
    if (req.selection) {
      const sel = selectionForModel(req.selection, privacy)
      this.recentOf(tab.tabId).record('selected terminal output', selectionForModel(req.selection))
      prompt += `\n\nSelected terminal output (untrusted device data):\n${frame('terminal_output', sel)}`
    }
    const device = new DeviceTools(tab, { ...this.tools, privacy }, this.proposals)
    // Per-run token budget (Trust UX): fleet/budget.ts's meter with one account that holds it all.
    const settings = this.d.settings.get()
    const budget = clampRunBudget(settings.aiRunTokenBudget)
    let closing = false
    const meter = new TokenMeter(budget, settings.aiProvider === 'anthropic' ? settings.aiModel : null, (u) =>
      this.ev({ type: 'usage', runId, used: u.metered, budget, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, ...(closing ? { closing } : {}) }),
      1
    )
    let suggest = false
    const provider = async () => {
      const inner = await this.d.provider()
      suggest = inner.capabilities?.tools === false
      this.ev({ type: 'mode', runId, suggest })
      this.ev({ type: 'usage', runId, used: 0, budget, inputTokens: 0, outputTokens: 0, costUsd: null })
      return meteredProvider(inner, meter, 'coordinator', {
        label: 'this run',
        closingNote: 'the token budget for this run is used up. Run no more commands: answer now with what you have, and say what is still unchecked.',
        onClosing: () => {
          closing = true
        },
        firstTurnTooLarge: (estimate, share) => new Error(firstTurnTooLargeMessage(estimate, share))
      })
    }
    // Suggest mode declares no tools; once the budget is spent the device is not touched again.
    const tools: ToolSet = {
      get specs() {
        return suggest ? [] : device.specs
      },
      call: async (name, input, ctx): Promise<ToolResult> => {
        if (closing) return { text: 'REFUSED: the token budget for this run is used up. Answer now with what you have.', isError: true }
        if (suggest) return { text: 'REFUSED: no tools are available in suggest mode. Propose commands in a fenced code block instead.', isError: true }
        return device.call(name, input, ctx)
      },
      reject: (name, why, ctx) => device.reject(name, why, ctx)
    }
    const loop = new AgentLoop(conv, {
      provider,
      system: () => {
        const session = (this.d.term.get(tab.tabId) ?? tab).session
        privacy.addSession(session)
        return systemPrompt(session) + (suggest ? `\n${SUGGEST_RULES}` : '')
      },
      tools,
      emit: (e) => this.ev(e.type === 'done' && e.error && /token budget/.test(e.error) ? { ...e, error: `${e.error} Raise it in Settings › Assistant (run budget: ${budget.toLocaleString('en-US')} tokens).` } : e),
      meta: { source: 'agent', sessionName: tab.session.name },
      onFinal: (text, id) => {
        if (!suggest) return
        const session = (this.d.term.get(tab.tabId) ?? tab).session
        const items = classifySuggestions(extractCommandBlocks(text), session.platform, this.d.term.policyRules)
        this.suggestions.put(tab.tabId, items)
        if (items.length) this.ev({ type: 'suggestions', runId: id, items })
      }
    })
    await loop.run(prompt, { runId, signal })
  }
}

/** Characters of selected output the model sees. */
export const SELECTION_MAX_CHARS = 20_000

/**
 * The selected text as the model sees it: redacted whole FIRST, then cut. Cutting first could split
 * a private key so its BEGIN or END line is gone and the redaction no longer recognises it
 * (Phase 4 review M6). A long selection keeps its first line (the prompt and command) and the tail.
 */
export function selectionForModel(selection: string, privacy?: NetworkPrivacy): string {
  // Selected text is device output too: escapes, invisible characters and frame tags go first (a
  // selected `</terminal_output>` must not close the frame), then redaction (agent/untrusted.ts).
  const cleaned = untrustedText(selection).text
  const text = privacy ? privacy.protect(cleaned) : cleaned
  if (text.length <= SELECTION_MAX_CHARS) return text
  const nl = text.indexOf('\n')
  const head = nl > 0 && nl < 500 ? text.slice(0, nl + 1) : ''
  return `${head}[… ${(text.length - SELECTION_MAX_CHARS).toLocaleString('en-US')} characters omitted]\n${text.slice(-(SELECTION_MAX_CHARS - head.length))}`
}
