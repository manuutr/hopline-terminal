/**
 * SFTP helpers over an ssh2 SFTPWrapper: directory listing, metadata and pipelined reads and writes
 * (a few requests in flight, so a high-latency link still moves data, but never more than a small,
 * bounded window: memory stays flat for multi-gigabyte images).
 */
import type { Attributes, SFTPWrapper, Stats } from 'ssh2'

export interface RemoteEntry {
  name: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  /** Seconds since the epoch. */
  mtime: number
  /** Permission bits (`0o755`). */
  mode: number
  /** `-rwxr-xr-x` style string. */
  perms: string
  uid?: number
  gid?: number
}

const CHUNK = 32 * 1024
const IN_FLIGHT = 8

const typeOf = (mode: number): RemoteEntry['type'] => {
  const t = mode & 0o170000
  return t === 0o040000 ? 'dir' : t === 0o100000 ? 'file' : t === 0o120000 ? 'link' : t === 0 ? 'file' : 'other'
}

export function permString(mode: number): string {
  const t = typeOf(mode)
  const c = t === 'dir' ? 'd' : t === 'link' ? 'l' : '-'
  return c + 'rwxrwxrwx'.split('').map((ch, i) => ((mode >> (8 - i)) & 1 ? ch : '-')).join('')
}

function entry(name: string, a: Attributes | Stats): RemoteEntry {
  return {
    name,
    type: typeOf(a.mode ?? 0),
    size: Number(a.size ?? 0),
    mtime: Number(a.mtime ?? 0),
    mode: (a.mode ?? 0) & 0o7777,
    perms: permString(a.mode ?? 0),
    uid: a.uid,
    gid: a.gid
  }
}

