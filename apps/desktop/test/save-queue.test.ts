import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelSave, queueSave } from '../src/renderer/src/lib/save-queue'

afterEach(() => vi.useRealTimers())

describe('scrollback save queue', () => {
  it('runs one save per idle period, never two in the same task', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    for (const id of ['a', 'b', 'c']) queueSave(id, () => order.push(id), () => false)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(50)
    expect(order).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(50)
    expect(order).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(50)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('a newer request for the same tab replaces the pending one; cancel drops it', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    queueSave('t', () => calls.push('old'), () => false)
    queueSave('t', () => calls.push('new'), () => false)
    queueSave('gone', () => calls.push('gone'), () => false)
    cancelSave('gone')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual(['new'])
  })

  it('puts off a tab that is receiving output, but not forever', async () => {
    vi.useFakeTimers()
    let busy = true
    const calls: string[] = []
    queueSave('flood', () => calls.push('flood'), () => busy)
    queueSave('quiet', () => calls.push('quiet'), () => false)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual(['quiet'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toEqual(['quiet'])
    busy = false
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toEqual(['quiet', 'flood'])
    // A tab that never goes quiet is still saved after 30 s.
    queueSave('busy', () => calls.push('busy'), () => true)
    await vi.advanceTimersByTimeAsync(32_000)
    expect(calls.at(-1)).toBe('busy')
  })
})
