import type { Event, Exception, StackFrame } from '@sentry/core'
import { redact, SECRET_KEYWORDS } from '@hopline/guard'

/**
 * Crash-report scrubbing (D7). Pure: no Electron, no Sentry client, so the tests feed it nasty
 * fixtures directly.
 *
 * Two layers:
 * 1. **Allow-list.** `scrubEvent` builds a new event from a few fields: the exception's type, its
 *    scrubbed message, and stack frames reduced to function, app-relative file, line and column.
 *    Everything else the SDK or an error object carries is dropped: breadcrumbs (console lines can
 *    hold terminal output), user, server_name (the machine's hostname), request, extra, contexts,
 *    modules, frame vars and source context, and an error's own properties (`address`, `hostname`,
 *    `path`, `syscall`, `cause`…).
 * 2. **Text scrubbing.** Messages are the one free-text field left, so `scrubText` keeps only the
 *    first line, removes everything shaped like an address, a host, a path, a key or a prompt,
 *    removes the values Hopline knows are the user's (session names, hosts, usernames, folder
 *    names, the OS user and machine name), blanks quoted strings that are not plain identifiers,
 *    and caps the length.
 *
 * Scrubbing errs on the side of losing debugging detail. A report that says only
 * "TypeError: Cannot read properties of undefined (reading 'map') at tabs.ts:120" is still useful.
 */

export interface ScrubContext {
  /** Literal values that belong to the user: session names, hosts, usernames, folder names… */
  known: readonly string[]
}

export const MAX_MESSAGE = 300
const MAX_FRAMES = 50

