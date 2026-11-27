import { create } from 'zustand'
import type { Session } from '@shared/types'
import { WORKSPACE_QUESTION_MAX, type WorkspaceChatReply, type WorkspaceDeviceSuggestion } from '@shared/workspace-chat'
import { notifyError, openSession } from '../../lib/connect'
import { errorText } from '../../lib/errors'
import { markChecklist } from '../../lib/checklist'
import { activeTab, useUi, type Tab } from '../../store'
import { usePackets } from '../packets/store'
import { useDrafts } from './drafts'
import { useAi } from './store'

// A live connection can outlive edits to its saved endpoint. Reuse only a matching connection.
const tabEndpoints = new Map<string, string>()
const endpointOf = (session: Session) => JSON.stringify([session.protocol, session.host, session.port, session.username])
export function recommendedTab(tabs: Tab[], activeId: string | null, session: Session) {
  const endpoint = endpointOf(session)
  const matches = tabs.filter((t) => t.sessionId === session.id && tabEndpoints.get(t.tabId) === endpoint)
  return matches.find((t) => t.tabId === activeId) ?? matches.find((t) => t.state === 'connected') ?? matches[0]
}

type Handoff = { tabId: string; status: 'waiting' | 'sent' | 'failed'; error?: string }
export interface WorkspaceTurn {
  id: string
  question: string
  reply?: WorkspaceChatReply
  error?: string
  handoffs: Record<string, Handoff>
}

interface WorkspaceChatState {
  turns: WorkspaceTurn[]
  draft: string
  scope: 'workspace' | 'device'
  focusRequest: boolean
  pendingId: string | null
  waitingForModel: boolean
  resetting: boolean
}

export const useWorkspaceChat = create<WorkspaceChatState>(() => ({
  turns: [], draft: '', scope: 'device', focusRequest: false, pendingId: null, waitingForModel: false, resetting: false
}))

export function showWorkspaceChat() {
  usePackets.setState({ chat: false })
  useWorkspaceChat.setState({ scope: 'workspace', focusRequest: true })
  useUi.getState().set({ aiOpen: true })
}

export function selectDeviceChat() {
  usePackets.setState({ chat: false })
  useWorkspaceChat.setState({ scope: 'device', focusRequest: false })
}

function updateTurn(id: string, edit: (t: WorkspaceTurn) => WorkspaceTurn) {
  useWorkspaceChat.setState((s) => ({ turns: s.turns.map((t) => t.id === id ? edit(t) : t) }))
}

async function dispatchWorkspaceQuestion(id: string, question: string) {
  useWorkspaceChat.setState({ waitingForModel: false })
  try {
    markChecklist('assistant')
    const reply = await window.hopline.workspaceChat.ask({ question })
    if (useWorkspaceChat.getState().pendingId === id) updateTurn(id, (t) => ({ ...t, reply }))
  } catch (err) {
    if (useWorkspaceChat.getState().pendingId === id) updateTurn(id, (t) => ({ ...t, error: errorText(err) }))
  } finally {
    if (useWorkspaceChat.getState().pendingId === id) useWorkspaceChat.setState({ pendingId: null })
  }
}

export function askWorkspace(text: string) {
  const state = useWorkspaceChat.getState()
  const question = text.trim()
  if (!question || question.length > WORKSPACE_QUESTION_MAX || state.pendingId || state.resetting) return
  const id = crypto.randomUUID()
  const waitingForModel = !useUi.getState().settings?.aiConfigured
  useWorkspaceChat.setState({
    turns: [...state.turns, { id, question, handoffs: {} }], draft: '', pendingId: id, waitingForModel
  })
  if (!waitingForModel) void dispatchWorkspaceQuestion(id, question)
}

export async function stopWorkspaceQuestion() {
  const { pendingId, waitingForModel } = useWorkspaceChat.getState()
  if (!pendingId) return
  try {
    if (!waitingForModel) await window.hopline.workspaceChat.cancel()
    if (useWorkspaceChat.getState().pendingId !== pendingId) return
    updateTurn(pendingId, (t) => ({ ...t, error: 'Question stopped.' }))
    useWorkspaceChat.setState({ pendingId: null, waitingForModel: false })
  } catch (e) { notifyError('Could not stop the question', e) }
}

export async function resetWorkspaceChat() {
  const { pendingId, resetting } = useWorkspaceChat.getState()
  if (pendingId || resetting) return
  useWorkspaceChat.setState({ resetting: true })
  try {
    await window.hopline.workspaceChat.reset()
    useWorkspaceChat.setState({ turns: [], draft: '' })
  } catch (e) { notifyError('Could not start a new conversation', e) }
  finally { useWorkspaceChat.setState({ resetting: false }) }
}

function saveHandoff(turnId: string, sessionId: string, handoff: Handoff) {
  updateTurn(turnId, (t) => ({ ...t, handoffs: { ...t.handoffs, [sessionId]: handoff } }))
}

export function pendingCheck(turns: WorkspaceTurn[], tabId: string) {
  for (const turn of turns) {
    const device = turn.reply?.devices.find((d) => {
      const handoff = turn.handoffs[d.sessionId]
      return handoff?.status === 'waiting' && handoff.tabId === tabId
    })
    if (device) return { turnId: turn.id, device }
  }
  return undefined
}

