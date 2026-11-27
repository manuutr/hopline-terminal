/// <reference path="./legacy/ssh2-internals.d.ts" />
/**
 * Production SSH transport (ssh2@1.17.0): jump-host chains, agent / key / password /
 * keyboard-interactive auth, agent forwarding, BREAK, flow control and legacy algorithms that
 * also work under Electron's BoringSSL (see ./legacy).
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import ssh2 from 'ssh2'
import type { AnyAuthMethod, AuthenticationType, Client, ClientChannel, ConnectConfig, ParsedKey, Prompt, SFTPWrapper, ShellOptions, TcpConnectionDetails } from 'ssh2'
import protocolUtils from 'ssh2/lib/protocol/utils.js'
import { hookGroup1, legacyAlgorithms, legacyNegotiated, legacySupport } from './legacy/index.ts'
import { parsePrivateKey } from './ppk.ts'
import { detectAgent } from './ssh-agent.ts'
import { TransportError, type HostKeyVerifier, type PromptRetry, type Prompter, type TermSize, type Transport, type TransportErrorCode } from './types.ts'

/**
 * How to authenticate to one hop. keyboard-interactive is always tried as well (servers that
 * only do MFA, or "password" via k-i, as most network gear does), with each round sent to
 * `prompter.keyboardInteractive`. A stored `password` answers at most one plain "Password:"
 * prompt automatically and is never used for OTP-style prompts.
 */
export type SshAuth =
  /** Password auth. Without `password`, the user is asked via `prompter.secret`. */
  | { type: 'password'; password?: string }
  /** OpenSSH / PEM / PPK (v2, v3) private key text. A missing passphrase is asked for when needed. */
  | { type: 'key'; privateKey: string; passphrase?: string; password?: string }
  /** SSH agent. `socket` overrides auto-detection (Unix socket, Windows pipe, or 'pageant'). */
  | { type: 'agent'; socket?: string; password?: string }
  /** Nothing stored: keyboard-interactive, then a prompted password. */
  | { type: 'interactive' }

export interface SshHop {
  host: string
  port?: number
  username: string
  auth: SshAuth
  /** Host-key policy for this hop. Defaults to the session's `verifyHostKey`. */
  verifyHostKey?: HostKeyVerifier
  /** Display name used in notices and errors. Defaults to `host`. */
  label?: string
}

export interface SshTransportOptions {
  host: string
  port: number
  username: string
  auth: SshAuth
  /** Jump hosts, outermost first (like `ssh -J jump1,jump2 target`). */
  jump?: SshHop[]
  keepAliveSec: number
  term?: string
  size: TermSize
  /**
   * Per-hop budget for TCP connect + handshake + auth (default 20 s). The clock stops while the
   * user is answering a prompt or a host-key dialog.
   */
  readyTimeoutMs?: number
  verifyHostKey: HostKeyVerifier
  prompter: Prompter
  /** Forward the local agent to the target (never to jump hosts). */
  agentForward?: boolean
  /** Offer legacy kex / host key / cipher / MAC algorithms after the modern ones. Default true. */
  legacyAlgorithms?: boolean
  /** Display name for the target in notices and errors. Defaults to `host`. */
  label?: string
  /**
   * Open an interactive shell (default true). false: a side connection for file transfer only
   * (connect() resolves once authenticated; no data events).
   */
  shell?: boolean
}

/** A forwarded-tcpip channel the server opened for one of our remote forwards (`ssh -R`). */
export interface IncomingTcp {
  info: TcpConnectionDetails
  accept: () => ClientChannel
  reject: () => void
}

const DEFAULT_READY_TIMEOUT = 20_000
/** Close reason after the device ended the shell itself (see the convention in types.ts). */
export const SSH_LOGOUT_REASON = 'logout: session ended by the device'
/** User-answered attempts per hop (like OpenSSH's NumberOfPasswordPrompts). */
const MAX_USER_ATTEMPTS = 3
const MAX_KBD_ROUNDS = 10
const MAX_PASSPHRASE_TRIES = 3
const OTP_LIKE = /one[- ]?time|otp|token|passcode|pin\b|code|verif|duo|push|factor/i

interface Hop {
  host: string
  port: number
  username: string
  auth: SshAuth
  verify: HostKeyVerifier
  label: string
  index: number
  target: boolean
}

type SshError = Error & { level?: string; code?: string | number; reason?: number }

