/**
 * Port forwards, in main: which forwards a tab has (saved on the session, or added live from the
 * tab menu), validation, the audit, and status events to the window that owns the tab. The
 * listeners and channels themselves live in the session host (`Forwards` in @hopline/transports),
 * so they survive reconnects; live forwards are kept here too, so a session-host restart brings
 * them back.
 */
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { describeForward, startsOnConnect, type ForwardEvent, type ForwardSpec, type ForwardStatus } from '@shared/files'
import type { Session } from '@shared/types'
import type { AuditEntry } from '../db/audit'
import type { FilesHost } from './service'

export class ForwardService {
  /** Forwards added live, per tab (not saved on the session). */
  private live = new Map<string, ForwardSpec[]>()
  /** Forwards the user wants running, per tab (to restore after a host restart). */
  private wanted = new Map<string, Set<string>>()

  constructor(
    private readonly host: FilesHost,
    private readonly audit: { append(e: AuditEntry): void }
  ) {
    host.onHostMessage((m) => {
      if (m.t !== 'fwd-state') return
      const t = host.owned(m.tabId)
      if (t) this.auditAuto(t.session, m.tabId, m.forwards)
      else this.windowless(m.tabId, m.forwards)
      if (t && !t.wc.isDestroyed()) t.wc.send('forward:event', { tabId: m.tabId, forwards: this.decorate(t.session, m.tabId, m.forwards) } satisfies ForwardEvent)
    })
  }

  /** Last state seen per tab and forward, to audit what the host did on its own. */
  private seen = new Map<string, Map<string, ForwardStatus['state']>>()

  /**
   * Saved forwards start in the session host when the session connects, without a request from
   * main: audit their first start, and any failure (e.g. a remote forward refused after a reconnect).
   */
  private auditAuto(s: Session, tabId: string, list: ForwardStatus[]): void {
    const seen = this.seen.get(tabId) ?? new Map<string, ForwardStatus['state']>()
    this.seen.set(tabId, seen)
    const mine = this.wanted.get(tabId)
    for (const f of list) {
      const prev = seen.get(f.spec.id)
      seen.set(f.spec.id, f.state)
      if (prev === f.state || mine?.has(f.spec.id)) continue
      if (f.state === 'error') this.log(s, f.spec, 'error', f.error ?? 'failed', f.boundPort)
      else if (f.state === 'listening' && (prev === undefined || prev === 'starting')) this.log(s, f.spec, 'executed', `started on connect (saved on the session${f.boundPort !== undefined ? `, port ${f.boundPort}` : ''})`, f.boundPort)
    }
  }

  /**
   * A forward running on a tab with no window (a background connection). The session host never
   * starts one there (OpenSpec.background); if one shows up anyway it is audited and stopped, so
   * nothing listens without a record and a window to see it. So is one on a tab main does not know.
   */
  private windowless(tabId: string, list: ForwardStatus[]): void {
    // A tab main cannot place at all (closed, or from an old host) is treated the same way (review A2).
    const s = this.host.background?.(tabId) ?? ({ id: '', name: `(unknown tab ${tabId.slice(0, 40)})`, host: '', ephemeral: true } as unknown as Session)
    const seen = this.seen.get(tabId) ?? new Map<string, ForwardStatus['state']>()
    this.seen.set(tabId, seen)
    for (const f of list) {
      const prev = seen.get(f.spec.id)
      seen.set(f.spec.id, f.state)
      if (prev === f.state || (f.state !== 'listening' && f.state !== 'starting' && f.state !== 'waiting')) continue
      this.log(s, f.spec, 'error', 'a port forward started on a background connection (no window); stopped', f.boundPort)
      void this.host.request((rid) => ({ t: 'fwd', id: rid, tabId, op: { op: 'stop', fid: f.spec.id } })).catch(() => {})
    }
  }

  private tab(tabId: string, sender: WebContents) {
    const t = this.host.owned(tabId, sender)
    if (!t) throw new Error('That tab is not open')
    if (t.session.protocol !== 'ssh') throw new Error('Port forwarding needs an SSH session')
    return t
  }

  private saved(s: Session): ForwardSpec[] {
    return s.options.ssh?.forwards ?? []
  }

  private specs(s: Session, tabId: string): ForwardSpec[] {
    return [...this.saved(s), ...(this.live.get(tabId) ?? [])]
  }

