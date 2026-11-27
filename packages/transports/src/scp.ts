/**
 * SCP over an exec channel (`scp -t` to send, `scp -f` to fetch), for network devices without
 * SFTP: IOS/IOS-XE (`ip scp server enable`), NX-OS, EOS, Junos, ASA.
 *
 * One file per call, never recursive: a `D` (directory) record from the device is refused, and the
 * file name in the device's `C` record is reported but never used as a local path.
 */
import type { Duplex } from 'node:stream'

/** An error the device reported (0x01/0x02 status line) or a protocol failure, with a hint. */
export class ScpError extends Error {
  constructor(
    message: string,
    /** What the device said, verbatim (trimmed), when it said anything. */
    readonly device?: string
  ) {
    super(message)
    this.name = 'ScpError'
  }
}

/** Common device messages → what to do about them. Best-effort; the device text is always kept. */
export function explainScpError(text: string): string {
  const t = text.trim()
  if (/privilege|not authori[sz]ed|authorization failed/i.test(t))
    return `${t}. The account needs privilege 15 for SCP (IOS: \`aaa authorization exec default local\` and a privilege-15 user)`
  if (/no space|not enough space|insufficient (space|disk)|disk full|out of space/i.test(t)) return `${t}. Free space on the device (\`dir\`, then \`delete\` an old image) and try again`
  if (/no such file|not found|does not exist|invalid (file|path)|bad file/i.test(t))
    return `${t}. Check the path and filesystem prefix (\`flash:\`, \`bootflash:\`, \`/mnt/flash\`, \`/var/tmp\`)`
  if (/permission denied|read-only|access denied/i.test(t)) return `${t}. The device refused to write there; pick another filesystem or check its permissions`
  if (/is a directory/i.test(t)) return `${t}. Give a file name, not just a directory`
  if (/recursive|not a regular file/i.test(t)) return `${t}. Only single files can be copied`
  return t || 'The device ended the copy without saying why'
}

/** Hint for a device that refused the exec channel or the scp command itself. */
export const SCP_DISABLED_HINT =
  'The device refused SCP. Enable its SCP server: IOS/IOS-XE `ip scp server enable` (needs AAA authorization), NX-OS `feature scp-server`, ASA `ssh scopy enable`; EOS and Junos have it on'

/** Reads bytes, lines and exact-length bodies from a channel, with backpressure. */
class Reader {
  private buf: Buffer = Buffer.alloc(0)
  private it: AsyncIterator<Buffer>
  constructor(stream: Duplex) {
    this.it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  }
  private async fill(): Promise<boolean> {
    const r = await this.it.next()
    if (r.done) return false
    this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value
    return true
  }
  /** Read (and drop) whatever else comes until the channel ends, so it can close. */
  drain(): void {
    void (async () => {
      try {
        while (!(await this.it.next()).done);
      } catch {
        /* closed */
      }
    })()
  }
  async byte(): Promise<number | null> {
    while (!this.buf.length) if (!(await this.fill())) return null
    const b = this.buf[0]!
    this.buf = this.buf.subarray(1)
    return b
  }
  async line(max = 4096): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a)
      if (nl >= 0) {
        const s = this.buf.subarray(0, nl).toString('utf8')
        this.buf = this.buf.subarray(nl + 1)
        return s
      }
      if (this.buf.length > max) throw new ScpError('The device sent an over-long SCP line')
      if (!(await this.fill())) return null
    }
  }
  async *body(n: number): AsyncGenerator<Buffer> {
    let left = n
    while (left > 0) {
      if (!this.buf.length && !(await this.fill())) throw new ScpError(`The device closed the copy early (${n - left} of ${n} bytes)`)
      const take = this.buf.subarray(0, Math.min(left, this.buf.length))
      this.buf = this.buf.subarray(take.length)
      left -= take.length
      yield take
    }
  }
}

