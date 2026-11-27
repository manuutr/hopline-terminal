import type { AccountAction, AccountProvider, AccountState, CloudProvider } from './providers'
import type { FleetEvent, FleetInfo, FleetMentionRequest, FleetMentionResult, FleetScopePreview, FleetScopeSpec, FleetStartRequest } from './fleet'
import type { CommandPlan, CommandRunResult, Keymap, MultiEvent, MultiPreview, MultiPreviewRequest, MultiStartRequest, ResolvedTarget, Snippet, SnippetInput, TargetSpec } from './productivity'
import type { BackupResult, BackupRetention, BackupSchedule, BackupScheduleInput, BackupText, BackupVersion } from './backups'
/**
 * Types shared by main, preload and renderer. Nothing here may carry a secret:
 * passwords, private keys and the API key exist only in the main process.
 */
import type { Classification, Platform, SessionPlatform } from '@hopline/guard'
import type { EgressDetail, EgressQuery, EgressRow, EgressSearch, EgressStats } from './egress'
import type { PolicyInfo } from './policy'
import type { CrashStatus, RendererError, RestartResult, UpdateStatus } from './privacy'
import type { ForwardApi, ForwardSpec, TransferApi } from './files'

export type { Platform, SessionPlatform, Classification }

/** What auto-detect learned about a device (set by main on connect, never by the renderer). */
export interface PlatformDetection {
  version?: string
  model?: string
  /** 0..1 */
  confidence: number
  at: number
}
export type Protocol = 'ssh' | 'telnet' | 'raw' | 'serial'

export interface SerialSettings {
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits: 1 | 1.5 | 2
  flow: 'none' | 'rtscts' | 'xonxoff'
  /** BREAK length for Send Break (ROMMON, password recovery). */
  breakMs: number
}

/** Protocol-specific settings, stored as JSON. Unknown keys are dropped on save. */
export interface SessionOptions {
  serial?: SerialSettings
  ssh?: {
    /** Jump hosts, first hop first: ids of other SSH sessions. */
    jump?: string[]
    /** Authenticate with the local SSH agent (OpenSSH, Pageant, 1Password). */
    useAgent?: boolean
    agentForward?: boolean
    /** Offer legacy algorithms (group1 DH, ssh-dss, CBC) after modern ones. Default on. */
    legacyAlgorithms?: boolean
    /** Port forwards (-L/-R/-D) for this session; see shared/files.ts. */
    forwards?: ForwardSpec[]
  }
}

export const SERIAL_DEFAULTS: SerialSettings = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', breakMs: 300 }

export interface Folder {
  id: string
  name: string
  parentId: string | null
  sort: number
}

/** Accent colors a session can carry (tab stripe, tree marker). Names, not hex: themes pick the shade. */
export const SESSION_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export type SessionColor = (typeof SESSION_COLORS)[number]

export interface Session {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  protocol: Protocol
  /** `auto` until the first connect identifies the device; the guard refuses everything until then. */
  platform: SessionPlatform
  username: string
  credentialId: string | null
  logToFile: boolean
  notes: string
  options: SessionOptions
  /** Free-form labels ("core", "prod", "dc1"), lowercase, unique. */
  tags: string[]
  color: SessionColor | null
  /** Pinned to the Favorites section of the tree. */
  favorite: boolean
  /** Set by main when a tab for this session reaches "connected". Never written by the renderer. */
  lastConnectedAt: number | null
  /** Set by main when auto-detect identified the platform. Never written by the renderer. */
  detected?: PlatformDetection | null
  /**
   * Quick-connect session that lives only in main's memory until saved ("Save as session").
   * Never stored, never listed by sessions.list().
   */
  ephemeral?: boolean
}

/** Tree fields are optional: omitted ones keep their stored value (or the default for a new session). */
export type SessionInput = Omit<Session, 'id' | 'tags' | 'color' | 'favorite' | 'lastConnectedAt' | 'ephemeral' | 'detected'> & {
  id?: string
  tags?: string[]
  color?: SessionColor | null
  favorite?: boolean
}

/** What quick connect sends for an unsaved session: no credential, jump host, logging or notes. */
export type QuickSessionInput = Pick<SessionInput, 'name' | 'host' | 'port' | 'protocol' | 'platform' | 'username'> & { options: { serial?: SerialSettings } }

/** Bulk edit: every present field is applied to every listed session in one transaction. */
export interface SessionPatch {
  folderId?: string | null
  platform?: SessionPlatform
  username?: string
  credentialId?: string | null
  color?: SessionColor | null
  favorite?: boolean
  /** Added to each session's tags (deduplicated). */
  addTags?: string[]
  removeTags?: string[]
}

export type CredentialKind = 'password' | 'key' | 'agent' | 'prompt'

/**
 * A credential profile as the renderer sees it: metadata only, never the secret itself.
 * - password: a stored password (or none: asked on connect)
 * - key: a private key (OpenSSH, PEM or PPK) plus an optional stored passphrase
 * - agent: the local SSH agent (OpenSSH, Pageant, 1Password)
 * - prompt: username only; the password is asked for every time
 */
/** A serial tab's modem-control lines, as last set on the port. `error`: why the last change was refused. */
export interface SerialLines {
  dtr: boolean
  rts: boolean
  /** BREAK is being sent. */
  brk: boolean
  error?: string
}

export interface CredentialInfo {
  id: string
  name: string
  username: string
  kind: CredentialKind
  /** A password or private key is stored. */
  hasSecret: boolean
  hasPassphrase: boolean
  /** Key profiles: "ssh-ed25519", "ssh-rsa"… */
  keyType: string | null
  /** Key profiles: "SHA256:…" of the public key (null when it can only be read with the passphrase). */
  keyFingerprint: string | null
  /** The stored key is encrypted and needs a passphrase (stored or asked on connect). */
  keyEncrypted: boolean
  /** Sessions that use this profile. */
  usedBy: number
}

/** Renderer → main when creating/updating a credential. Secrets flow one way only. */
export interface CredentialInput {
  id?: string
  name: string
  username: string
  kind: CredentialKind
  /** Password, or a pasted private key. Omit to keep the stored one; '' removes it. */
  secret?: string
  /** Key passphrase. Omit to keep; '' removes it (asked on connect). */
  passphrase?: string
  /** A key file picked with credentials.importKey (main read it; the renderer never sees the key). */
  keyToken?: string
}

