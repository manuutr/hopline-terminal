import { ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../lib/notify'
import { create } from 'zustand'
import { Button, Dialog, Input, Kbd } from '../../design'
import { bufferText, findAll, type BufferText } from '../../lib/buffer-text'
import { writeClipboard } from '../../lib/clipboard'
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'

/**
 * The accessible buffer view (docs/ACCESSIBILITY.md): a tab's scrollback as plain text in a
 * read-only textarea, which screen readers read line by line and word by word. Find, jump between
 * command blocks, and copy a selected range or a block's output. Copy goes through the same path as
 * copying from the terminal (lib/clipboard, the same text): nothing is shown here that the
 * terminal does not show.
 */
interface Snapshot {
  tabId: string
  title: string
  buf: BufferText
  /** Command blocks: where each prompt line starts in the text, and its command. */
  blocks: { offset: number; end: number; command: string }[]
}

export const useBufferView = create<{ snap: Snapshot | null }>(() => ({ snap: null }))

/** Open the view on a tab (the active one by default). False when there is no terminal. */
export function openBufferView(tabId = useUi.getState().activeTabId ?? undefined): boolean {
  const h = tabId ? terminals.get(tabId) : undefined
  if (!tabId || !h) return false
  const buffer = h.term.buffer.active
  const buf = bufferText(buffer)
  const blocks = (h.blocks?.blocks ?? [])
    .filter((b) => !b.start.isDisposed)
    .map((b) => ({ offset: buf.offsetOfRow(b.start.line), end: b.end.isDisposed ? buf.text.length : buf.offsetOfRow(b.end.line), command: b.command }))
    .filter((b, i, a) => i === 0 || b.offset > a[i - 1]!.offset)
  const title = useUi.getState().tabs.find((t) => t.tabId === tabId)?.title ?? 'Terminal'
  useBufferView.setState({ snap: { tabId, title, buf, blocks } })
  return true
}

export function BufferView(): React.JSX.Element {
  const snap = useBufferView((s) => s.snap)
  const area = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(-1)
  const [status, setStatus] = useState('')
  const text = snap?.buf.text ?? ''
  const hits = useMemo(() => findAll(text, query), [text, query])

  // Open at the end, where the latest output is, like the terminal.
  useEffect(() => {
    if (!snap) return
    setQuery('')
    setHit(-1)
    setStatus(`${snap.blocks.length} command${snap.blocks.length === 1 ? '' : 's'}, ${text.split('\n').length} lines`)
    requestAnimationFrame(() => {
      const a = area.current
      if (!a) return
      a.focus()
      a.setSelectionRange(a.value.length, a.value.length)
      a.scrollTop = a.scrollHeight
    })
  }, [snap, text])

  const close = () => {
    useBufferView.setState({ snap: null })
  }
  const select = (from: number, to: number, keepFocus = false) => {
    const a = area.current
    if (!a) return
    if (!keepFocus) a.focus()
    a.setSelectionRange(from, to)
    // Scroll the caret's line into view: measure with the line count before it.
    const line = a.value.slice(0, from).split('\n').length - 1
    const lh = parseFloat(getComputedStyle(a).lineHeight) || 18
    a.scrollTop = Math.max(0, line * lh - a.clientHeight / 3)
  }
  const blockAtCaret = () => {
    const pos = area.current?.selectionStart ?? 0
    return snap ? [...snap.blocks].reverse().find((b) => b.offset <= pos) : undefined
  }
  const jump = (dir: 1 | -1) => {
    if (!snap?.blocks.length) return setStatus('No commands in this buffer')
    const pos = area.current?.selectionStart ?? 0
    const list = snap.blocks
    const i = dir > 0 ? list.findIndex((b) => b.offset > pos) : list.map((b) => b.offset < pos).lastIndexOf(true)
    if (i < 0) return setStatus(dir > 0 ? 'Last command' : 'First command')
    const b = list[i]!
    const lineEnd = text.indexOf('\n', b.offset)
    // Select the prompt line, so a screen reader reads the command.
    select(b.offset, lineEnd < 0 ? text.length : lineEnd)
    setStatus(`Command ${i + 1} of ${list.length}: ${b.command}`)
  }
  const find = (dir: 1 | -1) => {
    if (!hits.length) return setStatus(query ? 'No results' : '')
    const next = hit < 0 ? (dir > 0 ? 0 : hits.length - 1) : (hit + dir + hits.length) % hits.length
    setHit(next)
    select(hits[next]!, hits[next]! + query.length, true)
    setStatus(`${next + 1} of ${hits.length}`)
  }
  const copy = async (t: string, what: string) => {
    if (!t) return setStatus('Nothing selected')
    await writeClipboard(t)
    toast(what)
    setStatus(what)
  }
  const copySelection = () => {
    const a = area.current
    void copy(a ? a.value.slice(a.selectionStart, a.selectionEnd) : '', 'Selection copied')
  }
  const copyBlock = () => {
    const b = blockAtCaret()
    if (!b) return setStatus('No command at the cursor')
    const out = text.slice(text.indexOf('\n', b.offset) + 1, b.end).replace(/\n+$/, '')
    void copy(out, `Output of ${b.command} copied`)
  }

  return (
    <Dialog
      open={!!snap}
      onOpenChange={(o) => !o && close()}
      title={`Terminal text: ${snap?.title ?? ''}`}
      description="Plain text of the scrollback. Alt+Up and Alt+Down jump between commands; Shift+arrows select; Ctrl+C copies the selection."
      fill
      className="h-[min(720px,88vh)] w-[min(1000px,94vw)]"
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        area.current?.focus()
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-2">
        <Input
          aria-label="Find in terminal text"
          placeholder="Find"
          value={query}
          className="h-7 w-56"
          onChange={(e) => {
            setQuery(e.target.value)
            setHit(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              find(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <Button variant="ghost" size="icon-sm" aria-label="Previous match" onClick={() => find(-1)}>
          <ChevronUp />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next match" onClick={() => find(1)}>
          <ChevronDown />
        </Button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <Button size="sm" onClick={() => jump(-1)} aria-keyshortcuts="Alt+ArrowUp">
          Previous command <Kbd keys="Alt+Up" />
        </Button>
        <Button size="sm" onClick={() => jump(1)} aria-keyshortcuts="Alt+ArrowDown">
          Next command <Kbd keys="Alt+Down" />
        </Button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <Button size="sm" onClick={copySelection}>
          <Copy /> Copy selection
        </Button>
        <Button size="sm" onClick={copyBlock}>
          Copy command output
        </Button>
      </div>
      <textarea
        ref={area}
        readOnly
        aria-label={`Terminal text of ${snap?.title ?? ''}`}
        data-testid="buffer-text"
        value={text}
        spellCheck={false}
        wrap="off"
        onKeyDown={(e) => {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault()
            jump(e.key === 'ArrowUp' ? -1 : 1)
          }
        }}
        // Never the real clipboard in tests, and the same path as terminal copy everywhere.
        onCopy={(e) => {
          e.preventDefault()
          copySelection()
        }}
        className="selectable min-h-0 flex-1 resize-none rounded-md border border-line bg-term p-2.5 font-mono text-[12.5px] leading-[1.45] text-fg focus:border-accent/60 focus:outline-none"
      />
      <div role="status" aria-live="polite" data-testid="buffer-status" className="shrink-0 truncate pt-1.5 text-xs text-fg-muted">
        {status}
      </div>
    </Dialog>
  )
}
