/**
 * File transfer support for the simulator: an in-memory filesystem per device, an SFTP subsystem,
 * an SCP endpoint (`scp -t` / `scp -f` over exec) and remote port forwarding (`tcpip-forward`).
 *
 * Everything here is opt-in (`SimOptions.files`, `SimOptions.remoteForwarding`), so existing
 * simulator behaviour is unchanged: without it, exec and the sftp subsystem are refused as before.
 *
 * The filesystem is POSIX-like with device aliases: `flash:x` (IOS) is `/flash/x`, `bootflash:x`
 * (NX-OS) is `/bootflash/x`, and on EOS `flash:` is `/mnt/flash`, as on the real box.
 */
import { createServer, type Server as NetServer } from 'node:net'
import { posix } from 'node:path'
import ssh2 from 'ssh2'
import type { Device, SimPlatform } from './state.ts'

const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp

export interface SimFile {
  data: Buffer
  mode: number
  mtime: number
}

/** One device's filesystem. Directories are paths in `dirs`; files are keyed by absolute path. */
export interface SimFs {
  /** The directory a session starts in (SFTP realpath('.'), relative SCP paths). */
  home: string
  dirs: Set<string>
  files: Map<string, SimFile>
  /** Device alias → directory (`flash:` → `/flash`). */
  aliases: Record<string, string>
  /** Bytes the device can hold in total; writes beyond it fail with "no space". */
  capacity: number
}

export interface SimFilesOptions {
  /** Offer the sftp subsystem (default false: like IOS, which has an SCP server only). */
  sftp?: boolean
  /** Accept `scp -t` / `scp -f` exec requests (default true when `files` is set). */
  scp?: boolean
  /** Total capacity in bytes (default 64 MiB). */
  capacity?: number
}

const FS_ROOT: Partial<Record<SimPlatform, { home: string; aliases: Record<string, string> }>> = {
  ios: { home: '/flash', aliases: { 'flash:': '/flash', 'nvram:': '/nvram' } },
  c9800: { home: '/flash', aliases: { 'flash:': '/flash', 'bootflash:': '/flash' } },
  nxos: { home: '/bootflash', aliases: { 'bootflash:': '/bootflash', 'volatile:': '/volatile' } },
  eos: { home: '/mnt/flash', aliases: { 'flash:': '/mnt/flash' } },
  junos: { home: '/var/tmp', aliases: {} },
  iosxr: { home: '/disk0:', aliases: { 'disk0:': '/disk0:', 'harddisk:': '/harddisk:' } },
  asa: { home: '/disk0', aliases: { 'disk0:': '/disk0', 'flash:': '/disk0' } }
}

const fsByDevice = new WeakMap<Device, SimFs>()

/** The device's filesystem, created (and seeded with a few typical files) on first use. */
export function deviceFs(device: Device, capacity = 64 * 1024 * 1024): SimFs {
  let fs = fsByDevice.get(device)
  if (fs) return fs
  const layout = FS_ROOT[device.platform] ?? { home: '/home/admin', aliases: {} }
  fs = { home: layout.home, dirs: new Set(['/']), files: new Map(), aliases: layout.aliases, capacity }
  mkdirp(fs, layout.home)
  for (const d of Object.values(layout.aliases)) mkdirp(fs, d)
  const now = Math.floor(Date.now() / 1000)
  const put = (p: string, text: string, mode = 0o100644) => {
    mkdirp(fs!, posix.dirname(p))
    fs!.files.set(p, { data: Buffer.from(text), mode, mtime: now })
  }
  const h = layout.home
  put(posix.join(h, 'startup-config'), `hostname ${device.hostname}\n!\nend\n`)
  put(posix.join(h, 'tech-support.txt'), `show tech-support for ${device.hostname}\n${'-'.repeat(60)}\nversion ${device.version}\n`)
  put(posix.join(h, '.persist'), 'hidden\n')
  mkdirp(fs, posix.join(h, 'logs'))
  put(posix.join(h, 'logs', 'messages'), 'boot ok\n')
  fsByDevice.set(device, fs)
  return fs
}

function mkdirp(fs: SimFs, dir: string): void {
  let cur = ''
  for (const part of dir.split('/').filter(Boolean)) {
    cur += '/' + part
    fs.dirs.add(cur)
  }
}

