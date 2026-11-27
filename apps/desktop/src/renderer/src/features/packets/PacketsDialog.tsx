import { useState } from 'react'
import type { PacketView } from '@shared/packets'
import { useUi } from '../../store'
import { Button, Dialog, Input } from '../../design'
import { openSettings } from '../../lib/settings-nav'
import { toast } from '../../lib/notify'
import { Acquire } from './Acquire'
import { PacketList } from './PacketList'
import { Markdown } from '../ai/Markdown'
import { inspect, packetTask, usePackets } from './store'

export function PacketsDialog() {
  const { open, view, acquire, busy, stage, error, canFinish } = usePackets()
  const close = () => usePackets.setState({ open: false })
  if (!open) return null
  const trace = acquire ? null : view
  return <Dialog open onOpenChange={(v) => { if (!v) close() }} title="Packet capture" className="top-[5vh] w-[min(68rem,95vw)]" bodyClassName="max-h-[73vh] space-y-4 px-4 py-3"
    footer={<>
      <div role="status" className="mr-auto self-center text-xs text-fg-muted">{busy ? stage : trace ? 'Decoded locally' : ''}</div>
      {busy && canFinish && <Button variant="primary" onClick={() => void window.hopline.packets.finish()}>Stop and analyze</Button>}
      {busy && <Button onClick={() => void window.hopline.packets.cancel()}>Cancel operation</Button>}
      {trace && <Button disabled={busy} onClick={() => void packetTask('Saving capture…', async () => { if (await window.hopline.packets.save(trace.id)) toast.success('Capture saved') })}>Save capture as…</Button>}
      {view && <Button disabled={busy} onClick={() => usePackets.setState({ acquire: !acquire, answer: '', error: '' })}>{acquire ? 'Back to frames' : 'New capture…'}</Button>}
    </>}>
    {error && <div role="alert" className="whitespace-pre-wrap break-words rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
    <fieldset disabled={busy} className="min-w-0">
      {trace ? <PacketList key={trace.id + ':' + trace.filter + ':' + trace.page} view={trace} /> : <Acquire />}
    </fieldset>
    <CaptureAssistant key={trace?.id ?? 'plan'} trace={trace} />
  </Dialog>
}

function CaptureAssistant({ trace }: { trace: PacketView | null }) {
  const { answer, selectedFrame, busy } = usePackets()
  const [question, setQuestion] = useState('')
  const configured = useUi((s) => s.settings?.aiConfigured)
  const proposed = /^```(wireshark)\s*\r?\n([^\r\n`]{1,512})\r?\n```\s*$/im.exec(answer)
  return <section className="space-y-2 border-t border-line pt-3" aria-label="Capture assistant">
    <label htmlFor="packet-question" className="text-sm font-medium">{trace ? 'Ask about these frames' : 'Plan a capture with AI'}</label>
    <form className="flex flex-wrap gap-2" onSubmit={(e) => {
      e.preventDefault()
      if (!configured || busy) return
      const prompt = question.trim() || (trace ? 'What stands out in these frames and what should I check next?' : 'Help me choose a capture point and filter for a connectivity problem.')
      void packetTask('Waiting for the assistant…', async () => {
        const answer = await window.hopline.packets.ask({ ...(trace ? { id: trace.id, page: trace.page, frame: selectedFrame } : {}), question: prompt })
        usePackets.setState({ answer })
      })
    }}>
      <Input id="packet-question" value={question} disabled={busy} maxLength={2000} className="min-w-44 flex-1" onChange={(e) => setQuestion(e.target.value)}
        placeholder={trace ? 'What explains the failure in this capture?' : 'Which traffic should I capture for a DNS timeout?'} />
      {configured ? <Button type="submit" disabled={busy}>Ask assistant</Button> : <Button disabled={busy} onClick={() => { usePackets.setState({ open: false }); openSettings('assistant') }}>Connect AI…</Button>}
    </form>
    {trace && <p className="text-xs text-fg-muted">Asking sends your question, counts and sampled frame metadata to your configured provider. Packet payloads stay local.</p>}
    {answer && <div aria-label="Capture assistant answer" className="break-words rounded-md bg-surface p-3"><Markdown text={answer} />
      {proposed && trace && <Button className="mt-2" disabled={busy} onClick={() => void inspect(trace, proposed[2]!.trim())}>Apply suggested display filter</Button>}
    </div>}
  </section>
}
