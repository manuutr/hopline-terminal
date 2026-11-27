/**
 * Command-tree engine: keyword nodes and typed parameter nodes are siblings. Resolves device-style
 * abbreviations (exact > priority shortcut > unique prefix > parameter), reports the failing token
 * and character for caret placement, and answers `?` help and Tab completion.
 *
 * Shape mirrors docs/research/cli-overview.md §2.2 so it can later be fed by @hopline/cli-model.
 */

export type ParamKind = 'word' | 'line' | 'int' | 'ipv4' | 'mask' | 'prefix' | 'mac' | 'iface' | 'enum' | 'vlanlist' | 'time' | 'asn' | 'regex' | 'string'

export interface Param {
  kind: ParamKind
  /** Left column in `?` help: WORD, LINE, A.B.C.D, <1-4094>, ... */
  label: string
  min?: number
  max?: number
  /** Enum values, or live values offered by Tab (interfaces, VLANs, neighbors ...). */
  values?: () => string[]
  /** Extra validation (e.g. the interface must exist). */
  test?: (tok: string) => boolean
}

export interface Ctx {
  /** Named captures: param values and matched keywords with a `name`. */
  args: Record<string, string>
  /** Param values in order. */
  params: string[]
  /** Canonical keywords matched, in order. */
  words: string[]
  /** Raw tokens. */
  tokens: string[]
  /** The line as typed (without pipes). */
  line: string
}

/** Returns the command output (pipes apply to it); interactive commands may also print directly. */
export type Handler = (c: Ctx) => string | void | Promise<string | void>

export interface Node {
  word?: string
  param?: Param
  /** Capture name: the param value, or the keyword itself (args[name] = word). */
  name?: string
  help: string
  children?: Node[]
  run?: Handler
  /** IOS-style priority shortcut: wins over spelling ties ("sh", "conf", "wr", "int"). */
  priority?: boolean
  /** Accepted but not listed in help. */
  hidden?: boolean
}

export type MatchResult =
  | { ok: true; node: Node; ctx: Ctx }
  | { ok: false; kind: 'invalid' | 'ambiguous' | 'incomplete'; index: number; offset: number; token: string; candidates?: string[] }

export function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean)
}

/** Character offsets of each token in `line`. */
export function tokenOffsets(line: string): number[] {
  const re = /\S+/g
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m.index)
  return out
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const MASKS = new Set(Array.from({ length: 33 }, (_, n) => maskToDotted(n)))

export function maskToDotted(len: number): string {
  const n = len === 0 ? 0 : (~0 << (32 - len)) >>> 0
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
}

export function dottedToLen(mask: string): number | undefined {
  if (!MASKS.has(mask)) return undefined
  return mask.split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0)
}

export function isIpv4(s: string): boolean {
  return IPV4.test(s)
}

/** Does `tok` satisfy the parameter? */
export function acceptParam(p: Param, tok: string): boolean {
  let ok: boolean
  switch (p.kind) {
    case 'int': {
      ok = /^\d+$/.test(tok)
      const n = Number(tok)
      if (ok && p.min !== undefined && n < p.min) ok = false
      if (ok && p.max !== undefined && n > p.max) ok = false
      break
    }
    case 'asn':
      ok = /^\d+(\.\d+)?$/.test(tok) && Number(tok.split('.')[0]) <= 4294967295
      break
    case 'ipv4':
      ok = IPV4.test(tok)
      break
    case 'mask':
      ok = MASKS.has(tok)
      break
    case 'prefix': {
      const [ip, len] = tok.split('/')
      ok = !!ip && IPV4.test(ip) && len !== undefined && /^\d+$/.test(len) && Number(len) <= 32
      break
    }
    case 'mac':
      ok = /^([0-9a-f]{1,4}\.){2}[0-9a-f]{1,4}$/i.test(tok) || /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(tok)
      break
    case 'enum':
      ok = (p.values?.() ?? []).some((v) => v.toLowerCase() === tok.toLowerCase())
      break
    case 'vlanlist':
      ok = /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(tok)
      break
    case 'time':
      ok = /^\d{1,2}:\d{2}(:\d{2})?$/.test(tok)
      break
    default:
      ok = tok.length > 0
  }
  return ok && (p.test ? p.test(tok) : true)
}

interface Step {
  node: Node
  /** Tokens consumed. */
  used: number
}

