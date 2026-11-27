import { createServer, type Server } from 'node:net'
import type { PlatformId } from '@hopline/cli-model'
import { afterAll, describe, expect, it } from 'vitest'
import { makeDevice, startSim, type RunningSim, type SimPlatform } from '../../../packages/simulator/src/index.ts'
import type { ExecResultMsg } from '@shared/host-protocol'
import type { PlatformDetection, PlatformEvent, Session } from '@shared/types'
import type { AuditEntry } from '../src/main/db/audit'
import { PlatformDetector, type DetectHost } from '../src/main/detect'
import { evidenceOf, idleAtPrompt, probeRefusal, settled, type Observed } from '../src/session-host/detect'
import { execute } from '../src/session-host/executor'
import { fakeTab } from './helpers'

/** What each simulated device must be detected as (RouterOS is not modelled: it stays unknown). */
const EXPECT: Record<SimPlatform, PlatformId | 'unknown'> = {
  ios: 'iosxe',
  nxos: 'nxos',
  eos: 'eos',
  junos: 'junos',
  panos: 'panos',
  fortios: 'fortios',
  iosxr: 'iosxr',
  asa: 'asa',
  aireos: 'aireos',
  c9800: 'c9800',
  aoscx: 'aoscx',
  vrp: 'vrp',
  routeros: 'unknown'
}

const sims: RunningSim[] = []
afterAll(async () => {
  for (const s of sims) await s.close()
})

