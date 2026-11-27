/**
 * Files for one tab, in the session host: the SFTP channel (or SCP over exec when the device has no
 * SFTP) on the tab's own SSH connection, and the byte pump for transfers.
 *
 * The host never touches local files. Upload bytes arrive from main (`xfer-data`), download bytes
 * go to main, both under an ack window so neither side buffers more than WINDOW bytes, however
 * large the file.
 */
import { classify, isPlatform, redact } from '@hopline/guard'
import { directoryCommand, parseScpDirectory, type ScpDirectoryEntry } from '@shared/scp-directory'
import { policyRefusal } from './guard-check'
import { cleanTerminalText } from '@shared/cli'
import type { SFTPWrapper } from 'ssh2'
import {
  ChannelError,
  SCP_DISABLED_HINT,
  ScpError,
  scpCommand,
  scpPathProblem,
  scpReceive,
  scpSend,
  sftpList,
  sftpMkdir,
  sftpOpenWrite,
  sftpReadFile,
  sftpRealpath,
  sftpRename,
  sftpRmdir,
  sftpStat,
  sftpStatMaybe,
  sftpUnlink,
  type SshTransport
} from '@hopline/transports'
import type { FilesInfo, FilesOp, RemoteEntry } from '@shared/files'
import { FILE_PREVIEW_LIMIT, remoteBase, type FilePreview } from '@shared/files'
import type { HostToMain, XferSpec } from '@shared/host-protocol'

/** Unacknowledged bytes allowed in either direction. */
export const WINDOW = 2 * 1024 * 1024
const PIECE = 64 * 1024

export interface FilesLink {
  /** The tab's live SSH connection, or null (not SSH, not connected). */
  ssh(): SshTransport | null
}

