/**
 * SecureCRT importer: the `Config/Sessions/` folder of `.ini` files and the
 * Tools > Export Settings XML. See docs/research/competitors-terminals.md,
 * appendices A and B, for the format notes this follows.
 */
import { addNote, guessFromName, ResultBuilder, sessionRef, type HopSpec } from './result'
import { checkSize, lookup, splitLines, stripBom } from './text'
import { SERIAL_DEFAULTS, type ImportedSession, type ImportResult, type Protocol, type SerialSettings } from './types'
import { parseXml, type XmlElement } from './xml'

type CrtValue = { t: 'S'; v: string } | { t: 'D'; v: number } | { t: 'Z'; v: string[] } | { t: 'B' }
type CrtOptions = Map<string, CrtValue>

const LINE = /^([SDBZ]):"([^"]*)"=(.*)$/

/** Parse one session `.ini`. `D` values are 8 hex digits; `B`/`Z` carry continuation lines indented by one space. */
export function parseCrtIni(text: string): CrtOptions {
  const out: CrtOptions = new Map()
  let pendingZ: string[] | null = null
  for (const raw of splitLines(text)) {
    if (raw.startsWith(' ')) {
      pendingZ?.push(raw.slice(1))
      continue
    }
    pendingZ = null
    const m = LINE.exec(raw)
    if (!m) continue
    const [, t, name, value] = m as unknown as [string, 'S' | 'D' | 'B' | 'Z', string, string]
    if (t === 'S') out.set(name, { t, v: value })
    else if (t === 'D') out.set(name, { t, v: parseInt(value, 16) })
    else if (t === 'Z') {
      pendingZ = []
      out.set(name, { t, v: pendingZ })
    } else out.set(name, { t })
  }
  return out
}

const str = (o: CrtOptions, k: string) => {
  const v = o.get(k)
  return v?.t === 'S' ? v.v : undefined
}
const num = (o: CrtOptions, k: string) => {
  const v = o.get(k)
  return v?.t === 'D' && Number.isFinite(v.v) ? v.v : undefined
}
const list = (o: CrtOptions, k: string) => {
  const v = o.get(k)
  return v?.t === 'Z' ? v.v : v?.t === 'S' && v.v ? [v.v] : undefined
}

/** Serial keys carry the OS that wrote them ("Linux Baud Rate"). Match whole keys, never suffixes ("Printer Baud Rate"). */
const OS_PREFIXES = ['', 'Linux ', 'Mac ']
const serialStr = (o: CrtOptions, k: string) => OS_PREFIXES.map((p) => str(o, p + k)).find((v) => v !== undefined && v !== '')
const serialNum = (o: CrtOptions, k: string) => OS_PREFIXES.map((p) => num(o, p + k)).find((v) => v !== undefined)

const PROTOCOLS: Record<string, Protocol> = { ssh2: 'ssh', telnet: 'telnet', raw: 'raw', serial: 'serial' }
const PARITY: SerialSettings['parity'][] = ['none', 'odd', 'even', 'mark', 'space']
const STOP: SerialSettings['stopBits'][] = [1, 1.5, 2]
const PASSWORD_KEYS = ['Password V2', 'Password', 'Session Password V2', 'Session Password']

