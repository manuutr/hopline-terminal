/**
 * CSV importer with header auto-detection. Accepts SecureCRT Text Import Wizard
 * columns, NetBox/Nautobot device exports and hand-made sheets. Delimiter is
 * `,`, `;` or tab (detected from the header line). RFC 4180 quoting, including
 * `""` escapes and newlines inside quotes (CRLF/CR there become `\n`).
 */
import { guessPlatform, platformFromSlug } from './platform'
import { guessFromName, ResultBuilder } from './result'
import { checkSize, lookup, stripBom } from './text'
import { DEFAULT_PORTS, SERIAL_DEFAULTS, type ImportedSession, type ImportResult, type Protocol } from './types'

export type CsvField = 'name' | 'host' | 'port' | 'protocol' | 'username' | 'folder' | 'platform' | 'tags' | 'notes' | 'baud' | 'password'

/** Column per field, by header name (case-insensitive) or 0-based index. */
export type CsvMapping = Partial<Record<CsvField, string | number>>

export interface CsvOptions {
  delimiter?: ',' | ';' | '\t'
  /** Whether row 1 is a header. Default: true, unless the mapping uses only column indexes. */
  hasHeader?: boolean
}

/**
 * Header aliases, matched in this field order and, within a field, alias order.
 * Host goes first and prefers address columns, so a sheet with both "Hostname"
 * and "IP" connects to the IP and names the session after the hostname, while a
 * SecureCRT-style sheet with only "Hostname" connects to it.
 */
const ALIASES: Record<CsvField, string[]> = {
  host: ['ip', 'ipaddress', 'mgmtip', 'managementip', 'primaryip', 'primaryipv4', 'primaryip4', 'ipv4', 'ipv6', 'address', 'host', 'hostname', 'fqdn', 'target'],
  name: ['name', 'session', 'sessionname', 'label', 'displayname', 'device', 'devicename', 'title', 'hostname'],
  port: ['port', 'tcpport'],
  protocol: ['protocol', 'proto', 'connectiontype'],
  username: ['username', 'user', 'login', 'loginname'],
  folder: ['folder', 'path', 'group', 'folderpath', 'site', 'location'],
  platform: ['platform', 'os', 'platformslug', 'networkdriver'],
  tags: ['tags', 'tag', 'labels'],
  notes: ['notes', 'note', 'description', 'comments', 'comment'],
  baud: ['baud', 'baudrate', 'speed'],
  password: ['password', 'pass', 'secret']
}

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * A column that holds secrets, by its (normalized) title: the password aliases,
 * or any title naming a password, passphrase or secret ("Enable Secret",
 * "SSH Password"). Such a column never feeds a session field.
 */
const isSecretHeader = (h: string) => ALIASES.password.includes(h) || h === 'pwd' || h === 'passwd' || /password|passphrase|secret/.test(h)

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const count = (d: string) => {
    let n = 0
    let q = false
    for (const c of first) {
      if (c === '"') q = !q
      else if (!q && c === d) n++
    }
    return n
  }
  const c = { ',': count(','), ';': count(';'), '\t': count('\t') }
  return c['\t'] > c[','] && c['\t'] > c[';'] ? '\t' : c[';'] > c[','] ? ';' : ','
}

/** RFC 4180 records. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  let i = 0
  const s = stripBom(text)
  while (i < s.length) {
    const c = s[i]!
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else q = false
      } else if (c === '\r') {
        // A line break inside quotes is kept, as \n: files saved on Windows use CRLF there too.
        if (s[i + 1] === '\n') i++
        field += '\n'
      } else field += c
    } else if (c === '"' && field.trim() === '') {
      field = ''
      q = true
    } else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const PROTOCOLS: Record<string, Protocol> = { ssh: 'ssh', ssh2: 'ssh', telnet: 'telnet', raw: 'raw', tcp: 'raw', serial: 'serial' }

/**
 * `headerless` is set when row 1 was read as data. Password columns can then
 * only be recognised by their title, which a headerless file lacks, so the app
 * should warn that a mapped column might hold secrets.
 */
export interface CsvImportResult extends ImportResult {
  headerless?: true
}

