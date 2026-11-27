/**
 * Base for Cisco-style CLIs (IOS/IOS-XE, NX-OS, EOS): a stack of suffix modes, a command tree per
 * mode, `do`, implicit exit to global config, pipes, and overridable error/help formats.
 * Subclasses supply trees, prompt suffixes and the vendor's exact strings.
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { completions, help as treeHelp, match, type HelpResult, type MatchResult, type Node } from '../../core/tree.ts'
import { splitPipes } from '../../core/text.ts'
import type { Device } from '../../state.ts'

export interface CMode {
  /** Internal id; prompts come from `suffix()`. */
  id: string
  /** Context object for the mode (interface, VLAN, ACL, BGP neighbor ...). */
  ctx?: unknown
  /** Parent mode (exit goes here). */
  up?: CMode
}

export type Failure = Extract<MatchResult, { ok: false }>

export interface PipeOutcome {
  out: string
  noMore?: boolean
}

export abstract class CiscoBase implements Personality {
  protected readonly s: Session
  protected readonly d: Device
  mode: CMode = { id: 'exec' }
  /** false = user EXEC (`>`). */
  privileged = true
  abortKeys = ['\x03']
  /** How exec commands run from config: `do` prefix, or inherited directly (EOS). */
  protected execFromConfig: 'do' | 'inherit' = 'do'
  /** Typing a global command in a sub-mode leaves the sub-mode (IOS, EOS). */
  protected implicitExit = true

  abstract pager: PagerSpec

  constructor(s: Session) {
    this.s = s
    this.d = s.d
  }

  // ------------------------------------------------------------------ hooks for subclasses

  /** Command tree for a mode id. */
  protected abstract tree(modeId: string): Node[]
  /** Prompt suffix for a mode, e.g. '(config-if)'; '' for exec. */
  protected abstract suffix(m: CMode): string
  protected abstract errInvalid(line: string, f: Failure): string
  protected abstract errAmbiguous(line: string, f: Failure): string
  protected abstract errIncomplete(line: string, f: Failure): string
  /** `word?` with no space: matching keywords. */
  protected abstract helpPartial(words: string[]): string
  /** `cmd ?`: the option list. */
  protected abstract helpList(h: Extract<HelpResult, { ok: true }>): string
  /** Apply output pipes. */
  protected abstract pipes(out: string, pipes: string[], line: string): PipeOutcome | { error: string }
  /** Help listing for `| ?`. */
  protected pipeHelp(): string {
    return ''
  }
  /** A line that matched nothing (after implicit-exit and exec fallbacks). Default: the error. */
  protected unknown(line: string, f: Failure): Promise<string> | string {
    return this.error(line, f)
  }

  banner(): string {
    return ''
  }

  // ------------------------------------------------------------------ prompt

  hostPart(): string {
    return this.d.hostname
  }

  promptText(): string {
    return `${this.hostPart()}${this.suffix(this.mode)}${this.mode.id === 'exec' && !this.privileged ? '>' : '#'}`
  }

  prompt(_reason: PromptReason): string {
    return this.promptText()
  }

  protected promptLen(): number {
    return this.promptText().length
  }

  inConfig(): boolean {
    return this.mode.id !== 'exec'
  }

  setMode(id: string, ctx?: unknown, up?: CMode): void {
    this.mode = { id, ctx, up: up ?? (id === 'config' ? { id: 'exec' } : this.configMode()) }
  }

  protected configMode(): CMode {
    let m: CMode | undefined = this.mode
    while (m && m.id !== 'config') m = m.up
    return m ?? { id: 'config', up: { id: 'exec' } }
  }

  /** `exit` from the current mode. Returns true when leaving config entirely. */
  exitMode(): boolean {
    if (this.mode.id === 'exec') return false
    this.mode = this.mode.up ?? { id: 'exec' }
    return this.mode.id === 'exec'
  }

  endConfig(): void {
    this.mode = { id: 'exec' }
  }

  // ------------------------------------------------------------------ errors

  error(line: string, f: Failure): string {
    if (f.kind === 'ambiguous') return this.errAmbiguous(line, f)
    if (f.kind === 'incomplete') return this.errIncomplete(line, f)
    return this.errInvalid(line, f)
  }

  /** IOS/NX-OS caret line: under column `offset` of the typed line, counting the prompt. */
  protected caret(offset: number): string {
    return ' '.repeat(this.promptLen() + offset) + '^'
  }

  // ------------------------------------------------------------------ execute

  protected execTree(): Node[] {
    return this.tree(this.privileged ? 'exec' : 'user')
  }

  protected modeTree(): Node[] {
    return this.mode.id === 'exec' ? this.execTree() : this.tree(this.mode.id)
  }

