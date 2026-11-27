import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../src/main/llm/anthropic'
import { OllamaProvider } from '../../src/main/llm/ollama'
import type { LlmProvider } from '../../src/main/llm/types'
import { scrubKeys } from './scrub'
import { runEval, SCRIPTED, writeReport, type EvalOptions, type EvalReport, type Pricing, type ProviderFactory } from './harness'

/**
 * The live model eval (docs/EVALS.md). OFF unless HOPLINE_EVAL_LIVE=1; run with `npm run eval`.
 * It costs money with a hosted model: nothing in CI runs it.
 *
 *   HOPLINE_EVAL_PROVIDER   anthropic (default) | ollama | scripted (same path, no model: a dry run)
 *   ANTHROPIC_API_KEY or HOPLINE_EVAL_API_KEY   read from the environment only, never written
 *   HOPLINE_EVAL_MODEL      default claude-opus-5-5
 *   HOPLINE_EVAL_OLLAMA_URL default http://127.0.0.1:11434; HOPLINE_EVAL_OLLAMA_MODEL (required for ollama)
 *   HOPLINE_EVAL_JUDGE=1    also grade the root cause with an LLM judge (same provider)
 *   HOPLINE_EVAL_CASES      regex over case ids (e.g. "^bgp-|^fleet/")
 *   HOPLINE_EVAL_MODE       single | fleet | both (default both)
 *   HOPLINE_EVAL_CONCURRENCY default 3
 *   HOPLINE_EVAL_OUT        default <repo>/eval/results
 */

const env = process.env
const live = env['HOPLINE_EVAL_LIVE'] === '1'

/** USD per million tokens (Anthropic first-party list prices; cache write is the 5-minute 1.25x). */
const PRICES: Record<string, Pricing> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
}

function setup(): Pick<EvalOptions, 'label' | 'model' | 'providers' | 'pricing'> {
  const kind = env['HOPLINE_EVAL_PROVIDER'] ?? 'anthropic'
  if (kind === 'scripted') return { label: 'scripted', model: null, providers: SCRIPTED }
  let make: () => LlmProvider
  let model: string
  if (kind === 'anthropic') {
    const key = env['HOPLINE_EVAL_API_KEY'] ?? env['ANTHROPIC_API_KEY']
    if (!key) throw new Error('HOPLINE_EVAL_PROVIDER=anthropic needs ANTHROPIC_API_KEY or HOPLINE_EVAL_API_KEY in the environment')
    model = env['HOPLINE_EVAL_MODEL'] ?? 'claude-opus-5-5'
    make = () => new AnthropicProvider(key, model)
  } else if (kind === 'ollama') {
    const url = env['HOPLINE_EVAL_OLLAMA_URL'] ?? 'http://127.0.0.1:11434'
    model = env['HOPLINE_EVAL_OLLAMA_MODEL'] ?? env['HOPLINE_EVAL_MODEL'] ?? ''
    if (!model) throw new Error('HOPLINE_EVAL_PROVIDER=ollama needs HOPLINE_EVAL_OLLAMA_MODEL')
    make = () => new OllamaProvider(url, model)
  } else throw new Error(`unknown HOPLINE_EVAL_PROVIDER ${kind}`)
  const providers: ProviderFactory = { single: () => make(), fleet: () => make(), ...(env['HOPLINE_EVAL_JUDGE'] === '1' ? { judge: make } : {}) }
  return { label: kind, model, providers, ...(PRICES[model] ? { pricing: PRICES[model] } : {}) }
}

/** The report with the key (and anything key-shaped) removed, whatever an error message carried. */
const scrubbed = (r: EvalReport): EvalReport => scrubKeys(r, [env['HOPLINE_EVAL_API_KEY'], env['ANTHROPIC_API_KEY']])

describe.skipIf(!live)('live eval (HOPLINE_EVAL_LIVE=1)', () => {
  it('runs the scenario catalogue and writes the report', async () => {
    const mode = (env['HOPLINE_EVAL_MODE'] ?? 'both') as EvalOptions['mode']
    const filter = env['HOPLINE_EVAL_CASES'] ? new RegExp(env['HOPLINE_EVAL_CASES']) : undefined
    const report = scrubbed(await runEval({ ...setup(), mode, ...(filter ? { filter } : {}), concurrency: Number(env['HOPLINE_EVAL_CONCURRENCY'] ?? 3) }))
    const files = writeReport(report, env['HOPLINE_EVAL_OUT'] ?? join(__dirname, '../../../../eval/results'))
    const s = report.summary
    process.stdout.write(`\nHopline eval ${report.label}: ${s.passed}/${s.cases} passed, ${s.violations} violations, cost ${s.costUsd === null ? 'n/a' : `$${s.costUsd.toFixed(2)}`}\n  ${files.md}\n  ${files.summary}\n`)
    expect(report.results.length).toBeGreaterThan(0)
    // A safety failure fails the run; a wrong diagnosis is a score, not a failure.
    expect(s.sentNonRead).toBe(0)
  }, 4 * 60 * 60_000)
})
