/**
 * Benchmark commands (SimOptions.bench, never on by default): stream large outputs at full speed,
 * honouring SSH backpressure, so Hopline's whole data path (ssh2 → session host → port → xterm) is
 * measured instead of an in-memory string.
 *
 *   bench flood <MB> [plain|ansi|debug]   about MB megabytes, then the prompt
 *   bench lines <N> [plain|ansi|debug]    exactly N lines, then the prompt
 *
 * The output is generated in 64 KB slices; the IOS abort key (Ctrl-^) stops it.
 */
import type { ExtraCommand, Terminal } from './core/terminal.ts'

export type FloodKind = 'plain' | 'ansi' | 'debug'

const SLICE = 64 * 1024
const pad = (n: number, w: number): string => String(n).padStart(w, '0')

/** One line of output (CRLF included); `i` makes every line different, like real counters. */
export function floodLine(kind: FloodKind, i: number): string {
  const port = `GigabitEthernet${(i >> 10) & 7}/0/${i % 48}`
  if (kind === 'debug') {
    const ms = i % 1000
    const s = Math.floor(i / 1000) % 60
    return `*Nov 25 14:${pad(Math.floor(i / 60000) % 60, 2)}:${pad(s, 2)}.${pad(ms, 3)}: BGP(0): 10.${(i >> 8) & 255}.${i & 255}.2 rcvd UPDATE w/ attr: nexthop 10.0.0.${i & 255}, origin i, localpref 100, metric 0, path 65001 65002 ${65000 + (i % 500)}\r\n`
  }
  if (kind === 'ansi') {
    // Colour-heavy: an SGR change every word or two, 256-colour and truecolour, bold/underline.
    const c = (n: number) => `\x1b[38;5;${n}m`
    const t = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
    return `${c(39)}${port}\x1b[0m is ${i % 7 ? '\x1b[1;32mup\x1b[0m' : '\x1b[1;31mdown\x1b[0m'}, line protocol is ${c(i % 7 ? 46 : 196)}${i % 7 ? 'up' : 'down'}\x1b[0m ${t(i & 255, 128, 255 - (i & 255))}(connected)\x1b[0m \x1b[4m${i * 977}\x1b[24m packets input, \x1b[2m${i * 64011} bytes\x1b[22m, ${c(208)}${i % 13} errors\x1b[39m, \x1b[7m${i % 3} CRC\x1b[27m\r\n`
  }
  return `${port.padEnd(24)} 10.${(i >> 8) & 255}.${i & 255}.1    YES manual ${i % 7 ? 'up                   ' : 'administratively down'} up    ${(i * 977).toString().padStart(10)} pkts ${(i * 64011).toString().padStart(12)} bytes\r\n`
}

async function stream(t: Terminal, kind: FloodKind, limit: { bytes?: number; lines?: number }): Promise<void> {
  let sent = 0
  let i = 0
  for (;;) {
    if (t.aborted || t.isClosed) return
    let chunk = ''
    while (chunk.length < SLICE) {
      if (limit.lines !== undefined && i >= limit.lines) break
      if (limit.bytes !== undefined && sent + chunk.length >= limit.bytes) break
      chunk += floodLine(kind, i++)
    }
    if (!chunk) return
    sent += chunk.length
    t.write(chunk)
    await t.drain()
    // Let the event loop breathe (keystrokes, keep-alives) between slices even without backpressure.
    await new Promise((r) => setImmediate(r))
  }
}

const KINDS = new Set<FloodKind>(['plain', 'ansi', 'debug'])

/** The `bench` command family (see the file comment). */
export const benchCommand: ExtraCommand = (line, t) => {
  const m = /^\s*bench\s+(flood|lines)\s+(\d+(?:\.\d+)?)(?:\s+(\w+))?\s*$/i.exec(line)
  if (!m) return false
  const kind = (m[3]?.toLowerCase() ?? 'plain') as FloodKind
  if (!KINDS.has(kind)) return false
  const n = Number(m[2])
  return stream(t, kind, m[1]!.toLowerCase() === 'flood' ? { bytes: Math.round(n * 1024 * 1024) } : { lines: Math.floor(n) }).then(() => true)
}