/** Resolve a client path (absolute, relative to home, or `flash:x`) to an absolute path. */
export function resolvePath(fs: SimFs, p: string): string {
  const m = /^([a-z][a-z0-9-]*:)\/?(.*)$/i.exec(p)
  if (m && fs.aliases[m[1]!.toLowerCase()]) return posix.normalize(posix.join(fs.aliases[m[1]!.toLowerCase()]!, m[2]!)).replace(/\/+$/, '') || '/'
  const abs = p.startsWith('/') ? p : posix.join(fs.home, p)
  return posix.normalize(abs).replace(/(.)\/+$/, '$1')
}

const used = (fs: SimFs) => [...fs.files.values()].reduce((n, f) => n + f.data.length, 0)
const parentOk = (fs: SimFs, p: string) => fs.dirs.has(posix.dirname(p))
const childrenOf = (fs: SimFs, dir: string) => {
  const pre = dir === '/' ? '/' : dir + '/'
  const names = new Set<string>()
  for (const p of [...fs.dirs, ...fs.files.keys()]) if (p !== dir && p.startsWith(pre) && !p.slice(pre.length).includes('/')) names.add(p.slice(pre.length))
  return [...names].sort()
}

/** A Cisco exec-channel directory listing of the same tree that SCP serves. */
export function simDirectory(fs: SimFs, path: string): string {
  const dir = resolvePath(fs, path)
  if (!fs.dirs.has(dir)) return '%Error opening directory (No such directory)\r\n'
  const lines = childrenOf(fs, dir).map((name, i) => {
    const file = fs.files.get(posix.join(dir, name))
    return `${100 + i}  ${file ? '-rw-' : 'drwx'}  ${file?.data.length ?? 4096}  Jan 1 2026 00:00:00 +00:00  ${name}`
  })
  return ['Directory of ' + path, '', ...lines, '', fs.capacity + ' bytes total', ''].join('\r\n')
}

function attrsOf(fs: SimFs, p: string): ssh2.Attributes | null {
  const f = fs.files.get(p)
  if (f) return { mode: f.mode, uid: 0, gid: 0, size: f.data.length, atime: f.mtime, mtime: f.mtime }
  if (fs.dirs.has(p)) return { mode: 0o040755, uid: 0, gid: 0, size: 4096, atime: 0, mtime: 0 }
  return null
}

function longname(name: string, a: ssh2.Attributes): string {
  const dir = (a.mode & 0o170000) === 0o040000
  const bits = 'rwxrwxrwx'.split('').map((c, i) => ((a.mode >> (8 - i)) & 1 ? c : '-')).join('')
  return `${dir ? 'd' : '-'}${bits} 1 admin admin ${String(a.size).padStart(10)} Jan  1 00:00 ${name}`
}

