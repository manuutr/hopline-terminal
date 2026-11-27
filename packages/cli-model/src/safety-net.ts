import type { ConfigSession } from './config-session'
import { CONFIG_SESSIONS } from './config-session'
import type { PlatformId } from './types'

/**
 * Platform safety nets for an approved configuration change (ARCHITECTURE §6.3): what Hopline arms
 * before the change, how the change is committed under it, and the lines that confirm it or roll it
 * back. Pure data, like CONFIG_SESSIONS.
 *
 * These lines are APP-OWNED. Several of them are on the agent's deny-list (`configure replace`,
 * `configure session …`, `rollback running-config checkpoint`, Junos `rollback 1`), and they stay
 * there: the model can never send them. Main sends them only from the safety-net flow, in a verdict
 * marked `net`, and the session host accepts such a verdict only when the command matches one of
 * the platform's fixed templates below (`netLineAllowed`), in the mode the template names. Nothing
 * from the model reaches these lines: the snapshot name is `hopline-<8 hex>` made by main, the
 * timer is an integer main validated, and the IOS-XE archive file name comes from the device and
 * must match a strict file-name shape.
 *
 * Platforms without an entry (IOS classic, IOS-XR, ASA, C9800, Cisco SB, AOS-CX, PAN-OS, VRP,
 * FortiOS, AireOS, FTD) have no net here: the proposal's own rollback lines are the undo.
 */

export type NetKind = 'commit-confirmed' | 'session-timer' | 'checkpoint' | 'archive'

/**
 * What a timer net's check read says about one change: `pending` (the device still waits for the
 * confirmation), `confirmed` (kept by Hopline's own confirm), `rolled-back` (not in effect: the
 * device timer or Hopline's rollback undid it), `unknown` (the output does not prove any of these).
 */
export type NetState = 'pending' | 'confirmed' | 'rolled-back' | 'unknown'

/** A line shape the session host accepts in a `net` verdict, and the prompt mode it is typed in. */
export interface NetTemplate {
  re: RegExp
  mode: 'exec' | 'config'
}

export interface SafetyNetSpec {
  kind: NetKind
  /** Short label for the approval card ("commit confirmed"). */
  label: string
  /** The device rolls the change back by itself unless it is confirmed in time. */
  timer: boolean
  /** One sentence for the card and the model: what happens if nobody confirms. */
  describe: (minutes: number) => string
  /** The configuration session the change is applied in under this net (Junos, EOS). */
  session: (name: string, minutes: number) => ConfigSession
  /** Wrapper lines of `session(...)` that are net lines (sent in a `net` verdict, not guard-classified). */
  sessionNetLines: (name: string, minutes: number) => string[]
  /** Typed at the exec prompt before the change (NX-OS checkpoint, IOS-XE archive). */
  arm: (name: string) => string[]
  /** Output of an arm line that means the snapshot was not taken. */
  armFailed?: readonly RegExp[]
  /**
   * A read run after arming to learn the snapshot the device chose (IOS-XE `show archive`): it
   * returns the snapshot id, or null when there is none.
   */
  learn?: { command: string; parse: (output: string) => string | null }
  /** Typed at the exec prompt to keep the change (empty: nothing to tell the device). */
  confirm: (name: string) => string[]
  /** Typed at the exec prompt to undo the change now. */
  rollback: (name: string, snapshot?: string) => string[]
  /** Output of a confirm or rollback line that means it did not take. */
  actionFailed?: readonly RegExp[]
  /** Typed after a confirm or a rollback, to remove the snapshot (NX-OS keeps at most 10). */
  cleanup?: (name: string) => string[]
  /**
   * Timer nets: a read that tells the state of THIS change (bound to the net name): still waiting
   * for confirmation, kept, not in effect (rolled back by the device or by Hopline), or unknown.
   * Anything the parser does not recognise is `unknown`, never `confirmed` (Phase 5 review H2/L3).
   * `absent`: the output is a history Hopline can read and this change's commit is not in it (used
   * only right after a commit that did not answer, to say it never reached the device).
   */
  /** `complete`: the read ended at the device prompt (not capped, timed out or interrupted). */
  check?: { command: string; state: (output: string, name: string, complete?: boolean) => NetState; absent?: (output: string, name: string) => boolean }
  templates: readonly NetTemplate[]
}

