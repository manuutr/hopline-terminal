/**
 * Simulated device over Telnet: real IAC negotiation (WILL ECHO, WILL SGA, DO NAWS, DO TTYPE),
 * an IOS-style Username:/Password: login, then the same Shell the SSH simulator uses.
 *
 * Deliberately self-contained (no import from @hopline/transports) so it exercises the client
 * against an independent implementation, and so it runs under plain `node` with type stripping.
 */
import { createServer, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { Shell } from './shell.ts'
import { tickBgp, type Device, type SimPlatform } from './state.ts'
import { resolveDevice } from './server.ts'
import type { ScenarioOptions } from './scenarios/index.ts'
import { runtime } from './core/runtime.ts'

export interface TelnetSimOptions {
  device: Device | SimPlatform
  scenario?: string | string[]
  scenarioOptions?: ScenarioOptions
  port: number
  host?: string
  username?: string
  password?: string
  log?: (msg: string) => void
}

export interface RunningTelnetSim {
  port: number
  device: Device
  close: () => Promise<void>
}

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240
const ECHO = 1
const SGA = 3
const TTYPE = 24
const NAWS = 31

/** Options we perform (answering DO) and options we let the client perform (answering WILL). */
const SERVER_DOES = new Set([ECHO, SGA])
const CLIENT_MAY = new Set([SGA, TTYPE, NAWS])

const CRLF = '\r\n'
const MAX_TRIES = 3

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const escapeIac = (buf: Buffer): Buffer => {
  if (!buf.includes(IAC)) return buf
  const out: number[] = []
  for (const b of buf) out.push(...(b === IAC ? [IAC, IAC] : [b]))
  return Buffer.from(out)
}

type OptState = 'no' | 'pending' | 'yes'

/** One Telnet client connection. */
class TelnetSession {
  private readonly sock: Socket
  private readonly opts: { device: Device; username: string; password: string; log: (msg: string) => void }
  // Negotiation: `pending` means we asked and wait for the answer, so the answer is not re-acked.
  private readonly ours = new Map<number, OptState>()
  private readonly theirs = new Map<number, OptState>()
  // IAC parser state, kept across reads.
  private pstate: 'data' | 'iac' | 'neg' | 'sb' | 'sb-iac' = 'data'
  private verb = 0
  private sb: number[] = []
  private afterCR = false
  // Login, then shell.
  private phase: 'user' | 'pass' | 'shell' = 'user'
  private line = ''
  private user = ''
  private tries = 0
  private swallowLF = false
  private rows = 24
  private shell: Shell | undefined

  constructor(sock: Socket, opts: { device: Device; username: string; password: string; log: (msg: string) => void }) {
    this.sock = sock
    this.opts = opts
  }

  start(): void {
    this.ask(WILL, ECHO)
    this.ask(WILL, SGA)
    this.ask(DO, NAWS)
    this.ask(DO, TTYPE)
    this.write(`${CRLF}${CRLF}User Access Verification${CRLF}${CRLF}Username: `)
    this.sock.on('data', (buf: Buffer) => this.input(buf))
  }

  private write(s: string): void {
    if (!this.sock.destroyed) this.sock.write(escapeIac(Buffer.from(s, 'utf8')))
  }

  private raw(bytes: number[]): void {
    if (!this.sock.destroyed) this.sock.write(Buffer.from(bytes))
  }

  private ask(verb: number, opt: number): void {
    ;(verb === WILL ? this.ours : this.theirs).set(opt, 'pending')
    this.raw([IAC, verb, opt])
  }

  private input(buf: Buffer): void {
    let text = ''
    for (const b of buf) {
      switch (this.pstate) {
        case 'data':
          if (b === IAC) this.pstate = 'iac'
          else if (b === 0 && this.afterCR) this.afterCR = false
          else {
            text += String.fromCharCode(b)
            this.afterCR = b === 13
          }
          break
        case 'iac':
          if (b === IAC) {
            text += '\xff'
            this.pstate = 'data'
          } else if (b >= WILL && b <= DONT) {
            this.verb = b
            this.pstate = 'neg'
          } else if (b === SB) {
            this.sb = []
            this.pstate = 'sb'
          } else this.pstate = 'data'
          break
        case 'neg':
          this.negotiate(this.verb, b)
          this.pstate = 'data'
          break
        case 'sb':
          if (b === IAC) this.pstate = 'sb-iac'
          else this.sb.push(b)
          break
        case 'sb-iac':
          if (b === SE) {
            this.subneg(this.sb)
            this.pstate = 'data'
          } else {
            this.sb.push(b)
            this.pstate = 'sb'
          }
          break
      }
    }
    if (text) this.text(text)
  }

  private negotiate(verb: number, opt: number): void {
    const local = verb === DO || verb === DONT
    const map = local ? this.ours : this.theirs
    const allowed = (local ? SERVER_DOES : CLIENT_MAY).has(opt)
    const state = map.get(opt) ?? 'no'
    const [yes, no] = local ? [WILL, WONT] : [DO, DONT]
    if (verb === DO || verb === WILL) {
      if (state === 'yes') return
      if (!allowed) {
        if (state === 'no') this.raw([IAC, no, opt])
        map.set(opt, 'no')
        return
      }
      if (state === 'no') this.raw([IAC, yes, opt])
      map.set(opt, 'yes')
      if (!local && opt === TTYPE) this.raw([IAC, SB, TTYPE, 1, IAC, SE])
    } else {
      if (state === 'yes') this.raw([IAC, no, opt])
      map.set(opt, 'no')
    }
  }

  private subneg(data: number[]): void {
    const [opt, ...rest] = data
    const name = this.opts.device.hostname
    if (opt === NAWS && rest.length >= 4) {
      const cols = (rest[0]! << 8) | rest[1]!
      const rows = (rest[2]! << 8) | rest[3]!
      if (rows > 0) {
        this.rows = rows
        this.shell?.resize(rows)
      }
      this.opts.log(`${name}: telnet window ${cols}x${rows}`)
    } else if (opt === TTYPE && rest[0] === 0) {
      this.opts.log(`${name}: telnet terminal type ${Buffer.from(rest.slice(1)).toString('ascii')}`)
    }
  }

  private text(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!
      // The LF of the CR LF that ended the password belongs to login, not to the first shell line.
      if (this.swallowLF) {
        this.swallowLF = false
        if (ch === '\n') continue
      }
      if (this.phase === 'shell') return this.shell!.input(s.slice(i))
      this.loginKey(ch)
    }
  }

  private loginKey(ch: string): void {
    if (ch === '\r' || ch === '\n') {
      this.swallowLF = ch === '\r'
      this.write(CRLF)
      const entered = this.line
      this.line = ''
      return this.phase === 'user' ? this.gotUser(entered) : this.gotPassword(entered)
    }
    if (ch === '\x7f' || ch === '\b') {
      if (this.line) {
        this.line = this.line.slice(0, -1)
        if (this.phase === 'user') this.write('\b \b')
      }
      return
    }
    if (ch < ' ' || ch > '~') return
    this.line += ch
    if (this.phase === 'user') this.write(ch)
  }

  private gotUser(name: string): void {
    if (!name) return this.write('Username: ')
    this.user = name
    this.phase = 'pass'
    this.write('Password: ')
  }

  private gotPassword(pw: string): void {
    const { username, password, device, log } = this.opts
    if (same(this.user, username) && same(pw, password)) {
      log(`${device.hostname}: telnet client authenticated`)
      this.phase = 'shell'
      this.shell = new Shell(device, { write: (s) => this.write(s), close: () => this.sock.end() }, this.rows, { user: this.user, password, from: this.sock.remoteAddress?.replace(/^::ffff:/, '') })
      this.shell.start()
      return
    }
    if (++this.tries >= MAX_TRIES) {
      this.write(`% Bad passwords${CRLF}`)
      this.sock.end()
      return
    }
    this.phase = 'user'
    this.write(`% Login invalid${CRLF}${CRLF}Username: `)
  }
}

/** Start one simulated device as a Telnet server. */
export function startTelnetSim(opts: TelnetSimOptions): Promise<RunningTelnetSim> {
  const { username = 'admin', password = 'admin', log = () => {} } = opts
  const device = resolveDevice(opts.device, opts.scenario, opts.scenarioOptions)
  const timer = setInterval(() => tickBgp(device), 1000)
  tickBgp(device)

  const sockets = new Set<Socket>()
  const server = createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', (e) => log(`${device.hostname}: telnet client error ${e.message}`))
    new TelnetSession(sock, { device, username, password, log }).start()
  })

  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      clearInterval(timer)
      reject(e)
    })
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : opts.port
      resolve({
        port,
        device,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(timer)
            runtime(device).dispose()
            for (const s of sockets) s.destroy()
            server.close(() => r())
          })
      })
    })
  })
}
