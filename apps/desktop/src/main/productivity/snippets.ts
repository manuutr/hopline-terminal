import { randomUUID } from 'node:crypto'
import type { CommandPlan, CommandRunResult } from '@shared/productivity'
import { fillSnippet, snippetApplies } from '@shared/snippets'
import type { Repo } from '../db/repo'
import type { AgentTab } from '../host/client'
import { splitLines, type Analysis, type GuardedRunner } from './runner'
import type { ProductivityStore } from './store'

const PLAN_TTL_MS = 10 * 60_000
const MAX_PLANS = 100

interface StoredPlan {
  planId: string
  /** The window that asked for the preview; only it may run the plan. */
  owner?: object
  tabId: string
  /** The tab and session as prepared, for audit rows when the plan never runs (expired, window closed, tab gone). */
  tab: AgentTab
  snippetName: string
  analysis: Analysis
  hostname: string
  expires: number
}

/**
 * Snippets and button-bar buttons. The renderer sends only ids and variable values: main reads
 * the body from its own store, fills it, and the guard sees the final text. A run is two steps:
 * `prepare` (classify, show the user what will run) and `run(planId)`, which runs exactly the
 * stored lines after classifying them again. Nothing is audited until something runs or is refused,
 * or a preview is dropped unrun (expired, or its window closed: review A2).
 */
export class SnippetService {
  private plans = new Map<string, StoredPlan>()

  constructor(
    private readonly store: ProductivityStore,
    private readonly runner: GuardedRunner,
    private readonly repo: Pick<Repo, 'listFolders'>
  ) {}

  private body(snippetId: string, tabId: string, vars: Record<string, string>, session: { id: string; folderId: string | null; platform: string }) {
    const s = this.store.snippet(snippetId)
    if (!s) throw new Error('This snippet no longer exists')
    if (!snippetApplies(s, session as never, this.repo.listFolders())) throw new Error(`“${s.name}” does not apply to this session (scope or platform)`)
    const filled = fillSnippet(s.body, vars)
    if ('error' in filled) throw new Error(filled.error)
    const split = splitLines(filled.text)
    if ('error' in split) throw new Error(`“${s.name}”: ${split.error}`)
    void tabId
    return { snippet: s, lines: split.lines }
  }

  async prepare(req: { snippetId: string; tabId: string; vars: Record<string, string> }, owner?: object): Promise<CommandPlan> {
    const tab = this.runner.term.get(req.tabId)
    if (!tab) throw new Error('The tab is closed')
    const { snippet, lines } = this.body(req.snippetId, req.tabId, req.vars, tab.session)
    // Insert snippets are typed for the user, never run from here.
    if (snippet.mode !== 'run') throw new Error(`“${snippet.name}” is an insert snippet; it is typed at the prompt, not run`)
    const r = await this.runner.analyze(req.tabId, lines)
    if (!r) throw new Error('The tab is closed')
    const now = Date.now()
    this.expire(now)
    while (this.plans.size >= MAX_PLANS) this.drop(this.plans.keys().next().value!, 'the preview was dropped (too many open previews) before it was run')
    const planId = randomUUID()
    this.plans.set(planId, { planId, ...(owner ? { owner } : {}), tabId: req.tabId, tab: r.tab, snippetName: snippet.name, analysis: r.analysis, hostname: r.hostname, expires: now + PLAN_TTL_MS })
    const a = r.analysis
    return {
      planId,
      kind: a.kind,
      reason: a.reason,
      lines: a.lines,
      wrapper: a.wrapper,
      confirm: a.kind === 'disruptive' ? r.hostname || undefined : undefined,
      sessionName: r.tab.session.name,
      platform: r.tab.session.platform,
      hostname: r.hostname
    }
  }

