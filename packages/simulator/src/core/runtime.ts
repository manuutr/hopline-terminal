/**
 * Per-device runtime that must not live in the (cloneable, plain-data) Device model: the clock,
 * device-owned timers (commit confirmed, commit timer, BGP establishment) and a broadcast bus that
 * reaches every CLI session open on the device, over SSH or Telnet.
 */
import type { Device } from '../state.ts'

export interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** A clock tests can drive: `advance(ms)` fires due timers in order. */
export class ManualClock implements Clock {
  private t: number
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  constructor(start = Date.now()) {
    this.t = start
  }
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn })
    return id
  }
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number)
  }
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      this.timers.delete(next[0])
      this.t = next[1].at
      next[1].fn()
    }
    this.t = end
  }
}

export interface DeviceRuntime {
  clock: Clock
  /** Send an unsolicited message (syslog-style broadcast) to every open CLI session. */
  broadcast: (text: string) => void
  subscribe: (fn: (text: string) => void) => () => void
  /** A named device timer; re-arming a name replaces the old timer. */
  timer: (name: string, ms: number, fn: () => void) => void
  cancel: (name: string) => void
  pending: (name: string) => boolean
  /** Tests: fire pending timers now (their names, or those starting with `prefix`); returns how many fired. */
  fire: (prefix: string) => number
  /** Clear every device timer (server close). */
  dispose: () => void
}

const runtimes = new WeakMap<Device, DeviceRuntime>()

export function runtime(d: Device): DeviceRuntime {
  let rt = runtimes.get(d)
  if (rt) return rt
  const listeners = new Set<(text: string) => void>()
  const timers = new Map<string, unknown>()
  const fns = new Map<string, () => void>()
  const r: DeviceRuntime = {
    clock: realClock,
    broadcast: (text) => {
      for (const fn of listeners) fn(text)
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    timer: (name, ms, fn) => {
      r.cancel(name)
      fns.set(name, fn)
      timers.set(
        name,
        r.clock.setTimeout(() => {
          timers.delete(name)
          fns.delete(name)
          fn()
        }, ms)
      )
    },
    cancel: (name) => {
      const h = timers.get(name)
      if (h !== undefined) r.clock.clearTimeout(h)
      timers.delete(name)
      fns.delete(name)
    },
    pending: (name) => timers.has(name),
    fire: (prefix) => {
      const due = [...fns].filter(([n]) => n.startsWith(prefix))
      for (const [n, fn] of due) {
        r.cancel(n)
        fn()
      }
      return due.length
    },
    dispose: () => {
      for (const h of timers.values()) r.clock.clearTimeout(h)
      timers.clear()
      fns.clear()
    }
  }
  rt = r
  runtimes.set(d, rt)
  return rt
}

/** Use a different clock for this device (tests). Call before any session starts. */
export function setClock(d: Device, clock: Clock): void {
  runtime(d).clock = clock
}

export const now = (d: Device): number => runtime(d).clock.now()