/** A private key file main read and parsed. The key itself stays in main behind `token`. */
export interface KeyImportInfo {
  token: string
  file: string
  format: 'openssh' | 'pem' | 'ppk2' | 'ppk3'
  keyType: string
  fingerprint: string | null
  encrypted: boolean
  comment: string
}

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'down'

export interface SessionVitals {
  steps: string[]
  connectedAt?: number
  retryAt?: number
  rxAt?: number
  txAt?: number
  echoRtt?: number
  sampledAt?: number
}

export interface TabInfo {
  tabId: string
  sessionId: string
  state: ConnState
  detail?: string
  logPath?: string
  /** Set on the state change where an established connection ended on its own (desktop notification). */
  dropped?: boolean
}

/**
 * How the data key that encrypts every secret is protected (D5):
 * keychain = OS keychain (safeStorage); master = master password (scrypt); session = memory only.
 */
export type VaultMode = 'keychain' | 'master' | 'session'

export interface VaultInfo {
  mode: VaultMode
  /** Master mode: the key is not in memory. Stored secrets can't be used until unlocked. */
  locked: boolean
  /** False on first run without a keyring: the user hasn't picked master password or session-only yet. */
  chosen: boolean
  keychainAvailable: boolean
  /** Secrets were sealed by a keychain that no longer answers. Nothing is deleted. */
  keychainBroken: boolean
  /** Linux: "gnome_libsecret", "kwallet", "basic_text"…; "dpapi" or "keychain" elsewhere. */
  backend: string
  /** Master mode: lock after this many idle minutes (0: never). */
  autoLockMin: number
  /** Secrets survive a restart. */
  persistent: boolean
}

export interface Settings {
  /** 'system' follows the OS (prefers-color-scheme). */
  theme: 'dark' | 'light' | 'system' | 'contrast'
  reduceMotion: boolean
  termSmoothCaret: boolean
  termLigatures: boolean
  /** Global AI read-only switch. When on, the agent can only run read-only commands. */
  aiReadOnly: boolean
  aiProvider: AiProviderId
  /** Anthropic model id. */
  aiModel: string
  openaiModel?: string
  geminiModel?: string
  connectedAccounts?: Partial<Record<AccountProvider, boolean>>
  cloudKeys?: Partial<Record<CloudProvider, { saved: boolean; last4: string | null }>>
  /** Derived in main: an Anthropic key is stored (or set in the environment). The key itself never leaves main. */
  hasApiKey: boolean
  /** Derived in main: the last 4 characters of the stored key, for "Saved · ••••abcd". Null if unknown. */
  apiKeyLast4: string | null
  /** Ollama server for local models (air-gapped networks). */
  ollamaEndpoint: string
  /** Ollama model name ("qwen3:8b"); empty until one is picked. */
  ollamaModel: string
  /**
   * The remote plain-http Ollama endpoint the user acknowledged as unencrypted (exactly that
   * string; empty if none). Main refuses a non-loopback http endpoint unless it equals this.
   */
  ollamaInsecureAck: string
  /** Derived in main: the selected provider has what it needs to run (a key, or a picked local model). */
  aiConfigured: boolean
  /** The first-run card in the empty assistant panel was dismissed. */
  aiIntroDismissed: boolean
  /** Token budget for one assistant run (input-equivalent tokens, as fleet/budget.ts meters them). */
  aiRunTokenBudget: number
  /** Keep the "what left this machine" log (every model request, as sent; encrypted, local). */
  egressLog: boolean
  commandTimeoutMs: number
  outputCapBytes: number
  logDir: string
  /** Log file name with SecureCRT-style tokens (%S session, %H host, %Y-%M-%D, %h%m%s…). */
  logTemplate: string
  /** Prefix each logged line with a timestamp. */
  logTimestamps: boolean
  /** Start a new log file at midnight. */
  logRotateDaily: boolean
  keepAliveSec: number
  filesOnConnect: boolean
  autoReconnect: boolean
  /** Color interfaces, addresses, states and errors in terminal output (display only). */
  termHighlight: boolean
  /** Ghost-text completion and command hints at the device prompt (cli-model, never sends anything itself). */
  termAutocomplete: boolean
  /** Extra font family tried before the bundled JetBrains Mono. Empty: bundled font. */
  termFontFamily: string
  termFontSize: number
  termLineHeight: number
  termCursorStyle: 'bar' | 'block' | 'underline'
  termCursorBlink: boolean
  /** Lines kept per tab. */
  termScrollback: number
  /** Terminal color theme id ("auto" follows the app theme). */
  termTheme: string
  /** Save each session's terminal history (encrypted) and show it again on the next connect. */
  termRestoreScrollback: boolean
  /**
   * Screen reader mode: xterm exposes its rows to assistive technology and new output is announced
   * through a polite, throttled live region. Offered when the OS reports a screen reader.
   */
  termScreenReader: boolean
  /** The "Screen reader detected" offer was answered (either way); not asked again. */
  a11yOfferAnswered: boolean
  /** Desktop notification when an approval waits and the window is not focused. */
  notifyApprovals: boolean
  /** Desktop notification when a session drops without the user closing it. */
  notifyDisconnects: boolean
  /** Check for updates on start and every few hours (D8: the only thing Hopline sends on its own). */
  updateAutoCheck: boolean
  updateChannel: 'stable' | 'beta'
  /** Opt-in crash reports (D7), scrubbed before they leave. Off by default. */
  crashReports: boolean
  /** A Sentry or GlitchTip DSN for crash reports; empty: the one built into this release (if any). */
  crashReportDsn: string
  /** The first-run privacy screen was seen and answered. Nothing is checked or sent before that. */
  privacyReviewed: boolean
}

/** Fields computed by main; a settings patch can't set them. */
export type DerivedSettings = 'connectedAccounts' | 'cloudKeys' | 'hasApiKey' | 'apiKeyLast4' | 'aiConfigured'
export type SettingsPatch = Partial<Omit<Settings, DerivedSettings>>

// ------------------------------------------------------------------ AI providers

