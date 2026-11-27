/**
 * The contract every transport implements. Transports are plain Node modules (no Electron) and are
 * hosted by the session host process. They move bytes and report lifecycle; policy (guard, audit,
 * credentials lookup) lives elsewhere.
 */
import type { EventEmitter } from 'node:events'

export type TransportKind = 'ssh' | 'telnet' | 'raw' | 'serial'

export interface TermSize {
  cols: number
  rows: number
}

/**
 * Lifecycle:
 * - `connect()` resolves once the session is interactive (shell open / socket connected / port open)
 *   and rejects with a `TransportError` if that never happens.
 * - After that, failures emit `close` with a reason. A user `end()` emits `close` with no reason
 *   (so the host knows not to auto-reconnect).
 *
 * Close-reason convention (the reason stays human-readable; a prefix tells the host what happened):
 * - no reason: the user called `end()`. Don't auto-reconnect.
 * - `logout: ...`: the session ended deliberately on the device (SSH: the shell sent
 *   exit-status / exit-signal, i.e. the user typed `exit` / `logout`). Don't auto-reconnect.
 *   SSH emits exactly `logout: session ended by the device`.
 * - `remote-closed: ...`: Telnet / raw got a clean FIN from the remote. Ambiguous (a logout, or the
 *   device or a terminal server dropping us), so the host decides. Telnet / raw emit exactly
 *   `remote-closed: Connection closed by remote host`.
 * - anything else: the link was lost (TCP reset, keepalive timeout, jump host down, serial unplug).
 *   Auto-reconnect is reasonable.
 *
 * Events: `data` (Buffer), `close` (reason?: string), `notice` (text: string) for one-line,
 * human-readable status such as "Trusted new host key" or "Negotiated NAWS".
 */
export interface Transport extends EventEmitter {
  readonly kind: TransportKind
  connect(): Promise<void>
  write(data: Buffer | string): void
  resize(size: TermSize): void
  /** Flow control: stop reading from the remote until resume() (backpressure from the renderer). */
  pause(): void
  resume(): void
  end(): void
  /** Serial: assert BREAK for `ms`. Telnet: send IAC BRK. SSH: send a "break" channel request. */
  sendBreak?(ms?: number): Promise<void>
  /** Serial only: set modem control lines. */
  setSignals?(s: { dtr?: boolean; rts?: boolean }): Promise<void>
}

export type TransportErrorCode =
  | 'auth' // credentials rejected: never auto-retry
  | 'host-key' // host key mismatch or rejected: never auto-retry
  | 'refused' // TCP refused / port busy
  | 'timeout'
  | 'unreachable' // DNS, no route, no such serial port
  | 'protocol' // negotiation failed, unsupported algorithms
  | 'cancelled' // user cancelled a prompt
  | 'other'

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'TransportError'
  }
  /** Errors that must not trigger automatic reconnects. */
  get permanent(): boolean {
    return this.code === 'auth' || this.code === 'host-key' || this.code === 'cancelled'
  }
}

/** Interactive questions a transport may need answered (by the user via the UI). */
/**
 * Set on the first prompt after the server rejected the previous answer, so the UI can say so.
 * `saved`: what was rejected was the stored password, not something the user typed.
 */
export interface PromptRetry {
  /** 1-based number of this user attempt, out of `of`. */
  attempt: number
  of: number
  saved?: boolean
}

export interface Prompter {
  /** Keyboard-interactive / MFA round. Return one answer per prompt, or null to cancel. */
  keyboardInteractive(round: { name: string; instructions: string; prompts: { prompt: string; echo: boolean }[]; retry?: PromptRetry }): Promise<string[] | null>
  /** A secret that wasn't stored (password or key passphrase). null cancels. */
  secret(what: { kind: 'password' | 'passphrase'; label: string; retry?: PromptRetry }): Promise<string | null>
}

/** Host key policy. Return 'accept' to continue, 'reject' to abort. Called once per hop. */
export type HostKeyVerifier = (key: {
  host: string
  port: number
  algorithm: string
  /** 'SHA256:base64' without padding, like OpenSSH. */
  fingerprint: string
}) => Promise<'accept' | 'reject'> | 'accept' | 'reject'
