import { resolve } from './engine'
import { PROFILES } from './profiles'
import { PLATFORM_IDS, type EvidenceKind, type FingerprintSignal, type PlatformId } from './types'

/** What is known about a device before (or right after) logging in. */
export interface Evidence {
  /** The server's SSH identification string (`SSH-2.0-Cisco-1.25`). */
  sshServerVersion?: string
  /** Pre- or post-login banner text. */
  banner?: string
  /** The prompt line, or the terminal tail ending in it. */
  prompt?: string
  /** Output of the platform's version command (`show version`, `show system info`, `get system status`). */
  showVersion?: string
}

export interface Fingerprint {
  platform: PlatformId | 'unknown'
  /** 0..1 for the chosen platform (or the best guess when `platform` is unknown). */
  confidence: number
  version?: string
  model?: string
  /** Human-readable signals that matched for the chosen platform (or the best guess). */
  evidence: string[]
  /** Every platform with a non-zero score, best first. */
  candidates: { platform: PlatformId; score: number }[]
}

/** A decision needs this score, and this lead over the runner-up. */
const THRESHOLD = 0.5
const MARGIN = 0.15

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n')
}

function matches(s: FingerprintSignal, ev: Evidence): string | undefined {
  const raw = ev[s.kind as EvidenceKind]
  if (!raw) return undefined
  const text = clean(raw)
  const last =
    text
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .at(-1) ?? ''
  const hit = s.re.test(text) || (s.kind === 'prompt' && s.re.test(last))
  if (!hit || s.unless?.test(text)) return undefined
  return text
}

/**
 * Identify the platform from whatever evidence exists. Weak, shared signals (plain OpenSSH, a
 * bare `host#`) never decide on their own: the answer stays `'unknown'`, and the guard denies
 * everything on an unknown platform. Only version text tells IOS from IOS-XE.
 */
export function fingerprint(ev: Evidence): Fingerprint {
  const scored = PLATFORM_IDS.map((platform) => {
    let miss = 1
    const notes: string[] = []
    let version: string | undefined
    let model: string | undefined
    for (const s of PROFILES[platform].fingerprint) {
      const text = matches(s, ev)
      if (text === undefined) continue
      miss *= 1 - s.weight
      notes.push(`${s.kind}: ${s.note}`)
      if (s.version && !version) {
        const m = s.version.exec(text)
        version = m?.slice(1).find(Boolean)
      }
      if (s.model && !model) model = s.model.exec(text)?.[1]
    }
    return { platform, score: Math.round((1 - miss) * 1000) / 1000, notes, version, model }
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  const [top, second] = scored
  const candidates = scored.map(({ platform, score }) => ({ platform, score }))
  if (!top) return { platform: 'unknown', confidence: 0, evidence: [], candidates }
  const decided = top.score >= THRESHOLD && top.score - (second?.score ?? 0) >= MARGIN
  return {
    platform: decided ? top.platform : 'unknown',
    confidence: top.score,
    version: top.version,
    model: top.model,
    evidence: decided ? top.notes : [...top.notes, `undecided between ${scored.slice(0, 3).map((x) => x.platform).join(', ')}`],
    candidates
  }
}

export interface Probe {
  /** The command to send (plain: no pipe; the executor pages through `--More--` itself). */
  command: string
  /** Candidates on which `command` resolves as a read-only command. */
  covers: PlatformId[]
  /** Candidates it does not cover; probe again with what the first probe revealed. */
  others: PlatformId[]
}

/**
 * The safest read-only command that tells the remaining candidates apart: each platform's own
 * version command, choosing the one that is read-only on the most candidates (best guess first).
 * With no evidence at all, every platform is a candidate.
 */
export function probeCommand(partial: Evidence | Fingerprint = {}): Probe {
  const fp = 'candidates' in partial ? partial : fingerprint(partial)
  const cands: PlatformId[] =
    fp.platform !== 'unknown' ? [fp.platform] : fp.candidates.length ? fp.candidates.map((c) => c.platform) : [...PLATFORM_IDS]
  const probes = [...new Set(cands.map((p) => PROFILES[p].probe))]
  let best: Probe | undefined
  for (const command of probes) {
    const covers = cands.filter((p) => resolve(p, 'exec', command).risk === 'read')
    if (!best || covers.length > best.covers.length) best = { command, covers, others: cands.filter((p) => !covers.includes(p)) }
  }
  return best!
}