export type AiProviderId = AccountProvider | CloudProvider | 'ollama'

export const ANTHROPIC_MODELS: readonly { id: string; label: string; note: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable · default' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster, lower cost' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest, lowest cost' }
]
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434'

/**
 * Test (or connect) a provider. For Anthropic, `key` is a newly pasted key; without it main uses
 * the stored one. The key travels renderer → main once and is never returned.
 */
export interface AiTestRequest {
  provider: AiProviderId
  model: string
  key?: string
  endpoint?: string
  /** Ollama: the user acknowledged that this (remote, plain-http) endpoint is unencrypted. */
  insecureAck?: boolean
}

export type AiTestCode =
  | 'ok'
  | 'no_key'
  | 'invalid_key'
  | 'no_credits'
  | 'no_access'
  | 'model_not_found'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'vault_locked'
  | 'no_tools'
  | 'bad_endpoint'
  | 'insecure_endpoint'
  /** The team policy refuses this provider or server (docs/POLICY.md). */
  | 'policy'
  | 'other'

export interface AiTestResult {
  ok: boolean
  code: AiTestCode
  /** One line for the user: "Connected to Claude Opus 5.5" or what to do about the error. */
  message: string
  /** Display name of the model that answered. */
  modelLabel?: string
  /** Ollama: the model has no tool calling, so the assistant runs in suggest mode with it. */
  suggestMode?: boolean
  /** After a successful connect: the saved settings. */
  settings?: Settings
}

export interface OllamaModel {
  name: string
  sizeBytes: number
  parameterSize?: string
  family?: string
  /** From /api/show capabilities; null if the server is too old to say. False: suggest mode. */
  tools: boolean | null
  /** The model's context length (/api/show model_info `<arch>.context_length`); null if unknown. */
  contextLength: number | null
  /** The `num_ctx` Hopline will run it with (the context length, capped). */
  numCtx: number
}

/** Health of the connected provider (Trust UX): what answers, and how the model will be used. */
export interface AiHealth {
  ok: boolean
  provider: AiProviderId
  /** "api.anthropic.com" or the Ollama host:port. */
  destination: string
  /** Loopback Ollama: prompts stay on this machine. */
  local: boolean
  model: string
  message: string
  /** Ollama server version. */
  version?: string
  /** False: suggest mode (the model proposes commands as text; you run each one). */
  tools?: boolean | null
  contextLength?: number | null
  numCtx?: number
  latencyMs?: number
  /** The team policy refuses this provider or server. */
  policy?: string
}

/**
 * Model discovery. A failure carries one fixed category and a fixed message chosen in main: never
 * text from the server's response (L4).
 */
export type OllamaModelsError = 'invalid_url' | 'unreachable' | 'timeout' | 'http_error' | 'not_ollama' | 'policy'
export type OllamaModelsResult =
  | { ok: true; models: OllamaModel[]; remote: boolean; insecure: boolean }
  | { ok: false; code: AiTestCode; error: OllamaModelsError; message: string }

// ------------------------------------------------------------------ AI agent

export type StepStatus = 'running' | 'ok' | 'blocked' | 'refused' | 'timeout' | 'error' | 'capped'

/** Agent event without routing info, as produced inside the agent. */
export type AgentEventBody =
  | { type: 'thinking'; runId: string; text: string }
  | { type: 'text'; runId: string; text: string }
  | { type: 'step'; runId: string; stepId: string; command: string; status: StepStatus; kind?: Classification['kind']; reason?: string; durationMs?: number; bytes?: number; preview?: string
      /** F5b: the local filter, as a label ("grep /down/ · last 30 lines"). */
      filter?: string
      /** What the filter kept ("showing last 30 of 2,410 lines"), or why it failed. */
      filterNote?: string }
  | {
      type: 'proposal'
      runId: string
      proposalId: string
      commands: string[]
      rationale: string
      /** The platform's own lines around the change (configure terminal … end, configure … commit and-quit). */
      wrapper?: { before: string[]; after: string[]; abort?: string[] }
      /** The guard marks a line disruptive: the user approves by typing `confirm` (the device hostname). */
      disruptive?: { reasons: string[]; confirm: string }
      /** A single exec command (reload, clear …), not a configuration change. */
      exec?: boolean
      /** Why Hopline asks before running a read-only command (a ping to a name: a DNS lookup). */
      notice?: string
      /** Indexes of `commands` the command trees do not model ("Hopline doesn't recognise this command"). */
      unknown?: number[]
      /** Proposals v2: the lines that undo the change (shown; run on rollback when there is no device net). */
      rollback?: string[]
      /** Read-only commands run after the change, each with what the assistant expects to see. */
      verify?: { command: string; expect: string }[]
      /** The safety net armed on approval (or the rollback lines when the platform has none). */
      net?: ChangeNet
      /**
       * Lines that contain a long run of recent device output (an injection signal): per section,
       * the line index and the command whose output it appeared in.
       */
      copied?: { section: 'commands' | 'rollback' | 'verify'; index: number; from: string }[]
      /** Indexes of `commands` that enter a sub-mode, with the indexes of the lines typed in it (deselect together). */
      groups?: { head: number; members: number[] }[]
    }
  /** A pending proposal closed in main (decided, timed out or cancelled); the card must stop offering a decision. */
  | { type: 'proposal-closed'; runId: string; proposalId: string; reason: 'timeout' | 'cancelled' | 'decided' }
  /**
   * Proposals v2: the life of an approved change after the approval (arm, apply, verify, then the
   * user's confirm or rollback, or the device's own rollback when its timer expires). It can arrive
   * after the run ended, so it names its tab.
   */
  | ({ type: 'change'; runId: string; tabId: string; proposalId: string } & ChangeUpdate)
  | { type: 'done'; runId: string; error?: string }
  /** Per-run token budget (Trust UX): input-equivalent tokens used of the run's budget (fleet/budget.ts units). */
  | { type: 'usage'; runId: string; used: number; budget: number; inputTokens: number; outputTokens: number; costUsd: number | null; closing?: boolean }
  /** Suggest mode: the model proposed these commands as text; each runs only when the user clicks it. */
  | { type: 'suggestions'; runId: string; items: AgentSuggestion[] }
  /** The run is on a model without tool calling: it can only suggest commands. */
  | { type: 'mode'; runId: string; suggest: boolean }

