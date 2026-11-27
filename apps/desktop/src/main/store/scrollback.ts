import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib'
import type { DataKey } from '../vault/datakey'

// Off the main thread (libuv pool): a tab's history is megabytes, and main serves every window's IPC.
const gzip = promisify(gzipCb)
const gunzip = promisify(gunzipCb)

/** Serialized terminal contents larger than this are trimmed from the top before saving. */
export const MAX_SCROLLBACK_CHARS = 8 * 1024 * 1024

export interface SavedScrollback {
  data: string
  savedAt: number
}

/**
 * Per-session terminal history, encrypted at rest. One file per session (the latest tab wins);
 * names are derived from session ids, never from renderer input.
 */
export class ScrollbackStore {
  constructor(
    private readonly dir: string,
    private readonly key: DataKey
  ) {}

  private file(sessionId: string): string {
    if (!/^[\w-]{1,64}$/.test(sessionId)) throw new Error('bad session id')
    return join(this.dir, `${sessionId}.hsb`)
  }

  /** Per session: the last queued write. Saves and clears of one session run one after another. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Bumped by clear(): a save asked for before the clear is dropped, even if it is still compressing. */
  private readonly gens = new Map<string, number>()
  private globalGen = 0
  private seq = 0

  private gen(sessionId: string): number {
    return (this.gens.get(sessionId) ?? 0) + this.globalGen
  }

  private enqueue(sessionId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(job)
    this.chains.set(sessionId, next)
    void next.finally(() => this.chains.get(sessionId) === next && this.chains.delete(sessionId)).catch(() => undefined)
    return next
  }

  /**
   * Save a tab's history (review L11). Writes for one session are serialised, so an older, larger
   * save can no longer finish after a newer one, and two writes never share a temp file (each gets
   * its own name). A save asked for before a clear() of its session is dropped.
   */
  async save(sessionId: string, data: string): Promise<void> {
    const f = this.file(sessionId)
    const gen = this.gen(sessionId)
    const savedAt = Date.now()
    return this.enqueue(sessionId, async () => {
      if (this.gen(sessionId) !== gen) return
      const trimmed = data.length > MAX_SCROLLBACK_CHARS ? data.slice(data.length - MAX_SCROLLBACK_CHARS) : data
      const payload = JSON.stringify({ data: trimmed, savedAt } satisfies SavedScrollback)
      const blob = await this.key.encrypt(await gzip(payload), `scrollback:${sessionId}`)
      if (this.gen(sessionId) !== gen) return
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      // Write then rename so a crash never leaves a half-written file.
      const tmp = `${f}.${process.pid}.${++this.seq}.tmp`
      try {
        await writeFile(tmp, blob, { mode: 0o600 })
        if (this.gen(sessionId) !== gen) return
        await rename(tmp, f)
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined)
      }
    })
  }

  /** Every save asked for so far has finished (quit waits for this: review L8). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()])
  }

  async load(sessionId: string): Promise<SavedScrollback | null> {
    try {
      const blob = await readFile(this.file(sessionId))
      const plain = (await gunzip(await this.key.decrypt(blob, `scrollback:${sessionId}`))).toString('utf8')
      const v = JSON.parse(plain) as SavedScrollback
      return typeof v.data === 'string' ? v : null
    } catch {
      return null
    }
  }

  async clear(sessionId?: string): Promise<void> {
    if (sessionId) {
      const f = this.file(sessionId)
      this.gens.set(sessionId, (this.gens.get(sessionId) ?? 0) + 1)
      // After any write already renaming, so the cleared history cannot come back.
      return this.enqueue(sessionId, () => rm(f, { force: true }))
    }
    this.globalGen++
    await Promise.allSettled([...this.chains.values()])
    await rm(this.dir, { recursive: true, force: true })
  }
}
