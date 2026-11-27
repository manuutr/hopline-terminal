import { rmSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { MOD, expect, launchHopline, termTextOf, test } from './fixtures'

const MASTER = 'correct-horse-battery'
let sim: RunningSim
test.beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0 })
})
test.afterAll(() => sim.close())

async function unlockWith(page: Page, pw: string) {
  const dlg = page.getByRole('dialog', { name: 'Unlock Hopline Terminal' })
  await expect(dlg).toBeVisible()
  await dlg.getByLabel('Master password').fill(pw)
  await dlg.getByLabel('Master password').press('Enter')
  return dlg
}

test('master password: set, lock, unlock on connect (wrong password refused), and unlock after a restart', async () => {
  const first = await launchHopline({ seedPorts: `${sim.port},1,1` })
  const { page } = first
  try {
    // Settings → Security → Master password.
    await page.keyboard.press(`${MOD}+Comma`)
    await page.getByRole('tab', { name: 'Security' }).click()
    await page.getByRole('radio', { name: 'Master password' }).click()
    const set = page.getByRole('dialog', { name: 'Set a master password' })
    await set.getByLabel('Master password', { exact: true }).fill(MASTER)
    await set.getByLabel('Repeat it').fill(MASTER)
    await set.getByRole('button', { name: 'Set master password' }).click()
    await expect(set).toBeHidden()
    await expect(page.getByRole('radio', { name: 'Master password' })).toHaveAttribute('aria-checked', 'true')
    // Changing auto-lock needs the current master password, even while unlocked.
    await page.getByLabel('Current master password').fill(MASTER)
    await page.getByRole('spinbutton', { name: 'Auto-lock minutes' }).fill('5')
    await page.getByRole('spinbutton', { name: 'Auto-lock minutes' }).blur()
    await expect(page.getByRole('spinbutton', { name: 'Auto-lock minutes' })).toHaveValue('5')
    await expect(page.getByLabel('Current master password')).toHaveValue('')
    await page.getByRole('button', { name: 'Lock now' }).click()
    await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(page.getByRole('button', { name: 'Unlock vault' })).toBeVisible()

    // Connecting with the seeded (stored) credential asks to unlock first.
    await page.getByText('core-sw1', { exact: true }).first().dblclick()
    const dlg = await unlockWith(page, 'not-the-password')
    await expect(dlg.getByRole('alert')).toContainText('Wrong master password')
    await unlockWith(page, MASTER)
    await expect(dlg).toBeHidden()
    const text = termTextOf(page)
    await expect.poll(text).toMatch(/core-sw1#\s*$/)
    expect(await text()).toContain('authenticated with password')
    await expect(page.locator('[role=dialog] input[type=password]')).toHaveCount(0)

    // Locking keeps the open session running.
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await expect(page.getByRole('button', { name: 'Unlock vault' })).toBeVisible()
    await page.locator('.xterm').first().click()
    await page.keyboard.type('show clock\r')
    await expect.poll(text).toMatch(/show clock[\s\S]*core-sw1#\s*$/)
  } finally {
    await first.app.close()
  }

  // Restart on the same profile: locked at startup, unlocked with the master password.
  const again = await launchHopline({ dir: first.dir, seedPorts: `${sim.port},1,1` })
  try {
    const dlg = await unlockWith(again.page, MASTER)
    await expect(dlg).toBeHidden()
    await expect(again.page.getByRole('button', { name: 'Lock vault' })).toBeVisible()
    await again.page.getByText('core-sw1', { exact: true }).first().dblclick()
    const text = termTextOf(again.page)
    await expect.poll(text).toMatch(/core-sw1#\s*$/)
    await expect(again.page.locator('[role=dialog] input[type=password]')).toHaveCount(0)
  } finally {
    await again.app.close()
    rmSync(first.dir, { recursive: true, force: true })
  }
})
