import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import ssh2 from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateEd25519, makeIosDevice, startSim, type RunningSim, type SimOptions } from '../../simulator/src/index.ts'
import { legacyStats } from '../src/legacy/index.ts'
import { SSH_LOGOUT_REASON, SshTransport, sshFingerprint, type SshAuth, type SshHop, type SshTransportOptions } from '../src/ssh.ts'
import { TransportError, type HostKeyVerifier, type Prompter } from '../src/types.ts'
import { generateDsaHostKey } from './fixtures/dsa.ts'

const { utils } = ssh2

// ---- helpers ------------------------------------------------------------------------------------

const sims: RunningSim[] = []
const live: SshTransport[] = []
afterEach(() => {
  for (const t of live.splice(0)) t.end()
})
afterAll(async () => {
  await Promise.all(sims.splice(0).map((s) => s.close()))
})

async function sim(extra: Partial<SimOptions> = {}): Promise<RunningSim> {
  const s = await startSim({ device: makeIosDevice(), port: 0, ...extra })
  sims.push(s)
  return s
}

interface RecordingPrompter extends Prompter {
  rounds: Parameters<Prompter['keyboardInteractive']>[0][]
  secrets: Parameters<Prompter['secret']>[0][]
}

function prompter(answers: { kbd?: (string[] | null)[]; secret?: (string | null)[] } = {}): RecordingPrompter {
  const kbd = [...(answers.kbd ?? [])]
  const secret = [...(answers.secret ?? [])]
  const p: RecordingPrompter = {
    rounds: [],
    secrets: [],
    keyboardInteractive: async (round) => {
      p.rounds.push(round)
      return kbd.length ? kbd.shift()! : null
    },
    secret: async (what) => {
      p.secrets.push(what)
      return secret.length ? secret.shift()! : null
    }
  }
  return p
}

function transport(port: number, o: Partial<SshTransportOptions> & { auth: SshAuth }): { t: SshTransport; notices: string[]; out: () => string; closes: (string | undefined)[] } {
  const t = new SshTransport({
    host: '127.0.0.1',
    port,
    username: 'admin',
    keepAliveSec: 0,
    size: { cols: 80, rows: 24 },
    verifyHostKey: () => 'accept',
    prompter: prompter(),
    readyTimeoutMs: 5000,
    ...o
  })
  live.push(t)
  const notices: string[] = []
  const closes: (string | undefined)[] = []
  let buf = ''
  t.on('notice', (n: string) => notices.push(n))
  t.on('data', (d: Buffer) => (buf += d.toString('latin1')))
  t.on('close', (r?: string) => closes.push(r))
  return { t, notices, closes, out: () => buf }
}

async function until(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function rejection(p: Promise<unknown>): Promise<TransportError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TransportError)
    return e as TransportError
  }
  throw new Error('expected connect() to reject')
}

function nextEvent<T>(s: RunningSim, name: string): Promise<T> {
  return new Promise((r) => s.events.once(name, r))
}

/** Passphrase-protected ed25519 key (retrying around the ssh2 keygen bug, see generateEd25519). */
const encryptedEd25519 = (passphrase: string) => generateEd25519({ passphrase, rounds: 16 })

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

// ---- auth ---------------------------------------------------------------------------------------