/** A timer whose clock can be stopped while we wait on the user. */
class Deadline {
  private timer: NodeJS.Timeout | undefined
  private remaining: number
  private startedAt = 0
  private holds = 0
  private done = false
  private readonly onExpire: () => void
  constructor(ms: number, onExpire: () => void) {
    this.onExpire = onExpire
    this.remaining = ms
    if (ms > 0) this.run()
    else this.done = true
  }
  private run(): void {
    this.startedAt = Date.now()
    this.timer = setTimeout(() => {
      this.done = true
      this.onExpire()
    }, this.remaining)
  }
  hold(): void {
    if (this.done || this.holds++ > 0) return
    clearTimeout(this.timer)
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt))
  }
  release(): void {
    if (this.done || this.holds === 0 || --this.holds > 0) return
    this.run()
  }
  clear(): void {
    this.done = true
    clearTimeout(this.timer)
  }
}

function readSshString(buf: Buffer): string {
  if (buf.length < 4) return 'unknown'
  const len = buf.readUInt32BE(0)
  return buf.subarray(4, 4 + len).toString('latin1') || 'unknown'
}

export function sshFingerprint(keyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')
}

const UNREACHABLE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'EADDRNOTAVAIL'])

/** SSH_MSG_DISCONNECT reason codes (RFC 4253 11.1) that ssh2 surfaces as a numeric `code`. */
const DISCONNECT_PROTOCOL = new Set([2, 3, 4, 5, 6, 8, 9])
const DISCONNECT_AUTH = new Set([13, 14, 15])

/**
 * Map an ssh2 / socket error to a TransportError for hop `where`. `authStarted` means a real
 * credential was already sent: any drop after that is treated as an auth failure (permanent), because
 * gear that counts failures (MaxAuthTries, lockout) often disconnects instead of rejecting.
 */
export function mapSshError(e: SshError, where: string, authStarted = false): TransportError {
  const msg = e.message || String(e)
  const code = e.code ?? ''
  let c: TransportErrorCode = 'other'
  let text = msg
  if (typeof code === 'number') {
    // The server sent SSH_MSG_DISCONNECT.
    if (authStarted || DISCONNECT_AUTH.has(code)) {
      c = 'auth'
      text = `server disconnected during authentication (${msg})`
    } else {
      c = DISCONNECT_PROTOCOL.has(code) ? 'protocol' : code === 12 ? 'refused' : 'other'
      text = `server disconnected (${msg})`
    }
  } else if (code === 'ECONNREFUSED') {
    c = 'refused'
    text = 'connection refused'
  } else if (UNREACHABLE.has(code)) {
    c = 'unreachable'
    text = code === 'ENOTFOUND' || code.startsWith('EAI_') ? 'host name not found' : `no route to host (${code})`
  } else if (code === 'ETIMEDOUT' || e.level === 'client-timeout') {
    c = 'timeout'
    text = /keepalive/i.test(msg) ? 'keepalive timeout' : 'timed out connecting'
  } else if (e.level === 'client-authentication') {
    c = 'auth'
    text = 'authentication failed'
  } else if (/no matching/i.test(msg)) {
    c = 'protocol'
    text = `${msg.replace(/^Handshake failed: /, '')} (the device may need legacy algorithms)`
  } else if (e.level === 'handshake' || e.level === 'protocol') {
    c = 'protocol'
  } else if (code === 'ECONNRESET' || code === 'EPIPE') {
    c = authStarted ? 'auth' : 'other'
    text = authStarted ? 'connection reset during authentication' : 'connection reset'
  }
  return new TransportError(c, `${where}: ${text}`, e)
}

/** Map a failed `forwardOut` on jump `via` while reaching `to`. */
function mapForwardError(e: SshError, via: Hop, to: Hop): TransportError {
  const where = `${to.label} (${to.host}:${to.port}) via ${via.label}`
  const msg = e.message || ''
  if (e.reason === 1) return new TransportError('refused', `${where}: jump host refused to open a tunnel (administratively prohibited; is TCP forwarding disabled?)`, e)
  if (e.reason === 3) return new TransportError('protocol', `${where}: jump host does not support direct-tcpip`, e)
  if (/no route|unreachable|resolve|not known|name or service/i.test(msg)) return new TransportError('unreachable', `${where}: ${msg}`, e)
  if (/timed? ?out/i.test(msg)) return new TransportError('timeout', `${where}: ${msg}`, e)
  if (e.reason === 2 || /refused|connect failed/i.test(msg)) return new TransportError('refused', `${where}: connection refused`, e)
  return new TransportError('other', `${where}: ${msg || 'could not open tunnel'}`, e)
}

type Step = 'none' | 'publickey' | 'agent' | 'password' | 'keyboard-interactive'

function planFor(auth: SshAuth): Step[] {
  switch (auth.type) {
    case 'password':
      // A stored password goes first over plain password auth; without one, let the server
      // drive the prompts (k-i) before asking for a password ourselves.
      return auth.password !== undefined ? ['password', 'keyboard-interactive', 'password'] : ['keyboard-interactive', 'password']
    case 'key':
      return ['publickey', 'keyboard-interactive', 'password']
    case 'agent':
      return ['agent', 'keyboard-interactive', 'password']
    case 'interactive':
      return ['keyboard-interactive', 'password']
  }
}

