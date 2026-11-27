import { Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTelnetSim, type RunningTelnetSim } from '../../simulator/src/telnet-server.ts'
import { makeIosDevice } from '../../simulator/src/state.ts'
import { mapSocketError } from '../src/tcp'
import {
  BRK,
  DO,
  DONT,
  GA,
  IAC,
  NOP,
  SB,
  SE,
  WILL,
  WONT,
  encodeData,
  nawsMessage,
  ttypeIsMessage,
  type NegotiationVerb,
  type TelnetEvent
} from '../src/telnet-codec'
import { OPT, TelnetNegotiator, TelnetParser, TelnetTransport, telnetPolicy, type NegotiationPolicy, type OptionSide } from '../src/telnet'
import { TransportError } from '../src/types'
import { closedPort, testServer, waitFor, type TestServer } from './helpers'

const B = (...bytes: number[]): Buffer => Buffer.from(bytes)
const verbName: Record<number, string> = { [WILL]: 'WILL', [WONT]: 'WONT', [DO]: 'DO', [DONT]: 'DONT' }
const optName: Record<number, string> = Object.fromEntries(Object.entries(OPT).map(([k, v]) => [v, k]))
const fmt = (verb: number, opt: number): string => `${verbName[verb]} ${optName[opt] ?? opt}`

function negotiator(policy: NegotiationPolicy = telnetPolicy) {
  const sent: string[] = []
  const changes: string[] = []
  const refused: string[] = []
  const n = new TelnetNegotiator(policy, {
    send: (v, o) => sent.push(fmt(v, o)),
    changed: (side, o, on) => changes.push(`${side} ${optName[o] ?? o} ${on ? 'on' : 'off'}`),
    refused: (side, o) => refused.push(`${side} ${optName[o] ?? o}`)
  })
  const take = (): string[] => sent.splice(0)
  return { n, sent, take, changes, refused }
}

// ---------------------------------------------------------------------------------- negotiator

describe('TelnetNegotiator policy', () => {
  it.each([
    [WILL, OPT.ECHO, 'DO ECHO', 'remote ECHO on'],
    [WILL, OPT.SGA, 'DO SGA', 'remote SGA on'],
    [WILL, OPT.BINARY, 'DO BINARY', 'remote BINARY on'],
    [DO, OPT.SGA, 'WILL SGA', 'local SGA on'],
    [DO, OPT.TTYPE, 'WILL TTYPE', 'local TTYPE on'],
    [DO, OPT.NAWS, 'WILL NAWS', 'local NAWS on'],
    [DO, OPT.BINARY, 'WILL BINARY', 'local BINARY on']
  ])('accepts %s %s', (verb, opt, reply, change) => {
    const { n, sent, changes } = negotiator()
    n.receive(verb as NegotiationVerb, opt)
    expect(sent).toEqual([reply])
    expect(changes).toEqual([change])
  })

  it.each([
    [DO, OPT.NEW_ENVIRON, 'WONT NEW_ENVIRON'],
    [WILL, OPT.NEW_ENVIRON, 'DONT NEW_ENVIRON'],
    [DO, OPT.ECHO, 'WONT ECHO'], // the server echoes, never us
    [WILL, OPT.NAWS, 'DONT NAWS'], // the server has no window to report
    [WILL, OPT.TTYPE, 'DONT TTYPE'],
    [DO, OPT.LINEMODE, 'WONT LINEMODE'],
    [DO, OPT.TSPEED, 'WONT TSPEED'],
    [DO, OPT.XDISPLOC, 'WONT XDISPLOC'],
    [DO, OPT.AUTH, 'WONT AUTH'],
    [WILL, OPT.ENCRYPT, 'DONT ENCRYPT']
  ])('refuses %s %s', (verb, opt, reply) => {
    const { n, sent, changes, refused } = negotiator()
    n.receive(verb as NegotiationVerb, opt)
    expect(sent).toEqual([reply])
    expect(changes).toEqual([])
    expect(refused).toHaveLength(1)
  })

  it('refuses every option outside the accepted set, on both sides', () => {
    const { n, take } = negotiator()
    const remoteOk = new Set<number>([OPT.ECHO, OPT.SGA, OPT.BINARY])
    const localOk = new Set<number>([OPT.SGA, OPT.TTYPE, OPT.NAWS, OPT.BINARY])
    for (let o = 0; o < 256; o++) {
      n.receive(WILL, o)
      expect(take()).toEqual([fmt(remoteOk.has(o) ? DO : DONT, o)])
      n.receive(DO, o)
      expect(take()).toEqual([fmt(localOk.has(o) ? WILL : WONT, o)])
    }
  })
})