export function importCsv(text: string, mapping?: CsvMapping, options: CsvOptions = {}): CsvImportResult {
  checkSize(text, 'CSV file')
  const b = new ResultBuilder()
  const delimiter = options.delimiter ?? detectDelimiter(stripBom(text))
  const rows = parseCsv(text, delimiter)
  const indexOnly = mapping && Object.values(mapping).every((v) => typeof v === 'number')
  const hasHeader = options.hasHeader ?? !indexOnly
  const finish = (): CsvImportResult => (hasHeader ? b.finish() : { ...b.finish(), headerless: true })
  if (!rows.length) return finish()

  const header = rows[0]!.map(normHeader)
  // Columns that hold secrets. Only titles can tell; in a headerless file row 1 is data.
  const secret = new Set(hasHeader ? header.flatMap((h, i) => (isSecretHeader(h) ? [i] : [])) : [])
  const col: Partial<Record<CsvField, number>> = {}
  if (hasHeader) {
    for (const [field, names] of Object.entries(ALIASES) as [CsvField, string[]][]) {
      // Earlier aliases win: "name" beats "device" when a sheet has both.
      for (const n of names) {
        const at = header.indexOf(n)
        if (at >= 0 && !Object.values(col).includes(at) && (field === 'password' || !secret.has(at))) {
          col[field] = at
          break
        }
      }
    }
  }
  for (const [field, v] of Object.entries(mapping ?? {}) as [CsvField, string | number][]) {
    if (!Object.hasOwn(ALIASES, field)) {
      b.warn(`column "${v}"`, `Unknown field "${field}" in the column mapping; ignored`)
      continue
    }
    const at = typeof v === 'number' ? v : header.indexOf(normHeader(v))
    if (at < 0) b.warn(`column "${v}"`, `Mapped column for ${field} not found in the header`)
    else if (field !== 'password' && secret.has(at)) {
      b.warn(`column "${rows[0]![at] ?? v}"`, `Not mapped to ${field}: the column holds passwords or secrets, which are never imported`)
    } else col[field] = at
  }
  if (col.host === undefined) {
    b.warn('header', 'No host/IP column found; map one explicitly')
    // Every data row is still accounted for.
    for (let r = hasHeader ? 1 : 0; r < rows.length; r++) b.warn(`row ${r + 1}`, 'Skipped: no host column')
    return finish()
  }

  for (let r = hasHeader ? 1 : 0; r < rows.length; r++) {
    const row = rows[r]!
    // Belt and braces: a secret column never feeds a field, however it got mapped.
    const get = (f: CsvField) => (col[f] === undefined || (f !== 'password' && secret.has(col[f]!)) ? '' : (row[col[f]!] ?? '').trim())
    const protoRaw = get('protocol').toLowerCase()
    const protocol = protoRaw ? lookup(PROTOCOLS, protoRaw) : 'ssh'
    // Strip a NetBox-style prefix length ("10.0.0.1/24"), but never from a serial device path.
    const host = protocol === 'serial' ? get('host') : get('host').replace(/\/\d{1,3}$/, '')
    const name = get('name') || host
    const item = name || `row ${r + 1}`
    if (!host) {
      b.warn(item, `Skipped: row ${r + 1} has no host`)
      continue
    }
    if (get('password') || [...secret].some((i) => (row[i] ?? '').trim())) b.warn(item, 'Password column not imported; you will be asked for it on connect')
    if (!protocol) {
      b.warn(item, `Skipped: protocol "${protoRaw}" is not supported`)
      continue
    }
    const portRaw = get('port')
    let port = protocol === 'serial' ? 0 : Number(portRaw || DEFAULT_PORTS[protocol])
    if (!(Number.isInteger(port) && port >= 0 && port < 65536)) {
      b.warn(item, `Invalid port "${portRaw}"; using ${DEFAULT_PORTS[protocol]}`)
      port = DEFAULT_PORTS[protocol]
    }
    const s: ImportedSession = {
      name,
      folderPath: get('folder').split(/[\\/]+/).map((p) => p.trim()).filter(Boolean),
      host,
      port,
      protocol,
      username: get('username'),
      notes: get('notes'),
      options: {},
      tags: [...new Set(get('tags').split(/[,;|]/).map((t) => t.trim()).filter(Boolean))],
      source: { format: 'csv', ref: `row ${r + 1}` }
    }
    if (protocol === 'serial') {
      const baud = Number(get('baud'))
      s.options.serial = { ...SERIAL_DEFAULTS, ...(baud > 0 ? { baudRate: baud } : {}) }
    }
    const platRaw = get('platform')
    const pm = platformFromSlug(platRaw)
    // A platform column ("cisco-ios-xe", "Cisco IOS-XE") is the source speaking; the name is only a guess.
    const platform = pm.platform ?? (pm.unsupported ? undefined : guessPlatform(platRaw))
    if (platform) s.platform = platform
    else if (platRaw) b.warn(item, `Platform "${platRaw}" ${pm.unsupported ? 'is not supported yet' : 'not recognised'}; choose one after import`)
    else guessFromName(s)
    b.add(s)
  }
  return finish()
}
