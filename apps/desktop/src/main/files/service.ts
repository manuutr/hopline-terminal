/**
 * The transfer queue, in main: local file access, the overwrite policy, hashing, progress and the
 * audit. The session host only moves bytes between the device and main (see session-host/files.ts).
 *
 * - Local paths come from main's own dialogs or from files the user dropped (resolved by the
 *   preload). The renderer names remote paths and transfer ids only.
 * - Downloads write `<name>.hopline-part` (exclusive, no-follow) inside the chosen folder and are
 *   moved to their final name when complete, never over an existing file unless the user chose
 *   "Overwrite" for it.
 * - One transfer runs per tab at a time; tabs run in parallel. Bytes move under an ack window, so
 *   memory stays flat for multi-gigabyte images.
 * - Every transfer is audited when it ends (source `transfer`: direction, remote path, size, hash).
 */
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { CAPTURE_BYTES } from '@shared/packets'
import { basename } from 'node:path'
import type { WebContents } from 'electron'
import type { ConflictChoice, Direction, FilePreview, FilesInfo, FilesOp, OverwritePolicy, QueueResult, RemoteEntry, TransferConflict, TransferEvent, TransferItem } from '@shared/files'
import { remoteBase, remoteJoin, remoteParent, rootsFor, verifyCommand } from '@shared/files'
import type { HostToMain, MainToHost } from '@shared/host-protocol'
import type { Session } from '@shared/types'
import type { AuditEntry } from '../db/audit'
import { directoryCommand, type ScpDirectoryEntry } from '@shared/scp-directory'
import { scpPathProblem } from '@hopline/transports/src/scp.ts'
import { checkUploadSource, childPath, commitPart, freeName, lstatMaybe, numbered, openPart, PART_SUFFIX, safeLocalName } from './paths'

export interface CaptureDownload {
  path: string
  name: string
  sha256: string
}

/** What the service needs from the session host client (tests pass a stand-in). */
export interface FilesHost {
  owned(tabId: string, sender?: WebContents): { session: Session; wc: WebContents } | undefined
  /** The session of a background connection (no window), for auditing what happens on it. */
  background?(tabId: string): Session | undefined
  request<T>(build: (id: number) => MainToHost): Promise<T>
  send(m: MainToHost): void
  onHostMessage(fn: (m: HostToMain) => void): () => void
}

export interface FilesDeps {
  host: FilesHost
  audit: { append(e: AuditEntry): void }
  /** Ask for a download folder (native dialog). */
  pickDir(wc: WebContents): Promise<string | null>
  /** Global read-only mode is on: uploads are refused (review Low 5). */
  readOnly?(): boolean
}

/** Unacknowledged upload bytes in flight to the host. */
const WINDOW = 2 * 1024 * 1024
const CHUNK = 64 * 1024
const EVENT_MS = 150

interface Job {
  item: TransferItem
  wc: WebContents
  sessionId: string | null
  host: string
  platform: string
  /** Upload: the local source. */
  source?: string
  /** Download: the folder and the name it will get. */
  dir?: string
  name?: string
  /** Download: replace an existing file at `name` (the user chose Overwrite). */
  replace?: boolean
  /** Byte to resume from (SFTP only): download = size of the part file, upload = remote size. */
  offset?: number
  /** Upload: refuse to replace an existing remote file (new name, or nothing was there). */
  exclusive?: boolean
  /** The final local path (completed downloads, for drag-out and reveal). */
  finalPath?: string
  capture?: boolean
  ctrl?: { cancelled: boolean; wake?: () => void; acked: number; unacked: number }
  lastEmit?: number
  speedAt?: { t: number; done: number }
}

interface PendingConflict {
  job: Job
  info: TransferConflict
  /** Upload: the remote size (resume offset). */
  remoteSize?: number
  existsRemote?: boolean
}

/** An upload refused when its job starts because read-only mode was turned on after it was queued. */
const LATE_READ_ONLY = 'Upload refused: read-only mode is on (Settings › Assistant › Read-only mode)'

