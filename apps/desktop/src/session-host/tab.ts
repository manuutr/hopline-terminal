import type { Transport } from '@hopline/transports'
import { Forwards, SshTransport, TransportError } from '@hopline/transports'
import { StringDecoder } from 'node:string_decoder'
import { startsOnConnect, type ForwardSpec, type ForwardStatus } from '@shared/files'
import type { HostToMain, OpenSpec, PortToHost, PortToRenderer } from '@shared/host-protocol'
import type { ConnState, SessionVitals, TabInfo } from '@shared/types'
import { cleanTerminalText, promptState } from '@shared/cli'
import type { ExecTarget } from './executor'
import { TabFiles } from './files'
import { SessionLogger } from './logger'

const TAIL_CHARS = 16 * 1024
const FIRST_OUTPUT_CHARS = 4096
const BACKOFF = [2, 4, 8, 15, 30, 30, 30, 60, 60, 60]
/** Flow control: pause the device when the renderer is this far behind, resume below LOW. */
const HIGH = 512 * 1024
const LOW = 128 * 1024
/** Output queued while no renderer port is attached (before attach, or while a window reloads). */
const MAX_QUEUE = 2 * 1024 * 1024
/** Largest single output message to the renderer. */
const MAX_MSG = 32 * 1024
/** Output is coalesced into batches this long; the first chunk after a quiet spell goes at once. */
const BATCH_MS = 8
/** A notice waits this long after the device's last output before it is written mid-line. */
const NOTICE_QUIET_MS = 150
/** An error's message without serialport's own "Error: " prefix. */
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/, '')
const DIM = (s: string) => `\r\n\x1b[2m[hopline] ${s}\x1b[0m\r\n`

/** Port-like object (Electron's MessagePortMain in the host, a fake in tests). */
export interface TabPort {
  postMessage(msg: PortToRenderer): void
  on(event: 'message', fn: (e: { data: PortToHost }) => void): void
  start(): void
  close(): void
}

export interface TabHooks {
  state(info: TabInfo): void
  makeTransport(spec: OpenSpec, password: string | undefined, notice: (text: string) => void): Transport
  /** Messages for main from this tab's file transfers and forwards (absent in tests that don't need them). */
  post?(m: HostToMain): void
}

/**
 * One terminal tab inside the session host: a transport, its output stream, logging,
 * reconnects, flow control, and the input lock used by the agent executor.
 */
export class HostTab implements ExecTarget {
  state: ConnState = 'connecting'
  detail?: string
  tail = ''
  lock: ExecTarget['lock'] = null
  private transport: Transport | null = null
  private logger: SessionLogger | null = null
  private decoder = new StringDecoder('utf8')
  private taps = new Set<(t: string) => void>()
  private port: TabPort | null = null
  private queue: string[] = []
  private queued = 0
  private batch = ''
  private flushTimer: NodeJS.Timeout | null = null
  private lastFlush = 0
  private unacked = 0
  private paused = false
  private retry = 0
  private retryTimer: NodeJS.Timeout | null = null
  private disposed = false
  private logFailed = false
  private lastUserInput = 0
  private lastOutput = 0
  /** The first output after connecting (login banner, MOTD, first prompt), for auto-detect. */
  private firstOutput = ''
  private cols: number
  private rows: number
  /** SFTP/SCP on this tab's connection (SSH only). */
  readonly files: TabFiles | null
  /** Port forwards: they outlive reconnects (listeners stay bound, remote ones are re-requested). */
  readonly forwards: Forwards | null
  /** Saved forwards that start on connect were started (only once: later connects re-attach). */
  private savedStarted = false
  /** Forward notices held while the agent owns the terminal (they would land in its command output). */
  private heldNotices: string[] = []
  /**
   * Does the device echo typed characters (review E3, no-echo fallback)? Learned from the user's own
   * keystrokes at a prompt, Telnet echo negotiation and the executor's own echo checks; undefined
   * until known.
   */
  private echo: boolean | undefined
  private echoMisses = 0
  private echoProbe: { started: number; text: string; timer: NodeJS.Timeout } | null = null
  /** Text Hopline typed and could not confirm erased (the line may hold it), until the user clears the line. */
  private unsentText: string | null = null