/** A command the model proposed in suggest mode, classified by the guard in main. The renderer only sends its id back. */
export interface AgentSuggestion {
  id: string
  /** The line(s) as they will run. Several only for a block of configuration lines (one proposal). */
  commands: string[]
  kind: 'read' | 'config' | 'disruptive' | 'blocked'
  /** The guard's reason (shown for anything that is not a read). */
  reason: string
  /**
   * A configuration group with a disruptive line (`shutdown` under an interface): still one proposal
   * (`kind: 'config'`, the card asks for the typed hostname), labelled disruptive, not "config".
   */
  disruptive?: true
}

/** The safety net of a change (ARCHITECTURE §6.3). `kind: 'rollback-lines'`: the platform has none. */
export interface ChangeNet {
  kind: 'commit-confirmed' | 'session-timer' | 'checkpoint' | 'archive' | 'rollback-lines'
  label: string
  /** What happens without a confirmation, in one sentence. */
  detail: string
  /** The device rolls back by itself after this many minutes (timer nets). */
  minutes?: number
}

export type ChangePhase =
  /** Arming the net and applying the lines. */
  | 'applying'
  /** Applied and verified; waiting for the user's confirm or rollback. */
  | 'awaiting'
  /** Confirm or rollback in progress. */
  | 'confirming'
  | 'rolling-back'
  | 'confirmed'
  | 'rolled-back'
  /** The device's timer expired and it rolled the change back by itself. */
  | 'expired'
  /** Not applied (arming failed, a line failed on a candidate platform, refused). */
  | 'failed'
  /**
   * Hopline cannot tell the device's state (a commit that did not finish, an unreadable timer
   * check, an action whose result it could not verify): "state unknown — check the device". With
   * `actions` the change is still open (Confirm / Roll back check the device first); without, it is
   * closed and nothing more is sent for it.
   */
  | 'unknown'

export interface ChangeUpdate {
  phase: ChangePhase
  /** One line for the card (what happened, what is left on the device). */
  message?: string
  net?: ChangeNet
  /** Epoch ms when a timer net rolls back by itself. */
  deadline?: number
  /** The verify commands' redacted output, as run after the change. */
  verify?: { command: string; expect: string; status: StepStatus; output: string }[]
  /** The assistant's judgement of the verify output. */
  judgement?: { verified: boolean; summary: string }
  /** The lines the apply stopped at (partial). */
  partial?: boolean
  /** The user may still confirm or roll back. */
  actions?: ('confirm' | 'rollback')[]
}

/** Auto-detect progress for one tab (main → renderer, channel `term:platform`). */
export interface PlatformEvent {
  tabId: string
  sessionId: string
  state: 'detecting' | 'detected' | 'unknown'
  platform?: Platform
  version?: string
  model?: string
  /** Unknown: why (never reached a prompt, the probe did not tell). */
  reason?: string
}

/** Every event carries its tab so the renderer can route it before it knows the runId. */
export type AgentEvent = AgentEventBody & { tabId: string }

export interface AgentRequest {
  tabId: string
  prompt: string
  /** Optional selected terminal text for "Explain this output". */
  selection?: string
}

export interface AuditRow {
  id: number
  ts: number
  sessionName: string
  host: string
  /**
   * `app`: Hopline itself (the auto-detect probe), never on behalf of the model. `snippet`: a
   * snippet or button-bar button the user ran. `multi`: send-to-many and multi-device runs.
   * `backup`: a config backup capture. `transfer`: SFTP/SCP file operations; `forward`: port forwards.
   * `fleet`: a fleet run (F10): a worker's command, a refusal, or the scope's topology walk.
   */
  source: 'agent' | 'user' | 'app' | 'snippet' | 'multi' | 'backup' | 'transfer' | 'forward' | 'fleet' | 'capture' | 'safety-net'
  command: string
  kind: string
  decision: 'executed' | 'blocked' | 'refused' | 'rejected' | 'timeout' | 'capped' | 'error' | 'inserted' | 'cancelled' | 'verified' | 'not-verified' | 'confirmed' | 'rolled-back' | 'expired' | 'unknown'
  reason: string
  approver: string | null
  durationMs: number | null
  bytes: number | null
  redactions: number | null
  /** Fleet runs: the run id and the lane (the device's session name). Null for every other source. */
  runId?: string | null
  lane?: string | null
}

export interface KnownHost {
  host: string
  port: number
  fingerprint: string
  keyType: string
  source: 'tofu' | 'import' | 'user'
  addedAt: number
}

export interface KnownHostsImport {
  added: number
  alreadyKnown: number
  /** Hosts whose imported key differs from one Hopline already trusts: left untouched. */
  conflicts: { host: string; port: number }[]
  hashed: number
  skipped: number
  file: string
}

// ------------------------------------------------------------------ interactive prompts

/** Questions a connection asks the user mid-flight. Answers go back through prompts.answer. */
export type HostPrompt =
  | { kind: 'host-key-changed'; host: string; port: number; known: string; offered: string }
  | { kind: 'keyboard-interactive'; host: string; name: string; instructions: string; prompts: { prompt: string; echo: boolean }[] }
  | { kind: 'secret'; host: string; secret: 'password' | 'passphrase'; label: string }

export interface PromptRequest {
  id: string
  tabId?: string
  sessionName?: string
  prompt: HostPrompt
  /** 1 for a first ask; higher when the device rejected the previous answer. */
  attempt: number
  /** Why this is asked again ("Wrong password. Try again (attempt 2 of 3)."). */
  error?: string
}

/** host-key-changed → boolean (replace and connect); keyboard-interactive → string[]; secret → string. null cancels. */
export type PromptAnswer = boolean | string | string[] | null

// ------------------------------------------------------------------ export, import, folder sync (D3)

export interface ExportCounts {
  folders: number
  sessions: number
  credentials: number
  /** Credentials whose password, key or passphrase is in the file. */
  secrets: number
  knownHosts: number
  settings: boolean
}

export interface ExportResult {
  file: string
  counts: ExportCounts
}

/** A picked .hopline file, before the passphrase is entered. */
export interface ImportFile {
  token: string
  file: string
  createdAt: number
}

