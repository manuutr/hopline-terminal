import { PAGE_SIZE, type PacketConversation, type PacketRow, type PacketView, type SignalCount } from '@shared/packets'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { DissectSession } from '@goodtools/wiregasm'

// Keep payloads, names, free-form Info columns and protocol text out of IPC and AI requests.
export const fields = [
  'frame.number', 'frame.time_relative', 'frame.len', 'frame.protocols', 'eth.src', 'eth.dst', 'vlan.id',
  'arp.opcode', 'arp.src.proto_ipv4', 'arp.dst.proto_ipv4', 'ip.src', 'ip.dst', 'ip.ttl', 'ipv6.src', 'ipv6.dst',
  'ipv6.hlim', 'tcp.srcport', 'tcp.dstport', 'udp.srcport', 'udp.dstport', 'tcp.flags', 'tcp.seq', 'tcp.ack',
  'tcp.stream', 'udp.stream', 'tcp.window_size', 'tcp.analysis.ack_rtt', 'tcp.analysis.retransmission', 'tcp.analysis.fast_retransmission',
  'tcp.analysis.spurious_retransmission', 'tcp.analysis.zero_window', 'tcp.flags.reset', 'dns.id', 'dns.qry.type',
  'dns.flags.rcode', 'icmp.type', 'icmp.code', 'icmpv6.type', 'tls.handshake.type', 'tls.alert_message.desc',
  'bgp.type', 'http.response.code'
] as const
type Field = typeof fields[number]
const position = Object.fromEntries(fields.map((f, i) => [f, i])) as Record<Field, number>
function columns(line: string) {
  const values = line.split('\t')
  return (field: Field) => values[position[field]] || ''
}
type Columns = ReturnType<typeof columns>

function protocol(c: Columns) {
  const layers = c('frame.protocols').split(':').filter((s) => s && s !== 'data' && !s.startsWith('_ws.') && s !== 'ethertype')
  return layers.at(-1)?.toUpperCase() ?? 'Unknown'
}

const indicators = [
  ['TCP retransmission', 'tcp.analysis.retransmission || tcp.analysis.fast_retransmission || tcp.analysis.spurious_retransmission'],
  ['TCP zero window', 'tcp.analysis.zero_window'],
  ['TCP reset', 'tcp.flags.reset == 1'],
  ['DNS error', 'dns.flags.rcode > 0'],
  ['Destination unreachable', 'icmp.type == 3 || icmpv6.type == 1']
] as const

function signals(c: Columns): number[] {
  const out: number[] = []
  if (c('tcp.analysis.retransmission') || c('tcp.analysis.fast_retransmission') || c('tcp.analysis.spurious_retransmission')) out.push(0)
  if (c('tcp.analysis.zero_window')) out.push(1)
  if (c('tcp.flags.reset') === '1' || c('tcp.flags.reset').toLowerCase() === 'true') out.push(2)
  if (Number(c('dns.flags.rcode')) > 0) out.push(3)
  if (c('icmp.type') === '3' || c('icmpv6.type') === '1') out.push(4)
  return out
}

const headerFields: readonly Field[] = [
  'eth.src', 'eth.dst', 'vlan.id', 'arp.opcode', 'arp.src.proto_ipv4', 'arp.dst.proto_ipv4', 'ip.ttl', 'ipv6.hlim',
  'tcp.stream', 'tcp.flags', 'tcp.seq', 'tcp.ack', 'tcp.window_size', 'tcp.analysis.ack_rtt', 'dns.id', 'dns.qry.type',
  'dns.flags.rcode', 'icmp.type', 'icmp.code', 'icmpv6.type', 'tls.handshake.type', 'tls.alert_message.desc', 'bgp.type', 'http.response.code'
]

function packet(line: string): PacketRow {
  const c = columns(line)
  const detail: string[] = []
  const srcPort = c('tcp.srcport') || c('udp.srcport')
  if (srcPort) detail.push(srcPort + ' → ' + (c('tcp.dstport') || c('udp.dstport')))
  if (c('tcp.flags')) {
    const flags = ['FIN', 'SYN', 'RST', 'PSH', 'ACK', 'URG', 'ECE', 'CWR'].filter((_, bit) => (Number(c('tcp.flags')) & (1 << bit)) !== 0)
    detail.push(flags.join(' '), `Seq ${c('tcp.seq')} · Ack ${c('tcp.ack')}`)
  }
  if (c('tcp.analysis.ack_rtt')) detail.push(`ACK RTT ${(Number(c('tcp.analysis.ack_rtt')) * 1000).toFixed(2)} ms`)
  if (c('dns.flags.rcode')) detail.push('DNS response code ' + c('dns.flags.rcode'))
  if (c('icmp.type')) detail.push(`ICMP type ${c('icmp.type')} code ${c('icmp.code')}`)
  if (c('icmpv6.type')) detail.push('ICMPv6 type ' + c('icmpv6.type'))
  return {
    frame: Number(c('frame.number')), seconds: c('frame.time_relative'),
    source: c('ip.src') || c('ipv6.src') || c('arp.src.proto_ipv4') || c('eth.src') || '—',
    destination: c('ip.dst') || c('ipv6.dst') || c('arp.dst.proto_ipv4') || c('eth.dst') || '—',
    protocol: protocol(c), length: Number(c('frame.len')), layers: c('frame.protocols'), detail: detail.filter(Boolean).join(' · '),
    signals: signals(c).map((i) => indicators[i]![0]), headers: headerFields.flatMap((name) => c(name) ? [{ name, value: c(name) }] : [])
  }
}