/** Cases from the RFC 1143 section 7 state table, written against the table rather than the code. */
describe('TelnetNegotiator RFC 1143 Q method', () => {
  it('does not acknowledge an acknowledgement (WANTYES + WILL -> YES, silent)', () => {
    const { n, take, changes } = negotiator()
    n.enable('remote', OPT.ECHO)
    expect(take()).toEqual(['DO ECHO'])
    n.receive(WILL, OPT.ECHO)
    expect(take()).toEqual([])
    expect(n.enabled('remote', OPT.ECHO)).toBe(true)
    expect(changes).toEqual(['remote ECHO on'])
  })

  it('ignores a repeated WILL/DO when already YES, even in a flood', () => {
    const { n, take } = negotiator()
    for (let i = 0; i < 100; i++) n.receive(WILL, OPT.SGA)
    for (let i = 0; i < 100; i++) n.receive(DO, OPT.NAWS)
    expect(take()).toEqual(['DO SGA', 'WILL NAWS'])
  })

  it('ignores WONT/DONT for an option that is already off', () => {
    const { n, take } = negotiator()
    n.receive(WONT, OPT.ECHO)
    n.receive(DONT, OPT.NAWS)
    n.receive(WONT, OPT.NEW_ENVIRON)
    expect(take()).toEqual([])
  })

  it('answers a refusal to our request with silence (WANTYES + WONT -> NO)', () => {
    const declined: string[] = []
    const sent: string[] = []
    const n = new TelnetNegotiator(telnetPolicy, { send: (v, o) => sent.push(fmt(v, o)), declined: (side, o) => declined.push(`${side} ${o}`) })
    n.enable('remote', OPT.ECHO)
    n.receive(WONT, OPT.ECHO)
    expect(sent).toEqual(['DO ECHO'])
    expect(declined).toEqual([`remote ${OPT.ECHO}`])
  })

  it('treats DONT in answer to our WILL as final (WANTYES + DONT -> NO)', () => {
    const { n, take, changes } = negotiator()
    n.enable('local', OPT.NAWS)
    expect(take()).toEqual(['WILL NAWS'])
    n.receive(DONT, OPT.NAWS)
    n.receive(DONT, OPT.NAWS)
    expect(take()).toEqual([])
    expect(n.enabled('local', OPT.NAWS)).toBe(false)
    expect(changes).toEqual([])
  })

  it('handles requests that cross on the wire (both sides offer at once)', () => {
    const { n, take } = negotiator()
    n.enable('local', OPT.TTYPE)
    n.enable('remote', OPT.ECHO)
    take()
    n.receive(DO, OPT.TTYPE)
    n.receive(WILL, OPT.ECHO)
    expect(take()).toEqual([])
    expect(n.enabled('local', OPT.TTYPE) && n.enabled('remote', OPT.ECHO)).toBe(true)
  })

  it('acknowledges a peer disabling an enabled option exactly once (YES + WONT -> NO, send DONT)', () => {
    const { n, take, changes } = negotiator()
    n.receive(WILL, OPT.ECHO)
    take()
    n.receive(WONT, OPT.ECHO)
    expect(take()).toEqual(['DONT ECHO'])
    n.receive(WONT, OPT.ECHO)
    expect(take()).toEqual([])
    expect(changes).toEqual(['remote ECHO on', 'remote ECHO off'])
  })

  it('only sends a request once while it is pending', () => {
    const { n, take } = negotiator()
    n.enable('remote', OPT.SGA)
    n.enable('remote', OPT.SGA)
    expect(take()).toEqual(['DO SGA'])
    n.receive(WILL, OPT.SGA)
    n.enable('remote', OPT.SGA)
    expect(take()).toEqual([])
  })

  it('queues a disable requested during WANTYES (WANTYES/OPPOSITE + WILL -> WANTNO, send DONT)', () => {
    const { n, take } = negotiator()
    n.enable('remote', OPT.ECHO)
    n.disable('remote', OPT.ECHO) // sets the queue bit, sends nothing yet
    expect(take()).toEqual(['DO ECHO'])
    n.receive(WILL, OPT.ECHO)
    expect(take()).toEqual(['DONT ECHO'])
    n.receive(WONT, OPT.ECHO)
    expect(take()).toEqual([])
    expect(n.enabled('remote', OPT.ECHO)).toBe(false)
  })

  it('a second enable cancels the queued disable (WANTYES/OPPOSITE -> WANTYES/EMPTY)', () => {
    const { n, take } = negotiator()
    n.enable('remote', OPT.ECHO)
    n.disable('remote', OPT.ECHO)
    n.enable('remote', OPT.ECHO)
    take()
    n.receive(WILL, OPT.ECHO)
    expect(take()).toEqual([])
    expect(n.enabled('remote', OPT.ECHO)).toBe(true)
  })

  it('queues an enable requested during WANTNO (WANTNO/OPPOSITE + WONT -> WANTYES, send DO)', () => {
    const { n, take } = negotiator()
    n.receive(WILL, OPT.SGA)
    take()
    n.disable('remote', OPT.SGA)
    expect(take()).toEqual(['DONT SGA'])
    n.enable('remote', OPT.SGA)
    expect(take()).toEqual([])
    n.receive(WONT, OPT.SGA)
    expect(take()).toEqual(['DO SGA'])
    n.receive(WILL, OPT.SGA)
    expect(take()).toEqual([])
    expect(n.enabled('remote', OPT.SGA)).toBe(true)
  })

  it('treats WILL in answer to our DONT as a protocol error and stays off (WANTNO/EMPTY + WILL -> NO)', () => {
    const { n, take } = negotiator()
    n.receive(WILL, OPT.ECHO)
    n.disable('remote', OPT.ECHO)
    take()
    n.receive(WILL, OPT.ECHO)
    expect(take()).toEqual([])
    expect(n.enabled('remote', OPT.ECHO)).toBe(false)
  })

  it('WANTNO/OPPOSITE + WILL -> YES without sending', () => {
    const { n, take } = negotiator()
    n.receive(DO, OPT.NAWS)
    n.disable('local', OPT.NAWS)
    n.enable('local', OPT.NAWS)
    take()
    n.receive(DO, OPT.NAWS)
    expect(take()).toEqual([])
    expect(n.enabled('local', OPT.NAWS)).toBe(true)
  })

  it('two negotiators wired back to back always go quiet', () => {
    const acceptAll: NegotiationPolicy = { local: () => true, remote: () => true }
    const refuseAll: NegotiationPolicy = { local: () => false, remote: () => false }
    for (const peerPolicy of [acceptAll, refuseAll, telnetPolicy]) {
      const wire: { to: 'a' | 'b'; verb: NegotiationVerb; opt: number }[] = []
      const a = new TelnetNegotiator(telnetPolicy, { send: (verb, opt) => wire.push({ to: 'b', verb, opt }) })
      const b = new TelnetNegotiator(peerPolicy, { send: (verb, opt) => wire.push({ to: 'a', verb, opt }) })
      for (const o of [OPT.ECHO, OPT.SGA, OPT.NAWS, OPT.TTYPE, OPT.BINARY, OPT.NEW_ENVIRON]) {
        for (const side of ['local', 'remote'] as OptionSide[]) {
          a.enable(side, o)
          b.enable(side, o)
        }
      }
      let steps = 0
      while (wire.length) {
        const m = wire.shift()!
        ;(m.to === 'a' ? a : b).receive(m.verb, m.opt)
        expect(++steps).toBeLessThan(100)
      }
      // Whatever was agreed is agreed on both ends.
      for (const o of [OPT.ECHO, OPT.SGA, OPT.NAWS, OPT.TTYPE, OPT.BINARY]) {
        expect(a.enabled('local', o)).toBe(b.enabled('remote', o))
        expect(a.enabled('remote', o)).toBe(b.enabled('local', o))
      }
    }
  })
})