/** Wait for the device's status byte: 0 ok, 1 warning/2 fatal followed by a message line. */
async function ack(r: Reader, stage: string): Promise<void> {
  const b = await r.byte()
  if (b === 0) return
  if (b === null) throw new ScpError(`The device closed the connection ${stage}`)
  if (b === 1 || b === 2) {
    const msg = (await r.line().catch(() => '')) ?? ''
    throw new ScpError(explainScpError(msg), msg.trim())
  }
  // Some gear prints an error as plain text instead of the status byte.
  const rest = (await r.line().catch(() => '')) ?? ''
  const text = (String.fromCharCode(b) + rest).trim()
  throw new ScpError(explainScpError(text), text)
}

function write(ch: Duplex, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = ch.write(data, (e) => e && reject(e))
    if (ok) resolve()
    else ch.once('drain', () => resolve())
  })
}

/** Collects stderr and the exit status of an exec channel. */
function watch(ch: Duplex & { stderr?: NodeJS.ReadableStream }) {
  let stderr = ''
  let code: number | null = null
  ch.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2000)))
  ch.on('exit', (c: number | null) => (code = c))
  const closed = new Promise<void>((resolve) => ch.once('close', () => resolve()))
  return { stderr: () => stderr.trim(), code: () => code, closed }
}

const abortError = () => new ScpError('cancelled')

export interface ScpSendOptions {
  /** The name in the `C` record (devices mostly use the path given to `scp -t`). */
  name: string
  size: number
  mode?: number
  signal?: AbortSignal
}

/**
 * Send one file: the channel must be an exec of `scp -t <remote path>` (see `scpCommand`).
 * `source` must yield exactly `size` bytes.
 */
export async function scpSend(ch: Duplex, source: AsyncIterable<Buffer>, o: ScpSendOptions): Promise<void> {
  const w = watch(ch)
  const r = new Reader(ch)
  const onAbort = () => ch.destroy()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await ack(r, 'before the copy started').catch((e) => {
      throw w.stderr() && e instanceof ScpError && !e.device ? new ScpError(explainScpError(w.stderr()), w.stderr()) : e
    })
    const name = o.name.replace(/[\r\n/]/g, '_') || 'file'
    await write(ch, `C${((o.mode ?? 0o644) & 0o777).toString(8).padStart(4, '0')} ${o.size} ${name}\n`)
    await ack(r, 'after the file header')
    let sent = 0
    for await (const chunk of source) {
      if (o.signal?.aborted) throw abortError()
      sent += chunk.length
      if (sent > o.size) throw new ScpError('The local file grew during the copy')
      await write(ch, chunk)
    }
    if (sent !== o.size) throw new ScpError(`The local file changed during the copy (${sent} of ${o.size} bytes)`)
    await write(ch, Buffer.from([0]))
    await ack(r, 'after the data (the device may still be writing)')
    ch.end()
    r.drain()
    await Promise.race([w.closed, new Promise((res) => setTimeout(res, 5000))])
    const code = w.code()
    if (code !== null && code !== 0) throw new ScpError(explainScpError(w.stderr() || `scp exited with status ${code}`), w.stderr() || undefined)
  } catch (e) {
    if (o.signal?.aborted) throw abortError()
    throw e
  } finally {
    o.signal?.removeEventListener('abort', onAbort)
  }
}

export interface ScpIncoming {
  size: number
  mode: number
  /** The name the device announced. Untrusted: shown to the user, never used as a local path. */
  name: string
  /** Exactly `size` bytes. Iterate it to the end, then call `done()`. */
  body: AsyncIterable<Buffer>
  done(): Promise<void>
}