  /** Resolve a line in the current mode, with `do`, implicit exit and exec inheritance. */
  protected resolve(base: string): { m: MatchResult; mode?: string; offset: number } {
    const lead = base.length - base.trimStart().length
    if (this.inConfig()) {
      const dm = /^(\s*do\s+)(.*)$/i.exec(base)
      if (dm && this.execFromConfig === 'do') {
        const m = match(dm[2]!, this.execTree())
        return { m, offset: dm[1]!.length }
      }
    }
    const m = match(base, this.modeTree())
    if (m.ok || !this.inConfig()) return { m, offset: 0 }
    if (this.implicitExit && this.mode.id !== 'config' && m.kind !== 'ambiguous') {
      const g = match(base, this.tree('config'))
      if (g.ok) return { m: g, mode: 'config', offset: 0 }
    }
    if (this.execFromConfig === 'inherit' && m.kind !== 'ambiguous') {
      const e = match(base, this.execTree())
      if (e.ok) return { m: e, offset: 0 }
    }
    void lead
    return { m, offset: 0 }
  }

  async execute(raw: string): Promise<void> {
    const [base, pipes] = splitPipes(raw)
    const r = this.resolve(base)
    if (!r.m.ok) {
      const f = { ...r.m, offset: r.m.offset + r.offset }
      const text = await this.unknown(raw, f)
      if (text) await this.s.print(text)
      return
    }
    if (r.mode === 'config') this.mode = this.configMode()
    let out = (await r.m.node.run!(r.m.ctx)) ?? ''
    let noMore = false
    if (pipes.length) {
      const p = this.pipes(out, pipes, raw)
      if ('error' in p) out = p.error
      else {
        out = p.out
        noMore = !!p.noMore
      }
    }
    if (out) await this.s.print(out, { noMore })
  }

  // ------------------------------------------------------------------ help & completion

  help(line: string): string {
    const [base, pipes] = splitPipes(line)
    if (pipes.length) return this.pipeHelp()
    let roots = this.modeTree()
    let text = base
    let shift = 0
    const dm = this.inConfig() && this.execFromConfig === 'do' ? /^(\s*do\s+)(.*)$/i.exec(base) : null
    if (dm) {
      roots = this.execTree()
      text = dm[2]!
      shift = dm[1]!.length
    }
    let h = treeHelp(text, roots)
    if (this.inConfig() && h.ok && !h.entries.length && !h.cr && this.mode.id !== 'config') h = treeHelp(text, this.tree('config'))
    if (!h.ok) {
      if (h.kind === 'ambiguous') return this.errAmbiguous(text, { ok: false, kind: 'ambiguous', index: h.index, offset: h.offset + shift, token: h.token })
      return this.errInvalid(line, { ok: false, kind: 'invalid', index: h.index, offset: h.offset + shift, token: h.token })
    }
    if (h.partial) return this.helpPartial(h.entries.filter((e) => e.keyword).map((e) => e.label))
    return this.helpList(h)
  }

  tab(line: string): TabResult {
    const [base, pipes] = splitPipes(line)
    if (pipes.length) return { bell: true }
    let roots = this.modeTree()
    let text = base
    const dm = this.inConfig() && this.execFromConfig === 'do' ? /^(\s*do\s+)(.*)$/i.exec(base) : null
    if (dm) {
      roots = this.execTree()
      text = dm[2]!
    }
    const { partial, options } = completions(text, roots)
    if (options.length === 1) return { line: line.slice(0, line.length - partial.length) + options[0] + ' ' }
    return this.tabAmbiguous(line, options)
  }

  /** Tab with zero or several candidates. IOS: bell. NX-OS: list them. */
  protected tabAmbiguous(_line: string, _options: string[]): TabResult {
    return { bell: true }
  }

  control(key: 'c' | 'z', _line: string): ControlResult {
    if (key === 'z') {
      if (!this.inConfig()) return { echo: '' }
      return { echo: '^Z\n', then: () => this.endConfig() }
    }
    return { echo: '^C\n', then: () => this.inConfig() && this.endConfig() }
  }
}

/** Format an IOS-style option list: two-space indent, keyword padded to the longest + 2. */
export function ciscoHelpList(h: Extract<HelpResult, { ok: true }>, opts: { cr: string; minWidth?: number; indent?: string }): string {
  const labels = h.entries.map((e) => e.label)
  if (h.cr) labels.push('<cr>')
  const width = Math.max(opts.minWidth ?? 0, ...labels.map((l) => l.length)) + 2
  const indent = opts.indent ?? '  '
  const lines = h.entries.map((e) => `${indent}${e.label.padEnd(width)}${e.help}`.trimEnd())
  if (h.cr) lines.push(opts.cr ? `${indent}${'<cr>'.padEnd(width)}${opts.cr}` : `${indent}<cr>`)
  return lines.join('\n')
}
