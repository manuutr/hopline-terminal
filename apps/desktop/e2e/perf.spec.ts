import { expect, test } from './fixtures'

type Bench = { mb: number; ms: number; mbps: number }

test('startup: window shows the session tree quickly', async ({ hop }) => {
  // Measured from launch inside the fixture; here we assert time-to-interactive from page load.
  const tti = await hop.page.evaluate(() => performance.now())
  test.info().annotations.push({ type: 'tti-ms', description: tti.toFixed(0) })
  expect(tti).toBeLessThan(3000)
})

test('throughput: heavy output with highlighting stays fast', async ({ hop }) => {
  await hop.connect('core-sw1')
  const run = (mb: number) =>
    hop.page.evaluate((m) => (window as unknown as { __hoplineTest: { bench: (mb: number) => Promise<Bench> } }).__hoplineTest.bench(m), mb)
  const bench = (mb: number, raw: boolean) =>
    hop.page.evaluate(([m, r]) => (window as unknown as { __hoplineTest: { bench: (mb: number, raw: boolean) => Promise<Bench> } }).__hoplineTest.bench(m, r), [mb, raw] as const)
  await run(1) // warm up
  // Shared CI runners are noisy: interleave the two and keep each one's best of three.
  let raw = { mb: 0, ms: 0, mbps: 0 }
  let r = { mb: 0, ms: 0, mbps: 0 }
  for (let i = 0; i < 3; i++) {
    const a = await bench(16, true)
    const b = await bench(16, false)
    if (a.mbps > raw.mbps) raw = a
    if (b.mbps > r.mbps) r = b
  }
  test.info().annotations.push({ type: 'throughput', description: `flood ${r.mbps.toFixed(1)} MB/s vs raw xterm ${raw.mbps.toFixed(1)} MB/s` })
  console.log(`flood: ${r.mbps.toFixed(1)} MB/s (best of 3); raw xterm ${raw.mbps.toFixed(1)} MB/s`)
  // Floods bypass highlighting, so they must run close to raw xterm speed.
  expect(r.mbps).toBeGreaterThan(raw.mbps * 0.6)
  // And far above any real device (a 115200-baud console is 0.011 MB/s; a busy show tech ~1-5 MB/s).
  // An absolute speed only says something about Hopline when xterm itself runs at its usual speed
  // (11-27 MB/s here and on Windows): with the CPU saturated raw xterm fell to 2.8 MB/s, and the
  // ratio above is the check.
  if (raw.mbps >= 8) expect(r.mbps).toBeGreaterThan(5)
  else test.info().annotations.push({ type: 'slow-machine', description: `raw xterm ${raw.mbps.toFixed(1)} MB/s: absolute check skipped` })
})
