import type { Page } from '@playwright/test'
import { MOD, expect, test } from './fixtures'

/** Count transitions and animations that start from now on (events plus the live animation list). */
const watch = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __motion: { transitions: number; animations: number } }
    w.__motion = { transitions: 0, animations: 0 }
    document.addEventListener('transitionrun', () => w.__motion.transitions++, true)
    document.addEventListener('animationstart', () => w.__motion.animations++, true)
  })
const seen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __motion: { transitions: number; animations: number } }
    return { ...w.__motion, running: document.getAnimations().length }
  })

/** Open and close the surfaces that animate: the palette, a dialog, a menu, a side panel. */
async function exercise(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+K`)
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await expect(dlg).toBeVisible()
  // Hover a nav row (a colour transition when motion is allowed).
  await dlg.getByRole('tab', { name: 'Keyboard' }).hover()
  await dlg.getByRole('tab', { name: 'Keyboard' }).click()
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  // Phase 6 surfaces: the overrides dialog from that menu, the Themes tab, the first-run steps.
  await page.getByRole('menuitem', { name: 'Overrides for this folder…' }).click()
  const ov = page.getByRole('dialog', { name: /Overrides for/ })
  await expect(ov).toBeVisible()
  await ov.locator('[data-override="termFontSize"]').getByRole('switch').click()
  await page.keyboard.press('Escape')
  await expect(ov).toBeHidden()
  await page.keyboard.press(`${MOD}+Comma`)
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()
  await expect(dlg.locator('[data-setting-key="themeLibrary"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  const steps = page.locator('[data-first-run]')
  if (await steps.isVisible()) await steps.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.keyboard.press(`${MOD}+I`)
  await page.waitForTimeout(300)
}

test('reduced motion: opening the palette, a dialog, a menu and a panel runs no transition or animation', async ({ hop }) => {
  const { page } = hop
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await watch(page)
  await exercise(page)
  expect(await seen(page)).toEqual({ transitions: 0, animations: 0, running: 0 })
})

test('without reduced motion the same surfaces do animate, at the 120 and 200 ms chrome durations (the test above is not vacuous)', async ({ hop }) => {
  const { page } = hop
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await watch(page)
  await page.keyboard.press(`${MOD}+K`)
  const durations = await page.evaluate(() =>
    document.getAnimations().map((a) => Number((a.effect as KeyframeEffect | null)?.getTiming().duration ?? 0))
  )
  await page.keyboard.press('Escape')
  await exercise(page)
  const s = await seen(page)
  expect(s.animations + s.transitions).toBeGreaterThan(0)
  for (const d of durations) expect([120, 200]).toContain(d)
})

test('the tab indicator uses the production motion duration and settles on the selected tab', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await hop.connect('dist-eos1')
  for (const [tabName, reduce] of [['core-sw1', false], ['dist-eos1', true]] as const) {
    await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' })
    const tab = page.getByRole('tab', { name: tabName, exact: true })
    const measurement = await tab.evaluate(async (button) => {
      ;(button as HTMLElement).click()
      await new Promise(requestAnimationFrame)
      const face = document.querySelector<HTMLElement>('[data-selection-face="tab"]')!
      const animation = face.getAnimations().find((a) => a.id === 'hopline-layout')
      const duration = Number(animation?.effect?.getTiming().duration ?? 0)
      await animation?.finished
      return { duration, offset: Math.abs(face.getBoundingClientRect().top - button.getBoundingClientRect().top - 6) }
    })
    expect(measurement.duration).toBe(reduce ? 0 : 200)
    expect(measurement.offset).toBeLessThanOrEqual(1)
  }
})
