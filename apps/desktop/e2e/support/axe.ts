import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { waitForWorkspace } from '../fixtures'

/**
 * axe-core checks for the e2e suite (docs/ACCESSIBILITY.md). Each surface is scanned in three
 * themes. Serious and critical violations fail the test unless the allow-list below covers them.
 * Each run appends one line per surface and theme to test-results/axe-report.jsonl.
 */

/**
 * What axe cannot judge or what is inherent, scoped to one rule and one part of the page. Never a
 * rule switched off everywhere. Keep this list short and say why.
 */
export const AXE_ALLOW: { rule: string; selector: string; why: string }[] = []

const REPORT = join(__dirname, '../../test-results/axe-report.jsonl')
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

export async function setTheme(page: Page, theme: 'dark' | 'light' | 'contrast'): Promise<void> {
  await waitForWorkspace(page)
  await page.evaluate(async (t) => {
    await document.fonts.ready
    localStorage.setItem('hopline.theme', t)
    document.documentElement.classList.toggle('dark', t !== 'light')
    document.documentElement.classList.toggle('contrast', t === 'contrast')
    document.documentElement.dataset.theme = t
    document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark'
    window.dispatchEvent(new CustomEvent('hopline:theme', { detail: t }))
    // Measure the final palette even when an off-screen runner delays the first paint.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSTransition) animation.finish()
    }
  }, theme)
}

const allowed = (rule: string, target: string) => AXE_ALLOW.some((a) => a.rule === rule && target.includes(a.selector))

export interface AxeOutcome {
  surface: string
  theme: 'dark' | 'light' | 'contrast'
  counts: Record<string, number>
  failing: string[]
  allowed: string[]
  moderate: string[]
}

/** Scan the page as it is now, in all three themes (dark last, the app default). Fails on serious/critical. */
export async function axeCheck(page: Page, surface: string, opts: { strict?: boolean } = {}): Promise<void> {
  const out: AxeOutcome[] = []
  for (const theme of ['light', 'contrast', 'dark'] as const) {
    await setTheme(page, theme)
    const r = await new AxeBuilder({ page }).setLegacyMode(true).withTags(TAGS).analyze()
    const o: AxeOutcome = { surface, theme, counts: {}, failing: [], allowed: [], moderate: [] }
    for (const v of r.violations) {
      for (const n of v.nodes) {
        const target = n.target.join(' ')
        const line = `${v.impact} ${v.id}: ${target} — ${n.failureSummary?.split('\n').slice(0, 2).join(' ') ?? ''}`
        o.counts[v.impact ?? 'unknown'] = (o.counts[v.impact ?? 'unknown'] ?? 0) + 1
        if (allowed(v.id, target)) o.allowed.push(line)
        else if (v.impact === 'serious' || v.impact === 'critical') o.failing.push(line)
        else o.moderate.push(line)
      }
    }
    out.push(o)
  }
  mkdirSync(dirname(REPORT), { recursive: true })
  for (const o of out) appendFileSync(REPORT, JSON.stringify(o) + '\n')
  const failing = out.flatMap((o) => o.failing.map((f) => `[${o.theme}] ${f}`))
  const moderate = out.flatMap((o) => o.moderate.map((f) => `[${o.theme}] ${f}`))
  if (process.env['HOPLINE_AXE_LOG']) for (const l of [...failing, ...moderate]) console.log(`${surface}: ${l}`)
  if (opts.strict !== false && !process.env['HOPLINE_AXE_EXPLORE']) expect(failing, `${surface}: serious or critical axe violations`).toEqual([])
}
