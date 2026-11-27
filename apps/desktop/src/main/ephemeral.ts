import { randomUUID } from 'node:crypto'
import type { Session, SessionInput } from '@shared/types'

/**
 * Quick-connect sessions ("admin@10.0.0.1:2222", "telnet://lab-ts1").
 *
 * Why an in-memory registry in main instead of a DB row flagged `ephemeral`:
 * - Main must know the session (the session host only connects what main resolves, and the agent,
 *   host-key and log paths all read the session from main), but nothing else should: a stored row
 *   would show up in every `listSessions` consumer (tree, palette, switcher, launcher, jump-host
 *   picker, future sync/export) unless each of them filtered it out.
 * - A flagged row needs a cleanup sweep after a crash or a kill; memory cleans itself up.
 * - The only touch points are one fallback in `SessionHostClient.open` and release on close.
 * "Save as session" writes the record to the DB under the same id, so the open tab, its port and
 * its scrollback key stay valid without reopening anything.
 *
 * Records never carry secrets: quick connect asks for the password like any credential-less session.
 */
export class EphemeralSessions {
  private readonly items = new Map<string, Session>()

  static readonly PREFIX = 'quick-'
  /** Unreferenced records beyond this are dropped, oldest first (a renderer that never opened its tab). */
  private static readonly MAX = 100

  /** `inUse` tells which records an open tab still needs; only the others are ever pruned. */
  constructor(private readonly inUse: (id: string) => boolean = () => false) {}

  create(input: SessionInput): Session {
    const id = EphemeralSessions.PREFIX + randomUUID()
    const s: Session = { ...input, id, tags: [], color: null, favorite: false, lastConnectedAt: null, ephemeral: true }
    for (const old of this.items.keys()) {
      if (this.items.size < EphemeralSessions.MAX) break
      if (!this.inUse(old)) this.items.delete(old)
    }
    this.items.set(id, s)
    return s
  }

  get(id: string): Session | undefined {
    return this.items.get(id)
  }

  update(id: string, patch: Partial<Pick<Session, 'platform' | 'detected'>>): Session | undefined {
    const s = this.items.get(id)
    if (!s) return undefined
    const next = { ...s, ...patch }
    this.items.set(id, next)
    return next
  }

  delete(id: string): void {
    this.items.delete(id)
  }

  get size(): number {
    return this.items.size
  }
}