/** Resolve one token (or two for "gi 1/0/1" style interfaces) against a node's children. */
function step(children: Node[], tokens: string[], i: number): Step | { error: 'invalid' | 'ambiguous'; offset: number; candidates?: string[] } {
  const raw = tokens[i]!
  const t = raw.toLowerCase()
  const kws = children.filter((c) => c.word !== undefined)
  const pre = kws.filter((c) => c.word!.toLowerCase().startsWith(t))
  const exact = pre.find((c) => c.word!.toLowerCase() === t)
  if (exact) return { node: exact, used: 1 }
  const distinct = [...new Set(pre.map((c) => c.word!))]
  if (distinct.length === 1) return { node: pre[0]!, used: 1 }
  if (distinct.length > 1) {
    const pri = pre.filter((c) => c.priority)
    if (pri.length === 1) return { node: pri[0]!, used: 1 }
    return { error: 'ambiguous', offset: 0, candidates: distinct.sort() }
  }
  for (const c of children) {
    if (!c.param) continue
    if (c.param.kind === 'iface' && /^[a-z-]+$/i.test(raw) && tokens[i + 1] && /^\d/.test(tokens[i + 1]!)) {
      // "gi 1/0/1": type and number as two tokens.
      if (acceptParam(c.param, raw + tokens[i + 1]!)) return { node: c, used: 2 }
    }
    if (acceptParam(c.param, raw)) return { node: c, used: 1 }
  }
  // Caret goes under the first character no keyword can match.
  let best = 0
  for (const k of kws) {
    const w = k.word!.toLowerCase()
    let n = 0
    while (n < t.length && n < w.length && t[n] === w[n]) n++
    best = Math.max(best, n)
  }
  if (children.some((c) => c.param)) best = 0
  return { error: 'invalid', offset: best }
}

export function match(line: string, roots: Node[]): MatchResult {
  const tokens = tokenize(line)
  const offs = tokenOffsets(line)
  const ctx: Ctx = { args: {}, params: [], words: [], tokens, line }
  let children = roots
  let node: Node | undefined
  for (let i = 0; i < tokens.length; ) {
    if (!children.length) return { ok: false, kind: 'invalid', index: i, offset: offs[i]!, token: tokens[i]! }
    const s = step(children, tokens, i)
    if ('error' in s) {
      return { ok: false, kind: s.error, index: i, offset: offs[i]! + s.offset, token: tokens[i]!, ...(s.candidates ? { candidates: s.candidates } : {}) }
    }
    node = s.node
    if (node.param?.kind === 'line') {
      const value = line.slice(offs[i]!).trimEnd()
      ctx.params.push(value)
      if (node.name) ctx.args[node.name] = value
      i = tokens.length
    } else if (node.param) {
      const value = s.used === 2 ? tokens[i]! + tokens[i + 1]! : tokens[i]!
      ctx.params.push(value)
      if (node.name) ctx.args[node.name] = value
      i += s.used
    } else {
      ctx.words.push(node.word!)
      if (node.name) ctx.args[node.name] = node.word!
      i += 1
    }
    children = node.children ?? []
  }
  if (!node) return { ok: false, kind: 'incomplete', index: 0, offset: line.length, token: '' }
  if (!node.run) return { ok: false, kind: 'incomplete', index: tokens.length, offset: line.length, token: '' }
  return { ok: true, node, ctx }
}

export interface HelpEntry {
  label: string
  help: string
  keyword: boolean
}

export type HelpResult =
  | { ok: true; partial: string; entries: HelpEntry[]; cr: boolean }
  | { ok: false; kind: 'invalid' | 'ambiguous'; index: number; offset: number; token: string }

