/**
 * Memory with 20 open tabs, each with 10k lines of scrollback: main, renderer and session host
 * RSS (Electron's app metrics; workingSetSize is RSS on Linux), plus the renderer's JS heap.
 * Also times the periodic scrollback save of all those tabs (renderer serialize + main encrypt).
 */
import { test } from '@playwright/test'
import { context, installRecorder, frameStats, lab, processMemory, record, rendererOf, runFlood } from '../lib'

const TABS = Number(process.env['BENCH_TABS'] ?? 20)
const LINES = Number(process.env['BENCH_TAB_LINES'] ?? 10_000)

test(`memory: ${TABS} tabs × ${LINES} lines`, async () => {
  const l = await lab()
  try {
    const idle = await processMemory(l.app)
    record({ id: 'memory.idle.total_mb', value: idle.total, unit: 'MB', better: 'lower', note: 'no tabs', info: true })
    record({ id: 'memory.idle.main_mb', value: idle.main, unit: 'MB', better: 'lower', note: 'no tabs', info: true })
    record({ id: 'memory.idle.renderer_mb', value: idle.renderer, unit: 'MB', better: 'lower', note: 'no tabs', info: true })
    record({ id: 'memory.idle.session_host_mb', value: idle.host, unit: 'MB', better: 'lower', note: 'no tabs', info: true })
    record({ id: 'memory.idle.gpu_mb', value: idle.gpu, unit: 'MB', better: 'lower', note: 'no tabs', info: true })
    const tabs: string[] = []
    for (let i = 0; i < TABS; i++) {
      const id = await l.open()
      tabs.push(id)
      await runFlood(l.page, id, `bench lines ${LINES} ansi`, LINES * 100)
    }
    // Let GC and the host's buffers settle.
    await new Promise((r) => setTimeout(r, 5000))
    await l.page.evaluate(() => (window as unknown as { gc?: () => void }).gc?.())
    const m = await processMemory(l.app)
    const heap = await l.page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
    const note = `${TABS} tabs × ${LINES} lines`
    record({ id: 'memory.tabs.main_mb', value: m.main, unit: 'MB', better: 'lower', note })
    record({ id: 'memory.tabs.renderer_mb', value: m.renderer, unit: 'MB', better: 'lower', note })
    record({ id: 'memory.tabs.renderer_js_heap_mb', value: heap / 1024 / 1024, unit: 'MB', better: 'lower', note })
    record({ id: 'memory.tabs.session_host_mb', value: m.host, unit: 'MB', better: 'lower', note })
    record({ id: 'memory.tabs.gpu_mb', value: m.gpu, unit: 'MB', better: 'lower', note, info: true })
    record({ id: 'memory.tabs.total_mb', value: m.total, unit: 'MB', better: 'lower', note })
    record({ id: 'memory.tabs.per_tab_mb', value: (m.total - idle.total) / TABS, unit: 'MB', better: 'lower', note })
    context('memory.processes', m)
    const renderers: Record<string, number> = {}
    for (const id of tabs) {
      const r = await rendererOf(l.page, id)
      renderers[r] = (renderers[r] ?? 0) + 1
    }
    context('memory.renderers', renderers)
    console.log('  renderers in use:', JSON.stringify(renderers))

    // The scrollback save that runs every 30 s, for every dirty tab at once (worst case: all dirty).
    await installRecorder(l.page)
    // Main's event loop while it encrypts and writes them (it serves every window's IPC).
    await l.app.evaluate(() => {
      const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks') as typeof import('node:perf_hooks')
      const h = monitorEventLoopDelay({ resolution: 5 })
      h.enable()
      ;(globalThis as unknown as { __benchLoop: typeof h }).__benchLoop = h
    })
    const save = await l.page.evaluate(async () => {
      const b = (window as unknown as { __bench: { start: () => void; stop: () => { frames: number[]; long: number[] } } }).__bench
      b.start()
      const t0 = performance.now()
      window.dispatchEvent(new Event('hopline:bench:save-scrollback'))
      // Long enough for a queued save of every tab (lib/save-queue runs one per idle period).
      await new Promise((r) => setTimeout(r, 8000))
      return { ms: performance.now() - t0, raw: b.stop() }
    })
    const mainLag = await l.app.evaluate(() => {
      const h = (globalThis as unknown as { __benchLoop: { disable: () => void; max: number } }).__benchLoop
      h.disable()
      return h.max / 1e6
    })
    record({ id: 'memory.save_all.main_loop_max_ms', value: mainLag, unit: 'ms', better: 'lower', note: 'main event-loop delay while the saves land' })
    const s = frameStats(save.raw)
    record({ id: 'memory.save_all.long_task_ms', value: s.longTaskMs, unit: 'ms', better: 'lower', note: `${TABS} tabs saved at once` })
    record({ id: 'memory.save_all.frame_max_ms', value: s.max, unit: 'ms', better: 'lower', note: `${TABS} tabs saved at once` })
    record({ id: 'memory.save_all.longest_task_ms', value: save.raw.long.length ? Math.max(...save.raw.long) : 0, unit: 'ms', better: 'lower', note: 'the longest single task' })
  } finally {
    await l.close()
  }
})
