import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import ssh2 from 'ssh2'
import type { ExtraCommand } from './core/terminal.ts'
import { Shell } from './shell.ts'
import { tickBgp, type Device, type SimPlatform } from './state.ts'
import { makeDevice } from './devices/index.ts'
import { applyScenario, type ScenarioOptions } from './scenarios/index.ts'
import { runtime } from './core/runtime.ts'
import { benchCommand } from './bench.ts'
import { deviceFs, simDirectory, parseScpCommand, serveRemoteForwards, serveScp, serveSftp, type SimFilesOptions } from './files.ts'

const { Server, utils } = ssh2

export type SimAuthMethod = 'password' | 'keyboard-interactive' | 'publickey'

/** One keyboard-interactive round: the prompts the server sends and the answers it expects. */
export interface SimKbdRound {
  name?: string
  instructions?: string
  prompts: { prompt: string; echo?: boolean; answer: string }[]
}

export interface SimOptions {
  /** A device, or a platform id to build the lab device for it. */
  device: Device | SimPlatform
  /** Fault/hostile scenario id(s) applied before the first login (comma-separated or a list). */
  scenario?: string | string[]
  scenarioOptions?: ScenarioOptions
  port: number
  host?: string
  username?: string
  password?: string
  /** PEM host key. If omitted, one is generated (and cached at hostKeyPath when given). */
  hostKey?: string
  hostKeyPath?: string
  log?: (msg: string) => void
  /**
   * Auth methods the server accepts. Default: password and keyboard-interactive, plus publickey
   * when `authorizedKeys` is set.
   */
  methods?: SimAuthMethod[]
  /** OpenSSH public key lines ("ssh-ed25519 AAAA... comment") accepted for publickey auth. */
  authorizedKeys?: string[]
  /**
   * Keyboard-interactive rounds (MFA style). Default: one round with a single "Password: " prompt
   * checked against `password`.
   */
  keyboardInteractive?: SimKbdRound[]
  /** Exact algorithm lists the server offers (e.g. only legacy kex / host key types). */
  algorithms?: ssh2.Algorithms
  /** Allow direct-tcpip channels (client `forwardOut`) so the sim can act as a jump host. */
  forwarding?: boolean
  /**
   * Drop the connection after this many failed auth attempts instead of rejecting politely, like
   * gear with a low MaxAuthTries. `authDrop` picks how: an SSH DISCONNECT (default) or a bare TCP close.
   */
  maxAuthTries?: number
  authDrop?: 'disconnect' | 'close'
  /**
   * Drop a connection that hasn't authenticated after this long, like OpenSSH's LoginGraceTime
   * (dropped the `authDrop` way).
   */
  loginGraceMs?: number
  /** Send exit-status when the shell ends (default true). false: just close the channel, like some gear. */
  exitStatus?: boolean
  /** Pre-auth login banner (SSH_MSG_USERAUTH_BANNER), like OpenSSH's `Banner`. */
  banner?: string
  /** SSH software version after `SSH-2.0-` (default: the device's `sshIdent`, else ssh2's). */
  ident?: string
  /** File transfer: an in-memory filesystem with SCP (exec `scp -t/-f`) and optionally SFTP. Off by default. */
  files?: SimFilesOptions
  /** Accept `tcpip-forward` (client remote forwards, `ssh -R`). Off by default: refused like `AllowTcpForwarding local`. */
  remoteForwarding?: boolean
  /** Session channels allowed per connection (some IOS versions take one). Default unlimited. */
  sessionsPerConnection?: number
  /** Enable the `bench flood|lines` streaming commands (benchmarks and soak tests only; see bench.ts). */
  bench?: boolean
  /** Test scenarios can extend the interactive shell on this server only. */
  extra?: readonly ExtraCommand[]
}

/** Connection-level faults for soak tests: the device model is untouched, only the link misbehaves. */
export interface SimFaults {
  /** Drop every live connection now, listener kept up (a link flap). `close`: bare TCP close; `disconnect`: SSH DISCONNECT. */
  drop(how?: 'close' | 'disconnect'): number
  /** Stop reading from every live connection for `ms` (keep-alives go unanswered), then resume. */
  stall(ms: number): number
  /** Refuse new connections for `ms` (accepted and closed at once), like a device rebooting. */
  refuse(ms: number): void
  /** Live connections right now. */
  readonly connections: number
}

