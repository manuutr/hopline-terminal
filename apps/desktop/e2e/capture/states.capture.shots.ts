/**
 * Safety states that must stay loud in every theme (0.6 redesign): an unknown platform, with the
 * assistant open beside it. Writes `44-platform-unknown-{dark,light}.png`.
 */
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { makeDevice, startSim } from '../../../../packages/simulator/src/index.ts'
import { expect, test } from '../fixtures'
import { OUT, sizeTo } from './narrow'

async function snap(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300)
  for (const t of ['dark', 'light'] as const) {
    await page.evaluate((theme) => {
      localStorage.setItem('hopline.theme', theme)
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.style.colorScheme = theme
      window.dispatchEvent(new CustomEvent('hopline:theme', { detail: theme }))
    }, t)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, `${name}-${t}.png`) })
  }
}

test('platform unknown: AI commands blocked, in the status bar, the tab and the assistant', async ({ hop }) => {
  const { app, page } = hop
  await sizeTo(app, page, 1440, 900)
  const sim = await startSim({ device: makeDevice('routeros'), port: 0 })
  try {
    await page.keyboard.press('Control+Shift+O')
    const input = page.getByRole('textbox', { name: 'Quick connect' })
    await input.fill(`admin@127.0.0.1:${sim.port}`)
    await input.press('Enter')
    const pw = page.locator('[role=dialog] input[type=password]')
    await expect(pw).toBeVisible()
    await pw.fill('admin')
    await pw.press('Enter')
    await expect.poll(hop.termText).toMatch(/\] >\s*$/)
    await expect(page.getByRole('button', { name: /Platform unknown — AI commands blocked · Set platform/ })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Toggle assistant' }).click()
    await expect(page.getByRole('button', { name: 'Toggle assistant' })).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.xterm').first().click()
    await snap(page, '44-platform-unknown')
  } finally {
    await sim.close()
  }
})
