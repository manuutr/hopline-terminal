/**
 * Telnet wire format (RFC 854): command bytes, a byte-at-a-time parser that survives arbitrary
 * chunk boundaries, and encoders for outgoing data and subnegotiations. No I/O here.
 */

export const IAC = 255
export const DONT = 254
export const DO = 253
export const WONT = 252
export const WILL = 251
export const SB = 250
export const GA = 249
export const BRK = 243
export const NOP = 241
export const SE = 240

export const OPT = {
  BINARY: 0,
  ECHO: 1,
  SGA: 3,
  STATUS: 5,
  TIMING_MARK: 6,
  TTYPE: 24,
  NAWS: 31,
  TSPEED: 32,
  LFLOW: 33,
  LINEMODE: 34,
  XDISPLOC: 35,
  ENVIRON: 36,
  AUTH: 37,
  ENCRYPT: 38,
  NEW_ENVIRON: 39
} as const

export const TTYPE_IS = 0
export const TTYPE_SEND = 1

export type NegotiationVerb = typeof WILL | typeof WONT | typeof DO | typeof DONT

export type TelnetEvent =
  | { type: 'data'; data: Buffer }
  | { type: 'negotiate'; verb: NegotiationVerb; option: number }
  | { type: 'subneg'; option: number; data: Buffer }
  | { type: 'command'; code: number }

const enumNames: Record<number, string> = Object.fromEntries(Object.entries(OPT).map(([k, v]) => [v, k.replace('_', '-')]))
export const optionName = (opt: number): string => enumNames[opt] ?? `option ${opt}`

type State = 'data' | 'iac' | 'neg' | 'sb' | 'sb-data' | 'sb-iac'

/** Subnegotiations larger than this are malformed or hostile; drop the excess. */
const MAX_SB = 4096

/**
 * Splits an incoming byte stream into data and Telnet commands. All state lives on the instance,
 * so a sequence split across TCP reads (IAC | WILL | ECHO, or CR | NUL) parses the same as whole.
 */
export class TelnetParser {
  /** When the remote sends in BINARY mode, CR NUL is literal data and must not be stripped. */
  binary = false
  private state: State = 'data'
  private verb: NegotiationVerb = WILL
  private sbOption = 0
  private sb: number[] = []
  private afterCR = false

  feed(chunk: Buffer): TelnetEvent[] {
    const events: TelnetEvent[] = []
    let out: number[] = []
    const flush = (): void => {
      if (out.length) events.push({ type: 'data', data: Buffer.from(out) })
      out = []
    }
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) {
            this.state = 'iac'
          } else if (b === 0 && this.afterCR && !this.binary) {
            this.afterCR = false
          } else {
            out.push(b)
            this.afterCR = b === 13
          }
          break
        case 'iac':
          if (b === IAC) {
            out.push(IAC)
            this.afterCR = false
            this.state = 'data'
          } else if (b === WILL || b === WONT || b === DO || b === DONT) {
            this.verb = b
            this.state = 'neg'
          } else if (b === SB) {
            this.state = 'sb'
          } else {
            flush()
            events.push({ type: 'command', code: b })
            this.state = 'data'
          }
          break
        case 'neg':
          flush()
          events.push({ type: 'negotiate', verb: this.verb, option: b })
          this.state = 'data'
          break
        case 'sb':
          this.sbOption = b
          this.sb = []
          this.state = 'sb-data'
          break
        case 'sb-data':
          if (b === IAC) this.state = 'sb-iac'
          else if (this.sb.length < MAX_SB) this.sb.push(b)
          break
        case 'sb-iac':
          if (b === SE) {
            flush()
            events.push({ type: 'subneg', option: this.sbOption, data: Buffer.from(this.sb) })
            this.sb = []
            this.state = 'data'
          } else {
            // IAC IAC inside SB is a literal 255. Anything else is malformed; keep the byte and go on.
            if (this.sb.length < MAX_SB) this.sb.push(b)
            this.state = 'sb-data'
          }
          break
      }
    }
    flush()
    return events
  }
}

export type NewlineMode = 'crnul' | 'crlf'

/**
 * Encodes user data for the wire: doubles IAC, and outside BINARY mode encodes a bare CR as CR NUL
 * (or CR LF) as NVT requires. An existing CR LF is left alone so pasted text keeps its lines.
 */
export function encodeData(data: Buffer, opts: { binary?: boolean; newline?: NewlineMode } = {}): Buffer {
  const binary = opts.binary ?? false
  const bareCR = opts.newline === 'crlf' ? 10 : 0
  const out: number[] = []
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!
    out.push(b)
    if (b === IAC) out.push(IAC)
    else if (b === 13 && !binary && data[i + 1] !== 10) out.push(bareCR)
  }
  return Buffer.from(out)
}

/** Doubles IAC bytes, for subnegotiation payloads. */
export function escapeIac(data: Buffer | number[]): number[] {
  const out: number[] = []
  for (const b of data) {
    out.push(b)
    if (b === IAC) out.push(IAC)
  }
  return out
}

export const negotiation = (verb: NegotiationVerb, option: number): Buffer => Buffer.from([IAC, verb, option])

export const subnegotiation = (option: number, payload: Buffer | number[]): Buffer =>
  Buffer.from([IAC, SB, option, ...escapeIac(payload), IAC, SE])

const clamp16 = (n: number): number => Math.max(0, Math.min(0xffff, Math.round(n)))

/** RFC 1073 window size. */
export function nawsMessage(cols: number, rows: number): Buffer {
  const c = clamp16(cols)
  const r = clamp16(rows)
  return subnegotiation(OPT.NAWS, [c >> 8, c & 255, r >> 8, r & 255])
}

/** RFC 1091 `IS <name>` reply. */
export const ttypeIsMessage = (name: string): Buffer => subnegotiation(OPT.TTYPE, [TTYPE_IS, ...Buffer.from(name, 'ascii')])
