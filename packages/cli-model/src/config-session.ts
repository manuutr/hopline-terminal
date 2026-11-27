import type { ModeId, PlatformId } from './types'

/**
 * How an approved configuration change is applied on each platform: the lines that open the
 * configuration context, commit it and leave it, and what discards it after a failure part-way.
 * Pure data (docs/research/cli-*.md); the executor and the approval card both read it, so the user
 * approves exactly the lines that run. Every line here must resolve in the platform's tree in the
 * mode it is typed in, as `config` risk (tested in config-session.test.ts).
 */
export interface ConfigSession {
  /** Typed in exec mode to open configuration mode. Empty when changes are single exec lines (AireOS, FTD) or self-contained blocks (FortiOS). */
  enter: readonly string[]
  /** Mode the proposal's own lines start in (and are classified in). */
  linesFrom: ModeId
  /** Typed after the lines to make them take effect. Empty where changes apply line by line. */
  commit: readonly string[]
  /** Commit only when the prompt matches (Huawei VRP commits only in two-stage mode, `[~host]`). */
  commitWhen?: RegExp
  /** Typed after commit to get back to exec mode. */
  exit: readonly string[]
  /**
   * Typed after a failure part-way to discard what was typed and leave. Empty means nothing can be
   * discarded safely, so `leftover` is reported instead.
   */
  abort: readonly string[]
  /** What stays on the device after a failure when `abort` cannot discard it. */
  leftover?: string
  /** Lines are `config …` / `end` blocks (FortiOS): they must balance, and they leave on their own. */
  blocks?: boolean
  /** Changes take effect only on commit (nothing is live until then). */
  candidate: boolean
  /**
   * Output of a commit line that means it did not take, on top of the platform's device errors
   * (IOS-XR prints `% Failed to commit …`, PAN-OS `Validation Error:` … `commit failed`).
   */
  commitFailed?: readonly RegExp[]
  /** Output of an enter line that means configuration mode was refused (Junos private database). */
  enterRefused?: readonly { re: RegExp; message: string }[]
  /** Output of a leave line that means the change was not kept (a question about uncommitted changes). */
  exitFailed?: readonly RegExp[]
  /**
   * Read-only check typed at the exec prompt before entering: configuration mode is not entered
   * when `dirty` matches its output (other admins' uncommitted changes would be committed too).
   */
  precheck?: { command: string; dirty: RegExp; message: string }
  /**
   * The commit lines for the admin named in the prompt (`user@host`), when the platform can commit
   * only that admin's changes (PAN-OS `commit partial admin <user>`). Without a user, `commit` is used.
   */
  commitAs?: (user: string) => readonly string[]
}

/** Commit-failure text shared by the two-stage platforms (research docs; most strings unverified). */
const COMMIT_FAILED = {
  iosxr: [/^% ?Failed to commit/im, /^% ?Commit failed/im, /^% ?Configuration (?:commit|check) failed/im, /Please issue 'show configuration failed/i],
  junos: [/^error: (?:configuration check-out failed|commit failed)/im, /^error: /im],
  panos: [/^Validation Error:/im, /^commit failed/im, /Commit job \d+ (?:failed|is not complete)/i, /^Commit failed/im, /^Server error/im],
  vrp: [/^Error: .*(?:commit|committed)/im, /The configuration fails to be committed/i],
  fortios: [/Command fail\. Return code/i, /^value parse error/im, /entry not found in datasource/i]
} as const

const CISCO: ConfigSession = { enter: ['configure terminal'], linesFrom: 'config', commit: [], exit: ['end'], abort: ['end'], candidate: false }

export const CONFIG_SESSIONS: Readonly<Record<PlatformId, ConfigSession>> = {
  ios: CISCO,
  iosxe: CISCO,
  nxos: CISCO,
  c9800: CISCO,
  asa: CISCO,
  ciscosb: CISCO,
  eos: CISCO,
  aoscx: CISCO,
  // Target configuration: nothing is live until `commit`; `abort` discards it and leaves.
  // Target configuration: nothing is live until `commit`; `abort` discards it and leaves (also after
  // a failed commit, where `end` would ask about uncommitted changes).
  iosxr: {
    enter: ['configure terminal'],
    linesFrom: 'config',
    commit: ['commit'],
    exit: ['end'],
    abort: ['abort'],
    candidate: true,
    commitFailed: COMMIT_FAILED.iosxr,
    exitFailed: [/Uncommitted changes found/i]
  },
  // A private candidate (`configure private`): `commit and-quit` commits only our changes, never
  // another admin's uncommitted work, and `rollback 0` inside it discards only what we typed. Junos
  // refuses a private database while the shared one holds uncommitted changes: Hopline stops there
  // and never falls back to plain `configure`.
  junos: {
    enter: ['configure private'],
    linesFrom: 'config',
    commit: ['commit and-quit'],
    exit: [],
    abort: ['rollback 0', 'exit configuration-mode'],
    candidate: true,
    commitFailed: COMMIT_FAILED.junos,
    enterRefused: [
      {
        re: /shared configuration database modified|database (?:is )?locked|configuration (?:database )?locked|private (?:edits|database) (?:not )?(?:allowed|available)|^error: /im,
        message: 'Junos refused a private configuration session because another administrator has uncommitted changes in the shared configuration (or it is locked). Nothing was changed; ask them to commit or discard first'
      }
    ],
    exitFailed: [/Exit with uncommitted changes/i, /uncommitted changes will be discarded/i]
  },
  // Shared candidate: before entering, `show config diff` must be empty (other admins' pending
  // changes would be committed with ours); the commit names our admin (`commit partial admin`).
  panos: {
    enter: ['configure'],
    linesFrom: 'config',
    commit: ['commit'],
    commitAs: (user) => [`commit partial admin ${user}`],
    exit: ['exit'],
    abort: ['exit'],
    leftover: 'the candidate configuration still holds the lines typed so far (uncommitted); revert them in the web UI or with "revert config"',
    candidate: true,
    commitFailed: COMMIT_FAILED.panos,
    precheck: {
      command: 'show config diff',
      dirty: /\S/,
      message: 'the candidate configuration already has uncommitted changes (another administrator, or an earlier session); committing now would commit them too. Nothing was changed; review "show config diff" and commit or revert them first'
    },
    exitFailed: [/uncommitted changes/i]
  },
  // Two-stage mode (`[~host]`) needs a commit; one-stage applies each line at once. Leaving with
  // uncommitted changes asks `[Y(yes)/N(no)/C(cancel)]:`; the bound answer on `return` is N (discard).
  vrp: {
    enter: ['system-view'],
    linesFrom: 'config',
    commit: ['commit'],
    commitWhen: /^\[~/,
    exit: ['return'],
    abort: ['return'],
    candidate: false,
    commitFailed: COMMIT_FAILED.vrp,
    exitFailed: [/Uncommitted configurations found/i]
  },
  // `config system interface` … `end`: the proposal carries its own blocks; `abort` drops an open one.
  fortios: { enter: [], linesFrom: 'exec', commit: [], exit: [], abort: ['abort'], blocks: true, candidate: false, commitFailed: COMMIT_FAILED.fortios },
  // One-line `config …` commands from the exec prompt; there is no configuration mode to enter.
  aireos: { enter: [], linesFrom: 'exec', commit: [], exit: [], abort: [], candidate: false },
  // FTD's restricted CLI: one-line `configure …` commands from the `>` prompt.
  ftd: { enter: [], linesFrom: 'exec', commit: [], exit: [], abort: [], candidate: false }
}