/** A DetectHost over a real SSH shell to the simulator, running the session host's own checks. */
async function hostFor(port: number) {
  const { raw, client } = await fakeTab(port, 24, { platform: 'auto' })
  let banner = ''
  let lastOut = Date.now()
  raw.addTap((t) => {
    lastOut = Date.now()
    if (banner.length < 4096) banner += t
  })
  banner = raw.tail
  const ident = (client as unknown as { _protocol?: { _remoteIdentRaw?: Buffer | string } })._protocol?._remoteIdentRaw
  const observed = (): Observed => ({ sshServerVersion: ident ? String(ident).trim() : undefined, banner, tail: raw.tail, quietMs: Date.now() - lastOut, idleMs: 1e9 })
  const sent: string[] = []
  const send = raw.send
  raw.send = (d: string) => (sent.push(d), send(d))
  const events: PlatformEvent[] = []
  const audit: AuditEntry[] = []
  const host: DetectHost = {
    async evidence(_tab, waitMs) {
      const until = Date.now() + waitMs
      while (!idleAtPrompt(observed()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      return { atPrompt: idleAtPrompt(observed()), ...evidenceOf(observed()) }
    },
    async probe(_tab, command, covers, opts): Promise<ExecResultMsg> {
      const refusal = probeRefusal(command, covers, observed())
      if (refusal) return { status: 'error', output: '', durationMs: 0, bytes: 0, error: refusal }
      return execute(raw as never, 'auto', command, { ...opts, allowConfig: false })
    },
    notify: (_t, _c, e) => events.push(e as PlatformEvent),
    tabsOf: () => [],
    get: () => undefined
  }
  return { host, events, audit, sent, client, observed }
}

function detector(host: DetectHost, audit: AuditEntry[], saved: { p?: PlatformId; d?: PlatformDetection }) {
  return new PlatformDetector({
    host,
    audit: { append: (e: AuditEntry) => audit.push(e) } as never,
    settings: () => ({ commandTimeoutMs: 8000, outputCapBytes: 256 * 1024 }),
    promptWaitMs: 8000,
    save: (s: Session, p, d) => ((saved.p = p), (saved.d = d), { ...s, platform: p, detected: d })
  })
}

describe('auto-detect against every simulated platform', () => {
  it.each(Object.entries(EXPECT) as [SimPlatform, PlatformId | 'unknown'][])('%s → %s', async (sim, want) => {
    const s = await startSim({ device: makeDevice(sim), port: 0 })
    sims.push(s)
    const h = await hostFor(s.port)
    const saved: { p?: PlatformId; d?: PlatformDetection } = {}
    const fp = await detector(h.host, h.audit, saved).detect({ tabId: 'tab-1', session: { id: 's1', name: 'dev', host: '127.0.0.1', platform: 'auto' } as Session })
    expect(fp.platform).toBe(want)
    // At most two probes, each a read-only version command, each audited as the app's own.
    expect(h.audit.length).toBeLessThanOrEqual(2)
    for (const a of h.audit) expect(a).toMatchObject({ source: 'app', kind: 'read', reason: expect.stringMatching(/^auto-detect/) })
    // Only the probe, plus the pager keys it took to page through the output.
    expect(h.sent.join('')).toMatch(/^((show|display|get) (version|sysinfo|system (info|status))\r[ q]*)*$/)
    if (want === 'unknown') expect(h.events.at(-1)).toMatchObject({ state: 'unknown' })
    else {
      expect(saved.p).toBe(want)
      expect(h.events.at(-1)).toMatchObject({ state: 'detected', platform: want })
    }
    h.client.end()
  }, 30_000)
})

describe('re-arming', () => {
  it('says unknown while a console waits, then identifies it once a prompt appears (sending nothing before)', async () => {
    const tab = { tabId: 't', session: { id: 's', name: 'x', host: 'h', platform: 'auto' } as Session }
    const seen = [
      { atPrompt: false, connected: true, key: 'k1', prompt: 'Press RETURN to get started.' },
      { atPrompt: true, connected: true, key: 'k2', prompt: 'r1#', sshServerVersion: 'SSH-2.0-Cisco-1.25' }
    ]
    const afters: (string | undefined)[] = []
    const probes: string[] = []
    const events: PlatformEvent[] = []
    const saved: { p?: PlatformId } = {}
    const d = new PlatformDetector({
      host: {
        evidence: async (_t, _ms, after) => (afters.push(after), seen.shift()!),
        probe: async (_t, command) => (probes.push(command), { status: 'ok', output: 'Cisco IOS XE Software, Version 17.09.04a\nCisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a', durationMs: 1, bytes: 1 }),
        notify: (_t, _c, e) => events.push(e as PlatformEvent),
        tabsOf: () => [],
        get: () => tab
      },
      audit: { append: () => {} } as never,
      settings: () => ({ commandTimeoutMs: 1000, outputCapBytes: 1024 }),
      save: (s, p) => ((saved.p = p), { ...s, platform: p })
    })
    const fp = await d.detect(tab)
    expect(afters).toEqual([undefined, 'k1'])
    expect(events.map((e) => e.state)).toEqual(['detecting', 'unknown', 'detecting', 'detected'])
    expect(fp.platform).toBe('iosxe')
    expect(saved.p).toBe('iosxe')
    expect(probes).toEqual(['show version'])
  })

  it('stops watching when the connection drops or the user sets the platform', async () => {
    const tab = { tabId: 't', session: { id: 's', name: 'x', host: 'h', platform: 'auto' } as Session }
    for (const [connected, now] of [[false, tab], [true, { ...tab, session: { ...tab.session, platform: 'eos' } }], [true, undefined]] as const) {
      let calls = 0
      const d = new PlatformDetector({
        host: { evidence: async () => (calls++, { atPrompt: false, connected, key: 'k' }), probe: async () => { throw new Error('no probe') }, notify: () => {}, tabsOf: () => [], get: () => now as never },
        audit: { append: () => {} } as never,
        settings: () => ({ commandTimeoutMs: 1000, outputCapBytes: 1024 }),
        save: () => undefined
      })
      expect((await d.detect(tab)).platform).toBe('unknown')
      expect(calls).toBe(1)
    }
  })
})

describe('never types on a device that is not at a prompt', () => {
  let srv: Server
  afterAll(() => srv?.close())

  const quiet = (tail: string): Observed => ({ banner: '', tail, quietMs: 5000, idleMs: 5000 })

  it.each(['Username: ', 'Password: ', 'login as: ', ' --More-- ', 'Proceed with reload? [confirm]', 'Connecting...', ''])('%j: no probe', (tail) => {
    expect(idleAtPrompt(quiet(`banner\r\n${tail}`))).toBe(false)
    expect(probeRefusal('show version', ['iosxe'], quiet(`banner\r\n${tail}`))).toMatch(/not idle at a prompt/)
  })

  it('a busy device or a typing user: no probe', () => {
    expect(idleAtPrompt({ banner: '', tail: 'r1#', quietMs: 100, idleMs: 5000 })).toBe(false)
    expect(idleAtPrompt({ banner: '', tail: 'r1#', quietMs: 5000, idleMs: 200 })).toBe(false)
    expect(idleAtPrompt({ banner: '', tail: 'r1#sh', quietMs: 5000, idleMs: 5000 })).toBe(false)
    expect(idleAtPrompt(quiet('r1#'))).toBe(true)
  })

  it('stops waiting on a device that settled on something else, but waits for a login', () => {
    expect(settled(quiet('r1#'))).toBe('prompt')
    expect(settled(quiet('[admin@mt-br1] > '))).toBe('other')
    expect(settled(quiet('Password: '))).toBeNull()
    expect(settled(quiet('Username: '))).toBeNull()
    expect(settled({ banner: '', tail: '[admin@mt-br1] > ', quietMs: 500, idleMs: 5000 })).toBeNull()
  })

  it('the host accepts only a version probe, read-only on every candidate', () => {
    expect(probeRefusal('show version', ['iosxe', 'eos'], quiet('r1#'))).toBeNull()
    expect(probeRefusal('reload', ['iosxe'], quiet('r1#'))).toMatch(/not the probe/)
    expect(probeRefusal('show running-config', ['iosxe'], quiet('r1#'))).toMatch(/not the probe/)
    expect(probeRefusal('show version', [], quiet('r1#'))).toMatch(/candidate/)
    // `get system status` is FortiOS's probe, but not read-only on IOS.
    expect(probeRefusal('get system status', ['fortios', 'iosxe'], quiet('r1#'))).toMatch(/not read-only on iosxe|not the probe/)
  })

  it('a raw server sitting at Password: receives zero bytes', async () => {
    let received = 0
    srv = createServer((c) => {
      c.write('User Access Verification\r\n\r\nPassword: ')
      c.on('data', (b) => (received += b.length))
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const { Socket } = await import('node:net')
    const sock = new Socket()
    await new Promise<void>((r) => sock.connect((srv.address() as { port: number }).port, '127.0.0.1', r))
    let tail = ''
    let last = Date.now()
    sock.on('data', (b) => ((tail += b.toString()), (last = Date.now())))
    const sent: string[] = []
    const raw = { tabId: 't', connected: true, tail: '', lock: null, addTap: () => () => {}, send: (d: string) => (sent.push(d), sock.write(d)) }
    const observed = (): Observed => ({ banner: tail, tail, quietMs: Date.now() - last, idleMs: 1e9 })
    const audit: AuditEntry[] = []
    const events: PlatformEvent[] = []
    const d = new PlatformDetector({
      host: {
        evidence: async (_t, ms) => {
          await new Promise((r) => setTimeout(r, ms))
          return { atPrompt: idleAtPrompt(observed()), ...evidenceOf(observed()) }
        },
        probe: async () => {
          raw.send('show version\r')
          return { status: 'ok', output: '', durationMs: 0, bytes: 0 }
        },
        notify: (_t, _c, e) => events.push(e as PlatformEvent),
        tabsOf: () => [],
        get: () => undefined
      },
      audit: { append: (e: AuditEntry) => audit.push(e) } as never,
      settings: () => ({ commandTimeoutMs: 1000, outputCapBytes: 1024 }),
      promptWaitMs: 1200,
      save: () => {
        throw new Error('must not save')
      }
    })
    const fp = await d.detect({ tabId: 't', session: { id: 's', name: 'x', host: 'h', platform: 'auto' } as Session })
    await new Promise((r) => setTimeout(r, 100))
    expect(fp.platform).toBe('unknown')
    expect(sent).toEqual([])
    expect(received).toBe(0)
    expect(audit).toEqual([])
    expect(events.at(-1)).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/prompt/) })
    sock.destroy()
  })
})
