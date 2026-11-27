export * from './types'
export { PROFILES } from './profiles'
export { PARAMS, matchParam, canonicalInterface, isIpv4, LIVE_SOURCES } from './params'
export { compile, countCommands, parseSpec, forbidsWord, shellFilter, SHELL_FILTERS, R, C, D, B, N, type Entry, type EntryOpts, type TreeSource } from './dsl'
export { TREES } from './trees'
export { getPlatform, type PlatformModel } from './registry'
export { detectMode } from './detect'
export { CONFIG_SESSIONS, type ConfigSession } from './config-session'
export { EQUIVALENTS, equivalentOf, type Equivalent } from './equivalents'
export { fingerprint, probeCommand, type Evidence, type Fingerprint, type Probe } from './identify'
export {
  resolve,
  complete,
  tokenize,
  type Resolution,
  type ResolvedToken,
  type SegmentResolution,
  type PipeStage,
  type Completion,
  type Candidate,
  type Token
} from './engine'

import { PLATFORM_IDS, type PlatformId } from './types'
import { PROFILES } from './profiles'

export const PLATFORM_LABELS: Readonly<Record<PlatformId, string>> = Object.fromEntries(PLATFORM_IDS.map((p) => [p, PROFILES[p].label])) as Record<PlatformId, string>
export { BACKUP_COMMANDS } from './backup'
export { SAFETY_NETS, NET_NAME_RE, NET_MINUTES, ARCHIVE_FILE_RE, safetyNet, netLineAllowed, junosNetState, junosNetAbsent, eosNetState, archiveSucceeds, type NetKind, type NetState, type NetTemplate, type SafetyNetSpec } from './safety-net'
export { canonicalize, matchWord, abbreviates, type Canonical, type WordMatch } from './canonical'
export { probeOf, probeRisk, isIpLiteral, isSourceValue, PROBE_CAPS, type ProbeInfo, type ProbeOption, type ProbeVerb } from './probe'
