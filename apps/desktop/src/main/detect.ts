import { classify, fingerprint, probeCommand, type Evidence, type Fingerprint } from '@hopline/guard'
import type { PlatformId } from '@hopline/cli-model'
import type { ExecResultMsg, ObservedEvidence } from '@shared/host-protocol'
import type { PlatformDetection, PlatformEvent, Session } from '@shared/types'
import type { AuditLog } from './db/audit'
import type { AgentTab, ExecOpts } from './host/client'

/**
 * F8 auto-detect. When a session still on Auto-detect reaches its device:
 *  1. wait (bounded) until the device is idle at a prompt, and fingerprint what was observed
 *     without sending anything: the SSH identification line, the login banner, the prompt;
 *  2. unless that alone is decisive (version text), run the cli-model probe (the platform's own
 *     version command) through the guard as an audited read with source "app", at most twice;
 *  3. store the platform on the session and tell the window, or report "unknown", which keeps
 *     the guard denying every AI command on it.
 * Nothing is ever sent to a device that is not idle at a prompt (the session host checks again).
 */

export interface DetectHost {
  evidence(tab: AgentTab, waitMs: number, after?: string): Promise<ObservedEvidence>
  /** The tab as main knows it now (undefined once closed). */
  get(tabId: string): AgentTab | undefined
  probe(tab: AgentTab, command: string, covers: PlatformId[], opts: ExecOpts): Promise<ExecResultMsg>
  notify(tabId: string, channel: string, payload: unknown): void
  tabsOf(sessionId: string): AgentTab[]
}

export interface DetectDeps {
  host: DetectHost
  audit: AuditLog
  /** Store the detected platform (DB row or quick-connect record); returns the updated session. */
  save(session: Session, platform: PlatformId, detection: PlatformDetection): Session | undefined
  settings: () => { commandTimeoutMs: number; outputCapBytes: number }
  /** How long to wait for the first prompt (logins on slow consoles take a while). */
  promptWaitMs?: number
}

/** Version text is decisive; prompt shapes and SSH strings alone are not (IOS vs IOS-XE). */
const DECISIVE = 0.9
const MAX_PROBES = 2

export class PlatformDetector {
  private running = new Set<string>()

  constructor(private readonly d: DetectDeps) {}

  /** Start detection for a tab (once at a time per tab). */
  onConnected(tab: AgentTab): void {
    if (tab.session.platform !== 'auto' || this.running.has(tab.tabId)) return
    this.running.add(tab.tabId)
    void this.detect(tab)
      .catch((e: unknown) => this.emit(tab, { state: 'unknown', reason: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.running.delete(tab.tabId))
  }

  private emit(tab: AgentTab, e: Omit<PlatformEvent, 'tabId' | 'sessionId'>): void {
    // Every open tab of the session learns the result (the same device in two panes).
    const tabs = e.state === 'detecting' ? [tab] : this.d.host.tabsOf(tab.session.id)
    for (const t of tabs.length ? tabs : [tab]) this.d.host.notify(t.tabId, 'term:platform', { ...e, tabId: t.tabId, sessionId: tab.session.id } satisfies PlatformEvent)
  }

  async detect(tab: AgentTab): Promise<Fingerprint> {
    this.emit(tab, { state: 'detecting' })
    const wait = this.d.promptWaitMs ?? 60_000
    let seen = await this.d.host.evidence(tab, wait)
    let ev: Evidence = { sshServerVersion: seen.sshServerVersion, banner: seen.banner, prompt: seen.prompt }
    let fp = fingerprint(ev)
    // Never probe a device that is not at a prompt. Decide on what was seen if that is decisive;
    // otherwise say "unknown" and keep watching (sending nothing) while the tab stays connected and
    // on Auto-detect: a console at "Press RETURN", a slow login or a user typing through the wait
    // reaches a prompt later.
    let said = false
    while (!seen.atPrompt) {
      if (fp.confidence >= DECISIVE) return this.finish(tab, fp, '')
      if (!said) this.finish(tab, { ...fp, platform: 'unknown' }, 'the device has not shown a prompt Hopline recognises')
      said = true
      const now = this.d.host.get(tab.tabId)
      if (seen.connected === false || !now || now.session.platform !== 'auto') return { ...fp, platform: 'unknown' }
      seen = await this.d.host.evidence(tab, wait, seen.key)
      ev = { sshServerVersion: seen.sshServerVersion, banner: seen.banner, prompt: seen.prompt }
      fp = fingerprint(ev)
    }
    if (said) this.emit(tab, { state: 'detecting' })
    const base = { sessionId: tab.session.id, sessionName: tab.session.name, host: tab.session.host, source: 'app' as const, approver: null }
    let candidates: PlatformId[] | null = null
    for (let i = 0; i < MAX_PROBES && (fp.platform === 'unknown' || fp.confidence < DECISIVE); i++) {
      const probe = probeCommand(candidates ? { platform: 'unknown', confidence: 0, evidence: [], candidates: candidates.map((platform) => ({ platform, score: 1 })) } : fp)
      // The guard decides: the probe must be read-only on every platform it is sent for.
      const covers = probe.covers.filter((p) => classify(probe.command, p).kind === 'read')
      if (!covers.length) break
      const s = this.d.settings()
      const r = await this.d.host.probe(tab, probe.command, covers, { timeoutMs: Math.min(s.commandTimeoutMs, 15_000), capBytes: Math.min(s.outputCapBytes, 64 * 1024) })
      this.d.audit.append({
        ...base,
        command: probe.command,
        kind: 'read',
        decision: r.status === 'ok' ? 'executed' : r.status,
        reason: r.error ? `auto-detect: ${r.error}` : `auto-detect (read-only on ${covers.join(', ')})`,
        durationMs: r.durationMs,
        bytes: r.bytes,
        redactions: null
      })
      if (r.status !== 'ok') break
      fp = fingerprint({ ...ev, showVersion: r.output })
      if (fp.platform !== 'unknown') break
      // The output did not tell: try once more for the candidates this probe did not cover.
      if (!probe.others.length) break
      candidates = probe.others
    }
    return this.finish(tab, fp, 'the version output did not match a modelled platform')
  }

  private finish(tab: AgentTab, fp: Fingerprint, why: string): Fingerprint {
    if (fp.platform === 'unknown') {
      this.emit(tab, { state: 'unknown', reason: why })
      return fp
    }
    const detection: PlatformDetection = { confidence: fp.confidence, at: Date.now(), ...(fp.version ? { version: fp.version } : {}), ...(fp.model ? { model: fp.model } : {}) }
    const saved = this.d.save(tab.session, fp.platform, detection)
    // Gone, or the user set a platform meanwhile: their choice stands, and there is nothing to announce.
    if (!saved || saved.platform !== fp.platform) return fp
    this.emit(tab, { state: 'detected', platform: fp.platform, version: fp.version, model: fp.model })
    return fp
  }
}
