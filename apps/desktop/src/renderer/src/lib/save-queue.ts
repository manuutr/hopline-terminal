/**
 * Periodic scrollback saves, one at a time. Serializing a tab's history is one synchronous task of
 * tens of milliseconds; tabs opened together (a restored workspace, a multi-device run) had their
 * 30 s timers aligned and serialized all at once, a visible freeze (bench: 20 tabs, 1.3 s of long
 * tasks in a burst). The queue runs one save per idle period and puts off a tab that is receiving
 * output, so a flood is never interrupted by its own save.
 */

interface Job {
  save: () => void
  /** Output arrived just now: try again later. */
  busy: () => boolean
  /** First queued (a busy tab is still saved after MAX_DEFER_MS). */
  since: number
}

const MAX_DEFER_MS = 30_000
const jobs = new Map<string, Job>()
let scheduled = false

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 })
  else setTimeout(fn, 50)
}

function pump(): void {
  scheduled = false
  const now = performance.now()
  for (const [id, job] of jobs) {
    if (job.busy() && now - job.since < MAX_DEFER_MS) continue
    jobs.delete(id)
    try {
      job.save()
    } catch {
      // A failed save is retried at the next period.
    }
    break
  }
  if (!jobs.size) return
  scheduled = true
  // Only busy tabs left: look again in a while instead of spinning through idle periods.
  const allBusy = [...jobs.values()].every((j) => j.busy())
  if (allBusy) setTimeout(() => idle(pump), 1000)
  else idle(pump)
}

/** Queue a save for `id` (one pending per tab: a newer request replaces the older one). */
export function queueSave(id: string, save: () => void, busy: () => boolean): void {
  const since = jobs.get(id)?.since ?? performance.now()
  jobs.set(id, { save, busy, since })
  if (!scheduled) {
    scheduled = true
    idle(pump)
  }
}

/** The tab is closing (it saves on its own) or gone: drop its pending save. */
export function cancelSave(id: string): void {
  jobs.delete(id)
}

// ------------------------------------------------------------------ flush on close / quit (review L8)

/** Every live tab's "save now", for main's flush request (window close, quit). */
const flushers = new Map<string, () => Promise<unknown> | void>()
let subscribed = false

/**
 * Answer main's flush requests (once, at startup: main.tsx). A window with no terminal answers at
 * once, so closing or quitting never waits for main's timeout.
 */
export function installFlushHandler(): void {
  if (subscribed || typeof window === 'undefined' || !window.hopline?.scrollback?.onFlush) return
  subscribed = true
  window.hopline.scrollback.onFlush(() => flushAll())
}

/** Register a tab's immediate save; returns the unregister function. */
export function registerFlush(id: string, save: () => Promise<unknown> | void): () => void {
  flushers.set(id, save)
  installFlushHandler()
  return () => {
    if (flushers.get(id) === save) flushers.delete(id)
  }
}

/** Save every tab now, ignoring the queue (a busy tab included). */
export async function flushAll(): Promise<void> {
  jobs.clear()
  await Promise.allSettled(
    [...flushers.values()].map(async (f) => {
      await f()
    })
  )
}
