import { WORKSPACE_QUESTION_MAX, type WorkspaceDeviceSuggestion } from '@shared/workspace-chat'
import { ArrowUp, ArrowUpRight, CircleStop, ListChecks, MessageSquare, Network, Route } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../design'
import { folderPath } from '../../lib/connect'
import { useUi, type Tab } from '../../store'
import { AiSetup } from './AiSetup'
import { Markdown } from './Markdown'
import { askWorkspace, cancelHandoff, confirmHandoff, openRecommendedDevice, pendingCheck, stopWorkspaceQuestion, useWorkspaceChat, recommendedTab, type WorkspaceTurn } from './workspace-chat'

function RecommendedDevice({ turn, device }: { turn: WorkspaceTurn; device: WorkspaceDeviceSuggestion }) {
  const session = useUi((s) => s.sessions.find((item) => item.id === device.sessionId))
  const previous = turn.handoffs[device.sessionId]
  const previousTab = useUi((s) => previous && s.tabs.find((t) => t.tabId === previous.tabId && t.sessionId === device.sessionId))
  const open = useUi((s) => session && recommendedTab(s.tabs, s.activeTabId, session))
  const folder = useUi((s) => session && folderPath(s.folders, session.folderId))
  const otherPending = useWorkspaceChat((s) => {
    const pending = open && pendingCheck(s.turns, open.tabId)
    return !!pending && pending.turnId !== turn.id
  })
  const existing = !!previousTab && previous?.status !== 'failed'
  const label = existing ? 'Open device conversation' : open?.state === 'connected' ? 'Ask' : 'Connect and ask'
  const name = session?.name ?? device.name
  return (
    <div className="min-w-0 rounded-md border border-line bg-raised px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Network aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
        <span className="truncate font-medium text-fg" title={name}>{name}</span>
      </div>
      {session && <div className="mt-1 break-words text-2xs text-fg-muted">
        <span className="font-mono">{session.protocol.toUpperCase()} · {session.host}{session.protocol !== 'serial' && ':' + session.port}</span>{folder && ' · ' + folder}
      </div>}
      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{device.reason}</p>
      <p className="my-2 border-l-2 border-line-strong pl-2 text-xs leading-relaxed text-fg">{device.question}</p>
      {previous?.error && <p role="status" className="mb-2 text-xs text-warn">{previous.error}</p>}
      {session && otherPending && !existing && <p className="mb-2 text-xs text-fg-muted">Another check is queued for this connection.</p>}
      {session ? <Button size="sm" disabled={otherPending && !existing} aria-label={label + (existing ? ' for ' : ' ') + name} onClick={() => openRecommendedDevice(turn.id, device)}>
        {label}<ArrowUpRight aria-hidden />
      </Button> : <span className="text-xs text-fg-subtle">Removed from saved sessions</span>}
    </div>
  )
}

export function PendingDeviceCheck({ tab, platformKnown, busy }: { tab: Tab; platformKnown: boolean; busy: boolean }) {
  const turns = useWorkspaceChat((s) => s.turns)
  const pending = pendingCheck(turns, tab.tabId)
  if (!pending) return null
  const canAsk = tab.state === 'connected' && platformKnown
  const status = tab.state !== 'connected' ? 'Waiting for this connection' : !platformKnown ? 'Waiting for the device platform' : busy ? 'A device check is already running' : 'Continue at the device prompt'
  return <section aria-label="Queued workspace check" className="space-y-1.5 border-t border-line px-3 py-2 text-xs">
    <div className="font-medium text-fg">{status}</div>
    <p className="text-fg-muted">{pending.device.question}</p>
    <div className="flex gap-1.5">
      {canAsk && <Button size="sm" disabled={busy} onClick={() => confirmHandoff(tab)}>Ask now</Button>}
      <Button size="sm" variant="ghost" onClick={() => cancelHandoff(pending.turnId, pending.device.sessionId, tab.tabId)}>Cancel check</Button>
    </div>
  </section>
}

