import { answerConfirmation, isConfirmationPrompt } from '@hopline/guard'
import { cleanTerminalText, completesOnSpace, interruptKeys, isModelled, lineClearKey, pagerKeys, pagerPattern, promptState, type AnyPlatform, type PromptState } from '@shared/cli'
import type { PromptMode } from '@shared/host-protocol'
import { clearOutputProblem, echoVerdict, LineEditor, type EchoOptions, type EchoVerdict } from './line-editor'

/** What the executor needs from a live tab (implemented by the session host's HostTab). */
export interface ExecTarget {
  readonly connected: boolean
  /** Last ~16KB of decoded output, for prompt detection. */
  readonly tail: string
  lock: { owner: 'agent'; onInterrupt: () => void } | null
  addTap(fn: (text: string) => void): () => void
  /** Write to the device, bypassing the user input lock. */
  send(data: string): void
  /** How long the line has been quiet (HostTab); without it the executor watches the line itself. */
  observed?(): { quietMs: number }
  /** Terminal width (columns), for the readline wrap in the echo check. */
  width?(): number
  /**
   * Whether the device echoes typed characters: learned from the user's typing at a prompt and from
   * Telnet negotiation; undefined until known (then the executor types and checks the echo).
   */
  echoes?(): boolean | undefined
  /** The executor saw the device echo (true), or show nothing at all before the deadline (false). */
  noteEcho?(echoes: boolean): void
  /** Text Hopline typed and could not confirm erased: the line may hold it. Null when the line is clean. */
  unsent?(): string | null
  /** Flag the line as possibly holding `text` (written to the terminal as a notice). */
  markUnsent?(text: string): void
}

/**
 * Runs one CLI line on a live interactive session on behalf of the agent.
 *
 * The device session is shared with the user, so the executor:
 *  - refuses unless the session is idle at a prompt with nothing typed after it;
 *  - holds an input lock so user keystrokes can't interleave (Ctrl-C still aborts);
 *  - waits until the line is quiet before it types, and only treats a prompt, a pager prompt or a
 *    device question as real once it is still the tail after `quietMs` without new bytes: device
 *    output can contain prompt-shaped text (`x\rcore-sw1#`, a `--More--` in a log line), and ending
 *    the capture there would hand the rest of the output to the next command;
 *  - captures from the echoed command to the next prompt (the profile's prompt grammar);
 *  - answers the profile's pager prompt with its page key. It never sends the profile's pager
 *    disable command ("terminal length 0"): that would change the user's session behind their
 *    back, outside the guard and the audit log;
 *  - enforces a timeout and an output-size cap, interrupting with the platform's break keys (IOS
 *    Ctrl-Shift-6, then Ctrl-C; `interruptKeys`) and holding the lock until the prompt is back.
 *    When no key brings it back, the input goes back to the user and the session is marked "still
 *    running": nothing more is typed there until a prompt shows again (Phase 8 review H2).
 */

export type ExecStatus = 'ok' | 'timeout' | 'capped' | 'error'

export interface ExecResult {
  status: ExecStatus
  output: string
  durationMs: number
  bytes: number
  error?: string
  /** The prompt hostname the command was typed at; '' when the prompt shows none. Absent when nothing was typed. */
  hostname?: string
  /** Typed, Enter not pressed, and the line could not be confirmed empty afterwards. */
  typedNotSent?: boolean
}

export type { PromptMode }
export { cleanTerminalText }

/** Classify the last line of the terminal as a prompt, with the platform's prompt grammar (`auto`: any platform's). */
export function detectPrompt(tail: string, platform: AnyPlatform): PromptState {
  return promptState(tail, platform)
}

export interface ExecOptions {
  timeoutMs: number
  capBytes: number
  /** Accept config-mode prompts (only for approved config sequences). */
  allowConfig?: boolean
  signal?: AbortSignal
  /**
   * Quiet period: a prompt, pager prompt or question counts only when it is still the tail after
   * this long without new bytes, and a command starts only after the line was this quiet.
   * Default `DEFAULT_QUIET_MS`.
   */
  quietMs?: number
  /**
   * The guard's expanded form of the command (the session host classifies it again): where the
   * device completes words on space (Junos, PAN-OS), every completed word in the echo must be this
   * expansion's word (Phase 8 review A-L2).
   */
  expanded?: string
}

