/**
 * Port forwarding over an SSH connection: local (-L), remote (-R) and dynamic SOCKS5 (-D).
 *
 * A `Forwards` instance belongs to one terminal tab and outlives its connections: local and
 * dynamic listeners stay bound while the session reconnects (new connections are refused until it
 * is back), and remote forwards are requested again on every new connection (`attach`).
 */
import { EventEmitter } from 'node:events'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { IncomingTcp } from './ssh.ts'
import { isAnyAddressBind, listenHost, remoteBindHost } from './bind.ts'

export type ForwardKind = 'L' | 'R' | 'D'

export interface ForwardSpec {
  id: string
  kind: ForwardKind
  /** L/D: local address to listen on. R: the address the server listens on. Default 127.0.0.1 (L/D) / 127.0.0.1 (R). */
  bindHost: string
  /** 0 picks a free port. */
  bindPort: number
  /** L: where the server connects to. R: where we connect to locally. Unused for D. */
  destHost?: string
  destPort?: number
}

export type ForwardState = 'starting' | 'listening' | 'waiting' | 'error' | 'stopped'

export interface ForwardStatus {
  spec: ForwardSpec
  state: ForwardState
  /** The port actually bound (differs from spec.bindPort when that is 0). */
  boundPort?: number
  active: number
  total: number
  bytesIn: number
  bytesOut: number
  error?: string
}

/** What the forwards need from an SSH connection (SshTransport implements it). */
export interface ForwardLink extends EventEmitter {
  forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number): Promise<ClientChannel>
  forwardIn(bindAddr: string, bindPort: number): Promise<number>
  unforwardIn(bindAddr: string, bindPort: number): Promise<void>
}

/** One-line description, like OpenSSH's flags: `L 127.0.0.1:8080 → 10.0.0.1:80`. */
export function describeForward(s: ForwardSpec, boundPort?: number): string {
  const bind = `${s.bindHost.includes(':') ? `[${s.bindHost}]` : s.bindHost}:${boundPort ?? s.bindPort}`
  if (s.kind === 'D') return `D ${bind} (SOCKS5)`
  const dest = `${s.destHost}:${s.destPort}`
  return s.kind === 'L' ? `L ${bind} → ${dest}` : `R ${bind} (server) → ${dest}`
}

export { isAnyAddressBind, isExposedBind, isLoopbackBind, listenHost } from './bind.ts'

/** Connections one forward carries at once; more are refused (closed) until some end. */
export const MAX_CONNECTIONS_PER_FORWARD = 64
/** A SOCKS client must finish its greeting and CONNECT request within this time. */
export const SOCKS_HANDSHAKE_MS = 10_000

/** A failure opening a direct-tcpip channel, in words (RFC 4254 reason codes). */
export function channelOpenError(e: Error & { reason?: number }): { text: string; socks: number } {
  if (e.reason === 1) return { text: 'the server does not allow port forwarding (administratively prohibited)', socks: 0x02 }
  if (e.reason === 2) return { text: 'the server could not connect to the destination', socks: 0x05 }
  if (e.reason === 3) return { text: 'the server does not support forwarding', socks: 0x01 }
  if (/not connected/i.test(e.message)) return { text: 'the session is not connected', socks: 0x01 }
  return { text: e.message || 'channel open failed', socks: 0x01 }
}

function listenError(e: NodeJS.ErrnoException, host: string, port: number): string {
  if (e.code === 'EADDRINUSE') return `port ${port} is already in use on ${host}`
  if (e.code === 'EACCES') return `not allowed to listen on ${host}:${port}${port < 1024 ? ' (ports below 1024 need admin rights)' : ''}`
  if (e.code === 'EADDRNOTAVAIL') return `${host} is not an address of this machine`
  return e.message
}

interface Entry {
  status: ForwardStatus
  server?: Server
  sockets: Set<Socket>
  /** R: connections accepted from the server whose local side is still connecting. */
  pending: number
  /** For R: the address/port we asked the server for (needed to cancel it). */
  remote?: { addr: string; port: number }
}

/**
 * Events: `change` (ForwardStatus[]) on any state change (throttled for byte counts),
 * `notice` (text) once per state transition, for the terminal.
 */
export class Forwards extends EventEmitter {
  private entries = new Map<string, Entry>()
  private link: ForwardLink | null = null
  private onTcp = (c: IncomingTcp) => this.incoming(c)
  private changeTimer: NodeJS.Timeout | null = null

  constructor(private readonly limits: { maxConnections: number; socksHandshakeMs: number } = { maxConnections: MAX_CONNECTIONS_PER_FORWARD, socksHandshakeMs: SOCKS_HANDSHAKE_MS }) {
    super()
  }