export function WorkspaceChat() {
  const { turns, draft, pendingId, waitingForModel, focusRequest, resetting } = useWorkspaceChat()
  const configured = useUi((s) => !!s.settings?.aiConfigured)
  const sessions = useUi((s) => s.sessions)
  const aiOpen = useUi((s) => s.aiOpen)
  const [modelSetup, setModelSetup] = useState(false)
  const setup = !configured && (modelSetup || waitingForModel)
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [turns, pendingId])
  useEffect(() => {
    if (aiOpen && focusRequest && input.current) {
      input.current.focus()
      useWorkspaceChat.setState({ focusRequest: false })
    }
  }, [focusRequest, aiOpen, setup])
  const startWith = (q: string) => {
    useWorkspaceChat.setState({ draft: q })
    input.current?.focus()
  }
  const example = sessions.find((s) => /core/i.test(s.name)) ?? sessions[0]
  return <section aria-label="Workspace conversation" className="flex min-h-0 flex-1 flex-col">
    <div ref={log} role="log" aria-label="Workspace messages" aria-live="polite" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
      {!turns.length && <div className="space-y-3 pt-1">
        <h2 className="text-sm font-medium text-fg">What are you troubleshooting?</h2>
        <p className="text-xs leading-relaxed text-fg-muted">Describe a symptom, ask which device to check, or drop a packet capture here.</p>
        <div className="space-y-0.5">
          <button type="button" className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-xs text-fg-muted hover:bg-hover hover:text-fg" onClick={() => startWith('Users are losing connectivity. Which device should I check first, and why?')}>
            <Route aria-hidden className="size-3.5 shrink-0" />Find a starting device
          </button>
          <button type="button" className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-xs text-fg-muted hover:bg-hover hover:text-fg" onClick={() => startWith(example ? 'Log into ' + example.name + ' and check interfaces.' : 'Help me narrow down intermittent packet loss. What should I check first?')}>
            <ListChecks aria-hidden className="size-3.5 shrink-0" />{example ? 'Check interfaces on ' + example.name : 'Investigate packet loss'}
          </button>
        </div>
      </div>}
      {turns.map((turn) => <div key={turn.id} className="min-w-0 space-y-2 border-t border-line pt-3 first:border-0 first:pt-0">
        <div className="text-2xs font-medium text-fg-subtle">You</div>
        <p className="selectable whitespace-pre-wrap break-words text-sm text-fg">{turn.question}</p>
        {turn.reply && <div className="space-y-2 pt-1">
          <div className="text-2xs font-medium text-fg-subtle">Assistant</div>
          <Markdown text={turn.reply.text} />
          {turn.reply.devices.map((device) => <RecommendedDevice key={device.sessionId} turn={turn} device={device} />)}
        </div>}
        {turn.error && <p role="alert" className="text-xs text-fg-muted">{turn.error} <button type="button" className="text-accent hover:underline" onClick={() => startWith(turn.question)}>Edit question</button></p>}
        {turn.id === pendingId && <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">{waitingForModel ? 'Waiting for a model connection.' : <><span className="thinking-dots" aria-hidden><i/><i/><i/></span> Thinking…</>}</p>}
      </div>)}
    </div>
    <div className="max-h-[68%] shrink-0 space-y-1.5 overflow-y-auto border-t border-line p-2">
      {setup ? <>
        <AiSetup pendingQuestion={waitingForModel} />
        <Button size="sm" variant="ghost" onClick={() => {
          if (waitingForModel) void stopWorkspaceQuestion()
          setModelSetup(false)
        }}>{waitingForModel ? 'Cancel question' : 'Back to chat'}</Button>
      </> : <>
        <form className="flex items-end gap-1.5 rounded-md border border-line-input bg-raised p-1 focus-within:border-accent" onSubmit={(e) => { e.preventDefault(); askWorkspace(draft) }}>
          <textarea ref={input} rows={1} aria-label="Workspace question" placeholder="Ask about your network…" maxLength={WORKSPACE_QUESTION_MAX} value={draft}
            className="max-h-40 min-h-7 min-w-0 flex-1 resize-none [field-sizing:content] bg-transparent px-1.5 py-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
            onChange={(e) => useWorkspaceChat.setState({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); askWorkspace(draft) }
            }} />
          {pendingId ? <Button size="icon-sm" aria-label="Stop" onClick={() => void stopWorkspaceQuestion()}><CircleStop /></Button> :
            <Button type="submit" variant="primary" size="icon-sm" aria-label="Send" disabled={!draft.trim() || resetting}><ArrowUp /></Button>}
        </form>
        {!configured && <Button variant="ghost" size="sm" onClick={() => setModelSetup(true)}><MessageSquare />Connect a model</Button>}
      </>}
    </div>
  </section>
}
