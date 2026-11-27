import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Names every test that passed only on a retry (CI allows one), so a flake is never hidden by the
 * green check. It prints them, writes test-results/flaky.json, adds a table to the GitHub job
 * summary and a warning annotation per test. A flaky test is a bug to fix: see docs/BACKLOG.md.
 */
export default class FlakyReporter implements Reporter {
  private flaky: { title: string; file: string; line: number; errors: string[] }[] = []
  private firstErrors = new Map<TestCase, string[]>()

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'passed' && result.status !== 'skipped' && result.retry === 0) {
      // eslint-disable-next-line no-control-regex
      const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
      this.firstErrors.set(test, result.errors.map((e) => plain(e.message ?? '').split('\n')[0]!.slice(0, 300)))
    }
  }

  onEnd(_result: FullResult): void {
    for (const [test, errors] of this.firstErrors) {
      if (test.outcome() !== 'flaky') continue
      this.flaky.push({ title: test.titlePath().filter(Boolean).join(' › '), file: test.location.file, line: test.location.line, errors })
    }
    const out = join(__dirname, '../../test-results/flaky.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(this.flaky, null, 2))
    if (this.flaky.length === 0) return
    console.log(`\n${this.flaky.length} flaky test(s): failed, then passed on retry. Fix them; a retry is not a pass.`)
    for (const f of this.flaky) {
      console.log(`  ${f.title} (${f.file}:${f.line})\n    first failure: ${f.errors[0] ?? '?'}`)
      if (process.env['GITHUB_ACTIONS']) console.log(`::warning file=${f.file},line=${f.line},title=Flaky e2e test::${f.title}: ${(f.errors[0] ?? '').replace(/[\r\n]/g, ' ')}`)
    }
    const summary = process.env['GITHUB_STEP_SUMMARY']
    if (summary) {
      const rows = this.flaky.map((f) => `| ${f.title.replace(/\|/g, '\\|')} | \`${(f.errors[0] ?? '').replace(/[|`]/g, ' ')}\` |`)
      appendFileSync(summary, `\n### Flaky e2e tests (${process.platform})\n\n| Test | First failure |\n|---|---|\n${rows.join('\n')}\n`)
    }
  }

  printsToStdio(): boolean {
    return false
  }
}
