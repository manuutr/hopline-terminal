/**
 * Drive a simulated device in-process and print the transcript (dev aid):
 *   node packages/simulator/scripts/drive.ts [--platform ios|eos|...] 'show version' 'sh ip int br'
 * A command ending in `?` or `\t` is sent without Enter (help / completion).
 */
import { Shell } from '../src/shell.ts'
import { makeDevice, type SimPlatform } from '../src/devices/index.ts'

const args = process.argv.slice(2)
let platform: SimPlatform = 'ios'
if (args[0] === '--platform') {
  platform = args[1] as SimPlatform
  args.splice(0, 2)
}
let out = ''
const sh = new Shell(makeDevice(platform), { write: (s) => (out += s), close: () => {} }, 2000)
sh.start()
for (const c of args) {
  const text = c.replace(/\\t$/, '\t')
  sh.input(text.endsWith('?') || text.endsWith('\t') ? text + '\x15' : text + '\r')
  await new Promise((r) => setTimeout(r, 120))
}
process.stdout.write(out.replace(/\r/g, ''))
process.exit(0)
