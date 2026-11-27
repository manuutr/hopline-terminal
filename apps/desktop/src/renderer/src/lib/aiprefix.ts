/**
 * "@ai <question>" typed at the device prompt goes to the assistant, not the device.
 *
 * Pure line tracking (no xterm, no IPC) so it is unit tested. The candidate prefix is *held*
 * locally and never sent: "@", "@a", "@ai" are echoed here in the AI colour, and only a mismatch
 * flushes them to the device (after erasing the local echo, so the device's echo does not double
 * it). A full "@ai " enters capture without the device ever having seen a byte, so there is no
 * remote echo to race with and nothing to erase on the device line afterwards.
 *
 * Input is processed per character, so a pasted "@ai why is bgp down?\rshow ver\r" asks the
 * question and then sends "show ver\r" to the device.
 *
 * Where a line starts is decided from two sources: the keys we sent since the last line reset
 * (Enter, Ctrl-C, Ctrl-U, Ctrl-Z), and, when those don't tell (after arrows, Tab completion,
 * history), what is on screen: the text before the cursor being only a device prompt. Leading
 * spaces are allowed ("core-sw1#  @ai …"); "@ai" in the middle of a command stays with the device.
 */

export interface PrefixContext {
  /** False at a password prompt: no part of a secret is ever echoed locally. Default true. */
  mayHold?: boolean
  /**
   * The screen shows the cursor right after a bare device prompt (plus spaces), and that screen is
   * current (device output arrived after our last keystroke). Asked only when the typed line is unknown.
   */
  atLineStart?: () => boolean
}

export const AI_PREFIX = '@ai '

export interface PrefixOutput {
  /** Bytes for the device. */
  send: string
  /** Local writes to the terminal (AI-coloured echo and its erasure). */
  echo: string
  /** Questions completed by Enter, in order. */
  ask: string[]
}

const ERASE = '\b \b'

export class AiPrefix {
  /**
   * What we believe is typed on the device line since its prompt: '' at a fresh prompt, null when
   * we lost track (arrows, Tab completion, history recall), until the next Enter or fresh prompt.
   */
  line: string | null = ''
  /** Held prefix of "@ai " (echoed locally, not sent). */
  held = ''
  /** The question being typed after "@ai ", or null when not capturing. */
  capture: string | null = null

  /** `color(s)` wraps locally echoed text in the AI colour. */
  constructor(private readonly color: (s: string) => string = (s) => s) {}

  get busy(): boolean {
    return this.held !== '' || this.capture !== null
  }

  /** Spaces typed before the held "@" (they went to the device; they stay on its line). */
  private lead = ''
  private justCleared = false

  /** Ctrl+U owns the empty line until the next edit. A delayed history redraw can arrive between
   * that key and a local question. Ordinary typing, history and completion still follow the echo. */
  syncDeviceLine(line: string): void {
    if (!this.busy && !(this.justCleared && line.trim())) this.line = line
  }

