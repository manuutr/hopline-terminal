/**
 * A TypeScript port of Google's TextFSM (python `textfsm` 1.1.3, `parser.py`), faithful to its
 * semantics so ntc-templates parse exactly as they do in Python:
 *
 * - Values with options Filldown, Key, Required, List (with nested named groups → dicts) and
 *   Fillup, applied through the same option hooks in declaration order.
 * - States with rules `^regex -> LineOp.RecordOp NewState`; line ops Next (default), Continue,
 *   Error; record ops NoRecord (default), Record, Clear, Clearall; the reserved End and EOF states.
 * - `${VALUE}` / `$VALUE` substitution with Python `string.Template` rules (`$$` is a literal `$`).
 * - Rules match at the start of the line only (Python `re.match`).
 * - At end of input, the current record is appended unless the FSM reached End or the template
 *   declares an EOF state.
 *
 * Template errors throw TextFSMTemplateError; an `Error` action throws TextFSMError.
 */
import { compilePyRegex, groupCount, pyMatch } from './pyre'
import { ParseTimeoutError } from './types'

export class TextFSMTemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TextFSMTemplateError'
  }
}
export class TextFSMError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TextFSMError'
  }
}

/** A recorded value: a string, or for List values an array of strings or nested-group dicts. */
export type ListItem = string | null | Record<string, string | null>
export type FsmCell = string | ListItem[]

class SkipRecord {}

const MAX_NAME_LEN = 48
const COMMENT = /^\s*#/
const STATE_NAME = /^(\w+)$/
const LINE_OPS = ['Continue', 'Next', 'Error'] as const
const RECORD_OPS = ['Clear', 'Clearall', 'Record', 'NoRecord'] as const
const MATCH_ACTION = /^(?<match>.*)(\s->(?<action>.*))/
const LINE_OP_RE = `(?<ln_op>${LINE_OPS.join('|')})`
const RECORD_OP_RE = `(?<rec_op>${RECORD_OPS.join('|')})`
const OPERATOR_RE = `(${LINE_OP_RE}(\\.${RECORD_OP_RE})?)`
const NEWSTATE_RE = `(?<new_state>\\w+|".*")`
const ACTION_RE = new RegExp(`^\\s+${OPERATOR_RE}(\\s+${NEWSTATE_RE})?$`)
const ACTION2_RE = new RegExp(`^\\s+${RECORD_OP_RE}(\\s+${NEWSTATE_RE})?$`)
const ACTION3_RE = new RegExp(`^(\\s+${NEWSTATE_RE})?$`)

type OptionName = 'Required' | 'Filldown' | 'Fillup' | 'Key' | 'List'
const OPTION_NAMES: readonly OptionName[] = ['Required', 'Filldown', 'Fillup', 'Key', 'List']

interface Option {
  name: OptionName
  onCreate?(): void
  onClearVar?(): void
  onClearAllVar?(): void
  onAssignVar?(): void
  onSaveRecord?(): void
}

class Value {
  name = ''
  regex = ''
  /** The regex with the outer group named after the value (Python syntax). */
  template = ''
  options: Option[] = []
  value: FsmCell | null = null
  compiled: RegExp | null = null

  constructor(private readonly fsm: TextFSM) {}

  optionNames(): OptionName[] {
    return this.options.map((o) => o.name)
  }

  assignVar(v: string | null): void {
    this.value = v
    for (const o of this.options) o.onAssignVar?.()
  }
  clearVar(): void {
    this.value = null
    for (const o of this.options) o.onClearVar?.()
  }
  clearAllVar(): void {
    this.value = null
    for (const o of this.options) o.onClearAllVar?.()
  }
  onSaveRecord(): void {
    for (const o of this.options) o.onSaveRecord?.()
  }