export class TransferService {
  private jobs = new Map<string, Job>()
  private order: string[] = []
  private busyTabs = new Set<string>()
  private conflicts = new Map<string, PendingConflict>()
  private dirs = new WeakMap<WebContents, string>()
  private infos = new Map<string, FilesInfo>()
  /** Live handlers for host messages of running transfers, by xfer id. */
  private routes = new Map<string, (m: HostToMain) => void>()

  constructor(private readonly deps: FilesDeps) {
    deps.host.onHostMessage((m) => {
      if (m.t === 'xfer-data' || m.t === 'xfer-ack' || m.t === 'xfer-meta') this.routes.get(m.xferId)?.(m)
    })
  }

  // ------------------------------------------------------------------ browsing

  private tab(tabId: string, sender: WebContents) {
    const t = this.deps.host.owned(tabId, sender)
    if (!t) throw new Error('That tab is not open')
    if (t.session.protocol !== 'ssh') throw new Error('Files need an SSH session')
    return t
  }

  async open(tabId: string, sender: WebContents): Promise<FilesInfo> {
    const t = this.tab(tabId, sender)
    const info = await this.deps.host.request<FilesInfo>((id) => ({ t: 'files', id, tabId, op: { op: 'open' } }))
    const roots = rootsFor(t.session.platform)
    const full: FilesInfo = { ...info, roots, home: info.home || roots[0] || '' }
    this.infos.set(tabId, full)
    return full
  }

  async listScpDirectory(tabId: string, sender: WebContents, path: string): Promise<ScpDirectoryEntry[]> {
    const { session } = this.tab(tabId, sender)
    const command = directoryCommand(session.platform, path)
    const audit = { sessionId: session.ephemeral ? null : session.id, sessionName: session.name, host: session.host, source: 'transfer' as const, command, kind: 'read', approver: 'user', durationMs: null, bytes: null, redactions: null }
    try {
      const entries = await this.deps.host.request<ScpDirectoryEntry[]>((id) => ({ t: 'files', id, tabId, op: { op: 'scp-directory', path, platform: session.platform } }))
      this.deps.audit.append({ ...audit, decision: 'executed', reason: 'Browse SCP device directory' })
      return entries
    } catch (e) {
      this.deps.audit.append({ ...audit, decision: 'error', reason: e instanceof Error ? e.message : 'Directory unavailable' })
      throw e
    }
  }

  async preview(tabId: string, sender: WebContents, path: string): Promise<FilePreview> {
    const { session } = this.tab(tabId, sender)
    return this.deps.host.request<FilePreview>((id) => ({ t: 'files', id, tabId, op: { op: 'preview', path, platform: session.platform } }))
  }

  async op(tabId: string, sender: WebContents, op: FilesOp): Promise<RemoteEntry[] | RemoteEntry | null> {
    const t = this.tab(tabId, sender)
    const r = await this.deps.host.request<RemoteEntry[] | RemoteEntry | null>((id) => ({ t: 'files', id, tabId, op })).catch((e: unknown) => {
      if (op.op === 'mkdir' || op.op === 'rename' || op.op === 'remove') this.auditOp(t.session, op, e instanceof Error ? e.message : String(e))
      throw e
    })
    if (op.op === 'mkdir' || op.op === 'rename' || op.op === 'remove') this.auditOp(t.session, op)
    return r
  }

  private auditOp(s: Session, op: Extract<FilesOp, { op: 'mkdir' | 'rename' | 'remove' }>, error?: string): void {
    const command = op.op === 'rename' ? `sftp rename ${op.from} → ${op.to}` : `sftp ${op.op === 'remove' ? (op.dir ? 'rmdir' : 'rm') : 'mkdir'} ${op.path}`
    this.deps.audit.append({
      sessionId: s.ephemeral ? null : s.id,
      sessionName: s.name,
      host: s.host,
      source: 'transfer',
      command,
      kind: op.op === 'remove' ? 'delete' : op.op,
      decision: error ? 'error' : 'executed',
      reason: error ?? '',
      approver: 'user',
      durationMs: null,
      bytes: null,
      redactions: null
    })
  }

