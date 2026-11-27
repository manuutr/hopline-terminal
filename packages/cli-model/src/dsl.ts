import { paramFor } from './params'
import type { ArgRule, CommandNode, ConfirmSpec, ModeId, ParamDef, Risk } from './types'
import { maxRisk } from './types'

/**
 * A compact line-spec DSL for command trees.
 *
 *   show ip route [vrf <vrf>] [<net>] ...
 *
 * - `word`         keyword (matched by unique prefix, like the device)
 * - `<name>`       typed parameter from PARAMS (`<if>`, `<vlan>`, `<vrf>`, `<ip>`, `<1-100>` …)
 * - `[a b]`        optional group
 * - `{a|b c|d}`    one of the alternatives
 * - `...`          open: the device accepts further options we do not model; they inherit the risk
 *
 * Each entry gives the risk of the node(s) where its spec ends. Nodes without a risk inherit
 * from their nearest ancestor. Optional groups are expanded, so `[vrf <vrf>]` makes both the
 * shorter and the longer path runnable.
 */

export interface EntryOpts {
  reason?: string
  confirm?: readonly ConfirmSpec[]
  rule?: ArgRule
  enters?: ModeId
  leaves?: boolean
  /** The rest of the line runs in this mode (`do`, `run`). */
  exec?: ModeId
  /** Not runnable by itself (a container keyword that only carries docs). */
  container?: boolean
}

export interface Entry {
  spec: string
  risk?: Risk
  help?: string
  opts?: EntryOpts
}

const entry =
  (risk: Risk | undefined) =>
  (spec: string, help?: string, opts?: EntryOpts): Entry => ({ spec, risk, help, opts })

/** Read-only and terminates on its own. */
export const R = entry('read')
/** Changes state; needs approval. */
export const C = entry('config')
/** Can take traffic or access down; approval plus a second confirmation. */
export const D = entry('disruptive')
/** Never run for the agent. */
export const B = entry('blocked')
/** Docs-only structure; inherits risk. */
export const N = entry(undefined)