/** Byte queue fed by `xfer-data` messages (upload). */
class Inbox {
  private chunks: Buffer[] = []
  private ended = false
  private wake: (() => void) | null = null
  push(d: Uint8Array): void {
    this.chunks.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength))
    this.wake?.()
  }
  end(): void {
    this.ended = true
    this.wake?.()
  }
  /** Wake a waiting drain (it then sees the abort). */
  poke(): void {
    this.wake?.()
  }
  async *drain(signal: AbortSignal): AsyncGenerator<Buffer> {
    for (;;) {
      if (signal.aborted) throw new Error('cancelled')
      const c = this.chunks.shift()
      if (c) {
        yield c
        continue
      }
      if (this.ended) return
      await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}

interface Running {
  ctrl: AbortController
  inbox: Inbox
  unacked: number
  wake: (() => void) | null
}

export class TabFiles {
  private info: Promise<FilesInfo> | null = null
  private sftp: SFTPWrapper | null = null
  private side: SshTransport | null = null
  private linkSeen: SshTransport | null = null
  private previewController: AbortController | null = null
  private running = new Map<string, Running>()

  constructor(
    private readonly link: FilesLink,
    private readonly post: (m: HostToMain) => void
  ) {}

  /** The connection changed (reconnect, close): channels on the old one are gone. */
  reset(): void {
    this.previewController?.abort()
    this.previewController = null
    this.info = null
    this.sftp = null
    this.side?.end()
    this.side = null
    this.linkSeen = null
  }

  dispose(): void {
    for (const r of this.running.values()) r.ctrl.abort()
    this.reset()
  }

  private current(): SshTransport {
    const t = this.link.ssh()
    if (!t) throw new Error('Not connected. Files are available while the SSH session is connected')
    if (t !== this.linkSeen) {
      this.reset()
      this.linkSeen = t
    }
    return t
  }

  /** A second login for devices that refuse another channel on the terminal's connection. */
  private async sideLink(main: SshTransport): Promise<SshTransport> {
    if (this.side) return this.side
    const side = main.sideConnection()
    side.on('close', () => {
      if (this.side === side) {
        this.side = null
        this.sftp = null
        this.info = null
      }
    })
    await side.connect()
    this.side = side
    return side
  }

  open(): Promise<FilesInfo> {
    const t = this.current()
    this.info ??= this.probe(t).catch((e: unknown) => {
      this.info = null
      throw e
    })
    return this.info
  }

  private async probe(t: SshTransport): Promise<FilesInfo> {
    const viaSftp = async (on: SshTransport, side: boolean): Promise<FilesInfo> => {
      const sftp = await on.openSftp()
      sftp.on('close', () => {
        if (this.sftp === sftp) {
          this.sftp = null
          this.info = null
        }
      })
      this.sftp = sftp
      const home = await sftpRealpath(sftp, '.').catch(() => '/')
      return { mode: 'sftp', home, roots: [], ...(side ? { side } : {}) }
    }
    try {
      return await viaSftp(t, false)
    } catch (e) {
      if (!(e instanceof ChannelError)) throw e
      if (e.kind === 'subsystem') return { mode: 'scp', home: '', reason: 'This device has no SFTP server. Copy single files with SCP.', roots: [] }
      // The device refused a second channel (older IOS takes one per connection): log in again.
      const side = await this.sideLink(t)
      try {
        return await viaSftp(side, true)
      } catch (e2) {
        if (e2 instanceof ChannelError && e2.kind === 'subsystem') return { mode: 'scp', home: '', side: true, reason: 'This device has no SFTP server. Copy single files with SCP.', roots: [] }
        throw e2
      }
    }
  }

  private async needSftp(): Promise<SFTPWrapper> {
    const info = await this.open()
    if (info.mode !== 'sftp' || !this.sftp) throw new Error('This device has no SFTP: browsing is not available, copy files with SCP')
    return this.sftp
  }

  async op(op: FilesOp): Promise<RemoteEntry[] | RemoteEntry | null> {
    const s = await this.needSftp()
    switch (op.op) {
      case 'list':
        return sftpList(s, op.path)
      case 'stat':
        return (await sftpStatMaybe(s, op.path)) ?? null
      case 'mkdir':
        await sftpMkdir(s, op.path)
        return null
      case 'rename':
        await sftpRename(s, op.from, op.to)
        return null
      case 'remove':
        await (op.dir ? sftpRmdir(s, op.path) : sftpUnlink(s, op.path))
        return null
    }
  }

  async listDirectory(path: string, platform: string, rules: Record<string, string[]>): Promise<ScpDirectoryEntry[]> {
    const command = directoryCommand(platform, path)
    if (!isPlatform(platform) || classify(command, platform).kind !== 'read') throw new Error('Directory command refused')
    const denied = policyRefusal(rules, platform, command)
    if (denied) throw new Error(denied)
    const signal = AbortSignal.timeout(10_000)
    const stopped = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Device directory listing timed out')), { once: true }))
    const read = async () => {
      if ((await this.open()).mode !== 'scp') throw new Error('Browse this device over SFTP')
      signal.throwIfAborted()
      const channel = await this.exec(command)
      const stop = () => channel.destroy()
      signal.addEventListener('abort', stop, { once: true })
      try {
        signal.throwIfAborted()
        let size = 0
        const chunks: Buffer[] = []
        channel.stderr.resume()
        for await (const value of channel) {
          const chunk = Buffer.from(value)
          size += chunk.length
          if (size > FILE_PREVIEW_LIMIT) throw new Error('Directory listing is too large. Enter a file path instead.')
          chunks.push(chunk)
        }
        return parseScpDirectory(Buffer.concat(chunks).toString('utf8'))
      } finally {
        signal.removeEventListener('abort', stop)
        channel.destroy()
      }
    }
    return Promise.race([read(), stopped])
  }

  /** Read a bounded file into memory on its existing connection. Only decoded, redacted text leaves the host. */
  async preview(path: string, platform: string): Promise<FilePreview> {
    this.current()
    const ctrl = new AbortController()
    this.previewController?.abort()
    this.previewController = ctrl
    const timer = setTimeout(() => ctrl.abort(new Error('File preview timed out')), 15_000)
    const signal = ctrl.signal
    const stopped = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    const read = async (): Promise<FilePreview> => {
      const info = await this.open()
      signal.throwIfAborted()
      if (info.mode === 'sftp') {
        const sftp = await this.needSftp()
        const st = await sftpStat(sftp, path)
        signal.throwIfAborted()
        if (st.type !== 'file') throw new Error('Choose a regular file to preview')
        if (st.size > FILE_PREVIEW_LIMIT) return { kind: 'large', bytes: st.size }
        const stream = sftp.createReadStream(path, { start: 0, end: FILE_PREVIEW_LIMIT })
        const stop = () => stream.destroy()
        signal.addEventListener('abort', stop, { once: true })
        try { return await readPreview(stream, st.size) }
        finally { signal.removeEventListener('abort', stop); stream.destroy() }
      }
      const problem = scpPathProblem(platform, path)
      if (problem) throw new Error(problem)
      const channel = await this.exec(scpCommand('receive', path))
      try {
        signal.throwIfAborted()
        const file = await scpReceive(channel, signal)
        if (file.size > FILE_PREVIEW_LIMIT) return { kind: 'large', bytes: file.size }
        const result = await readPreview(file.body, file.size)
        await file.done()
        return result
      } finally { channel.destroy() }
    }
    try { return await Promise.race([read(), stopped]) }
    finally {
      clearTimeout(timer)
      if (this.previewController === ctrl) this.previewController = null
    }
  }

  /** An exec channel for SCP: on the terminal's connection, else a second login. */
  private async exec(command: string): Promise<import('ssh2').ClientChannel> {
    const t = this.current()
    const on = this.side ?? t
    try {
      return await on.openExec(command)
    } catch (e) {
      if (e instanceof ChannelError && e.kind === 'channel' && on === t) return (await this.sideLink(t)).openExec(command)
      if (e instanceof ChannelError && e.kind === 'subsystem') throw new ScpError(SCP_DISABLED_HINT)
      throw e
    }
  }

  // ------------------------------------------------------------------ transfers

  data(xferId: string, d: Uint8Array): void {
    this.running.get(xferId)?.inbox.push(d)
  }
  end(xferId: string): void {
    this.running.get(xferId)?.inbox.end()
  }
  ack(xferId: string, n: number): void {
    const r = this.running.get(xferId)
    if (!r) return
    r.unacked = Math.max(0, r.unacked - n)
    r.wake?.()
  }
  cancel(xferId: string): void {
    this.running.get(xferId)?.ctrl.abort()
  }

  /** Run one transfer to completion. Resolves with the protocol used and the bytes moved. */
  async xfer(spec: XferSpec): Promise<{ protocol: 'sftp' | 'scp'; bytes: number }> {
    if (this.running.has(spec.xferId)) throw new Error('transfer already running')
    const r: Running = { ctrl: new AbortController(), inbox: new Inbox(), unacked: 0, wake: null }
    this.running.set(spec.xferId, r)
    r.ctrl.signal.addEventListener('abort', () => {
      r.inbox.poke()
      r.wake?.()
    })
    try {
      const info = await this.open()
      if (info.mode === 'none') throw new Error('Files are not available on this session')
      const protocol = info.mode
      if (protocol === 'scp' && spec.offset) throw new Error('SCP cannot resume a transfer')
      const bytes = spec.direction === 'upload' ? await this.upload(spec, r, protocol) : await this.download(spec, r, protocol)
      return { protocol, bytes }
    } catch (e) {
      if (r.ctrl.signal.aborted) throw new Error('cancelled')
      throw e
    } finally {
      this.running.delete(spec.xferId)
    }
  }

  private async upload(spec: XferSpec, r: Running, protocol: 'sftp' | 'scp'): Promise<number> {
    const signal = r.ctrl.signal
    let n = 0
    const ack = (len: number) => {
      n += len
      this.post({ t: 'xfer-ack', xferId: spec.xferId, n: len })
    }
    if (protocol === 'sftp') {
      const w = await sftpOpenWrite(this.sftp!, spec.remotePath, { offset: spec.offset, exclusive: spec.exclusive && !spec.offset })
      try {
        for await (const chunk of r.inbox.drain(signal)) {
          await w.write(chunk)
          ack(chunk.length)
        }
        await w.close()
      } catch (e) {
        await w.abort().catch(() => {})
        throw e
      }
      return n
    }
    const ch = await this.exec(scpCommand('send', spec.remotePath))
    const inbox = r.inbox
    const source = (async function* () {
      for await (const chunk of inbox.drain(signal)) {
        yield chunk
        ack(chunk.length)
      }
    })()
    await scpSend(ch, source, { name: remoteBase(spec.remotePath), size: spec.size ?? 0, signal })
    return n
  }

  private async download(spec: XferSpec, r: Running, protocol: 'sftp' | 'scp'): Promise<number> {
    const signal = r.ctrl.signal
    let n = 0
    const send = async (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += PIECE) {
        const piece = chunk.subarray(i, i + PIECE)
        // A copy: the transfer list owns the bytes, and the source buffer may be reused.
        this.post({ t: 'xfer-data', xferId: spec.xferId, d: new Uint8Array(piece) })
        r.unacked += piece.length
        n += piece.length
        while (r.unacked > WINDOW && !signal.aborted) await new Promise<void>((res) => (r.wake = res))
        r.wake = null
        if (signal.aborted) throw new Error('cancelled')
      }
    }
    if (protocol === 'sftp') {
      const st = await sftpStat(this.sftp!, spec.remotePath)
      if (st.type === 'dir') throw new Error('That is a folder. Only files can be downloaded')
      this.post({ t: 'xfer-meta', xferId: spec.xferId, size: st.size, name: st.name })
      for await (const chunk of sftpReadFile(this.sftp!, spec.remotePath, spec.offset ?? 0, signal)) await send(chunk)
      return n
    }
    const inc = await scpReceive(await this.exec(scpCommand('receive', spec.remotePath)), signal)
    this.post({ t: 'xfer-meta', xferId: spec.xferId, size: inc.size, name: inc.name })
    for await (const chunk of inc.body) await send(chunk)
    await inc.done()
    return n
  }
}

async function readPreview(source: AsyncIterable<Buffer>, expected: number): Promise<FilePreview> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of source) {
    bytes += chunk.length
    if (bytes > FILE_PREVIEW_LIMIT) return { kind: 'large', bytes: Math.max(bytes, expected) }
    chunks.push(chunk)
  }
  const data = Buffer.concat(chunks, bytes)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return { kind: 'binary', bytes } }
  if (/[\x00-\x08\x0e-\x1a]/.test(text)) return { kind: 'binary', bytes }
  const safe = redact(cleanTerminalText(text))
  return { kind: 'text', text: safe.text, bytes, redactions: safe.count }
}
