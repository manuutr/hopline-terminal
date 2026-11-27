import { randomUUID } from 'node:crypto'
import type { MultiEvent, MultiMode, MultiPreview, MultiPreviewRequest, MultiPreviewRow, MultiStartRequest, ResolvedTarget, TargetSpec, TargetStatus } from '@shared/productivity'
import type { Folder, Session } from '@shared/types'
import type { AgentTab, TabControl } from '../host/client'
import { translate } from './multi-plan'
import { parseTable, RUN_PARSE_BUDGET_MS } from './parsers'
import { analyze, splitLines, type Analysis, type GuardedRunner } from './runner'

/** Devices one run may reach. */
export const MAX_TARGETS = 64
export const MAX_CONCURRENCY = 8
const PREVIEW_TTL_MS = 10 * 60_000

/** What multi-device work needs from the session host (SessionHostClient; a fake in tests). */
export interface MultiHost extends TabControl {
  /** Open tabs of a session (never background connections). */
  tabsOf(sessionId: string): AgentTab[]
  /** Connect without a window, using stored credentials only; resolves idle at a prompt. */
  openBackground(sessionId: string, signal?: AbortSignal): Promise<AgentTab>
  close(tabId: string): void
  /** The tab is shown in this window. */
  ownedBy(tabId: string, owner: object): boolean
}

export interface MultiDeps {
  host: MultiHost
  runner: GuardedRunner
  repo: { listSessions(): Session[]; listFolders(): Pick<Folder, 'id' | 'parentId'>[]; getSession(id: string): Session | undefined }
  emit: (owner: object, e: MultiEvent) => void
}

interface StoredPreview {
  owner: object
  mode: MultiMode
  rows: MultiPreviewRow[]
  analyses: Map<string, Analysis>
  /** Open-tab targets: the hostname their prompt showed at preview; the run is refused if it changed. */
  hostnames: Map<string, string>
  at: number
  /** Every row was refused: the refusals were audited when the preview was made. */
  audited?: boolean
}

interface Run {
  owner: object
  abort: AbortController
}

const sameOwner = (a: object, b: object) => a === b

/** Folders below a folder, the folder included. */
function subtree(folderId: string, folders: Pick<Folder, 'id' | 'parentId'>[]): Set<string> {
  const ids = new Set([folderId])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
  }
  return ids
}

/**
 * Send-to-many and multi-device runs. Targets are resolved here (never trusted from the renderer),
 * each target's lines are classified for its own platform, the preview is stored in main and
 * started by id, and every target runs through the GuardedRunner (source `multi`): read-only lines
 * at once, configuration only after the user confirmed it, disruptive and blocked never.
 */
export class MultiService {
  private previews = new Map<string, StoredPreview>()
  private runs = new Map<string, Run>()

  constructor(private readonly d: MultiDeps) {}

  /** The devices a target spec names, deduplicated, with an open tab of this window when there is one. */
  resolve(spec: TargetSpec, owner: object): ResolvedTarget[] {
    const out = new Map<string, ResolvedTarget>()
    const add = (s: Session, tabId?: string) => {
      const prev = out.get(s.id)
      if (prev) {
        if (!prev.tabId && tabId) prev.tabId = tabId
        return
      }
      const open = tabId ?? this.d.host.tabsOf(s.id).find((t) => this.d.host.ownedBy(t.tabId, owner))?.tabId
      const t: ResolvedTarget = { key: s.id, sessionId: s.id, name: s.name, host: s.host, platform: s.platform, ...(open ? { tabId: open } : {}) }
      if (s.platform === 'auto') t.excluded = 'the platform is not known yet: connect once so Hopline Terminal can detect it, or set it in the session'
      else if (!open && s.protocol === 'serial') t.excluded = 'serial ports are only used from an open tab'
      // Telnet has no protocol-level sign-in: the login is typed at the device, which a background connection can't do.
      else if (!open && (s.protocol === 'telnet' || s.protocol === 'raw')) t.excluded = 'telnet sign-in is typed at the device: open a tab for it first'
      else if (!open && s.ephemeral) t.excluded = 'a quick-connect session is only used from its open tab'
      out.set(s.id, t)
    }
    for (const tabId of spec.tabs ?? []) {
      const tab = this.d.host.ownedBy(tabId, owner) ? this.d.host.get(tabId) : undefined
      if (tab) add(tab.session, tabId)
    }
    const sessions = this.d.repo.listSessions()
    const folders = this.d.repo.listFolders()
    const wanted = new Set(spec.sessions ?? [])
    const inFolders = new Set((spec.folders ?? []).flatMap((f) => [...subtree(f, folders)]))
    const tags = new Set(spec.tags ?? [])
    for (const s of sessions) if (wanted.has(s.id) || (s.folderId && inFolders.has(s.folderId)) || s.tags.some((t) => tags.has(t))) add(s)
    const list = [...out.values()]
    if (list.length > MAX_TARGETS) throw new Error(`That is ${list.length} devices; one run reaches at most ${MAX_TARGETS}`)
    return list
  }

