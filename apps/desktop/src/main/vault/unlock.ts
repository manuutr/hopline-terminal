import type { Vault } from './vault'

/**
 * Something in main needs a stored secret while the vault is locked (a new tab, a reconnect after a
 * session-host restart, a jump host). Ask the renderer to show the unlock dialog once, and let every
 * waiter continue when the user unlocks or declines (then they go on without stored secrets and the
 * device prompts as usual).
 */
export class UnlockBroker {
  private waiting: { promise: Promise<void>; done: () => void } | null = null

  constructor(
    private readonly vault: Vault,
    private readonly notify: () => void,
    private readonly timeoutMs = 5 * 60_000
  ) {
    vault.on('change', () => {
      if (!vault.info().locked) this.release()
    })
  }

  /** Resolves when unlocked, declined, or timed out. Never rejects. */
  request(): Promise<void> {
    if (!this.vault.info().locked || this.vault.info().mode !== 'master') return Promise.resolve()
    if (this.waiting) return this.waiting.promise
    let done!: () => void
    const promise = new Promise<void>((r) => (done = r))
    const timer = setTimeout(() => this.release(), this.timeoutMs)
    timer.unref?.()
    this.waiting = {
      promise,
      done: () => {
        clearTimeout(timer)
        done()
      }
    }
    this.notify()
    return promise
  }

  /** The user closed the unlock dialog without unlocking. */
  skip(): void {
    this.release()
  }

  private release(): void {
    const w = this.waiting
    this.waiting = null
    w?.done()
  }
}