export function cancelHandoff(turnId: string, sessionId: string, tabId: string) {
  saveHandoff(turnId, sessionId, { tabId, status: 'failed', error: 'Check cancelled.' })
}

function dispatchHandoff(turn: WorkspaceTurn, tab: Tab, device: WorkspaceDeviceSuggestion, operatorReady = false) {
  const session = useUi.getState().sessions.find((s) => s.id === device.sessionId)
  if (!session || tab.sessionId !== session.id) return
  if (tabEndpoints.get(tab.tabId) !== endpointOf(session)) {
    saveHandoff(turn.id, session.id, { tabId: tab.tabId, status: 'failed', error: 'Saved connection details changed. Review the destination and try again.' })
    return
  }
  if (tab.state !== 'connected' || session.platform === 'auto') return
  // A connected Telnet socket or serial port may still be waiting at its login prompt.
  if (session.protocol !== 'ssh' && !operatorReady) return
  if (useAi.getState().byTab[tab.tabId]?.runId || useAi.getState().byTab[tab.tabId]?.waiting) return
  saveHandoff(turn.id, session.id, { tabId: tab.tabId, status: 'sent' })
  void useAi.getState().ask(tab.tabId, device.question)
}

export function confirmHandoff(tab: Tab) {
  const state = useWorkspaceChat.getState()
  const pending = pendingCheck(state.turns, tab.tabId)
  const turn = state.turns.find((t) => t.id === pending?.turnId)
  if (pending && turn) dispatchHandoff(turn, tab, pending.device, true)
}

export function openRecommendedDevice(turnId: string, device: WorkspaceDeviceSuggestion) {
  const turn = useWorkspaceChat.getState().turns.find((t) => t.id === turnId)
  const session = useUi.getState().sessions.find((s) => s.id === device.sessionId)
  if (!turn || !session) return
  const previous = turn.handoffs[session.id]
  if (previous && previous.status !== 'failed' && useUi.getState().tabs.some((t) => t.tabId === previous.tabId && t.sessionId === session.id)) {
    useUi.getState().activate(previous.tabId)
    selectDeviceChat()
    return
  }
  const ui = useUi.getState()
  const open = recommendedTab(ui.tabs, ui.activeTabId, session)
  if (open) ui.activate(open.tabId)
  else openSession(session)
  const tab = activeTab(useUi.getState())
  if (!tab || tab.sessionId !== session.id) return
  selectDeviceChat()
  if (pendingCheck(useWorkspaceChat.getState().turns, tab.tabId)) return
  saveHandoff(turnId, session.id, { tabId: tab.tabId, status: 'waiting' })
  if (tab.state === 'down' || tab.state === 'idle') {
    void window.hopline.term.reconnect(tab.tabId).catch((err) => {
      if (useWorkspaceChat.getState().turns.find((t) => t.id === turnId)?.handoffs[session.id]?.status === 'waiting') {
        saveHandoff(turnId, session.id, { tabId: tab.tabId, status: 'failed', error: errorText(err) })
      }
    })
  } else dispatchHandoff(turn, tab, device)
}

export function wireWorkspaceChat() {
  useUi.subscribe((ui, before) => {
    if (ui.tabs !== before.tabs) {
      const live = new Set(ui.tabs.map((t) => t.tabId))
      for (const tab of ui.tabs) {
        if (tabEndpoints.has(tab.tabId)) continue
        const session = ui.sessions.find((s) => s.id === tab.sessionId)
        if (session) tabEndpoints.set(tab.tabId, endpointOf(session))
      }
      for (const id of tabEndpoints.keys()) if (!live.has(id)) tabEndpoints.delete(id)
    }
    const { turns, waitingForModel, pendingId } = useWorkspaceChat.getState()
    if (waitingForModel && ui.settings?.aiConfigured && !before.settings?.aiConfigured) {
      const turn = turns.find((t) => t.id === pendingId)
      if (turn) void dispatchWorkspaceQuestion(turn.id, turn.question)
    }
    if (ui.tabs === before.tabs && ui.sessions === before.sessions) return
    for (const turn of turns) {
      for (const device of turn.reply?.devices ?? []) {
        const handoff = turn.handoffs[device.sessionId]
        if (handoff?.status !== 'waiting') continue
        const tab = ui.tabs.find((t) => t.tabId === handoff.tabId && t.sessionId === device.sessionId)
        if (!tab || !ui.sessions.some((s) => s.id === device.sessionId) || (tab.state === 'down' && before.tabs.find((t) => t.tabId === tab.tabId)?.state !== 'down')) {
          saveHandoff(turn.id, device.sessionId, { ...handoff, status: 'failed', error: tab?.detail || 'Connection closed before the question was sent.' })
        } else dispatchHandoff(turn, tab, device)
      }
    }
  })
  // “Attach to AI” can originate in a command block or in terminal history.
  useDrafts.subscribe((s, prev) => {
    const id = useUi.getState().activeTabId
    if (id && s.byTab[id]?.attachment && s.byTab[id]?.attachment !== prev.byTab[id]?.attachment) selectDeviceChat()
  })
}
