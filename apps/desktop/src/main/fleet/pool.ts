import type { Session } from '@shared/types'
import type { AgentTab } from '../host/client'

/**
 * Background tabs for fleet lanes, with concurrency limits (FLEET-AGENT §3.2, §4.1).
 *
 * The connection itself is the session host's existing background connection
 * (`SessionHostClient.openBackground`, the one multi-device runs and backups use: no window, stored
 * credentials only, no prompts, no auto-reconnect, a changed host key refused, idle at a prompt
 * before it resolves). This pool only decides *when* one may open:
 * - at most `concurrency` background tabs at once for the run (1–8);
 * - at most `PER_JUMP_LIMIT` at once through the same jump host, app-wide (every pool, every run and
 *   scope walk shares one limit per jump host: ssh2 multiplexes, slow jump hosts choke).
 * The jump slot is taken before the pool slot, so a lane waiting for a busy jump host does not hold
 * one of the run's slots meanwhile.
 * Every tab it opens is closed by `release`, which the caller runs in a `finally`.
 */

export const PER_JUMP_LIMIT = 2
export const MAX_FLEET_CONCURRENCY = 8

export interface BackgroundHost {
  openBackground(sessionId: string, signal?: AbortSignal): Promise<AgentTab>
  close(tabId: string): void
}

/** A counting semaphore whose waits can be abandoned by a signal. */
export class Semaphore {
  private used = 0
  private waiters: (() => void)[] = []
  constructor(private readonly size: number) {}

  get inUse(): number {
    return this.used
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('stopped')
    if (this.used >= this.size) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', stop)
          resolve()
        }
        const stop = () => {
          this.waiters = this.waiters.filter((w) => w !== go)
          reject(new Error('stopped'))
        }
        this.waiters.push(go)
        signal?.addEventListener('abort', stop, { once: true })
      })
    } else this.used++
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      // Hand the slot straight to the next waiter (the count stays the same).
      if (next) next()
      else this.used--
    }
  }
}

export interface Lease {
  tab: AgentTab
  release: () => void
}

/** One semaphore per jump host, shared by every pool in the process. */
const JUMPS = new Map<string, Semaphore>()

export class LanePool {
  private readonly all: Semaphore
  /** Tabs this pool opened and has not closed (for tests and a last-resort `closeAll`). */
  private readonly open = new Set<string>()
  private peak = 0

  constructor(
    private readonly host: BackgroundHost,
    readonly concurrency: number
  ) {
    this.all = new Semaphore(clampConcurrency(concurrency))
  }

  /** Most background tabs this pool had open at once. */
  get maxOpen(): number {
    return this.peak
  }

  get openCount(): number {
    return this.open.size
  }

  /** The first jump host of an SSH session, the key it shares a limit under. */
  static jumpOf(s: Session): string | null {
    return s.protocol === 'ssh' ? (s.options.ssh?.jump?.[0] ?? null) : null
  }

  /** Wait for a slot (and a jump-host slot), then connect in the background. */
  async acquire(session: Session, signal?: AbortSignal, onConnecting?: () => void): Promise<Lease> {
    const jump = LanePool.jumpOf(session)
    let freeJump: (() => void) | undefined
    if (jump) {
      let s = JUMPS.get(jump)
      if (!s) JUMPS.set(jump, (s = new Semaphore(PER_JUMP_LIMIT)))
      freeJump = await s.acquire(signal)
    }
    let freeAll: () => void
    try {
      freeAll = await this.all.acquire(signal)
    } catch (e) {
      freeJump?.()
      throw e
    }
    try {
      onConnecting?.()
      const tab = await this.host.openBackground(session.id, signal)
      this.open.add(tab.tabId)
      this.peak = Math.max(this.peak, this.open.size)
      let done = false
      return {
        tab,
        release: () => {
          if (done) return
          done = true
          this.open.delete(tab.tabId)
          try {
            this.host.close(tab.tabId)
          } finally {
            freeJump?.()
            freeAll()
          }
        }
      }
    } catch (e) {
      freeJump?.()
      freeAll()
      throw e
    }
  }

  /** Close anything still open (a run that ended abnormally). */
  closeAll(): void {
    for (const id of [...this.open]) {
      this.open.delete(id)
      this.host.close(id)
    }
  }
}

export function clampConcurrency(n: number | undefined, fallback = 4): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 1) return fallback
  return Math.min(v, MAX_FLEET_CONCURRENCY)
}
