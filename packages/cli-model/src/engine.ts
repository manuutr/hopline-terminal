import { canonicalInterface, matchParam } from './params'
import type { CommandNode, ConfirmSpec, InterfaceSyntax, LiveValues, ModeId, PipeProfile, PlatformId, Risk } from './types'
import { maxRisk, RISK_ORDER } from './types'
import { getPlatform, type PlatformModel } from './registry'
import { probeRisk } from './probe'
import { abbreviates } from './words'

// ---------------------------------------------------------------------------------------------
// Tokenizer

export interface Token {
  text: string
  start: number
  end: number
  quoted: boolean
}

/**
 * Split a CLI line into tokens. `|` is always its own token unless it sits inside double quotes
 * on a platform where quotes group (Junos `match "a|b"`). Unbalanced quotes are reported.
 */
export function tokenize(line: string, quotes: boolean): { tokens: Token[]; unbalanced: boolean } {
  const tokens: Token[] = []
  let i = 0
  let unbalanced = false
  const n = line.length
  while (i < n) {
    const c = line[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (c === '|') {
      tokens.push({ text: '|', start: i, end: i + 1, quoted: false })
      i++
      continue
    }
    const start = i
    let text = ''
    let quoted = false
    while (i < n) {
      const ch = line[i]!
      if (ch === ' ' || ch === '\t' || ch === '|') break
      if (quotes && (ch === '"' || ch === "'")) {
        quoted = true
        const close = line.indexOf(ch, i + 1)
        if (close < 0) {
          unbalanced = true
          text += line.slice(i + 1)
          i = n
          break
        }
        text += line.slice(i + 1, close)
        i = close + 1
        continue
      }
      text += ch
      i++
    }
    tokens.push({ text, start, end: i, quoted })
  }
  return { tokens, unbalanced }
}

// ---------------------------------------------------------------------------------------------
// Walker: every interpretation of a token list against a tree

interface Step {
  node: CommandNode
  index: number
  count: number
}

export type InterpStatus = 'ok' | 'incomplete' | 'invalid'

export interface Interpretation {
  steps: Step[]
  node: CommandNode
  status: InterpStatus
  /** Token index where matching stopped (invalid/incomplete). */
  at: number
  /** Some token was an ambiguous prefix; the device would refuse it. */
  ambiguous?: { index: number; candidates: string[] }
  mode: ModeId
  /**
   * The open deny-listed head's reading of an abbreviation (Phase 8 M1). It only counts when every
   * other reading is read-only: an abbreviation must never auto-run because the tree lists only the
   * harmless word it could stand for.
   */
  shadow?: boolean
}

interface WalkCtx {
  tokens: readonly string[]
  lower: readonly string[]
  model: PlatformModel
  out: Interpretation[]
  overflow: boolean
  mode: ModeId
  ambiguous?: { index: number; candidates: string[] }
}

const MAX_INTERPRETATIONS = 48

function matchKeywords(node: CommandNode, t: string): CommandNode[] {
  let prefix: CommandNode[] | undefined
  for (const k of node.keywords) {
    const w = k.word!
    if (w === t) return [k]
    if (w.startsWith(t)) (prefix ??= []).push(k)
  }
  if (!prefix) return []
  if (prefix.length > 1 && node.priority) {
    const p = node.priority.get(t)
    const hit = p && prefix.find((k) => k.word === p)
    if (hit) return [hit]
  }
  return prefix
}

function walk(ctx: WalkCtx, node: CommandNode, i: number, steps: Step[]): void {
  if (ctx.out.length >= MAX_INTERPRETATIONS) {
    ctx.overflow = true
    return
  }
  const n = ctx.tokens.length
  if (node.exec && i < n) {
    for (const root of ctx.model.roots(node.exec)) walk(ctx, root, i, steps)
    return
  }
  if (i === n) {
    ctx.out.push({ steps, node, status: node.runnable ? 'ok' : 'incomplete', at: i, ambiguous: ctx.ambiguous, mode: ctx.mode })
    return
  }
  const t = ctx.lower[i]!
  const kws = t === '' ? [] : matchKeywords(node, t)
  // Phase 8 M1: under a deny-listed open head (`request ...` on PAN-OS), a word that only
  // abbreviates a modelled read child may also abbreviate an unmodelled sibling (`in` is `info` or
  // `install`). Keep the open head's meaning as one more interpretation, so the worst one counts.
  if (kws.length && kws[0]!.word !== t && steps.some((s) => s.node.open && s.node.risk === 'blocked'))
    ctx.out.push({ steps, node, status: 'ok', at: n, ambiguous: { index: i, candidates: [...kws.map((k) => k.word!), '(unmodelled)'] }, mode: ctx.mode, shadow: true })
  if (kws.length === 1) {
    walk(ctx, kws[0]!, i + 1, [...steps, { node: kws[0]!, index: i, count: 1 }])
  } else if (kws.length > 1) {
    const saved = ctx.ambiguous
    ctx.ambiguous ??= { index: i, candidates: kws.map((k) => k.word!) }
    for (const k of kws) walk(ctx, k, i + 1, [...steps, { node: k, index: i, count: 1 }])
    ctx.ambiguous = saved
  }
  let paramHit = false
  if (kws.length === 0) {
    for (const p of node.params) {
      const c = matchParam(p.param!, ctx.tokens, i, ctx.model.profile.interfaces)
      if (c > 0) {
        paramHit = true
        walk(ctx, p, i + c, [...steps, { node: p, index: i, count: c }])
      }
    }
  }
  // Nothing in the tree matched this token: an open node accepts it (the device validates the
  // options we do not model); otherwise the parse fails here.
  if (kws.length === 0 && !paramHit) {
    ctx.out.push({ steps, node, status: node.open ? 'ok' : 'invalid', at: node.open ? n : i, ambiguous: ctx.ambiguous, mode: ctx.mode })
  }
}

function interpret(model: PlatformModel, mode: ModeId, tokens: readonly string[]): { interps: Interpretation[]; overflow: boolean } {
  const lower = tokens.map((t) => t.toLowerCase())
  const out: Interpretation[] = []
  let overflow = false
  const level = model.profile.modes.find((d) => d.id === mode)?.level
  const inConfig = level === 'config' || level === 'sub-config'
  // A configuration command that shares its first word with an exec deny-list head (`feature bgp`
  // on NX-OS, `ssh <net> <mask> inside` on ASA): the exec tree does not apply to it in config mode.
  const shadowed = inConfig && !!lower[0] && !!model.profile.configShadowsExec?.includes(lower[0])
  for (const [m, root] of model.rootsWithModes(mode)) {
    if (m === 'exec' && shadowed) continue
    const ctx: WalkCtx = { tokens, lower, model, out, overflow: false, mode: m }
    walk(ctx, root, 0, [])
    overflow ||= ctx.overflow
  }
  return { interps: out, overflow }
}

// ---------------------------------------------------------------------------------------------
// Risk of an interpretation

interface Assessed {
  interp: Interpretation
  risk: Risk
  reason: string
}

function effectiveRisk(interp: Interpretation, tokens: readonly string[]): { risk: Risk | undefined; reason: string | undefined; node?: CommandNode } {
  let risk: Risk | undefined
  let reason: string | undefined
  let node: CommandNode | undefined
  for (const s of interp.steps) {
    if (s.node.risk) {
      risk = s.node.risk
      reason = s.node.reason
      node = s.node
    }
  }
  if (interp.status === 'ok') {
    for (const s of interp.steps) {
      if (!s.node.rule) continue
      const r = s.node.rule(tokens.slice(s.index + s.count))
      if (r && (!risk || RISK_ORDER[r.risk] > RISK_ORDER[risk])) {
        risk = r.risk
        reason = r.reason
      }
    }
  }
  return { risk, reason, node }
}

const expandedOf = (interp: Interpretation, tokens: readonly string[]) =>
  interp.steps.map((s) => (s.node.word ?? tokens.slice(s.index, s.index + s.count).join(' '))).join(' ')

function assess(interp: Interpretation, tokens: readonly string[]): Assessed | null {
  const { risk, reason } = effectiveRisk(interp, tokens)
  const what = expandedOf(interp, tokens) || tokens.join(' ')
  if (interp.status !== 'ok') {
    // A failed parse does nothing on the device, unless it sits under a deny-listed or disruptive head.
    if (risk === 'blocked' || risk === 'disruptive') return { interp, risk, reason: reason ?? `"${what}" is ${risk}` }
    return null
  }
  let r: Risk = risk ?? 'config'
  let why = reason ?? (risk ? `"${what}" is ${risk === 'read' ? 'read-only' : risk}` : `"${what}" can change device state`)
  if (interp.ambiguous && r === 'read') {
    r = 'config'
    why = `"${tokens[interp.ambiguous.index]}" is ambiguous (${interp.ambiguous.candidates.join(', ')})`
  }
  if (r === 'read' && interp.mode !== 'pipe') {
    const w = readArgumentRisk(tokens.slice(1))
    if (w) {
      r = w.risk
      why = w.reason
    }
  }
  return { interp, risk: r, reason: why }
}

/** `to-file` and its abbreviations (C9800/IOS-XE `show logging … to-file bootflash:x`). */
const TO_FILE = /^to-f(?:i(?:le?)?)?$/i
/** A destination on another host: a read command never needs one, writers (`… tftp://x/y`) do. */
const REMOTE_URL = /^(?:tftp|ftp|sftp|scp|rcp|http|https):/i
/**
 * Words that turn a show into an action (`show platform … punt cause clear`), with their
 * abbreviations of three letters or more (Phase 8: no rule matches a raw spelled-out word only).
 */
const ACTION_WORDS = ['clear', 'reset', 'delete', 'erase']
const isActionWord = (a: string) => ACTION_WORDS.some((w) => abbreviates(w, a, 3))

/**
 * Arguments of a read command (modelled or swallowed by an open `…` node) that make it write a
 * file, send output to another host or clear state. Checked on every platform: open-ended show
 * subtrees accept options we do not model, and some of those write.
 */
function readArgumentRisk(args: readonly string[]): { risk: Risk; reason: string } | undefined {
  for (const a of args) {
    if (TO_FILE.test(a)) return { risk: 'blocked', reason: `"${a}" writes the output to a file on the device` }
    if (REMOTE_URL.test(a)) return { risk: 'blocked', reason: `"${a}" sends output to or loads it from another host` }
  }
  const act = args.find(isActionWord)
  if (act) return { risk: 'config', reason: `"${act}" makes this more than a read: it can clear or reset state` }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Public API

export interface ResolvedToken {
  text: string
  start: number
  end: number
  kind: 'keyword' | 'param' | 'pipe' | 'unknown'
  /** Expanded keyword, or the parameter label. */
  value: string
  help: string
}

export interface SegmentResolution {
  status: 'ok' | 'incomplete' | 'invalid' | 'ambiguous' | 'empty'
  expanded: string
  risk: Risk
  reason: string
  /** Node where the primary interpretation ended. */
  node?: CommandNode
}

export interface PipeStage {
  name: string
  args: string[]
}

export interface Resolution {
  platform: PlatformId
  mode: ModeId
  /** Mode whose tree the primary interpretation came from (a sub-mode line may resolve in global config). */
  resolvedMode?: ModeId
  /** Status of the primary (device-preferred) interpretation of the command before any pipe. */
  status: SegmentResolution['status']
  /** Canonical form: keywords expanded, parameters as typed, pipes appended. */
  expanded: string
  tokens: ResolvedToken[]
  /** Captured parameters of the primary interpretation (interface, vrf, vlan, neighbor, …). */
  params: Record<string, string>
  /**
   * Conservative risk over every interpretation (ambiguous prefixes, mode fallbacks) and every pipe.
   * Anything that does not resolve to a runnable read command is at least `config`.
   */
  risk: Risk
  reason: string
  /** Help of the node the command ends on. */
  help: string
  runnable: boolean
  enters?: ModeId
  /** Some interpretation leaves configuration mode (end/exit). */
  leaves: boolean
  confirm: readonly ConfirmSpec[]
  error?: { token: number; column: number; message: string }
  ambiguity?: { token: number; text: string; candidates: string[] }
  pipes: SegmentResolution[]
  /** The command before the first pipe, abbreviations expanded where it resolved (else as typed). */
  base: string
  /** Pipe stages as the device parses them: filter name (expanded) and its arguments as typed. */
  stages: PipeStage[]
  interpretations: number
  unbalancedQuote: boolean
}

function resolveTokens(model: PlatformModel, mode: ModeId, toks: readonly Token[]): {
  seg: SegmentResolution
  primary?: Interpretation
  assessed: Assessed[]
  all: Interpretation[]
} {
  const texts = toks.map((t) => t.text)
  if (!texts.length) return { seg: { status: 'empty', expanded: '', risk: 'blocked', reason: 'empty command' }, assessed: [], all: [] }
  const { interps, overflow } = interpret(model, mode, texts)
  const assessed = interps.map((i) => assess(i, texts)).filter((a): a is Assessed => a !== null)
  // Primary interpretation: the one the device would pick (unambiguous ok first, then furthest progress).
  const rank = (i: Interpretation) => (i.shadow ? -1 : i.status === 'ok' ? (i.ambiguous ? 2 : 3) : i.status === 'incomplete' ? 1 : 0)
  let primary: Interpretation | undefined
  for (const i of interps) {
    if (!primary || rank(i) > rank(primary) || (rank(i) === rank(primary) && i.at > primary.at)) primary = i
  }
  let risk: Risk = 'read'
  let reason = ''
  const anyOk = interps.some((i) => i.status === 'ok' && !i.shadow)
  // Shadow readings (see Interpretation.shadow) only matter when everything else is read.
  const real = assessed.filter((a) => !a.interp.shadow)
  const allRead = real.every((a) => a.risk === 'read')
  for (const a of assessed) {
    if (a.interp.shadow && !allRead) continue
    if (!reason || RISK_ORDER[a.risk] > RISK_ORDER[risk]) {
      risk = a.risk
      reason = a.reason
    }
  }
  if (!assessed.length || !anyOk) {
    const failed = primary && primary.status !== 'ok'
    const base: Risk = 'config'
    if (!assessed.length) {
      risk = base
      const t = primary ? texts[Math.min(primary.at, texts.length - 1)] : texts[0]
      reason =
        primary?.status === 'incomplete'
          ? `"${texts.join(' ')}" is incomplete`
          : failed
            ? `"${t}" is not a known command here`
            : `"${texts.join(' ')}" is not a known read-only command`
    } else risk = maxRisk(risk, base)
  }
  if (overflow) {
    risk = 'blocked'
    reason = 'too many possible meanings to classify safely'
  }
  const status: SegmentResolution['status'] = !primary
    ? 'invalid'
    : primary.status === 'ok'
      ? primary.ambiguous
        ? 'ambiguous'
        : 'ok'
      : primary.ambiguous && primary.status === 'invalid'
        ? 'ambiguous'
        : primary.status
  return {
    seg: { status, expanded: primary ? expandedOf(primary, texts) : '', risk, reason, node: primary?.node },
    primary,
    assessed,
    all: interps
  }
}

const NEGATORS = new Set(['no', 'default', 'undo'])

/** Why `no X` is blocked (X is blocked and the negation is not modelled on its own), else undefined. */
function negatedBlocked(model: PlatformModel, mode: ModeId, primary: Interpretation | undefined, toks: readonly Token[]): string | undefined {
  const level = model.profile.modes.find((d) => d.id === mode)?.level
  if (level !== 'config' && level !== 'sub-config') return undefined
  const first = primary?.steps[0]
  if (!primary || !first?.node.word || !NEGATORS.has(first.node.word) || toks.length < 2) return undefined
  // An explicit negation entry (`no archive …`) carries its own risk deeper than the generic `no …`.
  const { node } = effectiveRisk(primary, toks.map((t) => t.text))
  if (primary.status === 'ok' && node && node !== first.node) return undefined
  const rest = resolveTokens(model, mode, toks.slice(1)).seg
  if (rest.risk !== 'blocked') return undefined
  return `"${first.node.word} ${rest.expanded || toks.slice(1).map((t) => t.text).join(' ')}" is blocked like the command it negates (${rest.reason})`
}

/** The unique filter `word` abbreviates, if any. */
function pipeFilter(filters: readonly string[], word: string | undefined): string | undefined {
  if (!word) return undefined
  const w = word.toLowerCase()
  const hits = filters.filter((f) => f.startsWith(w))
  return hits.length === 1 ? hits[0] : filters.includes(w) ? w : undefined
}

/**
 * Split on unquoted `|`. Where the platform's regex filters take the rest of the line (IOS), the
 * first such filter swallows every later `|` into its regex; `hidden` reports a writer word found
 * right after one of those `|` (`| i foo | redirect flash:x`).
 */
/**
 * A writer the device might see if it treated an inner `|` as a pipe: the word abbreviates one
 * and either is spelled out or is followed by a destination (`| i Gi|Te` is a regex, `| i x|tee
 * flash:y` is not let through).
 */
function writerAt(writers: readonly string[] | undefined, word: string | undefined, hasArg: boolean): string | undefined {
  if (!writers || !word) return undefined
  const w = word.toLowerCase()
  return writers.find((x) => x === w || (hasArg && x.startsWith(w)))
}

/**
 * Split on unquoted `|`. Where the platform's regex filters take the rest of the line (IOS), the
 * first such filter swallows every later `|` into its regex. `hidden` reports a writer found right
 * after an inner `|`, in that regex or inside quotes, in case the device splits there after all.
 */
function splitPipes(tokens: Token[], pipes: PipeProfile): { segs: Token[][]; hidden?: string; quotedStages: string[] } {
  const segs: Token[][] = [[]]
  let inRegex = false
  let hidden: string | undefined
  const quotedStages: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.text === '|' && !t.quoted && !inRegex) {
      segs.push([])
      const f = pipes.regexRest ? pipeFilter(pipes.filters, tokens[i + 1]?.text) : undefined
      if (f && pipes.regexRest!.includes(f)) inRegex = true
      continue
    }
    if (inRegex && t.text === '|' && !t.quoted) {
      // Words after the `|`, up to the next one: `Te` alone, or `tee flash:x`.
      const next = tokens[i + 1]
      const after = tokens[i + 2]
      hidden ??= writerAt(pipes.writers, next?.text, !!after && after.text !== '|')
    }
    if (t.quoted && t.text.includes('|')) {
      for (const part of t.text.split('|').slice(1)) {
        const words = part.trim().split(/\s+/).filter(Boolean)
        hidden ??= writerAt(pipes.writers, words[0], words.length > 1)
        if (words.length) quotedStages.push(words.join(' '))
      }
    }
    segs.at(-1)!.push(t)
  }
  return { segs, hidden, quotedStages }
}