function toSession(b: ResultBuilder, o: CrtOptions, name: string, folderPath: string[], ref: string, format: 'securecrt' | 'securecrt-xml') {
  const item = [...folderPath, name].join('/')
  const protoName = str(o, 'Protocol Name') ?? 'SSH2'
  const protocol = lookup(PROTOCOLS, protoName.toLowerCase())
  if (!protocol) {
    b.warn(item, `Skipped: SecureCRT protocol "${protoName}" is not supported`)
    return
  }
  const s: ImportedSession = {
    name,
    folderPath,
    host: '',
    port: 0,
    protocol,
    username: str(o, 'Username') ?? '',
    notes: (list(o, 'Description') ?? []).join('\n').trim(),
    options: {},
    tags: [],
    source: { format, ref }
  }
  guessFromName(s)
  if (num(o, 'Start Log Upon Connect') === 1) s.logToFile = true

  if (protocol === 'serial') {
    const port = serialStr(o, 'Com Port')
    if (!port) {
      b.warn(item, 'Skipped: serial session without a COM port')
      return
    }
    s.host = port
    const serial: SerialSettings = { ...SERIAL_DEFAULTS }
    const baud = serialNum(o, 'Baud Rate')
    if (baud) serial.baudRate = baud
    const bits = serialNum(o, 'Data Bits')
    if (bits && bits >= 5 && bits <= 8) serial.dataBits = bits as SerialSettings['dataBits']
    const parity = PARITY[serialNum(o, 'Parity') ?? 0]
    if (parity) serial.parity = parity
    const stop = STOP[serialNum(o, 'Stop Bits') ?? 0]
    if (stop) serial.stopBits = stop
    if (serialNum(o, 'CTS Flow') === 1) serial.flow = 'rtscts'
    else if (serialNum(o, 'XON Flow') === 1) serial.flow = 'xonxoff'
    else if (serialNum(o, 'DSR Flow') === 1) b.warn(item, 'DSR/DTR flow control is not supported; set to none')
    const brk = num(o, 'Serial Break Length')
    if (brk) serial.breakMs = brk
    s.options.serial = serial
  } else {
    s.host = (str(o, 'Hostname') ?? '').trim()
    if (!s.host) {
      b.warn(item, 'Skipped: no hostname')
      return
    }
    const port = protocol === 'ssh' ? num(o, '[SSH2] Port') : num(o, 'Port')
    s.port = port && port > 0 && port < 65536 ? port : protocol === 'ssh' ? 22 : 23
  }

  if (protocol === 'ssh') {
    const ssh: NonNullable<ImportedSession['options']['ssh']> = {}
    // 1 = on. A real file had 2 (meaning unknown, possibly "use global"): leave it unset.
    if (num(o, 'Enable Agent Forwarding') === 1) ssh.agentForward = true
    if (Object.keys(ssh).length) s.options.ssh = ssh
    const key = str(o, 'Identity Filename V2') || str(o, 'Identity Filename')
    if (key) addNote(s, `Identity file: ${key.replace(/::rawkey$/, '')}`)
  }
  const cred = str(o, 'Credential Title')
  if (cred) addNote(s, `SecureCRT credential: ${cred}`)

  if (PASSWORD_KEYS.some((k) => str(o, k)) || num(o, 'Session Password Saved') === 1) {
    b.warn(item, 'Saved password not imported; you will be asked for it on connect')
  } else if (cred) {
    b.warn(item, `Uses SecureCRT credential "${cred}": its password is not imported; you will be asked for it on connect`)
  }

  let hops: HopSpec[] | undefined
  const fw = str(o, 'Firewall Name')
  if (fw && fw !== 'None') {
    if (/^session:/i.test(fw)) {
      const path = fw.slice(fw.indexOf(':') + 1)
      hops = [{ ref: path, label: path }]
    } else {
      addNote(s, `SecureCRT firewall: ${fw}`)
      b.warn(item, `SecureCRT firewall/proxy "${fw}" not imported; only "Session:" jump hosts are`)
    }
  }
  b.add(s, hops)
}

// ------------------------------------------------------------------ .ini folder

/** Path segments. Empty, "." and ".." segments are dropped: folder names, never navigation. */
function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(isFolderName)
}

const isFolderName = (p: string) => p.trim() !== '' && p !== '.' && p !== '..'

/** Deeper folders are folded into the last one ("a › b › c"), so a hostile tree can't nest without bound. */
export const MAX_FOLDER_DEPTH = 32

/** Caps folder paths at MAX_FOLDER_DEPTH, warning once per folded folder. */
function folderCapper(b: ResultBuilder) {
  const warned = new Set<string>()
  return (path: string[]): string[] => {
    if (path.length <= MAX_FOLDER_DEPTH) return path
    const out = [...path.slice(0, MAX_FOLDER_DEPTH - 1), path.slice(MAX_FOLDER_DEPTH - 1).join(' › ')]
    const key = out.join('\u0000')
    if (!warned.has(key)) {
      warned.add(key)
      b.warn(out.join('/'), `Folder nested ${path.length} levels deep; levels below ${MAX_FOLDER_DEPTH} were merged into one folder`)
    }
    return out
  }
}

/** Folder segments below `Sessions/`. Paths without a `Sessions` segment are taken as relative to it. */
function sessionsRelative(segments: string[]): string[] | null {
  const idx = segments.findIndex((p, i) => p.toLowerCase() === 'sessions' && (i === 0 || segments[i - 1]!.toLowerCase() === 'config'))
  const any = segments.findIndex((p) => p.toLowerCase() === 'sessions')
  const at = idx >= 0 ? idx : any
  return at >= 0 ? segments.slice(at + 1) : null
}

// ------------------------------------------------------------------ XML export