/**
 * Events on `RunningSim.events`, for tests:
 * - `auth` { method, username, ok }
 * - `pty` { term, cols, rows }
 * - `window-change` { cols, rows }
 * - `break` { length } (RFC 4335 break request)
 * - `auth-agent` () (agent forwarding requested)
 * - `tcpip` { destIP, destPort } (jump-host forwarding)
 * - `tcpip-forward` { bindAddr, bindPort } (remote forward listening)
 * - `exec` { command } / `sftp` () (file transfer channels)
 */
export interface RunningSim {
  port: number
  device: Device
  events: EventEmitter
  faults: SimFaults
  close: () => Promise<void>
}

/**
 * ssh2@1.17.0's ed25519 keygen strips a leading 0x00 from the public key (~1 key in 256), and its
 * own parser then rejects the result as "Malformed OpenSSH private key". Regenerate until it parses.
 * With `passphrase`, the key is encrypted (aes256-ctr, bcrypt `rounds`) and must open with it.
 */
export function generateEd25519(o: { passphrase?: string; rounds?: number; comment?: string } = {}): { private: string; public: string } {
  const enc = o.passphrase ? { passphrase: o.passphrase, cipher: 'aes256-ctr', rounds: o.rounds ?? 4 } : {}
  for (;;) {
    const kp = utils.generateKeyPairSync('ed25519', { ...enc, comment: o.comment })
    if (!(utils.parseKey(kp.private, o.passphrase) instanceof Error)) return kp
  }
}

