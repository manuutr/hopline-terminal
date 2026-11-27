import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants, watch, type FSWatcher } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncStatus } from '@shared/types'
import type { Repo } from '../db/repo'
import { isLocked, type DataKey } from '../vault/datakey'
import { DEFAULT_SCRYPT, type ScryptParams } from '../vault/kdf'
import { MAX_FILE_BYTES, openFile, readHeader, sealFile } from './format'
import { buildPayload, parsePayload, payloadHash, type Payload } from './transfer'

export const SYNC_FILE = 'hopline-sync.hopline'
const CONFIG = 'sync_config'
export const SYNC_PASSPHRASE_SETTING = 'sync_passphrase_dek'
const PASSPHRASE = SYNC_PASSPHRASE_SETTING
const PASS_AAD = 'setting:sync_passphrase'
/** Not on Windows (0 there): symlinks need privileges to create there, and lstat still checks. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * Read the sync file. The folder is shared with other machines and sync tools, so what is there is
 * untrusted: only a regular file (never a symlink, FIFO or device) of at most MAX_FILE_BYTES is
 * read. Null when there is no file. Throws a readable error for anything else.
 */
export async function readSyncFile(f: string): Promise<{ buf: Buffer; mtimeMs: number } | null> {
  const st = await lstat(f).catch((e: unknown) => {
    if (missing(e)) return null
    throw e
  })
  if (!st) return null
  if (!st.isFile()) throw new Error(`${f} is not a regular file: folder sync will not read or replace it`)
  if (st.size > MAX_FILE_BYTES) throw new Error(`${f} is too large to be a Hopline Terminal sync file`)
  const fh = await open(f, constants.O_RDONLY | NOFOLLOW | NONBLOCK).catch((e: unknown) => {
    if (missing(e)) return null
    throw e
  })
  if (!fh) return null
  try {
    const s2 = await fh.stat()
    if (!s2.isFile()) throw new Error(`${f} is not a regular file: folder sync will not read or replace it`)
    // Read at most one byte past the cap: a file growing under us is refused, not read whole.
    const buf = Buffer.alloc(Math.min(s2.size, MAX_FILE_BYTES) + 1)
    let n = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (!bytesRead) break
      n += bytesRead
      if (n === buf.length) break
    }
    if (n > MAX_FILE_BYTES) throw new Error(`${f} is too large to be a Hopline Terminal sync file`)
    return { buf: buf.subarray(0, n), mtimeMs: s2.mtimeMs }
  } finally {
    await fh.close()
  }
}

interface Config {
  dir: string
  includeSecrets: boolean
  /** sha256 of the sync file as last written or imported here. Anything else there is "incoming". */
  knownFileHash: string | null
  /** Content hash of the last payload written (skip writes when nothing changed). */
  lastPayloadHash: string | null
  lastWriteAt: number | null
  lastImportAt: number | null
  /**
   * The newest sync file seen here: the `createdAt` of the last file written, or the newest one
   * imported (its header is the GCM AAD, so it can't be edited without the passphrase). An incoming
   * file older than this is a possible rollback (P8 D-L5). Missing in configs from before 0.8.
   */
  newestFileAt?: number | null
}

/**
 * Folder sync (D3): the encrypted export, written to a folder the user picked (Dropbox, a Git
 * checkout…) whenever something changes, debounced. A file there that this machine didn't write
 * is offered for import; it is never overwritten until it has been imported or the user forces
 * a write. No Hopline cloud: the folder is the transport.
 */
