/**
 * Network-aware output highlighting for the terminal.
 *
 * Display only: it runs between the device stream and xterm, so session logs, the AI executor
 * and copy/paste all see the raw bytes. Colors are ANSI palette indexes, so they follow the
 * terminal theme (dark and light). Output that already carries its own colors, and full-screen
 * apps (alternate screen), pass through untouched.
 */

const ESC = '\x1b'
const FG = (n: number) => `${ESC}[${n}m`
const OFF = `${ESC}[39m`
const BOLD = `${ESC}[1m`
const NORMAL = `${ESC}[22m`

const C = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 } as const

const paint = (s: string, color: number, bold = false) => (bold ? `${BOLD}${FG(color)}${s}${OFF}${NORMAL}` : `${FG(color)}${s}${OFF}`)
// ANSI faint halves glyph opacity after contrast correction. A muted palette color stays legible.
const dim = (s: string) => paint(s, 90)

// ---------------------------------------------------------------- token rules

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const CISCO_LONG =
  'GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|FourHundredGigE|TenGigE|FastEthernet|Ethernet|Port-channel|Bundle-Ether|Loopback|Vlan|Tunnel|Management|Serial|BDI|nve|Null|mgmt'
const CISCO_SHORT = 'Gi|Te|Tw|Fo|Hu|Fa|Eth|Et|Po|Lo|Vl|Tu|Ma|Se|BE'

/** Named groups; earlier alternatives win. */
const TOKEN = new RegExp(
  [
    // Error counters that are not zero: "5 input errors", "12 CRC", "Total output drops: 3".
    `(?<counter>\\b[1-9]\\d*(?= (?:input errors|output errors|CRC|frame|overrun|ignored|collisions|interface resets|runts|giants|throttles|output drops|input drops|late collision|deferred|lost carrier|no carrier|babbles|unknown protocol drops)\\b))`,
    `(?<mac>\\b[0-9a-fA-F]{4}\\.[0-9a-fA-F]{4}\\.[0-9a-fA-F]{4}\\b|\\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\\b)`,
    `(?<ipv4>(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?:\\/(?:3[0-2]|[12]?\\d))?(?![\\w.]))`,
    // IPv6: needs "::" or all 8 groups, so clock times like 00:01:02 never match.
    `(?<ipv6>(?<![\\w:.])(?=[0-9a-fA-F:]*::|(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4})[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?:\\/\\d{1,3})?(?![\\w:]))`,
    `(?<iface>(?<![\\w-])(?:(?:${CISCO_LONG}) ?\\d+(?:[/.:]\\d+)*|(?:${CISCO_SHORT})\\d+(?:[/.:]\\d+)*|(?:ge|xe|et|fe|so|gr|lt)-\\d+\\/\\d+\\/\\d+(?:[.:]\\d+)?|(?:ae|lo|em|fxp|me)\\d+(?:\\.\\d+)?|irb\\.\\d+)(?![\\w/]))`,
    `(?<admin>\\badministratively down\\b)`,
    `(?<stamp>\\b(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,6})?\\b)`,
    `(?<vlan>\\b[Vv][Ll][Aa][Nn] +\\d{1,4}\\b)`,
    `(?<bad>(?<![/\\w-])(?:down|Down|DOWN|notconnect|notconnected|disabled|err-disabled|errdisabled|Idle|failed|Failed|FAILED|BLK|blocking|shutdown|inactive|suspended|notpresent|sfpAbsent|unreachable|Unreachable)(?![/\\w-]))`,
    `(?<warn>(?<![/\\w-])(?:Active|Connect|OpenSent|OpenConfirm|INIT|EXSTART|EXCHANGE|LOADING|2WAY|LRN|LIS|LRN|monitoring|testing|dormant|flapping|Flapping)(?![/\\w-]))`,
    `(?<good>(?<![/\\w-])(?:up|Up|UP|connected|Established|ESTAB|FULL|FWD|forwarding|reachable|Reachable)(?![/\\w-]))`,
    `(?<quiet>\\b(?:unassigned|never)\\b)`
  ].join('|'),
  'g'
)

