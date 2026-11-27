export * from './types'
export * from './match'
export { TextFSM, TextFSMError, TextFSMTemplateError, splitLines, type FsmCell, type ListItem } from './textfsm'
export { convertPyRegex, compilePyRegex, PyRegexError } from './pyre'

import { lookup } from './match'
import { TEMPLATES } from './templates.generated'
import { TextFSM, TextFSMError, splitLines, type FsmCell } from './textfsm'
import { ParseTimeoutError, type Cell, type ParseOptions, type ParseResult } from './types'

const fsms = new Map<string, TextFSM>()
function fsmFor(template: string): TextFSM {
  let f = fsms.get(template)
  if (!f) {
    f = new TextFSM(TEMPLATES[template]!)
    fsms.set(template, f)
  }
  return f
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Python `repr()` of a str, as `str(dict)` prints it. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let body = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
  if (q === "'") body = body.replace(/'/g, "\\'")
  return q + body + q
}

/**
 * ntc's output shape: clitable's texttable stringifies every List entry with Python `str()`, so a
 * missing entry is `'None'` and a nested-group dict is its Python repr (`{'name': 'x'}`).
 */
export function toNtcCell(c: FsmCell): Cell {
  if (typeof c === 'string') return c
  return c.map((x) =>
    x === null
      ? 'None'
      : typeof x === 'string'
        ? x
        : '{' + Object.entries(x).map(([k, v]) => `${pyRepr(k)}: ${v === null ? 'None' : pyRepr(v)}`).join(', ') + '}'
  )
}

/**
 * Parse with a named bundled template (no index lookup), keeping the raw engine cells (List
 * values with nested groups stay dicts). Throws TextFSMError on an `Error` action and
 * ParseTimeoutError past the budget.
 */
export function parseWithTemplate(template: string, text: string, opts: ParseOptions = {}): { headers: string[]; keys: string[]; rows: FsmCell[][] } {
  if (TEMPLATES[template] === undefined) throw new Error(`template not bundled: ${template}`)
  const fsm = fsmFor(template)
  const deadline = opts.budgetMs !== undefined ? now() + opts.budgetMs : undefined
  const rows = fsm.parseText(text, { deadline, now })
  return { headers: fsm.header, keys: fsm.valuesByAttrib('Key'), rows: rows.map((r) => [...r]) }
}

// FortiOS 7.x also reports routes via a named tunnel and its peer, and may end a
// static path with a bracketed pair. Keep that pair out of the route-age column.
// The bundled template itself stays available unmodified via parseWithTemplate.
let fortiRouteFsm: TextFSM | undefined
function fortiRoutes(template: string): TextFSM {
  if (fortiRouteFsm) return fortiRouteFsm
  const [values, states] = TEMPLATES[template]!.split('\n\nStart\n')
  const metric = '\\[${DISTANCE}/${METRIC}\\]\\s+via\\s+'
  const paths = [
    '${INTERFACE}\\s+tunnel\\s+${GATEWAY},\\s*\\[${PATH_ATTRIBUTES}\\]',
    '${GATEWAY},\\s*${INTERFACE},\\s*\\[${PATH_ATTRIBUTES}\\]'
  ]
  const rules = paths.flatMap((path) => [
    '  ^\\s*${TYPE}\\s+${DESTINATION}\\s+' + metric + path + '\\s*$$ -> Record',
    '  ^\\s*' + metric + path + '\\s*$$ -> Record'
  ])
  fortiRouteFsm = new TextFSM([values, 'Value PATH_ATTRIBUTES (\\d+/\\d+)', '', 'Start', ...rules, states].join('\n'))
  return fortiRouteFsm
}

/** Each firewall routing table has its own namespace. Restart the upstream FSM at its
 * heading so a PAN-OS footer or FortiOS ECMP continuation cannot cross that boundary. */
function parseFirewallRoutes(template: string, platform: string, text: string, opts: ParseOptions): ParseResult | null {
  const forti = platform === 'fortinet'
  const heading = forti ? /^\s*Routing table for VRF=(\d+)\s*$/ : /^\s*VIRTUAL ROUTER:\s*(.+?)\s+\(id \d+\)\s*$/
  const headingPrefix = forti ? /^\s*Routing table for VRF/ : /^\s*VIRTUAL ROUTER:/
  const column = forti ? 'VRF' : 'VIRTUAL_ROUTER'
  const fsm = forti ? fortiRoutes(template) : fsmFor(template)
  const deadline = opts.budgetMs === undefined ? undefined : now() + opts.budgetMs
  const rows: Cell[][] = []
  let context = ''
  let section: string[] = []
  function finishSection(): void {
    if (!section.length) return
    for (const row of fsm.parseText(section.join('\n'), { deadline, now })) {
      if (forti && !row[1]) throw new TextFSMError('FortiOS route continuation without a prefix')
      rows.push([...row.map(toNtcCell), context])
    }
    section = []
  }
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) {
    if ((i & 63) === 0 && deadline !== undefined && now() > deadline) throw new ParseTimeoutError()
    const line = lines[i]!
    if (!headingPrefix.test(line)) {
      section.push(line)
      continue
    }
    const match = heading.exec(line)
    if (!match) return null
    finishSection()
    context = match[1]!
  }
  finishSection()
  if (!rows.length) return null
  const keys = forti ? [column, 'DESTINATION', 'GATEWAY', 'INTERFACE'] : [column, 'NETWORK', 'PREFIX_LENGTH', 'NEXTHOP_IP', 'NEXTHOP_IF']
  return { template, ntcPlatform: platform, headers: [...fsm.header, column], keys, rows }
}

/**
 * Parse CLI output into a table with the bundled ntc-templates.
 *
 * `platform` is a cli-model platform id (`ios`, `iosxe`, `nxos`, `eos`, `junos`, ...); `command` is
 * the command as typed (abbreviations allowed, like ntc's index). Returns null when no bundled
 * template matches, the command has a filtering pipe, the template hits an `Error` action, or it
 * records nothing. Throws ParseTimeoutError when `budgetMs` runs out (checked between lines).
 *
 * `text` should be the command's output only (without the echoed command line and the next
 * prompt): many templates end with a strict `^. -> Error` catch-all.
 *
 * Synchronous and pure. Callers that parse untrusted device output must run it where a runaway
 * regex can be stopped (a worker or a vm context with a timeout): see the desktop app.
 */
export function parseOutput(platform: string, command: string, text: string, opts: ParseOptions = {}): ParseResult | null {
  const e = lookup(platform, command)
  if (!e || e.template.includes(':') || TEMPLATES[e.template] === undefined) return null
  let parsed: ReturnType<typeof parseWithTemplate>
  try {
    if (e.template === 'fortinet_get_router_info_routing-table_all.textfsm' || e.template === 'paloalto_panos_show_routing_route.textfsm') {
      return parseFirewallRoutes(e.template, e.ntcPlatform, text, opts)
    }
    parsed = parseWithTemplate(e.template, text, opts)
  } catch (err) {
    if (err instanceof TextFSMError) return null
    throw err
  }
  if (!parsed.rows.length) return null
  const result: ParseResult = { template: e.template, ntcPlatform: e.ntcPlatform, headers: parsed.headers, rows: parsed.rows.map((r) => r.map(toNtcCell)) }
  if (parsed.keys.length) result.keys = parsed.keys
  return result
}