  constructor(
    readonly spec: OpenSpec,
    private readonly hooks: TabHooks
  ) {
    this.cols = spec.cols
    this.rows = spec.rows
    const ssh = spec.session.protocol === 'ssh'
    const post = (m: HostToMain) => hooks.post?.(m)
    this.files = ssh ? new TabFiles({ ssh: () => this.ssh() }, post) : null
    // A background connection has no window and nobody to see a listener: no forwards at all.
    this.forwards = ssh && !spec.background ? new Forwards() : null
    this.forwards?.on('change', (list: ForwardStatus[]) => post({ t: 'fwd-state', tabId: this.tabId, forwards: list }))
    this.forwards?.on('notice', (text: string) => this.notice(text))
  }

  /** The live SSH connection, for files and forwards. */
  ssh(): SshTransport | null {
    return this.transport instanceof SshTransport && this.state === 'connected' ? this.transport : null
  }

  /**
   * A status line for the terminal. Held while the agent runs a command (it would land in the
   * command's output) and while the device is mid-line and still sending (it would split that
   * line); written once the line is quiet, or after 3 s regardless.
   */
  private notice(text: string): void {
    const ready = () => !this.lock && (!this.line || Date.now() - this.lastData >= NOTICE_QUIET_MS)
    if (ready() && !this.heldNotices.length) return this.output(this.above(text))
    this.heldNotices.push(text)
    if (this.heldNotices.length > 1) return
    const since = Date.now()
    const flush = () => {
      if (this.disposed) return void this.heldNotices.splice(0)
      if (this.lock || (!ready() && Date.now() - since < 3000)) return void setTimeout(flush, NOTICE_QUIET_MS)
      for (const n of this.heldNotices.splice(0)) this.output(this.above(n))
    }
    setTimeout(flush, NOTICE_QUIET_MS)
  }

  /** When the device last sent output. */
  private lastData = 0
  private vitals: SessionVitals = { steps: [] }
  private sampleTimer?: NodeJS.Timeout

  private publishVitals(): void {
    clearTimeout(this.sampleTimer)
    this.sampleTimer = undefined
    this.port?.postMessage({ t: 'vitals', sample: { ...this.vitals } })
  }

  private activity(direction: 'rxAt' | 'txAt'): void {
    this.vitals[direction] = Date.now()
    if (this.port && !this.sampleTimer) this.sampleTimer = setTimeout(() => this.publishVitals(), 250)
  }

  /**
   * A status line written above the device's current line: when the cursor sits on a prompt
   * ("router#"), the notice goes on its own line and the prompt is drawn again after it, so the
   * user keeps typing where they were.
   */
  private above(text: string): string {
    if (!this.line) return DIM(text)
    return `\r\x1b[2K\x1b[2m[hopline] ${text}\x1b[0m\r\n${this.line}`
  }

  /** The device output after its last line break (a prompt, a half-typed command), capped. */
  private line = ''

  /**
   * Forwards saved on the session that start on connect. Decision: only a listener bound to a
   * loopback literal or `localhost` starts by itself. Any other bind (a wildcard in any spelling:
   * `0.0.0.0`, `0`, `0x0`, `::0`, `*`, empty; a LAN address; a name) exposes a port to the
   * network, so it is started by hand, wherever the session came from (an imported or synced file
   * included). A background connection starts none.
   */
  savedForwards(): ForwardSpec[] {
    if (this.spec.background) return []
    return (this.spec.session.options.ssh?.forwards ?? []).filter(startsOnConnect)
  }

  get tabId(): string {
    return this.spec.tabId
  }

  get connected(): boolean {
    return !!this.transport && this.state === 'connected'
  }

  info(): TabInfo {
    return { tabId: this.tabId, sessionId: this.spec.session.id, state: this.state, detail: this.detail, logPath: this.logger?.path }
  }

