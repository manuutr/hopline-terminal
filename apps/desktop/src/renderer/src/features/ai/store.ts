import { create } from 'zustand'
import type { AgentEvent, AgentSuggestion, ChangeNet, ChangeUpdate, StepStatus } from '@shared/types'
import { useUi } from '../../store'
import { useTrust } from '../trust/store'
import { markChecklist } from '../../lib/checklist'
import { selectDeviceChat, wireWorkspaceChat } from './workspace-chat'

export type Entry =
  | { kind: 'user'; id: string; text: string; selection?: boolean }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | { kind: 'step'; id: string; command: string; status: StepStatus; cmdKind?: string; reason?: string; durationMs?: number; bytes?: number; preview?: string; filter?: string; filterNote?: string }
  | {
      kind: 'proposal'
      id: string
      commands: string[]
      rationale: string
      wrapper?: { before: string[]; after: string[]; abort?: string[] }
      disruptive?: { reasons: string[]; confirm: string }
      exec?: boolean
      /** Proposals v2 (ProposalCard.tsx). */
      rollback?: string[]
      verify?: { command: string; expect: string }[]
      net?: ChangeNet
      copied?: { section: 'commands' | 'rollback' | 'verify'; index: number; from: string }[]
      notice?: string
      unknown?: number[]
      groups?: { head: number; members: number[] }[]
      /** After the approval: the applied change (arm, apply, verify, confirm or rollback). */
      change?: ChangeUpdate
      state: 'pending' | 'approved' | 'rejected' | 'expired'
      /** Why an expired proposal closed without a decision here (timeout, cancel, run ended). */
      closed?: string
    }
  | { kind: 'error'; id: string; text: string }
  /** Suggest mode: commands the model proposed; each runs (in main, by id) only when clicked. */
  | { kind: 'suggestions'; id: string; items: AgentSuggestion[]; ran: string[] }

/** The per-run token budget meter (Trust UX). */
export interface RunUsage {
  used: number
  budget: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  closing?: boolean
}

interface Thread {
  entries: Entry[]
  /** The last run's token use against its budget. */
  usage?: RunUsage
  /** The last run was on a model without tool calling. */
  suggest?: boolean
  /** 'pending' between asking and main returning the run id. */
  runId?: string
  /** F2: asked before any provider was connected; sent as soon as one is. */
  waiting?: { prompt: string; selection?: string; entryId: string }
}

interface AiState {
  byTab: Record<string, Thread>
  ask: (tabId: string, prompt: string, selection?: string) => Promise<void>
  /** Send every question that waited for a provider (called when one gets connected). */
  flushWaiting: () => void
  cancel: (tabId: string) => void
  reset: (tabId: string) => void
  /**
   * `ack`: the hostname typed for a disruptive proposal (main checks it; a mismatch keeps it
   * pending). `lines`: the ticked line indexes (main re-checks the subset).
   */
  decide: (tabId: string, proposalId: string, approve: boolean, ack?: string, lines?: number[]) => Promise<void>
  /** Confirm or roll back an applied change. */
  act: (proposalId: string, action: 'confirm' | 'rollback') => Promise<void>
  /** Suggest mode: run one suggestion by id (main holds the command). */
  runSuggestion: (tabId: string, entryId: string, suggestionId: string) => Promise<void>
  apply: (e: AgentEvent) => void
}

const uid = () => crypto.randomUUID()

/** Main's answer when a proposal already timed out, was cancelled or was decided elsewhere. */
export const NO_LONGER_OPEN = 'This proposal is no longer open'

const CLOSED_TEXT: Record<'timeout' | 'cancelled' | 'run-ended' | 'gone', string> = {
  timeout: 'The approval timed out. Nothing was applied.',
  cancelled: 'The run was cancelled. Nothing was applied.',
  'run-ended': 'The run ended. Nothing was applied.',
  gone: `${NO_LONGER_OPEN}. Nothing was applied.`
}

/** Close every still-pending proposal (or just `id`) as expired, with the reason shown on the card. */
function expire(entries: Entry[], why: keyof typeof CLOSED_TEXT, id?: string): Entry[] {
  return entries.map((e) => (e.kind === 'proposal' && e.state === 'pending' && (id === undefined || e.id === id) ? { ...e, state: 'expired', closed: CLOSED_TEXT[why] } : e))
}

