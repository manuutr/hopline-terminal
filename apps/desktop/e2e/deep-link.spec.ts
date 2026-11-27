import { MOD, expect, test } from './fixtures'

/**
 * Review M7: a hopline:// link may only navigate. It opens Settings on the row, but focus goes to
 * the section heading, so a stray Space after the link (the user was typing in a terminal) can
 * never flip a switch that saves at once (crash reports, update checks).
 */
const deliver = (app: import('@playwright/test').ElectronApplication, url: string) =>
  app.evaluate((_e, u) => (globalThis as { __hoplineDeepLink?: (x: string) => void }).__hoplineDeepLink!(u), url)

test('a deep link followed by Space changes no setting; focus is on the section heading', async ({ hop }) => {
  const { page, app } = hop
  const before = await page.evaluate(() => window.hopline.settings.get())
  const dlg = page.getByRole('dialog', { name: 'Settings' })

  for (const [url, section, key] of [
    ['hopline://settings/crash/crashReports', 'crash', 'crashReports'],
    ['hopline://settings/updates/updateAutoCheck', 'updates', 'updateAutoCheck'],
    ['hopline://settings/updates/updateChannel', 'updates', 'updateChannel']
  ] as const) {
    await deliver(app, url)
    await expect(dlg).toBeVisible()
    await expect(dlg.locator(`[data-setting-key="${key}"]`)).toBeInViewport()
    const heading = dlg.locator(`[data-settings-section="${section}"] [data-settings-heading]`)
    await expect(heading).toBeFocused()
    // No control inside the landed row has focus.
    expect(await page.evaluate((k) => !!document.activeElement?.closest(`[data-setting-key="${k}"]`), key)).toBe(false)
    await page.keyboard.press('Space')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape')
    await expect(dlg).toBeHidden()
  }

  const after = await page.evaluate(() => window.hopline.settings.get())
  expect({ crashReports: after.crashReports, updateAutoCheck: after.updateAutoCheck, updateChannel: after.updateChannel }).toEqual({
    crashReports: before.crashReports,
    updateAutoCheck: before.updateAutoCheck,
    updateChannel: before.updateChannel
  })
})

test('an in-app link (not a deep link) still focuses the control', async ({ hop }) => {
  const { page } = hop
  await page.getByTestId('read-only-status').click()
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await expect(dlg.getByRole('switch', { name: 'Read-only mode' })).toBeFocused()
})

test('settings search: a combobox with an active option; Enter that ends an IME composition is not a pick', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  const search = dlg.getByTestId('settings-search')
  await search.fill('log')
  await expect(search).toHaveAttribute('role', 'combobox')
  await expect(search).toHaveAttribute('aria-expanded', 'true')
  await expect(search).toHaveAttribute('aria-activedescendant', 'settings-hit-0')
  await search.press('ArrowDown')
  await expect(search).toHaveAttribute('aria-activedescendant', 'settings-hit-1')
  await expect(dlg.locator('#settings-hit-1')).toHaveAttribute('aria-selected', 'true')
  // An IME composition ends with Enter (isComposing): the search stays open.
  await search.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
  await page.waitForTimeout(200)
  await expect(search).toHaveValue('log')
  await expect(dlg.getByRole('listbox', { name: 'Matching settings' })).toBeVisible()
  // A plain Enter picks the active option.
  await search.press('Enter')
  await expect(search).toHaveValue('')
  await expect(search).toHaveAttribute('aria-expanded', 'false')
})