  /** `dropped`: the connection ended on its own (not closed or logged out by the user): main may notify. */
  private setState(state: ConnState, detail?: string, dropped = false): void {
    this.state = state
    if (state !== 'connected') {
      delete this.vitals.connectedAt
      delete this.vitals.echoRtt
      delete this.vitals.sampledAt
    }
    if (state !== 'reconnecting') delete this.vitals.retryAt
    this.publishVitals()
    this.detail = detail
    this.hooks.state(dropped ? { ...this.info(), dropped: true } : this.info())
  }

  // ------------------------------------------------------------------ renderer port

  attach(port: TabPort): void {
    this.port?.close()
    this.port = port
    // A fresh renderer has acked nothing; start the window over.
    this.unacked = 0
    port.on('message', (e) => this.onPort(e?.data))
    port.start()
    this.publishVitals()
    for (const chunk of this.queue) this.post(chunk)
    this.queue = []
    this.queued = 0
    this.updateFlow()
    if (this.state === 'connected') this.postLines()
  }

  /** Serial tabs: tell the window the modem lines (status bar). Other transports have none. */
  private postLines(extra: { brk?: boolean; error?: string } = {}): void {
    const lines = (this.transport as { lines?: { dtr: boolean; rts: boolean; brk: boolean } } | null)?.lines
    if (!lines || !this.port) return
    this.port.postMessage({ t: 'sig', ...lines, ...extra })
  }

  private onPort(m: PortToHost): void {
    if (!m || typeof m !== 'object') return
    if (m.t === 'w' && typeof m.d === 'string' && m.d.length <= 1_000_000) this.userInput(m.d)
    else if (m.t === 'r' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 10 && m.cols <= 1000 && m.rows >= 2 && m.rows <= 500)
      this.resize(m.cols, m.rows)
    // BREAK and modem signals are input too: never while the agent holds the session.
    else if ((m.t === 'b' || m.t === 'sig') && this.lock) this.postLines({ error: 'The assistant is using this session' })
    else if (m.t === 'b') {
      const brk = this.transport?.sendBreak?.(this.spec.session.options?.serial?.breakMs)
      if (!brk) return
      this.postLines({ brk: true })
      void brk.then(
        () => this.postLines(),
        (e) => this.postLines({ error: `Break not sent: ${reason(e)}` })
      )
    } else if (m.t === 'sig')
      void this.transport
        ?.setSignals?.({ dtr: m.dtr === undefined ? undefined : !!m.dtr, rts: m.rts === undefined ? undefined : !!m.rts })
        .then(
          () => this.postLines(),
          (e) => this.postLines({ error: `The port refused the change: ${reason(e)}` })
        )
    else if (m.t === 'a' && Number.isFinite(m.n) && m.n > 0) {
      this.unacked = Math.max(0, this.unacked - m.n)
      this.updateFlow()
    }
  }

  private post(chunk: string): void {
    this.unacked += chunk.length
    this.port!.postMessage({ t: 'd', d: chunk })
  }

