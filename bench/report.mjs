#!/usr/bin/env node
/**
 * Merge bench/results/.raw/*.jsonl into bench/results/<date>[-label].json and a markdown summary
 * next to it. A metric recorded several times (BENCH_REPEAT, startup runs) is reduced to its best
 * run (lowest, or highest for higher-is-better): on a shared machine interference only ever makes a
 * run slower, so the best run is the stable estimate. Every run is kept in `runs`.
 *
 *   node bench/report.mjs [--label name]
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const raw = join(here, 'results', '.raw')
const args = process.argv.slice(2)
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : ''

const lines = (f) => (existsSync(join(raw, f)) ? readFileSync(join(raw, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const byId = new Map()
for (const m of lines('metrics.jsonl')) {
  const e = byId.get(m.id) ?? { ...m, samples: [], loads: [] }
  e.samples.push(m.value)
  e.loads.push(m.load1)
  e.note = m.note
  byId.set(m.id, e)
}
const metrics = {}
for (const [id, e] of byId) {
  const best = e.better === 'higher' ? Math.max(...e.samples) : Math.min(...e.samples)
  metrics[id] = { value: best, ...(e.samples.length > 2 ? { median: median(e.samples) } : {}), unit: e.unit, better: e.better, ...(e.note ? { note: e.note } : {}), ...(e.info ? { info: true } : {}), ...(e.samples.length > 1 ? { runs: e.samples } : {}), load1: Math.max(...e.loads) }
}
const context = {}
for (const c of lines('context.jsonl')) context[c.key] = c.value

const git = (cmd) => {
  try {
    return execSync(cmd, { cwd: here, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const now = new Date()
const date = now.toISOString().slice(0, 10)
const name = `${date}${label ? `-${label}` : ''}`
const out = {
  date: now.toISOString(),
  label,
  git: { sha: git('git rev-parse --short HEAD'), dirty: git('git status --porcelain').length > 0 },
  machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? '', cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), load1End: loadavg()[0] },
  context,
  metrics
}
const dir = join(here, 'results')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${name}.json`), JSON.stringify(out, null, 2) + '\n')

const targets = JSON.parse(readFileSync(join(here, 'targets.json'), 'utf8'))
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(3))
const groups = new Map()
for (const id of Object.keys(metrics).sort()) {
  const g = id.split('.').slice(0, 2).join('.')
  groups.set(g, [...(groups.get(g) ?? []), id])
}
let md = `# Benchmark results ${name}\n\n`
md += `Commit \`${out.git.sha}\`${out.git.dirty ? ' (uncommitted changes)' : ''}, ${out.machine.platform} ${out.machine.release}, ${out.machine.cpu} × ${out.machine.cores}, ${out.machine.memGb} GB. Load average at the end: ${out.machine.load1End.toFixed(2)}.\n\n`
const renderers = Object.entries(context).filter(([k]) => k.endsWith('.renderer'))
if (renderers.length) md += `Renderer actually used: ${renderers.map(([k, v]) => `${k.replace(/\.renderer$/, '')} = ${v}`).join(', ')}.\n\n`
md += `| Metric | Value | Target | |\n|---|---:|---:|---|\n`
for (const [, ids] of groups)
  for (const id of ids) {
    const m = metrics[id]
    const t = targets[id]
    const ok = t ? (t.op === 'max' ? m.value <= t.limit : m.value >= t.limit) : null
    md += `| \`${id}\` | ${fmt(m.value)} ${m.unit} | ${t ? `${t.op === 'max' ? '≤' : '≥'} ${t.limit}` : ''} | ${ok === null ? '' : ok ? 'met' : '**missed**'} |\n`
  }
writeFileSync(join(dir, `${name}.md`), md)
console.log(`wrote bench/results/${name}.json and .md (${Object.keys(metrics).length} metrics)`)