// ---------------------------------------------------------------------------------- parser / codec

const mergeData = (events: TelnetEvent[]): TelnetEvent[] => {
  const out: TelnetEvent[] = []
  for (const e of events) {
    const last = out.at(-1)
    if (e.type === 'data' && last?.type === 'data') out[out.length - 1] = { type: 'data', data: Buffer.concat([last.data, e.data]) }
    else out.push(e)
  }
  return out
}

describe('TelnetParser', () => {
  it('passes plain data through untouched', () => {
    expect(new TelnetParser().feed(Buffer.from('hello\r\nworld'))).toEqual([{ type: 'data', data: Buffer.from('hello\r\nworld') }])
  })

  it('unescapes IAC IAC to a single 0xFF data byte', () => {
    expect(new TelnetParser().feed(B(0x41, IAC, IAC, 0x42))).toEqual([{ type: 'data', data: B(0x41, 0xff, 0x42) }])
  })

  it('strips negotiations and keeps data order around them', () => {
    const ev = new TelnetParser().feed(Buffer.concat([Buffer.from('a'), B(IAC, WILL, OPT.ECHO), Buffer.from('b'), B(IAC, DO, OPT.NAWS)]))
    expect(ev).toEqual([
      { type: 'data', data: Buffer.from('a') },
      { type: 'negotiate', verb: WILL, option: OPT.ECHO },
      { type: 'data', data: Buffer.from('b') },
      { type: 'negotiate', verb: DO, option: OPT.NAWS }
    ])
  })

  it('parses subnegotiations, unescaping IAC IAC inside', () => {
    const ev = new TelnetParser().feed(B(IAC, SB, OPT.TTYPE, 1, IAC, SE, IAC, SB, OPT.NAWS, 0, IAC, IAC, 0, 24, IAC, SE))
    expect(ev).toEqual([
      { type: 'subneg', option: OPT.TTYPE, data: B(1) },
      { type: 'subneg', option: OPT.NAWS, data: B(0, 255, 0, 24) }
    ])
  })

  it('reports other commands and drops them from data', () => {
    expect(new TelnetParser().feed(B(0x61, IAC, GA, IAC, NOP, 0x62))).toEqual([
      { type: 'data', data: Buffer.from('a') },
      { type: 'command', code: GA },
      { type: 'command', code: NOP },
      { type: 'data', data: Buffer.from('b') }
    ])
  })

  it('turns CR NUL into CR and keeps CR LF', () => {
    expect(new TelnetParser().feed(Buffer.from('a\r\0b\r\nc'))).toEqual([{ type: 'data', data: Buffer.from('a\rb\r\nc') }])
  })

  it('keeps NUL that does not follow CR, and keeps CR NUL in BINARY mode', () => {
    expect(new TelnetParser().feed(Buffer.from('a\0b'))).toEqual([{ type: 'data', data: Buffer.from('a\0b') }])
    const p = new TelnetParser()
    p.binary = true
    expect(p.feed(Buffer.from('\r\0'))).toEqual([{ type: 'data', data: Buffer.from('\r\0') }])
  })

  it('gives the same result fed one byte at a time as fed whole', () => {
    const stream = Buffer.concat([
      Buffer.from('Username: \r'),
      B(0, IAC, IAC, IAC, WILL, OPT.ECHO, IAC, SB, OPT.NAWS, 0, IAC, IAC, 1, 0, IAC, SE),
      Buffer.from('x\r'),
      B(0),
      Buffer.from('\r\ny'),
      B(IAC, GA)
    ])
    const whole = new TelnetParser().feed(stream)
    const bytewise = new TelnetParser()
    const split = mergeData([...stream].flatMap((b) => bytewise.feed(B(b))))
    expect(split).toEqual(mergeData(whole))
    expect(whole.filter((e) => e.type === 'data').map((e) => (e as { data: Buffer }).data.toString('latin1')).join('')).toBe(
      'Username: \r\xffx\r\r\ny'
    )
  })
})