  private updateFlow(): void {
    if (!this.paused && this.unacked > HIGH) {
      this.paused = true
      this.transport?.pause()
    } else if (this.paused && this.unacked < LOW) {
      this.paused = false
      this.transport?.resume()
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Opened without connecting: show why, and let Enter connect. */
  idle(reason: string): void {
    this.output(DIM(`${reason}. Press Enter to reconnect.`))
    this.setState('down', reason)
  }

  async connect(password = this.spec.auth.password): Promise<void> {
    if (this.disposed) return
    const protocol = this.spec.session.protocol
    this.vitals = { steps: [protocol === 'serial' ? 'Opening port' : 'Connecting to ' + this.spec.session.host] }
    this.setState(this.retry ? 'reconnecting' : 'connecting')
    const s = this.spec.session
    if (s.logToFile && !this.logger && !this.logFailed) {
      try {
        this.logger = new SessionLogger(this.spec.settings.log, { session: s.name, host: s.host, port: s.port, user: this.spec.auth.username }, undefined, (e) => {
          this.logger = null
          this.logFailed = true
          this.output(DIM(`Logging stopped: ${e.message}`))
        })
      } catch (e) {
        // A bad log folder must not block the session: connect without logging and say why.
        this.logFailed = true
        this.output(DIM(`Logging is off for this tab: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    let t: Transport
    try {
      t = this.hooks.makeTransport(this.spec, password, (text) => this.output(DIM(text)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.output(DIM(`Cannot connect: ${msg}`))
      this.setState('down', msg)
      throw e
    }
    this.transport = t
    // A new connection: what was learned about the old one's echo and line no longer holds.
    this.echo = undefined
    this.echoMisses = 0
    this.unsentText = null
    if (this.echoProbe) clearTimeout(this.echoProbe.timer)
    this.echoProbe = null
    // Transport status lines ("via jump1", "authenticated with publickey", legacy algorithms…).
    // Once the session is live they would land in the middle of the device's output (e.g. after a
    // "Username:" prompt), so later ones only go to the log, unless the user must act on them.
    let live = false
    t.on('stage', (stage: string) => {
      if (this.transport !== t || this.disposed || live || this.vitals.steps.includes(stage)) return
      this.vitals.steps.push(stage)
      this.publishVitals()
    })
    t.on('notice', (text: string) => {
      // Telnet echo negotiation (WONT ECHO / WILL ECHO).
      if (/server (?:does not echo|stopped echoing)/i.test(text)) this.echo = false
      else if (/server echoes/i.test(text)) this.echo = true
      if (!live || /local echo|refused|forward/i.test(text)) this.output(DIM(text))
      else this.logger?.note(text)
    })
    try {
      await t.connect()
    } catch (e) {
      // A newer attempt (reconnect) or dispose replaced this one: its failure is not ours to report.
      if (this.transport !== t) return
      this.transport = null
      const msg = e instanceof Error ? e.message : String(e)
      const permanent = e instanceof TransportError ? e.permanent : /authentication/i.test(msg)
      this.output(DIM(`Connection failed: ${msg}`))
      // Don't hammer a device with bad credentials or a changed host key.
      if (!permanent && this.retry > 0) return this.scheduleReconnect(msg)
      this.setState('down', msg)
      throw e
    }
    if (this.transport !== t || this.disposed) {
      // Superseded while connecting (reconnect, close): drop this connection.
      t.end()
      return
    }
    live = true
    this.firstOutput = ''
    this.retry = 0
    this.paused = false
    this.vitals.connectedAt = Date.now()
    this.vitals.steps.push(protocol === 'ssh' ? 'Authenticated as ' + this.spec.auth.username : protocol === 'serial' ? 'Port open' : 'Connected')
    this.setState('connected')
    this.logger?.note('connected')
    this.postLines()
    this.files?.reset()
    if (this.forwards && t instanceof SshTransport) {
      void this.forwards.attach(t).then(async () => {
        if (this.savedStarted || this.disposed) return
        this.savedStarted = true
        for (const f of this.savedForwards()) await this.forwards!.start(f)
      })
    }
    this.line = ''
    t.on('data', (buf: Buffer) => {
      const text = this.decoder.write(buf)
      this.lastData = Date.now()
      this.activity('rxAt')
      const nl = text.lastIndexOf('\n')
      this.line = (nl >= 0 ? text.slice(nl + 1) : this.line + text).slice(-400)
      this.seeEcho(text)
      this.output(text)
    })
    t.on('close', (reason?: string) => {
      if (this.transport !== t) return
      this.transport = null
      this.forwards?.detach()
      this.files?.reset()
      this.lock?.onInterrupt()
      if (this.disposed) return
      this.logger?.note(`disconnected: ${reason ?? 'closed'}`)
      const { text, deliberate } = closeKind(reason, Date.now() - this.lastUserInput)
      if (text && !deliberate && this.spec.settings.autoReconnect) this.scheduleReconnect(text, true)
      else {
        this.output(DIM(`Session closed${text ? `: ${text}` : ''}. Press Enter to reconnect.`))
        this.setState('down', text || 'closed', !!text && !deliberate)
      }
    })
    this.updateFlow()
  }

  private scheduleReconnect(reason: string, dropped = false): void {
    if (this.disposed) return
    if (this.retry >= BACKOFF.length) {
      this.output(DIM(`Giving up after ${BACKOFF.length} attempts. Press Enter to reconnect.`))
      this.setState('down', reason)
      return
    }
    const wait = BACKOFF[this.retry++]!
    this.output(DIM(`${reason}. Reconnecting in ${wait}s… (Ctrl-C to cancel)`))
    this.vitals.retryAt = Date.now() + wait * 1000
    this.setState('reconnecting', `${reason}; retry in ${wait}s`, dropped)
    this.retryTimer = setTimeout(() => void this.connect().catch(() => {}), wait * 1000)
  }

  async reconnect(password?: string): Promise<void> {
    if (password) this.spec.auth.password = password
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const old = this.transport
    this.transport = null
    old?.end()
    this.retry = 0
    await this.connect()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.sampleTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.lock?.onInterrupt()
    this.files?.dispose()
    void this.forwards?.dispose()
    this.transport?.end()
    this.logger?.close()
    this.taps.clear()
    if (this.echoProbe) clearTimeout(this.echoProbe.timer)
    this.port?.close()
    this.spec.auth.password = undefined
    this.spec.auth.passphrase = undefined
    this.spec.auth.privateKey = undefined
  }

  // ------------------------------------------------------------------ data

  /** Device output (or our own status lines) → log, taps, tail, renderer. */
  private output(text: string): void {
    if (!text || this.disposed) return
    this.logger?.write(text)
    this.tail = (this.tail + text).slice(-TAIL_CHARS)
    this.lastOutput = Date.now()
    if (this.firstOutput.length < FIRST_OUTPUT_CHARS) this.firstOutput = (this.firstOutput + text).slice(0, FIRST_OUTPUT_CHARS)
    for (const tap of this.taps) tap(text)
    this.batch += text
    // Coalesce bursts into ~8 ms batches to keep message overhead low. After a quiet spell (an echo,
    // a prompt) the batch goes on the next turn of the event loop instead: waiting 8 ms there only
    // adds latency to every keystroke (bench: key → echo).
    if (this.flushTimer) return
    const quiet = performance.now() - this.lastFlush >= BATCH_MS
    this.flushTimer = setTimeout(() => this.flush(), quiet ? 0 : BATCH_MS)
  }

  private flush(): void {
    this.flushTimer = null
    this.lastFlush = performance.now()
    const chunk = this.batch
    this.batch = ''
    if (!chunk) return
    if (this.port) {
      // Small messages let the renderer interleave input and paint between them during a flood.
      for (let i = 0; i < chunk.length; i += MAX_MSG) this.post(chunk.slice(i, i + MAX_MSG))
      this.updateFlow()
    } else {
      this.queue.push(chunk)
      this.queued += chunk.length
      // Nobody is watching: keep the newest output only.
      while (this.queued > MAX_QUEUE && this.queue.length > 1) this.queued -= this.queue.shift()!.length
    }
  }

  /**
   * What auto-detect may look at, all passively observed: the SSH server identification, the
   * first output after login and the current tail, plus how long the line has been quiet and how
   * long since the user typed.
   */
  observed(): { sshServerVersion?: string; banner: string; tail: string; quietMs: number; idleMs: number } {
    const now = Date.now()
    const ident = (this.transport as { serverIdent?: string } | null)?.serverIdent
    return { sshServerVersion: ident, banner: this.firstOutput, tail: this.tail, quietMs: now - this.lastOutput, idleMs: now - this.lastUserInput }
  }

  addTap(fn: (t: string) => void): () => void {
    this.taps.add(fn)
    return () => this.taps.delete(fn)
  }

  // ------------------------------------------------------------------ echo and unsent text (executor)

  width(): number {
    return this.cols
  }

  echoes(): boolean | undefined {
    return this.echo
  }

  /** The executor's own observation: one echo is proof; "nothing at all" counts as one miss (two make it non-echoing). */
  noteEcho(echoes: boolean): void {
    if (echoes) {
      this.echo = true
      this.echoMisses = 0
    } else if (++this.echoMisses >= 2) this.echo = false
  }

  unsent(): string | null {
    return this.unsentText
  }

  markUnsent(text: string): void {
    this.unsentText = text
    this.notice(
      `The device's input line may still hold "${text.slice(0, 60)}", typed by Hopline Terminal but not sent (Enter was not pressed). Clear it with Ctrl-U or Ctrl-C before pressing Enter; Hopline Terminal types nothing on this session until you do.`
    )
  }

  /** Learn whether the device echoes: a few printable keys typed at a bare prompt must come back. */
  private watchEcho(data: string): void {
    // Letters and digits only: `?` and the like make some CLIs print help instead of an echo.
    if (this.echoProbe || data.length > 8 || !/^[A-Za-z0-9]+$/.test(data)) return
    if (promptState(this.line, 'auto').mode === 'unknown') return
    const timer = setTimeout(() => {
      this.echoProbe = null
      if (++this.echoMisses >= 2) this.echo = false
    }, 1500)
    this.echoProbe = { text: data, timer, started: performance.now() }
  }

  private seeEcho(text: string): void {
    const p = this.echoProbe
    if (!p || !cleanTerminalText(text).includes(p.text)) return
    if (text.startsWith(p.text)) {
      this.vitals.echoRtt = Math.max(1, Math.round(performance.now() - p.started))
      this.vitals.sampledAt = Date.now()
    }
    clearTimeout(p.timer)
    this.echoProbe = null
    this.echo = true
    this.echoMisses = 0
  }

  /** Write on behalf of the agent (bypasses the user lock). Callers must have verified a verdict. */
  send(data: string): void {
    if (this.connected) this.activity('txAt')
    this.transport?.write(data)
  }

  /** Keystrokes from the user. */
  userInput(data: string): void {
    this.lastUserInput = Date.now()
    if (this.lock) {
      if (data.includes('\x03')) this.lock.onInterrupt()
      return
    }
    if (this.transport && this.state !== 'connected') {
      // Mid-attempt (e.g. 20 s to an unreachable host): Ctrl-C abandons it and stops retrying.
      if (data.includes('\x03')) {
        const t = this.transport
        this.transport = null
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = null
        this.retry = 0
        t.end()
        this.output(DIM('Connection attempt cancelled. Press Enter to reconnect.'))
        this.setState('down', 'cancelled')
      }
      return
    }
    if (!this.transport) {
      if (this.retryTimer && data.includes('\x03')) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
        this.output(DIM('Reconnect cancelled. Press Enter to reconnect.'))
        this.setState('down', 'reconnect cancelled')
      } else if ((this.state === 'down' || this.state === 'idle') && /[\r\n]/.test(data)) {
        this.retry = 0
        void this.connect().catch(() => {})
      }
      return
    }
    // The user clears the line (or runs it): the unsent-text flag goes.
    if (this.unsentText !== null && /[\x03\x15\r\n]/.test(data)) this.unsentText = null
    this.activity('txAt')
    this.watchEcho(data)
    this.transport.write(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.spec.cols = cols
    this.spec.rows = rows
    this.transport?.resize({ cols, rows })
  }

  size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }
}

/**
 * Transports prefix close reasons: "logout:" means the device ended the session on request
 * (`exit`), "remote-closed:" means a clean close that may or may not be deliberate (Telnet). A
 * remote close right after the user typed is treated as deliberate, so `exit` doesn't log back in.
 */
export function closeKind(reason: string | undefined, msSinceInput: number): { text: string; deliberate: boolean } {
  if (!reason) return { text: '', deliberate: true }
  const m = /^(logout|remote-closed):\s*/.exec(reason)
  const text = m ? reason.slice(m[0].length) : reason
  if (m?.[1] === 'logout') return { text, deliberate: true }
  if (m?.[1] === 'remote-closed') return { text, deliberate: msSinceInput < 10_000 }
  return { text, deliberate: false }
}
