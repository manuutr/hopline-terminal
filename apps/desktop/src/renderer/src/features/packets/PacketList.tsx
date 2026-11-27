import { ChevronLeft, ChevronRight, Filter } from 'lucide-react'
import { useState } from 'react'
import { PAGE_SIZE, type PacketView } from '@shared/packets'
import { Button, cn, Input } from '../../design'
import { inspect, packetTask, usePackets } from './store'

function ProtocolDetails({ id, frame }: { id: string; frame: number }) {
  const [text, setText] = useState('')
  return text
    ? <details open><summary className="w-fit cursor-pointer py-1 text-fg">Full protocol details</summary>
      <pre aria-label="Local protocol details" className="max-h-60 overflow-auto rounded-md bg-surface p-2">{text}</pre></details>
    : <Button size="sm" onClick={() => void packetTask('Reading frame details…', async () => {
      setText(await window.hopline.packets.details({ id, frame }))
    })}>Show full protocol details</Button>
}

export function PacketList({ view }: { view: PacketView }) {
  const selected = usePackets((s) => s.selectedFrame)
  const setSelected = (frame: number) => usePackets.setState({ selectedFrame: frame })
  const row = view.rows.find((r) => r.frame === selected) ?? view.rows[0]
  const pages = Math.max(1, Math.ceil(view.matched / PAGE_SIZE))
  return <div className="space-y-2">
    <div className="flex flex-wrap items-baseline gap-x-3">
      <h3 className="break-all text-sm font-semibold">{view.name}</h3>
      <span className="text-xs tabular-nums text-fg-muted">{view.matched.toLocaleString()} matching · {view.inspected.toLocaleString()} inspected</span>
    </div>
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void inspect(view, String(new FormData(e.currentTarget).get('filter') ?? '')) }}>
      <Input aria-label="Wireshark display filter" name="filter" placeholder="Display filter, e.g. tcp.stream == 0" defaultValue={view.filter} maxLength={512} className="min-w-0 flex-1 font-mono" />
      <Button type="submit"><Filter />Apply</Button>
      {view.filter && <Button onClick={() => void inspect(view, '')}>Clear</Button>}
    </form>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted" aria-label="Protocol counts">
      {view.protocols.slice(0, 8).map((p) => <span key={p.name}>{p.name} <b className="font-mono font-medium text-fg">{p.count.toLocaleString()}</b></span>)}
    </div>
    {!!view.conversations.length && <details className="text-xs">
      <summary className="w-fit cursor-pointer py-1 text-fg-muted">Busiest conversations by bytes</summary>
      {view.conversationsLimited && <p className="text-fg-muted">Ranking covers the first 20,000 matching streams.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left" aria-label="TCP and UDP conversations">
          <thead className="text-fg-muted"><tr>{['Stream', 'Endpoints', 'Frames', 'Bytes'].map((h) => <th className="px-2 py-1 font-medium" key={h}>{h}</th>)}</tr></thead>
          <tbody>{view.conversations.map((stream) => <tr key={stream.filter} className="border-t border-line">
            <td className="px-2 py-1"><button title="Show this entire stream" className="whitespace-nowrap font-mono text-accent" onClick={() => void inspect(view, stream.filter)}>{stream.filter}</button></td>
            <td className="whitespace-nowrap px-2 font-mono">{stream.endpoints}</td><td className="px-2 tabular-nums">{stream.frames}</td><td className="px-2 tabular-nums">{stream.bytes.toLocaleString()}</td>
          </tr>)}</tbody>
        </table>
      </div></details>}
    {!!view.signals.length && <div className="flex flex-wrap gap-1" aria-label="Observed signals">{view.signals.map((s) =>
      <Button key={s.label} size="sm" title={'Show matching frames. First observed in frame ' + s.firstFrame} onClick={() => void inspect(view, view.filter ? '(' + view.filter + ') && (' + s.filter + ')' : s.filter)}>{s.label} · {s.count}</Button>)}</div>}
    <div className="max-h-[32vh] min-h-16 overflow-auto rounded-md border border-line bg-surface">
      <table className="w-full whitespace-nowrap text-left text-xs tabular-nums" aria-label="Captured frames">
        <thead className="sticky top-0 bg-raised text-fg-muted"><tr>{['Frame', 'Time (s)', 'Source', 'Destination', 'Protocol', 'Bytes', 'Summary'].map((h) => <th key={h} scope="col" className="px-2.5 py-1.5 font-medium">{h}</th>)}</tr></thead>
        <tbody>{view.rows.map((r) => <tr key={r.frame} onClick={() => setSelected(r.frame)} className={cn('cursor-pointer border-t border-line hover:bg-hover', r.frame === row?.frame && 'bg-accent-soft')}>
          <td className="px-2.5 py-1"><button className="font-mono text-accent underline-offset-2 hover:underline" aria-label={'Inspect frame ' + r.frame} aria-pressed={r.frame === row?.frame} onClick={() => setSelected(r.frame)}>{r.frame}</button></td>
          <td className="px-2.5 font-mono">{Number(r.seconds).toFixed(6)}</td><td className="px-2.5 font-mono">{r.source}</td><td className="px-2.5 font-mono">{r.destination}</td>
          <td className="px-2.5">{r.protocol}</td><td className="px-2.5">{r.length}</td><td className="px-2.5">{r.signals.join(', ') || r.detail || r.layers}</td>
        </tr>)}</tbody>
      </table>
      {!row && <p className="p-4 text-sm text-fg-muted">{view.filter ? 'No frames match this display filter.' : 'The capture contains no frames.'}</p>}
    </div>
    <div className="flex items-start justify-between gap-3">
      {row && <section aria-label="Selected frame" className="min-w-0 space-y-0.5 text-xs text-fg-muted"><strong className="text-fg">Frame {row.frame}</strong>
        <div className="break-all font-mono">{row.layers.split(':').join(' › ')}</div><div>{row.detail}</div>
        <details key={row.frame}><summary className="cursor-pointer py-1 text-fg">Decoded header fields</summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 font-mono">{row.headers.map((h) => <div key={h.name} className="contents"><dt>{h.name}</dt><dd>{h.value}</dd></div>)}</dl></details>
        {!!row.signals.length && <div className="text-warn">{row.signals.join(' · ')}</div>}
        <ProtocolDetails key={row.frame} id={view.id} frame={row.frame} /></section>}
      {pages > 1 && <div className="ml-auto flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <Button size="icon-sm" aria-label="Previous page" disabled={!view.page} onClick={() => void inspect(view, view.filter, view.page - 1)}><ChevronLeft /></Button>
        {view.page + 1} / {pages}<Button size="icon-sm" aria-label="Next page" disabled={view.page + 1 >= pages} onClick={() => void inspect(view, view.filter, view.page + 1)}><ChevronRight /></Button></div>}
    </div>
  </div>
}