export interface ImportPreview {
  token: string
  file: string
  createdAt: number
  exportedAt: number
  includesSecrets: boolean
  counts: ExportCounts
  /** Same id here already: merge overwrites these with the file's version. */
  updates: { folders: number; sessions: number; credentials: number }
  /** Sessions with the same name and host as a local one under another id ("name (host)"). */
  duplicates: string[]
  /** The file trusts a different key than this machine: merge keeps the local key. */
  hostKeyConflicts: { host: string; port: number }[]
  /** Not in the file: replace deletes these. */
  localOnly: { folders: number; sessions: number; credentials: number; knownHosts: number }
  /**
   * "Retargeted (credentials removed)": sessions here that the file points at another host, port,
   * protocol or jump host, or gives agent forwarding. Their stored credential is detached.
   */
  retargeted: string[]
  /** Sessions the file connects with a credential stored here that they don't use here yet. */
  credentialAttached: string[]
  /** Host keys the file trusts for hosts it introduces or retargets: never imported (asked on first connect). */
  hostKeysWithheld: number
  /** Preferences that are applied (appearance only). */
  settingsApplied: string[]
  /** Preferences in the file that are never imported (security-relevant, machine-specific or unknown). */
  settingsIgnored: string[]
  /** Folder sync: local items the other machine deleted since; the merge removes them. */
  deletions: string[]
}

export interface ImportResult {
  mode: 'merge' | 'replace'
  folders: number
  sessions: number
  credentials: number
  knownHosts: number
  hostKeyConflicts: number
  settings: boolean
  /** Sessions whose credential was detached because the file retargeted them. */
  retargeted: number
  hostKeysWithheld: number
  /** Folder sync: items removed because the other machine deleted them. */
  deleted: number
}

export interface SyncStatus {
  enabled: boolean
  dir: string | null
  file: string | null
  includeSecrets: boolean
  lastWriteAt: number | null
  lastImportAt: number | null
  /** A sync file written elsewhere (newer than what this machine has seen). */
  incoming: { mtime: number } | null
  /** Writes wait while the vault is locked (the sync passphrase is in the vault). */
  paused: boolean
  error: string | null
}

// ------------------------------------------------------------------ session import (other tools, NetBox)

/** Where sessions come from. SecureCRT covers both the Sessions folder and the XML export. */
export type SessionImportSource = 'securecrt' | 'mobaxterm' | 'putty' | 'ssh-config' | 'csv' | 'netbox'

/** CSV columns the importer can map. Passwords are never mapped. */
export type CsvColumnField = 'name' | 'host' | 'port' | 'protocol' | 'username' | 'folder' | 'platform' | 'tags' | 'notes' | 'baud'

export interface SessionImportWarning {
  /** The record the warning is about: a session name, file, row or device. */
  item: string
  message: string
}

export type SessionImportStatus = 'new' | 'changed' | 'unchanged' | 'conflict'

/** One imported session in the preview. Never carries a password (the importers drop them). */
export interface SessionImportRow {
  /** Stable across re-plans of the same import: what `apply` refers to. */
  index: number
  status: SessionImportStatus
  name: string
  /** Where it lands: target folder, then the source folder when "keep source folders" is on. */
  folderPath: string[]
  host: string
  port: number
  protocol: Protocol
  username: string
  /** Null: the source did not say and no guess was made. */
  platform: Platform | null
  /** The platform was guessed from the name: confirm it. */
  platformGuessed: boolean
  /** The preview must ask for a platform ('missing') or should offer to confirm one ('guessed'). */
  platformPrompt: 'missing' | 'guessed' | null
  tags: string[]
  /** Jump hosts by session path, first hop first. */
  jump: string[]
  /** Changed / unchanged / some conflicts: the session already here. */
  existing?: { id: string; name: string; folderPath: string[] }
  /** Changed: which fields, as display text. */
  changes?: { field: string; from: string; to: string }[]
  /** Conflict: why the user has to decide (importing it anyway adds a separate session). */
  conflict?: { reason: 'ambiguous' | 'duplicate-in-import' | 'same-target'; message: string }
}

/** Re-sync: a session that came from this source but is gone from it now. Removed only when ticked. */
export interface SessionImportGoneRow {
  sessionId: string
  name: string
  folderPath: string[]
  host: string
}

export interface SessionImportOptions {
  /** Folder the import goes into (null: top level). */
  targetFolderId: string | null
  /** Recreate the source's folders below the target. */
  keepFolders: boolean
}

/** What main parsed, as a diff against what is here. The parsed data itself stays in main behind `token`. */
export interface SessionImportPlan {
  token: string
  source: SessionImportSource
  /** What was read: a file name, a folder, or the NetBox URL. */
  label: string
  /** A NetBox re-sync from the saved source. */
  resync: boolean
  rows: SessionImportRow[]
  gone: SessionImportGoneRow[]
  /** Folders the import would create, as paths. */
  newFolders: string[][]
  warnings: SessionImportWarning[]
  options: SessionImportOptions
  /** CSV only: the columns, so the user can map them when the header wasn't recognised. */
  csv?: {
    /** Positions, with the header text only when it is a recognised column title (never cell data). */
    columns: { index: number; header: string }[]
    hasHeader: boolean
    /** No host column was found: the preview must ask for a mapping. */
    needsMapping: boolean
    mapping: Partial<Record<CsvColumnField, number>>
  }
}

export interface SessionImportApply extends SessionImportOptions {
  token: string
  /** Row indexes to import (new and conflict rows are added, changed rows updated). */
  rows: number[]
  /** Re-sync: ids from `gone` to delete. */
  remove: string[]
  /** Platform per row index, for rows without one or with a guessed one. */
  platforms: Record<string, SessionPlatform>
}

export interface SessionImportOutcome {
  created: number
  updated: number
  removed: number
  /** Distinct folders the imported sessions are in (not counting the top level). */
  folders: number
  newFolders: number
  /** Jump hosts that could not be set because the jump session was not imported. */
  skippedJumps: number
  warnings: SessionImportWarning[]
}

