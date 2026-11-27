/**
 * F9 terminal autocomplete, the pure part (no xterm, no DOM): what to suggest for the line being
 * typed at the device prompt, and the values learned from output the user already ran.
 *
 * - Suggestions come from cli-model `complete()` for the session's platform and the mode the
 *   prompt shows. They are computed from the locally tracked line on each keystroke (never from
 *   the device echo, which can be a round trip away); the echo only re-syncs the line after Tab,
 *   `?`, history recall or a paste, when the local copy is unknown.
 * - Live values (interfaces, VLANs, VRFs, BGP/OSPF neighbours) are harvested passively: when the
 *   user runs the platform's own listing command (`show ip interface brief`, …), its output is
 *   parsed. Nothing is ever sent to get them. Every value is device-supplied text that accepting a
 *   completion would type back into the device, so each kind has a strict whitelist.
 */
import { complete, PROFILES, resolve, type Candidate, type LiveSource, type LiveValues, type ModeId, type PlatformId } from '@hopline/cli-model'
import { cleanTerminalText, promptState } from '@shared/cli'

export interface Suggestion {
  /** Characters to append (ghost text); '' when there is no unique completion. */
  ghost: string
  /** The word being completed. */
  partial: string
  /** What could come next, with help (keywords, parameters, learned values). */
  candidates: Candidate[]
}

const NONE: Suggestion = { ghost: '', partial: '', candidates: [] }
/** Longer than any CLI line worth completing; beyond it, suggesting costs more than it helps. */
const MAX_LINE = 240

export function suggest(platform: PlatformId, mode: ModeId, line: string, live: LiveValues = {}): Suggestion {
  if (line.length > MAX_LINE || !line.trim()) return NONE
  try {
    const c = complete(platform, mode, line, live)
    return { ghost: c.ghost, partial: c.partial, candidates: c.candidates.slice(0, 24) }
  } catch {
    return NONE
  }
}

// -----------------------------------------------------------------------------------------------
// Live values

/** The sources harvested (the ones the brief names: interfaces, VLANs, VRFs, neighbours). */
export const HARVESTED: readonly LiveSource[] = ['interfaces', 'vlans', 'vrfs', 'bgp-neighbors', 'ospf-neighbors']

const MAX_VALUES = 512
const MAX_CAPTURE = 256 * 1024

/**
 * Whitelists. A value is typed into the device if the user accepts it, so: no whitespace, no
 * control characters, nothing the CLI would read as a separator, pipe, comment or quote, and a
 * short length. Interface names keep their own characters (`/`, `.`, `:`); VLAN ids are numbers.
 */
const SAFE: Record<string, RegExp> = {
  interfaces: /^[A-Za-z][A-Za-z0-9\-/.:]{0,47}$/,
  vlans: /^(?:[1-9]\d{0,2}|[1-3]\d{3}|40[0-8]\d|409[0-4])$/,
  vrfs: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/,
  'bgp-neighbors': /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  'ospf-neighbors': /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
}

export const safeValue = (source: LiveSource, v: string): boolean => !!SAFE[source]?.test(v)

/** Header and filler words that sit in the first column of listings and are never names. */
const NOT_A_NAME = /^(?:name|vrf|default|interface|port|vlan|status|id|neighbor|neighbour|total|codes?|address|protocol|type|-+|=+)$/i

const IPV4_AT_START = /^\s*((?:\d{1,3}\.){3}\d{1,3})\b/

/** Pull one source's values out of a listing's output (as the device printed it). */
export function parseLive(platform: PlatformId, source: LiveSource, output: string): string[] {
  const lines = cleanTerminalText(output).split('\n')
  const out = new Set<string>()
  const add = (v: string | undefined) => {
    if (v && safeValue(source, v) && !NOT_A_NAME.test(v)) out.add(v)
  }
  const ifs = PROFILES[platform].interfaces
  /** A real interface name of this platform: its full-name pattern, or a type prefix (full or short) plus its numbering. */
  const isInterface = (w: string): boolean => {
    if (ifs.fullName) return ifs.fullName.test(w)
    if (ifs.opaque) return false
    const lw = w.toLowerCase()
    return ifs.types.some((t) => [t.full, ...t.short].some((pre) => lw.startsWith(pre.toLowerCase()) && ifs.numbering.test(w.slice(pre.length))))
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    switch (source) {
      case 'interfaces': {
        const w = line.trim().split(/\s+/)[0]!
        if (isInterface(w)) add(w)
        break
      }
      case 'vlans':
        add(/^\s*(\d{1,4})\s/.exec(line)?.[1])
        break
      case 'vrfs': {
        // `show vrf` style: the name in the first column of a data row (indented continuation rows skipped).
        if (/^\s/.test(line)) break
        add(line.split(/\s+/)[0])
        break
      }
      case 'bgp-neighbors':
      case 'ospf-neighbors':
        add(IPV4_AT_START.exec(line)?.[1])
        break
    }
    if (out.size >= MAX_VALUES) break
  }
  return [...out]
}

