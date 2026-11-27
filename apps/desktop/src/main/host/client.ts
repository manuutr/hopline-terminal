import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { join } from 'node:path'
import type { PlatformId } from '@hopline/cli-model'
import type { AuthSpec, ExecResultMsg, HostToMain, MainToHost, ObservedEvidence, OpenSpec, PromptInfo, PromptMode } from '@shared/host-protocol'
import type { SerialPortInfo, Session, TabInfo } from '@shared/types'
import { newKey, sign } from '@shared/verdict'
import { policyBlocked } from '@shared/policy-deny'
import type { Repo, ResolvedCredential } from '../db/repo'
import { EphemeralSessions } from '../ephemeral'
import { isLocked } from '../vault/datakey'
import { retryMeta, type PromptBroker } from '../prompts'
import type { SettingsService } from '../settings'
import { effectiveLogToFile, effectiveSettings, type HostOverrides } from '@shared/ux'

/** What the agent needs from tabs. Implemented here over the session host, and directly in tests. */
export interface AgentTab {
  tabId: string
  session: Session
}
export interface ExecOpts {
  timeoutMs: number
  capBytes: number
  allowConfig?: boolean
  signal?: AbortSignal
  /** Disruptive commands: the hostname the user typed to confirm (bound into the verdict). */
  ack?: string
  /** Config and disruptive commands: the device hostnames the approval was given for (bound into the verdict). */
  hosts?: string[]
  /**
   * An app-owned safety-net line (agent/safety-net.ts only): signed as `net`, so the session host
   * checks it against the platform's fixed net templates instead of the deny-list. Config kind only.
   */
  net?: boolean
}
export type ExecKind = 'read' | 'config' | 'disruptive'
export interface TabControl {
  get(tabId: string): AgentTab | undefined
  /** Callers must have classified `command` with the guard: the kind is bound into a signed verdict. */
  exec(tab: AgentTab, command: string, kind: ExecKind, opts: ExecOpts): Promise<ExecResultMsg>
  mode(tab: AgentTab): Promise<PromptMode>
  /** The device prompt now (mode, text, hostname), for commit-when checks and disruptive confirmations. */
  prompt(tab: AgentTab): Promise<PromptInfo>
  /** The team policy's extra blocked commands (exec refuses them too; callers use this to show the refusal early). */
  readonly policyRules?: Readonly<Record<string, readonly string[]>>
}

interface OpenTab {
  tabId: string
  session: Session
  cols: number
  rows: number
  /** Typed by the user for this tab only; kept in main memory for reconnects after a host restart. */
  password?: string
  /** The window that shows the tab; null for a background connection (multi-device runs). */
  wc: WebContents | null
  generation: number
}

/** Background connections: how long connecting and reaching an idle prompt may take. */
const BACKGROUND_CONNECT_MS = 30_000
let bgSeq = 0

/**
 * The session host's environment: main's, minus the cloud provider credentials. The host parses
 * untrusted network input and never talks to a model, so it has no use for an API key or a base URL.
 * Everything else (SSH_AUTH_SOCK for the agent, HOPLINE_* test switches, PATH) is kept: `env`
 * replaces the child's environment rather than adding to it.
 */
export function hostEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(?:ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API_KEY$)/i.test(k)) out[k] = v
  return out
}

/**
 * Supervises the session host process and brokers everything that crosses into it:
 * credentials (resolved here from the vault), host-key decisions, renderer ports and agent commands.
 */