/** The saved NetBox/Nautobot source for re-sync. The token stays in the vault. */
export interface NetBoxSource {
  url: string
  flavor: 'netbox' | 'nautobot'
  /** Query string of NetBox filters, e.g. "site=ams1&status=active". */
  filter: string
  targetFolderId: string | null
  keepFolders: boolean
  hasToken: boolean
  lastSyncAt: number | null
}

export interface NetBoxFetchRequest {
  url: string
  flavor: 'netbox' | 'nautobot'
  filter: string
  /** Omit to use the token saved in the vault. A new one is saved once a fetch succeeds. */
  token?: string
}

// ------------------------------------------------------------------ preload API

export interface SerialPortInfo {
  path: string
  label: string
  manufacturer?: string
  serialNumber?: string
  isUsb: boolean
}

/** The window frame, for the title bar: platform controls and traffic-light padding. */
export interface FrameState {
  platform: string
  maximized: boolean
  fullScreen: boolean
}

/** Help › About. */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  os: string
  license: string
}

export interface HoplineApi {
  /** Dev-build e2e run: side effects on the user's machine (clipboard) stay in memory. */
  testMode: boolean
  /** Phase 6: onboarding, per-host overrides, custom themes (shared/ux.ts), the bundled lab and deep links. */
  ux: {
    onboarding: { get(): Promise<import('./ux').OnboardingState>; set(s: import('./ux').OnboardingState): Promise<import('./ux').OnboardingState> }
    overrides: { get(): Promise<import('./ux').OverrideStore>; set(s: import('./ux').OverrideStore): Promise<import('./ux').OverrideStore> }
    themes: {
      get(): Promise<import('./ux').CustomTheme[]>
      set(list: import('./ux').CustomTheme[]): Promise<import('./ux').CustomTheme[]>
      /** Main's file picker, then parse (.json or .itermcolors). Null when cancelled. Nothing is stored. */
      import(): Promise<import('./theme-file').ThemeDraft | null>
      /** Main's save dialog; false when cancelled. */
      export(t: import('./ux').CustomTheme): Promise<boolean>
    }
    /** `hopline://settings/<section>/<key>` from the OS, validated in main. */
    onDeepLink(cb: (link: import('./settings-registry').DeepLink) => void): () => void
  }
  /** Available in the development build only. */
  lab?: {
    info(): Promise<{ running: boolean; sessionIds: string[] }>
    /** Start the bundled simulator lab on loopback and point the lab's sessions at it. */
    start(): Promise<{ running: boolean; sessionIds: string[] }>
  }
  scrollback: {
    /** Serialized xterm contents for a session (encrypted at rest). No-op without a secure keychain. */
    save(sessionId: string, data: string): Promise<void>
    load(sessionId: string): Promise<{ data: string; savedAt: number } | null>
    clear(sessionId?: string): Promise<void>
    /** Main asks every tab to save now (window close, quit); resolve once the saves were sent. */
    onFlush(cb: () => Promise<void> | void): () => void
  }
  knownHosts: {
    list(): Promise<KnownHost[]>
    remove(host: string, port: number): Promise<void>
    /** Import ~/.ssh/known_hosts (fixed path, read in main). */
    importOpenSsh(): Promise<KnownHostsImport>
  }
  serial: { list(): Promise<SerialPortInfo[]> }
  prompts: {
    onAsk(cb: (req: PromptRequest) => void): () => void
    /** The prompt was answered elsewhere or timed out. */
    onDone(cb: (id: string) => void): () => void
    answer(id: string, value: PromptAnswer): Promise<void>
  }
  sessions: {
    list(): Promise<{ folders: Folder[]; sessions: Session[] }>
    save(s: SessionInput): Promise<Session>
    remove(id: string): Promise<void>
    saveFolder(f: { id?: string; name: string; parentId: string | null }): Promise<Folder>
    removeFolder(id: string): Promise<void>
    move(sessionId: string, folderId: string | null): Promise<void>
    /** Move sessions and folders in one go (drag and drop). Folders never move into themselves. */
    moveMany(items: { sessionIds: string[]; folderIds: string[] }, folderId: string | null): Promise<void>
    bulkUpdate(ids: string[], patch: SessionPatch): Promise<Session[]>
    /** Quick connect: an unsaved session main knows about until its last tab closes. */
    createEphemeral(s: QuickSessionInput): Promise<Session>
    /** Delete sessions and folders in one transaction (saved terminal history goes too). */
    removeMany(items: { sessionIds: string[]; folderIds: string[] }): Promise<void>
    /** Persist a quick-connect session under the same id, so the open tab keeps working. */
    saveEphemeral(id: string, patch: { name: string; folderId: string | null }): Promise<Session>
    /** Set (or correct) the platform of a saved or quick-connect session; open tabs use it at once. */
    setPlatform(id: string, platform: SessionPlatform): Promise<Session>
  }
  credentials: {
    /** Metadata only: never a password, key or passphrase. */
    list(): Promise<CredentialInfo[]>
    save(c: CredentialInput): Promise<CredentialInfo>
    replacePasswords(ids: string[], password: string): Promise<number>
    remove(id: string): Promise<void>
    /** Main shows a file picker, reads and parses the key, and keeps it; null if cancelled. */
    importKey(): Promise<KeyImportInfo | null>
  }
  vault: {
    status(): Promise<VaultInfo>
    /** The password crosses to main once and is never stored or returned. */
    unlock(password: string): Promise<VaultInfo>
    lock(): Promise<VaultInfo>
    setMode(req: { mode: VaultMode; password?: string; current?: string }): Promise<VaultInfo>
    changePassword(current: string, next: string): Promise<VaultInfo>
    /** Master mode needs the current master password; main confirms turning it off. */
    setAutoLock(minutes: number, current?: string): Promise<VaultInfo>
    /** Broken keychain: try to unseal the data key again. */
    retryKeychain(): Promise<VaultInfo>
    /** Broken keychain: give up on it and start over with a master password (stored secrets are lost; main confirms). */
    resetToMaster(password: string): Promise<VaultInfo>
    /** User activity (throttled by the caller): pushes auto-lock back. */
    touch(): void
    onChange(cb: (v: VaultInfo) => void): () => void
    /** Main needs a stored secret while locked (connecting, reconnecting). */
    onUnlockRequest(cb: () => void): () => void
    /** The user declined to unlock: pending connects go on without stored secrets. */
    skipUnlock(): Promise<void>
  }
  data: {
    /** Main asks where to save (and confirms when secrets are included). Null if cancelled. */
    exportFile(req: { passphrase: string; includeSecrets: boolean }): Promise<ExportResult | null>
    pickImport(): Promise<ImportFile | null>
    previewImport(token: string, passphrase: string): Promise<ImportPreview>
    applyImport(token: string, mode: 'merge' | 'replace'): Promise<ImportResult>
    cancelImport(token: string): Promise<void>
  }
  sync: {
    status(): Promise<SyncStatus>
    /** Main shows a folder picker. */
    pickDir(): Promise<{ dirToken: string; dir: string } | null>
    enable(req: { dirToken: string; passphrase: string; includeSecrets: boolean }): Promise<SyncStatus>
    disable(): Promise<SyncStatus>
    syncNow(): Promise<SyncStatus>
    /** Decrypt the newer sync file with the stored passphrase; apply with data.applyImport. */
    previewIncoming(): Promise<ImportPreview>
    onStatus(cb: (s: SyncStatus) => void): () => void
  }
  importer: {
    /**
     * Main shows the native picker for `source` ('dir': SecureCRT's Sessions folder; 'default': the
     * standard location, ~/.ssh/config), reads and parses it. Null if cancelled.
     */
    pick(source: Exclude<SessionImportSource, 'netbox'>, mode?: 'file' | 'dir' | 'default'): Promise<SessionImportPlan | null>
    fetchNetBox(req: NetBoxFetchRequest): Promise<SessionImportPlan>
    /** Fetch again from the saved NetBox source; sessions gone from it are listed in `gone`. */
    resyncNetBox(): Promise<SessionImportPlan>
    /** Re-plan with another target folder, folder mode or CSV column mapping. */
    plan(token: string, options: SessionImportOptions & { csv?: { mapping: Partial<Record<CsvColumnField, number>>; hasHeader: boolean } }): Promise<SessionImportPlan>
    apply(req: SessionImportApply): Promise<SessionImportOutcome>
    cancel(token: string): Promise<void>
    netBoxSource(): Promise<NetBoxSource | null>
    /** Delete the saved source and its token. */
    forgetNetBox(): Promise<void>
  }
  term: {
    open(tabId: string, sessionId: string, cols: number, rows: number, password?: string): Promise<TabInfo>
    write(tabId: string, data: string): void
    resize(tabId: string, cols: number, rows: number): void
    /** Flow control: tell the session host `n` characters of output have been rendered. */
    ack(tabId: string, n: number): void
    sendBreak(tabId: string): void
    setSignals(tabId: string, s: { dtr?: boolean; rts?: boolean }): void
    /** Serial tabs: DTR, RTS and BREAK as the port has them (status bar). */
    onVitals(cb: (tabId: string, sample: SessionVitals) => void): () => void
    onSignals(cb: (tabId: string, lines: SerialLines) => void): () => void
    close(tabId: string): Promise<void>
    reconnect(tabId: string, password?: string): Promise<void>
    onData(cb: (tabId: string, data: string) => void): () => void
    onState(cb: (info: TabInfo) => void): () => void
    /** Auto-detect progress and results. */
    onPlatform(cb: (e: PlatformEvent) => void): () => void
  }
  /** Command blocks: re-run goes through main's guard (a read runs via the executor; anything else is only inserted). */
  blocks: {
    rerun(tabId: string, command: string): Promise<{ action: 'ran'; status: 'ok' | 'timeout' | 'capped' | 'error'; error?: string } | { action: 'insert'; command: string; reason: string }>
  }
  agent: {
    run(req: AgentRequest): Promise<{ runId: string }>
    cancel(runId: string): Promise<void>
    /**
     * `ack`: the hostname typed to approve a disruptive proposal. `lines`: the indexes of the
     * proposal's lines the user ticked (all when omitted); main re-checks the subset.
     */
    decide(proposalId: string, approve: boolean, ack?: string, lines?: number[]): Promise<void>
    /** Confirm or roll back an applied change (the user only; the model never confirms). */
    change(proposalId: string, action: 'confirm' | 'rollback'): Promise<void>
    reset(tabId: string): Promise<void>
    /** Suggest mode: run a command the model suggested, by its id (main holds the command). */
    runSuggestion(suggestionId: string): Promise<{ runId: string }>
    onEvent(cb: (e: AgentEvent) => void): () => void
  }
  /** "What left this machine": every model request as sent (encrypted, local). */
  egress: {
    list(q?: EgressQuery): Promise<EgressRow[]>
    /** Like `list`, and says whether the payloads were searched too (not while the vault is locked). */
    search(q?: EgressQuery): Promise<EgressSearch>
    get(id: number): Promise<EgressDetail | null>
    stats(): Promise<EgressStats>
    /** Write rows (all when `ids` is empty) as JSON Lines to a file chosen in main's save dialog. */
    exportTo(ids?: number[]): Promise<{ file: string | null; rows: number }>
  }
  /** The team policy (docs/POLICY.md), as loaded in main. */
  policy: {
    info(): Promise<PolicyInfo>
  }
  /** Auto-update (Phase 7). Never restarts while a session is open. */
  updates: {
    status(): Promise<UpdateStatus>
    /** "Check now": works with automatic checks off, never against the team policy. */
    check(): Promise<UpdateStatus>
    /** Install now and restart: refused in main while any session is open. */
    restart(): Promise<RestartResult>
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
  /** Opt-in crash reports (D7). */
  crash: {
    status(): Promise<CrashStatus>
    /** A synthetic error through the real pipeline; never crashes a process. */
    test(): Promise<{ ok: boolean; status: number | null; id: string | null }>
    /** A renderer error; main drops it unless reports are on, and scrubs it. */
    report(e: RendererError & { kind: 'exception' | 'rejection' | 'render' }): Promise<void>
    /** Main asks for confirmation itself before sending a native dump. */
    sendDump(id: string): Promise<{ ok: boolean; reason?: 'off' | 'missing' | 'cancelled' | 'failed' }>
    deleteDump(id: string): Promise<boolean>
    /** Delete every native dump on this machine; returns how many. */
    deleteAllDumps(): Promise<number>
  }
  audit: {
    list(limit?: number): Promise<AuditRow[]>
  }
  workspaceChat: import('./workspace-chat').WorkspaceChatApi
  packets: import('./packets').PacketsApi
  /** SFTP/SCP file transfers (shared/files.ts). */
  transfer: TransferApi
  /** Port forwarding per tab (shared/files.ts). */
  forward: ForwardApi
  /** Config backups. Config text is always redacted; there is no restore (nothing is pushed to a device). */
  backups: {
    list(sessionId?: string): Promise<BackupVersion[]>
    get(id: string): Promise<BackupText>
    take(sessionIds: string[]): Promise<BackupResult[]>
    /** The running config now (captured through the guard, audited, not stored). */
    live(sessionId: string): Promise<BackupText>
    /** The device was renamed: back it up once more, accepting exactly this new name (audited). */
    acceptRename(sessionId: string, hostname: string): Promise<BackupResult>
    remove(id: string): Promise<void>
    /** Write a version to a file chosen in main's save dialog. Redacted unless `includeSecrets` (main confirms). */
    exportVersion(id: string, includeSecrets: boolean): Promise<{ file: string | null }>
    schedules(): Promise<(BackupSchedule & { sessions: number })[]>
    saveSchedule(s: BackupScheduleInput): Promise<BackupSchedule>
    removeSchedule(id: string): Promise<void>
    retention(): Promise<BackupRetention>
    setRetention(r: BackupRetention): Promise<BackupRetention>
    onChanged(cb: () => void): () => void
  }
  ai: {
    /** Make a minimal real request with these settings; nothing is saved. */
    account(provider: AccountProvider, action: AccountAction): Promise<AccountState>
    test(req: AiTestRequest): Promise<AiTestResult>
    /** Test, and on success save the provider, model and key (Anthropic) or endpoint (Ollama). */
    connect(req: AiTestRequest): Promise<AiTestResult>
    /** Models installed on an Ollama server, with tool-calling support. */
    ollamaModels(endpoint: string): Promise<OllamaModelsResult>
    /** Health of the connected provider (no tokens spent). */
    health(): Promise<AiHealth>
  }
  links: {
    /** Open an http(s) link in the OS browser (main refuses anything else). Ask the user first. */
    open(url: string): Promise<void>
  }
  /** Assistive technology (docs/ACCESSIBILITY.md). */
  a11y: {
    /** The OS reports an active screen reader (Electron's accessibilitySupportEnabled). */
    screenReader(): Promise<boolean>
    onScreenReader(cb: (on: boolean) => void): () => void
  }
  /** The frameless window's own controls (Windows and Linux) and its state. */
  frame: {
    state(): Promise<FrameState>
    minimize(): Promise<void>
    toggleMaximize(): Promise<FrameState>
    /** Same as the OS close: asks first when sessions are open. */
    close(): Promise<void>
    onState(cb: (s: FrameState) => void): () => void
  }
  /** The application menu (shared/menu.ts): the native macOS menu, the dock, the jump list. */
  menu: {
    /** What the menu shows now (labels, enabled, checked, keys, recent sessions, tabs). Display only. */
    setState(snapshot: import('./menu').MenuSnapshot): Promise<void>
    /** A native menu, the dock or the jump list chose a command. The renderer re-checks and runs it. */
    onCommand(cb: (c: { id: string; arg?: string }) => void): () => void
  }
  /** App-level commands main carries out (window, zoom, help links, quit) and the About details. */
  app: {
    command(id: import('./menu').MainCommand): Promise<void>
    info(): Promise<AppInfo>
    /** File › Save output as…: main asks where (its own dialog) and writes the text there. */
    saveOutput(name: string, text: string): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    setApiKey(key: string | null, provider?: CloudProvider): Promise<Settings>
  }
  /** Rebound shortcuts (Settings → Keyboard). */
  keymap: {
    get(): Promise<Keymap>
    set(km: Keymap): Promise<Keymap>
  }
  /** Snippets and the button bar. Bodies are filled and classified in main; the renderer sends ids and values. */
  snippets: {
    list(): Promise<Snippet[]>
    save(s: SnippetInput): Promise<Snippet>
    remove(id: string): Promise<void>
    reorder(ids: string[]): Promise<Snippet[]>
    /** Classify a run snippet for a tab: what will run, and what it needs (confirmation, typed hostname). */
    prepare(snippetId: string, tabId: string, vars: Record<string, string>): Promise<CommandPlan>
    /** Run (approve) or decline a prepared plan. */
    run(planId: string, approve: boolean, ack?: string): Promise<CommandRunResult>
    /** Insert snippet: the filled line to type at the prompt (no Enter). */
    insert(snippetId: string, tabId: string, vars: Record<string, string>): Promise<{ text: string; kind: string; reason: string }>
  }
  /** Send-to-many and multi-device runs. Targets are resolved and every line classified in main. */
  multi: {
    info(): Promise<{ parser: boolean; maxTargets: number; maxConcurrency: number }>
    resolve(targets: TargetSpec): Promise<ResolvedTarget[]>
    preview(req: MultiPreviewRequest): Promise<MultiPreview>
    start(req: MultiStartRequest): Promise<{ runId: string }>
    cancel(runId: string): Promise<void>
    /** Leave a preview without starting it (a configuration preview is audited as declined). */
    decline(previewId: string): Promise<void>
    onEvent(cb: (e: MultiEvent) => void): () => void
  }
  /** Fleet agent (F10, read-only investigation). Scopes are resolved and stored in main; runs start by scope id. */
  fleet: {
    info(): Promise<FleetInfo>
    scope(spec: FleetScopeSpec): Promise<FleetScopePreview>
    /** "@ai … @edge-r1": resolve the mentions in the user's text (saved sessions only) and, when they all resolve, the scope preview. */
    mentions(req: FleetMentionRequest): Promise<FleetMentionResult>
    start(req: FleetStartRequest): Promise<{ runId: string }>
    cancel(runId: string): Promise<void>
    /** Stop one lane of a run (the rest goes on). */
    cancelLane(runId: string, lane: string): Promise<boolean>
    onEvent(cb: (e: FleetEvent) => void): () => void
  }
}
