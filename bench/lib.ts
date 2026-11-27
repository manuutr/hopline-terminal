/**
 * Shared helpers for the benchmark suite (docs/PERFORMANCE.md): launching Hopline hidden against
 * bench-enabled simulators, in-page frame/long-task recording, and the metric collector that
 * report.mjs turns into bench/results/<date>.json.
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { launchHopline, showSessions, termTextOf } from '../apps/desktop/e2e/fixtures'
import { makeEosDevice, makeIosDevice, startSim, startTelnetSim, type RunningSim } from '../packages/simulator/src/index.ts'

export const RAW_DIR = join(__dirname, 'results', '.raw')

export type Better = 'lower' | 'higher'
export interface Metric {
  id: string
  value: number
  unit: string
  better: Better
  /** Free-form context (renderer, sample count, …). */
  note?: string
  /** Informational only: never flagged by compare.mjs (e.g. absolute RSS on a shared box). */
  info?: boolean
}

/** Record one metric; every spec appends to the same raw file, report.mjs merges them. */
export function record(m: Metric): void {
  mkdirSync(RAW_DIR, { recursive: true })
  appendFileSync(join(RAW_DIR, 'metrics.jsonl'), JSON.stringify({ ...m, at: Date.now(), load1: loadavg()[0] }) + '\n')
  console.log(`  ${m.id.padEnd(48)} ${fmt(m.value).padStart(10)} ${m.unit}${m.note ? `  (${m.note})` : ''}`)
}

/** Context that applies to the whole run (renderer actually used, GPU status). */
export function context(key: string, value: unknown): void {
  mkdirSync(RAW_DIR, { recursive: true })
  appendFileSync(join(RAW_DIR, 'context.jsonl'), JSON.stringify({ key, value }) + '\n')
}

const fmt = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4))

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[i]!
}
export const median = (xs: number[]): number => percentile(xs, 50)

export interface Lab {
  app: ElectronApplication
  page: Page
  dir: string
  ios: RunningSim
  eos: RunningSim
  termText: () => Promise<string>
  /** Open one more tab on `name` (a seeded session) and wait for its prompt. Returns its tab id. */
  open: (name?: string) => Promise<string>
  close: () => Promise<void>
}

/**
 * Hopline (the built `out/` app, e2e mode: hidden window, in-memory clipboard, stubbed dialogs)
 * with three seeded sessions on bench-enabled simulators: core-sw1 (IOS), dist-sw1 (EOS), telnet.
 */
export async function lab(opts: { env?: Record<string, string>; renderer?: 'webgl' | 'dom' } = {}): Promise<Lab> {
  const ios = await startSim({ device: makeIosDevice(), port: 0, bench: true })
  const eos = await startSim({ device: makeEosDevice(), port: 0, bench: true })
  const telnet = await startTelnetSim({ device: makeIosDevice(), port: 0 })
  const { app, page, dir } = await launchHopline({ seedPorts: `${ios.port},${eos.port},${telnet.port}`, env: opts.env })
  if (opts.renderer === 'dom') await page.evaluate(() => localStorage.setItem('hopline:bench:renderer', 'dom'))
  else await page.evaluate(() => localStorage.removeItem('hopline:bench:renderer'))
  const termText = termTextOf(page)
  const open = async (name = 'core-sw1'): Promise<string> => {
    const before = await tabIds(page)
    await showSessions(page)
    await page.getByRole('treeitem', { name, exact: true }).first().dblclick()
    await expect.poll(async () => (await tabIds(page)).length, { timeout: 15_000 }).toBe(before.length + 1)
    const id = (await tabIds(page)).find((t) => !before.includes(t))!
    const ready = new RegExp(`${name}[#>]\\s*$`)
    const pw = page.locator('[role=dialog] input[type=password]')
    const text = () => page.evaluate((t) => (window as unknown as { __hoplineTest: { tail: (n: number, id: string) => string } }).__hoplineTest.tail(3, t), id)
    await expect.poll(async () => (await pw.isVisible()) || ready.test(await text()), { timeout: 20_000 }).toBe(true)
    if (await pw.isVisible()) {
      await pw.fill('admin')
      await pw.press('Enter')
    }
    await expect.poll(text, { timeout: 20_000 }).toMatch(ready)
    return id
  }
  return {
    app,
    page,
    dir,
    ios,
    eos,
    termText,
    open,
    close: async () => {
      await app.close().catch(() => {})
      await ios.close()
      await eos.close()
      await telnet.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export const tabIds = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __hoplineTest: { tabs: () => string[] } }).__hoplineTest.tabs())

export async function rendererOf(page: Page, tabId: string): Promise<string> {
  return page.evaluate((t) => (window as unknown as { __hoplineTest: { renderer: (id: string) => string | null } }).__hoplineTest.renderer(t) ?? 'none', tabId)
}

/** Settings through the renderer's own API (the same path as the Settings panel). */
export async function setSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => (window as unknown as { hopline: { settings: { update: (p: unknown) => Promise<unknown> } } }).hopline.settings.update(p), patch)
  // The UI store reads settings at load: reload so new tabs pick the patch up (call before opening tabs).
  await page.reload()
  await page.waitForFunction(() => performance.getEntriesByName('hopline:ready').length > 0)
}

/**
 * Installed in the page: a requestAnimationFrame loop recording frame deltas and a long-task
 * observer. `__bench.start()` … `__bench.stop()` returns the raw samples.
 */