const R = {
  pem: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g,
  sshKey: /\b(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]{16,}/g,
  url: /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi,
  buffer: /<Buffer( [0-9a-f]{2})+( \.\.\. \d+ more bytes)?>/gi,
  hexBytes: /\b([0-9a-f]{2}[ :,-]){7,}[0-9a-f]{2}\b/gi,
  byteList: /\b\d{1,3}(\s*,\s*\d{1,3}){15,}\b/g,
  apiKey: /\b(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+)/g,
  // Everything after a secret-ish word goes: "enable secret 5 $1$…", "snmp-server community public RO",
  // "tacacs key X", "pre-shared-key X". The guard's own keyword list is part of it, so the redaction
  // for the model and this scrubber never drift apart (review M6). A bare "key <word>" counts too, and
  // so does FortiOS "md5-keys N X": the guard anchors those to the start of a config line, and here
  // the line is usually quoted mid-message (Phase 8 D-L7). Escapes are doubled: these are plain strings.
  secretRest: new RegExp(String.raw`\b(${[...SECRET_KEYWORDS, 'password', 'passwd', 'pwd', 'secret', 'passphrase', 'community', 'psk', 'key-string', 'credentials?', 'md5-keys?', 'key(?=\\s+\\S)'].map((k) => `(?:${k})`).join('|')})(?![\w-]).*$`, 'gi'),
  // A dotless "host:port" (`connect ECONNREFUSED core-sw1:22`); the name must contain a letter, so
  // a time like 12:30 is not one. IP and dotted names are handled by their own rules first.
  hostPort: /(?<![\w<>.:-])(?=[\w-]*[A-Za-z])[A-Za-z0-9][\w-]*:\d{1,5}\b(?![:.\w])/g,
  // A VRF / routing instance name is a customer or site name.
  vrf: /\b(vrf(?:\s+(?:forwarding|member|definition|context))?|routing-instance|vpn-instance)\s+(?!<)[^\s'"`,;)]+/gi,
  // "Bearer abc…", "Token 0123…", "authorization: …" (not "Unexpected token <").
  tokenValue: /\b(bearer|token|authorization|basic)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/gi,
  keyValue: /\b(key|api[-_]?key|auth|private[-_]?key)\s*[:=]\s*\S+/gi,
  longHex: /\b[0-9a-f]{24,}\b/gi,
  longB64: /[A-Za-z0-9+/_-]{28,}={0,2}/g,
  email: /[\w.+-]+@[\w-]+(\.[\w-]+)*/g,
  winPath: /\b[a-z]:[\\/][^\s'"`<>|]*/gi,
  uncPath: /\\\\[^\s'"`<>|]+/g,
  posixPath: /(^|[\s('"`=:])(~|\.{1,2})?\/[^\s'"`<>()]*/g,
  // Any run of hex and colons with two or more colons (also catches times like 12:30:45: fine).
  ipv6: /(?<![\w:.])(?=[0-9a-f:]*:[0-9a-f:]*:)(?=[0-9a-f:]*[0-9a-f])[0-9a-f:]{2,39}(%[\w.-]+)?(\/\d{1,3})?(?![\w:])/gi,
  ipv4: /\b\d{1,3}(\.\d{1,3}){3}(\/\d{1,2}|:\d{1,5})?\b/g,
  mac: /\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b([0-9a-f]{4}\.){2}[0-9a-f]{4}\b/gi,
  host: /\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\b/gi,
  // A device prompt and whatever follows it on the line (the command typed there, its output).
  prompt: /(^|\s)(<redacted>|[^\s#><'"`]{1,63})(\([\w-]*\))?(#|>(?!=)).*$/,
  // A CLI command without a prompt: from the verb to the end of the line.
  cli: /\b(show|display|sh run|conf(igure)? t(erminal)?|write mem(ory)?|copy run(ning-config)?|debug|snmp-server|username|enable secret|crypto|tacacs-server|radius-server|access-list|router (bgp|ospf|eigrp|isis|rip)|interface \S|ip (address|route)|ipv6 (address|route)|set (system|security|interfaces|protocols|policy)|request system|commit|reload|terminal length)\b.*$/i,
  quoted: /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g,
  // A name the resolver or socket was given: `getaddrinfo ENOTFOUND edge-rtr7`, `EAI_AGAIN core`,
  // `connect to sw1 failed`. Dotless hosts have no shape, so the position gives them away.
  dnsError: /\b(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)\s+(?!<)[^\s'"`,;)]+/g,
  lookup: /\b(connecting(?: to)?|connected to|connect to|connection to|ssh to|telnet to|lookup|hostname|from|on)\s+(?!<|(?:the|a|an|this|that|undefined|null|line|position|Settings|close|error|exit|disk)\b)[^\s'"`,;)]+/gi,
  // Interface names carry a site's numbering (Gi1/0/1, Ethernet1/1, ge-0/0/0.0).
  iface: /\b(gi|te|fa|fo|hu|tw|eth|ethernet|gigabitethernet|tengigabitethernet|port-channel|po|vlan|lo|loopback|mgmt|ge|xe|et|ae|irb|tunnel|bdi|bvi)[\s-]?\d+([/.:]\d+)*\b/gi
} as const

const IDENT = /^[A-Za-z_$][\w$]{0,40}$/

/** `Object.keys`, `JSON.parse`, `this.state.tabs`: code in a message, not a host. A real TLD always counts as a host. */
const CODE_ROOTS = new Set(['Object', 'JSON', 'Math', 'Array', 'Promise', 'Reflect', 'Symbol', 'Number', 'String', 'Buffer', 'process', 'window', 'document', 'globalThis', 'console', 'this', 'e', 'err', 'error', 'ev', 'event', 'props', 'state', 'self', 'crypto', 'ipcRenderer', 'ipcMain', 'require', 'module', 'exports', 'navigator', 'location', 'history', 'localStorage', 'Intl', 'Date', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'URL', 'React', 'hopline'])
const TLDS = /\.(com|net|org|io|local|localdomain|lan|corp|internal|intra|intranet|home|arpa|edu|gov|int|mil|co|uk|de|fr|es|it|nl|be|ch|at|pl|cz|se|no|dk|fi|ru|cn|jp|kr|in|br|au|ca|us|eu|info|biz|site|cloud|dev|app|lab|test|example)$/i
const codeMember = (m: string): boolean => {
  const parts = m.split('.')
  return CODE_ROOTS.has(parts[0]!) && parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p)) && !TLDS.test(m)
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Word-boundary matchers for the user's own values, longest first; short or empty ones are skipped. */
function knownMatcher(known: readonly string[]): RegExp | null {
  const vals = [...new Set(known.map((v) => v.trim()).filter((v) => v.length >= 2 && v.length <= 200))].sort((a, b) => b.length - a.length)
  if (!vals.length) return null
  // (?<![\w-]) … (?![\w-]): "core" is removed from "core sw", not from "score".
  return new RegExp(`(?<![\\w-])(${vals.map(escape).join('|')})(?![\\w-])`, 'gi')
}

/** One line of free text, scrubbed. */
export function scrubText(input: unknown, ctx: ScrubContext): string {
  let s = typeof input === 'string' ? input : input == null ? '' : String(input)
  // Terminal output, configs and command lists are multi-line; an error message is one line.
  // PEM blocks span lines: take them out before cutting.
  s = s.replace(R.pem, '<key>')
  const nl = s.search(/[\r\n]/)
  if (nl >= 0) s = s.slice(0, nl) + ' <…>'
  s = s.slice(0, 2000)
  // The user's own values first, before shape rules split them up.
  const known = knownMatcher(ctx.known)
  if (known) s = s.replace(known, '<redacted>')
  // The guard's redaction (the rules the model's input goes through): ciphertext blobs and keyword values.
  s = redact(s).text
  s = s
    .replace(R.sshKey, '<key>')
    .replace(R.url, '<url>')
    .replace(R.dnsError, (_m, k: string) => `${k} <host>`)
    .replace(R.lookup, (_m, k: string) => `${k} <host>`)
    .replace(R.vrf, (_m, k: string) => `${k} <name>`)
    .replace(R.buffer, '<bytes>')
    .replace(R.apiKey, '<secret>')
    .replace(R.secretRest, (_m, k: string) => `${k} <secret>`)
    .replace(R.tokenValue, (_m, k: string) => `${k} <secret>`)
    .replace(R.keyValue, (_m, k: string) => `${k}=<secret>`)
    .replace(R.email, '<user@host>')
    .replace(R.winPath, '<path>')
    .replace(R.uncPath, '<path>')
    .replace(R.posixPath, (_m, pre: string) => `${pre}<path>`)
    .replace(R.mac, '<mac>')
    .replace(R.ipv6, '<ip>')
    .replace(R.ipv4, '<ip>')
    .replace(R.hexBytes, '<bytes>')
    .replace(R.byteList, '<bytes>')
    .replace(R.longHex, '<secret>')
    .replace(R.longB64, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '<secret>' : m))
    .replace(R.host, (m) => (/^\d+(\.\d+)*$/.test(m) || codeMember(m) ? m : '<host>'))
    .replace(R.hostPort, '<host>:<port>')
    .replace(R.iface, '<iface>')
    .replace(R.prompt, (_m, pre: string) => `${pre}<prompt> <…>`)
    .replace(R.cli, '<cli> <…>')
    // A quoted value is almost always something interpolated (a command, a name, a reply). Keep
    // plain identifiers ("reading 'map'"), blank the rest.
    .replace(R.quoted, (m, q: string, body: string) => (IDENT.test(body) || /^<[a-z@]+>$/.test(body) ? m : `${q}<str>${q}`))
  if (known) s = s.replace(known, '<redacted>')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s
}

/** An exception type is a class name: keep identifiers, nothing else. */
const scrubType = (t: unknown): string => (typeof t === 'string' && /^[A-Za-z_$][\w$.]{0,60}$/.test(t) ? t : 'Error')

/** A function name from a stack frame: code, but `eval` frames and odd names can carry anything. */
const scrubFunction = (f: unknown, known: RegExp | null): string | undefined => {
  if (typeof f !== 'string' || !f) return undefined
  if (known && new RegExp(known.source, 'i').test(f)) return '<fn>'
  const clean = f.replace(/^(async |new )/, '')
  return /^[\w$<>.[\] ]{1,80}$/.test(clean) && !/\s{2}/.test(clean) ? f.slice(0, 80) : '<fn>'
}

/**
 * A frame's file, relative to the app: `out/main/index.js`, `node_modules/ssh2/lib/client.js`,
 * `node:internal/...`. A path outside the app (a user's folder, a dev checkout) keeps only a code
 * file's name.
 */
export function appRelative(file: unknown, known: RegExp | null = null): string | undefined {
  if (typeof file !== 'string' || !file) return undefined
  const f = file.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '/')
  if (/^node:[\w/:-]+$/.test(f)) return f
  if (/^(native|<anonymous>)$/.test(f)) return f
  for (const anchor of ['app.asar/', 'app.asar.unpacked/', 'node_modules/', 'apps/desktop/', 'out/']) {
    const i = f.lastIndexOf(anchor === 'out/' ? '/out/' : anchor)
    if (i >= 0) {
      const rel = anchor === 'out/' ? f.slice(i + 1) : anchor === 'apps/desktop/' ? f.slice(i + anchor.length) : f.slice(i)
      if (/^[\w@./+-]{1,200}$/.test(rel)) return rel
    }
  }
  const base = f.split('/').pop() ?? ''
  if (known && new RegExp(known.source, 'i').test(base)) return '<file>'
  return /^[\w.-]{1,80}\.(c|m)?(js|ts|tsx|jsx)$/.test(base) ? base : '<file>'
}

function scrubFrames(frames: StackFrame[] | undefined, known: RegExp | null): StackFrame[] | undefined {
  if (!frames?.length) return undefined
  return frames.slice(-MAX_FRAMES).map((fr) => {
    const out: StackFrame = {}
    const filename = appRelative(fr.filename ?? fr.abs_path, known)
    const fn = scrubFunction(fr.function, known)
    if (filename) out.filename = filename
    if (fn) out.function = fn
    if (typeof fr.lineno === 'number') out.lineno = fr.lineno
    if (typeof fr.colno === 'number') out.colno = fr.colno
    out.in_app = !!filename && !filename.startsWith('node:') && !filename.startsWith('node_modules/')
    return out
  })
}

function scrubException(e: Exception, ctx: ScrubContext): Exception {
  const out: Exception = { type: scrubType(e.type), value: scrubText(e.value, ctx) }
  const frames = scrubFrames(e.stacktrace?.frames, knownMatcher(ctx.known))
  if (frames) out.stacktrace = { frames }
  if (e.mechanism) out.mechanism = { type: /^[\w.:-]{1,40}$/.test(e.mechanism.type) ? e.mechanism.type : 'generic', handled: !!e.mechanism.handled }
  return out
}

/** Tag keys and values a report may carry, all set by Hopline itself. */
const TAGS: Record<string, RegExp> = {
  process: /^(main|renderer|session-host|gpu|utility|unknown)$/,
  kind: /^(exception|rejection|render|process-gone|test)$/,
  reason: /^[a-z-]{1,30}$/,
  os: /^(linux|darwin|win32)$/,
  arch: /^(x64|arm64|ia32|arm)$/,
  electron: /^\d+\.\d+\.\d+$/,
  channel: /^(stable|beta)$/
}

/**
 * Rebuild an event from the allow-list. Returns null (nothing is sent) when the event has neither
 * an exception nor a message, or when anything about it is unexpected.
 */
export function scrubEvent(ev: Event, ctx: ScrubContext): Event | null {
  try {
    const values = (ev.exception?.values ?? []).slice(-5).map((x) => scrubException(x, ctx))
    const message = ev.message ? scrubText(typeof ev.message === 'string' ? ev.message : String((ev.message as { message?: string }).message ?? ''), ctx) : undefined
    if (!values.length && !message) return null
    const tags: Record<string, string> = {}
    for (const [k, v] of Object.entries(ev.tags ?? {})) if (TAGS[k]?.test(String(v))) tags[k] = String(v)
    const out: Event = {
      ...(ev.event_id ? { event_id: ev.event_id } : {}),
      ...(ev.timestamp ? { timestamp: ev.timestamp } : {}),
      platform: 'node',
      level: ev.level === 'fatal' || ev.level === 'warning' || ev.level === 'info' ? ev.level : 'error',
      ...(ev.release && /^hopline@[\w.+-]{1,40}$/.test(ev.release) ? { release: ev.release } : {}),
      ...(ev.environment && /^(production|beta|development)$/.test(ev.environment) ? { environment: ev.environment } : {}),
      ...(values.length ? { exception: { values } } : {}),
      ...(message ? { message } : {}),
      tags,
      ...(ev.sdk ? { sdk: { name: String(ev.sdk.name ?? 'hopline').slice(0, 60), version: String(ev.sdk.version ?? '').slice(0, 20) } } : {})
    }
    return out
  } catch {
    return null
  }
}