  // ------------------------------------------------------------------ folders

  downloadDir(wc: WebContents): string | null {
    const d = this.dirs.get(wc)
    return d ? basename(d) || d : null
  }

  async chooseDownloadDir(wc: WebContents): Promise<string | null> {
    const d = await this.deps.pickDir(wc)
    if (!d) return null
    const st = await fs.stat(d)
    if (!st.isDirectory()) throw new Error('That is not a folder')
    this.dirs.set(wc, d)
    return basename(d) || d
  }

  // ------------------------------------------------------------------ queueing

  private newItem(tabId: string, s: Session, direction: Direction, remotePath: string, localName: string, size: number): TransferItem {
    const info = this.infos.get(tabId)
    return {
      id: randomUUID(),
      tabId,
      sessionName: s.name,
      direction,
      protocol: info?.mode === 'scp' ? 'scp' : 'sftp',
      remotePath,
      localName,
      size,
      done: 0,
      speed: 0,
      state: 'queued'
    }
  }

  private job(item: TransferItem, wc: WebContents, s: Session, extra: Partial<Job>): Job {
    return { item, wc, sessionId: s.ephemeral ? null : s.id, host: s.host, platform: s.platform, ...extra }
  }

  private async info(tabId: string, sender: WebContents): Promise<FilesInfo> {
    return this.infos.get(tabId) ?? this.open(tabId, sender)
  }

  private stat(tabId: string, path: string): Promise<RemoteEntry | null> {
    return this.deps.host.request<RemoteEntry | null>((id) => ({ t: 'files', id, tabId, op: { op: 'stat', path } }))
  }

  /** Queue uploads of local files (already chosen by the user) to `remoteDir`, or one file to `remotePath`. */
  async upload(tabId: string, sender: WebContents, paths: string[], target: { remoteDir?: string; remotePath?: string }, policy: OverwritePolicy): Promise<QueueResult> {
    const t = this.tab(tabId, sender)
    if (this.deps.readOnly?.()) {
      const reason = 'read-only mode is on (Settings › Assistant › Read-only mode), so nothing is uploaded'
      for (const p of paths)
        this.deps.audit.append({ sessionId: t.session.ephemeral ? null : t.session.id, sessionName: t.session.name, host: t.session.host, source: 'transfer', command: `put ${target.remotePath ?? target.remoteDir ?? '~'} ← ${p.split(/[\\/]/).pop()}`, kind: 'upload', decision: 'refused', reason, approver: null, durationMs: null, bytes: null, redactions: null })
      throw new Error(`Upload refused: ${reason}`)
    }
    const info = await this.info(tabId, sender)
    if (info.mode === 'none') throw new Error(info.reason ?? 'Files are not available')
    const out: QueueResult = { queued: 0, conflicts: [], skipped: [] }
    if (target.remotePath && paths.length !== 1) throw new Error('A remote file path takes exactly one file')
    for (const p of paths) {
      const src = await checkUploadSource(p)
      if (!src.ok) {
        out.skipped.push({ name: src.name, reason: src.reason })
        continue
      }
      const remotePath = target.remotePath ?? remoteJoin(target.remoteDir ?? info.home, src.name)
      const item = this.newItem(tabId, t.session, 'upload', remotePath, src.name, src.size)
      const job = this.job(item, t.wc, t.session, { source: p, exclusive: true })
      if (info.mode === 'scp') {
        const bad = scpPathProblem(t.session.platform, remotePath)
        if (bad) {
          out.skipped.push({ name: src.name, reason: bad })
          continue
        }
        // SCP can't check whether the file exists; the device replaces it if it does.
        if (policy !== 'overwrite') {
          out.conflicts.push(this.conflict(job, { existing: undefined, canResume: false }))
          continue
        }
        job.exclusive = false
        this.enqueue(job)
        out.queued++
        continue
      }
      const existing = await this.stat(tabId, remotePath)
      if (existing) {
        if (existing.type === 'dir') {
          out.skipped.push({ name: src.name, reason: `${remotePath} is a folder on the device` })
          continue
        }
        const decided = await this.applyPolicy(job, policy, existing.size)
        if (decided === 'ask') {
          out.conflicts.push(this.conflict(job, { existing: { size: existing.size, mtime: existing.mtime }, canResume: existing.size > 0 && existing.size < src.size }, existing.size))
          continue
        }
        if (decided === 'skip') {
          out.skipped.push({ name: src.name, reason: 'already on the device' })
          continue
        }
      }
      this.enqueue(job)
      out.queued++
    }
    return out
  }

