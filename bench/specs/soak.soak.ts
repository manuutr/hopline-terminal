/**
 * Soak test (docs/PERFORMANCE.md#soak): many tabs on two simulators, and for SOAK_MINUTES a loop of
 * link faults — dropped TCP connections, SSH disconnects, stalled links that only keep-alive can
 * detect, a device refusing connects for a while (reboot), interface flaps with syslog — plus
 * output bursts and tab churn. After every fault each tab must be connected again and answer
 * Enter with a fresh prompt. At the end: no crashed process, no stuck tab, and the RSS slope of
 * main, renderer and session host (linear fit after a warm-up) under the limits.
 *
 *   SOAK_MINUTES=30 npm run soak          (24 h: SOAK_MINUTES=1440)
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtime, type RunningSim } from '../../packages/simulator/src/index.ts'
import { lab, processMemory, setSettings, tabIds, type Lab } from '../lib'

const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 30)
const TABS = Number(process.env['SOAK_TABS'] ?? 10)
/** RSS growth limits (MB per hour of the linear fit), per process. */
const SLOPE_LIMIT = { main: Number(process.env['SOAK_SLOPE_MAIN'] ?? 20), renderer: Number(process.env['SOAK_SLOPE_RENDERER'] ?? 40), host: Number(process.env['SOAK_SLOPE_HOST'] ?? 20) }
/** A tab must be back at a prompt this long after a fault (keep-alive 2 s × 3, backoff 2–8 s). */
const RECOVER_MS = 60_000

type Fault = 'drop' | 'disconnect' | 'stall' | 'reboot' | 'flap' | 'burst' | 'churn'
const FAULTS: Fault[] = ['drop', 'flap', 'disconnect', 'burst', 'stall', 'churn', 'reboot', 'flap']

interface Sample {
  t: number
  main: number
  renderer: number
  host: number
  total: number
}

