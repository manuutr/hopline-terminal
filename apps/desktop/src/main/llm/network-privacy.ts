import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { Session } from '@shared/types'
import { attr } from '../agent/untrusted'

type Kind = 'device' | 'label'
const hostField = /^(?:HOST_?NAME|DEVICE_?ID|SYSTEM_?NAME|NEIGHBOR(?:_NAME)?)$/i
const labelField = /^(?:DESCRIPTION|PORT_DESCRIPTION|INTERFACE_DESCRIPTION|ALIAS)$/i
const dnsName = /(?<![\w.-])(?:[\da-z][\da-z-]{0,62}\.)+[a-z][a-z\d-]{1,62}(?![\w-]|\.[\w-])/gi
const neighbor = /^\s*(?:-\s*)?(?:Device ID|(?:Local |Remote )?System Name|SysName)\s*:\s*(.+?)\s*$/i
const declaration = /^\s*(?:set\s+(?:system\s+)?)?(?:host[- ]?name|sysname)[\s:]+["']?([\w.-]+)/i
const prompt = /^\s*(?:(?:[\w.-]+@)|(?:[\w/-]+:))?([\w.-]+)(?:\([\w/-]+\))?[#>]/
const syslogHost = /^(?:<\d+>)?(?:\d{4}\s+)?[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+([\w.-]+)\s+(?:%|[\w-]+\[\d+\]:)/
const description = /^\s*(?:(?:set\s+(?:interfaces\s+\S+\s+(?:unit\s+\d+\s+)?)?)?(?:description|alias))\s*(?::\s*|\s+)(.+?)\s*$/i
const portDescription = /^\s*(?:-\s*)?(?:(?:Local |Remote )?Port Description|ifAlias)\s*:\s*(.+?)\s*$/i
const panInterfaceComment = /^\s*set\s+network\s+interface\s+\S+\s+\S+(?:\s+\S+)*?\s+comment\s+(.+?)\s*$/i
const fieldValue = (value: string) => value.trim().replace(/;$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')
const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One in-memory dictionary per chat or fleet investigation. Only fleet session aliases resolve to targets. */
export class NetworkPrivacy {
  private readonly salt = randomBytes(3).toString('hex')
  private readonly aliases = new Map<string, string>()
  private readonly issued = new Set<string>()
  private readonly frameNames = new Map<string, string>()
  private readonly displayNames = new Map<string, string>()
  private pattern: RegExp | undefined
  private size = 0

  remember(value: string, kind: Kind): string {
    const key = value.trim().toLowerCase()
    const existing = this.aliases.get(key)
    if (existing) return existing
    if (!key || /^[-–]+$/.test(key) || key === '<redacted>' || this.issued.has(key)) return value
    // Never send a partially protected request when a dump exceeds the dictionary budget.
    if (this.aliases.size >= 4096 || this.size + key.length > 128_000) {
      throw new Error('Too many private network labels in this conversation. Start a new chat with a smaller selection.')
    }
    const alias = kind + '-' + (this.aliases.size + 1) + '-' + this.salt
    this.aliases.set(key, alias)
    this.issued.add(alias)
    if (kind === 'device') this.frameNames.set(attr(key), alias)
    this.size += key.length
    this.pattern = undefined
    return alias
  }

  addSession(session: Pick<Session, 'name' | 'host' | 'tags'>): string {
    const alias = this.remember(session.name, 'device')
    this.displayNames.set(alias, session.name)
    if (session.host) this.remember(session.host, 'device')
    if (session.host && !isIP(session.host) && session.host.includes('.')) this.remember(session.host.split('.')[0]!, 'device')
    for (const tag of session.tags ?? []) this.remember(tag, 'label')
    return alias
  }

  /** Show saved session names in local streaming answers, even when a token splits over deltas. */
  displayStream(emit: (s: string) => void) {
    let pending = ''
    const alias = /device-\d+-[a-f0-9]{6}/gi
    const display = (s: string) => s.replace(alias, (token) => this.displayNames.get(token.toLowerCase()) ?? token)
    return {
      write: (delta: string) => {
        const text = pending + delta
        const tail = /(?<![\w-])(?:d|de|dev|devi|devic|device(?:-\d*(?:-[a-f0-9]{0,5})?)?)$/i.exec(text)
        pending = tail?.[0] ?? ''
        const ready = text.slice(0, text.length - pending.length)
        if (ready) emit(display(ready))
      },
      flush: () => { if (pending) emit(display(pending)) }
    }
  }

  /** Network placeholders may be discussed, but must never be written to a device. */
  hasPlaceholder(line: string): boolean {
    return (line.match(/(?:device|label)-\d+-[a-f0-9]{6}\b/gi) ?? []).some((token) => this.issued.has(token.toLowerCase()))
  }

  discoverField(name: string, value: string): void {
    if (hostField.test(name)) this.remember(value, 'device')
    if (labelField.test(name)) this.remember(value, 'label')
  }

  /** Learn fields before masking, including a name repeated earlier in a question or output. */
  discover(text: string): void {
    for (const m of text.matchAll(dnsName)) {
      // Dotted MAC addresses and validation paths are evidence rather than DNS names.
      if (/^(?:[a-f\d]{4}\.){2}[a-f\d]{4}$/i.test(m[0]) || /^verify\.\d+\.(?:expect|command)$/.test(m[0])) continue
      this.remember(m[0], 'device')
    }
    let columns: string[] = []
    let fixed: { start: number; end?: number; states: boolean } | undefined
    let neighborLocalColumn: number | undefined
    for (const line of text.split(/\r?\n/)) {
      for (const field of line.matchAll(/<(description|port-description|host-name|hostname|system-name)>([^<>]+)<\/\1>/gi)) {
        this.discoverField(field[1]!.replace(/-/g, '_'), field[2]!)
      }
      const anglePrompt = /^\s*<([\w.-]+)>\s*(?:(?:display|show)\b|$)/i.exec(line)
      if (anglePrompt) this.remember(anglePrompt[1]!, 'device')
      if (!line.trim() || /^\s*[<[]/.test(line)) {
        columns = []
        fixed = undefined
        neighborLocalColumn = undefined
        continue
      }
      const cells = line.split('\t')
      if (cells.length > 1) {
        if (cells.some((c) => hostField.test(c) || labelField.test(c))) columns = cells
        else if (cells.length === columns.length) {
          for (const [i, col] of columns.entries()) {
            this.discoverField(col, cells[i]!)
          }
        }
        continue
      }
      // IOS CDP/LLDP summaries put a remote device ID in the first column. Long
      // identities can occupy a row of their own before an indented interface.
      const neighborHeader = /^\s*Device[ -]ID\s+(?=Local\s+(?:Intrfce|Intf|Interface)\b)/i.exec(line)
      if (neighborHeader) {
        neighborLocalColumn = neighborHeader[0].length
        fixed = undefined
        continue
      }
      if (neighborLocalColumn !== undefined) {
        if (/^\s*[-=]+\s*$/.test(line) || line.search(/\S/) >= neighborLocalColumn) continue
        const cell = /^\s*([\w.-]+)(?:\s{2,}|$)/.exec(line)
        if (cell && !prompt.test(line)) {
          this.remember(cell[1]!, 'device')
          continue
        }
        neighborLocalColumn = undefined
      }
      const detail = portDescription.exec(line)
      if (detail) {
        this.remember(fieldValue(detail[1]!), 'label')
        fixed = undefined
        continue
      }
      if (/^\s*(?:Port|Interface|Interface-name)\s+/i.test(line)) {
        const col = /\b(?:Description|Name)\b/i.exec(line)
        if (col) {
          const next = /\S/.exec(line.slice(col.index + col[0].length))
          fixed = { start: col.index, states: /(?:Protocol|Proto|Link)\s+Description/i.test(line), end: next ? next.index + col.index + col[0].length : undefined }
          continue
        }
      }
      if (fixed && /^\s*[-=\s]+$/.test(line)) continue
      if (fixed && /^\s*[\w./:-]*\d[\w./:-]*\s/.test(line)) {
        const row = fixed.states && /^\s*\S+\s+(?:admin(?:istratively)?\s+down|\S+)\s+\S+\s+(.+)$/.exec(line)
        this.remember(row ? row[1]! : line.slice(fixed.start, fixed.end), 'label')
        continue
      }
      fixed = undefined
      const host = neighbor.exec(line) ?? declaration.exec(line) ?? prompt.exec(line) ?? syslogHost.exec(line)
      if (host) {
        const value = fieldValue(host[1]!)
        this.remember(value, 'device')
        if (value.includes('.') && !isIP(value)) this.remember(value.split('.')[0]!, 'device')
      }
      const label = (description.exec(line) ?? panInterfaceComment.exec(line))?.[1]
      if (label) this.remember(fieldValue(label), 'label')
    }
  }

  mask(text: string): string {
    if (!this.aliases.size) return text
    // Preserve tool framing, including random frame IDs. Session names in attributes are escaped
    // and capped by the frame builder, so match their actual on-wire spelling separately.
    return text.split(/(<\/?(?:device_output|terminal_output|device_report|task) id="[a-f\d]{12}"(?: (?:device|command|parsed|lane_status|untrusted)="[^"<>\n]*")*>)/g).map((chunk, i) =>
      i % 2 ? chunk.replace(/( (?:device|command)=")([^"]*)"/g, (_m, prefix: string, value: string) => {
        if (prefix === ' device="') {
          const alias = this.frameNames.get(value.toLowerCase().trim())
          if (alias) return prefix + alias + '"'
        }
        const plain = value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        const masked = this.replace(plain)
        return prefix + (plain === masked ? value : attr(masked, 200)) + '"'
      }) : this.replace(chunk)
    ).join('')
  }

  private replace(text: string): string {
    this.pattern ??= new RegExp('(?<![\\p{L}\\p{N}_-])(?:' +
      [...this.aliases.keys()].sort((a, b) => b.length - a.length).map(esc).join('|') +
      ')(?![\\p{L}\\p{N}_-])', 'giu')
    return text.replace(this.pattern, (value) => this.aliases.get(value.toLowerCase()) ?? value)
  }

  protect(text: string): string {
    this.discover(text)
    return this.mask(text)
  }
}