  /** The exact lines per target and the guard's verdict for each, on its own platform. Nothing is sent. */
  async preview(req: MultiPreviewRequest, owner: object): Promise<MultiPreview> {
    this.expire()
    const targets = this.resolve(req.targets, owner)
    if (!targets.length) throw new Error('No devices selected')
    const body = splitLines(req.command)
    if ('error' in body) throw new Error(body.error)
    if (req.mode === 'run' && body.lines.length !== 1) throw new Error('A multi-device run takes one show command')
    const rows: MultiPreviewRow[] = []
    const analyses = new Map<string, Analysis>()
    const hostnames = new Map<string, string>()
    for (const target of targets) {
      if (target.excluded) {
        // Kept as a plan so the attempt is audited like any refusal.
        analyses.set(target.key, { ...analyze('auto', body.lines), reason: target.excluded })
        rows.push({ target, lines: [], kind: 'refused', reason: target.excluded })
        continue
      }
      let lines = body.lines
      let translated = false
      if (req.mode === 'run' && req.perPlatform) {
        const t = translate(lines[0]!, target.platform)
        lines = [t.command]
        translated = t.translated
      }
      const a = analyze(target.platform, lines, { multi: true, readOnly: req.mode === 'run', readOnlyMode: this.d.runner.readOnlyMode(), policy: this.d.runner.policyRules() })
      analyses.set(target.key, a)
      // A reused tab is bound to the device it shows now (a nested ssh/telnet hop changes the prompt).
      const tab = target.tabId ? this.d.host.get(target.tabId) : undefined
      if (tab) {
        const p = await this.d.host.prompt(tab)
        hostnames.set(target.key, p.hostname)
        target.hostname = p.hostname
      }
      rows.push({ target, lines: a.lines, kind: a.kind, reason: a.reason, ...(a.wrapper ? { wrapper: a.wrapper } : {}), ...(translated ? { translated } : {}) })
    }
    const runs = (r: MultiPreviewRow) => r.kind === 'read' || r.kind === 'config'
    const counts = { read: rows.filter((r) => r.kind === 'read').length, config: rows.filter((r) => r.kind === 'config').length, refused: rows.filter((r) => !runs(r)).length }
    const previewId = randomUUID()
    // Nothing can run: there will be no start, so the refusals are on record now.
    const audited = counts.read + counts.config === 0
    if (audited) for (const row of rows) this.refuseRow(row, analyses.get(row.target.key), this.auditOpts(req.mode, previewId))
    this.previews.set(previewId, { owner, mode: req.mode, rows, analyses, hostnames, at: Date.now(), ...(audited ? { audited } : {}) })
    return { previewId, mode: req.mode, rows, counts, needsConfirm: counts.config > 0 }
  }

  private auditOpts(mode: MultiMode, id: string) {
    return { source: 'multi' as const, note: `${mode === 'run' ? 'multi-device run' : 'send to many'} ${id.slice(0, 8)}` }
  }

  /** Audit a row that never runs (refused, blocked or excluded at preview). */
  private refuseRow(row: MultiPreviewRow, a: Analysis | undefined, o: { source: 'multi'; note: string }): void {
    const session = this.d.repo.getSession(row.target.sessionId)
    if (a && session) this.d.runner.refuse({ tabId: row.target.tabId ?? '', session }, a, { ...o, approved: false }, row.kind === 'blocked' ? 'blocked' : 'refused', row.reason)
  }

  /** One audit row for a target, by session (a target that never connected or failed outside the runner). */
  private note(row: MultiPreviewRow, command: string, decision: 'error' | 'cancelled' | 'rejected', reason: string, o: { source: 'multi'; note: string }): void {
    const session = this.d.repo.getSession(row.target.sessionId)
    if (session) this.d.runner.record({ tabId: row.target.tabId ?? '', session }, command || '(empty)', row.kind, decision, reason, o)
  }

  /**
   * The user left a preview without starting it. A configuration preview is recorded as declined
   * for every device it would have changed; the preview is dropped either way.
   */
  decline(previewId: string, owner: object): void {
    const p = this.previews.get(previewId)
    if (!p || !sameOwner(p.owner, owner)) return
    this.previews.delete(previewId)
    const o = this.auditOpts(p.mode, previewId)
    for (const row of p.rows) if (row.kind === 'config') for (const l of row.lines) this.note(row, l.command, 'rejected', 'declined by user at the preview', o)
  }

  /** Run a preview (once). Events arrive on `multi:event`; the result is the run id. */
  start(req: MultiStartRequest, owner: object): { runId: string } {
    this.expire()
    const p = this.previews.get(req.previewId)
    if (!p || !sameOwner(p.owner, owner)) throw new Error('This preview expired; preview again')
    const needsConfirm = p.rows.some((r) => r.kind === 'config')
    if (needsConfirm && !req.confirmConfig) throw new Error('Confirm the configuration change first')
    this.previews.delete(req.previewId)
    const runId = randomUUID()
    const run: Run = { owner, abort: new AbortController() }
    this.runs.set(runId, run)
    void this.execute(runId, run, p, req).finally(() => this.runs.delete(runId))
    return { runId }
  }

