import { dirname, join } from 'node:path'
import type { ProtoTree, Vector, WiregasmLoader } from '@goodtools/wiregasm'
import { cleanTerminalText } from '@shared/cli'
import { fields, indexFrames } from './analysis'
import type { DecodeRequest, DecodeResult } from './decode'

// The packaged decoder and its data are read locally. Packet bytes only enter its virtual filesystem.
const loaderPath = require.resolve('@goodtools/wiregasm/dist/wiregasm.js')
const load: WiregasmLoader = require(loaderPath)
const port = process.parentPort

function treeText(nodes: Vector<ProtoTree>, output: string[], budget: { left: number }, depth = 0) {
  try {
    for (let i = 0; i < nodes.size() && budget.left > 0; i++) {
      const node = nodes.get(i)
      const line = '  '.repeat(depth) + node.label + '\n'
      output.push(line.slice(0, budget.left))
      budget.left -= line.length
      if (depth < 64 && budget.left > 0) treeText(node.tree, output, budget, depth + 1)
      else node.tree.delete()
    }
  } finally { nodes.delete() }
}

port.once('message', async ({ data }: { data: { bytes: Uint8Array; request: DecodeRequest } }) => {
  let reply: DecodeResult
  try {
    const lib = await load({ locateFile: (name) => join(dirname(loaderPath), name), print: () => {}, printErr: () => {}, handleStatus: () => {} })
    if (!lib.init()) throw new Error('Unable to initialize the bundled packet decoder.')
    const format = fields.map((name) => '"' + name + '","%Cus:' + name + ':1:U"').join(',')
    if (lib.setPref('gui', 'column.format', format).code !== 0) throw new Error('Unable to configure packet metadata fields.')
    lib.applyPreferences()
    lib.FS.writeFile('/uploads/trace', data.bytes)
    const session = new lib.DissectSession('/uploads/trace')
    const loaded = session.load()
    if (loaded.code !== 0) throw new Error(loaded.error || 'Unable to read this capture.')
    if ('frame' in data.request) {
      if (data.request.frame > loaded.summary.packet_count) throw new Error('Frame not found in this capture.')
      const frame = session.getFrame(data.request.frame)
      const lines: string[] = []
      const budget = { left: 128 * 1024 }
      treeText(frame.tree, lines, budget)
      if (budget.left <= 0) lines.push('\n… Details truncated at 128 KiB.')
      reply = { result: cleanTerminalText(lines.join('')) }
    } else {
      const { filter } = data.request
      const checked = lib.checkFilter(filter)
      if (!checked.ok) throw new Error(checked.error || 'Invalid display filter.')
      reply = { result: indexFrames(session, filter) }
    }
  } catch (e) { reply = { error: e instanceof Error ? e.message : 'Failed to decode this capture.' } }
  port.postMessage(reply)
})
