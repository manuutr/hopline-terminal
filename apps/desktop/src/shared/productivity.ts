/**
 * Phase 4 productivity types shared by main, preload and renderer: keymap, snippets and the
 * button bar, guarded command plans, send-to-many and multi-device runs.
 */
import type { SessionPlatform } from './types'

/** Action id → its keys, for the actions the user rebound. Anything absent uses the defaults. */
export type Keymap = Record<string, string[]>

// ------------------------------------------------------------------ snippets and the button bar

export type SnippetScope = { kind: 'global' } | { kind: 'folder'; id: string } | { kind: 'session'; id: string }

export interface Snippet {
  id: string
  name: string
  /** One command per line. `{{name}}` placeholders are filled in before it runs. */
  body: string
  /** insert: typed at the prompt without Enter (one line). run: sent through the guard and executed. */
  mode: 'insert' | 'run'
  scope: SnippetScope
  /** The platforms it applies to; empty means every platform. */
  platforms: SessionPlatform[]
  /** Shown on the button bar. */
  onBar: boolean
  updatedAt: number
}

export type SnippetInput = Omit<Snippet, 'id' | 'updatedAt'> & { id?: string }

/** A variable in a snippet body, in order of first use. `source` is where autocomplete values come from. */
export interface SnippetVar {
  name: string
  source?: 'interfaces' | 'vlans' | 'vrfs' | 'bgp-neighbors' | 'ospf-neighbors'
}

// ------------------------------------------------------------------ guarded command plans

export type LineKind = 'read' | 'config' | 'disruptive' | 'blocked'

/** What a plan is, overall: the most dangerous line wins; `refused` means it can't run here at all. */
export type PlanKind = LineKind | 'refused'

export interface PlanLine {
  command: string
  kind: LineKind
  reason: string
}

/**
 * The guard's view of one command (or block) on one device, computed in main. Display only: main
 * stores the lines behind `planId` and classifies them again when they run.
 */
export interface CommandPlan {
  planId: string
  kind: PlanKind
  /** Why it is blocked, refused or needs confirmation, in words for the user. */
  reason: string
  lines: PlanLine[]
  /** Lines Hopline adds around a configuration change on this platform (configure terminal … end). */
  wrapper?: { before: string[]; after: string[] }
  /** Disruptive: the device hostname the user must type to approve. */
  confirm?: string
  sessionName: string
  platform: string
  /** The hostname the prompt showed when the plan was made (the change is bound to it). */
  hostname: string
}

export type RunStatus = 'ok' | 'error' | 'timeout' | 'capped' | 'refused' | 'blocked' | 'rejected' | 'partial' | 'cancelled'

export interface CommandRunResult {
  status: RunStatus
  /** Redacted device output, capped. */
  output: string
  reason?: string
  redactions: number
}

// ------------------------------------------------------------------ send-to-many and multi-device runs

/** What the user picked. Main resolves it to sessions (folders recursively) with a device cap. */
export interface TargetSpec {
  /** Open tabs (their sessions, using those tabs). */
  tabs?: string[]
  sessions?: string[]
  folders?: string[]
  tags?: string[]
}

export interface ResolvedTarget {
  /** Stable key for the run: the session id. */
  key: string
  sessionId: string
  name: string
  host: string
  platform: SessionPlatform
  /** An open tab of this session that the run will use (otherwise a background connection). */
  tabId?: string
  /** Open tabs: the hostname the prompt showed at preview (the run is bound to it). */
  hostname?: string
  /** Why this target can't take part (unknown platform, serial). */
  excluded?: string
}

export type MultiMode = 'send' | 'run'

export interface MultiPreviewRequest {
  mode: MultiMode
  targets: TargetSpec
  /** One command per line (send-to-many may send a configuration block). */
  command: string
  /**
   * Multi-device runs: translate the command to each platform's equivalent where the cli-model
   * mapping has one ("show interfaces status" → Junos "show interfaces terse").
   */
  perPlatform?: boolean
}

export interface MultiPreviewRow {
  target: ResolvedTarget
  /** The exact lines this device will get (after translation). */
  lines: PlanLine[]
  kind: PlanKind
  reason: string
  wrapper?: { before: string[]; after: string[] }
  /** Translated from the typed command through the equivalents table. */
  translated?: boolean
}

export interface MultiPreview {
  previewId: string
  mode: MultiMode
  rows: MultiPreviewRow[]
  /** Rows that will run, by kind. */
  counts: { read: number; config: number; refused: number }
  /** True when at least one target needs the config confirmation. */
  needsConfirm: boolean
}

export type TargetStatus = 'queued' | 'connecting' | 'running' | RunStatus | 'skipped'

/** A parsed table (TextFSM), from the parsers workstream when it is installed. */
export interface ParsedTable {
  /** Full number of parsed rows when main sent a capped table. */
  totalRows?: number
  template: string
  headers: string[]
  rows: (string | string[])[][]
}

export interface MultiEvent {
  runId: string
  key: string
  status: TargetStatus
  /** Set once the target finished: redacted, capped output. */
  output?: string
  reason?: string
  durationMs?: number
  /** The command(s) the device got. */
  command?: string
  /** Whether a background connection was used (vs an open tab). */
  background?: boolean
  table?: ParsedTable
  /** Last event of the run. */
  done?: boolean
}

export interface MultiStartRequest {
  previewId: string
  /** The user confirmed the configuration change on every config target. */
  confirmConfig: boolean
  /** Targets run at once (1–8). */
  concurrency: number
}