  list(): ForwardStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status, spec: { ...e.status.spec } }))
  }

  private changed(now = false): void {
    if (now) {
      if (this.changeTimer) clearTimeout(this.changeTimer)
      this.changeTimer = null
      this.emit('change', this.list())
      return
    }
    this.changeTimer ??= setTimeout(() => {
      this.changeTimer = null
      this.emit('change', this.list())
    }, 250)
  }

  private set(e: Entry, state: ForwardState, error?: string): void {
    const was = e.status.state
    e.status.state = state
    e.status.error = error
    this.changed(true)
    if (was === state && !error) return
    const what = describeForward(e.status.spec, e.status.boundPort)
    if (state === 'listening') this.emit('notice', `forward ${what}: listening`)
    else if (state === 'error') this.emit('notice', `forward ${what}: ${error}`)
    else if (state === 'stopped') this.emit('notice', `forward ${what}: stopped`)
  }

  /** A new connection is up: (re)request remote forwards and accept local ones again. */
  async attach(link: ForwardLink): Promise<void> {
    this.detach()
    this.link = link
    link.on('tcp-connection', this.onTcp)
    await Promise.all([...this.entries.values()].map((e) => this.bring(e)))
  }

  /** The connection went away: listeners stay bound but refuse; remote forwards are gone with it. */
  detach(): void {
    if (!this.link) return
    this.link.off('tcp-connection', this.onTcp)
    this.link = null
    for (const e of this.entries.values()) {
      for (const s of e.sockets) s.destroy()
      if (e.status.state === 'listening' || e.status.state === 'starting') {
        e.remote = undefined
        e.status.state = 'waiting'
      }
    }
    this.changed(true)
  }

  /** Add and start a forward. Resolves once it is listening (or failed: see its status). */
  async start(spec: ForwardSpec): Promise<ForwardStatus> {
    const old = this.entries.get(spec.id)
    if (old && old.status.state !== 'stopped' && old.status.state !== 'error') return { ...old.status }
    if (old) await this.stop(spec.id, false)
    const e: Entry = { status: { spec: { ...spec }, state: 'starting', active: 0, total: 0, bytesIn: 0, bytesOut: 0 }, sockets: new Set(), pending: 0 }
    this.entries.set(spec.id, e)
    this.changed(true)
    await this.bring(e)
    return { ...e.status }
  }

  private async bring(e: Entry): Promise<void> {
    const s = e.status.spec
    if (s.kind === 'R') {
      if (!this.link) return void (e.status.state = 'waiting')
      try {
        const addr = remoteBindHost(s.bindHost)
        const port = await this.link.forwardIn(addr, s.bindPort)
        e.remote = { addr, port }
        e.status.boundPort = port
        this.set(e, 'listening')
      } catch (err) {
        this.set(e, 'error', `the server refused the remote forward on ${s.bindHost}:${s.bindPort} (${(err as Error).message}). Remote forwarding needs the server's permission (OpenSSH: AllowTcpForwarding yes or remote; GatewayPorts for non-loopback addresses)`)
      }
      return
    }
    if (e.server) {
      if (this.link && e.status.state === 'waiting') this.set(e, 'listening')
      return
    }
    const server = createServer((sock) => this.local(e, sock))
    e.server = server
    await new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        e.server = undefined
        this.set(e, 'error', listenError(err, s.bindHost, s.bindPort))
        resolve()
      })
      server.listen(s.bindPort, listenHost(s.bindHost), () => {
        e.status.boundPort = (server.address() as { port: number }).port
        server.removeAllListeners('error')
        server.on('error', () => {})
        this.set(e, this.link ? 'listening' : 'waiting')
        resolve()
      })
    })
  }

  async stop(id: string, emit = true): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    for (const s of e.sockets) s.destroy()
    e.sockets.clear()
    if (e.server) await new Promise<void>((r) => e.server!.close(() => r()))
    e.server = undefined
    if (e.remote && this.link) await this.link.unforwardIn(e.remote.addr, e.remote.port).catch(() => {})
    e.remote = undefined
    e.status.active = 0
    if (emit) this.set(e, 'stopped')
  }

  /** Stop and forget a forward. */
  async remove(id: string): Promise<void> {
    await this.stop(id, false)
    this.entries.delete(id)
    this.changed(true)
  }

  async dispose(): Promise<void> {
    this.detach()
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id, false)))
    this.entries.clear()
    if (this.changeTimer) clearTimeout(this.changeTimer)
  }

  // ---------------------------------------------------------------------------------------------

  private track(e: Entry, sock: Socket, ch: ClientChannel): void {
    e.status.active++
    e.status.total++
    this.changed()
    sock.on('data', (d: Buffer) => {
      e.status.bytesOut += d.length
      this.changed()
    })
    ch.on('data', (d: Buffer) => {
      e.status.bytesIn += d.length
      this.changed()
    })
    let closed = false
    const done = () => {
      if (closed) return
      closed = true
      e.sockets.delete(sock)
      e.status.active = Math.max(0, e.status.active - 1)
      this.changed()
      sock.destroy()
      ch.destroy()
    }
    sock.on('error', done).on('close', done)
    ch.on('error', done).on('close', done)
    sock.pipe(ch)
    ch.pipe(sock)
  }

  /** The forward already carries its maximum number of connections. */
  private full(e: Entry): boolean {
    if (e.sockets.size + e.pending < this.limits.maxConnections) return false
    e.status.error = `more than ${this.limits.maxConnections} connections at once: new ones are refused until some close`
    this.changed(true)
    return true
  }

  private local(e: Entry, sock: Socket): void {
    sock.on('error', () => {})
    const link = this.link
    // Refused sockets are destroyed at once and never kept in the set.
    if (!link || e.status.state !== 'listening' || this.full(e)) return void sock.destroy()
    e.sockets.add(sock)
    sock.once('close', () => e.sockets.delete(sock))
    const s = e.status.spec
    if (s.kind === 'D') return this.socks(e, sock, link)
    sock.pause()
    link.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, s.destHost!, s.destPort!).then(
      (ch) => {
        sock.resume()
        this.track(e, sock, ch)
      },
      (err: Error & { reason?: number }) => {
        e.sockets.delete(sock)
        sock.destroy()
        e.status.error = `${s.destHost}:${s.destPort}: ${channelOpenError(err).text}`
        this.changed(true)
      }
    )
  }

  private incoming(c: IncomingTcp): void {
    const e = [...this.entries.values()].find(
      (x) => x.status.spec.kind === 'R' && x.remote && x.remote.port === c.info.destPort && (x.remote.addr === c.info.destIP || isAnyAddressBind(x.remote.addr))
    )
    if (!e || e.status.state !== 'listening' || this.full(e)) return c.reject()
    const s = e.status.spec
    const ch = c.accept()
    ch.pause()
    e.pending++
    connectLocal(s.destHost!, s.destPort!).then(
      (local) => {
        e.pending--
        // Stopped or detached while connecting: the local side goes too.
        if (e.status.state !== 'listening') return void (local.destroy(), ch.destroy())
        e.sockets.add(local)
        local.once('close', () => e.sockets.delete(local))
        ch.resume()
        this.track(e, local, ch)
      },
      (err: Error) => {
        e.pending--
        ch.destroy()
        e.status.error = `${s.destHost}:${s.destPort}: ${err.message}`
        this.changed(true)
      }
    )
  }

  /** A minimal SOCKS5 server (RFC 1928): no authentication, CONNECT only. */
  private socks(e: Entry, sock: Socket, link: ForwardLink): void {
    let buf = Buffer.alloc(0)
    let stage: 'hello' | 'request' | 'done' = 'hello'
    const reply = (code: number) => sock.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
    // A client that never finishes the greeting (or lingers after a refusal) is cut off.
    const handshake = setTimeout(() => sock.destroy(), this.limits.socksHandshakeMs)
    handshake.unref?.()
    sock.once('close', () => clearTimeout(handshake))
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (buf.length > 600) return void sock.destroy()
      if (stage === 'hello') {
        if (buf.length < 2) return
        if (buf[0] !== 5) return void sock.destroy() // SOCKS4 and others: not supported
        const n = buf[1]!
        if (buf.length < 2 + n) return
        const methods = buf.subarray(2, 2 + n)
        buf = buf.subarray(2 + n)
        if (!methods.includes(0)) {
          sock.end(Buffer.from([5, 0xff]))
          return
        }
        sock.write(Buffer.from([5, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 5) return
        const [ver, cmd, , atyp] = buf
        let host: string
        let at: number
        if (atyp === 1) {
          if (buf.length < 10) return
          host = [...buf.subarray(4, 8)].join('.')
          at = 8
        } else if (atyp === 3) {
          const len = buf[4]!
          if (buf.length < 5 + len + 2) return
          host = buf.subarray(5, 5 + len).toString('latin1')
          at = 5 + len
        } else if (atyp === 4) {
          if (buf.length < 22) return
          const b = buf.subarray(4, 20)
          host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':')
          at = 20
        } else {
          reply(0x08)
          return void sock.end()
        }
        const port = buf.readUInt16BE(at)
        const rest = buf.subarray(at + 2)
        stage = 'done'
        sock.off('data', onData)
        if (ver !== 5 || cmd !== 1) {
          reply(0x07)
          return void sock.end()
        }
        sock.pause()
        link.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, host, port).then(
          (ch) => {
            clearTimeout(handshake)
            if (sock.destroyed) return void ch.destroy()
            reply(0)
            if (rest.length) ch.write(rest)
            sock.resume()
            this.track(e, sock, ch)
          },
          (err: Error & { reason?: number }) => {
            const { socks } = channelOpenError(err)
            reply(socks)
            sock.end()
          }
        )
      }
    }
    sock.on('data', onData)
  }
}

function connectLocal(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(port, host)
    s.once('connect', () => {
      s.removeAllListeners('error')
      s.on('error', () => {})
      resolve(s)
    })
    s.once('error', (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'ECONNREFUSED' ? 'connection refused' : e.message)))
  })
}
