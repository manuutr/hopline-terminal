import ssh2 from 'ssh2'
import type { Session } from '@shared/types'
import type { TabControl } from '../src/main/host/client'
import { detectPrompt, execute, setDefaultQuietMs, type ExecTarget } from '../src/session-host/executor'

// The simulator answers at once: a short quiet period keeps suites fast (the default is 250 ms;
// executor-quiet.test.ts covers the behaviour with explicit values).
setDefaultQuietMs(40)

type FakeTab = ExecTarget & { tabId: string; session: Session }

/** Minimal stand-in for a session-host tab: an ssh2 shell with a tail buffer and output taps. */
export async function fakeTab(port: number, rows = 24, session?: Partial<Session>) {
  const client = new ssh2.Client()
  const stream = await new Promise<ssh2.ClientChannel>((resolve, reject) => {
    client
      .on('ready', () => client.shell({ rows, cols: 120, term: 'xterm' }, (e, s) => (e ? reject(e) : resolve(s))))
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'admin', password: 'admin' })
  })
  const taps = new Set<(t: string) => void>()
  const tab = {
    tabId: 'tab-1',
    session: { id: 's1', name: 'core-sw1', host: '127.0.0.1', platform: 'iosxe' as const, ...session },
    connected: true,
    tail: '',
    lock: null as ExecTarget['lock'],
    addTap: (fn: (t: string) => void) => (taps.add(fn), () => taps.delete(fn)),
    send: (d: string) => stream.write(d),
    lastOutput: Date.now(),
    observed: () => ({ quietMs: Date.now() - tab.lastOutput })
  }
  stream.on('data', (b: Buffer) => {
    const t = b.toString()
    tab.lastOutput = Date.now()
    tab.tail = (tab.tail + t).slice(-16384)
    for (const f of taps) f(t)
  })
  const idle = async () => {
    for (let i = 0; i < 300 && detectPrompt(tab.tail, tab.session.platform).mode === 'unknown'; i++) await new Promise((r) => setTimeout(r, 10))
  }
  await idle()
  return { tab: tab as unknown as FakeTab, raw: tab, client, stream, idle }
}


/** TabControl that runs commands in-process (what the session host does, minus the process hop). */
export function localControl(tab: FakeTab): TabControl {
  return {
    get: (id) => (id === tab.tabId ? tab : undefined),
    exec: (_t, command, kind, opts) => execute(tab, tab.session.platform, command, { ...opts, allowConfig: kind !== 'read' && opts.allowConfig }),
    mode: async () => detectPrompt(tab.tail, tab.session.platform).mode,
    prompt: async () => {
      const p = detectPrompt(tab.tail, tab.session.platform)
      return { mode: p.mode, prompt: p.prompt, hostname: p.hostname }
    }
  }
}
