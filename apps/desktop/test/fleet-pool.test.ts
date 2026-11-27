import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { clampConcurrency, LanePool, MAX_FLEET_CONCURRENCY, PER_JUMP_LIMIT, Semaphore, type BackgroundHost } from '../src/main/fleet/pool'
import { session, simHost, type SimHost } from './fleet-helpers'

/** Step 2: background tabs for lanes, with concurrency limits, over the existing background connection. */

function countingHost(ms = 30) {
  let open = 0
  let peak = 0
  const closed: string[] = []
  let n = 0
  const host: BackgroundHost = {
    async openBackground(sessionId, signal) {
      open++
      peak = Math.max(peak, open)
      await new Promise((r) => setTimeout(r, ms))
      if (signal?.aborted) {
        open--
        throw new Error('stopped')
      }
      return { tabId: `t${++n}`, session: { id: sessionId } as Session }
    },
    close(tabId) {
      open--
      closed.push(tabId)
    }
  }
  return { host, peak: () => peak, open: () => open, closed }
}

const work = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('LanePool', () => {
  it('never has more than `concurrency` background tabs open, and closes every one', async () => {
    const h = countingHost()
    const pool = new LanePool(h.host, 3)
    const sessions = Array.from({ length: 9 }, (_, i) => session(`d${i}`, 'iosxe', 1))
    await Promise.all(
      sessions.map(async (s) => {
        const l = await pool.acquire(s)
        try {
          await work(20)
        } finally {
          l.release()
        }
      })
    )
    expect(h.peak()).toBe(3)
    expect(pool.maxOpen).toBe(3)
    expect(h.open()).toBe(0)
    expect(h.closed).toHaveLength(9)
    expect(pool.openCount).toBe(0)
  })

  it(`allows ${PER_JUMP_LIMIT} at once through the same jump host, others in parallel`, async () => {
    const h = countingHost(10)
    const pool = new LanePool(h.host, 8)
    const viaJ = Array.from({ length: 5 }, (_, i) => session(`j${i}`, 'iosxe', 1, { options: { ssh: { jump: ['jump-1'] } } } as Partial<Session>))
    const direct = Array.from({ length: 3 }, (_, i) => session(`x${i}`, 'iosxe', 1))
    let jumpOpen = 0
    let jumpPeak = 0
    await Promise.all(
      [...viaJ, ...direct].map(async (s) => {
        const l = await pool.acquire(s)
        const isJ = LanePool.jumpOf(s) === 'jump-1'
        if (isJ) jumpPeak = Math.max(jumpPeak, ++jumpOpen)
        await work(25)
        if (isJ) jumpOpen--
        l.release()
      })
    )
    expect(jumpPeak).toBe(PER_JUMP_LIMIT)
    expect(h.peak()).toBeGreaterThan(PER_JUMP_LIMIT)
  })

  it('a stopped wait never connects; a failed connect frees its slot; release is idempotent', async () => {
    const h = countingHost(10)
    const pool = new LanePool(h.host, 1)
    const a = await pool.acquire(session('a', 'iosxe', 1))
    const stop = new AbortController()
    const waiting = pool.acquire(session('b', 'iosxe', 1), stop.signal)
    stop.abort()
    await expect(waiting).rejects.toThrow('stopped')
    a.release()
    a.release()
    expect(h.closed).toEqual(['t1'])
    const failing: BackgroundHost = { openBackground: async () => Promise.reject(new Error('needs sign-in')), close: () => {} }
    const p2 = new LanePool(failing, 1)
    await expect(p2.acquire(session('c', 'iosxe', 1))).rejects.toThrow('needs sign-in')
    await expect(p2.acquire(session('c', 'iosxe', 1))).rejects.toThrow('needs sign-in')
  })

  it('clamps concurrency to 1–8', () => {
    expect(clampConcurrency(0)).toBe(4)
    expect(clampConcurrency(99)).toBe(MAX_FLEET_CONCURRENCY)
    expect(clampConcurrency(2.7)).toBe(2)
    expect(clampConcurrency(Number.NaN, 1)).toBe(1)
    const s = new Semaphore(1)
    expect(s.inUse).toBe(0)
  })
})

describe('LanePool against two simulator devices', () => {
  let host: SimHost
  beforeAll(async () => {
    host = await simHost([
      { name: 'core-sw1', platform: 'iosxe' },
      { name: 'dist-eos1', platform: 'eos' }
    ])
  })
  afterAll(() => host.stop())

  it('opens a background tab per device, runs a read on each in parallel, and closes both', async () => {
    const pool = new LanePool(host, 2)
    const results = await Promise.all(
      host.sessions.map(async (s) => {
        const l = await pool.acquire(s)
        try {
          return await host.exec(l.tab, 'show version', 'read', { timeoutMs: 8000, capBytes: 512 * 1024 })
        } finally {
          l.release()
        }
      })
    )
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(results[0]!.output).toMatch(/Cisco IOS XE/)
    expect(results[1]!.output).toMatch(/Arista/)
    expect(pool.maxOpen).toBe(2)
    expect(host.closed.sort()).toEqual(['core-sw1', 'dist-eos1'])
  })
})