/** Serve the sftp subsystem on one accepted channel. */
export function serveSftp(sftp: ssh2.SFTPWrapper, fs: SimFs): void {
  let nextHandle = 1
  const handles = new Map<number, { kind: 'file'; path: string; write: boolean } | { kind: 'dir'; path: string; done: boolean }>()
  const mkHandle = (v: Parameters<typeof handles.set>[1]) => {
    const id = nextHandle++
    handles.set(id, v)
    const b = Buffer.alloc(4)
    b.writeUInt32BE(id)
    return b
  }
  const getHandle = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined)
  const s = sftp as unknown as ssh2.SFTPWrapper & {
    on(ev: string, fn: (...a: never[]) => void): void
    status(id: number, code: number, msg?: string): void
    handle(id: number, h: Buffer): void
    data(id: number, d: Buffer): void
    name(id: number, names: ssh2.FileEntry[]): void
    attrs(id: number, a: ssh2.Attributes): void
  }
  const st = STATUS_CODE

  s.on('REALPATH', (id: number, p: string) => {
    const abs = resolvePath(fs, p === '.' || p === '' ? fs.home : p)
    s.name(id, [{ filename: abs, longname: abs, attrs: {} as ssh2.Attributes }])
  })
  const doStat = (id: number, p: string) => {
    const a = attrsOf(fs, resolvePath(fs, p))
    if (!a) return s.status(id, st.NO_SUCH_FILE, 'No such file')
    s.attrs(id, a)
  }
  s.on('STAT', doStat)
  s.on('LSTAT', doStat)
  s.on('OPENDIR', (id: number, p: string) => {
    const abs = resolvePath(fs, p)
    if (!fs.dirs.has(abs)) return s.status(id, st.NO_SUCH_FILE, 'No such directory')
    s.handle(id, mkHandle({ kind: 'dir', path: abs, done: false }))
  })
  s.on('READDIR', (id: number, h: Buffer) => {
    const hd = getHandle(h)
    if (!hd || hd.kind !== 'dir') return s.status(id, st.FAILURE, 'Bad handle')
    if (hd.done) return s.status(id, st.EOF)
    hd.done = true
    const list = childrenOf(fs, hd.path).map((name) => {
      const attrs = attrsOf(fs, posix.join(hd.path, name))!
      return { filename: name, longname: longname(name, attrs), attrs }
    })
    s.name(id, list)
  })
  s.on('OPEN', (id: number, p: string, flags: number) => {
    const abs = resolvePath(fs, p)
    const write = (flags & OPEN_MODE.WRITE) !== 0
    if (fs.dirs.has(abs)) return s.status(id, st.FAILURE, 'Is a directory')
    const exists = fs.files.has(abs)
    if (!write) {
      if (!exists) return s.status(id, st.NO_SUCH_FILE, 'No such file')
      return s.handle(id, mkHandle({ kind: 'file', path: abs, write: false }))
    }
    if (!parentOk(fs, abs)) return s.status(id, st.NO_SUCH_FILE, 'No such directory')
    if (exists && flags & OPEN_MODE.EXCL) return s.status(id, st.FAILURE, 'File exists')
    if (!exists && !(flags & OPEN_MODE.CREAT)) return s.status(id, st.NO_SUCH_FILE, 'No such file')
    if (!exists || flags & OPEN_MODE.TRUNC) fs.files.set(abs, { data: Buffer.alloc(0), mode: 0o100644, mtime: Math.floor(Date.now() / 1000) })
    s.handle(id, mkHandle({ kind: 'file', path: abs, write: true }))
  })
  s.on('READ', (id: number, h: Buffer, offset: number, len: number) => {
    const hd = getHandle(h)
    if (!hd || hd.kind !== 'file') return s.status(id, st.FAILURE, 'Bad handle')
    const f = fs.files.get(hd.path)
    if (!f) return s.status(id, st.NO_SUCH_FILE)
    if (offset >= f.data.length) return s.status(id, st.EOF)
    s.data(id, f.data.subarray(offset, Math.min(f.data.length, offset + len)))
  })
  s.on('WRITE', (id: number, h: Buffer, offset: number, data: Buffer) => {
    const hd = getHandle(h)
    if (!hd || hd.kind !== 'file' || !hd.write) return s.status(id, st.FAILURE, 'Bad handle')
    const f = fs.files.get(hd.path)
    if (!f) return s.status(id, st.NO_SUCH_FILE)
    const end = offset + data.length
    const grow = Math.max(0, end - f.data.length)
    if (used(fs) + grow > fs.capacity) return s.status(id, st.FAILURE, 'No space left on device')
    if (end > f.data.length) {
      const nb = Buffer.alloc(end)
      f.data.copy(nb)
      f.data = nb
    }
    data.copy(f.data, offset)
    f.mtime = Math.floor(Date.now() / 1000)
    s.status(id, st.OK)
  })
  s.on('FSTAT', (id: number, h: Buffer) => {
    const hd = getHandle(h)
    const a = hd && attrsOf(fs, hd.path)
    if (!a) return s.status(id, st.FAILURE, 'Bad handle')
    s.attrs(id, a)
  })
  s.on('CLOSE', (id: number, h: Buffer) => {
    if (h.length === 4) handles.delete(h.readUInt32BE(0))
    s.status(id, st.OK)
  })
  s.on('SETSTAT', (id: number, p: string, attrs: ssh2.InputAttributes) => {
    const f = fs.files.get(resolvePath(fs, p))
    if (f && typeof attrs.mode === 'number') f.mode = (f.mode & 0o170000) | (attrs.mode & 0o7777)
    s.status(id, f || fs.dirs.has(resolvePath(fs, p)) ? st.OK : st.NO_SUCH_FILE)
  })
  s.on('FSETSTAT', (id: number) => s.status(id, st.OK))
  s.on('MKDIR', (id: number, p: string) => {
    const abs = resolvePath(fs, p)
    if (fs.dirs.has(abs) || fs.files.has(abs)) return s.status(id, st.FAILURE, 'File exists')
    if (!parentOk(fs, abs)) return s.status(id, st.NO_SUCH_FILE, 'No such directory')
    fs.dirs.add(abs)
    s.status(id, st.OK)
  })
  s.on('RMDIR', (id: number, p: string) => {
    const abs = resolvePath(fs, p)
    if (!fs.dirs.has(abs)) return s.status(id, st.NO_SUCH_FILE)
    if (childrenOf(fs, abs).length) return s.status(id, st.FAILURE, 'Directory not empty')
    fs.dirs.delete(abs)
    s.status(id, st.OK)
  })
  s.on('REMOVE', (id: number, p: string) => {
    const abs = resolvePath(fs, p)
    if (!fs.files.delete(abs)) return s.status(id, st.NO_SUCH_FILE, 'No such file')
    s.status(id, st.OK)
  })
  s.on('RENAME', (id: number, from: string, to: string) => {
    const a = resolvePath(fs, from)
    const b = resolvePath(fs, to)
    if (fs.files.has(b) || fs.dirs.has(b)) return s.status(id, st.FAILURE, 'File exists')
    if (!parentOk(fs, b)) return s.status(id, st.NO_SUCH_FILE)
    const f = fs.files.get(a)
    if (f) {
      fs.files.delete(a)
      fs.files.set(b, f)
      return s.status(id, st.OK)
    }
    if (!fs.dirs.has(a)) return s.status(id, st.NO_SUCH_FILE)
    for (const d of [...fs.dirs]) if (d === a || d.startsWith(a + '/')) (fs.dirs.delete(d), fs.dirs.add(b + d.slice(a.length)))
    for (const [k, v] of [...fs.files]) if (k.startsWith(a + '/')) (fs.files.delete(k), fs.files.set(b + k.slice(a.length), v))
    s.status(id, st.OK)
  })
}