  parse(line: string): void {
    const tokens = line.split(' ')
    if (tokens.length < 3) throw new TextFSMTemplateError('Expect at least 3 tokens on line.')
    if (!tokens[2]!.startsWith('(')) {
      for (const o of tokens[1]!.split(',')) this.addOption(o)
      for (const o of this.options) o.onCreate?.()
      this.name = tokens[2]!
      this.regex = tokens.slice(3).join(' ')
    } else {
      this.name = tokens[1]!
      this.regex = tokens.slice(2).join(' ')
    }
    if (this.name.length > MAX_NAME_LEN) throw new TextFSMTemplateError(`Invalid Value name '${this.name}' or name too long.`)
    if (this.regex[0] !== '(' || this.regex.at(-1) !== ')' || this.regex.at(-2) === '\\')
      throw new TextFSMTemplateError(`Value '${this.regex}' must be contained within a '()' pair.`)
    let compiled: RegExp
    try {
      compiled = compilePyRegex(this.regex, { sticky: true })
    } catch (e) {
      throw new TextFSMTemplateError(e instanceof Error ? e.message : String(e))
    }
    this.template = this.regex.replace(/^\(/, `(?P<${this.name}>`)
    if (this.options.some((o) => o.name === 'List')) this.compiled = compiled
  }

  private addOption(name: string): void {
    if (this.options.some((o) => o.name === name)) throw new TextFSMTemplateError(`Duplicate option "${name}"`)
    if (!OPTION_NAMES.includes(name as OptionName)) throw new TextFSMTemplateError(`Unknown option "${name}"`)
    this.options.push(makeOption(name as OptionName, this, this.fsm))
  }
}

function makeOption(name: OptionName, v: Value, fsm: TextFSM): Option {
  switch (name) {
    case 'Required':
      return {
        name,
        onSaveRecord() {
          if (!truthy(v.value)) throw new SkipRecord()
        }
      }
    case 'Filldown': {
      let my: FsmCell | null = null
      return {
        name,
        onCreate: () => (my = null),
        onAssignVar: () => (my = v.value),
        onClearVar: () => (v.value = my),
        onClearAllVar: () => (my = null)
      }
    }
    case 'Fillup':
      return {
        name,
        onAssignVar() {
          if (!truthy(v.value)) return
          const idx = fsm.values.indexOf(v)
          for (let i = fsm.result.length - 1; i >= 0; i--) {
            const rec = fsm.result[i]!
            if (truthy(rec[idx] ?? null)) break
            rec[idx] = v.value as FsmCell
          }
        }
      }
    case 'Key':
      return { name }
    case 'List': {
      let list: ListItem[] = []
      return {
        name,
        onCreate: () => (list = []),
        onAssignVar() {
          const re = v.compiled!
          let m: RegExpExecArray | null = null
          if (groupCount(re) > 1 && typeof v.value === 'string') m = pyMatch(re, v.value)
          if (m?.groups && Object.keys(m.groups).length) {
            const d: Record<string, string | null> = {}
            for (const [k, x] of Object.entries(m.groups)) d[k] = x ?? null
            list.push(d)
          } else list.push(typeof v.value === 'string' ? v.value : null)
        },
        onClearVar() {
          if (!v.optionNames().includes('Filldown')) list = []
        },
        onClearAllVar: () => (list = []),
        onSaveRecord: () => (v.value = [...list])
      }
    }
  }
}

/** Python truthiness for a value cell: None, '' and [] are false. */
function truthy(x: FsmCell | null): boolean {
  return x !== null && x.length > 0
}

interface Rule {
  match: string
  regex: RegExp
  lineOp: '' | (typeof LINE_OPS)[number]
  recordOp: '' | (typeof RECORD_OPS)[number]
  newState: string
  lineNum: number
}

/** Python `string.Template(s).substitute(map)`; throws on an invalid placeholder or unknown name. */
function substitute(s: string, map: ReadonlyMap<string, string>, lineNum: number): string {
  const bad = () => new TextFSMTemplateError(`Duplicate or invalid variable substitution: '${s}'. Line: ${lineNum}.`)
  return s.replace(/\$(?:(\$)|([_a-z][_a-z0-9]*)|\{([_a-z][_a-z0-9]*)\}|())/gi, (_m, esc: string | undefined, named: string | undefined, braced: string | undefined) => {
    if (esc !== undefined) return '$'
    const key = named ?? braced
    if (key === undefined) throw bad()
    const v = map.get(key)
    if (v === undefined) throw bad()
    return v
  })
}

function parseRule(raw: string, lineNum: number, varMap: ReadonlyMap<string, string>): Rule {
  const line = raw.trim()
  if (!line) throw new TextFSMTemplateError(`Null data in FSMRule. Line: ${lineNum}`)
  const ma = MATCH_ACTION.exec(line)
  const match = ma ? ma.groups!['match']! : line
  const source = varMap.size ? substitute(match, varMap, lineNum) : match
  let regex: RegExp
  try {
    regex = compilePyRegex(source, { sticky: true })
  } catch {
    throw new TextFSMTemplateError(`Invalid regular expression: '${source}'. Line: ${lineNum}.`)
  }
  const rule: Rule = { match, regex, lineOp: '', recordOp: '', newState: '', lineNum }
  if (!ma) return rule
  const action = ma.groups!['action']!
  const a = ACTION_RE.exec(action) ?? ACTION2_RE.exec(action) ?? ACTION3_RE.exec(action)
  if (!a) throw new TextFSMTemplateError(`Badly formatted rule '${line}'. Line: ${lineNum}.`)
  const g = a.groups ?? {}
  if (g['ln_op']) rule.lineOp = g['ln_op'] as Rule['lineOp']
  if (g['rec_op']) rule.recordOp = g['rec_op'] as Rule['recordOp']
  if (g['new_state']) rule.newState = g['new_state']
  if (rule.lineOp === 'Continue' && rule.newState)
    throw new TextFSMTemplateError(`Action '${rule.lineOp}' with new state ${rule.newState} specified. Line: ${lineNum}.`)
  if (rule.lineOp !== 'Error' && rule.newState && !/^\w+/.test(rule.newState))
    throw new TextFSMTemplateError(`Alphanumeric characters only in state names. Line: ${lineNum}.`)
  return rule
}

/** Python `str.splitlines()` boundaries. */
const SPLITLINES = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]')