export class SessionHostClient implements TabControl {
  private proc: UtilityProcess | null = null
  private key = newKey()
  /** The team policy's extra blocked commands (docs/POLICY.md): refused here before signing, and sent to the host to check again. */
  policyRules: Record<string, string[]> = {}
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private tabs = new Map<string, OpenTab>()
  private generation = 0
  private ready: Promise<void> = Promise.resolve()
  private quitting = false
  private crashes: number[] = []
  /** Background tabs waiting for their first state ('connected' or 'down'). */
  private bgWaiters = new Map<string, (info: TabInfo) => void>()
  /** Called when a tab whose session is still Auto-detect reaches the device (see detect.ts). */
  onAutoConnected: ((tab: AgentTab) => void) | null = null
  /** Host messages for file transfers and forwards (main/files). */
  private extra = new Set<(m: HostToMain) => void>()
  /** Called after a tab was opened again in a restarted host (forwards added live are restored). */
  onReopened: ((tabId: string) => void) | null = null
  /** Called when a tab is closed (forwards added live on it are forgotten). */
  onClosed: ((tabId: string) => void) | null = null
  /** Called whenever a tab reaches the device (scheduled backups waiting for this session). */
  onConnected: ((tab: AgentTab) => void) | null = null
  /** A tab the user has open lost its connection on its own (desktop notification). */
  onDropped: ((tab: AgentTab, info: TabInfo) => void) | null = null
  /**
   * A background connection (multi-device run, backup, fleet, or a jump hop of one) trusted a host
   * key it had never seen, with nobody asked (OpenSSH accept-new). index.ts writes an audit row so
   * the trust decision is on record (P8 D-L4).
   */
  onBackgroundHostKey: ((tab: AgentTab | null, key: { host: string; port: number; fingerprint: string }) => void) | null = null
  /** Per-host overrides for a session (shared/ux.ts); none when unset. */
  overridesFor: (s: Session) => HostOverrides = () => ({})
  /** Quick-connect sessions: known here (and only here) until saved or their last tab closes. */
  readonly ephemeral = new EphemeralSessions((id) => [...this.tabs.values()].some((t) => t.session.id === id))

  constructor(
    private readonly repo: Repo,
    private readonly settings: SettingsService,
    private readonly prompts: PromptBroker,
    /** Ask the user to unlock the vault; resolves when unlocked or declined. */
    private readonly unlock?: () => Promise<void>
  ) {}

  start(): void {
    this.generation++
    this.key = newKey()
    const proc = utilityProcess.fork(join(__dirname, 'session-host.js'), [], { serviceName: 'Hopline Terminal Session Host', stdio: 'inherit', env: hostEnv() })
    this.proc = proc
    this.ready = new Promise((resolve) => {
      const onReady = (m: HostToMain) => {
        if (m?.t === 'ready') {
          proc.off('message', onReady)
          resolve()
        }
      }
      proc.on('message', onReady)
    })
    proc.on('message', (m: HostToMain) => this.onMessage(m))
    proc.on('exit', (code) => this.onExit(proc, code))
    this.post({ t: 'init', key: this.key, blocked: this.policyRules })
  }

  private post(m: MainToHost, transfer?: Electron.MessagePortMain[]): void {
    this.proc?.postMessage(m, transfer)
  }

