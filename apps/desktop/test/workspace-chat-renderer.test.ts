import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Settings } from '@shared/types'
import type { WorkspaceChatReply } from '@shared/workspace-chat'

const device = { sessionId: 'core', name: 'Core', reason: 'Saved core switch.', question: 'Check interface status.' }
const reply: WorkspaceChatReply = { text: 'Start at Core.', devices: [device] }
const ask = vi.fn(async () => reply)
const run = vi.fn(async () => ({ runId: 'run' }))
const close = vi.fn(async () => {})
vi.stubGlobal('window', {
  hopline: { agent: { run, onEvent: () => () => {} }, workspaceChat: { ask }, term: { close } },
  addEventListener: () => {}
})

const { useUi, activeTab } = await import('../src/renderer/src/store')
const { useAi, wireAgentEvents } = await import('../src/renderer/src/features/ai/store')
const { askWorkspace, stopWorkspaceQuestion, openRecommendedDevice, confirmHandoff, useWorkspaceChat } = await import('../src/renderer/src/features/ai/workspace-chat')
wireAgentEvents()

const saved = { id: 'core', name: 'Core', host: '10.0.0.1', protocol: 'ssh', port: 22, username: 'operator', platform: 'ios' } as Session
const settings = (aiConfigured: boolean) => ({ aiConfigured }) as Settings
const currentTab = () => activeTab(useUi.getState())!
const newTurn = async () => {
  askWorkspace('Check interfaces on core')
  await vi.waitFor(() => expect(useWorkspaceChat.getState().pendingId).toBeNull())
  return useWorkspaceChat.getState().turns.at(-1)!.id
}

describe('workspace chat and device handoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceChat.setState(useWorkspaceChat.getInitialState())
    useAi.setState({ byTab: {} })
    useUi.setState({ ...useUi.getInitialState(), sessions: [saved], settings: settings(true) })
  })

  it('sends a queued question once after model setup and keeps a new draft', async () => {
    useUi.setState({ settings: settings(false) })
    askWorkspace('Which switch?')
    askWorkspace('Another question')
    useWorkspaceChat.setState({ draft: 'A follow-up for later' })
    expect(ask).not.toHaveBeenCalled()
    expect(useWorkspaceChat.getState().waitingForModel).toBe(true)
    useUi.setState({ settings: settings(true) })
    await vi.waitFor(() => expect(useWorkspaceChat.getState().pendingId).toBeNull())
    expect(ask).toHaveBeenCalledExactlyOnceWith({ question: 'Which switch?' })
    expect(useWorkspaceChat.getState().turns).toHaveLength(1)
    expect(useWorkspaceChat.getState().draft).toBe('A follow-up for later')
    expect(useUi.getState().tabs).toHaveLength(0)
  })

  it('never sends a cancelled model-setup question', async () => {
    useUi.setState({ settings: settings(false) })
    askWorkspace('Which switch?')
    await stopWorkspaceQuestion()
    useUi.setState({ settings: settings(true) })
    expect(ask).not.toHaveBeenCalled()
    expect(useWorkspaceChat.getState().pendingId).toBeNull()
  })

  it('waits for connection and platform, follows the chosen tab and sends only once', async () => {
    useUi.setState({ sessions: [{ ...saved, platform: 'auto' }] })
    const id = await newTurn()
    openRecommendedDevice(id, device)
    const { tabId } = currentTab()
    expect(run).not.toHaveBeenCalled()
    useUi.getState().updateTab({ tabId, state: 'connected' })
    expect(run).not.toHaveBeenCalled()
    useUi.setState({ sessions: [saved] })
    await vi.waitFor(() => expect(run).toHaveBeenCalledExactlyOnceWith({ tabId, prompt: device.question, selection: undefined }))
    openRecommendedDevice(id, device)
    expect(useUi.getState().tabs).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each(['closed', 'down', 'moved'] as const)('drops a queued check when its destination is %s', async (failure) => {
    const id = await newTurn()
    openRecommendedDevice(id, device)
    const { tabId } = currentTab()
    if (failure === 'closed') useUi.getState().closeTab(tabId)
    else if (failure === 'down') useUi.getState().updateTab({ tabId, state: 'down', detail: 'Authentication failed' })
    else useUi.setState({ sessions: [{ ...saved, host: '10.0.0.2' }] })
    useUi.getState().updateTab({ tabId, state: 'connected' })
    expect(run).not.toHaveBeenCalled()
    expect(useWorkspaceChat.getState().turns[0]!.handoffs.core?.status).toBe('failed')
    if (failure === 'moved') {
      openRecommendedDevice(id, device)
      expect(currentTab().tabId).not.toBe(tabId)
    }
  })

  it('asks in an existing device conversation and never duplicates the connection', async () => {
    useUi.getState().addTab({ tabId: 'already-connected', sessionId: saved.id, title: saved.name, state: 'connected' })
    openRecommendedDevice(await newTurn(), device)
    expect(run).toHaveBeenCalledExactlyOnceWith({ tabId: 'already-connected', prompt: device.question, selection: undefined })
    expect(useUi.getState().tabs).toHaveLength(1)
  })

  it('waits for the operator on a connected serial console with an interactive login', async () => {
    useUi.setState({ sessions: [{ ...saved, protocol: 'serial' }] })
    openRecommendedDevice(await newTurn(), device)
    useUi.getState().updateTab({ tabId: currentTab().tabId, state: 'connected' })
    expect(run).not.toHaveBeenCalled()
    confirmHandoff(currentTab())
    expect(run).toHaveBeenCalledTimes(1)
  })
})
