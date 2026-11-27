import { Check, ChevronRight, CircleAlert, Clock, Loader2, Paperclip, RotateCcw, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, cn, PanelHeader, RiskLabel, Segmented, Tooltip } from '../../design'
import { READ_ONLY_OFF, READ_ONLY_ON } from '../../lib/read-only'
import { activeTab, sessionById, useUi } from '../../store'
import { PlatformNotice } from '../sessions/PlatformNotice'
import { openSettings } from '../../lib/settings-nav'
import { AssistantComposer } from './AssistantComposer'
import { AiSetup } from './AiSetup'
import { ScreenQuestions } from './ScreenQuestions'
import { StreamingAnswer } from './StreamingAnswer'
import { Markdown } from './Markdown'
import { providerLabel } from './setup-parts'
import { ProposalCard } from './ProposalCard'
import { useAi, type Entry } from './store'
import { SuggestionList } from './Suggestions'
import { TrustBar } from './TrustBar'
import { PendingDeviceCheck, WorkspaceChat } from './WorkspaceChat'
import { resetWorkspaceChat, selectDeviceChat, useWorkspaceChat } from './workspace-chat'
import { DeviceFindings } from './DeviceFindings'
import { foldedSteps, waitingForDecision } from './fold'
import { CaptureChat } from '../packets/CaptureChat'
import { attachCapture, usePackets } from '../packets/store'
import { useLocks } from '../trust/store'