const p = <T>(s: SFTPWrapper, fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> =>
  guarded<T>(s, (resolve, reject) => fn((err, v) => (err ? reject(sftpError(err)) : resolve(v))))

/** Make ssh2's status errors readable ("No such file" etc. keep their text; codes get one). */
export function sftpError(e: Error & { code?: number }): Error {
  const by: Record<number, string> = { 2: 'No such file or directory', 3: 'Permission denied', 4: 'The server refused the operation', 8: 'Operation not supported by the server' }
  const msg = e.message && !/^Failure$/i.test(e.message) ? e.message : (by[e.code ?? -1] ?? e.message ?? 'SFTP error')
  const out = new Error(msg) as Error & { code?: number }
  out.code = e.code
  return out
}

export const sftpRealpath = (s: SFTPWrapper, path: string) => p<string>(s, (cb) => s.realpath(path, cb))
export const sftpStat = async (s: SFTPWrapper, path: string): Promise<RemoteEntry> => entry(path.split('/').pop() || path, await p<Stats>(s, (cb) => s.stat(path, cb)))
/** Like stat, but undefined when the path does not exist. */
export async function sftpStatMaybe(s: SFTPWrapper, path: string): Promise<RemoteEntry | undefined> {
  try {
    return await sftpStat(s, path)
  } catch (e) {
    if ((e as { code?: number }).code === 2) return undefined
    throw e
  }
}
export const sftpMkdir = (s: SFTPWrapper, path: string) => p<void>(s, (cb) => s.mkdir(path, (e) => cb(e, undefined)))
export const sftpRename = (s: SFTPWrapper, from: string, to: string) => p<void>(s, (cb) => s.rename(from, to, (e) => cb(e, undefined)))
export const sftpUnlink = (s: SFTPWrapper, path: string) => p<void>(s, (cb) => s.unlink(path, (e) => cb(e, undefined)))
export const sftpRmdir = (s: SFTPWrapper, path: string) => p<void>(s, (cb) => s.rmdir(path, (e) => cb(e, undefined)))

/** List a directory. Symlinks are reported as links (never followed); `.` and `..` are dropped. */
export async function sftpList(s: SFTPWrapper, path: string, max = 10_000): Promise<RemoteEntry[]> {
  const list = await p<{ filename: string; longname: string; attrs: Attributes }[]>(s, (cb) => s.readdir(path, cb))
  return list
    .filter((e) => e.filename !== '.' && e.filename !== '..')
    .slice(0, max)
    .map((e) => entry(e.filename, e.attrs))
}

const closedErr = () => new Error('The SFTP channel closed (connection lost)')
const closedOf = new WeakMap<SFTPWrapper, { closed: boolean; waiters: Set<() => void> }>()
/** Requests on a channel that has closed never get an answer: track it and fail them instead. */
function lifecycle(s: SFTPWrapper) {
  let l = closedOf.get(s)
  if (!l) {
    const st = { closed: false, waiters: new Set<() => void>() }
    const close = () => {
      st.closed = true
      for (const w of st.waiters) w()
      st.waiters.clear()
    }
    s.once('close', close)
    s.once('end', close)
    closedOf.set(s, st)
    l = st
  }
  return l
}
/** `fn`'s promise, or a rejection as soon as the channel closes. */
function guarded<T>(s: SFTPWrapper, fn: (resolve: (v: T) => void, reject: (e: Error) => void) => void): Promise<T> {
  const l = lifecycle(s)
  if (l.closed) return Promise.reject(closedErr())
  return new Promise<T>((resolve, reject) => {
    const onClose = () => reject(closedErr())
    l.waiters.add(onClose)
    fn(
      (v) => {
        l.waiters.delete(onClose)
        resolve(v)
      },
      (e) => {
        l.waiters.delete(onClose)
        reject(e)
      }
    )
  })
}

function openHandle(s: SFTPWrapper, path: string, flags: string): Promise<Buffer> {
  return p<Buffer>(s, (cb) => s.open(path, flags as never, cb))
}
function closeHandle(s: SFTPWrapper, h: Buffer): Promise<void> {
  return guarded<void>(s, (resolve) => s.close(h, () => resolve())).catch(() => {})
}

/**
 * Read a remote file from `offset` as a stream of chunks, with up to IN_FLIGHT reads outstanding.
 * Chunks are yielded in order; the consumer's pace is the backpressure.
 */
export async function* sftpReadFile(s: SFTPWrapper, path: string, offset = 0, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const h = await openHandle(s, path, 'r')
  try {
    let next = offset
    type Req = { pos: number; done: Promise<Buffer> }
    const queue: Req[] = []
    const issue = () => {
      const pos = next
      next += CHUNK
      const done = guarded<Buffer>(s, (resolve, reject) => {
        const buf = Buffer.allocUnsafe(CHUNK)
        s.read(h, buf, 0, CHUNK, pos, (err, n) => {
          // EOF is an error with code 1 (SSH_FX_EOF), or a zero-length read.
          if (err && (err as { code?: number }).code !== 1) return reject(sftpError(err))
          resolve(buf.subarray(0, err ? 0 : n))
        })
      })
      // Never an unhandled rejection for a read we end up discarding.
      done.catch(() => {})
      queue.push({ pos, done })
    }
    for (let i = 0; i < IN_FLIGHT; i++) issue()
    while (queue.length) {
      if (signal?.aborted) throw new Error('cancelled')
      const req = queue.shift()!
      const chunk = await req.done
      if (chunk.length === 0) break
      yield chunk
      if (chunk.length < CHUNK) {
        // A short read (servers may cap the read size): the reads in flight are past a gap.
        // Drop them and carry on from right after this chunk.
        await Promise.allSettled(queue.map((q) => q.done))
        queue.length = 0
        next = req.pos + chunk.length
      }
      while (queue.length < IN_FLIGHT) issue()
    }
    await Promise.allSettled(queue.map((q) => q.done))
  } finally {
    await closeHandle(s, h)
  }
}

/**
 * Write chunks to a remote file. `offset` > 0 resumes (opens without truncating); `exclusive`
 * refuses to replace an existing file. Up to IN_FLIGHT writes are outstanding; `write()` resolves
 * when the window has room, so the producer is paced by the server.
 */
export async function sftpOpenWrite(s: SFTPWrapper, path: string, o: { offset?: number; exclusive?: boolean } = {}) {
  const flags = o.offset ? 'r+' : o.exclusive ? 'wx' : 'w'
  const h = await openHandle(s, path, flags)
  let pos = o.offset ?? 0
  const inflight = new Set<Promise<void>>()
  let failed: Error | null = null
  const one = (buf: Buffer, at: number): Promise<void> =>
    guarded<void>(s, (resolve) => {
      s.write(h, buf, 0, buf.length, at, (err) => {
        if (err) failed ??= sftpError(err)
        resolve()
      })
    }).catch((e: Error) => {
      failed ??= e
    })
  return {
    async write(chunk: Buffer): Promise<void> {
      if (failed) throw failed
      for (let i = 0; i < chunk.length; i += CHUNK) {
        const piece = chunk.subarray(i, i + CHUNK)
        const at = pos
        pos += piece.length
        const pr = one(piece, at).finally(() => inflight.delete(pr))
        inflight.add(pr)
        while (inflight.size >= IN_FLIGHT) await Promise.race(inflight)
        if (failed) throw failed
      }
    },
    async close(): Promise<void> {
      await Promise.all(inflight)
      await closeHandle(s, h)
      if (failed) throw failed
    },
    async abort(): Promise<void> {
      await Promise.allSettled(inflight)
      await closeHandle(s, h)
    }
  }
}