export class FolderSync extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private watcher: FSWatcher | null = null
  private checkTimer: ReturnType<typeof setTimeout> | null = null
  private incoming: { mtime: number; hash: string } | null = null
  private error: string | null = null
  /** The sync file can't be read (not a regular file, too large): shown until it can. */
  private fileError: string | null = null
  private paused = false
  private writing: Promise<void> | null = null

  constructor(
    private readonly repo: Repo,
    private readonly key: DataKey,
    private readonly opts: { debounceMs?: number; kdf?: ScryptParams } = {}
  ) {
    super()
  }

  private config(): Config | null {
    const raw = this.repo.getSetting(CONFIG)
    return raw ? (JSON.parse(raw) as Config) : null
  }
  private save(c: Config | null): void {
    this.repo.setSetting(CONFIG, c ? JSON.stringify(c) : null)
  }
  private file(c: Config): string {
    return join(c.dir, SYNC_FILE)
  }

  status(): SyncStatus {
    const c = this.config()
    return {
      enabled: !!c,
      dir: c?.dir ?? null,
      file: c ? this.file(c) : null,
      includeSecrets: !!c?.includeSecrets,
      lastWriteAt: c?.lastWriteAt ?? null,
      lastImportAt: c?.lastImportAt ?? null,
      incoming: this.incoming ? { mtime: this.incoming.mtime } : null,
      paused: this.paused,
      error: this.error ?? this.fileError
    }
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  /** Start watching (app start, or after enable). Checks once immediately. */
  async start(): Promise<void> {
    const c = this.config()
    if (!c) return
    this.watcher?.close()
    try {
      // Watch the directory: sync tools and our own writes replace the file by rename.
      this.watcher = watch(c.dir, (_e, name) => {
        if (!name || name === SYNC_FILE) this.scheduleCheck()
      })
      this.watcher.on('error', () => this.scheduleCheck())
    } catch (e) {
      this.error = `Cannot watch ${c.dir}: ${(e as Error).message}`
    }
    await this.check()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.timer = this.checkTimer = null
  }

  async enable(dir: string, passphrase: string, includeSecrets: boolean): Promise<SyncStatus> {
    const pass = await this.key.encrypt(Buffer.from(passphrase, 'utf8'), PASS_AAD)
    const existing = (await readSyncFile(join(dir, SYNC_FILE)))?.buf ?? null
    if (existing) {
      // Joining a folder that already has a sync file: the passphrase must open it.
      await openFile(existing, passphrase)
    }
    this.repo.setSetting(PASSPHRASE, pass.toString('base64'))
    this.save({ dir, includeSecrets, knownFileHash: null, lastPayloadHash: null, lastWriteAt: null, lastImportAt: null })
    this.incoming = null
    this.error = null
    await this.start()
    // A fresh folder gets our data right away; an existing file is offered for import first.
    if (!existing) await this.write()
    this.emitStatus()
    return this.status()
  }

  disable(): SyncStatus {
    this.stop()
    this.save(null)
    this.repo.setSetting(PASSPHRASE, null)
    this.incoming = null
    this.error = null
    this.fileError = null
    this.paused = false
    this.emitStatus()
    return this.status()
  }

  /** Something changed locally: write the sync file after a quiet period. */
  markDirty(): void {
    if (!this.config()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write().catch(() => {})
    }, this.opts.debounceMs ?? 2000)
  }

  private async passphrase(): Promise<string> {
    const enc = this.repo.getSetting(PASSPHRASE)
    if (!enc) throw new Error('Folder sync has no passphrase; set it up again')
    return (await this.key.decrypt(Buffer.from(enc, 'base64'), PASS_AAD)).toString('utf8')
  }

  /** Write now (skipped when the content is unchanged, or when someone else's file is waiting). */
  async write(force = false): Promise<void> {
    while (this.writing) await this.writing
    this.writing = this.doWrite(force).finally(() => (this.writing = null))
    return this.writing
  }

  private async doWrite(force: boolean): Promise<void> {
    const c = this.config()
    if (!c) return
    try {
      const pass = await this.passphrase()
      const payload = await buildPayload(this.repo, c.includeSecrets)
      this.paused = false
      const hash = payloadHash(payload)
      const f = this.file(c)
      const onDisk = await readSyncFile(f)
      const diskHash = onDisk ? sha(onDisk.buf) : null
      if (diskHash && diskHash !== c.knownFileHash && !force) {
        // Another machine wrote a newer file: offer it, never clobber it.
        await this.check()
        return
      }
      if (!force && hash === c.lastPayloadHash && diskHash && diskHash === c.knownFileHash) return
      const blob = await sealFile(payload, pass, this.opts.kdf ?? DEFAULT_SCRYPT)
      if (!(await this.replace(f, c.dir, blob, diskHash))) return void (await this.check())
      const at = readHeader(blob).header.createdAt
      this.save({ ...c, knownFileHash: sha(blob), lastPayloadHash: hash, lastWriteAt: Date.now(), newestFileAt: Math.max(c.newestFileAt ?? 0, at) })
      this.incoming = null
      this.error = null
    } catch (e) {
      if (isLocked(e)) this.paused = true
      else this.error = (e as Error).message
    }
    this.emitStatus()
  }

  /**
   * Write `blob` to `f` atomically, without following anything planted in the shared folder: a fresh
   * random tmp name created exclusively (O_EXCL, O_NOFOLLOW), then a rename over a destination that
   * must be a regular file or absent. False when the file changed since `expectHash` was read
   * (another machine wrote meanwhile): nothing is replaced.
   */
  private async replace(f: string, dir: string, blob: Buffer, expectHash: string | null): Promise<boolean> {
    const dst = await lstat(f).catch((e: unknown) => {
      if (missing(e)) return null
      throw e
    })
    if (dst && !dst.isFile()) throw new Error(`${f} is not a regular file: folder sync will not read or replace it`)
    const tmp = join(dir, `.${SYNC_FILE}.${randomBytes(8).toString('hex')}.tmp`)
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      try {
        await fh.writeFile(blob)
        await fh.sync()
      } finally {
        await fh.close()
      }
      // Sealing takes a while: re-check right before the rename that nobody wrote in between.
      const now = await readSyncFile(f)
      if ((now ? sha(now.buf) : null) !== expectHash) {
        await unlink(tmp)
        return false
      }
      await rename(tmp, f)
      return true
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
  }

  private scheduleCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null
      void this.check()
    }, 300)
  }

  /** Look at the sync file: if it isn't the one we wrote or imported, it is incoming. */
  async check(): Promise<void> {
    const c = this.config()
    if (!c) return
    const f = this.file(c)
    let file: Awaited<ReturnType<typeof readSyncFile>> = null
    const fileErrorBefore = this.fileError
    try {
      file = await readSyncFile(f)
      this.fileError = null
    } catch (e) {
      this.fileError = (e as Error).message
    }
    const before = this.incoming?.hash
    if (file) {
      const h = sha(file.buf)
      this.incoming = h !== c.knownFileHash ? { mtime: file.mtimeMs, hash: h } : null
    } else this.incoming = null
    if (this.incoming?.hash !== before || this.fileError !== fileErrorBefore) {
      this.emitStatus()
      if (this.incoming) this.emit('incoming', this.status())
    }
  }

  /** Decrypt the incoming file with the stored passphrase. */
  async readIncoming(): Promise<{ payload: Payload; hash: string; createdAt: number; file: string }> {
    const c = this.config()
    if (!c) throw new Error('Folder sync is off')
    const f = this.file(c)
    const file = await readSyncFile(f)
    if (!file) throw new Error('There is no sync file to import')
    const buf = file.buf
    const { header, payload } = await openFile(buf, await this.passphrase())
    return { payload: parsePayload(payload), hash: sha(buf), createdAt: header.createdAt, file: f }
  }

  /**
   * An incoming file sealed before the newest one written or imported here: someone may have copied
   * an old file back into the shared folder (P8 D-L5). Clocks differ between machines, so this is a
   * warning the user answers, not a refusal.
   */
  olderThanNewest(createdAt: number): number | null {
    const newest = this.config()?.newestFileAt
    return newest && createdAt < newest ? newest : null
  }

  /** The incoming file (by hash) was imported: it is now "ours", and our merged state is written back. */
  imported(hash: string, payload: Payload, createdAt?: number): void {
    const c = this.config()
    if (!c) return
    // If the merged state equals the file, the write-back is skipped (no ping-pong between machines).
    this.save({ ...c, knownFileHash: hash, lastPayloadHash: payloadHash(payload), lastImportAt: Date.now(), newestFileAt: Math.max(c.newestFileAt ?? 0, createdAt ?? 0) || null })
    if (this.incoming?.hash === hash) this.incoming = null
    this.emitStatus()
    this.markDirty()
  }

  /** The vault unlocked: retry a write that waited. */
  resume(): void {
    if (this.paused) this.markDirty()
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