/** `?` help for everything typed before the `?`. */
export function help(line: string, roots: Node[]): HelpResult {
  const endsWithSpace = line === '' || /\s$/.test(line)
  const tokens = tokenize(line)
  const offs = tokenOffsets(line)
  const fixed = endsWithSpace ? tokens : tokens.slice(0, -1)
  const partial = endsWithSpace ? '' : (tokens.at(-1) ?? '')
  let children = roots
  let node: Node | undefined
  for (let i = 0; i < fixed.length; ) {
    if (!children.length) return { ok: false, kind: 'invalid', index: i, offset: offs[i]!, token: fixed[i]! }
    const s = step(children, fixed, i)
    if ('error' in s) return { ok: false, kind: s.error, index: i, offset: offs[i]! + s.offset, token: fixed[i]! }
    node = s.node
    if (node.param?.kind === 'line') return { ok: true, partial, entries: [], cr: !!node.run }
    i += s.used
    children = node.children ?? []
  }
  const p = partial.toLowerCase()
  const entries: HelpEntry[] = []
  const seen = new Set<string>()
  for (const c of children) {
    if (c.hidden) continue
    if (c.word !== undefined) {
      if (!c.word.toLowerCase().startsWith(p) || seen.has(c.word)) continue
      seen.add(c.word)
      entries.push({ label: c.word, help: c.help, keyword: true })
    } else if (c.param && (!p || acceptParam({ ...c.param, test: undefined }, partial) || c.param.kind === 'word' || c.param.kind === 'line')) {
      if (seen.has(c.param.label)) continue
      seen.add(c.param.label)
      entries.push({ label: c.param.label, help: c.help, keyword: false })
    }
  }
  entries.sort((a, b) => (a.keyword === b.keyword ? (a.keyword ? a.label.localeCompare(b.label) : 0) : a.keyword ? -1 : 1))
  const cr = endsWithSpace && (node ? !!node.run : false)
  return { ok: true, partial, entries, cr }
}

/** Candidate completions for the last (partial) token. */
export function completions(line: string, roots: Node[]): { partial: string; options: string[] } {
  const tokens = tokenize(line)
  if (!line || /\s$/.test(line)) return { partial: '', options: [] }
  const partial = tokens.at(-1)!
  const fixed = tokens.slice(0, -1)
  let children = roots
  for (let i = 0; i < fixed.length; ) {
    const s = step(children, fixed, i)
    if ('error' in s) return { partial, options: [] }
    if (s.node.param?.kind === 'line') return { partial, options: [] }
    i += s.used
    children = s.node.children ?? []
  }
  const p = partial.toLowerCase()
  const kw = [...new Set(children.filter((c) => c.word !== undefined && !c.hidden && c.word.toLowerCase().startsWith(p)).map((c) => c.word!))]
  const exact = kw.find((w) => w.toLowerCase() === p)
  if (exact) return { partial, options: [exact] }
  if (kw.length > 1) {
    const pri = children.filter((c) => c.priority && c.word && c.word.toLowerCase().startsWith(p))
    if (pri.length === 1) return { partial, options: [pri[0]!.word!] }
  }
  const live: string[] = []
  for (const c of children) {
    if (!c.param?.values) continue
    for (const v of c.param.values()) if (v.toLowerCase().startsWith(p)) live.push(v)
  }
  return { partial, options: [...kw.sort(), ...new Set(live)] }
}

/** Tab: the completed line when the partial word is unique, else null. */
export function complete(line: string, roots: Node[], opts: { space?: boolean } = {}): string | null {
  const { partial, options } = completions(line, roots)
  if (options.length !== 1) return null
  const word = options[0]!
  return line.slice(0, line.length - partial.length) + word + (opts.space === false ? '' : ' ')
}

/** Small builders so command tables stay readable. */
export const kw = (word: string, help: string, rest: Partial<Node> = {}): Node => ({ word, help, ...rest })
export const prm = (param: Param, help: string, rest: Partial<Node> = {}): Node => ({ param, help, ...rest })

/**
 * Build nested keyword nodes from a space-separated path, merging into existing siblings.
 * `add(roots, 'show ip bgp summary', 'help', run)` creates/extends show → ip → bgp → summary.
 */
export function add(roots: Node[], path: string, help: string, run?: Handler, extra: Partial<Node> = {}, helps: Record<string, string> = {}): Node {
  const words = path.split(' ')
  let level = roots
  let node: Node | undefined
  words.forEach((w, idx) => {
    let n = level.find((c) => c.word === w)
    if (!n) {
      n = { word: w, help: idx === words.length - 1 ? help : (helps[words.slice(0, idx + 1).join(' ')] ?? helps[w] ?? '') }
      level.push(n)
    } else if (idx === words.length - 1 && !n.help) n.help = help
    node = n
    if (idx < words.length - 1) level = n.children ??= []
  })
  if (run) node!.run = run
  const { children, ...rest } = extra
  Object.assign(node!, rest)
  if (children) (node!.children ??= []).push(...children)
  return node!
}