/** Device-flavoured SCP error text (the line after the 0x01 status byte). */
function scpError(platform: SimPlatform, path: string, why: 'nofile' | 'nospace' | 'nodir' | 'recursive' | 'isdir'): string {
  const ios = platform === 'ios' || platform === 'c9800' || platform === 'asa'
  const text = { nofile: 'No such file or directory', nospace: 'No space left on device', nodir: 'No such file or directory', recursive: 'Recursive copy is not supported', isdir: 'Is a directory' }[why]
  return ios ? `%Error opening ${path} (${text})` : `scp: ${path}: ${text}`
}

/** Parse `scp -t [-p] [-d] [--] path` / `scp -f path`. */
export function parseScpCommand(cmd: string): { mode: 't' | 'f'; path: string; recursive: boolean } | null {
  // POSIX-style words: unquoted runs, '…' (literal) and "…" pieces glued together (`'a'\''b'` is a'b).
  const toks: string[] = []
  const re = /(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])+/g
  for (const m of cmd.trim().matchAll(re))
    toks.push(m[0].replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (_x, a?: string, b?: string, c?: string) => a ?? (b !== undefined ? b.replace(/\\(.)/g, '$1') : (c ?? ''))))
  if (!toks.length || toks[0] !== 'scp') return null
  let mode: 't' | 'f' | null = null
  let recursive = false
  let path: string | null = null
  for (const t of toks.slice(1)) {
    if (path === null && /^-[a-z]+$/i.test(t)) {
      if (t.includes('t')) mode = 't'
      if (t.includes('f')) mode = 'f'
      if (t.includes('r')) recursive = true
      continue
    }
    if (t === '--') continue
    path = t
  }
  return mode && path ? { mode, path, recursive } : null
}