  /** Queue downloads of remote files into the download folder (asked for when not chosen yet). */
  async download(tabId: string, sender: WebContents, items: { path: string; size?: number }[], policy: OverwritePolicy): Promise<QueueResult | null> {
    const t = this.tab(tabId, sender)
    const info = await this.info(tabId, sender)
    if (info.mode === 'none') throw new Error(info.reason ?? 'Files are not available')
    if (!this.dirs.get(t.wc) && !(await this.chooseDownloadDir(t.wc))) return null
    const dir = this.dirs.get(t.wc)!
    const out: QueueResult = { queued: 0, conflicts: [], skipped: [] }
    const taken = new Set<string>()
    for (const { path, size } of items) {
      const name = safeLocalName(remoteBase(path))
      const bad = info.mode === 'scp' ? scpPathProblem(t.session.platform, path) : null
      if (bad) {
        out.skipped.push({ name, reason: bad })
        continue
      }
      const item = this.newItem(tabId, t.session, 'download', path, name, size ?? 0)
      const job = this.job(item, t.wc, t.session, { dir, name })
      const existing = await lstatMaybe(childPath(dir, name))
      if (existing || taken.has(name)) {
        if (existing?.isDirectory()) {
          out.skipped.push({ name, reason: 'a folder with that name is in the download folder' })
          continue
        }
        const decided = await this.applyPolicy(job, policy, 0, taken)
        if (decided === 'ask') {
          out.conflicts.push(this.conflict(job, { existing: existing ? { size: existing.size, mtime: Math.floor(existing.mtimeMs / 1000) } : undefined, canResume: false }))
          continue
        }
        if (decided === 'skip') {
          out.skipped.push({ name, reason: 'already in the download folder' })
          continue
        }
      }
      taken.add(job.name!)
      this.enqueue(job)
      out.queued++
    }
    return out
  }

  /** Resolve the file channel and destination before starting a bounded capture on a device. */
  async captureDestination(tabId: string, sender: WebContents, path: string): Promise<boolean> {
    const { session } = this.tab(tabId, sender)
    const info = await this.info(tabId, sender)
    if (info.mode === 'none') throw new Error(info.reason ?? 'Files are unavailable on this session.')
    const problem = info.mode === 'scp' && scpPathProblem(session.platform, path)
    if (problem) throw new Error(problem)
    return this.dirs.has(sender) || !!(await this.chooseDownloadDir(sender))
  }

