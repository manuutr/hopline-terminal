import { MOD, expect, showSessions, test, sizeWindow } from './fixtures'

/**
 * Phase 6–8 review, UX P1/P2 at 1100×700: hints are readable, controls keep their own width, the
 * landed flash outlines the row, the sidebar header does not truncate, the font preview shows no
 * tofu boxes, and the theme generator's colour fields are labelled.
 */
test.beforeEach(async ({ hop }) => {
  await sizeWindow(hop.app, hop.page, 1100, 700)
})

test('optional tips are hidden until requested and show their full text', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Terminal', exact: true }).click()
  const hint = dlg.locator('[data-setting-key="termAutocomplete"] [data-settings-hint]')
  await expect(hint).toBeHidden()
  await dlg.getByRole('button', { name: 'Show tips' }).click()
  await expect(hint).toBeVisible()
  expect(await hint.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  await dlg.getByRole('button', { name: 'Hide tips' }).click()
  await expect(hint).toBeHidden()
})

test('Updates & privacy: the update-check hint says what GitHub sees (review L6)', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Updates & privacy' }).click()
  const hint = dlg.locator('[data-setting-key="updateAutoCheck"] [data-settings-hint]')
  await expect(hint).toContainText('GitHub sees your IP address and which version you download')
  await expect(hint).not.toContainText('nothing else')
})

test('settings controls keep their own width, left-aligned; the landed flash outlines the row (P2)', async ({ hop }) => {
  const { page, app } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  const width = async (sel: string) => (await dlg.locator(sel).boundingBox())!.width
  await dlg.locator('[data-setting-key="theme"]').scrollIntoViewIfNeeded()
  const theme = dlg.getByRole('radiogroup', { name: 'Theme', exact: true })
  const choicesWidth = await theme.getByRole('radio').evaluateAll((buttons) =>
    buttons.reduce((total, button) => total + button.getBoundingClientRect().width, 0))
  // The four labels determine the width, plus the group's border and padding.
  expect(Math.abs((await theme.boundingBox())!.width - choicesWidth - 6)).toBeLessThan(1)
  expect(await width('[data-setting-key="panelSizes"] button')).toBeLessThan(200)
  await dlg.getByRole('tab', { name: 'Connections' }).click()
  expect(await width('[data-setting-key="autoReconnect"] [role="switch"]')).toBeLessThan(60)
  // Text fields still use the column.
  expect(await width('[data-setting-key="logDir"] input')).toBeGreaterThan(300)
  await page.keyboard.press('Escape')

  await app.evaluate(() => (globalThis as { __hoplineDeepLink?: (u: string) => void }).__hoplineDeepLink!('hopline://settings/notifications/notifyApprovals'))
  const row = dlg.locator('[data-setting-key="notifyApprovals"]')
  await expect(row).toHaveAttribute('data-flash', '')
  expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
})

test('sidebar header and search fit the narrowest sidebar: no "Sessi…" (P2)', async ({ hop }) => {
  const { page } = hop
  // The narrowest sidebar the divider allows (180 px), with a tab open, as in the review's shots.
  await page.evaluate(() => localStorage.setItem('hopline.panelSizes', JSON.stringify({ sidebar: 180 })))
  await page.reload()
  await hop.connect('core-sw1')
  await showSessions(page)
  const box = await page.locator('#session-search').boundingBox()
  expect(box!.width).toBeLessThan(190)
  const title = page.locator('[data-panel-title]').filter({ hasText: 'Sessions' }).first()
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const search = page.locator('#session-search')
  await expect(search).toHaveAttribute('placeholder', 'Search')
  await expect(search).toHaveAccessibleName(/Search sessions/)
  expect(await search.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const tree = page.locator('[data-tree-scroller]')
  expect(await tree.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // The checklist header is whole too.
  const label = page.locator('[data-checklist] button[aria-expanded] span.truncate')
  if (await label.count()) expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // The header's icons are all inside the sidebar.
  const side = (await page.locator('[data-panel-title]').filter({ hasText: 'Sessions' }).first().locator('..').boundingBox())!
  const plus = (await page.getByRole('button', { name: 'New session' }).first().boundingBox())!
  expect(plus.x + plus.width).toBeLessThanOrEqual(side.x + side.width)
})

test('font preview: missing Nerd glyphs are a muted dash, not tofu; the colour fields are labelled (P2)', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()
  await dlg.getByText('Create a theme', { exact: true }).click()
  await expect(dlg.locator('[data-color-field="Base"]')).toContainText('Base')
  await expect(dlg.locator('[data-color-field="Accent"]')).toContainText('Accent')
  const nerd = dlg.locator('[data-check="nerd"]')
  await expect(nerd).not.toContainText('checking')
  // The bundled font has no Nerd glyphs: each one is drawn as "—".
  const glyphs = dlg.locator('[data-nerd-row] [data-glyph]')
  const n = await glyphs.count()
  expect(n).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    const g = glyphs.nth(i)
    if ((await g.getAttribute('data-glyph')) === 'missing') await expect(g).toHaveText(/^—\s*$/)
  }
})
