import { z } from 'zod'
import type { WebContents } from 'electron'
import { handler as h } from '.'
import { droppedPath } from './files'
import type { PacketWorkspace } from '../packets/workspace'

const id = z.uuid()
const tabId = z.string().min(1).max(80)
const page = z.number().int().min(0).max(50_000)
const text = (max: number) => z.string().trim().max(max).regex(/^[^\x00-\x1f\x7f]*$/)
const seconds = z.number().int().min(1).max(120)
const filter = text(512)
const frame = z.number().int().min(1).max(5_000_000)
const plan = z.strictObject({
  tabId, device: z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9/.:-]*$/),
  direction: z.enum(['in', 'out', 'both']), seconds,
  match: z.strictObject({ side: z.enum(['source', 'destination']), address: z.union([z.ipv4(), z.ipv6()]) }).optional()
})
const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file') }),
  z.strictObject({ kind: z.literal('download'), transferId: id }),
  z.strictObject({ kind: z.literal('remote'), tabId, path: text(1024).min(1) }),
  z.strictObject({ kind: z.literal('iosxe'), planId: id, ack: text(255).min(1) })
])

export function packetsHandlers(workspace: (wc: WebContents) => PacketWorkspace) {
  return {
    'packets:drop': h(droppedPath, (path, e) => workspace(e.sender).open({ kind: 'drop', path })),
    'packets:plan': h(plan, (req, e) => workspace(e.sender).prepare(req)),
    'packets:open': h(source, (req, e) => workspace(e.sender).open(req)),
    'packets:view': h(z.strictObject({ id, filter, page }), (req, e) => workspace(e.sender).view(req)),
    'packets:details': h(z.strictObject({ id, frame }), (req, e) => workspace(e.sender).details(req)),
    'packets:ask': h(z.strictObject({ id: id.optional(), question: z.string().trim().min(1).max(2000), page: page.optional(), frame: frame.optional() }), (req, e) => workspace(e.sender).ask(req)),
    'packets:save': h(id, (id, e) => workspace(e.sender).save(id)),
    'packets:finish': h(z.undefined(), (_, e) => workspace(e.sender).finish()),
    'packets:cancel': h(z.undefined(), (_, e) => workspace(e.sender).cancel()),
    'packets:close': h(z.undefined(), (_, e) => workspace(e.sender).close())
  }
}