export interface NetworkTarget { text: string; start: number; kind: 'address' | 'interface' }

export function networkTargets(line: string): NetworkTarget[] {
  return Array.from(line.matchAll(TOKEN)).flatMap((m) => {
    const g = m.groups
    if (!g?.iface && !g?.ipv4 && !g?.ipv6) return []
    return [{ text: m[0], start: m.index, kind: g.iface ? 'interface' : 'address' }]
  })
}

const DROPS = /(\b(?:Total output drops|[Ii]nput drops|[Oo]utput drops|[Dd]rops): )([1-9]\d*)/g

function tokens(text: string): string {
  // "Total output drops: 3" style counters (rare; a separate pass keeps the main regex cheap).
  if (text.includes('drops: ')) {
    const parts = text.split(DROPS)
    if (parts.length > 1) {
      let out = ''
      for (let i = 0; i < parts.length; i += 3) out += tokenize(parts[i]!) + (i + 1 < parts.length ? parts[i + 1]! + paint(parts[i + 2]!, C.red, true) : '')
      return out
    }
  }
  return tokenize(text)
}

function tokenize(text: string): string {
  return text.replace(TOKEN, (m, ...args) => {
    const g = args.at(-1) as Record<string, string | undefined>
    if (g.counter) return paint(m, C.red, true)
    if (g.mac) return paint(m, C.magenta)
    if (g.ipv4 || g.ipv6) return paint(m, C.cyan)
    if (g.stamp) return dim(m)
    if (g.admin) return dim(m.slice(0, -4)) + paint(m.slice(-4), C.red)
    if (g.vlan) return paint(m, C.magenta)
    if (g.iface) return paint(m, C.blue)
    if (g.bad) return paint(m, C.red)
    if (g.warn) return paint(m, C.yellow)
    if (g.good) return paint(m, C.green)
    if (g.quiet) return dim(m)
    return m
  })
}

// ---------------------------------------------------------------- line rules

