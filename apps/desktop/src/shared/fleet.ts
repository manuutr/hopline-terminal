import type { SessionPlatform, StepStatus, Classification } from './types'

/**
 * Fleet agent (F10, read-only investigation): what crosses between main and the renderer.
 * Everything a run touches is resolved and stored in main; the renderer sends ids and the question.
 */

/** What the user picked. Resolved in main (`fleet:scope`), never trusted as a device list. */
export interface FleetScopeSpec {
  sessions?: string[]
  folders?: string[]
  tags?: string[]
  /** Start from this session and walk CDP/LLDP neighbours, matched to saved sessions. */
  topology?: { seed: string; hops: 1 | 2 }
}

export interface FleetScopeDevice {
  sessionId: string
  /** The saved session's name: the only way a model can refer to the device. */
  name: string
  platform: SessionPlatform
  /** Tags, shown as the device's role in the coordinator's scope table. */
  tags: string[]
  /** Why this device is not in the run (unknown platform, needs sign-in, over the cap…). */
  excluded?: string
  /** How it got into the scope. */
  via: 'session' | 'folder' | 'tag' | 'seed' | 'topology'
  /** Topology matches: how the neighbour was matched to this session, and where it was seen. */
  match?: { by: 'name' | 'short name' | 'host' | 'ip'; neighbor: string; seenFrom: string }
  /** Not selected until the user ticks it (topology matches: device-controlled text chose them). */
  optIn?: boolean
}

/** A CDP/LLDP neighbour with no saved session: listed for the user, never contacted, never shown to a model. */
export interface FleetUnmatched {
  /** Device-controlled text: capped, shown as plain text only. */
  name: string
  ip?: string
  /** The saved session whose neighbour table listed it. */
  seenFrom: string
}

export interface FleetBudget {
  /** Input-equivalent tokens for the whole run (coordinator keeps 25%, the rest is split over lanes). */
  tokens: number
  /** Wall clock for the whole run. */
  runMs: number
  /** Wall clock per lane (worker). */
  laneMs: number
  /** Lanes that run at once. */
  concurrency: number
}

export interface FleetScopePreview {
  scopeId: string
  devices: FleetScopeDevice[]
  unmatched: FleetUnmatched[]
  /** Commands the topology walk ran (audited, source `fleet`). */
  walked: { device: string; command: string; status: string }[]
  budget: FleetBudget
  limits: { maxDevices: number; maxConcurrency: number }
}

export interface FleetStartRequest {
  scopeId: string
  question: string
  /** The user's final selection, a subset of the stored preview (default: every included device that is not opt-in). */
  sessionIds?: string[]
  concurrency?: number
  tokenBudget?: number
}

export type LaneStatus = 'idle' | 'queued' | 'connecting' | 'running' | 'found' | 'not_found' | 'blocked' | 'error' | 'timeout' | 'cancelled' | 'excluded'

export interface FleetEvidence {
  command: string
  lines: string[]
}

/** A worker's report as main verified and capped it. */
export interface FleetReport {
  status: 'found' | 'not_found' | 'blocked' | 'error'
  findings: string[]
  evidence: FleetEvidence[]
  confidence: 'low' | 'medium' | 'high'
  /** Config changes are never proposed in an investigation: a worker may only describe one here. */
  recommendations: string[]
  /** Evidence lines dropped because they were not in this lane's recorded output. */
  unverified: number
  /** Notes from main: dropped lines, copied text, caps. */
  flags: string[]
}

export interface FleetStep {
  stepId: string
  command: string
  status: StepStatus
  kind?: Classification['kind']
  reason?: string
  durationMs?: number
  bytes?: number
  preview?: string
  filter?: string
  filterNote?: string
  /** This command contains text that appeared in device output (this lane or another). */
  copiedFrom?: string
}

export interface FleetUsage {
  inputTokens: number
  outputTokens: number
  /** Prompt-cache reads and writes (Anthropic), not included in inputTokens. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** What the budget counts (input-equivalent: cache reads 0.1x, cache writes 1.25x, output 5x): the header shows this against the budget. */
  metered: number
  /** Null for local models and models without a known price (tokens only). */
  costUsd: number | null
}

export type FleetEvent = { runId: string } & (
  | { type: 'run'; status: 'running' | 'done' | 'cancelled' | 'error'; error?: string; question: string; devices: { name: string; platform: SessionPlatform; excluded?: string }[]; budget: FleetBudget; startedAt: number }
  | { type: 'usage'; usage: FleetUsage; elapsedMs: number }
  | { type: 'plan'; tasks: { device: string; task: string }[] }
  | { type: 'lane'; lane: string; status: LaneStatus; task?: string; reason?: string; background?: boolean; report?: FleetReport }
  | { type: 'step'; lane: string; step: FleetStep }
  | { type: 'text'; text: string }
  | { type: 'note'; text: string }
)

/** Device @-mentions in an "@ai …" question (F11): resolved in main against saved sessions only. */
export interface FleetMentionRequest {
  /** The question as the user typed it, with its mentions ("why is bgp down here and on @edge-r1"). */
  text: string
  /** The session of the tab it was typed in (the first device), or null. */
  sessionId: string | null
}

/** A mention that names no saved session, or more than one. Blocks the start until it is fixed. */
export interface FleetMentionError {
  /** The mention as typed ("@edge-r9"). */
  raw: string
  kind: 'session' | 'tag' | 'folder'
  ref: string
  message: string
  /** Ambiguous: the matches to pick from (a session's host is shown to tell them apart). */
  candidates?: { name: string; detail: string }[]
}

/** The tab the question came from: its saved session, or a quick-connect tab that can't take part. */
export type FleetMentionCurrent = { sessionId: string; name: string } | { quick: true }

export interface FleetMentionResult {
  /** The plain question (mentions turned into names). */
  question: string
  /** The scope the mentions name (the current session first). */
  spec: FleetScopeSpec
  errors: FleetMentionError[]
  current: FleetMentionCurrent | null
  /** Resolved when there are no errors; the user starts the run from it (the consent step). */
  preview: FleetScopePreview | null
}

export interface FleetInfo {
  maxDevices: number
  maxConcurrency: number
  defaults: FleetBudget
}