/** The snapshot / session name: `hopline-` and 8 lowercase hex digits, made by main. */
export const NET_NAME_RE = /^hopline-[0-9a-f]{8}$/
const NAME = 'hopline-[0-9a-f]{8}'

/** Minutes a timer net waits for confirmation. */
export const NET_MINUTES = { min: 1, max: 30, default: 5 } as const
const MINUTES = '(?:[1-9]|[12][0-9]|30)'
const MM = '(?:0[1-9]|[12][0-9]|30)'

/**
 * A device-chosen archive file on a LOCAL file system (`flash:`, `bootflash:`, `disk0:` …): letters,
 * digits and `._/-` only, no `//` (never a tftp/ftp/http URL), no `..`, and a file name after the
 * last `/` (never a bare `flash:/`). Not `nvram:` (Phase 5 review L5): the only archive-shaped file
 * there is the startup configuration, and replacing with it would also discard unsaved changes.
 */
const ARCHIVE_FILE = '(?:flash|bootflash|disk[0-9]|harddisk|usbflash[0-9]|slot[0-9]|crashinfo):(?!\\S*//)(?!\\S*\\.\\.)(?=[A-Za-z0-9._/-]{1,160}(?:\\s|$))/?(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+'
export const ARCHIVE_FILE_RE = new RegExp(`^${ARCHIVE_FILE}$`)

/**
 * IOS-XE: the archive `next` (after `archive config`) is a NEW snapshot following `prev` (before).
 * IOS names archives `<path>-<n>` (the path may hold `$h`/`$t`, so the text before `-<n>` can
 * differ): the new one must be on the same file system and in the same directory, with a higher
 * index. With no earlier archive (`prev` null) any well-formed file ending in `-<n>` counts. Phase 5
 * review L5: a silent `archive config` failure must not leave the rollback on an older archive.
 */
export function archiveSucceeds(prev: string | null, next: string | null): boolean {
  if (!next || !ARCHIVE_FILE_RE.test(next)) return false
  const parts = (f: string) => {
    const m = /^(.*[:/])[^/]*-(\d+)$/.exec(f)
    return m ? { dir: m[1]!, n: Number(m[2]) } : null
  }
  const b = parts(next)
  if (!b) return false
  if (prev === null) return true
  const a = parts(prev)
  return !!a && a.dir === b.dir && b.n > a.n
}

const t = (re: string, mode: NetTemplate['mode']): NetTemplate => ({ re: new RegExp(`^${re}$`), mode })

/** One row of Junos `show system commit`, with the comment line printed under it. */
interface JunosCommit {
  index: number
  text: string
  comment?: string
}

function junosCommits(out: string): JunosCommit[] {
  const rows: JunosCommit[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+\d{4}-\d\d-\d\d\s.*\bby\s+\S+\s+via\s+\S/.exec(line)
    if (m) rows.push({ index: Number(m[1]), text: line.trim() })
    else if (rows.length && /^\s{2,}\S/.test(line) && rows.at(-1)!.comment === undefined) rows.at(-1)!.comment = line.trim()
  }
  // The rows must be the history from index 0, in order; anything else is not a history we read.
  return rows.every((r, i) => r.index === i) ? rows : []
}

/**
 * Junos: the state of the change whose `commit confirmed` carries the comment `name`. Walks the
 * commits made after it, oldest first: Hopline's confirm (`name-ok`) keeps it, Hopline's rollback
 * (`name-undo`) or the device's own automatic rollback (`by root via other`) undoes it. Any other
 * commit after it (another admin, another tool) makes the state unknown: a plain commit would have
 * confirmed it, a `rollback` would not have. Positional `rollback 1` is only safe while the change is
 * `pending` (its commit is index 0), which the caller checks first.
 */