  /** Every forward of the tab, including saved ones that never started, with their saved flag. */
  private decorate(s: Session, tabId: string, running: ForwardStatus[]): ForwardStatus[] {
    const savedIds = new Set(this.saved(s).map((f) => f.id))
    const byId = new Map(running.map((r) => [r.spec.id, r]))
    const all = this.specs(s, tabId).map((spec): ForwardStatus => {
      const r = byId.get(spec.id)
      return { ...(r ?? { state: 'stopped', active: 0, total: 0, bytesIn: 0, bytesOut: 0 }), spec: { ...spec, ...(r ? { bindHost: r.spec.bindHost } : {}) }, saved: savedIds.has(spec.id) }
    })
    // Forwards the host still runs but that were removed from the session meanwhile.
    for (const r of running) if (!all.some((a) => a.spec.id === r.spec.id)) all.push({ ...r, saved: false })
    return all
  }

  async list(tabId: string, sender: WebContents): Promise<ForwardStatus[]> {
    const t = this.tab(tabId, sender)
    const running = await this.host.request<ForwardStatus[]>((id) => ({ t: 'fwd', id, tabId, op: { op: 'list' } }))
    return this.decorate(t.session, tabId, running)
  }

  async add(tabId: string, sender: WebContents, spec: Omit<ForwardSpec, 'id'>): Promise<ForwardStatus> {
    this.tab(tabId, sender)
    const full: ForwardSpec = { ...spec, id: randomUUID() }
    const list = this.live.get(tabId) ?? []
    if (list.length >= 32) throw new Error('Too many forwards on this tab')
    this.live.set(tabId, [...list, full])
    return this.start(tabId, sender, full.id)
  }

  async start(tabId: string, sender: WebContents, id: string): Promise<ForwardStatus> {
    const t = this.tab(tabId, sender)
    const spec = this.specs(t.session, tabId).find((f) => f.id === id)
    if (!spec) throw new Error('No such forward')
    // Marked before the request: the host's status event may arrive first, and this start is
    // audited here, not as an automatic one.
    const w = this.wanted.get(tabId) ?? new Set()
    w.add(id)
    this.wanted.set(tabId, w)
    const st = await this.host.request<ForwardStatus>((rid) => ({ t: 'fwd', id: rid, tabId, op: { op: 'start', spec } }))
    this.log(t.session, spec, st.state === 'error' ? 'error' : 'executed', st.state === 'error' ? (st.error ?? 'failed') : `started (${st.state}${st.boundPort !== undefined ? `, port ${st.boundPort}` : ''})`, st.boundPort)
    return { ...st, saved: this.saved(t.session).some((f) => f.id === id) }
  }

  async stop(tabId: string, sender: WebContents, id: string): Promise<void> {
    const t = this.tab(tabId, sender)
    await this.host.request((rid) => ({ t: 'fwd', id: rid, tabId, op: { op: 'stop', fid: id } }))
    this.wanted.get(tabId)?.delete(id)
    const spec = this.specs(t.session, tabId).find((f) => f.id === id)
    if (spec) this.log(t.session, spec, 'executed', 'stopped')
  }

  async remove(tabId: string, sender: WebContents, id: string): Promise<void> {
    const t = this.tab(tabId, sender)
    if (this.saved(t.session).some((f) => f.id === id)) throw new Error('This forward is saved on the session: edit the session to remove it')
    await this.host.request((rid) => ({ t: 'fwd', id: rid, tabId, op: { op: 'remove', fid: id } }))
    this.live.set(tabId, (this.live.get(tabId) ?? []).filter((f) => f.id !== id))
    this.wanted.get(tabId)?.delete(id)
  }

  /** The tab was opened again in a restarted session host: start the live forwards that were running. */
  restore(tabId: string): void {
    const t = this.host.owned(tabId)
    if (!t) return
    const savedIds = new Set(this.saved(t.session).filter(startsOnConnect).map((f) => f.id))
    for (const id of this.wanted.get(tabId) ?? []) {
      // Saved auto-start forwards come back on their own.
      if (savedIds.has(id)) continue
      const spec = this.specs(t.session, tabId).find((f) => f.id === id)
      if (spec) void this.host.request((rid) => ({ t: 'fwd', id: rid, tabId, op: { op: 'start', spec } })).catch(() => {})
    }
  }

  /** The tab closed: forget its live forwards. */
  forget(tabId: string): void {
    this.live.delete(tabId)
    this.wanted.delete(tabId)
    this.seen.delete(tabId)
  }

  private log(s: Session, spec: ForwardSpec, decision: 'executed' | 'error', reason: string, port?: number): void {
    this.audit.append({
      sessionId: s.ephemeral ? null : s.id,
      sessionName: s.name,
      host: s.host,
      source: 'forward',
      command: `forward ${describeForward(spec, port)}`,
      kind: spec.kind,
      decision,
      reason,
      approver: 'user',
      durationMs: null,
      bytes: null,
      redactions: null
    })
  }
}
