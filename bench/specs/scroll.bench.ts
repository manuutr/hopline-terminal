/**
 * Scrolling through 100k lines of scrollback: frame times while the view moves every frame
 * (a steady fling: 60 lines/frame; random jumps: every row changes), WebGL and DOM.
 */
import { expect, test } from '@playwright/test'
import { MOD } from '../../apps/desktop/e2e/fixtures'
import { context, frameStats, installRecorder, lab, record, recordFrames, rendererOf, runFlood, setSettings } from '../lib'

const TABS = Math.max(1, Number(process.env['BENCH_SCROLL_TABS'] ?? 1))
const LINES = Number(process.env['BENCH_SCROLL_LINES'] ?? 100_000)

for (const want of ['webgl', 'dom'] as const) {
  test(`scroll ${LINES} lines (${want})`, async () => {
    const l = await lab({ renderer: want, env: want === 'webgl' ? { HOPLINE_GPU: '1' } : {} })
    try {
      await setSettings(l.page, { termScrollback: Math.min(200_000, LINES + 10_000), termRestoreScrollback: false })
      const states: Record<string, string> = {}
      await l.page.exposeFunction('benchObserveConnection', (id: string, state: string) => { states[id] = state })
      await l.page.evaluate(() => {
        const w = window as unknown as {
          benchObserveConnection(id: string, state: string): Promise<void>
          hopline: { term: { onState(fn: (event: { tabId: string; state: string }) => void): () => void } }
        }
        w.hopline.term.onState(({ tabId, state }) => void w.benchObserveConnection(tabId, state))
      })
      for (let i = 1; i < TABS; i++) await l.open(i % 2 ? 'dist-eos1' : 'core-sw1')
      const tab = await l.open()
      await expect.poll(() => Object.values(states).filter((s) => s === 'connected').length).toBe(TABS)
      const actual = await rendererOf(l.page, tab)
      expect(actual).toBe(want)
      const gpu = await l.app.evaluate(async ({ app }) => {
        const report = await app.getGPUInfo('complete') as { auxAttributes?: { glRenderer?: string }; gpuDevice?: { deviceString?: string }[] }
        return { device: report.auxAttributes?.glRenderer ?? report.gpuDevice?.[0]?.deviceString, rasterization: app.getGPUFeatureStatus().rasterization }
      })
      // WSLg's main-process GPU report can omit the adapter that xterm actually uses.
      const adapter = actual === 'webgl' ? await l.page.evaluate((id) => {
        const pane = document.querySelector(`[data-terminal-container="${CSS.escape(id)}"]`)
        for (const canvas of pane?.querySelectorAll<HTMLCanvasElement>('.xterm-screen > canvas') ?? []) {
          const gl = canvas.getContext('webgl2')
          const ext = gl?.getExtension('WEBGL_debug_renderer_info')
          if (gl && ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        }
        return null
      }, tab) : null
      context(`scroll.${want}.gpu`, adapter ?? gpu.device ?? 'unknown')
      context(`scroll.${want}.rasterization`, gpu.rasterization)
      context(`scroll.${want}.renderer`, actual)
      await installRecorder(l.page)
      const fill = await runFlood(l.page, tab, `bench lines ${LINES}`, LINES * 60)
      record({ id: `scroll.${want}.fill_mb_per_s`, value: fill.bytes / 1024 / 1024 / (fill.ms / 1000), unit: 'MB/s', better: 'higher', info: true, note: `${LINES} lines into a ${LINES + 10_000}-line scrollback` })
      const len = await l.page.evaluate((id) => (window as unknown as { __hoplineTest: { raw: (id: string) => { buffer: { active: { length: number } } } } }).__hoplineTest.raw(id).buffer.active.length, tab)
      expect(len).toBeGreaterThanOrEqual(LINES)
      context(`scroll.${want}.buffer_lines`, len)
      for (const mode of ['fling', 'jump'] as const) {
        const raw = await l.page.evaluate(
          async ([id, m]) => {
            type Term = { scrollLines: (n: number) => void; scrollToLine: (n: number) => void; scrollToBottom: () => void; buffer: { active: { length: number } } }
            const term = (window as unknown as { __hoplineTest: { raw: (id: string) => Term } }).__hoplineTest.raw(id)
            const bench = (window as unknown as { __bench: { start: () => void; stop: () => { frames: number[]; long: number[] } } }).__bench
            term.scrollToBottom()
            await new Promise((r) => requestAnimationFrame(r))
            bench.start()
            let seed = 7
            const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
            for (let i = 0; i < 400; i++) {
              if (m === 'fling') term.scrollLines(-60)
              else term.scrollToLine(Math.floor(rnd() * term.buffer.active.length))
              await new Promise((r) => requestAnimationFrame(r))
            }
            const out = bench.stop()
            term.scrollToBottom()
            return out
          },
          [tab, mode] as const
        )
        recordFrames(`scroll.${want}.${mode}`, frameStats(raw), `renderer=${actual}, ${len} lines`)
      }
      // Exercise visible chrome with the populated terminal and other connections still alive.
      if (TABS > 1) {
        type Samples = { frames: number[]; long: number[]; loaf: number[] }
        const passes: Samples[] = []
        const assistant = l.page.getByRole('button', { name: 'Toggle assistant', exact: true })
        const palette = l.page.getByRole('dialog', { name: 'Command palette' })
        let open = (await assistant.getAttribute('aria-pressed')) === 'true'
        for (let i = 0; i < 4; i++) {
          await l.page.evaluate(() => (window as unknown as { __bench: { start(): void } }).__bench.start())
          await l.page.keyboard.press(MOD + '+I')
          open = !open
          await expect(assistant).toHaveAttribute('aria-pressed', String(open))
          await l.page.waitForTimeout(320)
          await l.page.keyboard.press(MOD + '+K')
          await expect(palette).toBeVisible()
          await l.page.waitForTimeout(200)
          await l.page.keyboard.press('Escape')
          await expect(palette).toBeHidden()
          await l.page.waitForTimeout(120)
          passes.push(await l.page.evaluate(() => (window as unknown as { __bench: { stop(): Samples } }).__bench.stop()))
        }
        const note = `${TABS} live sessions, ${len} lines, renderer=${actual}`
        for (const [label, samples] of [['chrome', passes], ['chrome_first', passes.slice(0, 1)], ['chrome_repeat', passes.slice(1)]] as const) {
          const raw = { frames: samples.flatMap((p) => p.frames), long: samples.flatMap((p) => p.long), loaf: samples.flatMap((p) => p.loaf) }
          recordFrames(`scroll.${want}.${label}`, frameStats(raw), note)
        }
      }
      const connected = Object.values(states).filter((s) => s === 'connected').length
      expect(connected).toBe(TABS)
      context(`scroll.${want}.connected_tabs`, connected)
    } finally {
      await l.close()
    }
  })
}