  /** Download one trace through the regular queue, keeping the exact job and its byte limit. */
  async receiveCapture(tabId: string, sender: WebContents, path: string, signal: AbortSignal, stage: (s: string) => void): Promise<CaptureDownload | null> {
    if (!(await this.captureDestination(tabId, sender, path))) return null
    signal.throwIfAborted()
    const { session } = this.tab(tabId, sender)
    const dir = this.dirs.get(sender)!
    // A unique name also isolates simultaneous downloads of the same remote capture.
    const name = safeLocalName(randomUUID() + '-' + safeLocalName(remoteBase(path)))
    const item = this.newItem(tabId, session, 'download', path, name, 0)
    const job = this.job(item, sender, session, { dir, name, capture: true })
    this.enqueue(job)
    const cancel = () => this.cancel(sender, item.id)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (item.state === 'queued' || item.state === 'running') {
        stage(`Transferring over ${item.protocol.toUpperCase()} · ${Math.round(item.done / 1024)} KiB received`)
        await delay(200, undefined, { signal })
      }
      if (!job.finalPath || !item.sha256) throw new Error(item.error ?? 'The transfer was cancelled.')
      return { path: job.finalPath, sha256: item.sha256, name: safeLocalName(remoteBase(path)) }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  /** Apply a non-ask policy to a conflicting job; 'ask' and 'skip' are returned for the caller. */
  private async applyPolicy(job: Job, policy: OverwritePolicy, remoteSize: number, taken = new Set<string>()): Promise<'ask' | 'skip' | 'go'> {
    if (policy === 'ask') return 'ask'
    if (policy === 'skip') return 'skip'
    if (policy === 'overwrite') {
      if (job.item.direction === 'download') job.replace = true
      else job.exclusive = false
      void remoteSize
      return 'go'
    }
    // rename
    if (job.item.direction === 'download') {
      job.name = await freeName(job.dir!, job.name!, taken)
      job.item.localName = job.name
    } else {
      job.item.remotePath = await this.freeRemote(job.item.tabId, job.item.remotePath)
    }
    return 'go'
  }

  private async freeRemote(tabId: string, path: string): Promise<string> {
    const dir = remoteParent(path)
    const base = remoteBase(path)
    for (let i = 2; i < 1000; i++) {
      const p = remoteJoin(dir, numbered(base, i))
      if (!(await this.stat(tabId, p))) return p
    }
    throw new Error('No free name on the device')
  }

  private conflict(job: Job, c: { existing?: { size: number; mtime: number }; canResume: boolean }, remoteSize?: number): TransferConflict {
    const token = randomUUID()
    const info: TransferConflict = {
      token,
      direction: job.item.direction,
      name: job.item.direction === 'download' ? job.name! : job.item.remotePath,
      ...(c.existing ? { existing: c.existing } : {}),
      incoming: { size: job.item.size },
      canResume: c.canResume
    }
    this.conflicts.set(token, { job, info, remoteSize })
    // Unanswered questions don't pile up forever.
    setTimeout(() => this.conflicts.delete(token), 30 * 60_000).unref?.()
    return info
  }

  async resolve(sender: WebContents, token: string, choice: ConflictChoice): Promise<QueueResult> {
    const c = this.conflicts.get(token)
    if (!c || c.job.wc !== sender) throw new Error('That question expired. Start the transfer again.')
    this.conflicts.delete(token)
    const out: QueueResult = { queued: 0, conflicts: [], skipped: [] }
    const job = c.job
    if (choice === 'skip') {
      out.skipped.push({ name: c.info.name, reason: 'skipped' })
      return out
    }
    if (choice === 'resume') {
      if (!c.info.canResume || job.item.direction !== 'upload') throw new Error('This transfer cannot resume')
      job.offset = c.remoteSize
      job.exclusive = false
    } else if (choice === 'overwrite') {
      if (job.item.direction === 'download') job.replace = true
      else job.exclusive = false
    } else {
      // rename
      if (job.item.direction === 'download') {
        job.name = await freeName(job.dir!, job.name!)
        job.item.localName = job.name
      } else if (job.item.protocol === 'scp') {
        throw new Error('SCP cannot pick a free name on the device: type another remote path')
      } else job.item.remotePath = await this.freeRemote(job.item.tabId, job.item.remotePath)
    }
    this.enqueue(job)
    out.queued++
    return out
  }

  private enqueue(job: Job): void {
    this.jobs.set(job.item.id, job)
    this.order.push(job.item.id)
    this.emit(job, true)
    this.pump()
  }

  list(sender: WebContents): TransferItem[] {
    return this.order.map((id) => this.jobs.get(id)!).filter((j) => j.wc === sender).map((j) => ({ ...j.item }))
  }

  clear(sender: WebContents): void {
    for (const id of [...this.order]) {
      const j = this.jobs.get(id)!
      if (j.wc !== sender || j.item.state === 'queued' || j.item.state === 'running') continue
      this.jobs.delete(id)
      this.order = this.order.filter((x) => x !== id)
      this.send(j.wc, { kind: 'removed', id })
    }
  }

  cancel(sender: WebContents, id: string): void {
    const j = this.jobs.get(id)
    if (!j || j.wc !== sender) return
    if (j.item.state === 'queued') {
      j.item.state = 'cancelled'
      this.emit(j, true)
      return
    }
    if (j.item.state !== 'running' || !j.ctrl) return
    j.ctrl.cancelled = true
    j.ctrl.wake?.()
    this.deps.host.send({ t: 'xfer-cancel', xferId: id })
  }

  async retry(sender: WebContents, id: string): Promise<void> {
    const j = this.jobs.get(id)
    if (!j || j.wc !== sender || (j.item.state !== 'error' && j.item.state !== 'cancelled')) return
    if (!this.deps.host.owned(j.item.tabId, sender)) throw new Error('The tab for this transfer is closed')
    j.offset = undefined
    if (j.item.protocol === 'sftp') {
      if (j.item.direction === 'download') {
        // Continue the part file the failed attempt left behind.
        const part = await lstatMaybe(childPath(j.dir!, j.name! + PART_SUFFIX))
        if (part?.isFile() && part.size > 0) j.offset = part.size
      } else {
        const r = await this.stat(j.item.tabId, j.item.remotePath).catch(() => null)
        if (r && r.type === 'file' && r.size < j.item.size) {
          j.offset = r.size
          j.exclusive = false
        } else if (r) j.exclusive = false
      }
    }
    j.item = { ...j.item, state: 'queued', error: undefined, done: 0, speed: 0, resumedFrom: undefined, md5: undefined, sha256: undefined, verify: undefined, finishedAt: undefined }
    this.emit(j, true)
    this.pump()
  }

  /** A completed download's local path (drag-out, reveal). */
  localPath(sender: WebContents, id: string): string | undefined {
    const j = this.jobs.get(id)
    return j && j.wc === sender && j.item.state === 'done' && j.item.direction === 'download' ? j.finalPath : undefined
  }

  captureDownload(sender: WebContents, id: string): CaptureDownload | undefined {
    const path = this.localPath(sender, id)
    const item = this.jobs.get(id)?.item
    return path && item?.sha256 ? { path, name: item.localName, sha256: item.sha256 } : undefined
  }

  // ------------------------------------------------------------------ running

  private pump(): void {
    for (const id of this.order) {
      const j = this.jobs.get(id)!
      if (j.item.state !== 'queued' || this.busyTabs.has(j.item.tabId)) continue
      if (j.wc.isDestroyed() || !this.deps.host.owned(j.item.tabId)) {
        j.item.state = 'cancelled'
        j.item.error = 'The tab was closed'
        continue
      }
      this.busyTabs.add(j.item.tabId)
      void this.run(j).finally(() => {
        this.busyTabs.delete(j.item.tabId)
        this.pump()
      })
    }
  }

  private send(wc: WebContents, e: TransferEvent): void {
    if (!wc.isDestroyed()) wc.send('transfer:event', e)
  }

  private emit(j: Job, now = false): void {
    const t = Date.now()
    if (!now && j.lastEmit && t - j.lastEmit < EVENT_MS) return
    j.lastEmit = t
    this.send(j.wc, { kind: 'item', item: { ...j.item } })
  }

  private progress(j: Job, done: number): void {
    j.item.done = done
    const t = Date.now()
    const s = j.speedAt
    if (!s) j.speedAt = { t, done }
    else if (t - s.t >= 250) {
      const inst = ((done - s.done) * 1000) / (t - s.t)
      j.item.speed = j.item.speed ? j.item.speed * 0.6 + inst * 0.4 : inst
      j.speedAt = { t, done }
    }
    this.emit(j)
  }

  private async run(j: Job): Promise<void> {
    const it = j.item
    it.state = 'running'
    it.startedAt = Date.now()
    it.resumedFrom = j.offset || undefined
    j.speedAt = undefined
    j.ctrl = { cancelled: false, acked: 0, unacked: 0 }
    this.emit(j, true)
    const md5 = createHash('md5')
    const sha = createHash('sha256')
    try {
      // Checked again when the job starts: a queued, retried, resumed or conflict-resolved upload
      // must not slip past read-only mode turned on after it was queued (review Low 5).
      if (it.direction === 'upload' && this.deps.readOnly?.()) throw new Error(LATE_READ_ONLY)
      if (it.direction === 'upload') await this.runUpload(j, md5, sha)
      else await this.runDownload(j, md5, sha)
      it.state = 'done'
      it.md5 = md5.digest('hex')
      it.sha256 = sha.digest('hex')
      if (it.direction === 'upload') it.verify = verifyCommand(j.platform, it.remotePath, it.md5)
      else it.draggable = true
    } catch (e) {
      it.state = j.ctrl.cancelled ? 'cancelled' : 'error'
      it.error = j.ctrl.cancelled ? undefined : e instanceof Error ? e.message : String(e)
    } finally {
      this.routes.delete(it.id)
      it.finishedAt = Date.now()
      it.speed = 0
      this.audit(j)
      this.emit(j, true)
    }
  }

  private audit(j: Job): void {
    const it = j.item
    const verb = it.direction === 'upload' ? 'put' : 'get'
    const hash = it.sha256 ? `sha256 ${it.sha256} md5 ${it.md5}` : ''
    const local = `local ${it.localName}`
    const reason = it.state === 'done' ? `${hash}; ${local}${it.resumedFrom ? `; resumed at ${it.resumedFrom}` : ''}` : it.state === 'cancelled' ? `cancelled by the user; ${local}` : `${it.error ?? 'failed'}; ${local}`
    this.deps.audit.append({
      sessionId: j.sessionId,
      sessionName: it.sessionName,
      host: j.host,
      source: 'transfer',
      command: `${it.protocol} ${verb} ${it.remotePath}`,
      kind: it.direction,
      decision: it.state === 'done' ? 'executed' : it.state === 'cancelled' ? 'cancelled' : it.error === LATE_READ_ONLY ? 'refused' : 'error',
      reason,
      approver: 'user',
      durationMs: it.startedAt ? Date.now() - it.startedAt : null,
      bytes: it.done,
      redactions: null
    })
  }

  /** Hash the first `n` bytes of a local file (a resumed transfer's hash covers the whole file). */
  private async hashPrefix(fh: fs.FileHandle, n: number, md5: Hash, sha: Hash): Promise<void> {
    const buf = Buffer.allocUnsafe(CHUNK)
    let pos = 0
    while (pos < n) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, n - pos), pos)
      if (!bytesRead) throw new Error('The local file is shorter than the part already transferred')
      md5.update(buf.subarray(0, bytesRead))
      sha.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
  }

  private async runUpload(j: Job, md5: Hash, sha: Hash): Promise<void> {
    const it = j.item
    const ctrl = j.ctrl!
    const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
    const fh = await fs.open(j.source!, constants.O_RDONLY | NOFOLLOW)
    try {
      const st = await fh.stat()
      if (!st.isFile()) throw new Error('Not a regular file')
      it.size = st.size
      const offset = j.offset ?? 0
      if (offset) await this.hashPrefix(fh, offset, md5, sha)
      this.routes.set(it.id, (m) => {
        if (m.t !== 'xfer-ack') return
        ctrl.unacked -= m.n
        ctrl.acked += m.n
        this.progress(j, offset + ctrl.acked)
        ctrl.wake?.()
      })
      const done = this.deps.host.request<{ protocol: 'sftp' | 'scp' }>((id) => ({
        t: 'xfer',
        id,
        tabId: it.tabId,
        spec: { xferId: it.id, direction: 'upload', remotePath: it.remotePath, size: st.size, ...(offset ? { offset } : {}), ...(j.exclusive ? { exclusive: true } : {}) }
      }))
      // A failure (or cancel) on the host side ends the pump below.
      let failed: unknown = null
      done.catch((e: unknown) => {
        failed = e
        ctrl.wake?.()
      })
      let pos = offset
      while (pos < st.size) {
        if (ctrl.cancelled || failed) break
        const len = Math.min(CHUNK, st.size - pos)
        const buf = Buffer.allocUnsafe(len)
        const { bytesRead } = await fh.read(buf, 0, len, pos)
        if (!bytesRead) throw new Error('The local file shrank during the upload')
        const piece = buf.subarray(0, bytesRead)
        md5.update(piece)
        sha.update(piece)
        pos += bytesRead
        ctrl.unacked += bytesRead
        this.deps.host.send({ t: 'xfer-data', xferId: it.id, d: piece })
        while (ctrl.unacked > WINDOW && !ctrl.cancelled && !failed) await new Promise<void>((r) => (ctrl.wake = r))
        ctrl.wake = undefined
      }
      if (!ctrl.cancelled && !failed) this.deps.host.send({ t: 'xfer-end', xferId: it.id })
      if (ctrl.cancelled) this.deps.host.send({ t: 'xfer-cancel', xferId: it.id })
      await done
      if (ctrl.cancelled) throw new Error('cancelled')
      this.progress(j, st.size)
    } finally {
      await fh.close()
    }
  }

  private async runDownload(j: Job, md5: Hash, sha: Hash): Promise<void> {
    const it = j.item
    const ctrl = j.ctrl!
    const dir = j.dir!
    const partName = j.name! + PART_SUFFIX
    const part = childPath(dir, partName)
    const offset = j.offset ?? 0
    if (!offset && !j.capture) {
      // A part file left by an older attempt that we aren't resuming: start over.
      const old = await lstatMaybe(part)
      if (old?.isFile()) await fs.unlink(part)
      else if (old) throw new Error(`${partName} is in the way in the download folder`)
    }
    const fh = await openPart(part, offset > 0, j.capture ? 0o600 : 0o644)
    let ok = false
    try {
      if (offset) {
        const rd = await fs.open(part, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0))
        try {
          await this.hashPrefix(rd, offset, md5, sha)
        } finally {
          await rd.close()
        }
      }
      let written = 0
      let writing: Promise<void> = Promise.resolve()
      let writeErr: unknown = null
      this.routes.set(it.id, (m) => {
        if (m.t === 'xfer-meta') {
          it.size = m.size
          if (j.capture && m.size > CAPTURE_BYTES) {
            writeErr = new Error('Capture exceeds the 64 MiB limit.')
            this.deps.host.send({ t: 'xfer-cancel', xferId: it.id })
          }
          this.emit(j, true)
          return
        }
        if (m.t !== 'xfer-data') return
        const d = Buffer.from(m.d.buffer, m.d.byteOffset, m.d.byteLength)
        md5.update(d)
        sha.update(d)
        writing = writing.then(async () => {
          if (writeErr || ctrl.cancelled) return
          try {
            if (j.capture && offset + written + d.length > CAPTURE_BYTES) throw new Error('Capture exceeds the 64 MiB limit.')
            await fh.writeFile(d)
            written += d.length
            this.deps.host.send({ t: 'xfer-ack', xferId: it.id, n: d.length })
            this.progress(j, offset + written)
          } catch (e) {
            writeErr = e
            this.deps.host.send({ t: 'xfer-cancel', xferId: it.id })
          }
        })
      })
      try {
        await this.deps.host.request((id) => ({ t: 'xfer', id, tabId: it.tabId, spec: { xferId: it.id, direction: 'download', remotePath: it.remotePath, ...(offset ? { offset } : {}) } }))
      } finally {
        this.routes.delete(it.id)
        await writing
        if (writeErr) throw writeErr
      }
      if (ctrl.cancelled) throw new Error('cancelled')
      await fh.sync().catch(() => {})
      await fh.close()
      const final = await commitPart(dir, part, j.name!, !!j.replace)
      j.finalPath = childPath(dir, final)
      it.localName = final
      ok = true
      this.progress(j, offset + written)
    } finally {
      if (!ok) {
        await fh.close().catch(() => {})
        // Keep a part file only where a retry can continue it (SFTP, not cancelled).
        if (j.capture || ctrl.cancelled || it.protocol === 'scp') await fs.unlink(part).catch(() => {})
      }
    }
  }
}
