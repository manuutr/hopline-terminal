/**
 * Heavy output through the real path (simulator → SSH → session host → MessagePort → highlighter →
 * xterm, with ack flow control): a 50 MB `show tech`-like flood, a 20 MB ANSI-heavy flood and a
 * 20 MB `debug` flood, with the WebGL renderer and with the DOM fallback. Measures bytes/s rendered,
 * frame times, long tasks and dropped frames. The renderer label is what xterm really used.
 */
import { test } from '@playwright/test'
import { context, frameStats, installRecorder, lab, record, recordFrames, rendererOf, runFlood, setSettings } from '../lib'

const FLOOD_MB = Number(process.env['BENCH_FLOOD_MB'] ?? 50)
const ANSI_MB = Number(process.env['BENCH_ANSI_MB'] ?? 20)
/** Each flood runs this many times; report.mjs keeps the median of every metric. */
const REPEAT = Number(process.env['BENCH_REPEAT'] ?? 3)

for (const want of ['webgl', 'dom'] as const) {
  test(`throughput (${want})`, async () => {
    // WSL disables GPU compositing unless HOPLINE_GPU=1; the WebGL run asks for the GPU.
    const l = await lab({ renderer: want, env: want === 'webgl' ? { HOPLINE_GPU: '1' } : {} })
    try {
      if (process.env['BENCH_SCROLLBACK']) await setSettings(l.page, { termScrollback: Number(process.env['BENCH_SCROLLBACK']) })
      const tab = await l.open()
      const actual = await rendererOf(l.page, tab)
      context(`throughput.${want}.renderer`, actual)
      context(`throughput.${want}.gpu`, await l.app.evaluate(({ app }) => app.getGPUFeatureStatus()))
      await installRecorder(l.page)
      await runFlood(l.page, tab, 'bench flood 2', 2 * 1024 * 1024) // warm-up (JIT, glyph atlas)
      const note = `renderer=${actual}`
      for (let rep = 0; rep < REPEAT; rep++) {
        for (const [kind, mb] of [['plain', FLOOD_MB], ['ansi', ANSI_MB], ['debug', ANSI_MB]] as const) {
          const r = await runFlood(l.page, tab, `bench flood ${mb} ${kind}`, mb * 1024 * 1024 * 0.999)
          const p = `flood.${want}.${kind}`
          record({ id: `${p}.mb_per_s`, value: r.bytes / 1024 / 1024 / (r.ms / 1000), unit: 'MB/s', better: 'higher', note: `${(r.bytes / 1024 / 1024).toFixed(1)} MB in ${(r.ms / 1000).toFixed(2)} s, ${note}` })
          recordFrames(p, frameStats(r.raw), note)
        }
      }
    } finally {
      await l.close()
    }
  })
}
