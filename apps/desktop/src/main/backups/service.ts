import { BACKUP_COMMANDS, PLATFORM_IDS, type PlatformId } from '@hopline/cli-model'
import { classify, redact } from '@hopline/guard'
import type { BackupResult, BackupSchedule, BackupText, BackupTrigger } from '@shared/backups'
import { bindingHostname, cleanTerminalText, clusterHostnames, configHostnames, deviceError, hostBound, sameHost, unbindablePrompt } from '@shared/cli'
import { userInfo } from 'node:os'
import type { PromptInfo } from '@shared/host-protocol'
import type { Folder, Session, Settings } from '@shared/types'
import type { AuditLog } from '../db/audit'
import type { AgentTab, TabControl } from '../host/client'
import { isLocked } from '../vault/datakey'
import { isDue } from '@shared/backup-schedule'
import type { BackupStore } from './store'

/** Backups need the whole config: at least this much output and time, whatever the AI caps are. */
const MIN_CAP_BYTES = 8 * 1024 * 1024
const MIN_TIMEOUT_MS = 120_000
const PARALLEL = 4
const TICK_MS = 30_000

export interface BackupDeps {
  host: Pick<TabControl, 'exec'> & {
    tabsOf(sessionId: string): AgentTab[]
    /**
     * The multi-device background connection (stored credentials only, no prompts, no reconnect,
     * no window). Used when the session has no connected tab; always closed after the capture.
     */
    openBackground?(sessionId: string, signal?: AbortSignal): Promise<AgentTab>
    close?(tabId: string): void
    /** The device prompt now; its hostname binds a capture to the device earlier versions came from. */
    prompt?(tab: AgentTab): Promise<PromptInfo>
    /** Whether a tab is shown in the window that asked (`owner`): a renderer only reaches its own tabs. */
    ownedBy?(tabId: string, owner: unknown): boolean
  }
  repo: { getSession(id: string): Session | undefined; listSessions(): Session[]; listFolders(): Folder[] }
  audit: AuditLog
  settings: () => Pick<Settings, 'commandTimeoutMs' | 'outputCapBytes'>
  store: BackupStore
  /** Something changed (a version saved, a schedule ran): the renderer refreshes. */
  changed?: () => void
  now?: () => number
}

type Capture =
  | { ok: true; text: string; command: string; platform: PlatformId; tab: AgentTab; durationMs: number; bytes: number; background: boolean; hostname: string; accepted?: { from: string; to: string } }
  | { ok: false; result: BackupResult; otherDevice?: boolean }

const isModelled = (p: string): p is PlatformId => (PLATFORM_IDS as readonly string[]).includes(p)

