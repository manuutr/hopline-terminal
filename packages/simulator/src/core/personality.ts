/**
 * The contract between the generic terminal (core/terminal.ts) and a vendor module. The terminal
 * owns bytes, line editing, history, the pager mechanics and confirm prompts; the vendor owns
 * everything a network engineer would recognise as "the CLI": prompts (including banner lines
 * such as `[edit]` or `{master:0}`), parsing, errors, help, completion, control-key semantics,
 * pager text/keys, and unsolicited output from device timers.
 */
import type { Device } from '../state.ts'
import type { DeviceRuntime } from './runtime.ts'

export type PagerAction = 'line' | 'page' | 'half' | 'all' | 'quit' | 'ignore'

export interface PagerSpec {
  /** Pager prompt; `pct` is the share of output shown so far (0-100). */
  text: (pct: number) => string
  /** Bytes that erase the pager prompt once a key is pressed. */
  erase: (text: string) => string
  /** Key → action; keys not listed use `other`. */
  keys: Record<string, PagerAction>
  other: PagerAction
}

export interface AskOptions {
  /** 'key': first key answers ([confirm], (y/n) on some gear). 'line': read a line until Enter. */
  mode: 'key' | 'line'
  /** Echo typed characters (line mode). Default true. */
  echo?: boolean
}

export interface PrintOptions {
  /** Bypass the pager for this output (`| no-more`). */
  noMore?: boolean
}

/** What a vendor can do to the session it runs in. */
export interface Session {
  readonly d: Device
  readonly rt: DeviceRuntime
  /** Logged-in user name. */
  readonly user: string
  /** Login password (for `enable`). */
  readonly password: string
  /** Client address, for syslog "on vty0 (10.10.10.50)". */
  readonly from: string
  readonly rows: number
  /** Lines per page; 0 disables the pager. */
  pageLength: number
  /** Write raw bytes (no newline conversion). */
  write: (s: string) => void
  /** Print text (LF or CRLF line ends); paged unless disabled. A trailing newline is added. */
  print: (text: string, opts?: PrintOptions) => Promise<void>
  /** Ask a question and wait for the answer. Resolves '' on Ctrl-C. */
  ask: (question: string, opts?: AskOptions) => Promise<string>
  /** Wait; resolves false early if the user aborted (vendor abort keys). */
  sleep: (ms: number) => Promise<boolean>
  /** True once the user pressed an abort key during the current command. */
  readonly aborted: boolean
  /** End the session (logout). */
  close: () => void
}

export interface ControlResult {
  /** Bytes echoed for the key (e.g. '^C\r\n'). */
  echo?: string
  /** Run this line before applying the key (NX-OS Ctrl-Z runs the current line first). */
  execute?: string
  /** Close the session (FortiOS Ctrl-C at top level). */
  disconnect?: boolean
  /** Applied after `execute` (or right away): the mode change the key causes. */
  then?: () => void
  /** Keep the typed line (Ctrl-G style) instead of clearing it. */
  keepLine?: boolean
}

export interface TabResult {
  /** Replace the line with this text. */
  line?: string
  /** Print this (candidate list), then redraw the prompt and line. */
  list?: string
  /** Ring the bell. */
  bell?: boolean
}

export type PromptReason = 'start' | 'command' | 'empty' | 'help' | 'interrupt' | 'notify'

export interface Personality {
  /** Text printed after login, before the first prompt (MOTD, last login, version line). */
  banner: () => string
  /** The prompt, including any banner lines above it. LF line ends. */
  prompt: (reason: PromptReason) => string
  /** Run one line; output goes through the session. */
  execute: (line: string) => Promise<void>
  /** `?` pressed with `line` before the cursor. Returns text to print; the prompt and line are redrawn. */
  help: (line: string) => string
  /** Tab pressed. */
  tab: (line: string) => TabResult
  /** Space pressed: return a replacement line to complete-on-space (Junos), or null to insert a space. */
  space?: (line: string) => TabResult | null
  /** Ctrl-C (`'c'`) or Ctrl-Z (`'z'`) at the prompt. */
  control: (key: 'c' | 'z', line: string) => ControlResult
  /** Keys that abort a running command (ping): Ctrl-C on most, Ctrl-^ on IOS. */
  abortKeys: string[]
  pager: PagerSpec
  /** Called when the session closes. */
  dispose?: () => void
}

export type PersonalityFactory = (s: Session) => Personality
