/**
 * MobaXterm importer: `.mxtsessions`, `.mobaconf` or the `[Bookmarks*]` sections
 * of `MobaXterm.ini`. There is no official spec; the field layout follows
 * docs/research/competitors-terminals.md appendix C (reverse-engineered notes
 * plus real lines). Decode the file with `decodeText()` first (Windows-1252).
 *
 * Session line: `Name=<prefix>#<icon>#<group1>#<group2>#<start>#<comment>#<color>`.
 * The icon is cosmetic; the type is group-1 field 0.
 */
import { addNote, guessFromName, ResultBuilder, sessionRef, type HopSpec } from './result'
import { checkSize, lookup, splitLines } from './text'
import { SERIAL_DEFAULTS, type ImportedSession, type ImportResult, type SerialSettings } from './types'

const TYPES: Record<string, string> = {
  '0': 'SSH',
  '1': 'Telnet',
  '2': 'Rsh/Rlogin',
  '3': 'XDMCP',
  '4': 'RDP',
  '5': 'VNC',
  '6': 'FTP',
  '7': 'SFTP',
  '8': 'Serial',
  '9': 'File',
  '10': 'Shell',
  '11': 'Browser',
  '12': 'Mosh',
  '13': 'AWS S3',
  '14': 'WSL'
}

export function unescapeMoba(s: string): string {
  return s
    .replace(/__PTVIRG__/g, ';')
    .replace(/__DBLQUO__/g, '"')
    .replace(/__PIPE__/g, '|')
    .replace(/__DIEZE__/g, '#')
    .replace(/__PERCENT__/g, '%')
    .replace(/_CurrentDrive_/g, 'C')
}

const flag = (v: string | undefined) => v === '-1' || v === '1'
const isPort = (n: number) => Number.isInteger(n) && n > 0 && n < 65536
const STANDARD_BAUDS = new Set([110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 128000, 230400, 256000, 460800, 921600])

/** Field 2 of a serial session. Real exports show 1009600 / 1115200: read as 1000000 + baud (hypothesis). */
export function decodeMobaBaud(raw: string | undefined): number | undefined {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return undefined
  if (n > 1_000_000 && STANDARD_BAUDS.has(n - 1_000_000)) return n - 1_000_000
  if (STANDARD_BAUDS.has(n)) return n
  return undefined
}

function parseSession(b: ResultBuilder, name: string, value: string, folderPath: string[], ref: string) {
  const item = sessionRef({ folderPath, name })
  const groups = value.split('#')
  if (groups.length < 3) {
    b.warn(item, 'Skipped: not a MobaXterm session line')
    return
  }
  const f = groups[2]!.split('%').map(unescapeMoba)
  const term = (groups[3] ?? '').split('%')
  const comment = unescapeMoba(groups[5] ?? '').trim()
  const type = f[0] ?? ''
  const s: ImportedSession = {
    name,
    folderPath,
    host: '',
    port: 0,
    protocol: 'ssh',
    username: '',
    notes: comment,
    options: {},
    tags: [],
    source: { format: 'mobaxterm', ref }
  }
  guessFromName(s)
  if (flag(term[11])) s.logToFile = true
  let hops: HopSpec[] | undefined

  if (type === '0' || type === '1') {
    s.protocol = type === '0' ? 'ssh' : 'telnet'
    s.host = (f[1] ?? '').trim()
    if (!s.host) {
      b.warn(item, 'Skipped: no host')
      return
    }
    const port = Number(f[2])
    s.port = isPort(port) ? port : type === '0' ? 22 : 23
  }
  if (type === '0') {
    const user = (f[3] ?? '').trim()
    if (user && user !== '<default>') s.username = user
    if (f[14]) addNote(s, `Private key: ${f[14]}`)
    if (flag(f[34])) s.options.ssh = { agentForward: true }
    const gwHosts = (f[8] ?? '').split('|').map((x) => x.trim())
    if (gwHosts.some(Boolean)) {
      const ports = (f[9] ?? '').split('|')
      const users = (f[10] ?? '').split('|')
      hops = gwHosts.map((host, i) => {
        const port = Number(ports[i])
        const user = (users[i] ?? '').trim()
        const h = { host, port: isPort(port) ? port : 22, user: user || undefined }
        return { ...h, label: `${h.user ? `${h.user}@` : ''}${host}${h.port !== 22 ? `:${h.port}` : ''}` }
      })
      if (hops.some((h) => !h.host)) {
        b.warn(item, 'Gateway list has an empty entry; jump host not set')
        addNote(s, `MobaXterm gateway: ${f[8]}`)
        hops = undefined
      }
    }
    const proxyType = f[19]
    if (proxyType && proxyType !== '0') {
      addNote(s, `MobaXterm proxy (type ${proxyType}): ${f[20] ?? ''}:${f[21] ?? ''}`)
      b.warn(item, 'MobaXterm proxy setting not imported')
    }
  } else if (type === '1') {
    // Fields after host and port are undecoded for Telnet.
  } else if (type === '8') {
    s.protocol = 'serial'
    const port = (f[8] ?? '').trim().split(/\s+/)[0] ?? ''
    if (!port) {
      b.warn(item, 'Skipped: serial session without a port')
      return
    }
    s.host = port
    const serial: SerialSettings = { ...SERIAL_DEFAULTS }
    const baud = decodeMobaBaud(f[2])
    if (baud) serial.baudRate = baud
    else b.warn(item, `Unrecognised serial speed "${f[2] ?? ''}"; using ${serial.baudRate}`)
    s.options.serial = serial
    b.warn(item, 'Serial settings decoded from a partly known format: check speed, data bits, parity, stop bits and flow control')
  } else {
    b.warn(item, `Skipped: MobaXterm ${lookup(TYPES, type) ?? `type ${type}`} sessions are not supported`)
    return
  }
  b.add(s, hops)
}

export function importMobaXterm(text: string): ImportResult {
  checkSize(text, 'MobaXterm file')
  const b = new ResultBuilder()
  // Collect sections first: SubRep normally leads, but nothing guarantees it.
  const sections: { name: string; subRep: string[]; entries: { key: string; value: string; line: number }[] }[] = []
  let cur: (typeof sections)[number] | null = null
  let lineNo = 0
  for (const raw of splitLines(text)) {
    lineNo++
    const line = raw.trimEnd()
    if (!line.trim() || line.trimStart().startsWith(';')) continue
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (sec) {
      cur = /^Bookmarks(_\d+)?$/i.test(sec[1]!) ? { name: sec[1]!, subRep: [], entries: [] } : null
      if (cur) sections.push(cur)
      continue
    }
    if (!cur) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'SubRep') cur.subRep = value.split('\\').map((p) => unescapeMoba(p).trim()).filter(Boolean)
    else if (key !== 'ImgNum') cur.entries.push({ key, value, line: lineNo })
  }
  for (const sec of sections) {
    const folderPath = sec.subRep
    b.folder(folderPath)
    for (const e of sec.entries) {
      const name = unescapeMoba(e.key).trim()
      const hash = e.value.indexOf('#')
      if (hash < 0) {
        b.warn(sessionRef({ folderPath, name }), 'Skipped: not a MobaXterm session line')
        continue
      }
      parseSession(b, name, e.value.slice(hash), folderPath, `[${sec.name}] line ${e.line}`)
    }
  }
  return b.finish()
}