/**
 * Resolve a CLI line in a mode: expand abbreviations, report ambiguity, fill parameters and give
 * the risk. `mode` defaults to the platform's privileged exec / operational mode.
 */
export function resolve(platform: PlatformId, mode: ModeId, line: string, opts: { probes?: boolean } = {}): Resolution {
  const model = getPlatform(platform)
  const { tokens, unbalanced } = tokenize(line, model.profile.quotes)
  const split = splitPipes(tokens, model.profile.pipes)
  const [baseToks, ...pipeSegs] = split.segs
  const base = resolveTokens(model, mode, baseToks!)
  const pipes = pipeSegs.map((seg, i) => {
    if (!seg.length) return { status: 'empty', expanded: '', risk: 'blocked', reason: 'empty pipe segment' } satisfies SegmentResolution
    const r = resolveTokens(model, 'pipe', seg).seg
    if (r.status !== 'ok' && RISK_ORDER[r.risk] < RISK_ORDER.blocked) {
      const word = seg[0]!.text
      const known = r.status === 'invalid' && r.expanded === ''
      const readable = (n: CommandNode, depth: number): boolean =>
        n.risk === 'read' || (depth > 0 && [...n.keywords, ...n.params].some((c) => readable(c, depth - 1)))
      const reads = (model.tree('pipe')?.keywords ?? []).filter((k) => !k.risk && readable(k, 2) || k.risk === 'read').map((k) => k.word)
      const prev = i > 0 ? pipeSegs[i - 1]![0]?.text : undefined
      const afterRegex = prev !== undefined && /^(?:i|in|inc|incl|inclu|includ|include|e|ex|exc|excl|exclu|exclud|exclude|grep|egrep|match|except)$/.test(prev)
      const reason = !known
        ? `pipe "| ${word}" is ${r.status}: ${r.reason}`
        : afterRegex
        ? `${model.profile.label} starts a new pipe at every "|", so "| ${prev} …|${word}" is not regex alternation; filter for each pattern separately, or ask Hopline Terminal to filter the output locally`
        : reads.length
        ? `${model.profile.label} has no "| ${word}" read-only filter; use ${reads.map((w) => `| ${w}`).join(', ')}, or ask Hopline Terminal to filter the output locally`
        : `${model.profile.label} has no read-only output filters ("| ${word}"); run the command without a pipe and ask Hopline Terminal to filter the output locally`
      return { ...r, risk: 'blocked' as Risk, reason }
    }
    return r
  })

  let risk = base.seg.risk
  let reason = base.seg.reason
  for (const p of pipes) {
    if (RISK_ORDER[p.risk] > RISK_ORDER[risk]) {
      risk = p.risk
      reason = p.reason
    }
  }
  // A `|` inside quotes, in case the device splits there after all: what follows must be harmless
  // as a pipe stage too (an unknown word only makes the device print an error).
  for (const text of model.profile.pipes.quotesUnverified ? split.quotedStages : []) {
    const r = resolveTokens(model, 'pipe', tokenize(text, false).tokens).seg
    if (r.risk === 'blocked' || (r.status === 'ok' && r.risk !== 'read')) {
      risk = 'blocked'
      reason = `"| ${text.split(' ')[0]}" inside quotes would be a ${r.risk} pipe stage if the device split there`
    }
  }
  // Where pipe stages reach a Linux shell (EOS), quotes, backslashes and `=` reshape the words the
  // program sees (`sort '-o' FILE`, `sort -\o FILE`, `sort --o=FILE`): refused in any stage.
  if (model.profile.pipes.unknown === 'shell') {
    for (const seg of pipeSegs) {
      if (!seg.length) continue
      const raw = line.slice(seg[0]!.start, seg.at(-1)!.end)
      if (/["'\\=`]/.test(raw)) {
        risk = 'blocked'
        reason = `"| ${seg[0]!.text}": quotes, backslashes and "=" are not allowed in a pipe on ${model.profile.label} (pipe stages run as Linux commands)`
      }
    }
  }
  if (split.hidden) {
    risk = 'blocked'
    reason = `"| ${split.hidden}" inside a regex or quotes: refused in case the device treats it as a pipe`
  }
  if (unbalanced) {
    risk = 'blocked'
    reason = 'unbalanced quote'
  }
  // Phase 8 M1: `no X` / `default X` (VRP `undo X`) in a configuration mode is blocked when X is,
  // unless the tree lists that negation itself (`no archive`, `no shutdown` …). Removing a
  // deny-listed feature (`no crypto pki trustpoint`, `no redundancy`) is as dangerous as adding it.
  if (RISK_ORDER[risk] < RISK_ORDER.blocked) {
    const neg = negatedBlocked(model, mode, base.primary, baseToks!)
    if (neg) {
      risk = 'blocked'
      reason = neg
    }
  }
  // Reachability probes (Phase 8 H2): their options sit under an open `...`; probe.ts resolves them
  // with the shared canonicaliser (which calls back here with probes off) and applies the caps.
  if (risk === 'read' && opts.probes !== false) {
    const p = probeRisk(platform, mode, line)
    if (p) {
      risk = p.risk
      reason = p.reason
    }
  }

  const primary = base.primary
  const texts = baseToks!.map((t) => t.text)
  const resolvedTokens: ResolvedToken[] = []
  const params: Record<string, string> = {}
  if (primary) {
    for (const s of primary.steps) {
      const first = baseToks![s.index]!
      const last = baseToks![s.index + s.count - 1]!
      const text = line.slice(first.start, last.end)
      if (s.node.word) resolvedTokens.push({ text, start: first.start, end: last.end, kind: 'keyword', value: s.node.word, help: s.node.help })
      else {
        resolvedTokens.push({ text, start: first.start, end: last.end, kind: 'param', value: s.node.param!.label, help: s.node.help })
        if (s.node.param!.capture) params[s.node.param!.capture] = texts.slice(s.index, s.index + s.count).join(' ')
      }
    }
  }
  const covered = new Set(resolvedTokens.map((t) => t.start))
  for (const t of tokens) {
    if (t.text === '|' && !t.quoted) resolvedTokens.push({ text: '|', start: t.start, end: t.end, kind: 'pipe', value: '|', help: 'Output modifiers' })
    else if (baseToks!.includes(t) && !covered.has(t.start) && !(primary && primary.status === 'ok'))
      resolvedTokens.push({ text: t.text, start: t.start, end: t.end, kind: 'unknown', value: t.text, help: '' })
  }
  resolvedTokens.sort((a, b) => a.start - b.start)

  let error: Resolution['error']
  if (primary && primary.status !== 'ok' && !primary.ambiguous) {
    const tok = baseToks![Math.min(primary.at, baseToks!.length - 1)]
    error = {
      token: primary.at,
      column: primary.status === 'incomplete' ? line.trimEnd().length : (tok?.start ?? 0),
      message: primary.status === 'incomplete' ? 'incomplete command' : `invalid input at "${tok?.text ?? ''}"`
    }
  }
  const amb = primary?.ambiguous ?? base.all.find((i) => i.ambiguous)?.ambiguous
  const node = primary?.node
  const expanded = [base.seg.expanded, ...pipes.map((p) => p.expanded)].filter((s, i) => i === 0 || s).join(' | ')
  return {
    platform,
    mode,
    resolvedMode: primary?.mode,
    status: base.seg.status,
    expanded,
    tokens: resolvedTokens,
    params,
    risk,
    reason,
    help: node?.help ?? '',
    runnable: !!node?.runnable && primary?.status === 'ok',
    enters: primary?.status === 'ok' ? node?.enters : undefined,
    leaves: base.all.some((i) => i.status === 'ok' && i.node.leaves),
    confirm: primary?.status === 'ok' ? (node?.confirm ?? []) : [],
    error,
    ambiguity: amb ? { token: amb.index, text: texts[amb.index] ?? '', candidates: amb.candidates } : undefined,
    pipes,
    base: base.seg.expanded || texts.join(' '),
    stages: pipeSegs.map((seg, i) => {
      const name = seg.length ? pipes[i]!.expanded.split(' ')[0] || seg[0]!.text : ''
      // A rest-of-line regex (IOS) is one argument, exactly as typed.
      const regex = seg.length > 1 && model.profile.pipes.regexRest?.includes(name)
      return { name, args: regex ? [line.slice(seg[1]!.start, seg.at(-1)!.end)] : seg.slice(1).map((t) => t.text) }
    }),
    interpretations: base.all.length,
    unbalancedQuote: unbalanced
  }
}

// ---------------------------------------------------------------------------------------------
// Completion

export interface Candidate {
  /** Text to insert for the current word (keyword, live value), or the parameter label. */
  text: string
  kind: 'keyword' | 'param' | 'value' | 'cr'
  help: string
  /** Parameter label (`<1-4094>`, `A.B.C.D`). */
  label?: string
  risk?: Risk
}

export interface Completion {
  candidates: Candidate[]
  /** Characters to append to complete the current word, when the completion is unique. */
  ghost: string
  /** Start offset of the word being completed. */
  replaceFrom: number
  /** The word being completed (may be empty). */
  partial: string
}

function nodeRisk(steps: readonly CommandNode[], n: CommandNode): Risk | undefined {
  if (n.risk) return n.risk
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.risk) return steps[i]!.risk
  return undefined
}