const storedPassword = (auth: SshAuth): string | undefined => (auth.type === 'interactive' ? undefined : auth.password)

export class SshTransport extends EventEmitter implements Transport {
  readonly kind = 'ssh' as const
  private readonly opts: SshTransportOptions
  private readonly hops: Hop[]
  private clients: Client[] = []
  /** The hop currently connecting (not yet in `clients`), so end() can stop it mid-prompt. */
  private pending: Client | undefined
  private stream: ClientChannel | null = null
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  private userEnded = false
  private closeEmitted = false
  private linkError: string | undefined
  private banner = ''
  private ident: string | undefined
  /** Data listeners are attached (banner flushed); before that the channel buffers. */
  private dataStarted = false
  /** Flow-control state requested by pause()/resume(); applied once data starts. */
  private paused = false
  /** The server sent exit-status / exit-signal: the shell ended (user typed exit/logout). */
  private remoteExited = false
  private agentForSession: string | undefined
  /** Latest terminal size, including resizes made while connecting. */
  private size: TermSize

  constructor(opts: SshTransportOptions) {
    super()
    this.opts = opts
    this.size = { ...opts.size }
    const jumps = opts.jump ?? []
    const all: Omit<Hop, 'index' | 'target'>[] = [
      ...jumps.map((j) => ({
        host: j.host,
        port: j.port ?? 22,
        username: j.username,
        auth: j.auth,
        verify: j.verifyHostKey ?? opts.verifyHostKey,
        label: j.label ?? j.host
      })),
      { host: opts.host, port: opts.port, username: opts.username, auth: opts.auth, verify: opts.verifyHostKey, label: opts.label ?? opts.host }
    ]
    this.hops = all.map((h, index) => ({ ...h, index, target: index === all.length - 1 }))
  }

  /**
   * The target server's SSH identification line (`SSH-2.0-Cisco-1.25`), including any comment
   * after the software version. Known once connected; used to fingerprint the platform.
   */
  get serverIdent(): string | undefined {
    return this.ident
  }

  async connect(): Promise<void> {
    if (this.state !== 'idle') throw new TransportError('other', 'connect() may only be called once')
    this.state = 'connecting'
    try {
      if (this.opts.agentForward) {
        const a = this.opts.auth
        this.agentForSession = a.type === 'agent' && a.socket ? a.socket : (await detectAgent())?.path
      }
      let sock: Duplex | undefined
      for (const hop of this.hops) {
        if (hop.index > 0) sock = await this.tunnel(this.hops[hop.index - 1]!, hop)
        this.clients.push(await this.connectHop(hop, sock))
        if (this.userEnded) throw new TransportError('cancelled', 'connection cancelled')
      }
      if (this.hops.length > 1) this.emit('notice', `via ${this.hops.slice(0, -1).map((h) => h.label).join(' → ')}`)
      // Remote forwards: the server opens a channel per connection; whoever owns the forward decides.
      this.target()!.on('tcp connection', (info, accept, reject) => {
        if (this.listenerCount('tcp-connection') === 0) return reject()
        this.emit('tcp-connection', { info, accept, reject } satisfies IncomingTcp)
      })
      if (this.opts.shell === false) {
        this.state = 'open'
        return
      }
      await this.openShell()
      this.state = 'open'
      // The caller subscribes to 'data' only after `await connect()`: start the flow on the next
      // turn of the event loop (a microtask would still run before the caller's continuation).
      setImmediate(() => this.startData())
    } catch (e) {
      this.state = 'closed'
      this.teardown()
      // After end(), whatever broke (tunnel, shell, a hop) broke because we closed it.
      if (this.userEnded && !(e instanceof TransportError && e.code === 'cancelled')) throw new TransportError('cancelled', 'connection cancelled', e)
      throw e instanceof TransportError ? e : new TransportError('other', (e as Error)?.message ?? String(e), e)
    }
  }

  write(data: Buffer | string): void {
    this.stream?.write(data)
  }

  resize(size: TermSize): void {
    this.size = { cols: size.cols, rows: size.rows }
    this.stream?.setWindow(size.rows, size.cols, 0, 0)
  }

  pause(): void {
    this.paused = true
    // Before startData() the channel has no 'data' listener; resuming it then would discard output.
    if (!this.dataStarted) return
    this.stream?.pause()
    this.stream?.stderr.pause()
  }

  resume(): void {
    this.paused = false
    if (!this.dataStarted) return
    this.stream?.resume()
    this.stream?.stderr.resume()
  }

