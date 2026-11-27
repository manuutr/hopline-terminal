import { Activity } from 'lucide-react'
import { useEffect, useState } from 'react'
import { visibleText } from '../../lib/announce'
import { terminals } from '../../lib/terminals'
import { useAi } from './store'

/** Only recognized observations can become question text. Device-provided prose stays in the terminal. */
function questions(screen: string, name: string): string[] {
  const port = /^\s*((?:Gi|Te|Et|Eth|Fa|Po|GigabitEthernet)[\d/.:]+)\s+[^\n]*?\b(administratively down|disabled|notconnect|err-disabled)\b/im.exec(screen)
  const choices: string[] = []
  if (port) choices.push('Why is ' + port[1] + ' ' + port[2] + '?')
  if (/\bBGP\b/i.test(screen)) choices.push('Summarize BGP activity')
  if (/routing table|gateway of last resort|show ip route/i.test(screen)) choices.push('Explain this routing table')
  if (/Duplex\s+Speed|show interfaces? status/i.test(screen)) choices.push('Summarize interface states')
  choices.push('Summarize ' + name, 'Explain the last command', 'What can I check next?')
  return choices.slice(0, 3)
}

export function ScreenQuestions({ tabId, name }: { tabId: string; name: string }) {
  const [items, setItems] = useState(() => questions('', name))
  useEffect(() => {
    let update: ReturnType<typeof setTimeout> | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let subs: { dispose(): void }[] = []
    function listen() {
      const term = terminals.get(tabId)?.term
      if (!term) { retry = setTimeout(listen, 150); return }
      function read() {
        update = undefined
        if (!term) return
        const buf = term.buffer.active
        const rows: string[] = []
        for (let y = buf.viewportY; y < Math.min(buf.length, buf.viewportY + term.rows); y++) rows.push(visibleText(buf.getLine(y)))
        const next = questions(rows.join('\n'), name)
        setItems((prev) => next.every((q, i) => q === prev[i]) ? prev : next)
      }
      const queue = () => { update ??= setTimeout(read, 200) }
      read()
      subs = [term.onWriteParsed(queue), term.onScroll(queue), term.onResize(queue)]
    }
    listen()
    return () => { clearTimeout(update); clearTimeout(retry); subs.forEach((s) => s.dispose()) }
  }, [tabId, name])
  return <section className="space-y-3" aria-label="Suggested questions">
    <Activity aria-hidden className="assistant-signal size-5 text-accent" />
    <p className="text-sm text-fg">Ask about <strong className="font-medium">{name}</strong>.</p>
    <div className="flex flex-wrap gap-1.5">{items.map((q) => <button className="question-chip" key={q} onClick={() => void useAi.getState().ask(tabId, q)}>{q}</button>)}</div>
  </section>
}