function liveMatches(ifs: InterfaceSyntax, kind: string, values: readonly string[], partial: string): { value: string; ghost: string }[] {
  const p = partial.toLowerCase()
  const out: { value: string; ghost: string }[] = []
  const canon = kind === 'interface' ? canonicalInterface(ifs, partial).toLowerCase() : p
  for (const v of values) {
    const lv = v.toLowerCase()
    if (lv.startsWith(p)) out.push({ value: v, ghost: v.slice(partial.length) })
    else if (canon !== p && lv.startsWith(canon)) out.push({ value: v, ghost: v.slice(canon.length) })
  }
  return out
}

/**
 * Completion candidates (with docs) for the word under the cursor at the end of `line`, plus ghost
 * text when the completion is unique. `live` supplies learned values for bound parameters.
 */
export function complete(platform: PlatformId, mode: ModeId, line: string, live: LiveValues = {}): Completion {
  const model = getPlatform(platform)
  const { tokens } = tokenize(line, model.profile.quotes)
  const endsWithSpace = line === '' || /\s$/.test(line)
  const partialTok = endsWithSpace ? undefined : tokens.at(-1)
  const partial = partialTok?.quoted ? '' : (partialTok?.text ?? '')
  const replaceFrom = partialTok ? partialTok.start : line.length
  const ctxTokens = partialTok ? tokens.slice(0, -1) : tokens
  const empty: Completion = { candidates: [], ghost: '', replaceFrom, partial }
  if (partial === '|') return empty

  // After the last pipe, complete against the pipe tree.
  let lastPipe = -1
  ctxTokens.forEach((t, i) => {
    if (t.text === '|' && !t.quoted) lastPipe = i
  })
  const inPipe = lastPipe >= 0
  const seg = ctxTokens.slice(lastPipe + 1).map((t) => t.text)
  const segMode: ModeId = inPipe ? 'pipe' : mode

  // Walk the context to the node(s) the next word hangs off.
  const nodes: { node: CommandNode; path: CommandNode[] }[] = []
  const { interps } = interpret(model, segMode, seg)
  const seen = new Set<CommandNode>()
  for (const i of interps) {
    if (i.status === 'invalid' || i.ambiguous) continue
    const last = i.steps.at(-1)
    if ((last ? last.index + last.count : 0) < seg.length) continue // an open node swallowed the rest
    const target = i.node
    const path = i.steps.map((s) => s.node)
    // `do` / `run`: the next word belongs to the exec tree.
    if (target.exec) {
      for (const root of model.roots(target.exec)) if (!seen.has(root)) {
        seen.add(root)
        nodes.push({ node: root, path })
      }
      continue
    }
    if (seen.has(target)) continue
    seen.add(target)
    nodes.push({ node: target, path })
  }
  if (!seg.length && !nodes.length) for (const r of model.roots(segMode)) nodes.push({ node: r, path: [] })

  const p = partial.toLowerCase()
  const out: Candidate[] = []
  const kwSeen = new Set<string>()
  const values: { value: string; ghost: string }[] = []
  let crOffered = false
  for (const { node, path } of nodes) {
    for (const k of node.keywords) {
      if (!k.word!.startsWith(p) || kwSeen.has(k.word!)) continue
      kwSeen.add(k.word!)
      out.push({ text: k.word!, kind: 'keyword', help: k.help, risk: nodeRisk(path, k) })
    }
    for (const prm of node.params) {
      const def = prm.param!
      const vals = def.live ? live[def.live] : undefined
      const hits = vals ? liveMatches(model.profile.interfaces, def.kind, vals, partial) : []
      for (const h of hits) {
        if (values.some((v) => v.value === h.value)) continue
        values.push(h)
        out.push({ text: h.value, kind: 'value', help: def.help, label: def.label })
      }
      if (!partial || matchParam(def, [partial], 0, model.profile.interfaces) > 0 || hits.length)
        out.push({ text: def.label, kind: 'param', help: def.help, label: def.label })
    }
    if (!partial && node.runnable && !crOffered) {
      crOffered = true
      out.push({ text: '<cr>', kind: 'cr', help: node.help || 'Run the command' })
    }
  }
  // Ghost: only when exactly one keyword or one live value completes the typed word.
  let ghost = ''
  const kwHits = out.filter((c) => c.kind === 'keyword')
  if (partial) {
    const exact = kwHits.find((c) => c.text === p)
    if (exact) ghost = ''
    else if (kwHits.length === 1 && !values.length) ghost = kwHits[0]!.text.slice(partial.length)
    else if (!kwHits.length && values.length === 1) ghost = values[0]!.ghost
    else if (kwHits.length > 1) {
      const prio = nodes.map((x) => x.node.priority?.get(p)).find(Boolean)
      if (prio) ghost = prio.slice(partial.length)
    }
  }
  return { candidates: out, ghost, replaceFrom, partial }
}
