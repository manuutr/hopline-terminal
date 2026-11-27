#!/usr/bin/env node
/**
 * Compare two benchmark result files and flag regressions over a threshold (default 15%).
 *
 *   node bench/compare.mjs [current.json] [baseline.json] [--threshold 15]
 *
 * Defaults: the newest bench/results/<date>.json against bench/baseline.json. Exits 1 when a
 * metric regressed. Metrics marked `info` are shown but never flagged, and a change smaller than
 * the unit's noise floor (2 ms, 3 counts, 5 points of %, 25 MB, 1 µs, …) is never a regression: going
 * from 0 to 1 long task is not "infinitely worse".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const { values, positionals: files } = parseArgs({
  allowPositionals: true,
  options: { threshold: { type: 'string', default: '15' } }
})
const threshold = Number(values.threshold)
if (!values.threshold.trim() || !Number.isFinite(threshold) || threshold < 0 || files.length > 2) {
  console.error('Usage: node bench/compare.mjs [current.json] [baseline.json] [--threshold nonnegative-percent]')
  process.exit(2)
}
const newest = () => {
  const dir = join(here, 'results')
  // Newest by time written, not by name (2026-11-25-noise sorts after 2026-11-25-after).
  const f = readdirSync(dir)
    .filter((n) => /^\d{4}-\d\d-\d\d.*\.json$/.test(n))
    .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)
    .at(-1)
  if (!f) throw new Error('no results in bench/results')
  return join(dir, f)
}
const curPath = files[0] ?? newest()
const basePath = files[1] ?? join(here, 'baseline.json')
const cur = JSON.parse(readFileSync(curPath, 'utf8'))
const base = JSON.parse(readFileSync(basePath, 'utf8'))

const FLOOR = { ms: 2, count: 3, '%': 5, MB: 25, 'MB/s': 1, 'µs': 1 }
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3))
const rows = []
let regressions = 0
for (const [id, m] of Object.entries(cur.metrics)) {
  const b = base.metrics[id]
  if (!b || b.value < 0 || m.value < 0) continue
  const delta = m.value - b.value
  const pct = b.value === 0 ? (delta === 0 ? 0 : Infinity) : (100 * delta) / Math.abs(b.value)
  const worse = m.better === 'lower' ? delta > 0 : delta < 0
  const big = Math.abs(delta) >= (FLOOR[m.unit] ?? 0) && Math.abs(pct) > threshold
  const flag = worse && big && !m.info && !b.info
  if (flag) regressions++
  rows.push({ id, base: b.value, cur: m.value, unit: m.unit, pct, flag, better: !worse && big })
}
console.log(`current:  ${curPath}\nbaseline: ${basePath}\nthreshold: ${threshold}%\n`)
for (const r of rows) {
  const mark = r.flag ? 'REGRESSION' : r.better ? 'better' : ''
  const pct = Number.isFinite(r.pct) ? `${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%` : 'new'
  console.log(`${r.id.padEnd(52)} ${fmt(r.base).padStart(9)} → ${fmt(r.cur).padStart(9)} ${r.unit.padEnd(6)} ${pct.padStart(8)}  ${mark}`)
}
console.log(`\n${regressions} regression(s) over ${threshold}%`)
process.exit(regressions ? 1 : 0)
