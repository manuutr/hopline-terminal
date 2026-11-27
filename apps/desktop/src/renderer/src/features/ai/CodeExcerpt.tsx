import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { notifyError } from '../../lib/connect'
import { writeClipboard } from '../../lib/clipboard'
import { askConfirm } from '../../lib/confirm'
import { terminals } from '../../lib/terminals'
import { activeTab, useUi } from '../../store'

export function CodeExcerpt({ text, language, tabId }: { text: string; language: string; tabId?: string }) {
  const [copied, setCopied] = useState(false)
  const [index, choose] = useState(0)
  const readOnly = useUi((s) => s.settings?.aiReadOnly !== false)
  const tab = useUi((s) => s.tabs.find((t) => t.tabId === tabId))
  const lines = text.split('\n').filter((line) => line.trim())
  const line = lines[index] ?? ''
  async function copy() {
    try { await writeClipboard(text); setCopied(true) }
    catch (err) { notifyError('Could not copy the code', err) }
  }
  const printable = /^[\x20-\x7e]+$/.test(line)
  const reason = readOnly ? 'Read-only is on' : tab?.state !== 'connected' ? 'Connect the terminal first' : !printable ? 'Choose a printable CLI line' : 'Review this line before inserting it at the prompt'
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  async function stage() {
    if (readOnly || !tab || !printable || tab.state !== 'connected') return
    const device = terminals.get(tab.tabId)
    if (!device || !await askConfirm('Insert into ' + tab.title + '?', 'Review the exact line. Press Enter at the device prompt to run it.', 'Insert line', { preview: line, defaultCancel: true })) return
    const ui = useUi.getState()
    const active = activeTab(ui)
    if (ui.settings?.aiReadOnly !== false || active?.tabId !== tab.tabId || active.state !== 'connected' || terminals.get(tab.tabId) !== device) return
    device.term.paste(line)
    device.focus()
  }
  return <div className="my-2 rounded-md border border-line bg-term">
    <pre tabIndex={0} className="selectable overflow-x-auto p-2.5 font-mono text-xs text-fg">{text}</pre>
    <div className="flex flex-wrap items-center gap-2 border-t border-line p-1.5 text-2xs">
      <span className="mr-auto text-fg-subtle">{language || 'Code'}</span>
      <button aria-label={copied ? 'Copied' : 'Copy code'} className="inline-flex items-center gap-1" onClick={() => void copy()}>{copied ? <Check /> : <Copy />} Copy</button>
      {tabId && <>{lines.length > 1 && <select aria-label="CLI line to insert" value={index} onChange={(e) => choose(Number(e.target.value))}>{lines.map((_, i) => <option key={'line-' + (i + 1)} value={i}>Line {i + 1}</option>)}</select>}
        <button title={reason} aria-label={'Send to terminal. ' + reason} disabled={readOnly || !printable || tab?.state !== 'connected'} className="disabled:text-fg-subtle enabled:text-accent" onClick={() => void stage()}>Send to terminal</button></>}
    </div>
  </div>
}