function StepRow({ e }: { e: Extract<Entry, { kind: 'step' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const icon =
    e.status === 'running' ? (
      <Loader2 className="size-3.5 animate-spin text-accent" />
    ) : e.status === 'ok' ? (
      <Check className="size-3.5 text-ok" />
    ) : e.status === 'blocked' ? (
      <ShieldAlert className="size-3.5 text-danger" />
    ) : (
      <CircleAlert className="size-3.5 text-warn" />
    )
  const tone = e.status === 'blocked' ? 'danger' : 'warn'
  const expandable = !!e.preview || !!e.filterNote || (!!e.reason && e.status !== 'running' && e.status !== 'ok')
  return (
    <div data-step={e.status} className="-mx-1.5">
      <button
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-2 rounded px-1.5 text-left hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
        title={e.reason}
      >
        {icon}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={cn('truncate font-mono text-xs', e.filter && 'max-w-[70%] shrink-0', e.status === 'blocked' ? 'text-fg-subtle line-through' : 'text-fg')}>{e.command}</span>
          {e.filter && (
            <span data-testid="step-filter" className="min-w-0 truncate text-2xs text-fg-subtle" title={e.filterNote ? `Filtered in Hopline Terminal: ${e.filterNote}` : 'Filtered in Hopline Terminal, not on the device'}>
              · {e.filter}
            </span>
          )}
        </span>
        {e.status !== 'ok' && e.status !== 'running' && <RiskLabel tone={tone}>{e.status}</RiskLabel>}
        {e.cmdKind === 'config' && e.status !== 'blocked' && <RiskLabel tone="warn">config</RiskLabel>}
        {e.durationMs !== undefined && <span className="text-2xs tabular-nums text-fg-subtle">{(e.durationMs / 1000).toFixed(1)}s</span>}
        {expandable && <ChevronRight className={cn('size-3.5 text-fg-subtle transition-transform duration-[var(--dur-fast)]', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="mb-1 ml-[22px] mr-1.5 animate-fade-in space-y-1">
          {e.reason && e.status !== 'ok' && <div className="text-xs text-fg-muted">{e.reason}</div>}
          {e.filterNote && <div className="text-2xs text-fg-subtle">Filtered in Hopline Terminal: {e.filterNote}</div>}
          {e.preview && (
            <pre tabIndex={0} aria-label="Preview" className="selectable max-h-64 overflow-auto rounded bg-term px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] text-fg-muted">{e.preview}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-2xs font-medium text-fg-subtle hover:text-fg-muted">
        <ChevronRight className={cn('size-3 transition-transform duration-[var(--dur-fast)]', open && 'rotate-90')} />
        <span className={cn(live && 'animate-pulse-dot')}>Reasoning</span>
      </button>
      {open && <div className="selectable mt-1 whitespace-pre-wrap border-l border-line pl-3 text-xs leading-relaxed text-fg-subtle animate-fade-in">{text}</div>}
    </div>
  )
}

/** Main's "nothing connected" error (a race with the renderer's queue): a neutral row, not a danger card. */
const isNoProvider = (text: string) => /No AI provider is connected/.test(text)

/**
 * Optional first-run note (F2): what the assistant does and how it is kept safe. Flat text under a
 * hairline, no box and no icons (review P2). Dismissible, never blocking.
 */
function IntroCard(): React.JSX.Element {
  const dismiss = async () => useUi.getState().setSettings(await window.hopline.settings.update({ aiIntroDismissed: true }))
  return (
    <div data-testid="ai-intro" className="border-t border-line pt-2 text-xs leading-snug text-fg-muted animate-fade-in">
      <div className="flex h-6 items-center">
        <span className="flex-1 font-medium text-fg">How the assistant works</span>
        <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
      <ul className="list-none space-y-1">
        <li>Every command is checked before it runs. Read-only by default; a config change runs only after you approve its exact lines.</li>
        <li>
          Type <code className="font-mono text-fg">@ai</code> in the terminal, or select output and choose Explain.
        </li>
        <li>Long output is filtered in Hopline Terminal (tail, grep, count), the same on every vendor.</li>
      </ul>
    </div>
  )
}

export function AiPanel(): React.JSX.Element {
  const tab = useUi(activeTab)
  const { settings, sessions, quick, aiOpen } = useUi()
  const thread = useAi((s) => (tab ? s.byTab[tab.tabId] : undefined))
  const reset = useAi((s) => s.reset)
  const scroller = useRef<HTMLDivElement>(null)
  const session = tab && sessionById({ sessions, quick }, tab.sessionId)
  const running = !!thread?.runId
  const entries = thread?.entries ?? []
  const notConfigured = !!settings && !settings.aiConfigured
  const waiting = !!thread?.waiting
  const who = settings?.aiConfigured ? providerLabel(settings) : null
  const [draggingCapture, setDraggingCapture] = useState(false)
  const captureChat = usePackets((s) => s.chat)
  const captureBusy = usePackets((s) => s.busy)
  const captureId = usePackets((s) => s.view?.id)
  const scope = useWorkspaceChat((s) => s.scope)
  const workspaceHasTurns = useWorkspaceChat((s) => !!s.turns.length)
  const workspaceBusy = useWorkspaceChat((s) => !!s.pendingId || s.resetting)
  const conversation = captureChat ? 'capture' : !tab || !session ? 'workspace' : scope
  const locks = useLocks()
  const folded = foldedSteps(entries)
  const deciding = waitingForDecision(entries)

  // Keep the newest entry in view, after layout: an error row that arrived with the end of the run
  // was left under the composer (review P2) when the scroll ran before the "Thinking" row went away.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    const f = requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
    return () => cancelAnimationFrame(f)
  }, [entries, running, waiting, conversation, aiOpen])

  const toggleReadOnly = async () => {
    if (!settings || locks.readOnly) return
    useUi.getState().setSettings(await window.hopline.settings.update({ aiReadOnly: !settings.aiReadOnly }))
  }

  return (
    <div className="relative flex h-full flex-col bg-surface" onDragOver={(e) => {
      if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = captureBusy ? 'none' : 'copy'; setDraggingCapture(!captureBusy) }
    }} onDragLeave={(e) => {
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDraggingCapture(false)
    }} onDrop={(e) => {
      setDraggingCapture(false)
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      if (captureBusy) return
      const files = e.dataTransfer.files
      if (files.length !== 1) { usePackets.setState({ chat: true, error: 'Attach one PCAP or PCAPNG at a time.' }); return }
      if (files[0]) void attachCapture(files[0])
    }}>
      {draggingCapture && <div className="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-md border border-dashed border-accent bg-surface/95 text-sm font-medium text-fg">Drop a PCAP or PCAPNG</div>}
      <PanelHeader title="Assistant" titleClassName="mr-auto flex-none" className="@container gap-1 px-2">
        <Tooltip label="Attach packet capture"><Button variant="ghost" size="icon-sm" aria-label="Attach packet capture" disabled={captureBusy} onClick={() => void attachCapture()}><Paperclip /></Button></Tooltip>
        {who && (
          <Tooltip label={`${who.title}. Click to change.`}>
            <button
              data-testid="ai-provider"
              onClick={() => openSettings('aiProvider')}
              className="flex h-[22px] min-w-0 max-w-32 items-center rounded px-1.5 text-2xs font-medium text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <span className="truncate">{who.text}</span>
            </button>
          </Tooltip>
        )}
        {settings && conversation === 'device' && (
          <Tooltip label={locks.readOnly ? `${READ_ONLY_ON} Managed by policy: your administrator turned it on.` : `${settings.aiReadOnly ? READ_ONLY_ON : READ_ONLY_OFF} Click to turn it ${settings.aiReadOnly ? 'off' : 'on'}.`}>
            <button
              data-testid="ai-readonly"
              aria-label={settings.aiReadOnly ? 'Read-only' : 'Changes allowed'}
              aria-disabled={locks.readOnly || undefined}
              onClick={() => void toggleReadOnly()}
              className={cn(
                'flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-2xs font-medium transition-colors hover:bg-hover',
                settings.aiReadOnly ? 'border-accent/35 text-accent' : 'border-warn/45 text-warn'
              )}
            >
              {settings.aiReadOnly ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
              {/* Narrow (900 px): "Changes", so the model name beside it is not cut (review P1-7). */}
              {settings.aiReadOnly ? 'Read-only' : <>Changes<span className="hidden @[20.5rem]:inline">&nbsp;allowed</span></>}
            </button>
          </Tooltip>
        )}
        {conversation === 'device' && tab && entries.length > 0 && (
          <Tooltip label="New conversation">
            <Button variant="ghost" size="icon-sm" aria-label="New conversation" disabled={running} onClick={() => reset(tab.tabId)}>
              <RotateCcw />
            </Button>
          </Tooltip>
        )}
        {conversation === 'workspace' && workspaceHasTurns && (
          <Tooltip label="New workspace conversation">
            <Button variant="ghost" size="icon-sm" aria-label="New workspace conversation" disabled={workspaceBusy} onClick={() => void resetWorkspaceChat()}><RotateCcw /></Button>
          </Tooltip>
        )}
      </PanelHeader>
      {(session || captureId || captureChat) && <div className="flex min-w-0 border-b border-line px-3 py-1.5">
        <Segmented<'workspace' | 'device' | 'capture'>
          label="Assistant conversation scope" size="sm" value={conversation}
          className="max-w-full [&>button]:block [&>button]:min-w-0 [&>button]:truncate"
          items={[
            { value: 'workspace', label: 'Workspace' },
            ...(session ? [{ value: 'device' as const, label: session.name }] : []),
            ...(captureId || captureChat ? [{ value: 'capture' as const, label: 'Capture' }] : [])
          ]}
          onChange={(next) => {
            if (next === 'workspace') {
              usePackets.setState({ chat: false })
              useWorkspaceChat.setState({ scope: 'workspace' })
            }
            else if (next === 'device') selectDeviceChat()
            else usePackets.setState({ chat: true })
          }}
        />
      </div>}
      {settings?.aiConfigured && <TrustBar settings={settings} usage={conversation === 'device' ? thread?.usage : undefined} suggest={conversation === 'device' ? thread?.suggest : false} />}

      {captureChat ? <CaptureChat key={captureId} /> : conversation === 'workspace' || !tab || !session ? (
        <WorkspaceChat />
      ) : (
        <>
          <div ref={scroller} role="log" aria-live="polite" aria-label="Assistant conversation" className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
            {entries.length === 0 && (
              <div className="space-y-3 pt-1 animate-fade-in">
                {aiOpen && <ScreenQuestions key={tab.tabId} tabId={tab.tabId} name={session.name} />}
                {settings?.aiConfigured && !settings.aiIntroDismissed && <IntroCard />}
              </div>
            )}

            {entries.map((e, i) => {
              switch (e.kind) {
                case 'user':
                  return (
                    <div key={e.id} data-entry="user" className="border-t border-line pt-3 text-sm text-fg animate-fade-in first:border-0 first:pt-0">
                      <div className="mb-0.5 text-2xs font-medium text-fg-subtle">You</div>
                      <div className="selectable whitespace-pre-wrap">{e.text}</div>
                      {e.selection && (
                        <div className="mt-1 flex items-center gap-1 text-2xs text-fg-subtle">
                          <Terminal className="size-3" /> with selected terminal output
                        </div>
                      )}
                    </div>
                  )
                case 'assistant':
                  return (
                    <div key={e.id} data-entry="assistant" className={cn('space-y-1.5 animate-fade-in', i > 0 && entries[i - 1]?.kind === 'user' && 'pt-2')}>
                      {(i === 0 || entries[i - 1]?.kind === 'user') && <div className="-mb-1 text-2xs font-medium text-fg-subtle">Assistant</div>}
                      {e.thinking && <Reasoning text={e.thinking} live={running && i === entries.length - 1 && !e.text} />}
                      {e.text && (running && i === entries.length - 1 ? <StreamingAnswer text={e.text} /> : <Markdown text={e.text} tabId={tab.tabId} />)}
                    </div>
                  )
                case 'step':
                  // An approved card's own lines are shown in the card, not again as rows.
                  return folded.has(e.id) ? null : <StepRow key={e.id} e={e} />
                case 'proposal':
                  return <ProposalCard key={e.id} e={e} tabId={tab.tabId} sessionName={session.name} />
                case 'suggestions':
                  return <SuggestionList key={e.id} e={e} tabId={tab.tabId} busy={running} readOnly={!!settings?.aiReadOnly} />
                case 'error':
                  if (isNoProvider(e.text))
                    return (
                      <div key={e.id} className="flex items-center gap-2 px-1 text-xs text-fg-muted animate-fade-in">
                        <Clock className="size-3.5 shrink-0 text-fg-subtle" /> Not sent: no model was connected yet. Ask again.
                      </div>
                    )
                  return (
                    <div key={e.id} role="alert" className="flex items-start gap-2 rounded border border-danger/30 px-2.5 py-1.5 text-xs text-danger animate-fade-in">
                      <CircleAlert className="mt-px size-3.5 shrink-0" /> {e.text}
                    </div>
                  )
              }
            })}
            {waiting && (
              <div data-testid="ai-waiting" className="flex items-center gap-2 px-1 text-xs text-fg-muted animate-fade-in">
                <Clock className="size-3.5 shrink-0 text-fg-subtle" /> Waiting for a model. Connect one below and this question is sent.
              </div>
            )}
            {running && !deciding && entries.at(-1)?.kind !== 'step' && !(entries.at(-1)?.kind === 'assistant') && (
              <div className="flex items-center gap-2 text-xs text-fg-subtle">
                <span className="thinking-dots" aria-hidden><i/><i/><i/></span> Thinking…
              </div>
            )}
          </div>

          <PlatformNotice tab={tab} />
          <PendingDeviceCheck tab={tab} platformKnown={session.platform !== 'auto'} busy={running || waiting} />
          <DeviceFindings tabId={tab.tabId} sessionName={session.name} />
          <div className="border-t border-line p-2">
            {notConfigured ? (
              <AiSetup pendingQuestion={waiting} />
            ) : (
              <AssistantComposer key={tab.tabId} tabId={tab.tabId} sessionName={session.name} running={running} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