export interface TreeSource {
  entries: readonly Entry[]
  /** Keyword help: key is the word, or the full keyword path ("show ip bgp") for overrides. */
  help: Readonly<Record<string, string>>
  /** Priority abbreviations per keyword path ('' = root): { sh: 'show' }. */
  priority?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

type Item =
  | { t: 'kw'; word: string }
  | { t: 'param'; name: string; def: ParamDef }
  | { t: 'open' }
  | { t: 'opt'; seq: Item[] }
  | { t: 'alt'; seqs: Item[][] }

function lex(spec: string): string[] {
  return spec.match(/<[^>]+>|\.\.\.|[[\]{}|]|[^\s[\]{}|<>]+/g) ?? []
}

function parseSeq(toks: string[], pos: { i: number }, stop: Set<string>, spec: string): Item[] {
  const out: Item[] = []
  while (pos.i < toks.length && !stop.has(toks[pos.i]!)) {
    const t = toks[pos.i++]!
    if (t === '[') {
      const seq = parseSeq(toks, pos, new Set([']']), spec)
      if (toks[pos.i++] !== ']') throw new Error(`unclosed [ in "${spec}"`)
      out.push({ t: 'opt', seq })
    } else if (t === '{') {
      const seqs: Item[][] = []
      for (;;) {
        seqs.push(parseSeq(toks, pos, new Set(['|', '}']), spec))
        const sep = toks[pos.i++]
        if (sep === '}') break
        if (sep !== '|') throw new Error(`unclosed { in "${spec}"`)
      }
      out.push({ t: 'alt', seqs })
    } else if (t === '...') {
      out.push({ t: 'open' })
    } else if (t.startsWith('<')) {
      const name = t.slice(1, -1)
      const def = paramFor(name)
      if (!def) throw new Error(`unknown parameter <${name}> in "${spec}"`)
      out.push({ t: 'param', name, def })
    } else {
      out.push({ t: 'kw', word: t.toLowerCase() })
    }
  }
  return out
}

type Flat = { t: 'kw'; word: string } | { t: 'param'; name: string; def: ParamDef } | { t: 'open' }

function expand(seq: readonly Item[]): Flat[][] {
  let paths: Flat[][] = [[]]
  for (const it of seq) {
    if (it.t === 'opt') {
      const inner = expand(it.seq)
      paths = paths.flatMap((p) => [p, ...inner.map((q) => [...p, ...q])])
    } else if (it.t === 'alt') {
      const inner = it.seqs.flatMap((s) => expand(s))
      paths = paths.flatMap((p) => inner.map((q) => [...p, ...q]))
    } else {
      paths = paths.map((p) => [...p, it])
    }
    if (paths.length > 4096) throw new Error('spec expands to too many paths')
  }
  return paths
}

export function parseSpec(spec: string): Flat[][] {
  const toks = lex(spec)
  const pos = { i: 0 }
  const seq = parseSeq(toks, pos, new Set(), spec)
  if (pos.i !== toks.length) throw new Error(`unexpected "${toks[pos.i]}" in "${spec}"`)
  return expand(seq)
}

const newNode = (help: string, word?: string, param?: ParamDef): CommandNode => ({ word, param, help, runnable: false, keywords: [], params: [] })

const humanize = (w: string) => w.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** Compile a tree source into a root node. */
export function compile(src: TreeSource): CommandNode {
  const root = newNode('')
  const paramKey = new WeakMap<CommandNode, string>()
  for (const e of src.entries) {
    const paths = parseSpec(e.spec)
    // Entry help documents the deepest keyword every expansion shares ("show ip route" in
    // "show ip route [vrf <vrf>] ..."), not each alternative.
    let last: CommandNode | undefined
    for (const path of paths) {
      let node = root
      const words: string[] = []
      let open = false
      for (const step of path) {
        if (step.t === 'open') {
          open = true
          continue
        }
        if (step.t === 'kw') {
          words.push(step.word)
          let child = node.keywords.find((k) => k.word === step.word)
          if (!child) {
            child = newNode(src.help[words.join(' ')] ?? src.help[step.word] ?? humanize(step.word), step.word)
            node.keywords.push(child)
          }
          node = child
        } else {
          words.push(`<${step.name}>`)
          let child = node.params.find((p) => paramKey.get(p) === step.name)
          if (!child) {
            child = newNode(step.def.help, undefined, step.def)
            paramKey.set(child, step.name)
            node.params.push(child)
          }
          node = child
        }
      }
      if (node === root) throw new Error(`empty spec "${e.spec}"`)
      const o = e.opts ?? {}
      if (!o.container) node.runnable = true
      if (open) node.open = true
      if (e.risk) {
        node.risk = node.risk ? maxRisk(node.risk, e.risk) : e.risk
        if (o.reason && (!node.reason || node.risk === e.risk)) node.reason = o.reason
      }
      last = node
      if (o.confirm) node.confirm = [...(node.confirm ?? []), ...o.confirm]
      if (o.rule) node.rule = o.rule
      if (o.enters) node.enters = o.enters
      if (o.leaves) node.leaves = true
      if (o.exec) node.exec = o.exec
    }
    const common = paths.length === 1 ? last : sharedPrefix(root, paths)
    if (e.help && common?.word && !common.helpSet) {
      common.help = e.help
      common.helpSet = true
    }
  }
  for (const [path, map] of Object.entries(src.priority ?? {})) {
    const node = path ? findPath(root, path.split(' ')) : root
    if (!node) throw new Error(`priority path "${path}" not in tree`)
    node.priority = new Map(Object.entries(map))
  }
  sortTree(root)
  return root
}

/** Deepest keyword node on the common prefix of all expanded paths. */
function sharedPrefix(root: CommandNode, paths: Flat[][]): CommandNode | undefined {
  let node: CommandNode | undefined = root
  let last: CommandNode | undefined
  for (let i = 0; ; i++) {
    const first = paths[0]![i]
    if (!first || first.t !== 'kw') break
    if (!paths.every((p) => p[i]?.t === 'kw' && (p[i] as { word: string }).word === first.word)) break
    node = node?.keywords.find((k) => k.word === first.word)
    if (!node) break
    last = node
  }
  return last
}

function findPath(root: CommandNode, words: string[]): CommandNode | undefined {
  let n: CommandNode | undefined = root
  for (const w of words) n = n?.keywords.find((k) => k.word === w)
  return n
}

function sortTree(n: CommandNode): void {
  n.keywords.sort((a, b) => (a.word! < b.word! ? -1 : 1))
  for (const k of n.keywords) sortTree(k)
  for (const p of n.params) sortTree(p)
}

/**
 * Rule: blocked when any later token could abbreviate `word` (at least `min` characters), e.g.
 * `follow` on an open-ended `show logging …`, unless the next token is `no` (PAN-OS `follow no`).
 */
export function forbidsWord(word: string, reason: string, min = 2): ArgRule {
  return (args) => {
    const i = args.findIndex((a) => a.length >= min && word.startsWith(a.toLowerCase()))
    if (i < 0 || /^no$/i.test(args[i + 1] ?? '')) return undefined
    return { risk: 'blocked', reason }
  }
}

/**
 * How a Linux-style output filter (EOS shell pipes, NX-OS built-ins, IOS-XR `utility`) may be
 * called. Strict allow-list: only these exact short options, no long options, no combined flags,
 * and at most `operands` positional arguments (grep's pattern; never a file).
 */
export interface ShellFilterSpec {
  /** Boolean short options, one letter each (`ivc` allows `-i`, `-v`, `-c`). */
  flags?: string
  /** Short options that take a value, with the value it must match (`{ n: INT }`). */
  values?: Readonly<Record<string, RegExp>>
  /** Positional arguments allowed: 1 for grep's pattern, 2 for `tr SET1 SET2`, else 0 (any more is a file). */
  operands?: number
  /** `head -20` / `tail -20` (legacy line count). */
  legacyCount?: boolean
}

/** A small integer value (`-n 50`). */
export const INT = /^\d{1,6}$/
/**
 * Characters allowed in any argument of a shell filter. Everything else is refused: quotes and
 * backslashes (they reshape the arguments the shell sees, `'-o'`, `-\o`), `=` (`--o=FILE`),
 * glob and brace expansion (`*`, `[`, `{` turn one word into file names), `~`, `$`, `!`, `#`.
 */
// `|` only reaches a filter inside quotes on platforms that group (NX-OS `egrep "a|b"`).
const SHELL_ARG = /^[A-Za-z0-9_.:/@%+,^|-]+$/

/**
 * Rule for a Linux-style output filter: refused unless every argument is on the allow-list.
 * These filters run as real Linux programs on some platforms, where an option like `sort -o`,
 * `tail -f` or `grep -r` writes a file, never returns or reads the device filesystem.
 */
export function shellFilter(name: string, spec: ShellFilterSpec): ArgRule {
  const flags = spec.flags ?? ''
  const values = spec.values ?? {}
  const maxOperands = spec.operands ?? 0
  return (args) => {
    let operands = 0
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (!SHELL_ARG.test(a))
        return { risk: 'blocked', reason: `"| ${name}" argument "${a}" has a quote, backslash, "=" or shell character; only plain options and words are allowed` }
      if (a.startsWith('--')) return { risk: 'blocked', reason: `"| ${name} ${a}": long options are not allowed on a filter that runs as a Linux command` }
      if (a.startsWith('-') && a.length > 1) {
        if (spec.legacyCount && INT.test(a.slice(1))) continue
        const letter = a.length === 2 ? a[1]! : ''
        if (letter && values[letter]) {
          const v = args[i + 1]
          if (v === undefined || !values[letter]!.test(v)) return { risk: 'blocked', reason: `"| ${name} ${a}" needs a plain value` }
          i++
          continue
        }
        if (letter && flags.includes(letter)) continue
        return { risk: 'blocked', reason: `"| ${name} ${a}" is not an allowed option (allowed: ${allowedOptions(spec) || 'none'})` }
      }
      if (++operands > maxOperands)
        return { risk: 'blocked', reason: maxOperands ? `"| ${name}" takes ${maxOperands === 1 ? 'one pattern' : `${maxOperands} arguments`}; "${a}" would be read as a file` : `"| ${name} ${a}": a file operand reads or writes the device filesystem` }
    }
    return undefined
  }
}