describe('outgoing encoding', () => {
  it('doubles IAC in data', () => {
    expect(encodeData(B(1, 0xff, 2, 0xff, 0xff))).toEqual(B(1, IAC, IAC, 2, IAC, IAC, IAC, IAC))
  })

  it('sends a bare CR as CR NUL and leaves CR LF alone', () => {
    expect(encodeData(Buffer.from('show ver\r'))).toEqual(Buffer.from('show ver\r\0'))
    expect(encodeData(Buffer.from('a\r\nb\rc'))).toEqual(Buffer.from('a\r\nb\r\0c'))
  })

  it('can send a bare CR as CR LF instead', () => {
    expect(encodeData(Buffer.from('a\r'), { newline: 'crlf' })).toEqual(Buffer.from('a\r\n'))
    expect(encodeData(Buffer.from('a\r\n'), { newline: 'crlf' })).toEqual(Buffer.from('a\r\n'))
  })

  it('does no CR translation in BINARY mode but still escapes IAC', () => {
    expect(encodeData(B(13, 0xff), { binary: true })).toEqual(B(13, IAC, IAC))
  })

  it('round-trips arbitrary bytes through encode then parse (binary both ways)', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const p = new TelnetParser()
    p.binary = true
    expect(mergeData(p.feed(encodeData(all, { binary: true })))).toEqual([{ type: 'data', data: all }])
  })

  it('encodes NAWS big-endian and doubles 255 inside the subnegotiation', () => {
    expect(nawsMessage(80, 24)).toEqual(B(IAC, SB, OPT.NAWS, 0, 80, 0, 24, IAC, SE))
    expect(nawsMessage(255, 255)).toEqual(B(IAC, SB, OPT.NAWS, 0, IAC, IAC, 0, IAC, IAC, IAC, SE))
    expect(nawsMessage(300, 65535)).toEqual(B(IAC, SB, OPT.NAWS, 1, 44, IAC, IAC, IAC, IAC, IAC, SE))
  })

  it('encodes TERMINAL-TYPE IS', () => {
    expect(ttypeIsMessage('VT100')).toEqual(Buffer.concat([B(IAC, SB, OPT.TTYPE, 0), Buffer.from('VT100'), B(IAC, SE)]))
  })
})

