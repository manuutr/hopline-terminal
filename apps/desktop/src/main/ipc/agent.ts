import type { Agent } from '../agent/agent'
import { handler as h, registerAll, type Handler } from '.'
import * as S from './schemas'

/** Whether a tab is shown in the window that sent the request (`SessionHostClient.ownedBy`). */
export type Owns = (tabId: string, sender: unknown) => boolean

type AgentIpc = Pick<Agent, 'start' | 'cancel' | 'decide' | 'reset' | 'changeAction' | 'runSuggestion' | 'tabOf'>

/**
 * Exported by channel for the IPC contract test. Every handler checks that the asking window owns
 * the tab the request is about (review L9), as snippets and blocks do: a run, a card's decision, a
 * change's confirm or rollback, or a suggestion of another window's tab is refused. An unknown id
 * passes through, and the agent refuses it with its own message.
 */
export function agentHandlers(agent: AgentIpc, owns: Owns = () => true): Record<string, Handler> {
  const mine = (tabId: string | undefined, sender: unknown) => {
    if (tabId !== undefined && !owns(tabId, sender)) throw new Error('This session is not open in this window')
  }
  return {
    'agent:run': h(S.AgentRequest, (req, e) => (mine(req.tabId, e.sender), agent.start(req))),
    'agent:cancel': h(S.Id, (runId, e) => (mine(agent.tabOf('run', runId), e.sender), agent.cancel(runId))),
    'agent:decide': h(S.Decide, ({ proposalId, approve, ack, lines }, e) => (mine(agent.tabOf('proposal', proposalId), e.sender), agent.decide(proposalId, approve, 'user', ack, lines))),
    'agent:change': h(S.ChangeAction, ({ proposalId, action }, e) => (mine(agent.tabOf('proposal', proposalId), e.sender), agent.changeAction(proposalId, action))),
    // A reset only clears state: for a tab this window does not own (or that already closed) it is a no-op.
    'agent:reset': h(S.Id, (tabId, e) => (owns(tabId, e.sender) ? agent.reset(tabId) : undefined)),
    'agent:runSuggestion': h(S.Id, (id, e) => (mine(agent.tabOf('suggestion', id), e.sender), agent.runSuggestion(id)))
  }
}

export function registerAgentIpc(agent: Agent, owns: Owns): void {
  registerAll(agentHandlers(agent, owns))
}
