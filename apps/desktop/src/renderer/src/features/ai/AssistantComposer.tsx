import { ArrowUp, CircleStop, Paperclip, Terminal, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { acceptMention, activeMention, parseMentions, suggestMentions } from '@shared/mentions'
import { Button, Tooltip } from '../../design'
import { PLATFORM_SHORT } from '../../lib/platforms'
import { outputExcerpt } from '../../lib/command-evidence'
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'
import { MentionList, mentionComplete, mentionKey } from '../fleet/MentionList'
import { askWithMentions, hasMentions } from '../fleet/mentions'
import { useAi } from './store'
import { useDrafts } from './drafts'

export function AssistantComposer({ tabId, sessionName, running }: { tabId: string; sessionName: string; running: boolean }): React.JSX.Element {
  const sessions = useUi((s) => s.sessions)
  const folders = useUi((s) => s.folders)
  const input = useRef<HTMLTextAreaElement>(null)
  const composer = useDrafts((s) => s.byTab[tabId])
  const draft = composer?.text ?? ''
  const attachment = composer?.attachment
  const setDraft = (text: string) => useDrafts.getState().edit(tabId, { text })
  const [needsCommand, setNeedsCommand] = useState(false)
  const attach = () => {
    const controller = terminals.get(tabId)?.blocks
    const block = controller?.current()
    if (!controller || !block) {
      setNeedsCommand(true)
      return
    }
    setNeedsCommand(false)
    useDrafts.getState().edit(tabId, { attachment: controller.attachment(block) })
    input.current?.focus()
  }

  // @-mentions (F11): "@" opens a list of saved sessions; a question that mentions devices opens
  // the fleet view with them (this tab's session first) instead of asking this tab's assistant.
  const [caret, setCaret] = useState(0)
  const [mIndex, setMIndex] = useState(0)
  const [mClosed, setMClosed] = useState<number | null>(null)
  const active = activeMention(draft, caret)
  const mItems = active ? suggestMentions(active.query, { sessions, folders }) : []
  const mOpen = !!active && mClosed !== active.start
  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length)
  const pickMention = (i: number) => {
    const item = mItems[i]
    if (!active || !item) return
    const r = acceptMention(draft, active.start, caret, item)
    // Commit the replacement before placing the caret. A later frame could rewind past the next keystroke.
    flushSync(() => {
      setDraft(r.text)
      setCaret(r.caret)
      setMIndex(0)
    })
    input.current?.setSelectionRange(r.caret, r.caret)
  }

  const send = () => {
    if (!draft.trim()) return
    setMClosed(null)
    const q = draft.trim().replace(/^@ai\s+/i, '')
    if (hasMentions(q)) {
      if (attachment) {
        setMClosed(active?.start ?? null)
        return
      }
      void askWithMentions(tabId, q)
      setDraft('')
      return
    }
    if (running) return
    void useAi.getState().ask(tabId, q, attachment?.selection)
    useDrafts.getState().clear(tabId)
  }

  return (
    <>
      {parseMentions(draft).map((m) => {
        const session = m.kind === 'session' && sessions.find((s) => s.name.toLowerCase() === m.ref.toLowerCase())
        if (!session || (mOpen && active?.start === m.start)) return null
        return <button key={m.start} className="question-chip mb-1 mr-1" aria-label={'Remove mention ' + session.name} onClick={() => { setDraft(draft.slice(0, m.start) + draft.slice(m.end)); input.current?.focus() }}>
          <span className="vendor-chip">{PLATFORM_SHORT[session.platform]}</span> {session.name} <X className="inline size-3" />
        </button>
      })}
      {attachment && (
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 rounded border border-line bg-raised pl-2 text-xs animate-evidence-in">
          <Terminal aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
          <details className="min-w-0 flex-1 py-1 font-mono">
            <summary className="cursor-pointer truncate text-fg" title={attachment.label}>{attachment.label}</summary>
            <pre tabIndex={0} aria-label="Attached output" className="selectable max-h-36 overflow-auto py-2 text-fg-muted">{outputExcerpt(attachment.selection)}</pre>
          </details>
          <Button variant="ghost" size="icon-sm" aria-label="Remove attachment" onClick={() => {
            useDrafts.getState().edit(tabId, { attachment: undefined })
            input.current?.focus()
          }}><X /></Button>
        </div>
      )}
      <div className="relative flex items-end gap-1.5 rounded-md border border-line-input bg-raised p-1 focus-within:border-accent">
        {mOpen && <MentionList id="composer-mentions" items={mItems} index={Math.min(mIndex, Math.max(0, mItems.length - 1))} onPick={pickMention} className="absolute bottom-full left-0 mb-1" />}
        <textarea
          ref={input}
          value={draft}
          rows={1}
          aria-autocomplete="list"
          aria-controls={mOpen ? 'composer-mentions' : undefined}
          aria-activedescendant={mOpen && mItems.length ? `composer-mentions-${Math.min(mIndex, mItems.length - 1)}` : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            syncCaret(e.target)
            setMIndex(0)
            // Esc closes the list for that one mention only: a new mention (or none) clears it.
            if (activeMention(e.target.value, e.target.selectionStart ?? e.target.value.length)?.start !== mClosed) setMClosed(null)
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onKeyDown={(e) => {
            if (mOpen && active) {
              const k = mentionKey(e.nativeEvent, Math.min(mIndex, Math.max(0, mItems.length - 1)), mItems.length, mentionComplete(active.query, mItems))
              if (k !== null) {
                e.preventDefault()
                e.stopPropagation()
                if (k === 'pick') pickMention(Math.min(mIndex, mItems.length - 1))
                else if (k === 'close') setMClosed(active.start)
                else setMIndex(k)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
            if (e.key === 'Escape') terminals.get(tabId)?.focus()
          }}
          placeholder={`Ask about ${sessionName}… @ adds devices`}
          className="max-h-40 min-h-7 min-w-0 flex-1 resize-none [field-sizing:content] bg-transparent px-1.5 py-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
        />
        {running ? (
          <Tooltip label="Stop">
            <Button size="icon-sm" variant="secondary" aria-label="Stop" onClick={() => useAi.getState().cancel(tabId)}>
              <CircleStop />
            </Button>
          </Tooltip>
        ) : (
          <Button size="icon-sm" variant="primary" aria-label="Send" disabled={!draft.trim()} onClick={() => send()}>
            <ArrowUp />
          </Button>
        )}
      </div>
      {attachment && hasMentions(draft) && (
        <p role="status" className="mt-1 px-1.5 text-xs text-fg-muted">Remove the attachment to ask across devices.</p>
      )}
      {needsCommand && <p role="status" className="mt-1 px-1.5 text-xs text-fg-muted">Run a command in this terminal first, then attach its output.</p>}
      <button type="button" className="mt-1 flex h-6 items-center gap-1.5 rounded px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-ring" onClick={attach}>
        <Paperclip aria-hidden className="size-3.5" />{attachment ? 'Replace attached output' : 'Attach command output'}
      </button>
    </>
  )
}