// ---------------------------------------------------------------------------------- transport, scripted server

/** Finds `needle` in `hay` (Buffer.includes with a Buffer argument). */
const has = (hay: Buffer, needle: Buffer): boolean => hay.includes(needle)

describe('TelnetTransport against a scripted server', () => {
  let srv: TestServer
  beforeAll(async () => {
    srv = await testServer()
  })
  afterAll(() => srv.close())

  async function open(opts: Partial<ConstructorParameters<typeof TelnetTransport>[0]> = {}) {
    const t = new TelnetTransport({ host: '127.0.0.1', port: srv.port, ...opts })
    const data: Buffer[] = []
    const notices: string[] = []
    const closes: unknown[][] = []
    t.on('data', (d: Buffer) => data.push(d))
    t.on('notice', (n: string) => notices.push(n))
    t.on('close', (...args: unknown[]) => closes.push(args))
    await t.connect()
    const peer = await srv.peer()
    const text = (): string => Buffer.concat(data).toString('latin1')
    return { t, peer, notices, closes, text }
  }

  it('offers NAWS, TTYPE and SGA and asks for ECHO and SGA up front', async () => {
    const { t, peer } = await open()
    await waitFor(() => peer.received().length >= 15, 'initial offers')
    const r = peer.received()
    for (const [v, o] of [
      [WILL, OPT.NAWS],
      [WILL, OPT.TTYPE],
      [WILL, OPT.SGA],
      [DO, OPT.SGA],
      [DO, OPT.ECHO]
    ] as const)
      expect(has(r, B(IAC, v, o))).toBe(true)
    t.end()
  })

  it('answers TTYPE SEND with IS, cycling a configured list and repeating the last entry', async () => {
    const { t, peer, notices } = await open({ terminalType: ['XTERM-256COLOR', 'VT100'] })
    peer.sock.write(B(IAC, DO, OPT.TTYPE, IAC, SB, OPT.TTYPE, 1, IAC, SE))
    await waitFor(() => has(peer.received(), ttypeIsMessage('XTERM-256COLOR')), 'first IS')
    peer.sock.write(B(IAC, SB, OPT.TTYPE, 1, IAC, SE, IAC, SB, OPT.TTYPE, 1, IAC, SE))
    await waitFor(() => peer.received().toString('latin1').split('VT100').length === 3, 'VT100 twice')
    expect(notices.join('\n')).toMatch(/terminal type XTERM-256COLOR/)
    t.end()
  })

  it('defaults the terminal type to XTERM-256COLOR', async () => {
    const { t, peer } = await open()
    peer.sock.write(B(IAC, DO, OPT.TTYPE, IAC, SB, OPT.TTYPE, 1, IAC, SE))
    await waitFor(() => has(peer.received(), ttypeIsMessage('XTERM-256COLOR')), 'IS XTERM-256COLOR')
    t.end()
  })

  it('sends NAWS once agreed, holds an earlier resize until then, and sends on later resizes', async () => {
    const { t, peer, notices } = await open({ size: { cols: 100, rows: 30 } })
    t.resize({ cols: 120, rows: 40 })
    await new Promise((r) => setTimeout(r, 20))
    expect(has(peer.received(), B(IAC, SB, OPT.NAWS))).toBe(false)
    peer.sock.write(B(IAC, DO, OPT.NAWS))
    await waitFor(() => has(peer.received(), nawsMessage(120, 40)), 'NAWS 120x40')
    t.resize({ cols: 255, rows: 50 })
    await waitFor(() => has(peer.received(), nawsMessage(255, 50)), 'NAWS 255x50')
    expect(notices.join('\n')).toMatch(/window size 120x40/)
    t.end()
  })

  it('refuses NEW-ENVIRON and says so in a notice', async () => {
    const { t, peer, notices } = await open()
    peer.sock.write(B(IAC, DO, OPT.NEW_ENVIRON))
    await waitFor(() => has(peer.received(), B(IAC, WONT, OPT.NEW_ENVIRON)), 'WONT NEW-ENVIRON')
    await waitFor(() => notices.some((n) => /refused NEW-ENVIRON/.test(n)), 'refusal notice')
    t.end()
  })

  it('strips IAC sequences from incoming data and unescapes 0xFF', async () => {
    const { t, peer, text, notices } = await open()
    peer.sock.write(Buffer.concat([Buffer.from('Username: '), B(IAC, WILL, OPT.ECHO, IAC, WILL, OPT.SGA, IAC, IAC), Buffer.from('\r\0ok\r\n')]))
    await waitFor(() => text().endsWith('ok\r\n'), 'data')
    expect(text()).toBe('Username: \xff\rok\r\n')
    expect(t.serverEchoes).toBe(true)
    expect(notices.join('\n')).toMatch(/server echoes/)
    peer.sock.write(B(IAC, WONT, OPT.ECHO))
    await waitFor(() => notices.some((n) => /local echo needed/.test(n)), 'WONT ECHO notice')
    expect(t.serverEchoes).toBe(false)
    t.end()
  })

  it('says local echo is needed when the server declines DO ECHO', async () => {
    const { t, peer, notices } = await open()
    await waitFor(() => has(peer.received(), B(IAC, DO, OPT.ECHO)), 'DO ECHO')
    peer.sock.write(B(IAC, WONT, OPT.ECHO))
    await waitFor(() => notices.some((n) => /server does not echo, local echo needed/.test(n)), 'declined notice')
    expect(t.serverEchoes).toBe(false)
    t.end()
  })

  it('escapes IAC and encodes Enter on write', async () => {
    const { t, peer } = await open()
    await waitFor(() => peer.received().length >= 15, 'initial offers')
    peer.clear()
    t.write(Buffer.from([0x41, 0xff, 0x0d]))
    t.write('é\r\n')
    await waitFor(() => peer.received().length >= 9, 'written bytes')
    expect(peer.received()).toEqual(Buffer.concat([B(0x41, IAC, IAC, 0x0d, 0), Buffer.from('é\r\n', 'utf8')]))
    t.end()
  })

  it('sends IAC BRK for sendBreak()', async () => {
    const { t, peer } = await open()
    await waitFor(() => peer.received().length >= 15, 'initial offers')
    peer.clear()
    await t.sendBreak()
    await waitFor(() => peer.received().length >= 2, 'BRK')
    expect(peer.received()).toEqual(B(IAC, BRK))
    t.end()
  })

  it('emits close with no reason after end(), and ignores writes afterwards', async () => {
    const { t, closes } = await open()
    t.end()
    t.write('ignored')
    t.resize({ cols: 1, rows: 1 })
    await waitFor(() => closes.length, 'close')
    expect(closes).toEqual([[]])
  })

  it('emits close with a reason when the server hangs up, exactly once', async () => {
    const { peer, closes } = await open()
    peer.sock.end()
    await waitFor(() => closes.length, 'close')
    await new Promise((r) => setTimeout(r, 20))
    expect(closes).toHaveLength(1)
    expect(closes[0]![0]).toBe('remote-closed: Connection closed by remote host')
  })

  it('a connection reset keeps its reason, without the "remote-closed:" prefix', async () => {
    const { peer, closes } = await open()
    peer.sock.resetAndDestroy()
    await waitFor(() => closes.length, 'close')
    expect(closes[0]![0]).toEqual(expect.any(String))
    expect(closes[0]![0]).not.toMatch(/^remote-closed:/)
    expect(closes[0]![0]).toMatch(/ECONNRESET/)
  })

  it('supports pause() and resume()', async () => {
    const { t, peer, text } = await open()
    t.pause()
    peer.sock.write('held')
    await new Promise((r) => setTimeout(r, 30))
    expect(text()).toBe('')
    t.resume()
    await waitFor(() => text() === 'held', 'data after resume')
    t.end()
  })
})

