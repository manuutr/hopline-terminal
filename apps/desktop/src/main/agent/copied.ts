import { COPY_MIN_CHARS, normalise } from '../fleet/ledger'

/**
 * Recent device output of one terminal session, for the copied-line flag on proposal cards
 * (ARCHITECTURE §5.2, FLEET-AGENT §6.1): a proposed line that contains a long run of text the device
 * printed may have been planted there (a description, a banner, an LLDP name) for the model to
 * relay. The card flags it with the command whose output it came from; it is a signal for the user,
 * not a refusal (re-adding or negating an existing line legitimately quotes `show running-config`).
 *
 * Only REDACTED output is recorded (what the model saw), so the check is never an oracle on a
 * secret. Comparison is case-insensitive on whitespace-normalised text, with the fleet ledger's
 * window length (COPY_MIN_CHARS): shorter lines are never flagged.
 */

/** Recorded output per session; older output is dropped first. */
export const MAX_RECENT_CHARS = 1_000_000
const MAX_RECORDS = 200

const fold = (s: string): string => normalise(s).toLowerCase()

/** Every COPY_MIN_CHARS window of `t` (stride 4, plus the tail), as the fleet ledger does. */
function windows(t: string): string[] {
  const w = new Set<string>()
  for (let i = 0; i + COPY_MIN_CHARS <= t.length; i += 4) w.add(t.slice(i, i + COPY_MIN_CHARS))
  if (t.length >= COPY_MIN_CHARS) w.add(t.slice(-COPY_MIN_CHARS))
  return [...w]
}

export class RecentOutput {
  private records: { source: string; folded: string }[] = []
  private chars = 0

  /** Record one command's redacted output (the command's own echo is dropped). */
  record(source: string, redactedOutput: string): void {
    const cmd = normalise(source)
    const folded = redactedOutput
      .split(/\r?\n/)
      .map(normalise)
      .filter((l) => l && l !== cmd && !l.endsWith(`#${cmd}`) && !l.endsWith(`>${cmd}`))
      .join('\n')
      .toLowerCase()
    if (!folded) return
    this.records.push({ source: cmd, folded })
    this.chars += folded.length
    while ((this.chars > MAX_RECENT_CHARS || this.records.length > MAX_RECORDS) && this.records.length > 1) this.chars -= this.records.shift()!.folded.length
  }

  /** The most recent command whose output contains a long run of `line`, or null. */
  sourceOf(line: string): string | null {
    const w = windows(fold(line))
    if (!w.length) return null
    for (let i = this.records.length - 1; i >= 0; i--) if (w.some((x) => this.records[i]!.folded.includes(x))) return this.records[i]!.source
    return null
  }
}
