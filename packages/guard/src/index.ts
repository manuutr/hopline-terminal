export {
  PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_VENDORS,
  GUARD_PLATFORMS,
  SESSION_PLATFORMS,
  SESSION_PLATFORM_LABELS,
  isPlatform,
  type Platform,
  type GuardPlatform,
  type SessionPlatform
} from './platforms'
export {
  classify,
  classifyConfigLines,
  isConfirmationPrompt,
  answerConfirmation,
  MAX_COMMAND_LENGTH,
  type Classification,
  type ClassifyOptions,
  type CommandClass,
  type ConfirmationDecision
} from './classify'
export { redact, REDACTED, REDACT_RULES, REDACT_RULESET_VERSION, SECRET_KEYWORDS, type RedactResult, type RedactRule } from './redact'
// Re-exported so the app needs no direct cli-model dependency for prompt-mode detection.
export { detectMode, fingerprint, probeCommand, type DetectedMode, type ModeId, type Evidence, type Fingerprint, type Probe } from '@hopline/cli-model'