export function junosNetState(out: string, name: string): NetState {
  const rows = junosCommits(out)
  if (!rows.length) return 'unknown'
  const k = rows.findIndex((r) => r.comment === name)
  // Our commit is not in the history: never a positive claim here (a device that prints the comment
  // differently must not read as "rolled back"). See junosNetAbsent for the one place it is used.
  if (k < 0) return 'unknown'
  if (!/\bcommit confirmed\b/.test(rows[k]!.text)) return 'unknown'
  if (k === 0) return /\bcommit confirmed, rollback in \d+\s*mins?\b/.test(rows[0]!.text) ? 'pending' : 'unknown'
  let state: NetState = 'pending'
  for (let i = k - 1; i >= 0; i--) {
    const r = rows[i]!
    if (/\bcommit confirmed\b/.test(r.text)) return 'unknown'
    if (r.comment === `${name}-ok`) state = state === 'pending' ? 'confirmed' : state
    // `rollback 1` after the device already rolled back loads OUR commit again: it is live.
    else if (r.comment === `${name}-undo`) state = state === 'pending' ? 'rolled-back' : 'unknown'
    else if (r.comment === undefined && /\bby root via other\b/.test(r.text)) state = state === 'pending' ? 'rolled-back' : 'unknown'
    else return 'unknown'
    if (state === 'unknown') return state
  }
  return state
}

/**
 * Junos: the history is readable and holds no commit with this change's comment, and the newest
 * commit is not a pending `commit confirmed` (which could be ours with the comment printed in a way
 * we do not read). Only meaningful right after Hopline's own commit line did not answer.
 */
export function junosNetAbsent(out: string, name: string): boolean {
  const rows = junosCommits(out)
  return rows.length > 0 && !rows.some((r) => r.comment === name || (r.comment && r.comment.includes(name))) && !/\bcommit confirmed, rollback in\b/.test(rows[0]!.text)
}

/**
 * EOS: the state of configuration session `name` in `show configuration sessions`. The table must
 * be there; a missing session is not in effect (the commit timer, or Hopline's abort, deleted it;
 * EOS keeps a committed session as `completed`). The name must end at whitespace: a session whose
 * name extends ours is not ours (Phase 8 review B-7). A missing row counts only when the read was
 * `complete` (it ended at the prompt) and shows no pager or truncation marker; otherwise `unknown`.
 */
export function eosNetState(out: string, name: string, complete = false): NetState {
  if (!/^\s*Name\s+State\b/m.test(out)) return 'unknown'
  // EOS prints the table in fixed-width columns: our name (16 characters) overflows the Name column,
  // so the state follows it with no space (`hopline-0a1b2c3dpendingCommitTimer  admin`). After the
  // name comes either whitespace and the state, or directly a state word that ends the line or is
  // followed by column padding (two spaces or more). `hopline-0a1b2c3d-x …` or
  // `hopline-0a1b2c3dcompleted pending` (a session whose name extends ours) is not our row.
  const row = new RegExp(`^[ \\t]*(?:\\*[ \\t]*)?${name}(?:[ \\t]+(\\S+)|(pendingCommitTimer|completed|pending)(?: {2,}|[ \\t]*$))`, 'm').exec(out)
  if (!row) return complete && !/--\s*More\s*--|output truncated|<--- More --->/i.test(out) ? 'rolled-back' : 'unknown'
  const state = row[1] ?? row[2]
  return state === 'pendingCommitTimer' ? 'pending' : state === 'completed' ? 'confirmed' : 'unknown'
}