/** Rank bidirectional streams using Wireshark's stream IDs (ports can be reused across connections). */
function countStream(streams: Map<string, PacketConversation>, c: Columns): boolean {
  const transport = c('tcp.stream') ? 'tcp' : 'udp'
  const stream = c(transport === 'tcp' ? 'tcp.stream' : 'udp.stream')
  if (!stream) return true
  const filter = `${transport}.stream == ${stream}`
  let entry = streams.get(filter)
  if (!entry) {
    if (streams.size >= 20_000) return false
    const endpoint = (side: 'src' | 'dst') => {
      const address = c(`ipv6.${side}`) ? '[' + c(`ipv6.${side}`) + ']' : c(`ip.${side}`) || c(`eth.${side}`)
      return address + ':' + c(`${transport}.${side}port`)
    }
    entry = { filter, endpoints: endpoint('src') + ' ↔ ' + endpoint('dst'), frames: 0, bytes: 0, firstFrame: Number(c('frame.number')) }
    streams.set(filter, entry)
  }
  entry.frames++
  entry.bytes += Number(c('frame.len'))
  return true
}

export function indexFrames(session: DissectSession, filter: string) {
  const byProtocol = new Map<string, number>()
  const streams = new Map<string, PacketConversation>()
  let conversationsLimited = false
  const findings: SignalCount[] = indicators.map(([label, filter]) => ({ label, filter, count: 0, firstFrame: 0 }))
  const examples: PacketRow[] = []
  // Store independently compressed pages. Large traces can be filtered in their entirety
  // without holding a JS object per frame or re-running the dissector to turn a page.
  const pages: Buffer[] = []
  let batch: string[] = []
  let indexBytes = 0
  let matched = 0
  function flushPage() {
    const compressed = deflateRawSync(batch.join('\n'), { level: 1 })
    indexBytes += compressed.length
    if (indexBytes > 64 * 1024 * 1024) throw new Error('The decoded frame index exceeded 64 MiB. Open a smaller capture.')
    pages.push(compressed)
    batch = []
  }
  function append(line: string) {
    if (!line) return
    const cols = columns(line)
    if (!countStream(streams, cols)) conversationsLimited = true
    const name = protocol(cols)
    byProtocol.set(name, (byProtocol.get(name) ?? 0) + 1)
    let sample = false
    for (const i of signals(cols)) {
      const finding = findings[i]!
      if (!finding.count) finding.firstFrame = Number(cols('frame.number'))
      if (finding.count < 3) sample = true
      finding.count++
    }
    if (sample) examples.push(packet(line))
    batch.push(line)
    matched++
    if (batch.length === PAGE_SIZE) flushPage()
  }
  let total = 0
  do {
    const result = session.getFrames(filter, matched, 512)
    total = result.matched
    try {
      const size = result.frames.size()
      if (!size && matched < total) throw new Error('The packet decoder returned an incomplete page.')
      for (let i = 0; i < size; i++) {
        const { columns } = result.frames.get(i)
        try {
          const row = fields.map((_, n) => columns.get(n))
          append(row.join('\t'))
        } finally { columns.delete() }
      }
    } finally { result.frames.delete() }
  } while (matched < total)
  if (batch.length) flushPage()
  const protocols = Array.from(byProtocol, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const conversations = [...streams.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10)
  return { matched, pages, examples, conversations, conversationsLimited, signals: findings.filter((f) => f.count), protocols }
}

export interface Trace {
  id: string
  name: string
  bytes: Buffer
  inspected: number
  filter: string
  data: ReturnType<typeof indexFrames>
}
export function pageOf(trace: Trace, page: number): PacketView {
  const { matched, pages, protocols, signals, conversations, conversationsLimited } = trace.data
  page = Math.min(page, Math.max(0, pages.length - 1))
  const block = pages[page]
  return {
    id: trace.id, name: trace.name, bytes: trace.bytes.length, inspected: trace.inspected, matched,
    filter: trace.filter, protocols, signals, conversations, conversationsLimited, page, rows: block ? inflateRawSync(block).toString().split('\n').map(packet) : []
  }
}