export async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __bench?: unknown }
    if (w.__bench) return
    let frames: number[] = []
    let long: number[] = []
    let loaf: number[] = []
    let on = false
    let last = 0
    // One loop per start(): a frame still pending from an earlier run must not double-count.
    let gen = 0
    const loop = (g: number) => (t: number) => {
      if (!on || g !== gen) return
      if (last) frames.push(t - last)
      last = t
      requestAnimationFrame(loop(g))
    }
    new PerformanceObserver((l) => {
      if (on) for (const e of l.getEntries()) long.push(e.duration)
    }).observe({ type: 'longtask', buffered: false })
    // Long animation frames (> 50 ms) also catch rendering work that no single task owns.
    new PerformanceObserver((l) => {
      if (on) for (const e of l.getEntries()) loaf.push(e.duration)
    }).observe({ type: 'long-animation-frame', buffered: false })
    w.__bench = {
      start() {
        frames = []
        long = []
        loaf = []
        last = 0
        on = true
        requestAnimationFrame(loop(++gen))
      },
      stop() {
        on = false
        return { frames, long, loaf }
      }
    }
  })
}

export interface FrameStats {
  frames: number
  p50: number
  p95: number
  p99: number
  max: number
  dropped: number
  longTasks: number
  longTaskMs: number
  longFrames: number
}

/** Frame deltas → percentiles; a frame that took k refresh intervals dropped k-1 frames. */
export function frameStats(raw: { frames: number[]; long: number[]; loaf?: number[] }, refreshMs = 1000 / 60): FrameStats {
  const f = raw.frames
  let dropped = 0
  for (const dt of f) dropped += Math.max(0, Math.round(dt / refreshMs) - 1)
  return {
    frames: f.length,
    p50: percentile(f, 50),
    p95: percentile(f, 95),
    p99: percentile(f, 99),
    max: f.length ? Math.max(...f) : 0,
    dropped,
    longTasks: raw.long.length,
    longTaskMs: raw.long.reduce((a, b) => a + b, 0),
    longFrames: raw.loaf?.length ?? 0
  }
}

export function recordFrames(prefix: string, s: FrameStats, note: string): void {
  record({ id: `${prefix}.frame_p50_ms`, value: s.p50, unit: 'ms', better: 'lower', note })
  record({ id: `${prefix}.frame_p95_ms`, value: s.p95, unit: 'ms', better: 'lower', note })
  record({ id: `${prefix}.frame_p99_ms`, value: s.p99, unit: 'ms', better: 'lower', note })
  record({ id: `${prefix}.dropped_frames_pct`, value: s.frames ? (100 * s.dropped) / (s.frames + s.dropped) : 0, unit: '%', better: 'lower', note })
  record({ id: `${prefix}.long_tasks`, value: s.longTasks, unit: 'count', better: 'lower', note })
  record({ id: `${prefix}.long_task_ms`, value: s.longTaskMs, unit: 'ms', better: 'lower', note })
  record({ id: `${prefix}.long_animation_frames`, value: s.longFrames, unit: 'count', better: 'lower', note })
}

/** Per-process memory from Electron (workingSetSize is RSS on Linux), in MB. */
export async function processMemory(app: ElectronApplication): Promise<{ main: number; renderer: number; host: number; gpu: number; other: number; total: number }> {
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? '', service: m.serviceName ?? '', kb: m.memory.workingSetSize })))
  const out = { main: 0, renderer: 0, host: 0, gpu: 0, other: 0, total: 0 }
  for (const m of metrics) {
    const mb = m.kb / 1024
    out.total += mb
    if (m.type === 'Browser') out.main += mb
    else if (m.type === 'Tab') out.renderer += mb
    else if (m.type === 'Utility' && /session|hopline|node/i.test(`${m.name} ${m.service}`)) out.host += mb
    else if (m.type === 'GPU') out.gpu += mb
    else out.other += mb
  }
  return out
}

export interface FloodResult {
  bytes: number
  ms: number
  raw: { frames: number[]; long: number[] }
}

/** Send `cmd` to the tab and resolve once at least `minBytes` arrived and the prompt is back on screen. */
export async function runFlood(page: Page, tabId: string, cmd: string, minBytes: number, prompt = 'core-sw1#'): Promise<FloodResult> {
  await installRecorder(page)
  return page.evaluate(
    async ([id, command, min, p]) => {
      type T = { raw: (id: string) => import('@xterm/xterm').Terminal }
      const term = (window as unknown as { __hoplineTest: T }).__hoplineTest.raw(id)
      const bench = (window as unknown as { __bench: { start: () => void; stop: () => { frames: number[]; long: number[] } } }).__bench
      const api = (window as unknown as { hopline: { term: { onData: (cb: (t: string, d: string) => void) => () => void; write: (t: string, d: string) => void } } }).hopline.term
      let bytes = 0
      const off = api.onData((t, d) => {
        if (t === id) bytes += d.length
      })
      const atPrompt = () => {
        const b = term.buffer.active
        return (b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '').trimEnd().endsWith(p)
      }
      bench.start()
      const t0 = performance.now()
      api.write(id, command + '\r')
      await new Promise<void>((resolve) => {
        const d = term.onWriteParsed(() => {
          if (bytes >= min && atPrompt()) {
            d.dispose()
            resolve()
          }
        })
      })
      // The final screen is painted on the next frame.
      await new Promise((r) => requestAnimationFrame(r))
      const ms = performance.now() - t0
      off()
      return { bytes, ms, raw: bench.stop() }
    },
    [tabId, cmd, minBytes, prompt] as const
  )
}