  /** One chunk from the terminal (a key, or a paste). */
  input(chunk: string, ctx: PrefixContext | boolean = {}): PrefixOutput {
    const { mayHold = true, atLineStart } = typeof ctx === 'boolean' ? { mayHold: ctx } : ctx
    const out: PrefixOutput = { send: '', echo: '', ask: [] }
    let sentThisChunk = false
    const chars = [...chunk]
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!
      if (this.capture !== null) {
        if (ch === '\r') {
          const q = this.capture.trim()
          this.endCapture(out)
          if (q) out.ask.push(q)
          continue
        }
        if (ch === '\x03' || ch === '\x1b') {
          // Cancel. An Esc starts a key sequence (arrows…): drop the rest of this chunk with it.
          this.endCapture(out)
          return out
        }
        if (ch === '\x7f' || ch === '\b') {
          if (this.capture.length) {
            this.capture = this.capture.slice(0, -1)
            out.echo += ERASE
          } else {
            // Backspace over the space after "@ai": back to holding "@ai".
            this.capture = null
            this.held = this.held.slice(0, -1)
            out.echo += ERASE
          }
          continue
        }
        if (ch >= ' ' && ch !== '\x7f') {
          this.capture += ch
          out.echo += this.color(ch)
        }
        continue
      }

      if (this.held) {
        if (ch === '\x7f' || ch === '\b') {
          this.held = this.held.slice(0, -1)
          out.echo += ERASE
          continue
        }
        const cand = this.held + ch
        if (ch >= ' ' && AI_PREFIX.startsWith(cand)) {
          this.held = cand
          out.echo += this.color(ch)
          if (cand === AI_PREFIX) this.capture = ''
          continue
        }
        // Not "@ai ": give the held characters to the device after all, then this one.
        out.echo += ERASE.repeat(this.held.length)
        out.send += this.held
        sentThisChunk = true
        this.line = this.lead + this.held
        this.held = ''
        // fall through: `ch` is handled as a normal key below
      } else if (ch === '@' && mayHold && this.atStart(atLineStart, sentThisChunk)) {
        this.lead = this.line ?? ''
        this.held = '@'
        out.echo += this.color('@')
        continue
      }

      if (ch !== ' ') this.justCleared = ch === '\x15'
      // Enter, Ctrl-C, Ctrl-U and Ctrl-Z (leave config mode) all end at a fresh, empty line.
      if (ch === '\r' || ch === '\x03' || ch === '\x15' || ch === '\x1a') this.line = ''
      else if (ch === '\x7f' || ch === '\b') this.line = this.line === null ? null : this.line.slice(0, -1)
      else if (ch >= ' ' && ch !== '\x7f') this.line = this.line === null ? null : this.line + ch
      else this.line = null // arrows, tab completion, etc.: we no longer know the line
      out.send += ch
      sentThisChunk = true
      if (ch === '\x1b') {
        // The rest of an escape sequence goes out as is, untracked.
        out.send += chars.slice(i + 1).join('')
        return out
      }
    }
    return out
  }

  /**
   * An "@" here starts a line: what we typed since the last reset is only spaces, or (when that is
   * unknown) the screen shows a bare prompt. The screen is stale once this chunk has sent bytes.
   */
  private atStart(atLineStart: (() => boolean) | undefined, sentThisChunk: boolean): boolean {
    if (this.line !== null) return /^\s*$/.test(this.line)
    return !sentThisChunk && !!atLineStart?.()
  }

  /** The device drew a fresh, empty prompt: the line is known again (empty). */
  promptSeen(): void {
    if (!this.busy) this.line = ''
  }

  private endCapture(out: PrefixOutput): void {
    out.echo += ERASE.repeat(this.held.length + (this.capture?.length ?? 0))
    this.capture = null
    this.held = ''
    this.line = this.lead
    this.lead = ''
  }
}

/** The text before the cursor asks for a secret ("Password:", "Enter passphrase:"): never hold. */
export const isSecretPrompt = (before: string): boolean => /(pass(word|phrase|code)?|secret|pin|token|otp|verification)[^:]*:\s*$/i.test(before)

/**
 * The text before the cursor is only a device prompt, optionally followed by spaces: IOS/NX-OS/EOS
 * "core-sw1#", "dist-eos1(config-if)#", Junos "admin@r1> " / "admin@r1#" (under "[edit]"),
 * IOS-XR "RP/0/RSP0/CPU0:pe1#", MikroTik "[admin@r1] >", Linux "user@host:~$ ". Not
 * "core-sw1#show run | i x>". (Junos's "[edit]" banner is on the line above, not before the cursor.)
 */
export const isBarePrompt = (before: string): boolean =>
  before.length <= 120 && /^\s*(?:\[[^\]]*\]\s*[#>$%]|(?:\[[^\]]*\]\s*)?[\w.\-()/:@~{}]+[#>$%])\s*$/.test(before) && !isSecretPrompt(before)
