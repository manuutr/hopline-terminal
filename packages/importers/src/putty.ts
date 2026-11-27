/**
 * PuTTY importer: a regedit `.reg` export of
 * `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\*`. regedit writes
 * UTF-16LE; decode with `decodeText()` first.
 *
 * Value names follow PuTTY's settings.c. PuTTY never stores session passwords,
 * but `ProxyPassword` is stored in clear text, and KiTTY adds `Password`: both
 * are flagged and dropped.
 */
import { addNote, guessFromName, ResultBuilder, type HopSpec } from './result'
import { checkSize, lookup, splitLines } from './text'
import { SERIAL_DEFAULTS, type ImportedSession, type ImportResult, type Protocol, type SerialSettings } from './types'

type RegValue = string | number
const SESSION_KEY = /\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\\]+)$/i

/** PuTTY escapes session names byte-wise as %XX. Bytes are the ANSI code page, or UTF-8 in newer builds. */
export function decodePuttyName(raw: string): string {
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === '%' && /^[0-9a-f]{2}$/i.test(raw.slice(i + 1, i + 3))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      const code = c.charCodeAt(0)
      if (code < 0x80) bytes.push(code)
      else bytes.push(...new TextEncoder().encode(c))
    }
  }
  const u8 = new Uint8Array(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch {
    return new TextDecoder('windows-1252').decode(u8)
  }
}

function parseRegString(s: string): string {
  return s.replace(/\\(.)/g, '$1')
}

/** Parse a .reg file into keys → values. Only REG_SZ and DWORD values are kept. */
export function parseReg(text: string): Map<string, Map<string, RegValue>> {
  const keys = new Map<string, Map<string, RegValue>>()
  let cur: Map<string, RegValue> | null = null
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    // hex values continue with a trailing backslash
    while (line.endsWith('\\') && i + 1 < lines.length && !/^\s*"/.test(lines[i + 1]!)) line = line.slice(0, -1) + lines[++i]!.trim()
    const t = line.trim()
    if (!t || t.startsWith(';')) continue
    const k = /^\[(-?)(.+)\]$/.exec(t)
    if (k) {
      cur = k[1] ? null : new Map()
      if (cur) keys.set(k[2]!, cur)
      continue
    }
    if (!cur) continue
    const v = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(t)
    if (!v) continue
    const name = parseRegString(v[1]!)
    const data = v[2]!
    const sz = /^"((?:[^"\\]|\\.)*)"$/.exec(data)
    if (sz) cur.set(name, parseRegString(sz[1]!))
    else if (/^dword:[0-9a-f]{1,8}$/i.test(data)) cur.set(name, parseInt(data.slice(6), 16))
  }
  return keys
}

const PROTOCOLS: Record<string, Protocol> = { ssh: 'ssh', telnet: 'telnet', raw: 'raw', serial: 'serial' }
const PARITY: SerialSettings['parity'][] = ['none', 'odd', 'even', 'mark', 'space']
const STOP_HALFBITS: Record<number, SerialSettings['stopBits']> = { 2: 1, 3: 1.5, 4: 2 }
const PROXY_NAMES = ['none', 'SOCKS 4', 'SOCKS 5', 'HTTP', 'Telnet', 'local command', 'SSH', 'SSH exec', 'SSH subsystem']

export function importPutty(text: string): ImportResult {
  checkSize(text, 'PuTTY .reg file')
  const b = new ResultBuilder()
  for (const [key, v] of parseReg(text)) {
    const m = SESSION_KEY.exec(key)
    if (!m) continue
    const name = decodePuttyName(m[1]!)
    const s_ = (k: string) => (typeof v.get(k) === 'string' ? (v.get(k) as string) : undefined)
    const n_ = (k: string) => (typeof v.get(k) === 'number' ? (v.get(k) as number) : undefined)
    if (name === 'Default Settings') {
      b.warn(name, 'Skipped: PuTTY default-settings template')
      continue
    }
    if (s_('Password')) b.warn(name, 'Saved password (KiTTY) not imported; you will be asked for it on connect')
    if (s_('ProxyPassword')) b.warn(name, 'Proxy password not imported (PuTTY stores it in clear text: consider removing it)')

    const protoName = (s_('Protocol') ?? 'ssh').toLowerCase()
    const protocol = lookup(PROTOCOLS, protoName)
    if (!protocol) {
      b.warn(name, `Skipped: PuTTY protocol "${protoName}" is not supported`)
      continue
    }
    const s: ImportedSession = {
      name,
      folderPath: [],
      host: '',
      port: 0,
      protocol,
      username: s_('UserName') ?? '',
      notes: '',
      options: {},
      tags: [],
      source: { format: 'putty', ref: key }
    }
    guessFromName(s)

    if (protocol === 'serial') {
      const line = (s_('SerialLine') ?? '').trim()
      if (!line) {
        b.warn(name, 'Skipped: serial session without a serial line')
        continue
      }
      s.host = line
      const serial: SerialSettings = { ...SERIAL_DEFAULTS }
      const speed = n_('SerialSpeed')
      if (speed) serial.baudRate = speed
      const bits = n_('SerialDataBits')
      if (bits && bits >= 5 && bits <= 8) serial.dataBits = bits as SerialSettings['dataBits']
      const stop = STOP_HALFBITS[n_('SerialStopHalfbits') ?? 2]
      if (stop) serial.stopBits = stop
      const parity = PARITY[n_('SerialParity') ?? 0]
      if (parity) serial.parity = parity
      const flow = n_('SerialFlowControl') ?? 1
      serial.flow = flow === 1 ? 'xonxoff' : flow === 2 ? 'rtscts' : 'none'
      if (flow === 3) b.warn(name, 'DSR/DTR flow control is not supported; set to none')
      s.options.serial = serial
      b.add(s)
      continue
    }

    let host = (s_('HostName') ?? '').trim()
    const at = host.lastIndexOf('@')
    if (at > 0) {
      if (!s.username) s.username = host.slice(0, at)
      host = host.slice(at + 1)
    }
    if (!host) {
      b.warn(name, 'Skipped: no host name')
      continue
    }
    s.host = host
    const port = n_('PortNumber')
    s.port = port && port > 0 && port < 65536 ? port : protocol === 'ssh' ? 22 : 23

    let hops: HopSpec[] | undefined
    if (protocol === 'ssh') {
      const ssh: NonNullable<ImportedSession['options']['ssh']> = {}
      if (n_('AgentFwd') === 1) ssh.agentForward = true
      if (n_('TryAgent') === 0) ssh.useAgent = false
      if (Object.keys(ssh).length) s.options.ssh = ssh
      const key = s_('PublicKeyFile')
      if (key) addNote(s, `Private key: ${key}`)
    }
    const method = n_('ProxyMethod') ?? 0
    const proxyHost = (s_('ProxyHost') ?? '').trim()
    if (method !== 0 && proxyHost && proxyHost !== 'proxy') {
      if (method === 6) {
        // PuTTY 0.77+: proxy through SSH; ProxyHost may be a saved session's name.
        const pport = n_('ProxyPort')
        const user = s_('ProxyUsername') || undefined
        hops = [{ ref: proxyHost, host: proxyHost, port: pport && pport !== 80 ? pport : undefined, user, label: proxyHost }]
      } else {
        addNote(s, `PuTTY proxy (${PROXY_NAMES[method] ?? method}): ${proxyHost}:${n_('ProxyPort') ?? ''}`)
        b.warn(name, `PuTTY ${PROXY_NAMES[method] ?? `type ${method}`} proxy not imported`)
      }
    }
    b.add(s, hops)
  }
  return b.finish()
}