  /** RFC 4335 "break" channel request; `ms` is the break length the server should assert. */
  async sendBreak(ms = 500): Promise<void> {
    const stream = this.stream
    const client = this.clients[this.clients.length - 1]
    if (!stream || !client || this.state !== 'open') throw new TransportError('other', 'not connected')
    sendBreakRequest(client, stream, ms)
  }

  // ------------------------------------------------------------------ extra channels (same connection)

  private target(): Client | undefined {
    return this.clients.length === this.hops.length ? this.clients[this.clients.length - 1] : undefined
  }

  private live(): Client {
    const c = this.target()
    if (!c || this.state !== 'open') throw new TransportError('other', 'not connected')
    return c
  }

  /**
   * Start the SFTP subsystem on a new channel of this connection (through the same jump chain, no
   * second login). Rejects with `ChannelError`: `kind: 'channel'` when the server refused another
   * channel, `kind: 'subsystem'` when it has no SFTP.
   */
  openSftp(): Promise<SFTPWrapper> {
    const c = this.live()
    return new Promise((resolve, reject) => {
      c.sftp((err, sftp) => (err ? reject(channelError(err, 'sftp')) : resolve(sftp)))
    })
  }

  /** Run `command` on a new exec channel (SCP). Rejects with a `ChannelError` (see openSftp). */
  openExec(command: string): Promise<ClientChannel> {
    const c = this.live()
    return new Promise((resolve, reject) => {
      c.exec(command, (err, ch) => (err ? reject(channelError(err, 'exec')) : resolve(ch)))
    })
  }