/** Least-squares slope of y over x (x in hours): MB per hour. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  return den ? num / den : 0
}

const write = (page: Page, tab: string, d: string) => page.evaluate(([id, data]) => (window as unknown as { hopline: { term: { write: (t: string, d: string) => void } } }).hopline.term.write(id, data), [tab, d] as const)

async function installWatch(l: Lab): Promise<void> {
  await l.page.evaluate(() => {
    const st = { state: {} as Record<string, string>, count: {} as Record<string, number> }
    ;(window as unknown as { __soak: typeof st }).__soak = st
    ;(window as unknown as { hopline: { term: { onState: (cb: (i: { tabId: string; state: string }) => void) => void } } }).hopline.term.onState((i) => {
      st.state[i.tabId] = i.state
      st.count[i.state] = (st.count[i.state] ?? 0) + 1
    })
  })
  await l.app.evaluate(({ app }) => {
    const g = globalThis as unknown as { __soakGone: { kind: string; reason: string; name?: string }[] }
    g.__soakGone = []
    app.on('render-process-gone', (_e, _wc, d) => g.__soakGone.push({ kind: 'renderer', reason: d.reason }))
    app.on('child-process-gone', (_e, d) => g.__soakGone.push({ kind: d.type, reason: d.reason, name: d.serviceName ?? d.name }))
  })
}

/** Enter on the tab gives a new prompt line within `ms`. */
async function answers(page: Page, tab: string, ms = 5000): Promise<boolean> {
  // Count line feeds rather than compare cursor rows: once the (small) scrollback is full, the
  // absolute row of the cursor no longer moves.
  await page.evaluate((id) => {
    type T = { onLineFeed: (fn: () => void) => { dispose: () => void } }
    const w = window as unknown as { __hoplineTest: { raw: (id: string) => T }; __soakLf?: { n: number; d: { dispose: () => void } } }
    w.__soakLf?.d.dispose()
    const st = { n: 0, d: { dispose: () => {} } }
    st.d = w.__hoplineTest.raw(id).onLineFeed(() => st.n++)
    w.__soakLf = st
  }, tab)
  await write(page, tab, '\r')
  const deadline = Date.now() + ms
  try {
    while (Date.now() < deadline) {
      const ok = await page.evaluate((id) => {
        type B = { baseY: number; cursorY: number; getLine: (y: number) => { translateToString: (t: boolean) => string } | undefined }
        const w = window as unknown as { __hoplineTest: { raw: (id: string) => { buffer: { active: B } } }; __soakLf: { n: number } }
        const b = w.__hoplineTest.raw(id).buffer.active
        return w.__soakLf.n > 0 && /[\w-]+(\([\w-]+\))?[#>]\s*$/.test(b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '')
      }, tab)
      if (ok) return true
      await page.waitForTimeout(100)
    }
    return false
  } finally {
    await page.evaluate(() => (window as unknown as { __soakLf?: { d: { dispose: () => void } } }).__soakLf?.d.dispose())
  }
}

async function recovered(l: Lab, tabs: string[]): Promise<string[]> {
  const deadline = Date.now() + RECOVER_MS
  let bad = tabs
  while (Date.now() < deadline) {
    const states = await l.page.evaluate(() => (window as unknown as { __soak: { state: Record<string, string> } }).__soak.state)
    const notUp = tabs.filter((t) => states[t] !== undefined && states[t] !== 'connected')
    if (!notUp.length) {
      bad = []
      for (const t of tabs) if (!(await answers(l.page, t))) bad.push(t)
      if (!bad.length) return []
    }
    await l.page.waitForTimeout(1000)
  }
  return bad
}

function flap(sim: RunningSim): void {
  const ifc = sim.device.interfaces.find((i) => /ethernet/i.test(i.name) && i.linkUp)
  if (!ifc) return
  const say = (up: boolean) => {
    ifc.linkUp = up
    sim.events.emit('soak-flap', ifc.name, up)
  }
  say(false)
  setTimeout(() => say(true), 3000)
}

test(`soak: ${MINUTES} min, ${TABS} tabs`, async () => {
  test.setTimeout((MINUTES + 15) * 60_000)
  const l = await lab()
  const log: string[] = []
  const note = (s: string) => {
    const line = `${new Date().toISOString()} ${s}`
    log.push(line)
    console.log(line)
  }
  const samples: Sample[] = []
  const failures: string[] = []
  const counts: Record<string, number> = {}
  const t0 = Date.now()
  try {
    // Fast keep-alive so a stalled link is detected in seconds; auto-reconnect on; a small scrollback
    // that fills within the warm-up, so a growing RSS after it is a leak, not history.
    await setSettings(l.page, { keepAliveSec: 2, autoReconnect: true, termScrollback: 2000 })
    await installWatch(l)
    const sims = { 'core-sw1': l.ios, 'dist-eos1': l.eos }
    const names = Object.keys(sims) as (keyof typeof sims)[]
    const tabs: { id: string; name: keyof typeof sims }[] = []
    for (let i = 0; i < TABS; i++) {
      const name = names[i % names.length]!
      tabs.push({ id: await l.open(name), name })
    }
    // Device syslog for interface flaps: the sims broadcast it to every session.
    for (const sim of [l.ios, l.eos])
      sim.events.on('soak-flap', (name: string, up: boolean) => {
        runtime(sim.device).broadcast(`%LINK-3-UPDOWN: Interface ${name}, changed state to ${up ? 'up' : 'down'}`)
        runtime(sim.device).broadcast(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to ${up ? 'up' : 'down'}`)
      })
    const sample = async () => {
      const m = await processMemory(l.app)
      samples.push({ t: (Date.now() - t0) / 3_600_000, main: m.main, renderer: m.renderer, host: m.host, total: m.total })
    }
    await sample()
    let cycle = 0
    while (Date.now() - t0 < MINUTES * 60_000) {
      const fault = FAULTS[cycle++ % FAULTS.length]!
      counts[fault] = (counts[fault] ?? 0) + 1
      const target = cycle % 2 ? l.ios : l.eos
      switch (fault) {
        case 'drop':
          note(`drop: ${l.ios.faults.drop('close') + l.eos.faults.drop('close')} connections`)
          break
        case 'disconnect':
          note(`disconnect: ${target.faults.drop('disconnect')} connections`)
          break
        case 'stall':
          // Unanswered keep-alives: the client must notice on its own (2 s × 3) and reconnect.
          note(`stall 15 s: ${target.faults.stall(15_000)} connections`)
          await l.page.waitForTimeout(15_000)
          break
        case 'reboot':
          target.faults.refuse(12_000)
          note(`reboot: ${target.faults.drop('close')} dropped, refusing for 12 s`)
          await l.page.waitForTimeout(12_000)
          break
        case 'flap':
          flap(target)
          note('interface flap with syslog')
          break
        case 'burst':
          for (const t of tabs) await write(l.page, t.id, 'bench lines 3000 ansi\r')
          note(`burst: 3000 lines on ${tabs.length} tabs`)
          await l.page.waitForTimeout(5000)
          break
        case 'churn': {
          // Close the oldest tab (its close button), open a new one on the same session.
          const old = tabs.shift()!
          const before = (await tabIds(l.page)).length
          // The oldest tab is first in the bar: select it, close it the user's way (Mod+Shift+W, confirm).
          await l.page.getByRole('tab').first().click()
          await l.page.keyboard.press('Control+Shift+W')
          await l.page.getByRole('dialog').getByRole('button', { name: 'Close tab' }).click()
          await expect.poll(async () => (await tabIds(l.page)).length).toBe(before - 1)
          const live = await tabIds(l.page)
          if (live.includes(old.id)) failures.push('churn: closed the wrong tab')
          tabs.push({ id: await l.open(old.name), name: old.name })
          note(`churn: closed one tab, opened one (${(await tabIds(l.page)).length} terminals)`)
          break
        }
      }
      await l.page.waitForTimeout(2000)
      const bad = await recovered(
        l,
        tabs.map((t) => t.id)
      )
      if (bad.length) {
        failures.push(`after ${fault} (cycle ${cycle}): ${bad.length} tab(s) stuck`)
        note(`STUCK after ${fault}: ${bad.join(', ')}`)
        // Give it a push so one stuck tab doesn't fail every later cycle: Enter reconnects a down tab.
        for (const t of bad) await write(l.page, t, '\r')
      }
      const gone = await l.app.evaluate(() => (globalThis as unknown as { __soakGone: unknown[] }).__soakGone.length)
      if (gone) {
        failures.push(`process gone: ${JSON.stringify(await l.app.evaluate(() => (globalThis as unknown as { __soakGone: unknown[] }).__soakGone))}`)
        break
      }
      await sample()
      // Quiet time between faults, so user-typed Enters don't make the next drop look deliberate.
      await l.page.waitForTimeout(10_000)
    }
    await sample()
    const states = await l.page.evaluate(() => (window as unknown as { __soak: { count: Record<string, number> } }).__soak.count)
    // Linear fit after the first 20% (warm-up: JIT, caches, scrollback filling up).
    const warm = samples.filter((s) => s.t >= (samples.at(-1)!.t * 0.2))
    const fit = (k: 'main' | 'renderer' | 'host' | 'total') =>
      slope(
        warm.map((s) => s.t),
        warm.map((s) => s[k])
      )
    const slopes = { main: fit('main'), renderer: fit('renderer'), host: fit('host'), total: fit('total') }
    const result = {
      minutes: (Date.now() - t0) / 60_000,
      tabs: TABS,
      cycles: cycle,
      faults: counts,
      stateTransitions: states,
      failures,
      slopesMbPerHour: slopes,
      limits: SLOPE_LIMIT,
      rss: { first: samples[0], last: samples.at(-1), max: { main: Math.max(...samples.map((s) => s.main)), renderer: Math.max(...samples.map((s) => s.renderer)), host: Math.max(...samples.map((s) => s.host)) } },
      samples,
      log
    }
    const dir = join(__dirname, '..', 'results')
    mkdirSync(dir, { recursive: true })
    const name = `soak-${new Date().toISOString().slice(0, 10)}-${Math.round(MINUTES)}min`
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(result, null, 2) + '\n')
    const r = (n: number) => n.toFixed(1)
    writeFileSync(
      join(dir, `${name}.md`),
      `# Soak ${name}\n\n${r(result.minutes)} min, ${TABS} tabs on two simulators, ${cycle} fault cycles: ${Object.entries(counts).map(([k, v]) => `${k} × ${v}`).join(', ')}.\n\n` +
        `State changes seen by the renderer: ${Object.entries(states).map(([k, v]) => `${k} ${v}`).join(', ')}.\n\n` +
        `| Process | first MB | last MB | max MB | slope MB/h | limit |\n|---|---:|---:|---:|---:|---:|\n` +
        (['main', 'renderer', 'host'] as const).map((k) => `| ${k} | ${r(samples[0]![k])} | ${r(samples.at(-1)![k])} | ${r(result.rss.max[k])} | ${r(slopes[k])} | ${SLOPE_LIMIT[k]} |`).join('\n') +
        `\n\nFailures: ${failures.length ? failures.map((f) => `\n- ${f}`).join('') : 'none'}.\n`
    )
    note(`slopes MB/h: ${JSON.stringify(slopes)}; failures: ${failures.length}`)
    expect(failures).toEqual([])
    expect(slopes.main).toBeLessThan(SLOPE_LIMIT.main)
    expect(slopes.renderer).toBeLessThan(SLOPE_LIMIT.renderer)
    expect(slopes.host).toBeLessThan(SLOPE_LIMIT.host)
  } finally {
    await l.close()
  }
})
