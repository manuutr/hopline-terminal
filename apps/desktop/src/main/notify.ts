/**
 * Desktop notifications: only two things are worth interrupting someone in another window for.
 *
 * - An approval is waiting (the assistant proposed a change and stopped).
 * - A session dropped without the user closing it.
 *
 * Both are opt-out in Settings → Notifications, and both are shown only while no Hopline window
 * has focus (in the window, the approval card and the tab glyph already say it). Clicking one only
 * brings the window forward; it never approves, rejects or reconnects anything.
 *
 * In e2e (dev builds), notifications are recorded instead of shown, so a test run never puts
 * anything on the user's desktop.
 */
import type { Settings } from '@shared/types'

export interface DesktopNote {
  kind: 'approval' | 'disconnect'
  title: string
  body: string
}

export interface NotifierDeps {
  settings: () => Pick<Settings, 'notifyApprovals' | 'notifyDisconnects'>
  /** True while a Hopline window has focus. */
  focused: () => boolean
  /** Show a notification; `onClick` brings the window forward. */
  show: (n: DesktopNote, onClick: () => void) => void
  /** Bring the window forward (from a click). */
  reveal: () => void
  now?: () => number
}

/** One disconnect notice per session per minute: a flapping link must not flood the desktop. */
const DISCONNECT_QUIET_MS = 60_000

export class Notifier {
  private lastDrop = new Map<string, number>()
  private seen = new Set<string>()

  constructor(private readonly d: NotifierDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** The assistant is waiting for a decision on `proposalId` in `sessionName`. */
  approval(proposalId: string, sessionName: string, lines: number, disruptive: boolean): boolean {
    if (!this.d.settings().notifyApprovals || this.d.focused() || this.seen.has(proposalId)) return false
    this.seen.add(proposalId)
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-100))
    const what = disruptive ? 'A disruptive change' : lines === 1 ? 'A change of 1 line' : `A change of ${lines} lines`
    this.d.show({ kind: 'approval', title: `Approval waiting · ${sessionName}`, body: `${what} waits for your approval in Hopline Terminal.` }, () => this.d.reveal())
    return true
  }

  /** `sessionName` dropped on its own (not closed by the user, not a logout). */
  disconnect(sessionId: string, sessionName: string, detail: string | undefined, reconnecting: boolean): boolean {
    if (!this.d.settings().notifyDisconnects || this.d.focused()) return false
    const t = this.now()
    const last = this.lastDrop.get(sessionId)
    if (last !== undefined && t - last < DISCONNECT_QUIET_MS) return false
    this.lastDrop.set(sessionId, t)
    const why = detail?.replace(/;\s*retry in \d+s$/, '').trim()
    this.d.show(
      { kind: 'disconnect', title: `Disconnected · ${sessionName}`, body: `${why ? `${why}. ` : ''}${reconnecting ? 'Reconnecting…' : 'Press Enter in the tab to reconnect.'}` },
      () => this.d.reveal()
    )
    return true
  }
}