  /** Stop a run: targets not started are skipped, running commands are cancelled. */
  cancel(runId: string, owner: object): void {
    const r = this.runs.get(runId)
    if (r && sameOwner(r.owner, owner)) r.abort.abort()
  }

  /** A window closed or reloaded: stop what it started; its previews will never start (audited). */
  cancelFor(owner: object): void {
    for (const r of this.runs.values()) if (sameOwner(r.owner, owner)) r.abort.abort()
    for (const [id, p] of this.previews) if (sameOwner(p.owner, owner)) this.drop(id, 'the window closed before the preview was started')
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, p] of this.previews) if (now - p.at > PREVIEW_TTL_MS) this.drop(id, 'the preview expired before it was started')
  }

  /** A preview that will never start: the lines it would have sent are on record (review A2). */
  private drop(id: string, reason: string): void {
    const p = this.previews.get(id)
    if (!p) return
    this.previews.delete(id)
    if (p.audited) return
    const o = this.auditOpts(p.mode, id)
    for (const row of p.rows) if (row.kind === 'read' || row.kind === 'config') for (const l of row.lines) this.note(row, l.command, 'cancelled', reason, o)
  }

  private async execute(runId: string, run: Run, p: StoredPreview, req: MultiStartRequest): Promise<void> {
    const emit = (key: string, status: TargetStatus, extra: Partial<MultiEvent> = {}) => this.d.emit(run.owner, { runId, key, status, ...extra })
    const signal = run.abort.signal
    const note = `${p.mode === 'run' ? 'multi-device run' : 'send to many'} ${runId.slice(0, 8)}`
    const opts = { source: 'multi' as const, multi: true, readOnly: p.mode === 'run', note, signal }
    const queue = [...p.rows]
    for (const r of queue) emit(r.target.key, 'queued')
    // One parse budget for the whole run: hostile output on many devices can't stall main (M7).
    const parseBudget = { remainingMs: RUN_PARSE_BUDGET_MS }

    const one = async (row: MultiPreviewRow): Promise<void> => {
      const { target } = row
      const command = row.lines.map((l) => l.command).join('\n')
      const a = p.analyses.get(target.key)
      if (signal.aborted) {
        if (row.kind === 'read' || row.kind === 'config') this.note(row, command, 'cancelled', 'skipped: the run was stopped before this device', opts)
        return emit(target.key, 'skipped', { reason: 'stopped', command })
      }
      // Refused and blocked rows never run; they are audited as attempts (unless the preview already did).
      if (!a || (row.kind !== 'read' && row.kind !== 'config')) {
        if (!p.audited) this.refuseRow(row, a, opts)
        return emit(target.key, row.kind === 'blocked' ? 'blocked' : 'refused', { reason: row.reason, command })
      }
      const started = Date.now()
      let tabId = target.tabId
      let background = false
      try {
        if (!tabId || !this.d.host.get(tabId)) {
          emit(target.key, 'connecting')
          try {
            tabId = (await this.d.host.openBackground(target.sessionId, signal)).tabId
            background = true
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e)
            this.note(row, command, signal.aborted ? 'cancelled' : 'error', `could not connect: ${why}`, opts)
            return emit(target.key, signal.aborted ? 'cancelled' : 'error', { reason: `could not connect: ${why}`, command, durationMs: Date.now() - started, background: true })
          }
        }
        emit(target.key, 'running', { command, background })
        const bound = background ? undefined : p.hostnames.get(target.key)
        const r = await this.d.runner.run(tabId, a, { ...opts, approved: a.kind === 'read' || req.confirmConfig, ...(bound !== undefined ? { hostname: bound } : {}) })
        const table = p.mode === 'run' && r.status === 'ok' ? await parseTable(target.platform, a.commands[0]!, r.output, parseBudget) : null
        emit(target.key, r.status, { output: r.output, reason: r.reason, command, durationMs: Date.now() - started, background, ...(table ? { table } : {}) })
      } finally {
        if (background && tabId) this.d.host.close(tabId)
      }
    }

    const width = Math.min(Math.max(1, Math.floor(req.concurrency) || 1), MAX_CONCURRENCY)
    const workers = Array.from({ length: Math.min(width, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        await one(row).catch((e: unknown) => {
          const why = e instanceof Error ? e.message : String(e)
          this.note(row!, row!.lines.map((l) => l.command).join('\n'), 'error', `failed: ${why}`, opts)
          emit(row!.target.key, 'error', { reason: why })
        })
      }
    })
    await Promise.all(workers)
    this.d.emit(run.owner, { runId, key: '', status: signal.aborted ? 'cancelled' : 'ok', done: true })
  }
}
