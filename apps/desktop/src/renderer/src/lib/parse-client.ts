/**
 * The renderer's door to TextFSM: a dedicated worker with a hard time budget. A parse that runs
 * past it is abandoned by terminating the worker (a runaway regex can't be interrupted any other
 * way); the next request starts a fresh one.
 */
import type { ParseResult } from '@hopline/parsers'
import { findTemplate } from '@hopline/parsers/match'
import type { ParseRequest } from './parse.worker'

export const PARSE_BUDGET_MS = 1500
/** Outputs larger than this are not parsed (a show tech, a full config). */
export const MAX_PARSE_CHARS = 1024 * 1024

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (r: ParseResult | null) => void; timer: ReturnType<typeof setTimeout> }>()

function spawn(): Worker {
  const w = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module', name: 'hopline-textfsm' })
  w.onmessage = (e: MessageEvent<{ id: number; result: ParseResult | null }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    clearTimeout(p.timer)
    p.resolve(e.data.result)
  }
  w.onerror = () => reset()
  return w
}

function reset(): void {
  worker?.terminate()
  worker = null
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.resolve(null)
  }
  pending.clear()
}

/** Is there a bundled template for this command? Cheap (index only), safe on the UI thread. */
export function hasTemplate(platform: string, command: string): boolean {
  try {
    return findTemplate(platform, command) !== null
  } catch {
    return false
  }
}

/** Parse in the worker; null on no template, an error or a timeout. */
export function parseInWorker(platform: string, command: string, text: string, budgetMs = PARSE_BUDGET_MS): Promise<ParseResult | null> {
  if (!text || text.length > MAX_PARSE_CHARS || !hasTemplate(platform, command)) return Promise.resolve(null)
  worker ??= spawn()
  const id = ++seq
  return new Promise((resolve) => {
    // The worker checks the budget between lines; this catches one regex that never returns.
    const timer = setTimeout(() => reset(), budgetMs + 500)
    pending.set(id, { resolve, timer })
    worker!.postMessage({ id, platform, command, text, budgetMs } satisfies ParseRequest)
  })
}