/** The live sources whose listing command `line` is on this platform (after abbreviation expansion). */
export function liveSourcesFor(platform: PlatformId, mode: ModeId, line: string): LiveSource[] {
  if (!line.trim() || line.includes('|')) return []
  let expanded: string
  try {
    expanded = resolve(platform, mode, line).expanded.trim().toLowerCase()
  } catch {
    return []
  }
  const out: LiveSource[] = []
  for (const src of HARVESTED) {
    const b = PROFILES[platform].live[src]
    if (!b) continue
    let want: string
    try {
      want = resolve(platform, mode, b.command).expanded.trim().toLowerCase()
    } catch {
      continue
    }
    if (want === expanded) out.push(src)
  }
  return out
}

/**
 * Per-tab cache of learned values plus the capture in progress. Fed with the line the user ran
 * (on Enter) and the output that follows, until the next prompt.
 */
export class LiveHarvest {
  readonly values: { -readonly [K in LiveSource]?: string[] } = {}
  private capture: { sources: LiveSource[]; text: string } | null = null

  constructor(private readonly platform: () => PlatformId | null) {}

  /** The user pressed Enter on `line` in `mode`. */
  ran(line: string, mode: ModeId | null): void {
    const p = this.platform()
    this.capture = null
    if (!p || !mode) return
    const sources = liveSourcesFor(p, mode, line)
    if (sources.length) this.capture = { sources, text: '' }
  }

  /** Device output (raw). Ends the capture at the next prompt. */
  output(data: string): void {
    const c = this.capture
    if (!c) return
    c.text += data
    if (c.text.length > MAX_CAPTURE) {
      this.capture = null
      return
    }
    const p = this.platform()
    if (!p) return
    const tail = c.text.slice(-512)
    const st = promptState(tail, p)
    if (st.mode === 'unknown' || st.pending.trim()) return
    // The listing ended: drop the rest of the echoed command line (everything up to the first line
    // break) and the final prompt, then parse.
    const full = c.text.slice(0, c.text.length - tail.length) + tail.slice(0, tail.lastIndexOf(st.prompt) >= 0 ? tail.lastIndexOf(st.prompt) : tail.length)
    const nl = full.indexOf('\n')
    const body = nl >= 0 ? full.slice(nl + 1) : ''
    for (const src of c.sources) {
      const vals = parseLive(p, src, body)
      if (vals.length) this.values[src] = vals
    }
    this.capture = null
  }

  get live(): LiveValues {
    return this.values
  }
}

/** The mode for completion from the screen (prompt line and the two above, for Junos `[edit]`). */
export function screenMode(platform: PlatformId, screenTail: string): { mode: ModeId; pending: string } | null {
  const st = promptState(screenTail, platform)
  if (st.mode === 'unknown' || !st.detected) return null
  return { mode: st.detected.mode, pending: st.pending }
}

/**
 * What the typed line becomes after the screen (current: device output after our last key) shows
 * `pending` after the prompt, or undefined to keep `local`. The screen wins, except while the echo
 * of keys already sent is still on its way (the screen then shows a prefix of the local line). A
 * fresh, bare prompt always resets it: a line adopted from someone else's echo (the assistant's
 * command) must not survive the next prompt, or "@ai" typed there would go to the device.
 */
export function reconcileLine(local: string | null, pending: string, blocked: boolean): string | undefined {
  if (blocked || local === pending) return undefined
  if (pending === '') return ''
  if (local === null || !local.startsWith(pending) || local.slice(pending.length).includes('?')) return pending
  return undefined
}