describe('TelnetTransport connect errors', () => {
  it('rejects with refused on a closed port, without a close event', async () => {
    const port = await closedPort()
    const t = new TelnetTransport({ host: '127.0.0.1', port })
    let closed = false
    t.on('close', () => (closed = true))
    const err = await t.connect().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('refused')
    expect(closed).toBe(false)
  })

  it('rejects with timeout when the connect never completes', async () => {
    const t = new TelnetTransport({ host: '192.0.2.1', connectTimeoutMs: 20, createSocket: () => new Socket() })
    const err = await t.connect().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('timeout')
  })

  it('rejects (does not throw) on an invalid port', async () => {
    const t = new TelnetTransport({ host: '127.0.0.1', port: 70000 })
    const err = await t.connect().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('other')
  })

  it('rejects with cancelled when end() is called while connecting', async () => {
    const t = new TelnetTransport({ host: '192.0.2.1', createSocket: () => new Socket() })
    const p = t.connect().catch((e: unknown) => e)
    t.end()
    expect(((await p) as TransportError).code).toBe('cancelled')
  })

  it.each([
    ['ECONNREFUSED', 'refused'],
    ['ETIMEDOUT', 'timeout'],
    ['ENOTFOUND', 'unreachable'],
    ['EAI_AGAIN', 'unreachable'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ECONNRESET', 'other'],
    [undefined, 'other']
  ])('maps %s to %s', (code, expected) => {
    const e = Object.assign(new Error('boom'), { code })
    expect(mapSocketError(e).code).toBe(expected)
  })
})

// ---------------------------------------------------------------------------------- simulator integration

describe('TelnetTransport against the Telnet simulator', () => {
  let sim: RunningTelnetSim
  const simLog: string[] = []
  beforeAll(async () => {
    sim = await startTelnetSim({ device: makeIosDevice(), port: 0, log: (m) => simLog.push(m) })
  })
  afterAll(() => sim.close())

  it('logs in, runs show version, and reports a resize with NAWS', async () => {
    const t = new TelnetTransport({ host: '127.0.0.1', port: sim.port, size: { cols: 100, rows: 30 } })
    let out = ''
    const notices: string[] = []
    t.on('data', (d: Buffer) => (out += d.toString('utf8')))
    t.on('notice', (n: string) => notices.push(n))
    await t.connect()

    const expectOut = async (re: RegExp): Promise<string> => {
      const text = await waitFor(() => re.test(out) && out, `${re} in output:\n${out}`)
      out = ''
      return text
    }
    await expectOut(/Username: $/)
    t.write('admin\r')
    await expectOut(/Password: $/)
    t.write('admin\r')
    await expectOut(/core-sw1#$/)
    t.write('terminal length 0\r')
    await expectOut(/core-sw1#$/)
    t.write('show version\r')
    const version = await expectOut(/core-sw1#$/)
    expect(version).toMatch(/Cisco IOS XE Software, Version/)
    expect(version).not.toMatch(/--More--/)

    expect(t.serverEchoes).toBe(true)
    expect(notices.join('\n')).toMatch(/server echoes/)
    await waitFor(() => simLog.some((l) => l.endsWith('telnet window 100x30')), 'initial NAWS at the simulator')
    expect(simLog.some((l) => l.endsWith('telnet terminal type XTERM-256COLOR'))).toBe(true)

    t.resize({ cols: 132, rows: 50 })
    await waitFor(() => simLog.some((l) => l.endsWith('telnet window 132x50')), 'NAWS after resize')

    const closed = new Promise<unknown[]>((r) => t.once('close', (...a: unknown[]) => r(a)))
    t.end()
    expect(await closed).toEqual([])
  })

  it('does not echo the password and rejects bad credentials', async () => {
    const t = new TelnetTransport({ host: '127.0.0.1', port: sim.port, newline: 'crlf' })
    let out = ''
    t.on('data', (d: Buffer) => (out += d.toString('utf8')))
    await t.connect()
    await waitFor(() => /Username: $/.test(out), 'Username prompt')
    t.write('admin\r')
    await waitFor(() => /Password: $/.test(out), 'Password prompt')
    t.write('s3cret-wrong\r')
    await waitFor(() => /% Login invalid\r\n\r\nUsername: $/.test(out), 'login invalid')
    expect(out).toContain('admin')
    expect(out).not.toContain('s3cret-wrong')
    t.end()
  })
})
