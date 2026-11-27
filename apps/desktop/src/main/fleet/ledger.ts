/**
 * What each lane's device actually said, and what the coordinator was shown, for the cross-checks
 * of FLEET-AGENT §7:
 * - evidence verification: a report's evidence line counts only if it occurred in that worker's
 *   recorded output (unmatched lines are dropped and flagged), and its command is the recorded one;
 * - copied-text detection across lanes: a task, command or recommendation that contains a long run
 *   of another lane's text is flagged (or refused) with the device it came from.
 *
 * Only REDACTED output is recorded (the executor result passes through `redact` first, exactly as
 * DeviceTools does before the model sees it), so neither check can become an oracle on a secret.
 *
 * Cost (review M3): the cross-lane check never scans raw output. Text from another device can reach
 * a model only through the coordinator, and the coordinator only ever sees framed reports (≤ 4 kB
 * each), so tasks and worker commands are compared with those reports. Recommendations are compared
 * with the worker's own recorded output (its only other input). Both sides are lower-cased: an
 * upper-cased relay is still a relay.
 */

/** An evidence line must be at least this long (after whitespace is normalised)... */
import { mentions } from './reach'

export const MIN_EVIDENCE_CHARS = 20
/** ...or, when shorter (down to this), cover most of the recorded line it came from. */
export const MIN_SHORT_EVIDENCE_CHARS = 8
export const SHORT_EVIDENCE_COVER = 0.6
/** Characters a copied run must have before it is flagged: longer than an IP or an interface name. */
export const COPY_MIN_CHARS = 24
/** Recorded output per lane (redacted); older output is dropped first. */
export const MAX_LANE_RECORD_CHARS = 2_000_000

export const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim()
const fold = (s: string): string => normalise(s).toLowerCase()

interface Record {
  lane: string
  /** One worker's conversation (a lane can be dispatched again in a later round). */
  worker: string
  command: string
  /** Normalised lines, the command's own echo excluded. */
  lines: string[]
  /** Lower-cased lines joined by \n (recommendation copy checks). */
  folded: string
}

/** Every COPY_MIN_CHARS window of `t` (stride 4, plus the tail). */
function windows(t: string): string[] {
  const w = new Set<string>()
  for (let i = 0; i + COPY_MIN_CHARS <= t.length; i += 4) w.add(t.slice(i, i + COPY_MIN_CHARS))
  if (t.length >= COPY_MIN_CHARS) w.add(t.slice(-COPY_MIN_CHARS))
  return [...w]
}

export class Ledger {
  private records: Record[] = []
  private chars = new Map<string, number>()
  /** The framed text the coordinator saw, per lane (lower-cased, normalised). */
  private shown = new Map<string, string>()

  /** Record one command's redacted output for a lane's worker. */
  record(lane: string, command: string, redactedOutput: string, worker = lane): void {
    const cmd = normalise(command)
    const lines = redactedOutput
      .split(/\r?\n/)
      .map(normalise)
      .filter((l) => l && l !== cmd && !l.endsWith(`#${cmd}`) && !l.endsWith(`>${cmd}`))
    const rec: Record = { lane, worker, command: cmd, lines, folded: lines.join('\n').toLowerCase() }
    this.records.push(rec)
    let used = (this.chars.get(lane) ?? 0) + rec.folded.length
    // Bound memory per lane: drop that lane's oldest records first.
    while (used > MAX_LANE_RECORD_CHARS) {
      const i = this.records.findIndex((r) => r.lane === lane)
      if (i < 0 || this.records[i] === rec) break
      used -= this.records[i]!.folded.length
      this.records.splice(i, 1)
    }
    this.chars.set(lane, used)
  }

  /** What the coordinator was shown from this lane (its framed report). Appended per round. */
  recordShown(lane: string, framed: string): void {
    this.shown.set(lane, `${this.shown.get(lane) ?? ''}\n${fold(framed)}`)
  }

  /** Commands this lane ran (normalised). */
  commands(lane: string): string[] {
    return this.records.filter((r) => r.lane === lane).map((r) => r.command)
  }

  /** Lanes with recorded output. */
  lanes(): string[] {
    return [...new Set(this.records.map((r) => r.lane))]
  }

  /**
   * The recorded command whose output contains `line` for this worker, or null. A line verifies if
   * it is one line, a substring of one recorded output line, and either at least MIN_EVIDENCE_CHARS
   * long or (down to MIN_SHORT_EVIDENCE_CHARS) most of that recorded line: "Ethernet" proves nothing.
   * With `command`, that command's output is preferred.
   */
  source(worker: string, line: string, command?: string): string | null {
    if (/[\r\n]/.test(line.trim())) return null
    const l = normalise(line)
    if (l.length < MIN_SHORT_EVIDENCE_CHARS) return null
    const ok = (x: string) => x.includes(l) && (l.length >= MIN_EVIDENCE_CHARS || l.length >= x.length * SHORT_EVIDENCE_COVER)
    const mine = this.records.filter((r) => r.worker === worker)
    const want = command === undefined ? '' : normalise(command)
    const preferred = mine.find((r) => r.command === want && r.lines.some(ok))
    if (preferred) return preferred.command
    return mine.find((r) => r.lines.some(ok))?.command ?? null
  }

  verifies(worker: string, line: string): boolean {
    return this.source(worker, line) !== null
  }

  /**
   * The lane whose framed report (what the coordinator saw) contains a run of at least
   * COPY_MIN_CHARS characters of `text`, case-insensitively, or null. `skipLane` leaves one lane
   * out (a device's own report, when the text goes back to that same device).
   */
  copiedFrom(text: string, skipLane?: string): string | null {
    const w = windows(fold(text))
    if (!w.length) return null
    for (const [lane, shown] of this.shown) {
      if (lane === skipLane) continue
      if (w.some((x) => shown.includes(x))) return lane
    }
    return null
  }

  /** Whether this lane's recorded output mentions the address `ip` (ping/traceroute targets, reach.ts). */
  seen(lane: string, ip: string): boolean {
    return this.records.some((r) => r.lane === lane && mentions(r.folded, ip))
  }

  /** Whether `text` contains a long run of this worker's own recorded output (case-insensitive). */
  copiedFromOwn(worker: string, text: string): boolean {
    const w = windows(fold(text))
    if (!w.length) return false
    return this.records.some((r) => r.worker === worker && w.some((x) => r.folded.includes(x)))
  }
}