export const useAi = create<AiState>((set, get) => {
  const patch = (tabId: string, f: (t: Thread) => Thread) =>
    set((s) => ({ byTab: { ...s.byTab, [tabId]: f(s.byTab[tabId] ?? { entries: [] }) } }))

  /** Start a run whose user entry is already shown. */
  const run = async (tabId: string, prompt: string, selection?: string) => {
    try {
      markChecklist('assistant')
      const { runId } = await window.hopline.agent.run({ tabId, prompt, selection })
      // Events may already have arrived (or the run may already be done): only fill in a still-pending id.
      patch(tabId, (t) => (t.runId === 'pending' ? { ...t, runId } : t))
    } catch (e) {
      const text = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      patch(tabId, (t) => ({ ...t, runId: undefined, entries: [...t.entries, { kind: 'error', id: uid(), text }] }))
    }
  }

  return {
    byTab: {},

    ask: async (tabId, prompt, selection) => {
      const cur = get().byTab[tabId]
      if (cur?.runId) return
      const user: Entry = { kind: 'user', id: uid(), text: prompt, selection: !!selection }
      if (!useUi.getState().settings?.aiConfigured) {
        // No dead end: open the panel on the connect card and keep the question for after.
        // Asking again before connecting replaces the waiting question (the last one wins).
        patch(tabId, (t) => ({
          ...t,
          waiting: { prompt, selection, entryId: user.id },
          entries: [...t.entries.filter((e) => e.id !== t.waiting?.entryId), user]
        }))
        useUi.getState().set({ aiOpen: true })
        return
      }
      patch(tabId, (t) => ({ ...t, runId: 'pending', entries: [...t.entries, user] }))
      await run(tabId, prompt, selection)
    },

    flushWaiting: () => {
      for (const [tabId, t] of Object.entries(get().byTab)) {
        if (!t.waiting || t.runId) continue
        const { prompt, selection } = t.waiting
        patch(tabId, (x) => ({ ...x, waiting: undefined, runId: 'pending' }))
        void run(tabId, prompt, selection)
      }
    },


    cancel: (tabId) => {
      const runId = get().byTab[tabId]?.runId
      if (runId && runId !== 'pending') void window.hopline.agent.cancel(runId)
    },

    reset: (tabId) => {
      void window.hopline.agent.reset(tabId)
      patch(tabId, () => ({ entries: [] }))
    },

    act: (proposalId, action) => window.hopline.agent.change(proposalId, action),

    decide: async (tabId, proposalId, approve, ack, lines) => {
      try {
        await window.hopline.agent.decide(proposalId, approve, ack, lines)
      } catch (e) {
        // Timed out or cancelled in main before this click: the card must not claim a decision.
        if (e instanceof Error && e.message.includes(NO_LONGER_OPEN)) {
          patch(tabId, (t) => ({ ...t, entries: expire(t.entries, 'gone', proposalId) }))
          return
        }
        throw e
      }
      patch(tabId, (t) => ({
        ...t,
        entries: t.entries.map((e) => (e.kind === 'proposal' && e.id === proposalId && e.state === 'pending' ? { ...e, state: approve ? 'approved' : 'rejected' } : e))
      }))
    },

    runSuggestion: async (tabId, entryId, suggestionId) => {
      const cur = get().byTab[tabId]
      if (cur?.runId) return
      patch(tabId, (t) => ({
        ...t,
        runId: 'pending',
        entries: t.entries.map((x) => (x.kind === 'suggestions' && x.id === entryId ? { ...x, ran: [...x.ran, suggestionId] } : x))
      }))
      try {
        const { runId } = await window.hopline.agent.runSuggestion(suggestionId)
        patch(tabId, (t) => (t.runId === 'pending' ? { ...t, runId } : t))
      } catch (e) {
        const text = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
        patch(tabId, (t) => ({ ...t, runId: undefined, entries: [...t.entries, { kind: 'error', id: uid(), text }] }))
      }
    },

    apply: (e) => {
      const tabId = e.tabId
      if (!tabId) return
      // The agent drives this tab from its first step or card until the run is done: the terminal
      // must not adopt its echoed commands as the user's line (autocomplete, "@ai").
      if (e.type === 'step' || e.type === 'proposal') {
        if (!useUi.getState().tabs.find((t) => t.tabId === tabId)?.agentBusy) useUi.getState().updateTab({ tabId, agentBusy: true })
      } else if (e.type === 'done') {
        useUi.getState().updateTab({ tabId, agentBusy: false })
        // A failed run (Ollama stopped, a network error): check the provider again, so the trust
        // bar's dot does not stay green after a failure (review P2).
        if (e.error) void useTrust.getState().checkHealth()
      }
      if (e.type === 'change') {
        // May arrive after the run ended (a confirm from the card): it never marks a run active.
        const { type: _t, runId: _r, tabId: _tab, proposalId, ...u } = e
        patch(tabId, (t) => ({ ...t, entries: t.entries.map((x) => (x.kind === 'proposal' && x.id === proposalId ? { ...x, state: x.state === 'pending' ? 'approved' : x.state, change: u } : x)) }))
        return
      }
      patch(tabId, (t0) => {
        const t = e.type === 'done' ? t0 : { ...t0, runId: e.runId }
        const entries = [...t.entries]
        const last = entries.at(-1)
        switch (e.type) {
          case 'text':
          case 'thinking': {
            const target =
              last?.kind === 'assistant' ? { ...last } : ({ kind: 'assistant', id: uid(), text: '', thinking: '' } as Extract<Entry, { kind: 'assistant' }>)
            if (e.type === 'text') target.text += e.text
            else target.thinking += e.text
            if (last?.kind === 'assistant') entries[entries.length - 1] = target
            else entries.push(target)
            return { ...t, entries }
          }
          case 'step': {
            const i = entries.findIndex((x) => x.kind === 'step' && x.id === e.stepId)
            const prev = i >= 0 ? (entries[i] as Extract<Entry, { kind: 'step' }>) : undefined
            const step: Entry = {
              kind: 'step',
              id: e.stepId,
              command: e.command,
              status: e.status,
              cmdKind: e.kind,
              reason: e.reason ?? prev?.reason,
              filter: e.filter ?? prev?.filter,
              filterNote: e.filterNote ?? prev?.filterNote,
              durationMs: e.durationMs,
              bytes: e.bytes,
              preview: e.preview
            }
            if (i >= 0) entries[i] = step
            else entries.push(step)
            return { ...t, entries }
          }
          case 'proposal':
            entries.push({ kind: 'proposal', id: e.proposalId, commands: e.commands, rationale: e.rationale, wrapper: e.wrapper, disruptive: e.disruptive, exec: e.exec, rollback: e.rollback, verify: e.verify, net: e.net, copied: e.copied, notice: e.notice, unknown: e.unknown, groups: e.groups, state: 'pending' })
            return { ...t, entries }
          case 'proposal-closed':
            // 'decided': the click that decided it updates the card (approved/rejected).
            if (e.reason === 'decided') return t
            return { ...t, entries: expire(entries, e.reason, e.proposalId) }
          case 'done':
            if (e.error) entries.push({ kind: 'error', id: uid(), text: e.error })
            return { entries: expire(entries, 'run-ended'), runId: undefined, usage: t.usage, suggest: t.suggest }
          case 'usage':
            return { ...t, usage: { used: e.used, budget: e.budget, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd, closing: e.closing } }
          case 'mode':
            return { ...t, suggest: e.suggest }
          case 'suggestions':
            entries.push({ kind: 'suggestions', id: uid(), items: e.items, ran: [] })
            return { ...t, entries }
          default:
            return t
        }
      })
    }
  }
})

let wired = false
export function wireAgentEvents(): void {
  if (wired) return
  wired = true
  wireWorkspaceChat()
  window.hopline.agent.onEvent((e) => useAi.getState().apply(e))
  // A provider just got connected (panel card or Settings): send the questions that waited for it.
  useUi.subscribe((s, prev) => {
    if (s.settings?.aiConfigured && !prev.settings?.aiConfigured) useAi.getState().flushWaiting()
  })
  // "@ai" from the terminal and "Explain this output". Wired here, not in the panel, so they work while it is collapsed.
  window.addEventListener('hopline:explain', (ev) => {
    const { tabId, text } = (ev as CustomEvent<{ tabId: string; text: string }>).detail
    selectDeviceChat()
    useUi.getState().set({ aiOpen: true })
    void useAi.getState().ask(tabId, 'Explain this output. Point out anything abnormal.', text)
  })
  window.addEventListener('hopline:ask', (ev) => {
    const { tabId, text } = (ev as CustomEvent<{ tabId: string; text: string }>).detail
    selectDeviceChat()
    void useAi.getState().ask(tabId, text)
  })
}