/** The configuration as captured: no echo or prompt (the executor drops those), no CRs, no blank edges. */
export function cleanCapture(output: string): string {
  return cleanTerminalText(output)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * The name a backup is bound to (review B1, B8): the prompt hostname as the platform binds it, or,
 * when the prompt shows none or a factory name, the last hostname the configuration sets ('' when
 * neither says anything).
 */
export function deviceIdentity(platform: PlatformId, shown: string, text: string): string {
  if (!unbindablePrompt(platform, shown)) return bindingHostname(platform, shown)
  return configHostnames(text).at(-1) ?? bindingHostname(platform, shown)
}

/**
 * Takes config backups through the same doors as the agent: the guard classifies the platform's
 * backup command (it must be read-only), the session host re-checks the signed verdict, and every
 * attempt, including the ones skipped before anything was sent, is audited with source `backup`.
 * Nothing here ever writes configuration to a device.
 */
export class BackupService {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  /**
   * Scheduled slots a session missed because it had no connected tab (the usual case for the
   * catch-up right after start): the backup is taken when that session next connects, once.
   * In memory only; the schedule's own slot is marked run, so a restart doesn't pile them up.
   */
  private readonly pending = new Map<string, { since: number }>()
  private readonly now: () => number

  constructor(private readonly d: BackupDeps) {
    this.now = d.now ?? Date.now
  }

  private audit(
    s: Pick<Session, 'id' | 'name' | 'host'>,
    command: string,
    decision: 'executed' | 'blocked' | 'refused' | 'timeout' | 'capped' | 'error',
    reason: string,
    extra: { durationMs?: number; bytes?: number; redactions?: number; kind?: string; approver?: string } = {}
  ): void {
    this.d.audit.append({
      sessionId: s.id,
      sessionName: s.name,
      host: s.host,
      source: 'backup',
      command,
      kind: extra.kind ?? 'read',
      decision,
      reason,
      approver: extra.approver ?? null,
      durationMs: extra.durationMs ?? null,
      bytes: extra.bytes ?? null,
      redactions: extra.redactions ?? null
    })
  }

  /** Run the platform's backup command on a connected tab of the session. Audits failures. */
  private async capture(sessionId: string, why: string, owner?: unknown, accept?: string): Promise<Capture> {
    const s = this.d.repo.getSession(sessionId)
    if (!s) return { ok: false, result: { sessionId, sessionName: '(deleted)', outcome: 'skipped', reason: 'the session no longer exists' } }
    const fail = (outcome: 'failed' | 'skipped', reason: string): Capture => ({ ok: false, result: { sessionId, sessionName: s.name, outcome, reason } })
    const platform = s.platform
    if (!isModelled(platform)) {
      const reason = 'the platform is unknown (auto-detect has not identified it); set the platform first'
      this.audit(s, '(config backup)', 'refused', `${why}: ${reason}`)
      return fail('skipped', reason)
    }
    const command = BACKUP_COMMANDS[platform]
    // The guard is the gate even for Hopline's own commands.
    const v = classify(command, platform)
    if (v.kind !== 'read') {
      this.audit(s, command, 'blocked', `${why}: not read-only (${v.reason})`)
      return fail('failed', `the backup command is not classified read-only: ${v.reason}`)
    }
    // A request from a window only uses that window's tabs; another window's tab is not its to drive.
    const tabs = this.d.host.tabsOf(sessionId).filter((t) => owner === undefined || !!this.d.host.ownedBy?.(t.tabId, owner))
    if (!tabs.length) return this.captureInBackground(s, v.command, platform, why, accept)
    const st = this.d.settings()
    const opts = { timeoutMs: Math.max(st.commandTimeoutMs, MIN_TIMEOUT_MS), capBytes: Math.max(st.outputCapBytes, MIN_CAP_BYTES) }
    let last: Awaited<ReturnType<TabControl['exec']>> | null = null
    let tab = tabs[0]!
    for (const t of tabs) {
      tab = t
      last = await this.d.host.exec(t, v.command, 'read', opts)
      if (!(last.status === 'error' && /not connected/.test(last.error ?? ''))) break
    }
    const c = this.finish(s, v.command, platform, why, tab, last!, false, await this.ranAt(tab, last!), accept)
    // The tab shows another device (a hop, or a rename the tab can't tell apart): the background
    // connection goes straight to the session's host instead, where the binding is checked again.
    if (!c.ok && c.otherDevice && !this.backgroundRefusal(s)) return this.captureInBackground(s, v.command, platform, `${why}, the tab shows another device`, accept)
    return c
  }

  /**
   * The prompt hostname the command was typed at (review B7): the executor reports it with the
   * result, so a hop between a separate prompt check and the command can't slip through. Only a
   * host that reports none (older test fakes) is asked for the prompt afterwards; undefined when
   * neither is known (no binding is checked then).
   */
  private async ranAt(tab: AgentTab, r: Awaited<ReturnType<TabControl['exec']>>): Promise<string | undefined> {
    if (typeof r.hostname === 'string') return r.hostname
    if (!this.d.host.prompt) return undefined
    return (await this.d.host.prompt(tab)).hostname ?? ''
  }

  /** Why a session can't get a background connection, or null (the same rules as multi-device runs). */
  private backgroundRefusal(s: Session): string | null {
    if (!this.d.host.openBackground) return 'not connected: backups run on an open, connected tab'
    if (s.protocol === 'serial') return 'not connected: serial ports are only used from an open tab'
    if (s.protocol === 'telnet' || s.protocol === 'raw') return 'not connected: telnet sign-in is typed at the device, so it needs an open tab'
    if (s.ephemeral) return 'not connected: a quick-connect session is only used from its open tab'
    return null
  }

  /**
   * No connected tab: connect in the background like a multi-device run (stored credentials only,
   * never a prompt), run the same guarded read, and always close the connection.
   */
  private async captureInBackground(s: Session, command: string, platform: PlatformId, why: string, accept?: string): Promise<Capture> {
    const fail = (reason: string, outcome: 'failed' | 'skipped' = 'skipped'): Capture => ({ ok: false, result: { sessionId: s.id, sessionName: s.name, outcome, reason } })
    const refusal = this.backgroundRefusal(s)
    if (refusal) {
      this.audit(s, command, 'refused', `${why}: ${refusal}`)
      return fail(refusal)
    }
    let tab: AgentTab
    try {
      tab = await this.d.host.openBackground!(s.id)
    } catch (e) {
      const reason = `not connected: a background connection failed (${e instanceof Error ? e.message : String(e)})`
      this.audit(s, command, 'refused', `${why}: ${reason}`)
      return fail(reason)
    }
    try {
      const st = this.d.settings()
      const r = await this.d.host.exec(tab, command, 'read', { timeoutMs: Math.max(st.commandTimeoutMs, MIN_TIMEOUT_MS), capBytes: Math.max(st.outputCapBytes, MIN_CAP_BYTES) })
      return this.finish(s, command, platform, `${why}, background connection`, tab, r, true, await this.ranAt(tab, r), accept)
    } finally {
      this.d.host.close?.(tab.tabId)
    }
  }

  private finish(s: Session, command: string, platform: PlatformId, why: string, tab: AgentTab, r: Awaited<ReturnType<TabControl['exec']>>, background: boolean, shown: string | undefined, accept?: string): Capture {
    const fail = (outcome: 'failed' | 'skipped', reason: string): Capture => ({ ok: false, result: { sessionId: s.id, sessionName: s.name, outcome, reason } })
    const st = this.d.settings()
    const capBytes = Math.max(st.outputCapBytes, MIN_CAP_BYTES)
    if (r.status !== 'ok') {
      const reason = r.error ?? r.status
      this.audit(s, command, r.status, `${why}: not stored (${reason})`, { durationMs: r.durationMs, bytes: r.bytes })
      return fail('failed', r.status === 'capped' ? `the output hit the ${Math.round(capBytes / 1048576)} MB cap; nothing was stored` : reason)
    }
    const text = cleanCapture(r.output)
    // A device error right after the command (an unsupported keyword): not a configuration.
    const err = deviceError(platform, text.split('\n').slice(0, 5).join('\n'))
    if (err || text.split('\n').length < 3) {
      const reason = err ? `the device answered "${err}"` : 'the device returned no configuration'
      this.audit(s, command, 'error', `${why}: not stored (${reason})`, { durationMs: r.durationMs, bytes: r.bytes })
      return fail('failed', reason)
    }
    const identity = shown === undefined ? undefined : deviceIdentity(platform, shown, text)
    const check = identity === undefined ? null : this.otherDevice(s.id, platform, shown!, identity, text, background, accept)
    if (check && 'refused' in check) {
      this.audit(s, command, 'refused', `${why}: not stored (${check.refused})`, { durationMs: r.durationMs, bytes: r.bytes })
      return { ok: false, result: { sessionId: s.id, sessionName: s.name, outcome: 'skipped', reason: check.refused, ...(check.renamed ? { renamed: check.renamed } : {}) }, otherDevice: true }
    }
    return { ok: true, text, command, platform, tab, durationMs: r.durationMs, bytes: r.bytes, background, hostname: identity ?? '', ...(check?.accepted ? { accepted: check.accepted } : {}) }
  }

  /**
   * The capture is bound to the device earlier versions came from: the device name must match the
   * one recorded with the session's newest version that has one (a tab that hopped to another
   * device with ssh/telnet shows another prompt). The name is the prompt hostname as the platform
   * binds it (`bindingHostname`: ASA `fw/sec/act` is `fw`), or, where the prompt shows none or a
   * factory one (FTD `>`, VRP `<HUAWEI>`, AireOS `(Cisco Controller)`), the hostname the captured
   * configuration sets. Accepted besides:
   * - both names are nodes of one SRX chassis cluster (`set groups nodeN system host-name`);
   * - the user accepted this new name (`acceptRename`, audited with them as approver);
   * - a background connection, which goes straight to the session's host, finds a configuration
   *   that itself sets the name the prompt shows: a rename (trust on first use of the host address).
   * Returns null (no earlier name, or a match), the accepted rename, or why it is refused.
   */
  private otherDevice(
    sessionId: string,
    platform: PlatformId,
    shown: string,
    identity: string,
    text: string,
    background: boolean,
    accept?: string
  ): null | { accepted: { from: string; to: string } } | { refused: string; renamed?: { from: string; to: string } } {
    const expected = this.d.store.lastHostname(sessionId)
    if (expected === null) return null
    const was = bindingHostname(platform, expected)
    if (hostBound([was], identity)) return null
    const nodes = clusterHostnames(text)
    if (nodes.some((n) => sameHost(n, was)) && nodes.some((n) => sameHost(n, identity))) return null
    if (identity && accept !== undefined && sameHost(accept, identity)) return { accepted: { from: was, to: identity } }
    if (background && identity && configHostnames(text).some((h) => sameHost(h, identity))) return null
    return {
      refused: `the device prompt shows "${shown || '(no hostname)'}", but earlier backups of this session came from "${was}"; a tab that hopped to another device is never backed up as this one`,
      ...(identity ? { renamed: { from: was, to: identity } } : {})
    }
  }

  /**
   * The user says the device was renamed (review B3): back it up once more, accepting `hostname`
   * as its new name if that is exactly the name it shows now. Audited with the user as approver;
   * later backups are bound to the new name. Nothing else about the binding changes.
   */
  async acceptRename(sessionId: string, hostname: string, owner?: unknown): Promise<BackupResult> {
    const r = await this.takeOne(sessionId, 'manual', owner, hostname.trim())
    if (r.outcome === 'saved' || r.outcome === 'unchanged') this.d.changed?.()
    return r
  }

  /** Back up one session and store the version unless it is unchanged. */
  async takeOne(sessionId: string, trigger: BackupTrigger, owner?: unknown, accept?: string): Promise<BackupResult> {
    const why = `config backup (${trigger})`
    const c = await this.capture(sessionId, why, owner, accept)
    if (!c.ok) return c.result
    const s = c.tab.session
    if (c.accepted)
      this.audit(s, `device renamed: accept ${c.accepted.to}`, 'executed', `config backup binding moved from "${c.accepted.from}" to "${c.accepted.to}" (accepted by the user)`, {
        kind: 'binding',
        approver: userInfo().username
      })
    const meta = { durationMs: c.durationMs, bytes: c.bytes, redactions: redact(c.text).count }
    try {
      const { version, unchanged } = await this.d.store.add({ sessionId, sessionName: s.name, platform: c.platform, text: c.text, trigger, command: c.command, hostname: c.hostname })
      const via = c.background ? ', background connection' : ''
      this.audit(s, c.command, 'executed', unchanged ? `${why}${via}: unchanged since the last version` : `${why}${via}: stored version ${version.id.slice(0, 8)}`, meta)
      return { sessionId, sessionName: s.name, outcome: unchanged ? 'unchanged' : 'saved', versionId: version.id }
    } catch (e) {
      const reason = isLocked(e) ? 'the vault is locked; unlock it to store backups' : e instanceof Error ? e.message : String(e)
      this.audit(s, c.command, 'executed', `${why}: not stored (${reason})`, meta)
      return { sessionId, sessionName: s.name, outcome: 'failed', reason }
    }
  }

  /** Several sessions, a few at a time (each device is independent). */
  async take(sessionIds: string[], trigger: BackupTrigger = 'manual', owner?: unknown): Promise<BackupResult[]> {
    const ids = [...new Set(sessionIds)]
    const out: BackupResult[] = new Array(ids.length)
    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        const i = next++
        out[i] = await this.takeOne(ids[i]!, trigger, owner)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker))
    if (out.some((r) => r.outcome === 'saved')) this.d.changed?.()
    return out
  }

  /** The running config now, for "Compare with live": captured the same guarded way, audited, not stored. */
  async live(sessionId: string, owner?: unknown): Promise<BackupText> {
    const c = await this.capture(sessionId, 'config backup (compare with live)', owner)
    if (!c.ok) throw new Error(`Could not read the running config of ${c.result.sessionName}: ${c.result.reason}`)
    const red = redact(c.text)
    this.audit(c.tab.session, c.command, 'executed', 'config backup (compare with live): shown, not stored', { durationMs: c.durationMs, bytes: c.bytes, redactions: red.count })
    return { id: null, ts: this.now(), sessionName: c.tab.session.name, platform: c.platform, text: red.text, redactions: red.count }
  }

  /** A stored version as the renderer may see it (redacted). */
  async view(id: string): Promise<BackupText> {
    const m = this.d.store.meta(id)
    if (!m) throw new Error('No such backup version')
    const red = redact(await this.d.store.text(id))
    return { id, ts: m.ts, sessionName: m.sessionName, platform: m.platform, text: red.text, redactions: red.count }
  }

  // ---------------------------------------------------------------- schedules

  /** Sessions a schedule covers: a folder with its subfolders, or a tag. */
  targets(s: Pick<BackupSchedule, 'kind' | 'target'>): Session[] {
    const sessions = this.d.repo.listSessions()
    if (s.kind === 'tag') return sessions.filter((x) => x.tags.includes(s.target.toLowerCase()))
    const folders = this.d.repo.listFolders()
    const inside = new Set([s.target])
    for (let grew = true; grew; ) {
      grew = false
      for (const f of folders)
        if (f.parentId && inside.has(f.parentId) && !inside.has(f.id)) {
          inside.add(f.id)
          grew = true
        }
    }
    return sessions.filter((x) => x.folderId !== null && inside.has(x.folderId))
  }

  /**
   * Run every due schedule once. Scheduled runs never prompt: a session without a connected tab is
   * reached over a background connection with stored credentials; one that needs a typed sign-in is
   * backed up when it next connects.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const s of this.d.store.schedules()) {
        const at = this.now()
        if (!isDue(s, at)) continue
        const results = await this.take(
          this.targets(s).map((x) => x.id),
          'scheduled'
        )
        for (const r of results) if (r.outcome === 'skipped' && /not connected/.test(r.reason ?? '')) this.pending.set(r.sessionId, { since: at })
        const waiting = results.filter((r) => this.pending.has(r.sessionId)).length
        this.d.store.markRun(s.id, at, summarize(results) + (waiting ? `; ${waiting} will be backed up when they connect` : ''))
        this.d.changed?.()
      }
    } finally {
      this.ticking = false
    }
  }

  /** Sessions with a scheduled backup waiting for a connection. */
  pendingSessions(): string[] {
    return [...this.pending.keys()]
  }

  /**
   * A tab of `sessionId` reached the device. If a scheduled backup is waiting for it, take it once
   * the device has had time to show its prompt (the executor still requires an idle prompt and
   * refuses otherwise; a refusal retries a few times, then gives up until the next slot).
   */
  onConnected(sessionId: string, delays: readonly number[] = [5_000, 15_000, 45_000]): Promise<BackupResult | undefined> {
    if (!this.pending.has(sessionId)) return Promise.resolve(undefined)
    const attempt = async (i: number): Promise<BackupResult | undefined> => {
      await new Promise((r) => setTimeout(r, delays[i]))
      if (!this.pending.has(sessionId)) return undefined
      const r = await this.takeOne(sessionId, 'scheduled')
      if (r.outcome === 'saved' || r.outcome === 'unchanged' || i + 1 >= delays.length) {
        this.pending.delete(sessionId)
        if (r.outcome === 'saved') this.d.changed?.()
        return r
      }
      return attempt(i + 1)
    }
    return attempt(0)
  }

  /** Check schedules every 30 s while the app runs, and once shortly after start (catch-up). */
  start(firstDelayMs = 10_000): void {
    if (this.timer) return
    setTimeout(() => void this.tick().catch((e) => console.error('[hopline] backup schedule:', e)), firstDelayMs)
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('[hopline] backup schedule:', e)), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export function summarize(results: BackupResult[]): string {
  if (!results.length) return 'no sessions'
  const n = (o: BackupResult['outcome']) => results.filter((r) => r.outcome === o).length
  return (
    [
      [n('saved'), 'saved'],
      [n('unchanged'), 'unchanged'],
      [n('failed'), 'failed'],
      [n('skipped'), 'skipped (not connected or unknown platform)']
    ] as const
  )
    .filter(([k]) => k > 0)
    .map(([k, w]) => `${k} ${w}`)
    .join(', ')
}