  /** Run a prepared plan. `approve`: the user confirmed it (config, disruptive); false records a rejection. */
  /**
   * `owns`: the tab is still shown in the asking window, checked again at run time (review A1: a
   * tab can move or close between the preview and the click).
   */
  async run(req: { planId: string; approve: boolean; ack?: string }, owner?: object, owns?: (tabId: string) => boolean): Promise<CommandRunResult> {
    this.expire()
    const p = this.plans.get(req.planId)
    if (!p || p.owner !== owner) throw new Error('This preview expired. Run the snippet again.')
    this.plans.delete(req.planId)
    const opts = { source: 'snippet' as const, approved: req.approve, ack: req.ack, hostname: p.hostname, note: `snippet “${p.snippetName}”`, session: p.tab.session }
    if (owns && !owns(p.tabId)) return this.runner.refuse(p.tab, p.analysis, opts, 'refused', 'the tab is no longer open in this window')
    const tab = this.runner.term.get(p.tabId)
    if (!tab) return this.runner.refuse(p.tab, p.analysis, opts, 'refused', 'the tab is closed')
    // Blocked and refused plans are recorded when the user tries to run them; a declined config plan as rejected.
    if (p.analysis.kind === 'blocked') return this.runner.refuse(tab, p.analysis, opts, 'blocked', p.analysis.reason)
    if (p.analysis.kind === 'refused') return this.runner.refuse(tab, p.analysis, opts, 'refused', p.analysis.reason)
    if (!req.approve && p.analysis.kind !== 'read') return this.runner.refuse(tab, p.analysis, opts, 'rejected', 'rejected by user')
    return this.runner.run(p.tabId, p.analysis, opts)
  }

  /** Drop expired previews, each audited (review A2). */
  private expire(now = Date.now()): void {
    for (const [id, p] of this.plans) if (p.expires < now) this.drop(id, 'the preview expired before it was run')
  }

  /** A window closed or reloaded: its previews will never run (audited, review A2). */
  dropFor(owner: object): void {
    for (const [id, p] of this.plans) if (p.owner === owner) this.drop(id, 'the window closed before the preview was run')
  }

  private drop(id: string, reason: string): void {
    const p = this.plans.get(id)
    if (!p) return
    this.plans.delete(id)
    const opts = { source: 'snippet' as const, note: `snippet “${p.snippetName}”` }
    for (const l of p.analysis.lines.length ? p.analysis.lines : [{ command: '(empty)', kind: p.analysis.kind }]) this.runner.record(p.tab, l.command, l.kind, 'cancelled', reason, opts)
  }

  /**
   * Insert mode: the filled text to type at the prompt without Enter (the user presses Enter, so it
   * is the user's command). One line only; blocked commands are refused here too.
   */
  async insert(req: { snippetId: string; tabId: string; vars: Record<string, string> }): Promise<{ text: string; kind: string; reason: string }> {
    const tab = this.runner.term.get(req.tabId)
    if (!tab) throw new Error('The tab is closed')
    const { snippet, lines } = this.body(req.snippetId, req.tabId, req.vars, tab.session)
    if (snippet.mode !== 'insert') throw new Error(`“${snippet.name}” is a run snippet`)
    if (lines.length !== 1) throw new Error(`“${snippet.name}” has ${lines.length} lines; insert types one line. Make it a run snippet instead`)
    const r = await this.runner.analyze(req.tabId, lines)
    if (!r) throw new Error('The tab is closed')
    const opts = { source: 'snippet' as const, approved: false, note: `snippet “${snippet.name}”` }
    if (r.analysis.kind === 'blocked') {
      this.runner.record(r.tab, lines[0]!, 'blocked', 'blocked', `insert refused: ${r.analysis.reason}`, opts)
      throw new Error(`Blocked: ${r.analysis.reason}`)
    }
    // Typed at the prompt without Enter: the user presses Enter, but the insert itself is on record.
    this.runner.record(r.tab, lines[0]!, r.analysis.lines[0]?.kind ?? r.analysis.kind, 'inserted', `inserted at the prompt without Enter (${r.analysis.kind})`, opts)
    return { text: lines[0]!, kind: r.analysis.kind, reason: r.analysis.reason }
  }
}