function loadHostKey(path?: string): string {
  if (path && existsSync(path)) return readFileSync(path, 'utf8')
  const { private: key } = generateEd25519()
  if (path) writeFileSync(path, key, { mode: 0o600 })
  return key
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

type CR = (p: unknown, recipient: number, type: string, wantReply: boolean, data: unknown) => void
interface ProtoInternals {
  _handlers?: { CHANNEL_REQUEST?: CR }
  channelSuccess?: (id: number) => void
}
interface ChanMgrInternals {
  get(id: number): { _chanInfo?: { outgoing?: { id: number } } } | undefined
}

/**
 * ssh2's server auto-rejects channel requests it doesn't know, including "break", without emitting
 * anything. We wrap this connection's CHANNEL_REQUEST handler so the sim can observe breaks.
 */
function observeBreaks(conn: ssh2.Connection, onBreak: (length: number) => void): void {
  const internals = conn as unknown as { _protocol?: ProtoInternals; _chanMgr?: ChanMgrInternals }
  const proto = internals._protocol
  const handlers = proto?._handlers
  const original = handlers?.CHANNEL_REQUEST
  if (!proto || !handlers || !original) return
  handlers.CHANNEL_REQUEST = (p, recipient, type, wantReply, data) => {
    if (type !== 'break') return original(p, recipient, type, wantReply, data)
    const length = Buffer.isBuffer(data) && data.length >= 4 ? data.readUInt32BE(0) : 0
    onBreak(length)
    const out = internals._chanMgr?.get(recipient)?._chanInfo?.outgoing?.id
    if (wantReply && out !== undefined) proto.channelSuccess?.(out)
  }
}

/** Start one simulated device as an SSH server. */
export function startSim(opts: SimOptions): Promise<RunningSim> {
  const { username = 'admin', password = 'admin', log = () => {} } = opts
  const device = resolveDevice(opts.device, opts.scenario, opts.scenarioOptions)
  const hostKey = opts.hostKey ?? loadHostKey(opts.hostKeyPath)
  const timer = setInterval(() => tickBgp(device), 1000)
  tickBgp(device)
  const events = new EventEmitter()

  const authorized: ssh2.ParsedKey[] = []
  for (const line of opts.authorizedKeys ?? []) {
    const k = utils.parseKey(line)
    if (k instanceof Error) throw new Error(`authorizedKeys: ${k.message}`)
    authorized.push(Array.isArray(k) ? k[0]! : k)
  }
  const methods: SimAuthMethod[] =
    opts.methods ?? (authorized.length ? ['publickey', 'password', 'keyboard-interactive'] : ['password', 'keyboard-interactive'])
  const rounds: SimKbdRound[] = opts.keyboardInteractive ?? [{ prompts: [{ prompt: 'Password: ', echo: false, answer: password }] }]

  const clients = new Set<ssh2.Connection>()
  const serverConfig: ssh2.ServerConfig = { hostKeys: [hostKey] }
  if (opts.algorithms) serverConfig.algorithms = opts.algorithms
  if (opts.banner !== undefined) serverConfig.banner = opts.banner
  const ident = opts.ident ?? device.sshIdent
  if (ident) serverConfig.ident = ident
  let refuseUntil = 0
  type Internals = { _protocol?: { disconnect(reason: number): void }; _sock?: { destroy(): void; pause(): void; resume(): void } }
  const sock = (c: ssh2.Connection) => (c as unknown as Internals)._sock
  const faults: SimFaults = {
    drop(how = 'close') {
      const n = clients.size
      for (const c of [...clients]) {
        if (how === 'close') sock(c)?.destroy()
        else {
          ;(c as unknown as Internals)._protocol?.disconnect(11) // BY_APPLICATION
          c.end()
        }
      }
      return n
    },
    stall(ms) {
      const live = [...clients]
      for (const c of live) sock(c)?.pause()
      setTimeout(() => {
        for (const c of live) sock(c)?.resume()
      }, ms).unref()
      return live.length
    },
    refuse(ms) {
      refuseUntil = Date.now() + ms
    },
    get connections() {
      return clients.size
    }
  }
  const server = new Server(serverConfig, (client, info) => {
    if (Date.now() < refuseUntil) {
      sock(client)?.destroy()
      return
    }
    clients.add(client)
    observeBreaks(client, (length) => {
      log(`${device.hostname}: break (${length} ms)`)
      events.emit('break', { length })
    })
    const drop = (): void => {
      const internals = client as unknown as { _protocol?: { disconnect(reason: number): void }; _sock?: { destroy(): void } }
      if (opts.authDrop === 'close') return internals._sock?.destroy()
      internals._protocol?.disconnect(2) // PROTOCOL_ERROR, as OpenSSH sends for "Too many authentication failures"
      client.end()
    }
    const grace = opts.loginGraceMs !== undefined ? setTimeout(drop, opts.loginGraceMs) : undefined
    client.on('close', () => {
      clearTimeout(grace)
      clients.delete(client)
    })
    let failures = 0
    client.on('authentication', (ctx) => {
      const result = (ok: boolean) => {
        events.emit('auth', { method: ctx.method, username: ctx.username, ok })
        if (ok) return ctx.accept()
        if (opts.maxAuthTries !== undefined && ++failures >= opts.maxAuthTries) return drop()
        ctx.reject(methods)
      }
      const userOk = same(ctx.username, username)
      if (ctx.method === 'password' && methods.includes('password')) return result(userOk && same(ctx.password, password))
      if (ctx.method === 'publickey' && methods.includes('publickey')) {
        const key = authorized.find((k) => k.getPublicSSH().equals(ctx.key.data))
        if (!userOk || !key) return result(false)
        // No signature yet: the client is only asking whether this key would be acceptable.
        if (!ctx.signature || !ctx.blob) return ctx.accept()
        return result(key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)
      }
      if (ctx.method === 'keyboard-interactive' && methods.includes('keyboard-interactive')) {
        let ok = userOk
        const ask = (i: number): void => {
          const round = rounds[i]
          if (!round) return result(ok)
          const prompts = round.prompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? false }))
          ctx.prompt(prompts, round.name ?? '', round.instructions ?? '', (answers) => {
            round.prompts.forEach((p, j) => {
              if (!same(answers[j] ?? '', p.answer)) ok = false
            })
            // Like a real MFA server, stop at the first failed round.
            if (!ok) return result(false)
            ask(i + 1)
          })
        }
        return ask(0)
      }
      ctx.reject(methods)
    })
    client.on('ready', () => {
      clearTimeout(grace)
      log(`${device.hostname}: client authenticated`)
      let sessions = 0
      client.on('session', (accept, reject) => {
        if (opts.sessionsPerConnection !== undefined && sessions >= opts.sessionsPerConnection) return reject()
        sessions++
        const session = accept()
        session.on('close', () => sessions--)
        let rows = 24
        session.on('pty', (acceptPty, _reject, info) => {
          rows = info.rows || 24
          events.emit('pty', { term: info.term, cols: info.cols, rows: info.rows })
          acceptPty?.()
        })
        session.on('window-change', (acceptWc, _reject, info) => {
          rows = info.rows || rows
          events.emit('window-change', { cols: info.cols, rows: info.rows })
          shell?.resize(rows)
          acceptWc?.()
        })
        session.on('auth-agent', (acceptAgent) => {
          events.emit('auth-agent')
          acceptAgent?.()
        })
        let shell: Shell | undefined
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          let waiting: Promise<void> | null = null
          const io = {
            write: (s: string) => {
              if (!stream.write(s) && !waiting) waiting = new Promise<void>((r) => stream.once('drain', () => ((waiting = null), r())))
            },
            drain: () => waiting ?? Promise.resolve(),
            close: () => {
              if (opts.exitStatus !== false) stream.exit(0) // like OpenSSH: exit-status before EOF / close
              stream.end()
            }
          }
          shell = new Shell(device, io, rows, { user: username, password, from: info?.ip?.replace(/^::ffff:/, ''), extra: [...(opts.extra ?? []), ...(opts.bench ? [benchCommand] : [])] })
          stream.on('data', (buf: Buffer) => shell!.input(buf.toString('latin1')))
          stream.on('close', () => shell?.detach())
          shell.start()
        })
        session.on('exec', (acceptExec, reject, info) => {
          if (!opts.files || opts.files.scp === false) return reject()
          const dir = /^dir ([a-z0-9-]+:[a-z0-9_./-]*)$/i.exec(info.command)
          if (dir && ['ios', 'iosxe', 'c9800'].includes(device.platform)) {
            events.emit('exec', { command: info.command })
            const ch = acceptExec()
            ch.write(simDirectory(deviceFs(device, opts.files.capacity), dir[1]!))
            ch.exit(0)
            ch.end()
            return
          }
          if (!parseScpCommand(info.command)) return reject()
          events.emit('exec', { command: info.command })
          serveScp(acceptExec(), info.command, deviceFs(device, opts.files.capacity), device.platform)
        })
        session.on('sftp', (acceptSftp, reject) => {
          if (!opts.files?.sftp) return reject()
          events.emit('sftp')
          serveSftp(acceptSftp(), deviceFs(device, opts.files.capacity))
        })
      })
      if (opts.remoteForwarding) {
        const stop = serveRemoteForwards(client, (ev, i) => events.emit(ev, i))
        client.on('close', stop)
      }
      if (opts.forwarding) {
        client.on('tcpip', (acceptTcp, rejectTcp, info) => {
          events.emit('tcpip', { destIP: info.destIP, destPort: info.destPort })
          const sock = netConnect(info.destPort, info.destIP)
          sock.once('error', () => rejectTcp())
          sock.once('connect', () => {
            const channel = acceptTcp()
            channel.on('error', () => sock.destroy())
            sock.on('error', () => channel.destroy())
            channel.pipe(sock).pipe(channel)
          })
        })
      }
    })
    client.on('error', (e) => log(`${device.hostname}: client error ${e.message}`))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : opts.port
      resolve({
        port,
        device,
        events,
        faults,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(timer)
            runtime(device).dispose()
            for (const c of clients) c.end()
            server.close(() => r())
          })
      })
    })
  })
}

/** A platform id becomes its lab device; scenarios are applied (idempotently) before serving. */
export function resolveDevice(d: Device | SimPlatform, scenario?: string | string[], o?: ScenarioOptions): Device {
  const device = typeof d === 'string' ? makeDevice(d) : d
  if (scenario && scenario.length) applyScenario(device, scenario, o)
  return device
}
