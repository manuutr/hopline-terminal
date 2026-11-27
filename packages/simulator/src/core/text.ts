/** Small text helpers shared by vendor renderers. */

export const pad = (s: string | number, n: number): string => String(s).padEnd(n)
export const lpad = (s: string | number, n: number): string => String(s).padStart(n)

/** Center `s` so that its middle character sits at column `mid` within a field starting at `start`. */
export function center(s: string, start: number, mid: number): string {
  const at = mid - Math.floor((s.length - 1) / 2)
  return ' '.repeat(Math.max(0, at - start)) + s
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
}

export function network(ip: string, mask: number): string {
  const m = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0
  return intToIp((ipToInt(ip) & m) >>> 0)
}

export function inSubnet(ip: string, net: string, mask: number): boolean {
  return network(ip, mask) === network(net, mask)
}

/** Classful network of an address: [network, mask]. */
export function classful(ip: string): [string, number] {
  const first = Number(ip.split('.')[0])
  const mask = first < 128 ? 8 : first < 192 ? 16 : 24
  return [network(ip, mask), mask]
}

export const cmpIp = (a: string, b: string): number => ipToInt(a) - ipToInt(b)

/** Cisco dotted MAC (aabb.cc00.0110) to colon form (aa:bb:cc:00:01:10). */
export function macColon(m: string): string {
  const hex = m.replace(/[^0-9a-f]/gi, '').toLowerCase().padStart(12, '0')
  return hex.match(/../g)!.join(':')
}

/** Line-based unified diff (`---`/`+++` headers, `@@` hunks, `context` lines around changes). */
export function unifiedDiff(a: string[], b: string[], from: string, to: string, context = 3): string[] {
  const n = a.length
  const m = b.length
  // LCS table (configs are small: a few hundred lines).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const ops: { op: ' ' | '-' | '+'; text: string; ai: number; bi: number }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ op: ' ', text: a[i]!, ai: i++, bi: j++ })
    else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ops.push({ op: '+', text: b[j]!, ai: i, bi: j++ })
    else ops.push({ op: '-', text: a[i]!, ai: i++, bi: j })
  }
  if (!ops.some((o) => o.op !== ' ')) return []
  const out = [`--- ${from}`, `+++ ${to}`]
  let k = 0
  while (k < ops.length) {
    while (k < ops.length && ops[k]!.op === ' ') k++
    if (k >= ops.length) break
    let start = Math.max(0, k - context)
    let end = k
    for (;;) {
      while (end < ops.length && ops[end]!.op !== ' ') end++
      let next = end
      while (next < ops.length && ops[next]!.op === ' ' && next - end < context * 2) next++
      if (next < ops.length && ops[next]!.op !== ' ') end = next
      else break
    }
    end = Math.min(ops.length, end + context)
    const hunk = ops.slice(start, end)
    const aStart = hunk[0]!.ai + 1
    const bStart = hunk[0]!.bi + 1
    const aLen = hunk.filter((o) => o.op !== '+').length
    const bLen = hunk.filter((o) => o.op !== '-').length
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`)
    for (const o of hunk) out.push(o.op + o.text)
    k = end
    start = end
  }
  return out
}

/** Split a line on unquoted `|` into the command and its pipe segments. */
export function splitPipes(line: string): [string, string[]] {
  const parts: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = ''
      cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '|') {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const [base = '', ...pipes] = parts
  return [base, pipes.map((p) => p.trim())]
}

/** Strip surrounding quotes from a pipe argument. */
export const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

export function safeRegex(pattern: string, flags = ''): RegExp | null {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/** Cisco `| section`: a top-level line matching the regex plus its indented children. */
export function section(lines: string[], re: RegExp): string[] {
  const out: string[] = []
  let inSection = false
  for (const l of lines) {
    if (!/^\s/.test(l)) inSection = re.test(l)
    else if (!inSection && re.test(l)) {
      out.push(l)
      continue
    }
    if (inSection) out.push(l)
  }
  return out
}