function xmlOptions(key: XmlElement, out: CrtOptions = new Map()): CrtOptions {
  for (const c of key.children) {
    const name = c.attrs.name
    if (c.name === 'key') {
      // Defensive: flatten nested option groups that are not sessions or folders.
      if (!isXmlSession(c) && !c.children.some((g) => g.name === 'key')) xmlOptions(c, out)
      continue
    }
    if (name === undefined) continue
    if (c.name === 'string') out.set(name, { t: 'S', v: c.text })
    else if (c.name === 'dword') out.set(name, { t: 'D', v: parseInt(c.text.trim(), 10) })
    else if (c.name === 'array') out.set(name, { t: 'Z', v: c.children.filter((x) => x.name === 'string').map((x) => x.text) })
    else if (c.name === 'binary') out.set(name, { t: 'B' })
  }
  return out
}

function directDword(key: XmlElement, name: string) {
  const el = key.children.find((c) => c.name === 'dword' && c.attrs.name === name)
  return el ? parseInt(el.text.trim(), 10) : undefined
}

function isXmlSession(key: XmlElement): boolean {
  const flag = directDword(key, 'Is Session')
  if (flag !== undefined) return flag === 1
  const hasKeys = key.children.some((c) => c.name === 'key' && c.children.some((g) => g.name === 'key' || g.attrs.name === 'Hostname'))
  return !hasKeys && key.children.some((c) => c.name === 'string' && (c.attrs.name === 'Hostname' || c.attrs.name === 'Protocol Name'))
}

function importXml(b: ResultBuilder, text: string, file: string, cap: (path: string[]) => string[]) {
  let doc: XmlElement
  try {
    doc = parseXml(stripBom(text))
  } catch (e) {
    b.warn(file, `Not a readable SecureCRT XML export: ${(e as Error).message}`)
    return
  }
  const sessions = doc.children.find((c) => c.name === 'key' && c.attrs.name === 'Sessions')
  if (!sessions) {
    b.warn(file, 'No <key name="Sessions"> in this XML export')
    return
  }
  const walk = (node: XmlElement, path: string[]) => {
    for (const k of node.children) {
      if (k.name !== 'key' || k.attrs.name === undefined) continue
      const name = k.attrs.name
      if (path.length === 0 && name === 'Default') {
        b.warn('Default', 'Skipped: SecureCRT default-session template')
        continue
      }
      if (isXmlSession(k)) toSession(b, xmlOptions(k), name, cap(path), `${file}#${[...path, name].join('/')}`, 'securecrt-xml')
      else {
        // An empty, "." or ".." folder name adds no level.
        const sub = isFolderName(name) ? [...path, name] : path
        b.folder(cap(sub))
        if (k.children.some((c) => c.name === 'key')) walk(k, sub)
      }
    }
  }
  walk(sessions, [])
}

/**
 * Import a SecureCRT `Sessions/` tree (one `.ini` per session, subfolders as
 * folders) and/or XML exports. Pass every file with its path; files outside a
 * `Sessions` folder are ignored when others are inside one.
 */
export function importSecureCrt(files: { path: string; text: string }[]): ImportResult {
  const b = new ResultBuilder()
  const cap = folderCapper(b)
  const anyInSessions = files.some((f) => sessionsRelative(splitPath(f.path)) !== null)
  const sorted = [...files].sort((a, b2) => a.path.localeCompare(b2.path))
  for (const f of sorted) {
    checkSize(f.text, f.path)
    const segs = splitPath(f.path)
    const file = segs[segs.length - 1] ?? f.path
    const head = stripBom(f.text).trimStart()
    if (/\.xml$/i.test(file) || head.startsWith('<?xml') || head.startsWith('<VanDyke')) {
      importXml(b, f.text, f.path, cap)
      continue
    }
    if (!/\.ini$/i.test(file)) continue
    let rel = sessionsRelative(segs)
    if (rel === null) {
      if (anyInSessions) continue
      rel = segs
    }
    const folderPath = cap(rel.slice(0, -1))
    const stem = file.replace(/\.ini$/i, '')
    if (stem === '__FolderData__') {
      b.folder(folderPath)
      continue
    }
    if (folderPath.length === 0 && stem === 'Default') {
      b.warn('Default', 'Skipped: SecureCRT default-session template (Default.ini)')
      continue
    }
    const o = parseCrtIni(f.text)
    if (num(o, 'Is Session') === 0) {
      b.warn(sessionRef({ folderPath, name: stem }), 'Skipped: file is marked "Is Session"=0')
      continue
    }
    toSession(b, o, stem, folderPath, f.path, 'securecrt')
  }
  return b.finish()
}