export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(SPLITLINES)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** A compiled template. Parse state lives in `run`, so one TextFSM can parse many outputs. */
export class TextFSM {
  values: Value[] = []
  readonly states = new Map<string, Rule[]>()
  readonly stateList: string[] = []
  /** Records of the parse in progress (used by Fillup). */
  result: FsmCell[][] = []
  private varMap = new Map<string, string>()

  constructor(template: string) {
    if (!template) throw new TextFSMTemplateError('Null template.')
    // Python iterates the file: universal newlines, then rstrip() per line.
    const lines = template.replace(/\r\n?/g, '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    let pos = 0
    pos = this.parseVariables(lines, pos)
    for (;;) {
      const r = this.parseState(lines, pos)
      pos = r.pos
      if (!r.name) break
    }
    this.validate()
  }

  get header(): string[] {
    return this.values.map((v) => v.name)
  }

  /** Names of the values that carry an option (e.g. `Key`). */
  valuesByAttrib(option: OptionName): string[] {
    return this.values.filter((v) => v.optionNames().includes(option)).map((v) => v.name)
  }

  private parseVariables(lines: string[], start: number): number {
    let i = start
    for (; i < lines.length; i++) {
      const lineNum = i + 1
      const line = lines[i]!.trimEnd()
      if (!line) return i + 1
      if (COMMENT.test(line)) continue
      if (line.startsWith('Value ')) {
        const v = new Value(this)
        try {
          v.parse(line)
        } catch (e) {
          if (e instanceof TextFSMTemplateError) throw new TextFSMTemplateError(`${e.message} Line ${lineNum}.`)
          throw e
        }
        if (this.header.includes(v.name)) throw new TextFSMTemplateError(`Duplicate declarations for Value '${v.name}'. Line: ${lineNum}.`)
        this.values.push(v)
        this.varMap.set(v.name, v.template)
      } else if (!this.values.length) throw new TextFSMTemplateError('No Value definitions found.')
      else throw new TextFSMTemplateError(`Expected blank line after last Value entry. Line: ${lineNum}.`)
    }
    return i
  }

  private parseState(lines: string[], start: number): { name: string; pos: number } {
    let i = start
    let name = ''
    for (; i < lines.length; i++) {
      const line = lines[i]!.trimEnd()
      if (line && !COMMENT.test(line)) {
        if (!STATE_NAME.test(line) || line.length > MAX_NAME_LEN || (LINE_OPS as readonly string[]).includes(line) || (RECORD_OPS as readonly string[]).includes(line))
          throw new TextFSMTemplateError(`Invalid state name: '${line}'. Line: ${i + 1}`)
        name = line
        if (this.states.has(name)) throw new TextFSMTemplateError(`Duplicate state name: '${line}'. Line: ${i + 1}`)
        this.states.set(name, [])
        this.stateList.push(name)
        i++
        break
      }
    }
    if (!name) return { name, pos: i }
    for (; i < lines.length; i++) {
      const line = lines[i]!.trimEnd()
      if (!line) {
        i++
        break
      }
      if (COMMENT.test(line)) continue
      if (!(line.startsWith(' ^') || line.startsWith('  ^') || line.startsWith('\t^')))
        throw new TextFSMTemplateError(`Missing white space or carat ('^') before rule. Line: ${i + 1}`)
      this.states.get(name)!.push(parseRule(line, i + 1, this.varMap))
    }
    return { name, pos: i }
  }

  private validate(): void {
    if (!this.states.has('Start')) throw new TextFSMTemplateError("Missing state 'Start'.")
    if (this.states.get('End')?.length) throw new TextFSMTemplateError("Non-Empty 'End' state.")
    if (this.states.get('EOF')?.length) throw new TextFSMTemplateError("Non-Empty 'EOF' state.")
    if (this.states.has('End')) {
      this.states.delete('End')
      this.stateList.splice(this.stateList.indexOf('End'), 1)
    }
    for (const [state, rules] of this.states)
      for (const r of rules) {
        if (r.lineOp === 'Error') continue
        if (!r.newState || r.newState === 'End' || r.newState === 'EOF') continue
        if (!this.states.has(r.newState)) throw new TextFSMTemplateError(`State '${r.newState}' not found, referenced in state '${state}'`)
      }
  }

  /**
   * Parse text into records aligned with `header`. `deadline` (performance.now()/Date.now() ms
   * via `now`) is checked between lines; past it, ParseTimeoutError is thrown.
   */
  parseText(text: string, opts: { eof?: boolean; deadline?: number; now?: () => number } = {}): FsmCell[][] {
    // Reset (Python: Reset() in the constructor and between uses).
    this.result = []
    let stateName = 'Start'
    let state = this.states.get('Start')!
    for (const v of this.values) v.clearAllVar()
    const now = opts.now ?? Date.now
    const lines = splitLines(text)
    for (let n = 0; n < lines.length; n++) {
      if (opts.deadline !== undefined && (n & 15) === 0 && now() > opts.deadline) throw new ParseTimeoutError()
      const line = lines[n]!
      for (const rule of state) {
        const m = pyMatch(rule.regex, line)
        if (!m) continue
        if (m.groups) for (const [k, x] of Object.entries(m.groups)) this.values.find((v) => v.name === k)?.assignVar(x ?? null)
        if (this.operations(rule, line)) {
          if (rule.newState) {
            if (rule.newState !== 'End' && rule.newState !== 'EOF') state = this.states.get(rule.newState)!
            stateName = rule.newState
          }
          break
        }
      }
      if (stateName === 'End' || stateName === 'EOF') break
    }
    if (stateName !== 'End' && !this.states.has('EOF') && opts.eof !== false) this.appendRecord()
    return this.result
  }

  private operations(rule: Rule, line: string): boolean {
    if (rule.recordOp === 'Record') this.appendRecord()
    else if (rule.recordOp === 'Clear') this.clearRecord()
    else if (rule.recordOp === 'Clearall') this.clearAllRecord()
    if (rule.lineOp === 'Error') {
      if (rule.newState) throw new TextFSMError(`Error: ${rule.newState}. Rule Line: ${rule.lineNum}. Input Line: ${line}.`)
      throw new TextFSMError(`State Error raised. Rule Line: ${rule.lineNum}. Input Line: ${line}`)
    }
    return rule.lineOp !== 'Continue'
  }

  private appendRecord(): void {
    if (!this.values.length) return
    const rec: (FsmCell | null)[] = []
    for (const v of this.values) {
      try {
        v.onSaveRecord()
      } catch (e) {
        if (e instanceof SkipRecord) {
          this.clearRecord()
          return
        }
        throw e
      }
      rec.push(v.value)
    }
    if (rec.every((x) => x === null || (Array.isArray(x) && x.length === 0))) return
    this.result.push(rec.map((x) => x ?? ''))
    this.clearRecord()
  }

  private clearRecord(): void {
    for (const v of this.values) v.clearVar()
  }
  private clearAllRecord(): void {
    for (const v of this.values) v.clearAllVar()
  }
}