export const SAFETY_NETS: Readonly<Partial<Record<PlatformId, SafetyNetSpec>>> = {
  // Junos: commit confirmed inside the private candidate, then confirm with a plain commit (from a
  // new private session) after verification. Rolling back now is `rollback 1` + commit.
  junos: {
    kind: 'commit-confirmed',
    label: 'commit confirmed',
    timer: true,
    describe: (m) => `Junos rolls the change back by itself after ${m} minute${m === 1 ? '' : 's'} unless you confirm it.`,
    // Every Hopline commit carries a comment bound to the change (Phase 5 review H1/L3): the change's
    // own `commit confirmed` is `<name>`, the confirm `<name>-ok`, the rollback `<name>-undo`, so the
    // check reads the state of THIS change, not of whatever commit is newest.
    session: (name, m) => ({ ...CONFIG_SESSIONS.junos, commit: [`commit confirmed ${m} comment ${name}`], exit: ['exit configuration-mode'] }),
    sessionNetLines: (name, m) => [`commit confirmed ${m} comment ${name}`],
    arm: () => [],
    confirm: (name) => ['configure private', `commit comment ${name}-ok and-quit`],
    rollback: (name) => ['configure private', 'rollback 1', `commit comment ${name}-undo and-quit`],
    actionFailed: [/^error: /im, /shared configuration database modified/i],
    check: {
      command: 'show system commit',
      // `0   2025-… by admin via cli commit confirmed, rollback in 5mins` + `    hopline-…` while it waits.
      state: junosNetState,
      absent: junosNetAbsent
    },
    templates: [
      t('configure private', 'exec'),
      t(`commit confirmed ${MINUTES} comment ${NAME}`, 'config'),
      t(`commit comment ${NAME}-(?:ok|undo) and-quit`, 'config'),
      t('rollback 1', 'config'),
      t('exit configuration-mode', 'config')
    ]
  },
  // EOS: a named configuration session committed with `commit timer`; confirmed with
  // `configure session <name> commit`, rolled back now with `configure session <name> abort`.
  eos: {
    kind: 'session-timer',
    label: 'session commit timer',
    timer: true,
    describe: (m) => `EOS rolls the session back by itself after ${m} minute${m === 1 ? '' : 's'} unless you confirm it.`,
    session: (name, m) => ({
      enter: [`configure session ${name}`],
      linesFrom: 'config',
      commit: [`commit timer 00:${String(m).padStart(2, '0')}:00`],
      exit: [],
      abort: ['abort'],
      candidate: true
    }),
    sessionNetLines: (name, m) => [`configure session ${name}`, `commit timer 00:${String(m).padStart(2, '0')}:00`],
    arm: () => [],
    confirm: (name) => [`configure session ${name} commit`],
    rollback: (name) => [`configure session ${name} abort`],
    check: {
      command: 'show configuration sessions',
      state: eosNetState
    },
    templates: [t(`configure session ${NAME}`, 'exec'), t(`configure session ${NAME} (?:commit|abort)`, 'exec'), t(`commit timer 00:${MM}:00`, 'config')]
  },
  // NX-OS: a named checkpoint before the change; rollback to it on request; deleted afterwards.
  nxos: {
    kind: 'checkpoint',
    label: 'checkpoint',
    timer: false,
    describe: () => 'A checkpoint is taken first; rolling back restores it exactly.',
    session: () => CONFIG_SESSIONS.nxos,
    sessionNetLines: () => [],
    arm: (name) => [`checkpoint ${name}`],
    armFailed: [/^ERROR:/im],
    confirm: () => [],
    rollback: (name) => [`rollback running-config checkpoint ${name}`],
    actionFailed: [/^ERROR:/im, /Rollback failed/i],
    cleanup: (name) => [`no checkpoint ${name}`],
    templates: [t(`checkpoint ${NAME}`, 'exec'), t(`no checkpoint ${NAME}`, 'exec'), t(`rollback running-config checkpoint ${NAME}`, 'exec')]
  },
  // IOS-XE: an archive snapshot before the change; `configure replace <it> force` rolls back.
  iosxe: {
    kind: 'archive',
    label: 'archive',
    timer: false,
    describe: () => 'The running configuration is archived first; rolling back replaces it with that archive.',
    session: () => CONFIG_SESSIONS.iosxe,
    sessionNetLines: () => [],
    arm: () => ['archive config'],
    armFailed: [/not enabled/i, /path not specified/i, /^%\s*Error/im],
    learn: {
      command: 'show archive',
      parse: (out) => {
        const m = /(\S+)\s*<-\s*Most Recent/i.exec(out)
        return m && ARCHIVE_FILE_RE.test(m[1]!) ? m[1]! : null
      }
    },
    confirm: () => [],
    rollback: (_name, file) => (file && ARCHIVE_FILE_RE.test(file) ? [`configure replace ${file} force`] : []),
    actionFailed: [/^%\s*Error/im, /Rollback aborted/i, /Rollback failed/i],
    templates: [t('archive config', 'exec'), t(`configure replace ${ARCHIVE_FILE} force`, 'exec')]
  }
}

/** The platform's safety net, or undefined when it relies on the proposal's rollback lines. */
export function safetyNet(platform: PlatformId): SafetyNetSpec | undefined {
  return SAFETY_NETS[platform]
}

/**
 * The session host's check for a `net` verdict: the line matches one of the platform's fixed
 * templates, typed in that template's mode. `mode` is the mode the device prompt shows.
 */
export function netLineAllowed(platform: PlatformId, line: string, mode: 'exec' | 'config' | 'other'): boolean {
  const net = SAFETY_NETS[platform]
  if (!net || line !== line.trim() || /[^\x20-\x7e]/.test(line)) return false
  return net.templates.some((x) => x.mode === mode && x.re.test(line))
}
