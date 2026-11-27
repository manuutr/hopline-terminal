import type { CloudProvider, AccountProvider } from './providers'
/**
 * Team policy (docs/POLICY.md): what the renderer learns about it. Pure types, no Node APIs.
 * The policy itself is loaded, validated and enforced in main.
 */

export type PolicyProvider = AccountProvider | CloudProvider | 'ollama'

/** Settings and limits a policy fixes; the UI shows "Managed by policy" on each. */
export interface PolicyLocks {
  /** Read-only mode is forced on. */
  readOnly: boolean
  /** Providers the user may connect; null: any. */
  allowedProviders: PolicyProvider[] | null
  /** Ollama servers allowed (exact origins); null: any. */
  allowedOllamaEndpoints: string[] | null
  /** Extra blocked command patterns, per platform key ("all" applies everywhere). */
  blockedCommands: Record<string, string[]>
  fleetMaxConcurrency: number | null
  fleetMaxTokenBudget: number | null
  /** Per-run token budget cap for the chat assistant. */
  runMaxTokenBudget: number | null
  /** The "what left this machine" log can't be turned off, and a request is not sent if it can't be logged. */
  egressLogRequired: boolean
  /** AI is off (an invalid policy fails closed). */
  aiDisabled: boolean
  /** No update checks at all, "Check now" included (D8: the only phone-home). */
  updatesDisabled: boolean
  /** The update channel is fixed; null: the user picks. */
  updateChannel: UpdateChannel | null
  /** Crash reports cannot be turned on. */
  crashReportsDisabled: boolean
  /** Crash reports, when a user opts in, go to this DSN (a self-hosted Sentry or GlitchTip); null: the user's or the built-in one. */
  crashReportDsn: string | null
}

export type UpdateChannel = 'stable' | 'beta'

export type PolicyInfo =
  | { state: 'none'; source: string | null; locks: PolicyLocks }
  | { state: 'active'; source: string; name: string | null; message: string | null; locks: PolicyLocks }
  /** The file exists but is not a valid policy: read-only on, AI off. */
  | { state: 'invalid'; source: string; error: string; locks: PolicyLocks }

export const NO_LOCKS: PolicyLocks = {
  readOnly: false,
  allowedProviders: null,
  allowedOllamaEndpoints: null,
  blockedCommands: {},
  fleetMaxConcurrency: null,
  fleetMaxTokenBudget: null,
  runMaxTokenBudget: null,
  egressLogRequired: false,
  aiDisabled: false,
  updatesDisabled: false,
  updateChannel: null,
  crashReportsDisabled: false,
  crashReportDsn: null
}

export const MANAGED_BY_POLICY = 'Managed by policy'
