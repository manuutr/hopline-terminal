import type { ElectronApplication, Page } from '@playwright/test'
import { MOD, expect, showSessions, test, keyLabel } from './fixtures'

const termOptions = (page: Page) =>
  page.evaluate(() => (window as unknown as { __hoplineTest: { options: () => { fontSize: number; cursorStyle: string; background?: string } | null } }).__hoplineTest.options())
const notes = (app: ElectronApplication) => app.evaluate(() => [...((globalThis as { __hoplineNotes?: { kind: string; title: string; body: string }[] }).__hoplineNotes ?? [])])

test('settings search finds any setting and lands on its row; openSettings and hopline:// deep links do too', async ({ hop }) => {
  const { page, app } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  const search = dlg.getByTestId('settings-search')
  await search.fill('anti-idle')
  const results = dlg.getByRole('listbox', { name: 'Matching settings' })
  await expect(results.getByRole('option').first()).toContainText('Keep-alive')
  await expect(results.getByRole('option').first()).toContainText('Connections')
  await search.press('Enter')
  // Landed: the row is visible, flashed and its control focused.
  const row = dlg.locator('[data-setting-key="keepAliveSec"]')
  await expect(row).toBeInViewport()
  await expect(dlg.getByLabel('Keep-alive seconds')).toBeFocused()

  // Shortcuts are searchable too; a hit opens the Keyboard tab on that action.
  await search.fill('split right')
  await results.getByRole('option', { name: /Split right/ }).click()
  await expect(dlg.getByRole('tab', { name: 'Keyboard' })).toHaveAttribute('aria-selected', 'true')
  await expect(dlg.locator('[data-action="pane.splitRight"]')).toBeInViewport()

  // No match says so; Esc clears the search before it closes the dialog.
  await search.fill('qqqqzz')
  await expect(dlg.getByRole('status')).toContainText('No settings match')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(dlg).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()

  // The status bar's read-only link names its setting.
  await page.getByTestId('read-only-status').click()
  await expect(dlg.locator('[data-setting-key="aiReadOnly"]')).toBeInViewport()
  await expect(dlg.getByRole('switch', { name: 'Read-only mode' })).toBeFocused()
  await page.keyboard.press('Escape')

  // A deep link from the OS (dev hook: delivered the way open-url / second-instance deliver it).
  await app.evaluate((_e, url) => (globalThis as { __hoplineDeepLink?: (u: string) => void }).__hoplineDeepLink!(url), 'hopline://settings/notifications/notifyDisconnects')
  await expect(dlg).toBeVisible()
  // A link only navigates: the row is shown, its section heading has focus, never the switch (review M7).
  await expect(dlg.locator('[data-setting-key="notifyDisconnects"]')).toBeInViewport()
  await expect(dlg.locator('[data-settings-section="notifications"] [data-settings-heading]')).toBeFocused()
  await page.keyboard.press('Escape')
  // Anything not in the registry is ignored.
  await app.evaluate((_e, url) => (globalThis as { __hoplineDeepLink?: (u: string) => void }).__hoplineDeepLink!(url), 'hopline://connect/evil.example')
  await page.waitForTimeout(300)
  await expect(dlg).toBeHidden()
})

test('per-host overrides: a folder font size and a session theme apply to the open terminal and inherit', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  expect((await termOptions(page))!.fontSize).toBe(13)
  await showSessions(page)
  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Overrides for this folder…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Overrides for Lab (simulator)' })
  const size = dlg.locator('[data-override="termFontSize"]')
  await expect(size.locator('[data-inherited]')).toContainText('13 px · Settings')
  await size.getByRole('switch', { name: 'Override font size' }).click()
  await dlg.getByLabel('Font size override').fill('17')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg).toBeHidden()
  // Applied at once to the open tab.
  await expect.poll(async () => (await termOptions(page))!.fontSize).toBe(17)

  // The session sees the folder value as inherited, and sets its own cursor.
  await page.getByRole('treeitem', { name: 'core-sw1', exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Overrides…' }).click()
  const sdlg = page.getByRole('dialog', { name: 'Overrides for core-sw1' })
  await expect(sdlg.locator('[data-override="termFontSize"] [data-inherited]')).toContainText('17 px · from Lab (simulator)')
  // A session's own logging switch is in the session dialog, not here.
  await expect(sdlg.locator('[data-override="logToFile"]')).toHaveCount(0)
  await sdlg.locator('[data-override="termCursorStyle"]').getByRole('switch').click()
  await sdlg.getByRole('radio', { name: 'Underline' }).click()
  await sdlg.locator('[data-override="termTheme"]').getByRole('switch').click()
  await sdlg.getByLabel('Theme override').selectOption('deep-sea')
  await sdlg.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await termOptions(page))!.cursorStyle).toBe('underline')

  // Kept in main: after a reload the new tab opens with both.
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await hop.connect('core-sw1')
  expect(await termOptions(page)).toMatchObject({ fontSize: 17, cursorStyle: 'underline', background: '#09272d' })
  // Inherit all on the folder puts the global size back.
  await showSessions(page)
  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Overrides for this folder…' }).click()
  await dlg.getByRole('button', { name: 'Inherit all' }).click()
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await termOptions(page))!.fontSize).toBe(13)
})