/** Default quiet period (ms) before a prompt-shaped tail is believed. */
export let DEFAULT_QUIET_MS = 250
/** Tests: a shorter quiet period, so suites against the simulator stay fast. */
export function setDefaultQuietMs(ms: number): void {
  DEFAULT_QUIET_MS = ms
}

/** Wait until no bytes arrived for `quietMs` (bounded by `maxMs`); false if the line never went quiet. */
async function waitQuiet(tab: ExecTarget, quietMs: number, maxMs: number, signal?: AbortSignal): Promise<boolean> {
  const quietFor = tab.observed?.().quietMs
  if (quietFor !== undefined && quietFor >= quietMs) return true
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const end = (ok: boolean) => {
      clearTimeout(timer)
      clearTimeout(cap)
      untap()
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = () => end(false)
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => end(true), quietMs)
    }
    const untap = tab.addTap(arm)
    const cap = setTimeout(() => end(false), maxMs)
    signal?.addEventListener('abort', onAbort)
    arm()
  })
}

export class BusyError extends Error {}

/** Junos / PAN-OS print the edit path on its own line above a configuration prompt. */
const EDIT_LINE = /^(?:\{[^}]*\})?\[edit(?: [^\]]*)?\]\s*$/
/** A device question, for a device whose platform is not known yet (nothing is ever answered there). */
const ANY_QUESTION = /\[confirm\]|\[y(?:es)?\/n(?:o)?\]|\(y\/n\)|\[yes,no\]/i

/**
 * The raw bytes after the last newline hold nothing that moves the cursor back or erases: only
 * printable text and colour (SGR) sequences. A trailing `\r` is a line ending, not an overwrite.
 */
