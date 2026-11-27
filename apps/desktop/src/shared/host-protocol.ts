/**
 * Messages between main (broker) and the session host (utilityProcess that owns all device I/O).
 * Data to and from the renderer does NOT pass through here: each tab gets its own MessagePort.
 */
import type { AnyPlatform } from './cli'
import type { ConnState, HostPrompt, SerialLines, SessionVitals, Session, TabInfo } from './types'
import type { Direction, FilesOp, ForwardSpec, ForwardStatus } from './files'

/** Credentials resolved by main from the vault (never from the renderer, except a typed password). */
export interface AuthSpec {
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  useAgent?: boolean
}

/** Everything the host needs to open a tab. Secrets are resolved by main from the vault. */
export interface OpenSpec {
  tabId: string
  session: Session
  cols: number
  rows: number
  auth: AuthSpec
  /** Open the tab without connecting (state down, Enter connects). */
  deferConnect?: string
  /**
   * A background connection (multi-device runs, background backups): no window, nobody watching.
   * It never gets port forwards, saved or otherwise.
   */
  background?: boolean
  /** SSH jump hosts, outermost first, each with its own resolved credentials. */
  jump?: { host: string; port: number; username: string; label: string; auth: AuthSpec }[]
  settings: {
    keepAliveSec: number
    autoReconnect: boolean
    log: { dir: string; template: string; timestamps: boolean; rotateDaily: boolean }
  }
}

export interface ExecSpec {
  tabId: string
  command: string
  kind: 'read' | 'config' | 'disruptive'
  /** HMAC verdict from main's guard; the host refuses any non-user write without a valid one. */
  token: string
  timeoutMs: number
  capBytes: number
  allowConfig?: boolean
}

export interface ExecResultMsg {
  status: 'ok' | 'timeout' | 'capped' | 'error'
  output: string
  durationMs: number
  bytes: number
  error?: string
  /** The prompt hostname the command was typed at (the device it ran on); '' when the prompt shows none. */
  hostname?: string
  /**
   * The command was typed but Enter was not pressed, and the line could not be confirmed empty
   * afterwards: the device may still hold the text (audited as "typed, not sent").
   */
  typedNotSent?: boolean
}

export type PromptMode = 'exec' | 'user' | 'config' | 'unknown'

/** What auto-detect observed without sending anything (cli-model `Evidence`), and whether the device is idle at a prompt. */
export interface ObservedEvidence {
  atPrompt: boolean
  /** False once the connection dropped (detection stops; the next connect starts it again). */
  connected?: boolean
  /** The end of the screen, passed back as `after` to wait for something new. */
  key?: string
  sshServerVersion?: string
  banner?: string
  prompt?: string
}

/** The device prompt right now, per the platform's grammar. */
export interface PromptInfo {
  mode: PromptMode
  /** The prompt text (`core-sw1(config-if)#`, `[~HUAWEI]`). */
  prompt: string
  hostname: string
}

export type MainToHost =
  /** `blocked`: the team policy's extra blocked commands (shared/policy-deny.ts), checked again here. */
  | { t: 'init'; key: string; blocked?: Record<string, string[]> }
  | { t: 'open'; id: number; spec: OpenSpec }
  | { t: 'port'; tabId: string } // carries a MessagePort for the renderer side of this tab
  | { t: 'close'; tabId: string }
  | { t: 'reconnect'; id: number; tabId: string; password?: string }
  | { t: 'exec'; id: number; spec: ExecSpec }
  | { t: 'exec-cancel'; id: number }
  | { t: 'mode'; id: number; tabId: string; platform: AnyPlatform }
  | { t: 'prompt'; id: number; tabId: string; platform: AnyPlatform }
  /** Auto-detect: wait until the device is idle at a prompt, then report what was observed. */
  | { t: 'evidence'; id: number; tabId: string; waitMs: number; after?: string }
  | { t: 'reply'; id: number; value: unknown }
  | { t: 'serial-list'; id: number }
  | { t: 'shutdown' }
  // ---- files (SFTP/SCP) and forwards: see src/session-host/files.ts
  | { t: 'files'; id: number; tabId: string; op: FilesOp | { op: 'open' } | { op: 'preview'; path: string; platform: string } | { op: 'scp-directory'; path: string; platform: string } }
  /** Start a transfer; answered (res) when it is complete. Bytes travel as xfer-data/xfer-ack. */
  | { t: 'xfer'; id: number; tabId: string; spec: XferSpec }
  /** Upload bytes (main reads the local file) and their end. */
  | { t: 'xfer-data'; xferId: string; d: Uint8Array }
  | { t: 'xfer-end'; xferId: string }
  /** Download flow control: main wrote `n` more bytes to disk. */
  | { t: 'xfer-ack'; xferId: string; n: number }
  | { t: 'xfer-cancel'; xferId: string }
  | { t: 'fwd'; id: number; tabId: string; op: FwdOp }

export type HostToMain =
  | { t: 'ready' }
  | { t: 'res'; id: number; ok: true; value?: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'state'; info: TabInfo }
  | { t: 'ask'; id: number; tabId: string; q: HostAsk }
  /** Download bytes for main to write, and the size/name once known (SCP announces them late). */
  | { t: 'xfer-data'; xferId: string; d: Uint8Array }
  | { t: 'xfer-meta'; xferId: string; size: number; name: string }
  /** Upload flow control: the host wrote `n` more bytes to the device. */
  | { t: 'xfer-ack'; xferId: string; n: number }
  | { t: 'fwd-state'; tabId: string; forwards: ForwardStatus[] }

/** One file transfer, as main asks the host to run it. Local files never reach the host. */
export interface XferSpec {
  xferId: string
  direction: Direction
  remotePath: string
  /** Upload: the local file's size. */
  size?: number
  /** Resume from this byte (SFTP only). */
  offset?: number
  /** Upload: refuse to replace an existing remote file. */
  exclusive?: boolean
}

export type FwdOp = { op: 'start'; spec: ForwardSpec } | { op: 'stop'; fid: string } | { op: 'remove'; fid: string } | { op: 'list' }

/** Questions the host needs main (and maybe the user) to answer. */
export type HostAsk =
  | { kind: 'host-key'; host: string; port: number; fingerprint: string }
  | (Extract<HostPrompt, { kind: 'keyboard-interactive' | 'secret' }> & { retry?: PromptRetry })

/** The device rejected the previous answer (see Prompter in @hopline/transports). */
export interface PromptRetry {
  attempt: number
  of: number
  /** The stored password was rejected, not a typed one. */
  saved?: boolean
}

/** Renderer ↔ host, per tab, over a MessagePort. Short keys: this is the hot path. */
export type PortToRenderer =
  | { t: 'd'; d: string }
  | { t: 'vitals'; sample: SessionVitals }
  | { t: 's'; state: ConnState; detail?: string }
  /** Serial tabs: the modem lines as the port has them (after a change, a BREAK, or connect). */
  | ({ t: 'sig' } & SerialLines)
export type PortToHost =
  | { t: 'w'; d: string }
  | { t: 'r'; cols: number; rows: number }
  | { t: 'a'; n: number }
  /** Send Break (serial BREAK, Telnet IAC BRK, SSH break request). */
  | { t: 'b' }
  | { t: 'sig'; dtr?: boolean; rts?: boolean }
