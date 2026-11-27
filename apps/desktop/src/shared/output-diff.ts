/**
 * Cross-device comparison for multi-device runs: normalise away what differs on every run
 * (clocks, uptimes, packet and byte counters, the device's own prompt), then diff each device's
 * output against a baseline device line by line. Pure, so the renderer and tests share it.
 */

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
const NOISE: [RegExp, string][] = [
  // 2026-11-25 03:34:28(.123)(Z|+01:00) and 2026/11/25 03:34:28
  [/\b\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, '<time>'],
  // *03:34:28.123 UTC Wed Nov 25 2026, Wed Nov 25 03:34:28 2026, Nov 25 03:34:28
  [new RegExp(`\\*?\\b\\d{1,2}:\\d{2}:\\d{2}(\\.\\d+)?( [A-Z]{2,5})?( (Mon|Tue|Wed|Thu|Fri|Sat|Sun))?( (${MONTHS}) \\d{1,2}( \\d{4})?)?`, 'g'), '<time>'],
  [new RegExp(`\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun),? (${MONTHS}) \\d{1,2}\\b`, 'g'), '<date>'],
  [new RegExp(`\\b(${MONTHS}) \\d{1,2}( \\d{4})?\\b`, 'g'), '<date>'],
  // uptime 3 weeks, 2 days, 4 hours, 12 minutes / up 12d03h / 1w2d / 00:12:44
  [/\b\d+ (years?|weeks?|days?|hours?|minutes?|seconds?)\b(?! (input|output))(,? \d+ (years?|weeks?|days?|hours?|minutes?|seconds?)\b)*/g, '<duration>'],
  [/\b\d+[wdhms](\d+[wdhms])+\b/g, '<duration>'],
  [/\b\d+ (bits|packets|bytes)\/sec\b/gi, '<rate>'],
  // Counters: 12345 packets input, 0 bytes, rates, "Last clearing"
  [/\b\d[\d,]*( (packets?|pkts|bytes|octets|frames|errors|drops|discards|runts|giants|collisions|broadcasts|multicasts|unicasts?|CRC|overruns?|underruns?|input|output|resets|interrupts))/gi, '<n>$1'],
  [/\b\d+(\.\d+)? ?(bps|kbps|Kbps|Mbps|Gbps|pps)\b/g, '<rate>'],
  [/(Last (input|output|clearing)[^,\n]*?)\b[\d:]+\b/gi, '$1<time>'],
  [/\b(txload|rxload|reliability) \d+\/255/g, '$1 <n>/255']
]

/** The output with run-to-run noise replaced by placeholders, and trailing blanks and the final prompt dropped. */
export function normalizeOutput(text: string): string {
  let lines = text.replace(/\r\n?/g, '\n').split('\n')
  // The prompt the command ended on names the device, so it always differs.
  while (lines.length && (!lines[lines.length - 1]!.trim() || /^[\w.@()/:~-]+[#>$%]\s*$/.test(lines[lines.length - 1]!))) lines.pop()
  lines = lines.map((l) => {
    let x = l.replace(/\s+$/, '')
    for (const [re, to] of NOISE) x = x.replace(re, to)
    return x
  })
  return lines.join('\n')
}

export type DiffOp = { op: 'same' | 'add' | 'del'; text: string }

const MAX_LINES = 3000

/** Line diff (longest common subsequence). Inputs past MAX_LINES are compared by position only. */
export function diffLines(a: string, b: string): DiffOp[] {
  const x = a ? a.split('\n') : []
  const y = b ? b.split('\n') : []
  if (x.length > MAX_LINES || y.length > MAX_LINES) {
    const out: DiffOp[] = []
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) out.push({ op: 'same', text: x[i]! })
      else {
        if (i < x.length) out.push({ op: 'del', text: x[i]! })
        if (i < y.length) out.push({ op: 'add', text: y[i]! })
      }
    }
    return out
  }
  const n = x.length
  const m = y.length
  // lcs[i][j]: length of the LCS of x[i..] and y[j..], in one flat array.
  const lcs = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i * (m + 1) + j] = x[i] === y[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ op: 'same', text: x[i]! }), i++, j++)
    else if (lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!) out.push({ op: 'del', text: x[i++]! })
    else out.push({ op: 'add', text: y[j++]! })
  }
  while (i < n) out.push({ op: 'del', text: x[i++]! })
  while (j < m) out.push({ op: 'add', text: y[j++]! })
  return out
}

/** The output without the echoed command line on top (devices echo what they were sent). */
export function stripEcho(text: string, command: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const first = lines.findIndex((l) => l.trim())
  if (first >= 0 && lines[first]!.trim().endsWith(command.trim())) lines.splice(0, first + 1)
  return lines.join('\n')
}

/** Compare outputs to a baseline: per device, the diff and how many lines differ. */
export function compareOutputs(baseline: string, others: { key: string; text: string }[], opts: { noise: boolean }): { key: string; changed: number; ops: DiffOp[] }[] {
  const norm = (t: string) => (opts.noise ? normalizeOutput(t) : t.replace(/\r\n?/g, '\n').replace(/\s+$/, ''))
  const base = norm(baseline)
  return others.map((o) => {
    const ops = diffLines(base, norm(o.text))
    return { key: o.key, changed: ops.filter((x) => x.op !== 'same').length, ops }
  })
}
