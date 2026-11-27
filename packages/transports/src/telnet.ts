/**
 * Telnet client transport: a TCP socket plus the pure parser (telnet-codec) and RFC 1143
 * negotiator (telnet-options). This file only wires them together and decides policy.
 */
import { TcpTransport, type TcpOptions } from './tcp'
import {
  BRK,
  IAC,
  OPT,
  TTYPE_SEND,
  TelnetParser,
  encodeData,
  nawsMessage,
  negotiation,
  optionName,
  ttypeIsMessage,
  type NewlineMode
} from './telnet-codec'
import { TelnetNegotiator, type NegotiationPolicy, type OptionSide } from './telnet-options'
import type { TermSize, Transport } from './types'

export { TelnetParser, encodeData, escapeIac, nawsMessage, ttypeIsMessage, OPT, optionName } from './telnet-codec'
export { TelnetNegotiator, type NegotiationPolicy, type NegotiatorOutput, type OptionSide } from './telnet-options'

export interface TelnetTransportOptions extends Omit<TcpOptions, 'port'> {
  /** Default 23. */
  port?: number
  /**
   * Answer to TERMINAL-TYPE SEND. With a list, each SEND gets the next entry and the last one
   * repeats, which RFC 1091 servers read as "end of list". Default XTERM-256COLOR.
   */
  terminalType?: string | readonly string[]
  /** Initial window size, sent once the server agrees to NAWS. Default 80x24. */
  size?: TermSize
  /** How a bare CR (the Enter key) goes on the wire outside BINARY mode. Default CR NUL (RFC 854). */
  newline?: NewlineMode
}

/** Options the server may perform: it echoes, suppresses go-ahead, sends 8-bit. */
const REMOTE_OK = new Set<number>([OPT.ECHO, OPT.SGA, OPT.BINARY])
/** Options we perform. ECHO is deliberately absent: the server echoes, we don't. NEW-ENVIRON could leak USER. */
const LOCAL_OK = new Set<number>([OPT.SGA, OPT.TTYPE, OPT.NAWS, OPT.BINARY])

/** What this client agrees to; exported for tests and for anyone building a custom negotiator. */
export const telnetPolicy: NegotiationPolicy = {
  local: (o) => LOCAL_OK.has(o),
  remote: (o) => REMOTE_OK.has(o)
}

export class TelnetTransport extends TcpTransport implements Transport {
  readonly kind = 'telnet' as const
  private readonly parser = new TelnetParser()
  private readonly options: TelnetNegotiator
  private readonly terminalTypes: readonly string[]
  private ttypeIndex = 0
  private size: TermSize
  private readonly newline: NewlineMode
  /** Notice fragments collected while handling one read, emitted together. */
  private pending: string[] = []

  constructor(opts: TelnetTransportOptions) {
    super({ ...opts, port: opts.port ?? 23 })
    const tt = opts.terminalType ?? 'XTERM-256COLOR'
    this.terminalTypes = typeof tt === 'string' ? [tt] : tt.length ? tt : ['XTERM-256COLOR']
    this.size = opts.size ?? { cols: 80, rows: 24 }
    this.newline = opts.newline ?? 'crnul'
    this.options = new TelnetNegotiator(telnetPolicy, {
      send: (verb, option) => this.send(negotiation(verb, option)),
      changed: (side, option, on) => this.optionChanged(side, option, on),
      refused: (_side, option) => this.pending.push(`refused ${optionName(option)}`),
      declined: (side, option) => {
        if (side === 'remote' && option === OPT.ECHO) this.pending.push('server does not echo, local echo needed')
      }
    })
  }

  /** False after the server sends WONT ECHO: the host should echo locally. */
  get serverEchoes(): boolean {
    return this.options.enabled('remote', OPT.ECHO)
  }

  write(data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.send(encodeData(buf, { binary: this.options.enabled('local', OPT.BINARY), newline: this.newline }))
  }

  resize(size: TermSize): void {
    this.size = { cols: size.cols, rows: size.rows }
    if (this.options.enabled('local', OPT.NAWS)) this.send(nawsMessage(size.cols, size.rows))
  }

  async sendBreak(): Promise<void> {
    this.send(Buffer.from([IAC, BRK]))
  }

  protected onConnected(): void {
    // Many devices (some Cisco lines, terminal servers) wait for the client to speak first.
    this.options.enable('local', OPT.NAWS)
    this.options.enable('local', OPT.TTYPE)
    this.options.enable('local', OPT.SGA)
    this.options.enable('remote', OPT.SGA)
    this.options.enable('remote', OPT.ECHO)
  }

  protected onRemoteData(buf: Buffer): void {
    for (const ev of this.parser.feed(buf)) {
      if (ev.type === 'data') this.emit('data', ev.data)
      else if (ev.type === 'negotiate') this.options.receive(ev.verb, ev.option)
      else if (ev.type === 'subneg') this.subnegotiation(ev.option, ev.data)
      // Other commands (GA, NOP, AYT from a server, ...) carry nothing a terminal needs.
    }
    if (this.pending.length) {
      this.notice(`Telnet: ${this.pending.join(', ')}`)
      this.pending = []
    }
  }

  private subnegotiation(option: number, data: Buffer): void {
    if (option !== OPT.TTYPE || data[0] !== TTYPE_SEND || !this.options.enabled('local', OPT.TTYPE)) return
    const name = this.terminalTypes[Math.min(this.ttypeIndex++, this.terminalTypes.length - 1)]!
    this.send(ttypeIsMessage(name))
    this.pending.push(`terminal type ${name}`)
  }

  private optionChanged(side: OptionSide, option: number, on: boolean): void {
    if (option === OPT.BINARY && side === 'remote') this.parser.binary = on
    if (option === OPT.NAWS && side === 'local' && on) {
      this.send(nawsMessage(this.size.cols, this.size.rows))
      this.pending.push(`window size ${this.size.cols}x${this.size.rows}`)
      return
    }
    if (option === OPT.ECHO) {
      this.pending.push(on ? 'server echoes' : 'server stopped echoing, local echo needed')
      return
    }
    if (option === OPT.TTYPE && on) return // reported when the type is actually sent
    const who = side === 'local' ? 'client' : 'server'
    this.pending.push(`${optionName(option)} ${on ? 'on' : 'off'} (${who})`)
  }
}