function cleanLastLine(raw: string): boolean {
  const line = raw.slice(raw.lastIndexOf('\n') + 1).replace(/\r+$/, '')
  // eslint-disable-next-line no-control-regex
  const withoutColour = line.replace(/\x1b\[[0-9;]*m/g, '')
  // eslint-disable-next-line no-control-regex
  return !/[\r\b\x1b\x7f]/.test(withoutColour)
}

/**
 * Compare what the device echoed with the command typed, before Enter is pressed: the line-editor
 * emulator (line-editor.ts) follows scroll windows, wraps and redraws, and the verdict is `ok` only
 * when every character of the command was displayed at its own offset and matched.
 */
export function echoState(command: string, echoed: string, o: EchoOptions = {}): 'ok' | 'pending' | 'mismatch' {
  return echoVerdict(command, echoed, o).state
}

/** After each interrupt key: how long the prompt may take to come back before the next key (or giving up). */
export const BREAK_WAIT_MS = 1500

/** Sessions whose last command was interrupted and did not return to a prompt: the command, as typed. */
const stillRunning = new WeakMap<ExecTarget, string>()

const KEY_NAMES: Record<string, string> = { '\x1e': 'Ctrl-Shift-6', '\x03': 'Ctrl-C' }

/** Longest the device may take to echo a typed command (and to settle after the clear key). */
export const ECHO_DEADLINE_MS = 5000

export async function execute(tab: ExecTarget, platform: AnyPlatform, rawCommand: string, opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now()
  const command = rawCommand.trim()
  const fail = (error: string): ExecResult => ({ status: 'error', output: '', durationMs: Date.now() - started, bytes: 0, error })

  if (!tab.connected) return fail('session is not connected')
  if (tab.lock) return fail('another agent command is already running on this session')
  const unsent = tab.unsent?.()
  if (unsent != null)
    return fail(`the device's input line may still hold "${unsent.slice(0, 80)}", which Hopline typed but could not confirm erased (typed, not sent); clear the line (Ctrl-U or Ctrl-C) in the terminal before Hopline types here again`)
  const running = stillRunning.get(tab)
  if (running !== undefined) {
    // Interrupted earlier without a prompt coming back: only a prompt on the screen clears it.
    if (promptState(tab.tail, platform).mode === 'unknown')
      return fail(
        `the previous command ("${running.slice(0, 80)}") may still be running on the device: Hopline interrupted it and no prompt came back. Stop it in the terminal (${interruptKeys(platform).map((k) => KEY_NAMES[k] ?? 'the break key').join(', then ')}) and wait for the prompt; nothing was typed`
      )
    stillRunning.delete(tab)
  }
  if (tab.echoes?.() === false)
    return fail('this session does not echo typed characters, so Hopline cannot check a command before pressing Enter; nothing was typed. If it does echo, type a letter at the prompt (and erase it) so Hopline sees the echo, or reconnect')
  const quietMs = Math.max(0, opts.quietMs ?? DEFAULT_QUIET_MS)
  // The device must be quiet first: a prompt in the middle of output still arriving is not idle.
  if (!(await waitQuiet(tab, quietMs, Math.max(Math.min(opts.timeoutMs, 5000), quietMs + 100), opts.signal))) return fail('the device is still sending output; not interrupting')
  if (!tab.connected) return fail('session is not connected')
  if (tab.lock) return fail('another agent command is already running on this session')
  const before = promptState(tab.tail, platform)
  if (before.mode === 'unknown') return fail('the session is not at a CLI prompt (busy, paging, or logging in)')
  if (before.pending.trim()) return fail(`the user has a partially typed command ("${before.pending.trim()}"); not interrupting`)
  if (before.mode === 'config' && !opts.allowConfig) return fail('the session is in configuration mode; read-only commands only run from exec mode')
  if (!command) return fail('there is no command')

  // Done when the device is back at a prompt for the same host, in any mode.
  const host = before.hostname
  const grammar: AnyPlatform = platform === 'auto' ? (before.platform ?? 'auto') : platform
  const atPrompt = (text: string) => {
    const p = promptState(text, grammar)
    return p.mode !== 'unknown' && !p.pending.trim() && p.hostname === host
  }
  const MORE = pagerPattern(platform)
  const keys = pagerKeys(platform)
  const guarded = isModelled(platform)
  // What the input line follows on screen (the prompt exactly as drawn), for the echo emulator.
  const promptText = cleanTerminalText(tab.tail).split('\n').at(-1) ?? before.prompt
  const lopts: EchoOptions = { prompt: promptText, cols: tab.width?.(), completeOnSpace: completesOnSpace(grammar), ...(opts.expanded ? { expanded: opts.expanded } : {}) }
  const shown = command.slice(0, 80)

  const clearKey = isModelled(platform) ? lineClearKey(platform) : undefined
  const echoMs = Math.max(quietMs + 500, Math.min(opts.timeoutMs, ECHO_DEADLINE_MS))
  const settleMs = Math.max(20, Math.min(quietMs, 150))
  // Phases: `clear` (the line-clear key went out; only erasing may come back), `echo` (the command is
  // typed, Enter not yet pressed: the echo must match), `run` (Enter pressed, capturing), `abandon`
  // (erasing what was typed, then checking the line is empty again).
  return new Promise<ExecResult>((resolve) => {
    let raw = ''
    let clearRaw = ''
    let abandonRaw = ''
    /** Offset in `raw` where Enter was pressed: output starts after the next line break. */
    let runFrom = -1
    let bytes = 0
    let done = false
    let typed = false
    let typedNotSent = false
    let phase: 'clear' | 'echo' | 'run' | 'abandon' = clearKey ? 'clear' : 'echo'
    let phaseTimer: ReturnType<typeof setTimeout> | undefined
    let echoDeadline: ReturnType<typeof setTimeout> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let abandonTimer: ReturnType<typeof setTimeout> | undefined
    let abandonArm: (() => void) | undefined
    let settle: ReturnType<typeof setTimeout> | undefined
    let breakTimer: ReturnType<typeof setTimeout> | undefined
    let interrupted: ExecStatus | null = null
    let errorText: string | undefined
    let answered = false
    let confirmFrom = 0

    const finish = (status: ExecStatus) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(settle)
      clearTimeout(phaseTimer)
      clearTimeout(echoDeadline)
      clearTimeout(abandonTimer)
      clearTimeout(breakTimer)
      untap()
      tab.lock = null
      opts.signal?.removeEventListener('abort', onAbort)
      // Output starts after Enter: drop the rest of the echoed line (E5: a scrolled echo is not
      // searched for by its text) and the trailing prompt.
      const lines = runFrom >= 0 ? cleanTerminalText(raw.slice(runFrom)).split('\n') : []
      lines.shift()
      if (lines.length && atPrompt(lines.at(-1)!)) {
        lines.pop()
        if (EDIT_LINE.test(lines.at(-1) ?? '')) lines.pop()
      }
      const out = lines
        .map((l) => l.replace(MORE, '').replace(/^\s*--\s*More\s*--\s*|^\s*---\(more(?: \d+%)?\)---\s*/i, ''))
        .join('\n')
        .replace(/\n+$/, '')
      resolve({ status, output: out, durationMs: Date.now() - started, bytes, error: errorText, ...(typed ? { hostname: host } : {}), ...(typedNotSent ? { typedNotSent: true } : {}) })
    }

    /**
     * Before Enter: erase what is on the line, then check it is empty again (E3). If that cannot be
     * confirmed, the tab is flagged ("the line may hold unsent text"): Hopline types nothing there
     * until the user clears the line, and the result says "typed, not sent".
     */
    const abandon = (msg: string, eraseWith?: string) => {
      if (done || phase === 'abandon') return
      const seen = phase === 'clear' ? clearRaw : raw
      phase = 'abandon'
      clearTimeout(echoDeadline)
      clearTimeout(phaseTimer)
      tab.send(eraseWith ?? clearKey ?? '\x7f'.repeat(command.length + 2))
      const since = Date.now()
      const settleFor = Math.max(50, Math.min(quietMs, 300))
      const check = () => {
        if (done) return
        const ed = new LineEditor(lopts).feed(seen + abandonRaw)
        // A device that showed nothing at all cannot prove the line is empty.
        const clean = ed.blank() && (ed.everShown || !typed)
        if (clean) errorText = `${msg}; the line was erased and Enter was not pressed`
        else {
          typedNotSent = true
          // eslint-disable-next-line no-control-regex
          const what = typed ? command : clearRaw.replace(/[\x00-\x1f\x7f]/g, '') || '(the line-clear key)'
          tab.markUnsent?.(what)
          errorText = `${msg}; typed, not sent: Enter was not pressed, but Hopline could not confirm the line is empty again, so "${what.slice(0, 80)}" may still be on the device's input line. Clear it (Ctrl-U or Ctrl-C) before pressing Enter; Hopline types nothing on this session until you do`
        }
        raw = ''
        runFrom = -1
        finish('error')
      }
      abandonArm = () => {
        clearTimeout(abandonTimer)
        abandonTimer = setTimeout(check, Date.now() - since > 2000 ? 0 : settleFor)
      }
      abandonArm()
    }

    /** `question`: a device question is cancelled with Ctrl-C (a break key is no answer to a `[confirm]`). */
    const interrupt = (why: ExecStatus, msg: string, question = false) => {
      if (interrupted || done || phase === 'abandon') return
      if (phase === 'clear') {
        errorText = `${msg}; nothing was typed`
        return finish('error')
      }
      if (phase === 'echo') return abandon(msg)
      interrupted = why
      errorText = msg
      // The break keys one at a time, each only while the prompt has not come back (`evaluate`
      // finishes as soon as it does). The lock holds meanwhile, so nothing else is typed.
      const keys = question ? ['\x03'] : interruptKeys(platform, before.mode)
      let k = 0
      const next = () => {
        if (done) return
        if (!tab.connected) return finish(why)
        if (k < keys.length) {
          tab.send(keys[k++]!)
          breakTimer = setTimeout(next, BREAK_WAIT_MS)
          return
        }
        // No key brought the prompt back. The user gets the input back (to stop it themselves);
        // Hopline types nothing here until a prompt shows again.
        stillRunning.set(tab, command)
        errorText = `${msg}; Hopline sent ${keys.map((x) => KEY_NAMES[x] ?? 'the break key').join(', then ')} and no prompt came back, so the command may still be running on the device. Stop it in the terminal; Hopline runs nothing on this session until the prompt is back`
        finish(why)
      }
      next()
    }

    const onAbort = () => interrupt('error', 'cancelled')
    opts.signal?.addEventListener('abort', onAbort)

    // Everything that reacts to the tail (pager, questions, the closing prompt) runs only once the
    // line has been quiet for `quietMs`: then the tail is what the device is waiting at, not text
    // that happens to look like a prompt in the middle of output.
    const evaluate = () => {
      if (done || phase !== 'run') return
      const tail = cleanTerminalText(raw.slice(-512))
      if (MORE.test(tail)) {
        // Paging stops after an interrupt: the quit key ends the listing, and only while the
        // pager is still what the device waits at (never a stray key at the user's prompt).
        tab.send(interrupted ? keys.quit : keys.page)
        return
      }
      // A device question ("[confirm]", "Destination filename [startup-config]?"): answer only with
      // the answer the guard binds to this command, once; anything else is cancelled. A device whose
      // platform is not known yet (the auto-detect probe) gets no answers at all.
      const ran = raw.slice(runFrom)
      const fresh = cleanTerminalText(raw.slice(Math.max(confirmFrom, runFrom, raw.length - 512)))
      if (!interrupted && ran.includes('\n')) {
        if (!guarded && ANY_QUESTION.test(fresh.split('\n').at(-1) ?? '')) return interrupt('error', 'the device asked a question; nothing is answered on an unidentified device', true)
        if (guarded && isConfirmationPrompt(platform, fresh)) {
          const d = answerConfirmation(platform, command, fresh, { mode: before.mode === 'exec' ? 'exec' : 'config-any' })
          if ('refuse' in d || answered) return interrupt('error', 'refuse' in d ? `device confirmation refused: ${d.refuse}` : 'device asked for a second confirmation', true)
          answered = true
          confirmFrom = raw.length
          tab.send(d.answer)
          return
        }
      }
      // Need at least one newline after Enter before a prompt counts as "done", and (unless we
      // interrupted) a prompt on a line of its own: one drawn over other text with a carriage
      // return, backspaces or cursor/erase sequences (`  1 x\rcore-sw1#`) is output, not the device.
      if (ran.includes('\n') && atPrompt(tail) && (interrupted || cleanLastLine(raw))) finish(interrupted ?? 'ok')
    }

    // The echo must match the command before Enter (E1): every character displayed at its own
    // offset. A consistent partial echo keeps waiting (SSH may deliver it in pieces); a wrong one
    // stops at once; no full echo before the echo deadline stops too, with its own reason (E2).
    const echoProblem = (v: EchoVerdict): string => {
      const secs = `${Math.round(echoMs / 100) / 10}s`
      if (v.state === 'mismatch') {
        if (v.why === 'unsupported') return `the device redrew the line in a way Hopline cannot follow (${v.detail}), so the echo of "${shown}" could not be checked`
        if (v.why === 'extra') return `the device echoed "${v.shown}", which is more than "${shown}" (text already on the line?)`
        return `the device echoed "${v.shown}" instead of "${shown}" (a lost or changed character, or a key already on the line)`
      }
      if (v.state === 'pending' && v.why === 'empty') return `the device did not echo the command within ${secs}`
      if (v.state === 'pending' && v.why === 'interrupted') return `device output interrupted the echo of "${shown}" and the line was not redrawn within ${secs}, so it could not be checked`
      return `the device echoed only part of "${shown}" within ${secs}`
    }
    const checkEcho = (final = false) => {
      if (done || phase !== 'echo') return
      const v = echoVerdict(command, raw, lopts)
      if (v.state === 'ok') {
        phase = 'run'
        clearTimeout(echoDeadline)
        tab.noteEcho?.(true)
        runFrom = raw.length
        tab.send('\r')
        // The command timeout starts at Enter (E2: the echo deadline has its own error).
        timer = setTimeout(() => interrupt('timeout', `no prompt within ${Math.round(opts.timeoutMs / 1000)}s after the command was sent`), opts.timeoutMs)
      } else if (v.state === 'mismatch' || final) {
        if (final && v.state === 'pending' && v.why === 'empty') tab.noteEcho?.(false)
        abandon(echoProblem(v))
      }
    }
    const startEcho = () => {
      phase = 'echo'
      raw = ''
      typed = true
      // The echo deadline counts from typing, not from the clear key.
      clearTimeout(echoDeadline)
      echoDeadline = setTimeout(() => checkEcho(true), echoMs)
      tab.send(command)
    }
    const afterClear = () => {
      if (done || phase !== 'clear') return
      // The clear phase may only erase (E4): `^U` shown as text means the key reached the line.
      // Log lines may arrive meanwhile: the clear key's own line, and the prompt drawn again after
      // them, may still only erase.
      const segs = clearRaw.split('\n')
      const lastSeg = segs.at(-1)!.replace(/^\r+/, '')
      if (segs.length > 1 && !lastSeg.startsWith(promptText)) {
        errorText = 'the device printed output while the line was being cleared and did not show the prompt again; nothing was typed, try again'
        return finish('error')
      }
      const problem = clearOutputProblem(segs[0]!.replace(/\r$/, ''), promptText) ?? (segs.length > 1 ? clearOutputProblem(lastSeg.slice(promptText.length), promptText) : null)
      if (problem) {
        // Ctrl-E (IOS family) first moved to the end of the line: text right of the cursor that the
        // screen did not show is drawn there, then Ctrl-U erases it (Phase 8 review A-L3). The line
        // is empty again, but it held text nobody saw: refuse this once, type nothing.
        if (segs.length === 1 && new LineEditor(lopts).feed(clearRaw).blank()) {
          errorText = `the device's input line held text the screen did not show ("${problem}"); the line-clear key erased it and nothing was typed, try again`
          return finish('error')
        }
        return abandon(`the line-clear key reached the device's line as text ("${problem}") instead of clearing it; nothing was typed`, '\x7f'.repeat(problem.length + 2))
      }
      startEcho()
    }
    echoDeadline = setTimeout(
      () => {
        if (phase === 'clear') {
          errorText = 'the device kept sending output after the line-clear key; nothing was typed'
          return finish('error')
        }
        checkEcho(true)
      },
      echoMs + (clearKey ? settleMs : 0)
    )

    const untap = tab.addTap((text) => {
      if (done) return
      bytes += Buffer.byteLength(text)
      if (phase === 'clear') {
        clearRaw += text
        clearTimeout(phaseTimer)
        phaseTimer = setTimeout(afterClear, settleMs)
        return
      }
      if (phase === 'abandon') {
        abandonRaw += text
        return abandonArm?.()
      }
      raw += text
      if (phase === 'echo') return checkEcho()
      clearTimeout(settle)
      settle = setTimeout(evaluate, quietMs)
      if (bytes > opts.capBytes && !interrupted) interrupt('capped', `output exceeded ${Math.round(opts.capBytes / 1024)} KB`)
    })

    tab.lock = {
      owner: 'agent',
      onInterrupt: () => interrupt('error', 'interrupted by the user (Ctrl-C) or the session closed')
    }
    // Start on an empty line: the profile's clear key, then wait for the device to settle.
    if (clearKey) {
      tab.send(clearKey)
      phaseTimer = setTimeout(afterClear, settleMs)
    } else startEcho()
  })
}