describe('SshTransport auth', () => {
  it('password auth reaches the device prompt and end() closes without a reason', async () => {
    const s = await sim({ methods: ['password'] })
    const { t, notices, out, closes } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    await until(() => /core-sw1#$/.test(out()), 3000, 'prompt')
    expect(notices).toContain('authenticated with password')
    // The full identification line, for platform fingerprinting.
    expect(t.serverIdent).toMatch(/^SSH-2\.0-\S+/)
    t.end()
    expect(closes).toEqual([undefined])
  })

  it.each(['ed25519', 'rsa'] as const)('publickey auth with a generated %s key', async (type) => {
    const kp = type === 'rsa' ? utils.generateKeyPairSync('rsa', { bits: 2048 }) : generateEd25519()
    const s = await sim({ methods: ['publickey'], authorizedKeys: [kp.public] })
    const auths: { method: string; ok: boolean }[] = []
    s.events.on('auth', (a) => auths.push(a))
    const { t, notices, out } = transport(s.port, { auth: { type: 'key', privateKey: kp.private } })
    await t.connect()
    await until(() => /#$/.test(out()))
    expect(notices).toContain('authenticated with publickey')
    expect(auths).toContainEqual({ method: 'publickey', username: 'admin', ok: true })
  })

  it('asks prompter.secret for a missing key passphrase, and re-asks after a wrong one', async () => {
    const kp = encryptedEd25519('open sesame')
    const s = await sim({ methods: ['publickey'], authorizedKeys: [kp.public] })
    const p = prompter({ secret: ['nope', 'open sesame'] })
    const { t, notices } = transport(s.port, { auth: { type: 'key', privateKey: kp.private }, prompter: p })
    await t.connect()
    expect(p.secrets.map((x) => x.kind)).toEqual(['passphrase', 'passphrase'])
    expect(p.secrets[1]!.label).toMatch(/wrong passphrase/i)
    expect(notices).toContain('authenticated with publickey')
  })

  it('cancelling the passphrase prompt rejects with a permanent "cancelled" error', async () => {
    const kp = encryptedEd25519('pw')
    const s = await sim({ methods: ['publickey'], authorizedKeys: [kp.public] })
    const { t } = transport(s.port, { auth: { type: 'key', privateKey: kp.private }, prompter: prompter({ secret: [null] }) })
    const err = await rejection(t.connect())
    expect(err.code).toBe('cancelled')
    expect(err.permanent).toBe(true)
  })

  it('keyboard-interactive MFA: the stored password answers round 1, the user answers round 2', async () => {
    const s = await sim({
      methods: ['keyboard-interactive'],
      keyboardInteractive: [
        { prompts: [{ prompt: 'Password: ', answer: 'admin' }] },
        { name: 'Duo two-factor', instructions: 'Enter a passcode', prompts: [{ prompt: 'Passcode: ', echo: true, answer: '123456' }] }
      ]
    })
    const p = prompter({ kbd: [['123456']] })
    const { t, notices, out } = transport(s.port, { auth: { type: 'password', password: 'admin' }, prompter: p })
    await t.connect()
    await until(() => /#$/.test(out()))
    expect(p.rounds).toEqual([{ name: 'Duo two-factor', instructions: 'Enter a passcode', prompts: [{ prompt: 'Passcode: ', echo: true }] }])
    expect(notices).toContain('authenticated with keyboard-interactive')
  })

  it('keyboard-interactive MFA with nothing stored sends both rounds to the prompter', async () => {
    const s = await sim({
      methods: ['keyboard-interactive'],
      keyboardInteractive: [
        { prompts: [{ prompt: 'Password: ', answer: 'admin' }] },
        { prompts: [{ prompt: 'Verification code: ', answer: '42' }] }
      ]
    })
    const p = prompter({ kbd: [['admin'], ['42']] })
    const { t } = transport(s.port, { auth: { type: 'interactive' }, prompter: p })
    await t.connect()
    expect(p.rounds.map((r) => r.prompts[0]!.prompt)).toEqual(['Password: ', 'Verification code: '])
  })

  it('never auto-answers an OTP prompt with the stored password', async () => {
    const s = await sim({ methods: ['keyboard-interactive'], keyboardInteractive: [{ prompts: [{ prompt: 'One-time password: ', answer: '999' }] }] })
    const p = prompter({ kbd: [['999']] })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'admin' }, prompter: p })
    await t.connect()
    expect(p.rounds).toHaveLength(1)
  })

  it('end() while a login prompt is open cancels the connect', async () => {
    const s = await sim({ methods: ['keyboard-interactive'] })
    let asked!: () => void
    const prompted = new Promise<void>((r) => (asked = r))
    const p: Prompter = {
      keyboardInteractive: () => {
        asked()
        return new Promise(() => {}) // the user never answers
      },
      secret: async () => null
    }
    const { t, closes } = transport(s.port, { auth: { type: 'interactive' }, prompter: p })
    const pending = rejection(t.connect())
    await prompted
    t.end()
    const err = await pending
    expect(err.code).toBe('cancelled')
    expect(closes).toEqual([]) // connect() rejected; no close event for a session that never opened
  })

  it('a bad password is an "auth" error (permanent), after a bounded number of prompts', async () => {
    const s = await sim() // password + keyboard-interactive, like most network gear
    const p = prompter({ kbd: [['wrong1'], ['wrong2'], ['wrong3'], ['wrong4']], secret: ['wrong5'] })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'stale' }, prompter: p })
    const err = await rejection(t.connect())
    expect(err.code).toBe('auth')
    expect(err.permanent).toBe(true)
    expect(err.message).toMatch(/127\.0\.0\.1/)
    expect(p.rounds.length + p.secrets.length).toBeLessThanOrEqual(3)
  })

  it('tells the next prompt that the server rejected the last answer, and how many tries are left', async () => {
    const s = await sim({ methods: ['keyboard-interactive'], keyboardInteractive: [{ prompts: [{ prompt: 'Password: ', answer: 'admin' }] }] })
    const p = prompter({ kbd: [['typo'], ['admin']] })
    const { t } = transport(s.port, { auth: { type: 'interactive' }, prompter: p })
    await t.connect()
    expect(p.rounds.map((r) => r.retry)).toEqual([undefined, { attempt: 2, of: 3 }])
  })

  it('a rejected stored password is reported as such, a rejected typed password as a typo', async () => {
    const s = await sim({ methods: ['password'] })
    const p = prompter({ secret: ['wrong', 'admin'] })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'stale' }, prompter: p })
    await t.connect()
    expect(p.secrets.map((x) => x.retry)).toEqual([{ attempt: 1, of: 3, saved: true }, { attempt: 2, of: 3 }])
  })

  it('a second keyboard-interactive round (OTP after the password) is not flagged as a retry', async () => {
    const s = await sim({
      methods: ['keyboard-interactive'],
      keyboardInteractive: [
        { prompts: [{ prompt: 'Password: ', answer: 'admin' }] },
        { prompts: [{ prompt: 'Verification code: ', answer: '42' }] }
      ]
    })
    const p = prompter({ kbd: [['admin'], ['42']] })
    const { t } = transport(s.port, { auth: { type: 'interactive' }, prompter: p })
    await t.connect()
    expect(p.rounds.map((r) => r.retry)).toEqual([undefined, undefined])
  })

  it.each([
    ['SSH DISCONNECT on the first attempt', { maxAuthTries: 1 }],
    ['TCP close on the first attempt', { maxAuthTries: 1, authDrop: 'close' }],
    ['SSH DISCONNECT after one polite reject', { maxAuthTries: 2 }],
    ['TCP close after one polite reject', { maxAuthTries: 2, authDrop: 'close' }]
  ] as const)('a server that drops the connection on bad credentials is "auth", not a retryable error (%s)', async (_name, drop) => {
    const s = await sim({ methods: ['password'], ...drop })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'wrong' }, prompter: prompter({ secret: ['wrong again', 'still wrong'] }) })
    const err = await rejection(t.connect())
    expect(err.code).toBe('auth')
    expect(err.permanent).toBe(true)
  })

  it.each([
    ['password prompt', 'password', 'disconnect'],
    ['password prompt', 'password', 'close'],
    ['keyboard-interactive round', 'keyboard-interactive', 'disconnect'],
    ['keyboard-interactive round', 'keyboard-interactive', 'close']
  ] as const)('the server giving up while the user is still typing (%s via %s, dropped by %s) is "timeout", not "auth"', async (_name, method, authDrop) => {
    const s = await sim({ methods: [method], loginGraceMs: 500, authDrop })
    let asked = 0
    const slow: Prompter = {
      // The user is still typing when the server's login grace time runs out.
      keyboardInteractive: () => (asked++, new Promise(() => {})),
      secret: () => (asked++, new Promise(() => {}))
    }
    const { t } = transport(s.port, { auth: { type: 'interactive' }, prompter: slow })
    const err = await rejection(t.connect())
    expect(asked).toBe(1)
    expect(err.code).toBe('timeout')
    expect(err.permanent).toBe(false)
    expect(err.message).toMatch(/while waiting for your answer/)
  })

  it('a stored password rejected, then the server giving up during the retry prompt, is still "timeout"', async () => {
    const s = await sim({ methods: ['password'], loginGraceMs: 800 })
    let asked = 0
    const slow: Prompter = { keyboardInteractive: async () => null, secret: () => (asked++, new Promise(() => {})) }
    const { t } = transport(s.port, { auth: { type: 'password', password: 'stale' }, prompter: slow })
    const err = await rejection(t.connect())
    expect(asked).toBe(1)
    expect(err.code).toBe('timeout')
  })

  it('a bad password with password-only servers is an "auth" error too', async () => {
    const s = await sim({ methods: ['password'] })
    const p = prompter({ secret: ['nope', 'nope', 'nope'] })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'wrong' }, prompter: p })
    const err = await rejection(t.connect())
    expect(err.code).toBe('auth')
  })

  it('agent auth falls back to keyboard-interactive, and agentForward requests forwarding', async () => {
    // A fake agent with no identities: agent auth fails, then k-i takes the stored password.
    // Windows agents (Win32-OpenSSH, 1Password) listen on a named pipe; elsewhere it's a Unix socket.
    const dir = mkdtempSync(join(tmpdir(), 'hopline-agent-'))
    const sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, 'agent.sock')
    const agent: Server = createServer((c) => {
      c.on('data', () => c.write(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))) // IDENTITIES_ANSWER, 0 keys
    })
    await new Promise<void>((resolve, reject) => {
      agent.once('error', reject)
      agent.listen(sockPath, resolve)
    })
    try {
      const s = await sim()
      const fwd = nextEvent(s, 'auth-agent')
      const { t, notices } = transport(s.port, { auth: { type: 'agent', socket: sockPath, password: 'admin' }, agentForward: true })
      await t.connect()
      await fwd
      expect(notices).toContain('authenticated with keyboard-interactive (stored password)')
      expect(notices).toContain('agent forwarding enabled')
    } finally {
      agent.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- host keys and errors -------------------------------------------------------------------------

describe('SshTransport host keys and errors', () => {
  it('passes the SHA256 fingerprint to the verifier and maps a reject to "host-key"', async () => {
    const hostKey = generateEd25519()
    const s = await sim({ hostKey: hostKey.private })
    const seen: Parameters<HostKeyVerifier>[0][] = []
    const { t } = transport(s.port, {
      auth: { type: 'password', password: 'admin' },
      verifyHostKey: (k) => {
        seen.push(k)
        return 'reject'
      }
    })
    const err = await rejection(t.connect())
    expect(err.code).toBe('host-key')
    expect(err.permanent).toBe(true)
    const parsed = utils.parseKey(hostKey.public) as ssh2.ParsedKey
    expect(seen).toEqual([{ host: '127.0.0.1', port: s.port, algorithm: 'ssh-ed25519', fingerprint: sshFingerprint(parsed.getPublicSSH()) }])
    expect(seen[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('an async verifier can take its time without tripping the ready timeout', async () => {
    const s = await sim()
    const { t } = transport(s.port, {
      auth: { type: 'password', password: 'admin' },
      readyTimeoutMs: 300,
      verifyHostKey: () => new Promise((r) => setTimeout(() => r('accept'), 600))
    })
    await t.connect()
  })

  it('maps a closed port to "refused"', async () => {
    const { t } = transport(await freePort(), { auth: { type: 'password', password: 'x' } })
    const err = await rejection(t.connect())
    expect(err.code).toBe('refused')
    expect(err.permanent).toBe(false)
  })

  it('maps DNS failure to "unreachable"', async () => {
    const { t } = transport(22, { host: 'no-such-host.invalid', auth: { type: 'password', password: 'x' } })
    const err = await rejection(t.connect())
    expect(err.code).toBe('unreachable')
  })

  it('maps a silent server to "timeout"', async () => {
    const silent = createServer(() => {})
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    try {
      const port = (silent.address() as { port: number }).port
      const { t } = transport(port, { auth: { type: 'password', password: 'x' }, readyTimeoutMs: 300 })
      const err = await rejection(t.connect())
      expect(err.code).toBe('timeout')
    } finally {
      silent.close()
    }
  })

  it('maps "no matching algorithms" to "protocol"', async () => {
    const s = await sim({ hostKey: generateDsaHostKey(), algorithms: { serverHostKey: ['ssh-dss'] } })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'admin' }, legacyAlgorithms: false })
    const err = await rejection(t.connect())
    expect(err.code).toBe('protocol')
    expect(err.message).toMatch(/host key/i)
  })

  it('a logout on the device (exit-status) closes with a "logout:" reason', async () => {
    const s = await sim()
    const { t, out, closes } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    await until(() => /#$/.test(out()))
    t.write('exit\r')
    await until(() => closes.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(closes).toEqual(['logout: session ended by the device'])
    expect(SSH_LOGOUT_REASON).toBe('logout: session ended by the device')
  })

  it('a dropped connection keeps a non-logout reason', async () => {
    const s = await startSim({ device: makeIosDevice(), port: 0 }) // closed by the test, not afterAll
    const { t, out, closes } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    await until(() => /#$/.test(out()))
    await s.close()
    await until(() => closes.length > 0)
    expect(closes[0]).toEqual(expect.any(String))
    expect(closes[0]).not.toMatch(/^logout:/)
  })

  it('a channel closed without exit-status keeps a non-logout reason', async () => {
    const s = await sim({ exitStatus: false })
    const { t, out, closes } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    await until(() => /#$/.test(out()))
    t.write('exit\r')
    await until(() => closes.length > 0)
    expect(closes[0]).toEqual(expect.any(String))
    expect(closes[0]).not.toMatch(/^logout:/)
  })
})

// ---- jump hosts ---------------------------------------------------------------------------------

describe('SshTransport jump hosts', () => {
  let j1: RunningSim
  let j2: RunningSim
  let target: RunningSim
  beforeAll(async () => {
    j1 = await sim({ forwarding: true, username: 'ops1', password: 'pw1', methods: ['password'] })
    j2 = await sim({ forwarding: true, username: 'ops2', password: 'pw2' })
    target = await sim()
  })
  const hops = (over: Partial<SshHop>[] = []): SshHop[] => [
    { host: '127.0.0.1', port: j1.port, username: 'ops1', auth: { type: 'password', password: 'pw1' }, label: 'jump1', ...over[0] },
    { host: '127.0.0.1', port: j2.port, username: 'ops2', auth: { type: 'password', password: 'pw2' }, label: 'jump2', ...over[1] }
  ]

  it('connects through two jump hosts and checks every host key', async () => {
    const checked: number[] = []
    const t1 = nextEvent<{ destPort: number }>(j1, 'tcpip')
    const t2 = nextEvent<{ destPort: number }>(j2, 'tcpip')
    const { t, notices, out } = transport(target.port, {
      auth: { type: 'password', password: 'admin' },
      jump: hops(),
      verifyHostKey: (k) => {
        checked.push(k.port)
        return 'accept'
      }
    })
    await t.connect()
    await until(() => /core-sw1#$/.test(out()))
    expect(checked).toEqual([j1.port, j2.port, target.port])
    expect((await t1).destPort).toBe(j2.port)
    expect((await t2).destPort).toBe(target.port)
    expect(notices).toContain('via jump1 → jump2')
    expect(notices).toContain('jump1: authenticated with password')
  })

  it('names the failing hop (host key rejected on jump2)', async () => {
    const { t } = transport(target.port, {
      auth: { type: 'password', password: 'admin' },
      jump: hops([{}, { verifyHostKey: () => 'reject' }])
    })
    const err = await rejection(t.connect())
    expect(err.code).toBe('host-key')
    expect(err.message).toMatch(/^jump2 /)
  })

  it('names the failing hop (bad password on jump1)', async () => {
    const { t } = transport(target.port, {
      auth: { type: 'password', password: 'admin' },
      jump: hops([{ auth: { type: 'password', password: 'bad' } }]),
      // The user mistypes too (a null answer would be "cancelled", not "auth").
      prompter: prompter({ secret: ['typo', 'typo', 'typo'] })
    })
    const err = await rejection(t.connect())
    expect(err.code).toBe('auth')
    expect(err.message).toMatch(/^jump1 /)
  })

  it('names the unreachable target and the hop it went through', async () => {
    const { t } = transport(await freePort(), { label: 'core1', auth: { type: 'password', password: 'admin' }, jump: hops() })
    const err = await rejection(t.connect())
    expect(err.message).toMatch(/core1 .* via jump2/)
    expect(err.code).toBe('refused')
  })

  it('end() while the target behind a jump host is prompting cancels the connect', async () => {
    const tgt = await sim({ methods: ['keyboard-interactive'] })
    let asked!: () => void
    const prompted = new Promise<void>((r) => (asked = r))
    const { t, notices } = transport(tgt.port, {
      label: 'core1',
      auth: { type: 'interactive' },
      jump: hops(),
      prompter: {
        keyboardInteractive: () => {
          asked()
          return new Promise(() => {})
        },
        secret: async () => null
      }
    })
    const pending = rejection(t.connect())
    await prompted
    expect(notices).toContain(`core1 (127.0.0.1:${tgt.port}): login prompt (keyboard-interactive)`)
    t.end()
    expect((await pending).code).toBe('cancelled')
  })

  it('closes the session when a jump host drops', async () => {
    const j = await sim({ forwarding: true })
    const tgt = await sim()
    const { t, closes, out } = transport(tgt.port, {
      auth: { type: 'password', password: 'admin' },
      jump: [{ host: '127.0.0.1', port: j.port, username: 'admin', auth: { type: 'password', password: 'admin' }, label: 'bastion' }]
    })
    await t.connect()
    await until(() => /#$/.test(out()))
    await j.close()
    await until(() => closes.length > 0)
    expect(closes[0]).toEqual(expect.any(String))
  })
})

// ---- channel ------------------------------------------------------------------------------------

describe('SshTransport channel', () => {
  it('requests the pty with the configured term and size, and forwards resize', async () => {
    const s = await sim()
    const pty = nextEvent<{ term: string; cols: number; rows: number }>(s, 'pty')
    const { t } = transport(s.port, { auth: { type: 'password', password: 'admin' }, term: 'vt100', size: { cols: 100, rows: 30 } })
    await t.connect()
    expect(await pty).toEqual({ term: 'vt100', cols: 100, rows: 30 })
    const wc = nextEvent<{ cols: number; rows: number }>(s, 'window-change')
    t.resize({ cols: 132, rows: 50 })
    expect(await wc).toEqual({ cols: 132, rows: 50 })
  })

  it('delivers the login banner first to a data listener attached after await connect()', async () => {
    const s = await sim({ banner: 'Authorized access only\nViolators will be prosecuted\n' })
    const t = new SshTransport({
      host: '127.0.0.1',
      port: s.port,
      username: 'admin',
      auth: { type: 'password', password: 'admin' },
      keepAliveSec: 0,
      size: { cols: 80, rows: 24 },
      verifyHostKey: () => 'accept',
      prompter: prompter(),
      readyTimeoutMs: 5000
    })
    live.push(t)
    await t.connect()
    let out = ''
    t.on('data', (d: Buffer) => (out += d.toString('latin1')))
    await until(() => /core-sw1#$/.test(out), 3000, 'prompt')
    expect(out.startsWith('Authorized access only\r\nViolators will be prosecuted\r\n')).toBe(true)
  })

  it('a resize() while connecting is used for the pty request', async () => {
    const s = await sim()
    const pty = nextEvent<{ term: string; cols: number; rows: number }>(s, 'pty')
    const { t } = transport(s.port, {
      auth: { type: 'password', password: 'admin' },
      size: { cols: 80, rows: 24 },
      verifyHostKey: () => {
        t.resize({ cols: 200, rows: 60 }) // the window was resized during the host-key dialog
        return 'accept'
      }
    })
    await t.connect()
    expect(await pty).toEqual({ term: 'xterm-256color', cols: 200, rows: 60 })
  })

  it('a resize() after the pty request but before the shell opened is sent as a window change', async () => {
    const s = await sim()
    const wc = nextEvent<{ cols: number; rows: number }>(s, 'window-change')
    const { t } = transport(s.port, { auth: { type: 'password', password: 'admin' }, size: { cols: 80, rows: 24 } })
    s.events.once('pty', () => t.resize({ cols: 120, rows: 40 }))
    await t.connect()
    expect(await wc).toEqual({ cols: 120, rows: 40 })
  })

  it('resume() right after connect() does not lose the banner or the first prompt', async () => {
    const s = await sim({ banner: 'Authorized access only\n' })
    const t = new SshTransport({
      host: '127.0.0.1',
      port: s.port,
      username: 'admin',
      auth: { type: 'password', password: 'admin' },
      keepAliveSec: 0,
      size: { cols: 80, rows: 24 },
      verifyHostKey: () => 'accept',
      prompter: prompter(),
      readyTimeoutMs: 5000
    })
    live.push(t)
    await t.connect()
    t.resume()
    let out = ''
    t.on('data', (d: Buffer) => (out += d.toString('latin1')))
    await until(() => /core-sw1#$/.test(out), 3000, 'prompt')
    expect(out.startsWith('Authorized access only\r\n')).toBe(true)
  })

  it('pause() before data starts holds output until resume()', async () => {
    const s = await sim()
    const { t, out } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    t.pause()
    await new Promise((r) => setTimeout(r, 200))
    expect(out()).toBe('')
    t.resume()
    await until(() => /core-sw1#$/.test(out()), 3000, 'prompt after resume')
  })

  it('sendBreak sends an RFC 4335 break request the device receives', async () => {
    const s = await sim()
    const { t, out } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    const brk = nextEvent<{ length: number }>(s, 'break')
    await t.sendBreak(300)
    expect(await brk).toEqual({ length: 300 })
    // The session is still usable afterwards.
    t.write('show clock\r')
    await until(() => /#$/.test(out()))
  })

  it('pause() stops data until resume()', async () => {
    const s = await sim()
    const { t, out } = transport(s.port, { auth: { type: 'password', password: 'admin' } })
    await t.connect()
    await until(() => /core-sw1#$/.test(out()))
    t.write('terminal length 0\r')
    await until(() => /length 0\r?\n.*#$/s.test(out()))
    t.pause()
    const before = out().length
    t.write('show running-config\r')
    await new Promise((r) => setTimeout(r, 300))
    expect(out().length).toBe(before)
    t.resume()
    await until(() => /hostname core-sw1/.test(out()) && /core-sw1#$/.test(out()), 3000, 'config after resume')
  })
})

// ---- legacy algorithms --------------------------------------------------------------------------

describe('SshTransport legacy algorithms (plain Node, same shims as Electron)', () => {
  it('connects with diffie-hellman-group1-sha1 + ssh-dss through the shims', async () => {
    const s = await sim({
      hostKey: generateDsaHostKey(),
      algorithms: { kex: ['diffie-hellman-group1-sha1'], serverHostKey: ['ssh-dss'], cipher: ['aes128-cbc'], hmac: ['hmac-sha1'] }
    })
    const before = { ...legacyStats }
    const algos: string[] = []
    const { t, notices, out } = transport(s.port, {
      auth: { type: 'password', password: 'admin' },
      verifyHostKey: (k) => {
        algos.push(k.algorithm)
        return 'accept'
      }
    })
    await t.connect()
    await until(() => /#$/.test(out()))
    expect(algos).toEqual(['ssh-dss'])
    expect(notices).toEqual(
      expect.arrayContaining([
        'legacy algorithm diffie-hellman-group1-sha1 negotiated',
        'legacy algorithm ssh-dss negotiated',
        'legacy algorithm aes128-cbc negotiated',
        'legacy algorithm hmac-sha1 negotiated'
      ])
    )
    expect(legacyStats.group1Exchanges).toBe(before.group1Exchanges + 1)
    expect(legacyStats.dssVerifications).toBe(before.dssVerifications + 1)
  })

  it('does not offer legacy algorithms when legacyAlgorithms is false', async () => {
    const s = await sim({ algorithms: { kex: ['diffie-hellman-group1-sha1'] } })
    const { t } = transport(s.port, { auth: { type: 'password', password: 'admin' }, legacyAlgorithms: false })
    const err = await rejection(t.connect())
    expect(err.code).toBe('protocol')
    expect(err.message).toMatch(/key exchange|kex/i)
  })
})
