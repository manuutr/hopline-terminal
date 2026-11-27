import { expect, test } from './fixtures'

test('a real show tech flood keeps the UI responsive (flow control end to end)', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('terminal length 0\r')
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  // Measure renderer main-thread lag while ~4 MB flows device → session host → port → xterm.
  await hop.page.evaluate(() => {
    const w = window as unknown as { __lag: number[]; __lagTimer: number }
    w.__lag = []
    let last = performance.now()
    w.__lagTimer = window.setInterval(() => {
      const now = performance.now()
      w.__lag.push(now - last - 10)
      last = now
    }, 10)
  })
  // The same timer with nothing flowing: what the machine itself adds (a busy CPU, other test runs).
  await hop.page.waitForTimeout(1000)
  const idle = await hop.page.evaluate(() => {
    const w = window as unknown as { __lag: number[] }
    const s = [...w.__lag].sort((a, b) => a - b)
    w.__lag = []
    return s[Math.floor(s.length * 0.95)] ?? 0
  })
  const tail = () => hop.page.evaluate(() => (window as unknown as { __hoplineTest: { tail: (n: number) => string } }).__hoplineTest.tail(3))
  const t0 = Date.now()
  await hop.page.keyboard.type('show tech-support\r')
  // Output has started (the prompt is no longer last), then it ends back at the prompt.
  await expect.poll(tail, { timeout: 10_000, intervals: [20] }).not.toMatch(/core-sw1#\s*$/)
  await expect.poll(tail, { timeout: 30_000, intervals: [100] }).toMatch(/core-sw1#\s*$/)
  const ms = Date.now() - t0
  const lag = await hop.page.evaluate(() => {
    const w = window as unknown as { __lag: number[]; __lagTimer: number }
    clearInterval(w.__lagTimer)
    const s = [...w.__lag].sort((a, b) => a - b)
    return { p95: s[Math.floor(s.length * 0.95)] ?? 0, max: s.at(-1) ?? 0 }
  })
  const mbps = 4 / (ms / 1000)
  console.log(`show tech 4 MB in ${ms} ms (${mbps.toFixed(1)} MB/s); renderer lag p95 ${lag.p95.toFixed(0)} ms, max ${lag.max.toFixed(0)} ms (idle p95 ${idle.toFixed(0)} ms)`)
  test.info().annotations.push({ type: 'flood-e2e', description: `${mbps.toFixed(1)} MB/s, lag p95 ${lag.p95.toFixed(0)} ms` })
  // Target: <50 ms with GPU compositing (measured ~25 ms). Software compositing (WSL default, CI
  // under xvfb) adds paint stalls outside our code, so those runs get a looser budget.
  // The budget is for what the flood adds: the timer's own idle lag (other processes) comes on top.
  // Measured here: 18-65 ms under software compositing; 167-200 ms only with every core saturated
  // by other processes, which no budget can absorb (docs/BACKLOG.md › e2e hardening).
  const budget = Number(process.env['HOPLINE_LAG_BUDGET_MS'] ?? (process.env['HOPLINE_GPU'] === '1' ? 50 : 150))
  expect(lag.p95).toBeLessThan(budget + idle)
  // Typing still works right after the flood.
  await hop.page.keyboard.type('show clock\r')
  await expect.poll(hop.termText).toMatch(/UTC[\s\S]*core-sw1#\s*$/)
})

test('session host crash: tabs reconnect on their own', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.app.evaluate(() => (globalThis as unknown as { __hoplineHost: { crashForTest(): void } }).__hoplineHost.crashForTest())
  // The same xterm gets a fresh connection: a second login banner/prompt appears after the restart.
  await expect.poll(async () => ((await hop.termText()).match(/core-sw1#/g) ?? []).length, { timeout: 20_000 }).toBeGreaterThan(1)
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
})