/** Serve one SCP exec (`scp -t` sink or `scp -f` source) on a channel. */
export function serveScp(stream: ssh2.ServerChannel, command: string, fs: SimFs, platform: SimPlatform): void {
  const cmd = parseScpCommand(command)
  const fail = (msg: string) => {
    stream.write(Buffer.concat([Buffer.from([1]), Buffer.from(msg + '\n')]))
    stream.exit(1)
    stream.end()
  }
  if (!cmd) {
    stream.stderr.write('unsupported command\n')
    stream.exit(127)
    stream.end()
    return
  }
  let buf = Buffer.alloc(0)
  const waitFor = (n: number) => buf.length >= n
  if (cmd.mode === 'f') {
    const abs = resolvePath(fs, cmd.path)
    const f = fs.files.get(abs)
    let stage: 'start' | 'header-ack' | 'data-ack' = 'start'
    stream.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      while (waitFor(1)) {
        const b = buf[0]!
        buf = buf.subarray(1)
        if (b !== 0) return fail(scpError(platform, cmd.path, 'nofile'))
        if (stage === 'start') {
          if (fs.dirs.has(abs)) return fail(scpError(platform, cmd.path, 'isdir'))
          if (!f) return fail(scpError(platform, cmd.path, 'nofile'))
          stage = 'header-ack'
          stream.write(`C${(f.mode & 0o777).toString(8).padStart(4, '0')} ${f.data.length} ${posix.basename(abs)}\n`)
        } else if (stage === 'header-ack') {
          stage = 'data-ack'
          stream.write(Buffer.concat([f!.data, Buffer.from([0])]))
        } else {
          stream.exit(0)
          stream.end()
          return
        }
      }
    })
    return
  }
  // Sink: we receive files.
  const target = resolvePath(fs, cmd.path)
  let pending: { path: string; size: number; got: Buffer[]; n: number } | null = null
  stream.write(Buffer.from([0]))
  stream.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (pending) {
        const need = pending.size - pending.n
        if (need > 0) {
          if (!buf.length) return
          const take = buf.subarray(0, need)
          pending.got.push(take)
          pending.n += take.length
          buf = buf.subarray(take.length)
          continue
        }
        if (!waitFor(1)) return
        buf = buf.subarray(1) // the sender's trailing 0x00
        const data = Buffer.concat(pending.got)
        const old = fs.files.get(pending.path)?.data.length ?? 0
        if (used(fs) - old + data.length > fs.capacity) {
          pending = null
          return fail(scpError(platform, cmd.path, 'nospace'))
        }
        fs.files.set(pending.path, { data, mode: 0o100644, mtime: Math.floor(Date.now() / 1000) })
        pending = null
        stream.write(Buffer.from([0]))
        continue
      }
      const nl = buf.indexOf(0x0a)
      if (nl < 0) return
      const line = buf.subarray(0, nl).toString('utf8')
      buf = buf.subarray(nl + 1)
      if (line.startsWith('T')) {
        stream.write(Buffer.from([0]))
        continue
      }
      if (line.startsWith('D') || line.startsWith('E')) return fail(scpError(platform, cmd.path, 'recursive'))
      const m = /^C([0-7]{4}) (\d+) (.+)$/.exec(line)
      if (!m) return fail('scp: protocol error: bad header')
      const size = Number(m[2])
      const dest = fs.dirs.has(target) ? posix.join(target, posix.basename(m[3]!)) : target
      if (!parentOk(fs, dest)) return fail(scpError(platform, cmd.path, 'nodir'))
      const old = fs.files.get(dest)?.data.length ?? 0
      if (used(fs) - old + size > fs.capacity) return fail(scpError(platform, cmd.path, 'nospace'))
      pending = { path: dest, size, got: [], n: 0 }
      stream.write(Buffer.from([0]))
    }
  })
  stream.on('end', () => {
    stream.exit(0)
    stream.end()
  })
}

/**
 * Remote forwarding (`ssh -R`): on `tcpip-forward`, listen on the requested address and open a
 * `forwarded-tcpip` channel to the client per connection. Returns a cleanup function.
 */
export function serveRemoteForwards(client: ssh2.Connection, emit: (ev: string, info: unknown) => void): () => void {
  const servers = new Map<string, NetServer>()
  client.on('request', (accept, reject, name, info) => {
    const i = info as { bindAddr: string; bindPort: number }
    const key = `${i.bindAddr}:${i.bindPort}`
    if (name === 'cancel-tcpip-forward') {
      const srv = [...servers.entries()].find(([k]) => k === key || k.endsWith(`:${i.bindPort}`))
      if (srv) {
        srv[1].close()
        servers.delete(srv[0])
      }
      return accept?.()
    }
    if (name !== 'tcpip-forward') return reject?.()
    const srv = createServer((sock) => {
      const port = (srv.address() as { port: number }).port
      client.forwardOut(i.bindAddr, port, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, (err, ch) => {
        if (err) return sock.destroy()
        ch.on('error', () => sock.destroy())
        sock.on('error', () => ch.destroy())
        sock.pipe(ch).pipe(sock)
      })
    })
    srv.once('error', () => reject?.())
    // Tests bind loopback only; a wildcard request still listens on 127.0.0.1.
    srv.listen(i.bindPort, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      servers.set(`${i.bindAddr}:${port}`, srv)
      emit('tcpip-forward', { bindAddr: i.bindAddr, bindPort: port })
      accept?.(port)
    })
  })
  return () => {
    for (const s of servers.values()) s.close()
    servers.clear()
  }
}
