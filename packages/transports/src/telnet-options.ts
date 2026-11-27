/**
 * Telnet option negotiation using the RFC 1143 "Q method". Each option has two independent
 * sides: `local` (we perform it: WILL/WONT from us, DO/DONT from the peer) and `remote` (the peer
 * performs it: DO/DONT from us, WILL/WONT from the peer). Each side is NO, YES, WANTNO or WANTYES,
 * plus a one-bit queue for a reversal requested mid-negotiation. Following the table exactly is
 * what guarantees we never answer an acknowledgement and so never loop.
 */
import { DO, DONT, WILL, WONT, type NegotiationVerb } from './telnet-codec'

export type OptionSide = 'local' | 'remote'
type Q = 'no' | 'yes' | 'wantno' | 'wantyes'

interface SideState {
  q: Q
  /** RFC 1143 OPPOSITE queue bit. */
  opposite: boolean
}

export interface NegotiationPolicy {
  /** May we enable `option` on our side when the peer sends DO? */
  local(option: number): boolean
  /** May the peer enable `option` when it sends WILL? */
  remote(option: number): boolean
}

export interface NegotiatorOutput {
  send(verb: NegotiationVerb, option: number): void
  /** The option actually turned on or off for that side. */
  changed?(side: OptionSide, option: number, enabled: boolean): void
  /** We declined a peer's request to enable an option. */
  refused?(side: OptionSide, option: number): void
  /** The peer declined our request to enable an option. */
  declined?(side: OptionSide, option: number): void
}

const verbs = {
  local: { on: WILL, off: WONT },
  remote: { on: DO, off: DONT }
} as const

export class TelnetNegotiator {
  private readonly sides = { local: new Map<number, SideState>(), remote: new Map<number, SideState>() }

  constructor(
    private readonly policy: NegotiationPolicy,
    private readonly out: NegotiatorOutput
  ) {}

  enabled(side: OptionSide, option: number): boolean {
    return this.state(side, option).q === 'yes'
  }

  /** Feed a WILL/WONT/DO/DONT received from the peer. */
  receive(verb: NegotiationVerb, option: number): void {
    if (verb === WILL) this.peerOn('remote', option)
    else if (verb === WONT) this.peerOff('remote', option)
    else if (verb === DO) this.peerOn('local', option)
    else this.peerOff('local', option)
  }

  /** Ask to turn an option on (we offer WILL for local, or request DO for remote). */
  enable(side: OptionSide, option: number): void {
    const s = this.state(side, option)
    switch (s.q) {
      case 'no':
        s.q = 'wantyes'
        this.out.send(verbs[side].on, option)
        break
      case 'yes':
        break
      case 'wantno':
        s.opposite = true
        break
      case 'wantyes':
        s.opposite = false
        break
    }
  }

  /** Ask to turn an option off. */
  disable(side: OptionSide, option: number): void {
    const s = this.state(side, option)
    switch (s.q) {
      case 'no':
        break
      case 'yes':
        s.q = 'wantno'
        this.out.send(verbs[side].off, option)
        this.out.changed?.(side, option, false)
        break
      case 'wantno':
        s.opposite = false
        break
      case 'wantyes':
        s.opposite = true
        break
    }
  }

  private allowed(side: OptionSide, option: number): boolean {
    return side === 'local' ? this.policy.local(option) : this.policy.remote(option)
  }

  /** Peer sent WILL (remote side) or DO (local side). */
  private peerOn(side: OptionSide, option: number): void {
    const s = this.state(side, option)
    const { on, off } = verbs[side]
    switch (s.q) {
      case 'no':
        if (this.allowed(side, option)) {
          s.q = 'yes'
          this.out.send(on, option)
          this.out.changed?.(side, option, true)
        } else {
          this.out.send(off, option)
          this.out.refused?.(side, option)
        }
        break
      case 'yes':
        break
      case 'wantno':
        // Peer answered our "off" with "on": an RFC 1143 protocol error. Treat as off, or honour the queue.
        if (s.opposite) {
          s.q = 'yes'
          s.opposite = false
          this.out.changed?.(side, option, true)
        } else {
          s.q = 'no'
        }
        break
      case 'wantyes':
        if (s.opposite) {
          s.q = 'wantno'
          s.opposite = false
          this.out.send(off, option)
        } else {
          s.q = 'yes'
          this.out.changed?.(side, option, true)
        }
        break
    }
  }

  /** Peer sent WONT (remote side) or DONT (local side). */
  private peerOff(side: OptionSide, option: number): void {
    const s = this.state(side, option)
    const { on, off } = verbs[side]
    switch (s.q) {
      case 'no':
        break
      case 'yes':
        s.q = 'no'
        this.out.send(off, option)
        this.out.changed?.(side, option, false)
        break
      case 'wantno':
        if (s.opposite) {
          s.q = 'wantyes'
          s.opposite = false
          this.out.send(on, option)
        } else {
          s.q = 'no'
        }
        break
      case 'wantyes':
        s.q = 'no'
        // With the queue bit set we wanted it off anyway, so it isn't a refusal.
        if (!s.opposite) this.out.declined?.(side, option)
        s.opposite = false
        break
    }
  }

  private state(side: OptionSide, option: number): SideState {
    const map = this.sides[side]
    let s = map.get(option)
    if (!s) {
      s = { q: 'no', opposite: false }
      map.set(option, s)
    }
    return s
  }
}
