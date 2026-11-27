import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { Forwards, listenHost } from '@hopline/transports'
import type { AuditEntry } from '../src/main/db/audit'
import type { FilesHost } from '../src/main/files/service'
import { ForwardService } from '../src/main/files/forwards'
import { startsOnConnect, type ForwardSpec } from '@shared/files'
import type { MainToHost } from '@shared/host-protocol'
import type { Session } from '@shared/types'

// Phase 4 fix-round review F1, F2, F3.

const reach = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host, port }, () => (s.destroy(), resolve(true)))
    s.on('error', () => resolve(false))
  })

describe('F1/F2: a local listener binds the address the check looked at', () => {
  it('listenHost: brackets dropped, localhost as 127.0.0.1, others unchanged', () => {
    expect(listenHost('[::1]')).toBe('::1')
    expect(listenHost(' localhost ')).toBe('127.0.0.1')
    expect(listenHost('LOCALHOST')).toBe('127.0.0.1')
    expect(listenHost('127.0.0.1')).toBe('127.0.0.1')
    expect(listenHost('::1')).toBe('::1')
    expect(listenHost('0.0.0.0')).toBe('0.0.0.0')
  })
  it('F1: "[::1]" listens on ::1 instead of failing with ENOTFOUND', async () => {
    const fw = new Forwards()
    try {
      const st = await fw.start({ id: 'v6', kind: 'D', bindHost: '[::1]', bindPort: 0 })
      // Hosts without IPv6 loopback fail with EADDRNOTAVAIL, never with a name lookup.
      if (st.state === 'error') expect(st.error ?? '').not.toMatch(/ENOTFOUND|not found|resolve/i)
      else {
        expect(st.state).toBe('waiting')
        expect(await reach('::1', st.boundPort!)).toBe(true)
      }
    } finally {
      await fw.dispose()
    }
  })
  it('F2: "localhost" binds the literal 127.0.0.1 (never what the resolver says)', async () => {
    const fw = new Forwards()
    try {
      const st = await fw.start({ id: 'lh', kind: 'D', bindHost: 'localhost', bindPort: 0 })
      expect(st.state).toBe('waiting')
      expect(await reach('127.0.0.1', st.boundPort!)).toBe(true)
    } finally {
      await fw.dispose()
    }
  })
})

describe('F3: restore and the session host agree on which saved forwards start on connect', () => {
  it('startsOnConnect: auto-start and a loopback bind', () => {
    expect(startsOnConnect({ bindHost: '127.0.0.1' })).toBe(true)
    expect(startsOnConnect({ bindHost: '127.0.0.1', autoStart: false })).toBe(false)
    expect(startsOnConnect({ bindHost: '0.0.0.0' })).toBe(false)
    expect(startsOnConnect({ bindHost: '192.168.1.20', autoStart: true })).toBe(false)
  })
  it('a saved auto-start forward on a LAN address that the user started by hand is restored after a host restart', async () => {
    const forwards: ForwardSpec[] = [
      { id: 'lan', kind: 'D', bindHost: '192.168.1.20', bindPort: 1080 },
      { id: 'lo', kind: 'D', bindHost: '127.0.0.1', bindPort: 1081 }
    ]
    const session = { id: 's1', name: 'r1', host: '10.0.0.1', protocol: 'ssh', options: { ssh: { forwards } } } as unknown as Session
    const wc = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
    const requests: MainToHost[] = []
    const host: FilesHost = {
      owned: (tabId) => (tabId === 'tab1' ? { session, wc } : undefined),
      background: () => undefined,
      request: <T,>(build: (id: number) => MainToHost) => {
        const m = build(1)
        requests.push(m)
        return Promise.resolve({ spec: (m as { op?: { spec?: ForwardSpec } }).op?.spec, state: 'listening', active: 0, total: 0, bytesIn: 0, bytesOut: 0 } as T)
      },
      send: () => {},
      onHostMessage: () => () => {}
    }
    const audit: AuditEntry[] = []
    const svc = new ForwardService(host, { append: (e) => audit.push(e) })
    await svc.start('tab1', wc, 'lan')
    await svc.start('tab1', wc, 'lo')
    requests.length = 0
    svc.restore('tab1')
    // The LAN one does not start by itself in the host, so main restores it; the loopback one comes back on its own.
    const started = requests.map((r) => (r as { op: { spec: ForwardSpec } }).op.spec.id)
    expect(started).toEqual(['lan'])
  })
})
