/**
 * Input latency: a real key event (Playwright → Chromium input) → keystroke over the port → session
 * host → SSH → simulator echo → back → xterm parse → the next painted frame. Idle, and while another
 * tab floods (the session host and the renderer are shared by every tab). `recv` splits off the time
 * until the echo reaches the renderer (network + session host) from the render part.
 */
import { test, type Page } from '@playwright/test'
import { lab, percentile, record, rendererOf } from '../lib'

const SAMPLES = Number(process.env['BENCH_LATENCY_SAMPLES'] ?? 40)

async function installProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    type Term = import('@xterm/xterm').Terminal
    type Key = { ch: string; t: number; recv?: number }
    const term = (window as unknown as { __hoplineTest: { raw: (id: string) => Term } }).__hoplineTest.raw(id)
    const api = (window as unknown as { hopline: { term: { onData: (cb: (t: string, d: string) => void) => void } } }).hopline.term
    const st = { samples: [] as number[], recv: [] as number[], parsed: [] as number[], pending: [] as Key[] }
    ;(window as unknown as { __lat: typeof st }).__lat = st
    // Capture phase: the browser's own event timestamp, before any app handler runs.
    window.addEventListener('keydown', (e) => e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && st.pending.push({ ch: e.key, t: e.timeStamp }), true)
    // When the echo reaches the renderer (port message).
    api.onData((t) => {
      const p = st.pending[0]
      if (t === id && p && p.recv === undefined) p.recv = performance.now()
    })
    term.onWriteParsed(() => {
      const p = st.pending[0]
      if (!p) return
      const b = term.buffer.active
      const line = b.getLine(b.baseY + b.cursorY)?.translateToString(true, 0, b.cursorX) ?? ''
      if (!line.endsWith(p.ch)) return
      st.pending.shift()
      const parsed = performance.now()
      requestAnimationFrame(() => {
        st.parsed.push(parsed - p.t)
        st.samples.push(performance.now() - p.t)
        st.recv.push((p.recv ?? performance.now()) - p.t)
      })
    })
  }, tabId)
}

async function typeSamples(page: Page, n: number): Promise<{ total: number[]; recv: number[]; parsed: number[] }> {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  for (let i = 0; i < n; i++) {
    const before = await page.evaluate(() => (window as unknown as { __lat: { samples: number[] } }).__lat.samples.length)
    await page.keyboard.press(letters[i % 26]!)
    await page.waitForFunction((k) => (window as unknown as { __lat: { samples: number[] } }).__lat.samples.length > k, before, { timeout: 10_000 })
    // Keep the line short: clear it every 20 keys (Ctrl-U), out of band of the measurement.
    if (i % 20 === 19) {
      await page.keyboard.press('Control+u')
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(20)
  }
  await page.keyboard.press('Control+u')
  return page.evaluate((k) => {
    const st = (window as unknown as { __lat: { samples: number[]; recv: number[]; parsed: number[] } }).__lat
    return { total: st.samples.slice(-k), recv: st.recv.slice(-k), parsed: st.parsed.slice(-k) }
  }, n)
}

const write = (page: Page, tab: string, d: string) =>
  page.evaluate(([id, data]) => (window as unknown as { hopline: { term: { write: (t: string, d: string) => void } } }).hopline.term.write(id, data), [tab, d] as const)

for (const want of ['webgl', 'dom'] as const) {
  test(`input latency (${want})`, async () => {
    const l = await lab({ renderer: want, env: want === 'webgl' ? { HOPLINE_GPU: '1' } : {} })
    try {
      const flooder = await l.open()
      const tab = await l.open()
      const actual = await rendererOf(l.page, tab)
      await l.page.locator('.xterm:visible').first().click()
      await installProbe(l.page, tab)
      await typeSamples(l.page, 5) // warm-up
      const idle = await typeSamples(l.page, SAMPLES)
      const note = `renderer=${actual}, n=${idle.total.length}`
      record({ id: `latency.${want}.idle_p50_ms`, value: percentile(idle.total, 50), unit: 'ms', better: 'lower', note })
      record({ id: `latency.${want}.idle_p95_ms`, value: percentile(idle.total, 95), unit: 'ms', better: 'lower', note })
      record({ id: `latency.${want}.idle_max_ms`, value: Math.max(...idle.total), unit: 'ms', better: 'lower', note, info: true })
      record({ id: `latency.${want}.idle_recv_p50_ms`, value: percentile(idle.recv, 50), unit: 'ms', better: 'lower', note: 'key → echo at the renderer', info: true })
      record({ id: `latency.${want}.idle_parsed_p50_ms`, value: percentile(idle.parsed, 50), unit: 'ms', better: 'lower', note: 'key → echo parsed by xterm', info: true })
      // Another tab floods for the whole measurement.
      await write(l.page, flooder, 'bench flood 2000\r')
      await l.page.waitForTimeout(500)
      const busy = await typeSamples(l.page, SAMPLES)
      await write(l.page, flooder, '\x1e') // the IOS abort key stops the flood
      const n2 = `renderer=${actual}, other tab flooding, n=${busy.total.length}`
      record({ id: `latency.${want}.flood_other_tab_p50_ms`, value: percentile(busy.total, 50), unit: 'ms', better: 'lower', note: n2 })
      record({ id: `latency.${want}.flood_other_tab_p95_ms`, value: percentile(busy.total, 95), unit: 'ms', better: 'lower', note: n2 })
      record({ id: `latency.${want}.flood_other_tab_max_ms`, value: Math.max(...busy.total), unit: 'ms', better: 'lower', note: n2, info: true })
      record({ id: `latency.${want}.flood_other_tab_recv_p50_ms`, value: percentile(busy.recv, 50), unit: 'ms', better: 'lower', note: 'key → echo at the renderer', info: true })
    } finally {
      await l.close()
    }
  })
}