/** Start fetching one file: the channel must be an exec of `scp -f <remote path>`. */
export async function scpReceive(ch: Duplex, signal?: AbortSignal): Promise<ScpIncoming> {
  const w = watch(ch)
  const r = new Reader(ch)
  const onAbort = () => ch.destroy()
  signal?.addEventListener('abort', onAbort, { once: true })
  const cleanup = () => signal?.removeEventListener('abort', onAbort)
  try {
    await write(ch, Buffer.from([0]))
    let line: string | null
    for (;;) {
      const b = await r.byte()
      if (b === null) {
        await w.closed
        const err = w.stderr()
        throw new ScpError(err ? explainScpError(err) : 'The device closed the connection without sending the file', err || undefined)
      }
      if (b === 1 || b === 2) {
        const msg = (await r.line()) ?? ''
        throw new ScpError(explainScpError(msg), msg.trim())
      }
      line = String.fromCharCode(b) + ((await r.line()) ?? '')
      if (line.startsWith('T')) {
        await write(ch, Buffer.from([0]))
        continue
      }
      break
    }
    if (line.startsWith('D')) throw new ScpError('That is a directory on the device. Only single files can be copied')
    const m = /^C([0-7]{4}) (\d{1,15}) (.*)$/.exec(line)
    if (!m) throw new ScpError(explainScpError(line), line.trim())
    const size = Number(m[2])
    const mode = parseInt(m[1]!, 8)
    const name = m[3]!.slice(0, 255)
    await write(ch, Buffer.from([0]))
    const body = (async function* () {
      for await (const chunk of r.body(size)) {
        if (signal?.aborted) throw abortError()
        yield chunk
      }
    })()
    const done = async () => {
      try {
        await ack(r, 'after the data')
        await write(ch, Buffer.from([0]))
        ch.end()
        r.drain()
        await Promise.race([w.closed, new Promise((res) => setTimeout(res, 5000))])
      } finally {
        cleanup()
      }
    }
    return { size, mode, name, body, done }
  } catch (e) {
    cleanup()
    if (signal?.aborted) throw abortError()
    throw e
  }
}

/** Characters a remote path may carry unquoted: nothing a shell or a device CLI reads as syntax. */
const PLAIN_PATH = /^[A-Za-z0-9._/:+@%=,-]+$/

/**
 * The remote command for an SCP transfer. A path of plain characters goes as it is
 * (`flash:ios.bin`); anything else is single-quoted with POSIX escaping (`'` becomes `'\''`), so a
 * server that hands the command to a shell never runs `;`, `$(…)` or `${IFS}` from a file name.
 * A path starting with `-` would be read as an option and is refused.
 */
export function scpCommand(mode: 'send' | 'receive', remotePath: string): string {
  if (/[\r\n\0]/.test(remotePath)) throw new ScpError('The remote path has a line break in it')
  if (!remotePath) throw new ScpError('The remote path is empty')
  if (remotePath.startsWith('-')) throw new ScpError('The remote path starts with "-", which would be read as an option')
  // A leading `~/` stays unquoted so a shell expands it to the home folder (quoted, it is a folder
  // named "~"); the rest is plain or quoted as before (Phase 4 fix-round review S1).
  const home = remotePath === '~' || remotePath.startsWith('~/') ? remotePath.slice(0, remotePath === '~' ? 1 : 2) : ''
  const rest = remotePath.slice(home.length)
  const p = home + (!rest || PLAIN_PATH.test(rest) ? rest : `'${rest.replace(/'/g, `'\\''`)}'`)
  return `scp ${mode === 'send' ? '-t' : '-f'} ${p}`
}

/**
 * Platforms whose SCP server reads the path itself instead of handing the command to a shell:
 * quotes would reach the file system as part of the name, and `~` means nothing there.
 */
const DEVICE_PARSED = new Set(['ios', 'iosxe', 'iosxr', 'nxos', 'asa', 'ftd', 'c9800', 'ciscosb', 'aireos', 'fortios', 'vrp', 'aoscx'])

/**
 * Why `remotePath` cannot go over SCP to a device of `platform`, or null. On a device that parses
 * the path itself, only plain paths work (letters, digits and `. _ / : + @ % = , -`): one that would
 * need quoting is refused with a clear reason instead of creating a file whose name has quotes in it.
 * On shells (Linux, Junos, EOS) and unknown platforms everything is allowed, quoted by `scpCommand`.
 */
export function scpPathProblem(platform: string, remotePath: string): string | null {
  if (!DEVICE_PARSED.has(platform)) return null
  if (PLAIN_PATH.test(remotePath)) return null
  return `"${remotePath}" has characters this device's SCP server cannot take (it reads the path itself, so quotes would become part of the name${remotePath.startsWith('~') ? ', and "~" is not a home folder there' : ''}). Use only letters, digits and . _ / : + @ % = , - (for example flash:${remotePath.replace(/^~\/?/, '').replace(/[^A-Za-z0-9._/:+@%=,-]+/g, '_')})`
}
