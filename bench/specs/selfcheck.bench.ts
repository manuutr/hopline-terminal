/** The recorder itself: rAF runs at the display rate in the hidden window and long tasks are seen. */
import { expect, test } from '@playwright/test'
import { context, frameStats, installRecorder, lab } from '../lib'

test('recorder self-check', async () => {
  const l = await lab()
  try {
    await installRecorder(l.page)
    const r = await l.page.evaluate(async () => {
      const b = (window as unknown as { __bench: { start: () => void; stop: () => { frames: number[]; long: number[] } } }).__bench
      b.start()
      await new Promise((res) => setTimeout(res, 500))
      const t = performance.now()
      while (performance.now() - t < 120) {
        /* a 120 ms long task */
      }
      await new Promise((res) => setTimeout(res, 300))
      return { raw: b.stop(), types: PerformanceObserver.supportedEntryTypes }
    })
    const s = frameStats(r.raw)
    context('recorder.selfcheck', { ...s, types: r.types })
    console.log(JSON.stringify({ ...s, types: r.types }))
    expect(r.types).toContain('longtask')
    expect(s.longTasks).toBeGreaterThanOrEqual(1)
    expect(s.p50).toBeGreaterThan(10)
    expect(s.p50).toBeLessThan(25)
  } finally {
    await l.close()
  }
})
