/**
 * Session host: an Electron utilityProcess that owns every device connection.
 *
 * - Main sends control messages (open/close/exec) over parentPort.
 * - Each tab's renderer talks to its HostTab directly over a MessagePort (keystrokes, output, acks).
 * - Writes that don't come from the user's keyboard (the agent) need a verdict token signed by
 *   main's guard, and are re-checked against the deny-list here before anything reaches a device.
 */
import type { MessagePortMain } from 'electron'
import type { AuthSpec, HostAsk, HostToMain, MainToHost, OpenSpec } from '@shared/host-protocol'
import { verify } from '@shared/verdict'
import { detectPrompt, execute } from './executor'
import { RawTcpTransport, SerialTransport, SshTransport, TelnetTransport, listSerialPorts, type Prompter, type SshAuth } from '@hopline/transports'
import { SERIAL_DEFAULTS } from '@shared/types'
import { HostTab, type TabPort } from './tab'
import { bindingRefusal, hostExpanded, hostRefusal, netRefusal, policyRefusal, readOnlyRefusal } from './guard-check'
import { completesOnSpace } from '@shared/cli'
import { evidenceOf, probeRefusal, screenKey, settled } from './detect'

interface ParentPort {
  on(event: 'message', fn: (e: { data: MainToHost; ports: MessagePortMain[] }) => void): void
  postMessage(msg: HostToMain): void
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort

let key = ''
/** The team policy's extra blocked commands, from main at init (docs/POLICY.md). */
let policyRules: Record<string, string[]> = {}
/** Verdict nonces already used (until they expire): a token runs at most once. */
const usedNonces = new Map<string, number>()
const tabs = new Map<string, HostTab>()
const execs = new Map<number, AbortController>()
const asks = new Map<number, (v: unknown) => void>()
let askSeq = 0
/** Running transfers → their tab, to route xfer-data/ack/cancel. */
const xferTabs = new Map<string, string>()
const xferFiles = (xferId: string) => {
  const tabId = xferTabs.get(xferId)
  return tabId ? tabs.get(tabId)?.files : undefined
}

const send = (m: HostToMain) => parent.postMessage(m)
const ok = (id: number, value?: unknown) => send({ t: 'res', id, ok: true, value })
const err = (id: number, e: unknown) => send({ t: 'res', id, ok: false, error: e instanceof Error ? e.message : String(e) })

function ask<T>(tabId: string, q: HostAsk): Promise<T> {
  const id = ++askSeq
  return new Promise<T>((resolve) => {
    asks.set(id, resolve as (v: unknown) => void)
    send({ t: 'ask', id, tabId, q })
  })
}

function makeTransport(spec: OpenSpec, password: string | undefined, notice: (t: string) => void) {
  const s = spec.session
  if (s.protocol === 'serial') {
    const o = { ...SERIAL_DEFAULTS, ...s.options.serial }
    notice(`Opening ${s.host} at ${o.baudRate} ${o.dataBits}${o.parity[0]!.toUpperCase()}${o.stopBits}, flow ${o.flow}`)
    return new SerialTransport({ path: s.host, ...o })
  }
  if (s.protocol === 'telnet') return new TelnetTransport({ host: s.host, port: s.port, size: { cols: spec.cols, rows: spec.rows } })
  if (s.protocol === 'raw') return new RawTcpTransport({ host: s.host, port: s.port })
  const verifyHostKey = async (k: { host: string; port: number; fingerprint: string }) => {
    const r = await ask<{ accept: boolean; notice?: string }>(spec.tabId, { kind: 'host-key', host: k.host, port: k.port, fingerprint: k.fingerprint })
    if (r.notice) notice(k.host === s.host ? r.notice : `${k.host}: ${r.notice}`)
    return r.accept ? ('accept' as const) : ('reject' as const)
  }
  // SSH announces "<hop>: login prompt (keyboard-interactive)" right before each round: name the hop.
  let promptHop = s.name
  const prompter: Prompter = {
    keyboardInteractive: (round) =>
      ask<string[] | null>(spec.tabId, { kind: 'keyboard-interactive', host: s.host, ...round, name: round.name || `Sign in to ${promptHop}` }),
    secret: async ({ kind, label, retry }) => {
      // Labels end with "user@host": attribute the prompt to the right hop.
      const host = /@([^\s@]+)$/.exec(label)?.[1] ?? s.host
      const v = await ask<string | null>(spec.tabId, { kind: 'secret', host, secret: kind, label, ...(retry ? { retry } : {}) })
      // Keep a typed target password for automatic reconnects (session host memory only).
      if (typeof v === 'string' && kind === 'password' && host === s.host) spec.auth.password = v
      return v
    }
  }
  const o = s.options.ssh ?? {}
  const t = new SshTransport({
    host: s.host,
    port: s.port,
    username: spec.auth.username,
    auth: sshAuth({ ...spec.auth, password }),
    jump: spec.jump?.map((j) => ({ host: j.host, port: j.port, username: j.username, label: j.label, auth: sshAuth(j.auth) })),
    keepAliveSec: spec.settings.keepAliveSec,
    size: { cols: spec.cols, rows: spec.rows },
    verifyHostKey,
    prompter,
    // Background connections (multi-device runs, backups, fleet) never forward the user's agent:
    // nobody watches them, and reads never need it (P8 D-L8).
    agentForward: spec.background ? false : o.agentForward,
    legacyAlgorithms: o.legacyAlgorithms ?? true,
    label: s.name
  })
  t.on('notice', (text: string) => {
    const m = /^(.*?): login prompt/.exec(text)
    if (m) promptHop = m[1]!.replace(/\s*\(.*\)$/, '')
  })
  return t
}

function sshAuth(a: AuthSpec): SshAuth {
  if (a.privateKey) return { type: 'key', privateKey: a.privateKey, passphrase: a.passphrase, password: a.password }
  if (a.useAgent) return { type: 'agent', password: a.password }
  if (a.password) return { type: 'password', password: a.password }
  return { type: 'interactive' }
}

async function handle(m: MainToHost, ports: MessagePortMain[]): Promise<void> {
  switch (m.t) {
    case 'init':
      key = m.key
      policyRules = m.blocked ?? {}
      return
    case 'reply':
      asks.get(m.id)?.(m.value)
      asks.delete(m.id)
      return
    case 'open': {
      if (tabs.has(m.spec.tabId)) return err(m.id, new Error('tab already open'))
      const tab = new HostTab(m.spec, { state: (info) => send({ t: 'state', info }), makeTransport, post: send })
      tabs.set(m.spec.tabId, tab)
      if (m.spec.deferConnect) {
        tab.idle(m.spec.deferConnect)
        return ok(m.id, tab.info())
      }
      try {
        await tab.connect()
      } catch {
        // State is 'down' with a reason; the tab stays so the user can read why and press Enter.
      }
      return ok(m.id, tab.info())
    }
    case 'port': {
      const port = ports[0]
      const tab = tabs.get(m.tabId)
      if (!port) return
      if (!tab) return port.close()
      tab.attach(port as unknown as TabPort)
      return
    }
    case 'close':
      tabs.get(m.tabId)?.dispose()
      tabs.delete(m.tabId)
      return
    case 'reconnect': {
      const tab = tabs.get(m.tabId)
      if (!tab) return err(m.id, new Error('no such tab'))
      try {
        await tab.reconnect(m.password)
      } catch {
        /* reported through state */
      }
      return ok(m.id, tab.info())
    }
    case 'mode': {
      const tab = tabs.get(m.tabId)
      return ok(m.id, tab ? detectPrompt(tab.tail, m.platform).mode : 'unknown')
    }
    case 'prompt': {
      const tab = tabs.get(m.tabId)
      const p = tab ? detectPrompt(tab.tail, m.platform) : null
      return ok(m.id, p ? { mode: p.mode, prompt: p.prompt, hostname: p.hostname } : { mode: 'unknown', prompt: '', hostname: '' })
    }
    case 'evidence': {
      // Wait (bounded) until the device is idle at a prompt; report what was observed. Sends nothing.
      const tab = tabs.get(m.tabId)
      if (!tab) return err(m.id, new Error('no such tab'))
      // `after`: what the screen looked like last time; wait for something new before answering again.
      const until = Date.now() + Math.min(Math.max(m.waitMs, 0), 120_000)
      for (;;) {
        const o = tab.observed()
        const key = screenKey(o)
        const fresh = m.after === undefined || key !== m.after
        const state = fresh ? settled(o) : null
        const atPrompt = tab.connected && !tab.lock && state === 'prompt'
        if (atPrompt || state === 'other' || Date.now() >= until || !tab.connected) return ok(m.id, { atPrompt, connected: tab.connected, key, ...evidenceOf(o) })
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    case 'exec': {
      const { spec } = m
      const tab = tabs.get(spec.tabId)
      if (!tab) return err(m.id, new Error('no such tab'))
      // Second enforcement point: authentic verdict for exactly this command, and never a deny-listed one.
      const v = key ? verify(key, spec.token, spec.tabId, spec.command) : null
      if (!v || v.kind !== spec.kind) return err(m.id, new Error('refused by session host: missing or invalid guard verdict'))
      const now = Date.now()
      for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n)
      if (usedNonces.has(v.nonce)) return err(m.id, new Error('refused by session host: verdict already used'))
      usedNonces.set(v.nonce, v.exp)
      // Read-only mode was on when main signed: only reads (review Low 5).
      const ro = readOnlyRefusal(spec.kind, v.readOnly)
      if (ro) return err(m.id, new Error(ro))
      // The platform main classified for (detection or an edit may have changed it since the tab opened).
      const platform = v.platform
      // The team policy's deny-list, checked here again (main refuses before signing).
      const denied = policyRefusal(policyRules, platform, spec.command, v.probe)
      if (denied) return err(m.id, new Error(denied))
      // An unidentified device takes one thing only: the auto-detect probe, checked here again.
      // Otherwise read commands only run from exec mode, and config lines are classified in the
      // mode the device prompt shows (interface, router, ...), or against every config mode.
      const refusal =
        platform === 'auto'
          ? spec.kind === 'read'
            ? probeRefusal(spec.command, v.probe, tab.observed())
            : 'refused by session host: the device platform is not known'
          : v.net
            ? netRefusal(spec.command, platform, spec.kind, tab.tail, v.hosts)
            : (bindingRefusal(spec.kind, v.hosts) ?? hostRefusal(spec.command, platform, spec.kind, tab.tail, v.ack, v.hosts))
      if (refusal) return err(m.id, new Error(refusal))
      const ctrl = new AbortController()
      execs.set(m.id, ctrl)
      try {
        const r = await execute(tab, platform, spec.command, {
          ...(platform !== 'auto' && completesOnSpace(platform) ? { expanded: hostExpanded(spec.command, platform, spec.kind, tab.tail) } : {}),
          timeoutMs: spec.timeoutMs,
          capBytes: spec.capBytes,
          allowConfig: spec.kind !== 'read' && spec.allowConfig,
          signal: ctrl.signal
        })
        return ok(m.id, r)
      } finally {
        execs.delete(m.id)
      }
    }
    case 'serial-list':
      return ok(m.id, (await listSerialPorts()).map(({ path, label, manufacturer, serialNumber, isUsb }) => ({ path, label, manufacturer, serialNumber, isUsb })))
    case 'exec-cancel':
      execs.get(m.id)?.abort()
      return
    // ---- files and forwards (session-host/files.ts, @hopline/transports forward.ts)
    case 'files': {
      const files = tabs.get(m.tabId)?.files
      if (!files) return err(m.id, new Error('Files need an SSH session'))
      if (m.op.op === 'scp-directory') return ok(m.id, await files.listDirectory(m.op.path, m.op.platform, policyRules))
      if (m.op.op === 'preview') return ok(m.id, await files.preview(m.op.path, m.op.platform))
      return ok(m.id, m.op.op === 'open' ? await files.open() : await files.op(m.op))
    }
    case 'xfer': {
      const tab = tabs.get(m.tabId)
      if (!tab?.files) return err(m.id, new Error('Files need an SSH session'))
      xferTabs.set(m.spec.xferId, tab.tabId)
      try {
        return ok(m.id, await tab.files.xfer(m.spec))
      } finally {
        xferTabs.delete(m.spec.xferId)
      }
    }
    case 'xfer-data':
      return xferFiles(m.xferId)?.data(m.xferId, m.d)
    case 'xfer-end':
      return xferFiles(m.xferId)?.end(m.xferId)
    case 'xfer-ack':
      return xferFiles(m.xferId)?.ack(m.xferId, m.n)
    case 'xfer-cancel':
      return xferFiles(m.xferId)?.cancel(m.xferId)
    case 'fwd': {
      const fw = tabs.get(m.tabId)?.forwards
      if (!fw) return err(m.id, new Error('Port forwarding needs an SSH session'))
      const op = m.op
      if (op.op === 'start') return ok(m.id, await fw.start(op.spec))
      if (op.op === 'stop') return ok(m.id, await fw.stop(op.fid))
      if (op.op === 'remove') return ok(m.id, await fw.remove(op.fid))
      return ok(m.id, fw.list())
    }
    case 'shutdown':
      for (const t of tabs.values()) t.dispose()
      tabs.clear()
      setTimeout(() => process.exit(0), 50)
      return
  }
}

// One bad stream or callback must not take every device connection down with it.
process.on('uncaughtException', (e) => console.error('[session-host] uncaught exception (continuing):', e))
process.on('unhandledRejection', (e) => console.error('[session-host] unhandled rejection (continuing):', e))

parent.on('message', (e) => {
  handle(e.data, e.ports).catch((x) => {
    const id = (e.data as { id?: number }).id
    if (typeof id === 'number') err(id, x)
  })
})
send({ t: 'ready' })