  /** A direct-tcpip channel from the target to `dstHost:dstPort` (local and dynamic forwards). */
  forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number): Promise<ClientChannel> {
    const c = this.live()
    return new Promise((resolve, reject) => {
      c.forwardOut(srcHost, srcPort, dstHost, dstPort, (err, ch) => (err ? reject(err) : resolve(ch)))
    })
  }

  /** Ask the target to listen on `bindAddr:bindPort` for us (`ssh -R`); resolves with the bound port. */
  forwardIn(bindAddr: string, bindPort: number): Promise<number> {
    const c = this.live()
    return new Promise((resolve, reject) => {
      c.forwardIn(bindAddr, bindPort, (err, port) => (err ? reject(err) : resolve(port)))
    })
  }

  unforwardIn(bindAddr: string, bindPort: number): Promise<void> {
    const c = this.target()
    if (!c || this.state !== 'open') return Promise.resolve()
    return new Promise((resolve) => {
      try {
        c.unforwardIn(bindAddr, bindPort, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  /** Same targets, credentials and jump chain, but a fresh connection without a shell. */
  sideConnection(overrides: Partial<SshTransportOptions> = {}): SshTransport {
    return new SshTransport({ ...this.opts, ...overrides, shell: false, agentForward: false })
  }

  end(): void {
    this.userEnded = true
    const wasOpen = this.state === 'open'
    this.state = 'closed'
    this.teardown()
    if (wasOpen) this.finish()
  }

  // ---------------------------------------------------------------------------------------------

  private teardown(): void {
    try {
      this.stream?.end()
    } catch {
      /* ignore */
    }
    // Innermost first; ending an outer hop kills the tunnels running through it.
    for (const c of [this.pending, ...[...this.clients].reverse()]) {
      if (!c) continue
      try {
        c.end()
      } catch {
        /* ignore */
      }
    }
  }

  private finish(reason?: string): void {
    if (this.closeEmitted) return
    // A session that closes before the deferred data start still delivers what it sent.
    this.startData(true)
    this.closeEmitted = true
    const wasUser = this.userEnded
    this.state = 'closed'
    if (!wasUser) this.teardown()
    // A user-initiated end() closes silently (no reason => no auto-reconnect). After the shell
    // exited on the device, whichever link event fires first, the session was logged out.
    this.emit('close', wasUser ? undefined : this.remoteExited ? SSH_LOGOUT_REASON : (reason ?? 'connection lost'))
  }

  /** Called when any link drops after the session is up. */
  private linkDown(hop: Hop, why?: string): void {
    if (this.state !== 'open') return
    const prefix = hop.target ? '' : `${hop.label}: `
    this.finish(`${prefix}${why ?? this.linkError ?? 'connection lost'}`)
  }

  /**
   * Emit the login banner, then start forwarding channel data. Runs once, after connect() has
   * resolved, so the banner and the first prompt reach a listener attached after `await connect()`.
   * `drain` (from finish()) also emits what the channel already buffered, before 'close'.
   */
  private startData(drain = false): void {
    const stream = this.stream
    if (this.dataStarted || !stream || this.userEnded || this.closeEmitted) return
    this.dataStarted = true
    if (this.banner) {
      this.emit('data', Buffer.from(this.banner.replace(/\r?\n/g, '\r\n')))
      this.banner = ''
    }
    if (drain) {
      for (const src of [stream, stream.stderr]) {
        let chunk: Buffer | null
        while ((chunk = src.read() as Buffer | null) !== null) this.emit('data', chunk)
      }
    }
    if (this.paused) {
      stream.pause()
      stream.stderr.pause()
    }
    stream.on('data', (d: Buffer) => this.emit('data', d))
    stream.stderr.on('data', (d: Buffer) => this.emit('data', d))
  }

  private tunnel(via: Hop, to: Hop): Promise<Duplex> {
    const client = this.clients[via.index]!
    const ms = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT
    return new Promise((resolve, reject) => {
      const timer =
        ms > 0
          ? setTimeout(() => reject(new TransportError('timeout', `${to.label} (${to.host}:${to.port}) via ${via.label}: timed out opening tunnel`)), ms)
          : undefined
      client.forwardOut('127.0.0.1', 0, to.host, to.port, (err, channel) => {
        clearTimeout(timer)
        if (err) reject(mapForwardError(err as SshError, via, to))
        else resolve(channel)
      })
    })
  }

  private connectHop(hop: Hop, sock: Duplex | undefined): Promise<Client> {
    const where = `${hop.label} (${hop.host}:${hop.port})`
    const prompter = this.opts.prompter
    return new Promise<Client>((resolve, reject) => {
      const client = new ssh2.Client()
      this.pending = client
      let settled = false
      let ready = false
      /** Our own first cause (host-key reject, cancel, timeout); wins over ssh2's later error. */
      let cause: TransportError | undefined
      /** A real credential (not 'none') has been sent; see mapSshError. */
      let authStarted = false
      /** Prompts / dialogs currently waiting on the user (password, k-i round, host key). */
      let waitingOnUser = 0
      let lastStep: Step | undefined
      let lastPrompted = false
      let lastAutoAnswered = false
      let userAttempts = 0
      /** The server rejected the last answer (typed or stored); told to the next prompt, once. */
      let rejected: 'typed' | 'saved' | undefined
      const takeRetry = (): PromptRetry | undefined => {
        const was = rejected
        rejected = undefined
        if (!was) return undefined
        return { attempt: userAttempts, of: MAX_USER_ATTEMPTS, ...(was === 'saved' ? { saved: true } : {}) }
      }
      let storedUsed = false
      let rounds = 0
      let parsedKey: ParsedKey | undefined
      const stored = storedPassword(hop.auth)
      // 'none' first, like OpenSSH: it tells us which methods the server takes before we spend a
      // stored password on a method the server doesn't offer.
      const queue: Step[] = ['none', ...planFor(hop.auth)]

      const deadline = new Deadline(this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT, () => {
        cause ??= new TransportError('timeout', `${where}: timed out ${lastStep ? 'during authentication' : 'connecting'}`)
        fail(cause)
      })
      const ask = async <T>(fn: () => Promise<T>): Promise<T> => {
        deadline.hold()
        waitingOnUser++
        try {
          return await fn()
        } finally {
          waitingOnUser--
          deadline.release()
        }
      }
      /**
       * The server hung up while the user was still answering: almost always its login grace
       * time (OpenSSH LoginGraceTime, IOS `ip ssh time-out`) running out, not bad credentials.
       */
      const graceExpired = (): TransportError =>
        new TransportError('timeout', `${where}: the server closed the connection while waiting for your answer (login time limit reached?)`)
      const abort = (err: TransportError) => {
        cause ??= err
        try {
          client.end()
        } catch {
          /* ignore */
        }
        // If ssh2 never gets to emit close (e.g. no socket yet), still settle.
        setImmediate(() => fail(cause!))
      }
      const fail = (err: TransportError) => {
        if (settled) return
        settled = true
        if (this.pending === client) this.pending = undefined
        deadline.clear()
        try {
          client.destroy()
        } catch {
          /* ignore */
        }
        reject(err)
      }

      const loadKey = async (auth: Extract<SshAuth, { type: 'key' }>): Promise<ParsedKey> => {
        if (parsedKey) return parsedKey
        let pass = auth.passphrase
        for (let i = 0; i <= MAX_PASSPHRASE_TRIES; i++) {
          const parsed = parsePrivateKey(auth.privateKey, pass)
          if (!(parsed instanceof Error)) {
            const key = Array.isArray(parsed) ? parsed[0] : parsed
            if (!key || !key.isPrivateKey()) throw new TransportError('auth', `${where}: the configured key is not a private key`)
            return (parsedKey = key)
          }
          const encrypted = /encrypt|passphrase|decrypt|integrity|bad key/i.test(parsed.message)
          if (!encrypted) throw new TransportError('auth', `${where}: cannot read private key: ${parsed.message}`, parsed)
          if (i === MAX_PASSPHRASE_TRIES) break
          const label = `${pass === undefined ? 'Passphrase' : 'Wrong passphrase. Try again'} for the private key of ${hop.username}@${hop.host}`
          const answer = await ask(() => prompter.secret({ kind: 'passphrase', label }))
          if (answer === null) throw new TransportError('cancelled', `${where}: passphrase prompt cancelled`)
          pass = answer
        }
        throw new TransportError('auth', `${where}: wrong passphrase for private key`)
      }

      const nextMethod = async (methodsLeft: AuthenticationType[] | null): Promise<AnyAuthMethod | false> => {
        const username = hop.username
        for (;;) {
          const step = queue.shift()
          if (!step) return false
          const wire: AuthenticationType = step === 'agent' ? 'publickey' : step
          if (methodsLeft && !methodsLeft.includes(wire)) continue
          lastPrompted = false
          lastAutoAnswered = false
          switch (step) {
            case 'none':
              lastStep = step
              return { type: 'none', username }
            case 'publickey': {
              if (hop.auth.type !== 'key') continue
              lastStep = step
              const key = await loadKey(hop.auth)
              authStarted = true
              return { type: 'publickey', username, key }
            }
            case 'agent': {
              const socket = (hop.auth.type === 'agent' ? hop.auth.socket : undefined) ?? (await detectAgent())?.path
              if (!socket) {
                this.emit('notice', `${hop.label}: no SSH agent found (set SSH_AUTH_SOCK or pick an agent socket)`)
                continue
              }
              lastStep = step
              authStarted = true
              return { type: 'agent', username, agent: socket }
            }
            case 'password': {
              lastStep = step
              if (stored !== undefined && !storedUsed) {
                storedUsed = true
                authStarted = true
                return { type: 'password', username, password: stored }
              }
              if (userAttempts >= MAX_USER_ATTEMPTS) continue
              const label = `Password for ${username}@${hop.host}`
              userAttempts++
              const retry = takeRetry()
              const pw = await ask(() => prompter.secret({ kind: 'password', label, ...(retry ? { retry } : {}) }))
              if (pw === null) throw new TransportError('cancelled', `${where}: password prompt cancelled`)
              lastPrompted = true
              authStarted = true
              return { type: 'password', username, password: pw }
            }
            case 'keyboard-interactive': {
              if (userAttempts >= MAX_USER_ATTEMPTS && (stored === undefined || storedUsed)) continue
              lastStep = step
              authStarted = true
              return { type: 'keyboard-interactive', username, prompt: kbdPrompt }
            }
          }
        }
      }

      const kbdPrompt = (name: string, instructions: string, _lang: string, prompts: Prompt[], finish: (answers: string[]) => void): void => {
        if (++rounds > MAX_KBD_ROUNDS) return abort(new TransportError('auth', `${where}: too many keyboard-interactive rounds`))
        const only = prompts.length === 1 ? prompts[0] : undefined
        if (stored !== undefined && !storedUsed && only && !only.echo && /password/i.test(only.prompt) && !OTP_LIKE.test(only.prompt)) {
          storedUsed = true
          lastAutoAnswered = true
          return finish([stored])
        }
        // Only the first round of an attempt carries the rejection: a second round (password, then
        // OTP) is not a retry.
        let retry: PromptRetry | undefined
        if (!lastPrompted) {
          if (userAttempts >= MAX_USER_ATTEMPTS) return abort(new TransportError('auth', `${where}: authentication failed`))
          userAttempts++
          lastPrompted = true
          retry = takeRetry()
        }
        // The Prompter contract carries no host, so name the hop for the UI before asking.
        this.emit('notice', `${where}: login prompt (keyboard-interactive)`)
        const round = { name, instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true })), ...(retry ? { retry } : {}) }
        ask(() => prompter.keyboardInteractive(round)).then(
          (answers) => {
            if (settled) return
            if (answers === null) return abort(new TransportError('cancelled', `${where}: login prompt cancelled`))
            finish(prompts.map((_, i) => answers[i] ?? ''))
          },
          (err: unknown) => abort(new TransportError('cancelled', `${where}: login prompt failed: ${(err as Error)?.message ?? err}`, err))
        )
      }

      const authHandler = (methodsLeft: AuthenticationType[] | null, partial: boolean | null, next: (m: AnyAuthMethod | false) => void): void => {
        if (lastStep !== undefined && lastStep !== 'none' && !partial) {
          // Retry an interactive method the user answered (typo), or k-i after a stored password failed.
          if (lastPrompted) rejected = 'typed'
          else if (lastAutoAnswered || (lastStep === 'password' && storedUsed)) rejected = 'saved'
          if (lastStep === 'keyboard-interactive' && (lastPrompted || lastAutoAnswered)) queue.unshift('keyboard-interactive')
          if (lastStep === 'password' && lastPrompted) queue.unshift('password')
        }
        nextMethod(methodsLeft).then(
          (m) => {
            if (!settled) next(m)
          },
          (err: unknown) => {
            if (settled) return
            cause ??= err instanceof TransportError ? err : new TransportError('auth', `${where}: ${(err as Error)?.message ?? err}`, err)
            next(false)
          }
        )
      }

      const describe = (step: Step | undefined): string => {
        if (step === 'agent') return 'publickey (agent)'
        if (step === 'publickey') return 'publickey'
        if (step === 'keyboard-interactive') return lastAutoAnswered && !lastPrompted ? 'keyboard-interactive (stored password)' : 'keyboard-interactive'
        return step ?? 'none'
      }

      client.on('connect', () => { if (hop.target) this.emit('stage', 'TCP open') })
      client.on('handshake', (n) => {
        if (hop.target) this.emit('stage', 'SSH handshake')
        if (hop.target) this.ident = remoteIdent(client)
        for (const alg of legacyNegotiated(n)) this.emit('notice', `${hop.target ? '' : hop.label + ': '}legacy algorithm ${alg} negotiated`)
      })
      client.on('banner', (msg: string) => {
        if (hop.target) this.banner += msg
      })
      client.on('ready', () => {
        if (settled) return
        settled = true
        ready = true
        // Interactive traffic: no Nagle delay on keystrokes and echoes (ssh2 leaves Nagle on; OpenSSH
        // sets TCP_NODELAY for interactive sessions). Measured: key → echo 60 ms → 26 ms (bench/).
        client.setNoDelay(true)
        if (this.pending === client) this.pending = undefined
        deadline.clear()
        this.emit('notice', `${hop.target ? '' : hop.label + ': '}authenticated with ${describe(lastStep)}`)
        resolve(client)
      })
      client.on('error', (e: SshError) => {
        if (ready) {
          this.linkError = mapSshError(e, hop.label).message.replace(/^[^:]*: /, '')
          return
        }
        if (settled) return
        // Non-fatal: ssh2 reports agent failures and per-key signing errors, then tries the next method.
        if (e.level === 'agent') return void this.emit('notice', `${hop.label}: agent: ${e.message}`)
        if (e.level === 'client-authentication' && !/All configured authentication methods failed/.test(e.message)) {
          return void this.emit('notice', `${hop.label}: ${e.message}`)
        }
        fail(cause ?? (waitingOnUser > 0 ? graceExpired() : mapSshError(e, where, authStarted)))
      })
      client.on('close', () => {
        if (ready) return this.linkDown(hop)
        if (settled) return
        if (cause) return fail(cause)
        if (this.userEnded) return fail(new TransportError('cancelled', 'connection cancelled'))
        if (waitingOnUser > 0) return fail(graceExpired())
        if (authStarted) return fail(new TransportError('auth', `${where}: server closed the connection during authentication`))
        fail(new TransportError('other', `${where}: connection closed during handshake`))
      })

      const legacy = this.opts.legacyAlgorithms !== false
      const support = legacy ? legacySupport() : undefined
      const cfg: ConnectConfig = {
        host: hop.host,
        port: hop.port,
        username: hop.username,
        readyTimeout: 0, // ours (Deadline) pauses while the user answers prompts
        keepaliveInterval: this.opts.keepAliveSec > 0 ? this.opts.keepAliveSec * 1000 : 0,
        keepaliveCountMax: 3,
        authHandler: authHandler as ConnectConfig['authHandler'],
        hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
          const algorithm = readSshString(key)
          const fingerprint = sshFingerprint(key)
          ask(async () => hop.verify({ host: hop.host, port: hop.port, algorithm, fingerprint })).then(
            (verdict) => {
              if (verdict === 'accept') return verify(true)
              cause ??= new TransportError('host-key', `${where}: host key rejected (${algorithm} ${fingerprint})`)
              verify(false)
            },
            (err: unknown) => {
              cause ??= new TransportError('host-key', `${where}: host key check failed: ${(err as Error)?.message ?? err}`, err)
              verify(false)
            }
          )
        }) as ConnectConfig['hostVerifier']
      }
      if (sock) cfg.sock = sock
      if (support) cfg.algorithms = legacyAlgorithms(support)
      if (hop.target && this.agentForSession) cfg.agent = this.agentForSession
      try {
        client.connect(cfg)
      } catch (e) {
        return fail(new TransportError('other', `${where}: ${(e as Error).message}`, e))
      }
      if (support?.group1 && !hookGroup1(client)) {
        this.emit('notice', `${hop.label}: legacy group1 key exchange unavailable in this runtime`)
      }
    })
  }

  private openShell(): Promise<void> {
    const client = this.clients[this.clients.length - 1]!
    const target = this.hops[this.hops.length - 1]!
    const pty = { term: this.opts.term ?? 'xterm-256color', cols: this.size.cols, rows: this.size.rows, width: 0, height: 0 }
    const open = (agentForward: boolean) =>
      new Promise<ClientChannel>((resolve, reject) => {
        const cb = (err: Error | undefined, s: ClientChannel) => (err ? reject(err) : resolve(s))
        if (agentForward) client.shell(pty, { agentForward: true } as ShellOptions, cb)
        else client.shell(pty, cb)
      })
    const wantFwd = this.opts.agentForward === true
    if (wantFwd && !this.agentForSession) this.emit('notice', 'agent forwarding requested, but no SSH agent was found')
    return (async () => {
      let stream: ClientChannel
      try {
        stream = await open(wantFwd && !!this.agentForSession)
        if (wantFwd && this.agentForSession) this.emit('notice', 'agent forwarding enabled')
      } catch (e) {
        if (!(wantFwd && /agent forwarding/i.test((e as Error).message))) throw e
        this.emit('notice', 'server refused agent forwarding')
        stream = await open(false)
      }
      this.stream = stream
      // A resize() while the shell request was in flight didn't reach the pty request.
      if (this.size.cols !== pty.cols || this.size.rows !== pty.rows) stream.setWindow(this.size.rows, this.size.cols, 0, 0)
      // 'data' listeners are attached later by startData(); until then the channel buffers.
      stream.on('exit', () => (this.remoteExited = true))
      stream.on('close', () => this.linkDown(target, 'remote closed the session'))
    })().catch((e: unknown) => {
      throw e instanceof TransportError ? e : new TransportError('other', `${target.label}: could not open a shell: ${(e as Error)?.message ?? e}`, e)
    })
  }
}