test('desktop notifications: an unexpected disconnect is notified (recorded, never shown in tests); the setting turns it off', async ({ hop }) => {
  const { page, app } = hop
  await hop.connect('core-sw1')
  // A drop right after typing reads as the user's own logout: wait out that window.
  await page.waitForTimeout(10_500)
  await hop.sims.ios.close()
  await expect.poll(async () => (await notes(app)).filter((n) => n.kind === 'disconnect').length, { timeout: 15_000 }).toBe(1)
  const n = (await notes(app)).find((x) => x.kind === 'disconnect')!
  expect(n.title).toBe('Disconnected · core-sw1')

  // Off in Settings: the next drop is not notified.
  await page.evaluate(() => window.hopline.settings.update({ notifyDisconnects: false }))
  await hop.connect('dist-eos1')
  await page.waitForTimeout(10_500)
  await hop.sims.eos.close()
  await page.waitForTimeout(2_000)
  expect((await notes(app)).filter((x) => x.kind === 'disconnect')).toHaveLength(1)
})

test('desktop notifications: an approval waiting is notified once; the card still needs the click', async ({ hop }) => {
  const { page, app } = hop
  hop.llm.ollama.script.push({
    tools: [{ name: 'propose_config_change', arguments: { commands: ['interface Gi1/0/2', 'description E2E-NOTE'], rationale: 'label the port', rollback: ['interface Gi1/0/2', 'no description'], verify: [{ command: 'show running-config interface Gi1/0/2', expect: 'description E2E-NOTE' }] } }]
  })
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  await page.reload()
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+I`)
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await setup.getByRole('radio', { name: 'Ollama' }).click()
  await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
  await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
  await setup.getByRole('button', { name: 'Connect' }).click()
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  await composer.fill('label Gi1/0/2')
  await composer.press('Enter')
  // The approval card is unchanged (safety UX): it still needs the user's click.
  await expect(page.locator('[data-proposal="config"]')).toBeVisible()
  await expect
    .poll(async () => (await notes(app)).filter((n) => n.kind === 'approval'))
    .toEqual([{ kind: 'approval', title: 'Approval waiting · core-sw1', body: 'A change of 2 lines waits for your approval in Hopline Terminal.' }])
})

test('keymap editor: a clash already in the keymap (say, from an older version) is listed and reset in one click', async ({ hop }) => {
  const { page } = hop
  // Written past the editor (which refuses clashes), like a keymap kept from an older version.
  await page.evaluate(() => window.hopline.keymap.set({ 'pane.splitRight': ['Mod+K'] }))
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Keyboard' }).click()
  const banner = dlg.getByTestId('key-conflicts')
  await expect(banner).toContainText('One key does two things')
  await expect(banner).toContainText('Command palette · Split right')
  await banner.getByRole('button', { name: 'Reset mine' }).click()
  await expect(banner).toHaveCount(0)
  await expect(dlg.locator('[data-action="pane.splitRight"]')).toContainText(keyLabel('Mod+D'))
})

test('a failed read says so (with a retry) instead of showing an empty list', async ({ hop }) => {
  const { page, app } = hop
  // Make main's handlers throw, as a locked or corrupt database would.
  await app.evaluate(({ ipcMain }, chs) => {
    for (const c of chs) {
      ipcMain.removeHandler(c)
      ipcMain.handle(c, () => {
        throw new Error('database is locked')
      })
    }
  }, ['knownHosts:list', 'audit:list'])
  const palette = async (q: string) => {
    await page.keyboard.press(`${MOD}+K`)
    const pal = page.getByRole('dialog', { name: 'Command palette' })
    await expect(pal).toBeVisible()
    await pal.getByRole('combobox').fill(q)
    await expect(pal.getByRole('option').first()).toContainText(new RegExp(q, 'i'))
    await page.keyboard.press('Enter')
  }
  await palette('known hosts')
  const kh = page.getByRole('dialog', { name: 'Known hosts' })
  await expect(kh.getByRole('alert')).toContainText('Could not read known hosts: database is locked')
  await expect(kh.getByText('No trusted hosts yet')).toHaveCount(0)
  await expect(kh.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(kh).toBeHidden()
  await palette('open audit log')
  const audit = page.getByRole('dialog', { name: 'AI audit log' })
  await expect(audit.getByRole('alert')).toContainText('Could not read the audit log: database is locked')
  await expect(audit.getByText('Nothing yet')).toHaveCount(0)
})

test('sessions that cannot be read show an error in the sidebar and the launcher, never "No sessions yet"', async ({ hop }) => {
  const { page, app } = hop
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('sessions:list')
    ipcMain.handle('sessions:list', () => {
      throw new Error('database disk image is malformed')
    })
  })
  await page.reload()
  await expect(page.getByTestId('tree-load-error')).toContainText('Could not read your sessions: database disk image is malformed')
  await expect(page.getByText(/^No sessions yet/)).toHaveCount(0)
  await expect(page.locator('[data-launcher]').getByRole('alert')).toContainText('Quick connect still works')
})
