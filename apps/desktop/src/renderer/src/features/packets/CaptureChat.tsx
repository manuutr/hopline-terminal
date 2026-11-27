import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '../../design'
import { openSettings } from '../../lib/settings-nav'
import { useUi } from '../../store'
import { Markdown } from '../ai/Markdown'
import { WorkspaceFollowUp } from '../ai/WorkspaceFollowUp'
import { detachCapture, packetTask, showPackets, usePackets } from './store'

/** The capture conversation is window-scoped and also works without an open terminal. */
export function CaptureChat() {
  const { view, busy, stage, error, chatTurns, selectedFrame } = usePackets()
  const configured = useUi((s) => s.settings?.aiConfigured)
  const [draft, setDraft] = useState('')
  const latest = chatTurns.at(-1)
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [chatTurns, busy, error])
  const ask = () => {
    if (!view || busy || !configured) return
    const question = draft.trim() || 'What stands out in this capture? Cite the frames that support your findings.'
    void packetTask('Analyzing capture…', async () => {
      const answer = await window.hopline.packets.ask({ id: view.id, page: view.page, frame: selectedFrame, question })
      usePackets.setState((s) => ({ chatTurns: [...s.chatTurns, { id: crypto.randomUUID(), question, answer }] }))
      setDraft('')
    })
  }
  return <section aria-label="Capture conversation" className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
      {view && <><div className="min-w-0 flex-1"><strong className="block truncate text-sm" title={view.name}>{view.name}</strong>
        <span className="text-xs text-fg-muted">{view.inspected.toLocaleString()} {view.inspected === 1 ? 'frame' : 'frames'}</span></div>
        <Button size="sm" onClick={() => { usePackets.setState({ acquire: false }); showPackets() }}>Inspect frames</Button></>}
      <Button size="sm" disabled={busy} onClick={() => void detachCapture()}>{view ? 'Remove attachment' : 'Back to assistant'}</Button>
    </div>
    <div ref={log} role="log" aria-label="Capture messages" aria-live="polite" className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3 text-sm">
      {view && !chatTurns.length && <p className="text-fg-muted">{view.signals.length
        ? view.signals.map((s) => s.label + ' · ' + s.count + ' (first seen in frame ' + s.firstFrame + ')').join('. ')
        : 'Capture ready. Ask about a protocol, conversation or failure.'}</p>}
      {chatTurns.map((turn) => <div key={turn.id} className="space-y-2"><div className="whitespace-pre-wrap font-medium">{turn.question}</div><Markdown text={turn.answer} /></div>)}
      {error && <p role="alert" className="whitespace-pre-wrap text-danger">{error}</p>}
      {busy && <p role="status" className="text-fg-muted">{stage}</p>}
    </div>
    {latest && view && !busy && <WorkspaceFollowUp
      question="Given this capture finding, which saved device should I check next, and what should I look for?"
      evidence={[
        ...view.signals.slice(0, 3).map(s => s.label + ' first seen in frame ' + s.firstFrame + ' (' + s.count + ' total)'),
        'Capture assistant’s answer: ' + latest.answer
      ].join('\n')}
    />}
    <form className="space-y-2 border-t border-line p-2" onSubmit={(e) => { e.preventDefault(); ask() }}>
      <Input aria-label="Question about attached capture" placeholder="Ask about this capture…" value={draft} maxLength={2000} disabled={!view || busy} onChange={(e) => setDraft(e.target.value)} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-muted">Asking shares sampled frame metadata. Payloads stay local.</span>
        {busy ? <Button size="sm" onClick={() => void window.hopline.packets.cancel()}>Cancel</Button> : configured
          ? <Button type="submit" size="sm" variant="primary" disabled={!view}>{draft.trim() ? 'Send' : 'Analyze capture'}</Button>
          : <Button size="sm" onClick={() => openSettings('assistant')}>Connect AI…</Button>}
      </div>
    </form>
  </section>
}