  private rpc<T>(build: (id: number) => MainToHost): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.post(build(id))
    })
  }

  private onMessage(m: HostToMain): void {
    switch (m.t) {
      case 'res': {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (!p) return
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(m.error))
        return
      }
      case 'state': {
        const tab = this.tabs.get(m.info.tabId)
        // Recent sessions: stamped in main, the moment a tab reaches the device. Quick connects are not stored.
        if (tab?.wc && m.info.state === 'connected' && !tab.session.ephemeral) this.repo.touchConnected(tab.session.id)
        if (tab?.wc && !tab.wc.isDestroyed()) tab.wc.send('term:state', m.info)
        if (tab?.wc && m.info.dropped) this.onDropped?.({ tabId: tab.tabId, session: tab.session }, m.info)
        if (tab && !tab.wc && (m.info.state === 'connected' || m.info.state === 'down')) this.bgWaiters.get(tab.tabId)?.(m.info)
        if (tab && m.info.state === 'connected') {
          const s = this.fresh(tab)
          if (s.platform === 'auto') this.onAutoConnected?.({ tabId: tab.tabId, session: s })
          this.onConnected?.({ tabId: tab.tabId, session: s })
        }
        return
      }
      case 'xfer-data':
      case 'xfer-meta':
      case 'xfer-ack':
      case 'fwd-state':
        for (const fn of this.extra) fn(m)
        return
      case 'ask': {
        // Answer only the process that asked: after a restart, ask ids start over.
        const proc = this.proc
        void this.answerAsk(m).then((value) => {
          if (this.proc === proc) this.post({ t: 'reply', id: m.id, value })
        })
        return
      }
    }
  }

  private async answerAsk(m: Extract<HostToMain, { t: 'ask' }>): Promise<unknown> {
    const tab = this.tabs.get(m.tabId)
    const meta = { tabId: m.tabId, sessionName: tab?.session.name }
    const q = m.q
    switch (q.kind) {
      case 'host-key': {
        const known = this.repo.hostKeys(q.host, q.port)
        if (known.length === 0) {
          this.repo.addHostKey(q.host, q.port, q.fingerprint)
          if (!tab?.wc) this.onBackgroundHostKey?.(tab ? { tabId: tab.tabId, session: tab.session } : null, { host: q.host, port: q.port, fingerprint: q.fingerprint })
          return { accept: true, notice: `Trusted new host key ${q.fingerprint}` }
        }
        if (known.includes(q.fingerprint)) return { accept: true }
        // A changed key is never accepted without the user: a background connection just fails.
        if (!tab?.wc) return { accept: false }
        const replace = await this.prompts.ask(tab.wc, { kind: 'host-key-changed', host: q.host, port: q.port, known: known.join('\n'), offered: q.fingerprint }, meta)
        if (replace !== true) return { accept: false }
        this.repo.replaceHostKeys(q.host, q.port, q.fingerprint)
        return { accept: true, notice: `Replaced the stored host key with ${q.fingerprint} (approved by you)` }
      }
      case 'keyboard-interactive': {
        // Background connections ask nobody: a device that wants a typed answer fails as "needs sign-in".
        if (!tab?.wc) return null
        const { retry, ...prompt } = q
        return this.prompts.ask(tab.wc, prompt, { ...meta, ...retryMeta(retry, prompt) })
      }
      case 'secret': {
        if (!tab?.wc) return null
        const { retry, ...prompt } = q
        const v = await this.prompts.ask(tab.wc, prompt, { ...meta, ...retryMeta(retry, prompt) })
        // Remember a typed target password (memory only) so a session-host restart can reconnect.
        if (typeof v === 'string' && q.secret === 'password' && q.host === tab.session.host) tab.password = v
        return v
      }
    }
  }

  private onExit(proc: UtilityProcess, code: number): void {
    if (proc !== this.proc) return
    this.proc = null
    for (const p of this.pending.values()) p.reject(new Error('session host stopped'))
    this.pending.clear()
    // Questions asked by the dead process can't be answered any more.
    for (const id of this.tabs.keys()) this.prompts.cancelTab(id)
    if (this.quitting) return
    // Crash loops must never become reconnect storms against production devices.
    const now = Date.now()
    this.crashes = this.crashes.filter((t) => now - t < 60_000)
    this.crashes.push(now)
    if (this.crashes.length > 3) {
      console.error(`[hopline] session host exited (${code}) ${this.crashes.length} times in a minute; not reconnecting`)
      this.start()
      // Tabs come back disconnected: the user decides when to try again (Enter).
      this.dropBackground()
      for (const tab of this.tabs.values()) if (tab.wc && !tab.wc.isDestroyed()) this.openInHost(tab, 'The connection process crashed repeatedly').catch(() => {})
      return
    }
    const delay = 500 * 2 ** (this.crashes.length - 1)
    console.error(`[hopline] session host exited (${code}); restarting in ${delay} ms and reconnecting ${this.tabs.size} tab(s)`)
    this.dropBackground()
    this.start()
    setTimeout(() => this.reopenAll(), delay)
  }

  /** Background connections died with the host: their runs fail, nothing reconnects them. */
  private dropBackground(): void {
    for (const t of [...this.tabs.values()]) if (!t.wc) {
      this.bgWaiters.get(t.tabId)?.({ tabId: t.tabId, sessionId: t.session.id, state: 'down', detail: 'session host stopped' })
      this.tabs.delete(t.tabId)
    }
  }

  private reopenAll(): void {
    // Every connection died with the host: reopen each tab (new transport, new port, same xterm).
    for (const tab of this.tabs.values()) {
      if (tab.generation === this.generation) continue
      if (!tab.wc || tab.wc.isDestroyed()) continue
      tab.wc.send('term:state', { tabId: tab.tabId, sessionId: tab.session.id, state: 'reconnecting', detail: 'session host restarted' } satisfies TabInfo)
      this.openInHost(tab).then(() => this.onReopened?.(tab.tabId)).catch(() => {})
    }
  }

  // ------------------------------------------------------------------ tabs

  /**
   * A stored credential, resolved from the vault. While a master-password vault is locked, the
   * renderer is asked to unlock first; if the user declines, the connection goes on with the
   * username only and the device prompts for what it needs.
   */
  private async resolve(id: string): Promise<ResolvedCredential | undefined> {
    try {
      return await this.repo.resolveCredential(id)
    } catch (e) {
      if (!isLocked(e)) throw e
    }
    await this.unlock?.()
    try {
      return await this.repo.resolveCredential(id)
    } catch (e) {
      if (!isLocked(e)) throw e
      const meta = this.repo.getCredential(id)
      return meta && { username: meta.username, kind: meta.kind }
    }
  }

  private async authFor(s: Session, typed?: string): Promise<AuthSpec> {
    const auth: AuthSpec = { username: s.username, password: typed, useAgent: s.options.ssh?.useAgent }
    if (s.credentialId) {
      const c = await this.resolve(s.credentialId)
      if (c) {
        auth.username = c.username || auth.username
        switch (c.kind) {
          case 'password':
            auth.password = typed ?? c.secret
            break
          case 'key':
            auth.privateKey = c.secret
            auth.passphrase = c.passphrase
            break
          case 'agent':
            auth.useAgent = true
            break
          case 'prompt':
            // Username only: the session host asks for the password on every connect.
            break
        }
      }
    }
    return auth
  }

  private async spec(tab: OpenTab): Promise<OpenSpec> {
    const o = this.overridesFor(tab.session)
    // A folder (or the session) can override keep-alive, auto-reconnect and logging.
    const s: Session = { ...tab.session, logToFile: effectiveLogToFile(tab.session, o) }
    const settings = effectiveSettings(this.settings.get(), o)
    const auth = await this.authFor(s, tab.password)
    const jump: NonNullable<OpenSpec['jump']> = []
    for (const id of s.protocol === 'ssh' ? (s.options.ssh?.jump ?? []) : []) {
      const j = this.repo.getSession(id)
      if (!j || j.protocol !== 'ssh' || j.id === s.id) throw new Error('A jump host for this session no longer exists or is not an SSH session')
      // The hop signs in as its credential's user, like a target does (P8 D-L2), not the session's.
      const jAuth = await this.authFor(j)
      jump.push({ host: j.host, port: j.port, username: jAuth.username, label: j.name, auth: jAuth })
    }
    return {
      jump,
      tabId: tab.tabId,
      session: s,
      background: !tab.wc,
      cols: tab.cols,
      rows: tab.rows,
      auth,
      settings: {
        keepAliveSec: settings.keepAliveSec,
        autoReconnect: tab.wc ? settings.autoReconnect : false,
        log: { dir: settings.logDir, template: settings.logTemplate, timestamps: settings.logTimestamps, rotateDaily: settings.logRotateDaily }
      }
    }
  }

  /** Open a tab in the host and hand the renderer its end of a fresh MessagePort. */
  private async openInHost(tab: OpenTab, deferConnect?: string): Promise<TabInfo> {
    await this.ready
    const spec = { ...(await this.spec(tab)), deferConnect }
    // The tab may have closed while credentials were being resolved: don't open an orphan.
    if (this.tabs.get(tab.tabId) !== tab) throw new Error('tab closed')
    tab.generation = this.generation
    const result = this.rpc<TabInfo>((id) => ({ t: 'open', id, spec }))
    // A background connection has no screen: the host keeps a bounded tail of its output.
    if (!tab.wc) return result
    const { port1, port2 } = new MessageChannelMain()
    this.post({ t: 'port', tabId: tab.tabId }, [port1])
    if (!tab.wc.isDestroyed()) tab.wc.postMessage('term:port', { tabId: tab.tabId }, [port2])
    return result
  }

  async open(wc: WebContents, tabId: string, sessionId: string, cols: number, rows: number, password?: string): Promise<TabInfo> {
    if (this.tabs.has(tabId)) throw new Error('tab already open')
    const session = this.repo.getSession(sessionId) ?? this.ephemeral.get(sessionId)
    if (!session) throw new Error('unknown session')
    // Review L1: once "Restart and install" is accepted, no new connection may start under the installer.
    if (this.installingUpdate) throw new Error('Hopline Terminal is restarting to install an update')
    this.remember(session)
    const tab: OpenTab = { tabId, session, cols, rows, password, wc, generation: 0 }
    this.tabs.set(tabId, tab)
    return this.openInHost(tab)
  }

  /**
   * A background connection for a multi-device run: no window, no prompts (stored credentials
   * only), no auto-reconnect. Resolves once the device is idle at a prompt; the caller closes it.
   */
  async openBackground(sessionId: string, signal?: AbortSignal): Promise<AgentTab> {
    const session = this.repo.getSession(sessionId)
    if (!session) throw new Error('unknown session')
    if (this.installingUpdate) throw new Error('Hopline Terminal is restarting to install an update')
    const tabId = `bg-${Date.now().toString(36)}-${++bgSeq}`
    const tab: OpenTab = { tabId, session, cols: 200, rows: 50, wc: null, generation: 0 }
    this.tabs.set(tabId, tab)
    const first = new Promise<TabInfo>((resolve) => this.bgWaiters.set(tabId, resolve))
    const stop = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('timed out connecting')), BACKGROUND_CONNECT_MS)
      first.finally(() => clearTimeout(t)).catch(() => {})
      signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    })
    try {
      const opened = this.openInHost(tab)
      const info = await Promise.race([first, opened.then((i) => (i.state === 'connected' || i.state === 'down' ? i : first)), stop])
      if (info.state !== 'connected') throw new Error(info.detail || 'could not connect')
      const at = await this.evidence({ tabId, session }, 15_000)
      if (!at.connected) throw new Error('the connection closed')
      if (!at.atPrompt) throw new Error('no prompt (the device may want a typed sign-in)')
      return { tabId, session: this.fresh(tab) }
    } catch (e) {
      this.close(tabId)
      throw e
    } finally {
      this.bgWaiters.delete(tabId)
    }
  }

  /** Whether a tab is shown in this window (send-to-many only takes tabs of the asking window). */
  /** The window a tab belongs to (null for a background connection or an unknown tab). */
  windowOf(tabId: string): WebContents | null {
    return this.tabs.get(tabId)?.wc ?? null
  }

  ownedBy(tabId: string, wc: WebContents): boolean {
    return this.tabs.get(tabId)?.wc === wc
  }

  async reconnect(sender: WebContents, tabId: string, password?: string): Promise<TabInfo | undefined> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.wc !== sender) return undefined
    this.prompts.cancelTab(tabId)
    if (password) tab.password = password
    // After a host restart the tab no longer exists there: open it again with a new port.
    if (tab.generation !== this.generation) return this.openInHost(tab)
    return this.rpc<TabInfo>((id) => ({ t: 'reconnect', id, tabId, password }))
  }

  close(tabId: string, sender?: WebContents): void {
    const tab = this.tabs.get(tabId)
    if (!tab || (sender && tab.wc !== sender)) return
    this.prompts.cancelTab(tabId)
    if (tab.generation === this.generation) this.post({ t: 'close', tabId })
    tab.password = undefined
    this.tabs.delete(tabId)
    this.onClosed?.(tabId)
    const id = tab.session.id
    if (tab.session.ephemeral && ![...this.tabs.values()].some((t) => t.session.id === id)) this.ephemeral.delete(id)
  }

  /** A quick-connect session was saved under the same id: open tabs now refer to the stored one. */
  adopt(session: Session): void {
    this.ephemeral.delete(session.id)
    for (const t of this.tabs.values()) if (t.session.id === session.id) t.session = session
  }

  /** Window closed or reloaded: drop its tabs. */
  closeFor(wc: WebContents): void {
    for (const t of [...this.tabs.values()]) if (t.wc === wc) this.close(t.tabId)
  }

  /** Open tabs in a window, for the close-window confirmation. */
  openCount(wc: WebContents): number {
    let n = 0
    for (const t of this.tabs.values()) if (t.wc === wc) n++
    return n
  }

  /** The sessions behind every live connection, quick-connect ones included (crash-report scrubbing). */
  liveSessions(): Session[] {
    return [...this.tabs.values()].map((t) => t.session)
  }

  /** Set when an update install was accepted (UpdateService.restart): new connections are refused. */
  installingUpdate = false

  /** Sessions opened earlier in this run, kept after their tab closed (a closed quick connect): review M6. */
  private readonly seen = new Map<string, Pick<Session, 'name' | 'host' | 'username'>>()
  private remember(s: Session): void {
    this.seen.delete(s.id)
    this.seen.set(s.id, { name: s.name, host: s.host, username: s.username })
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!)
  }
  /** Every session seen in this run, live or closed: their names, hosts and users stay out of crash reports. */
  sessionsSeen(): Pick<Session, 'name' | 'host' | 'username'>[] {
    return [...this.liveSessions(), ...this.seen.values()]
  }

  /** Every connection this host holds, the user's tabs and background ones (multi runs, backups, fleet). */
  liveCount(): number {
    return this.tabs.size
  }

  /** Test hook: simulate a session host crash. */
  crashForTest(): void {
    this.proc?.kill()
  }

  shutdown(): void {
    this.quitting = true
    this.post({ t: 'shutdown' })
  }

  // ------------------------------------------------------------------ files and forwards (main/files)

  /** Listen to the host's file-transfer and forward messages. */
  onHostMessage(fn: (m: HostToMain) => void): () => void {
    this.extra.add(fn)
    return () => this.extra.delete(fn)
  }

  /** A tab and its owner, when `sender` (if given) owns it and it is open in the current host. */
  owned(tabId: string, sender?: WebContents): { session: Session; wc: WebContents } | undefined {
    const t = this.tabs.get(tabId)
    // Background connections (multi-device runs) have no window and are never used for files or forwards.
    if (!t || !t.wc || (sender && t.wc !== sender) || t.generation !== this.generation) return undefined
    return { session: this.fresh(t), wc: t.wc }
  }

  /** The session of a background connection (no window), or undefined for window tabs and unknown ids. */
  background(tabId: string): Session | undefined {
    const t = this.tabs.get(tabId)
    return t && !t.wc ? this.fresh(t) : undefined
  }

  /** A request to the host (files/forwards); rejects when the host stops. */
  request<T>(build: (id: number) => MainToHost): Promise<T> {
    return this.rpc<T>(build)
  }

  /** A one-way message to the host (transfer bytes, acks, cancels). */
  send(m: MainToHost): void {
    this.post(m)
  }

  // ------------------------------------------------------------------ TabControl (agent)

  /** The stored session as it is now (the platform may have been detected or edited since the tab opened). */
  private fresh(t: OpenTab): Session {
    if (!t.session.ephemeral) {
      const s = this.repo.getSession(t.session.id)
      if (s) t.session = s
    } else t.session = this.ephemeral.get(t.session.id) ?? t.session
    return t.session
  }

  get(tabId: string): AgentTab | undefined {
    const t = this.tabs.get(tabId)
    return t && { tabId: t.tabId, session: this.fresh(t) }
  }

  /** The platform as stored now: a change made during an agent run applies to its next command. */
  private platformOf(tab: AgentTab): Session['platform'] {
    const t = this.tabs.get(tab.tabId)
    return t ? this.fresh(t).platform : tab.session.platform
  }

  /** Tell the window that owns a tab something about it (auto-detect results). */
  notify(tabId: string, channel: string, payload: unknown): void {
    const t = this.tabs.get(tabId)
    if (t?.wc && !t.wc.isDestroyed()) t.wc.send(channel, payload)
  }

  /** Every open tab of a session (a session can be open in several); background connections are not tabs. */
  tabsOf(sessionId: string): AgentTab[] {
    return [...this.tabs.values()].filter((t) => t.wc && t.session.id === sessionId).map((t) => ({ tabId: t.tabId, session: this.fresh(t) }))
  }

  /** Auto-detect: wait until the device is idle at a prompt and report what was observed. Sends nothing. */
  evidence(tab: AgentTab, waitMs: number, after?: string): Promise<ObservedEvidence> {
    return this.rpc<ObservedEvidence>((id) => ({ t: 'evidence', id, tabId: tab.tabId, waitMs, ...(after !== undefined ? { after } : {}) })).catch(() => ({ atPrompt: false, connected: false }))
  }

  /**
   * Auto-detect probe: one read-only command on a device whose platform is not known, signed with
   * the candidates it was classified read on. The host re-derives and re-checks it.
   */
  async probe(tab: AgentTab, command: string, covers: PlatformId[], opts: ExecOpts): Promise<ExecResultMsg> {
    // The team policy applies to the probe too (review L8): checked for every platform it is signed
    // for, and the "all" rules (an invalid policy blocks it). The host checks the same list again.
    for (const p of [...covers, 'auto']) {
      const denied = policyBlocked(this.policyRules, p, command)
      if (denied) return { status: 'error', output: '', durationMs: 0, bytes: 0, error: `refused: "${command}" is ${denied}` }
    }
    const token = sign(this.key, { tabId: tab.tabId, command, kind: 'read', platform: 'auto', probe: covers })
    return this.rpc<ExecResultMsg>((id) => ({ t: 'exec', id, spec: { tabId: tab.tabId, command, kind: 'read', token, timeoutMs: opts.timeoutMs, capBytes: opts.capBytes } })).catch(
      (e: unknown) => ({ status: 'error' as const, output: '', durationMs: 0, bytes: 0, error: e instanceof Error ? e.message : String(e) })
    )
  }

  async exec(tab: AgentTab, command: string, kind: ExecKind, opts: ExecOpts): Promise<ExecResultMsg> {
    // Global read-only mode covers every automated send (review Low 5): one refusal for every caller
    // (agent, snippets, send-to-many, backups), before anything is signed.
    const readOnly = !!this.settings.get().aiReadOnly
    if (readOnly && kind !== 'read')
      return { status: 'error', output: '', durationMs: 0, bytes: 0, error: `refused: "${command}" is a ${kind} command and read-only mode is on (Settings › Assistant › Read-only mode)` }
    // The team policy's extra blocked commands, for every caller, before anything is signed.
    const denied = policyBlocked(this.policyRules, this.platformOf(tab), command)
    if (denied) return { status: 'error', output: '', durationMs: 0, bytes: 0, error: `refused: "${command}" is ${denied}` }
    // Bind the platform the caller classified for: the host re-checks with this one.
    const token = sign(this.key, { tabId: tab.tabId, command, kind, platform: this.platformOf(tab), ...(readOnly ? { readOnly } : {}), ...(kind === 'disruptive' && opts.ack ? { ack: opts.ack } : {}), ...(kind !== 'read' && opts.hosts ? { hosts: opts.hosts } : {}), ...(kind === 'config' && opts.net ? { net: true as const } : {}) })
    let id = 0
    const onAbort = () => this.post({ t: 'exec-cancel', id })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.rpc<ExecResultMsg>((i) => {
        id = i
        return {
          t: 'exec',
          id: i,
          spec: { tabId: tab.tabId, command, kind, token, timeoutMs: opts.timeoutMs, capBytes: opts.capBytes, allowConfig: opts.allowConfig }
        }
      })
    } catch (e) {
      return { status: 'error', output: '', durationMs: 0, bytes: 0, error: e instanceof Error ? e.message : String(e) }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  async listSerialPorts(): Promise<SerialPortInfo[]> {
    await this.ready
    return this.rpc<SerialPortInfo[]>((id) => ({ t: 'serial-list', id }))
  }

  prompt(tab: AgentTab): Promise<PromptInfo> {
    return this.rpc<PromptInfo>((id) => ({ t: 'prompt', id, tabId: tab.tabId, platform: this.platformOf(tab) })).catch(() => ({ mode: 'unknown' as const, prompt: '', hostname: '' }))
  }

  mode(tab: AgentTab): Promise<PromptMode> {
    return this.rpc<PromptMode>((id) => ({ t: 'mode', id, tabId: tab.tabId, platform: this.platformOf(tab) })).catch(() => 'unknown' as const)
  }
}