/** A channel the server would not open (`channel`), or a subsystem / command it refused. */
export class ChannelError extends Error {
  constructor(
    readonly kind: 'channel' | 'subsystem',
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

function channelError(e: Error, what: 'sftp' | 'exec'): ChannelError {
  const msg = e?.message ?? String(e)
  // ssh2: "(SSH) Channel open failure: ..." when the channel itself is refused (limit, policy);
  // "Unable to start subsystem: sftp" / "Unable to exec" when the channel opened but the request failed.
  if (/channel open failure|no channels available|not connected/i.test(msg)) return new ChannelError('channel', msg, e)
  return new ChannelError('subsystem', what === 'sftp' ? 'The server has no SFTP subsystem' : `The server refused the command (${msg})`, e)
}

interface ProtoInternals {
  _packetRW: { write: { allocStart: number; alloc(n: number): Buffer; finalize(p: Buffer): Buffer } }
}

/**
 * ssh2 has no API for RFC 4335 "break", so build the CHANNEL_REQUEST the way ssh2's own
 * `signal()` does. want_reply is false: a reply would desync ssh2's per-channel callback queue.
 */
function sendBreakRequest(client: Client, stream: ClientChannel, ms: number): void {
  const proto = (client as unknown as { _protocol?: ProtoInternals })._protocol
  const chan = (stream as unknown as { outgoing?: { id?: number; state?: string } }).outgoing
  if (!proto || chan?.id === undefined || chan.state !== 'open') throw new TransportError('other', 'channel is not open')
  const w = proto._packetRW.write
  let p = w.allocStart
  const packet = w.alloc(1 + 4 + 4 + 5 + 1 + 4)
  packet[p] = 98 // SSH_MSG_CHANNEL_REQUEST
  packet.writeUInt32BE(chan.id, ++p)
  packet.writeUInt32BE(5, (p += 4))
  packet.write('break', (p += 4), 'latin1')
  packet[(p += 5)] = 0 // want_reply
  packet.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(ms))), ++p)
  protocolUtils.sendPacket(proto, w.finalize(packet))
}

/** ssh2 keeps the raw identification line only on its protocol object; fall back to the software version. */
function remoteIdent(client: Client): string | undefined {
  const c = client as unknown as { _protocol?: { _remoteIdentRaw?: Buffer }; _remoteVer?: string }
  const raw = c._protocol?._remoteIdentRaw?.toString('latin1').trim()
  if (raw) return raw.slice(0, 255)
  return c._remoteVer ? `SSH-2.0-${c._remoteVer}`.slice(0, 255) : undefined
}