const allowedOptions = (spec: ShellFilterSpec) =>
  [...(spec.flags ?? '')].map((f) => `-${f}`).concat(Object.keys(spec.values ?? {}).map((k) => `-${k} <value>`)).join(' ')

const GREP: ShellFilterSpec = { flags: 'ivcnwxEFo', values: { A: INT, B: INT, C: INT, m: INT }, operands: 1 }

/** The allowed form of each Linux-style filter (shared by EOS, NX-OS and IOS-XR `utility`). */
export const SHELL_FILTERS: Readonly<Record<'grep' | 'egrep' | 'fgrep' | 'head' | 'tail' | 'wc' | 'sort' | 'uniq' | 'cut' | 'tr' | 'diff', ArgRule>> = {
  grep: shellFilter('grep', GREP),
  egrep: shellFilter('egrep', GREP),
  fgrep: shellFilter('fgrep', GREP),
  head: shellFilter('head', { values: { n: INT, c: INT }, legacyCount: true }),
  tail: shellFilter('tail', { values: { n: INT, c: INT }, legacyCount: true }),
  wc: shellFilter('wc', { flags: 'lwcm' }),
  sort: shellFilter('sort', { flags: 'nrufbdhMV', values: { k: /^\d{1,3}(?:[.,]\d{1,3})*$/ } }),
  uniq: shellFilter('uniq', { flags: 'cdui', values: { f: INT, s: INT, w: INT } }),
  cut: shellFilter('cut', { values: { f: /^[\d,-]{1,32}$/, c: /^[\d,-]{1,32}$/, b: /^[\d,-]{1,32}$/, d: /^[A-Za-z0-9:,./@%+_-]$/ } }),
  tr: shellFilter('tr', { flags: 'dsc', operands: 2 }),
  diff: shellFilter('diff', { flags: 'cubiwyds' })
}

/** Count runnable nodes (distinct commands) in a compiled tree. */
export function countCommands(root: CommandNode): number {
  let n = root.runnable ? 1 : 0
  for (const k of root.keywords) n += countCommands(k)
  for (const p of root.params) n += countCommands(p)
  return n
}