const PROMPT = /^([A-Za-z0-9_.@-]{1,63}(?:\([\w./:-]{1,40}\))?[#>])(?![#>=])/
const DEVICE_ERROR = /^\s*% ?(?:Invalid|Incomplete|Ambiguous|Unknown|Unrecognized|Bad|Error|Ivalid|Cannot|Not|No such|Unable|Command rejected|Authorization failed|Permission denied)/
const SYSLOG = /%[A-Z0-9_]+(?:-[A-Z0-9_]+)?-([0-7])-[A-Z0-9_]+/
const SECTION = /^(interface|router|line|vlan|vrf definition|vrf context|ip vrf|route-map|ip access-list|ipv6 access-list|ip prefix-list|policy-map|class-map|key chain|crypto|tacacs server|radius server|aaa|ntp|snmp-server|logging|hostname|username|spanning-tree|management api|daemon|banner)\b/

/** Highlight one line (no newline inside). `bol` is false when it continues a line already on screen. */
export function highlightLine(line: string, bol: boolean): string {
  if (!line) return line
  if (bol) {
    if (DEVICE_ERROR.test(line)) return paint(line, C.red)
    const prompt = PROMPT.exec(line)
    // Prompt, then whatever was typed after it, left as typed.
    if (prompt) return BOLD + prompt[1]! + NORMAL + line.slice(prompt[1]!.length)
    if (/^\s*!/.test(line)) return dim(line)
    const desc = /^(\s*description )(.*)$/.exec(line)
    if (desc) return desc[1] + dim(desc[2]!)
    const no = /^(\s*)(no)( .*)$/.exec(line)
    if (no) return no[1] + paint(no[2]!, C.red) + tokens(no[3]!)
    const sec = SECTION.exec(line)
    if (sec) return BOLD + sec[1] + NORMAL + tokens(line.slice(sec[1]!.length))
  }
  const sys = SYSLOG.exec(line)
  if (sys) {
    const sev = Number(sys[1])
    const color = sev <= 3 ? C.red : sev === 4 ? C.yellow : C.cyan
    const at = sys.index
    return tokens(line.slice(0, at)) + paint(sys[0], color, sev <= 3) + tokens(line.slice(at + sys[0].length))
  }
  return tokens(line)
}

// ---------------------------------------------------------------- stream

// CSI, OSC and other escape sequences, kept intact.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g
// eslint-disable-next-line no-control-regex
const ALT_ON = /\x1b\[\?(?:1049|1047|47)h/
// eslint-disable-next-line no-control-regex
const ALT_OFF = /\x1b\[\?(?:1049|1047|47)l/

/** Hold a trailing partial line of bulk output this long, so a token split across chunks still colors. */
const HOLD_MS = 12
const BULK = 128
/**
 * Above this input rate the stream is a flood (e.g. `cat` of a huge file), not something a person
 * reads live: highlighting steps aside so xterm runs at full speed, and resumes when it calms down.
 * Interactive output stays far below it; a fast `show tech` (several MB/s on a LAN) scrolls by
 * unhighlighted, which nobody can read at that speed anyway.
 */
const FLOOD_BYTES = 512 * 1024
const FLOOD_WINDOW_MS = 250

export class StreamHighlighter {
  private atLineStart = true
  private deviceColor = false
  private altScreen = false
  private held = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private windowStart = 0
  private windowBytes = 0

  constructor(
    private readonly write: (s: string) => void,
    private readonly enabled: () => boolean,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** True while the input rate is above the flood threshold. */
  get flooding(): boolean {
    return this.windowBytes > FLOOD_BYTES
  }

  private meter(n: number): void {
    const t = this.now()
    if (t - this.windowStart > FLOOD_WINDOW_MS) {
      this.windowStart = t
      this.windowBytes = 0
    }
    this.windowBytes += n
  }

  push(data: string): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    data = this.held + data
    this.held = ''
    if (!data) return
    this.meter(data.length)

    if (!this.enabled() || this.flooding || this.passthrough(data)) {
      this.write(data)
      this.track(data)
      return
    }

    // Bulk output that stops mid-line: keep the tail briefly (interactive echo is never held).
    const lastNl = Math.max(data.lastIndexOf('\n'), data.lastIndexOf('\r'))
    if (data.length >= BULK && lastNl >= 0 && lastNl < data.length - 1 && !data.includes(ESC, lastNl)) {
      this.held = data.slice(lastNl + 1)
      data = data.slice(0, lastNl + 1)
      this.timer = setTimeout(() => {
        this.timer = null
        const rest = this.held
        this.held = ''
        if (rest) this.emit(rest)
      }, HOLD_MS)
    }
    this.emit(data)
  }

  /** Flush anything held (e.g. before the terminal is disposed). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.held) this.emit(this.held)
    this.held = ''
  }

  private emit(data: string): void {
    this.write(this.render(data))
    this.track(data)
  }

  private passthrough(data: string): boolean {
    if (this.altScreen || this.deviceColor || ALT_ON.test(data)) return true
    // The device colors its own output (Linux shells, some NOS): leave it alone.
    for (const m of data.matchAll(SGR)) if (m[1] && !/^0*$/.test(m[1])) return true
    return false
  }

  /** Follow alternate-screen and device color state across chunks. */
  private track(data: string): void {
    if (ALT_ON.test(data)) this.altScreen = true
    if (ALT_OFF.test(data)) this.altScreen = false
    let last: string | undefined
    for (const m of data.matchAll(SGR)) last = m[1]
    if (last !== undefined) this.deviceColor = !!last && !/^0*$/.test(last)
    const tail = data.replace(ESCAPES, '')
    if (tail) this.atLineStart = /[\r\n]$/.test(tail)
  }

  private render(data: string): string {
    let out = ''
    let bol = this.atLineStart
    let last = 0
    const handleText = (text: string) => {
      for (const part of text.split(/(\r\n|\n|\r)/)) {
        if (part === '\r\n' || part === '\n' || part === '\r') {
          out += part
          bol = true
        } else if (part) {
          out += highlightLine(part, bol)
          bol = false
        }
      }
    }
    for (const m of data.matchAll(ESCAPES)) {
      handleText(data.slice(last, m.index))
      out += m[0]
      last = m.index + m[0].length
    }
    handleText(data.slice(last))
    return out
  }
}
