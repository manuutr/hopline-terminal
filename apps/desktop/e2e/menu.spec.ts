import type { Page } from '@playwright/test'
import { axeCheck } from './support/axe'
import { expect, showSessions, sizeWindow, test } from './fixtures'

/**
 * The in-app menu bar (Windows and Linux; macOS uses the native menu, built by the same tree and
 * unit-tested in test/menu.test.ts) and the context menus. Everything runs hidden; clipboard and
 * dialogs are the e2e stand-ins.
 */
test.skip(process.platform === 'darwin', 'macOS has the native menu bar')

const bar = (page: Page) => page.locator('[data-menubar]')
const openMenu = (page: Page, id: string) => page.locator(`[data-menu="${id}"]`)
const cmd = (page: Page, id: string) => page.locator(`[data-menu-content] [data-command="${id}"]`)

/** Open a top-level menu by mouse, once the previous one has finished closing (a person's pace). */
async function openTop(page: Page, name: string): Promise<void> {
  await expect(page.locator('[data-menu-content]')).toHaveCount(0)
  await bar(page).getByRole('menuitem', { name, exact: true }).click()
  await expect(page.locator('[data-menu-content]')).toBeVisible()
}

async function tapAlt(page: Page): Promise<void> {
  await page.keyboard.down('Alt')
  await page.keyboard.up('Alt')
}

test('menu bar: inline at 1440 px, the ≡ button when narrow, roles for assistive technology', async ({ hop }) => {
  const { app, page } = hop
  await expect(bar(page)).toHaveAttribute('role', 'menubar')
  for (const name of ['File', 'Edit', 'View', 'Session', 'AI', 'Window', 'Help']) await expect(bar(page).getByRole('menuitem', { name, exact: true })).toBeVisible()
  // Every trigger is out of the drag region (a click would move the window otherwise).
  expect(await bar(page).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  await sizeWindow(app, page, 1100, 700)
  await expect(bar(page).getByRole('menuitem', { name: 'Application menu' })).toBeVisible()
  await expect(bar(page).getByRole('menuitem', { name: 'File', exact: true })).toHaveCount(0)
  await bar(page).getByRole('menuitem', { name: 'Application menu' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'View' })).toBeVisible()
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: `${process.env['HOPLINE_SHOTS']}/compact-menu.png` })
  await page.getByRole('menuitem', { name: 'Find a command…' }).click()
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeFocused()
  await page.keyboard.press('Escape')
  await sizeWindow(app, page, 1440, 900)
  await expect(bar(page).getByRole('menuitem', { name: 'File', exact: true })).toBeVisible()
})

test('menu bar: Alt tap focuses it, arrows move, a mnemonic opens a menu, Esc gives the keyboard back', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const inTerm = () => page.evaluate(() => !!document.activeElement?.closest('.xterm'))
  await expect.poll(inTerm).toBe(true)
  await tapAlt(page)
  await expect(bar(page).getByRole('menuitem', { name: 'File', exact: true })).toBeFocused()
  // The mnemonics are underlined while the bar has the keyboard.
  await expect(bar(page).locator('.underline').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(bar(page).getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect.poll(inTerm).toBe(true)
  // Alt then V: the View menu, then its items by arrow keys; Esc closes it and keeps the bar.
  await tapAlt(page)
  await page.keyboard.press('v')
  await expect(openMenu(page, 'view')).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(openMenu(page, 'view').locator('[data-highlighted]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(openMenu(page, 'view')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect.poll(inTerm).toBe(true)
  // An Alt+letter chord is the device's (word motion), never a menu.
  await page.keyboard.press('Alt+f')
  await expect(page.locator('[data-menu-content]')).toHaveCount(0)
  await expect.poll(inTerm).toBe(true)
})

test('menu bar: a command runs through the same gate as its key; disabled items without a tab', async ({ hop }) => {
  const { page } = hop
  // No tab: session commands are disabled.
  await openTop(page, 'Session')
  for (const id of ['session.reconnect', 'session.duplicate', 'terminal.sendBreak', 'backups.takeActive']) await expect(cmd(page, id)).toHaveAttribute('data-disabled', '')
  await page.keyboard.press('Escape')
  // View › Command palette opens the palette, like Mod+K.
  await openTop(page, 'View')
  await expect(cmd(page, 'palette.open')).toContainText(/Ctrl\+Shift\+K|⌘K/)
  await cmd(page, 'palette.open').click()
  await expect(page.getByRole('dialog').getByPlaceholder(/Connect to a session/)).toBeVisible()
  await page.keyboard.press('Escape')
  // With a tab, they are enabled; Session › Duplicate tab opens a second tab of the session.
  await hop.connect('core-sw1')
  await openTop(page, 'Session')
  await expect(cmd(page, 'session.duplicate')).not.toHaveAttribute('data-disabled', '')
  await cmd(page, 'session.duplicate').click()
  await expect(page.locator('[role=tab][data-ws-id]')).toHaveCount(2)
  // The Window menu lists the tabs; the active one is checked.
  await openTop(page, 'Window')
  await expect(openMenu(page, 'window').locator('[data-command="tab.activate"]')).toHaveCount(2)
  await expect(openMenu(page, 'window').locator('[data-command="tab.activate"][data-state=checked]')).toHaveCount(1)
  await page.keyboard.press('Escape')
})

test('menu bar: the read-only checkbox follows the setting and toggles it; a modal blocks menu commands', async ({ hop }) => {
  const { page } = hop
  const readOnly = () => page.evaluate(async () => (await (window as unknown as { hopline: { settings: { get: () => Promise<{ aiReadOnly: boolean }> } } }).hopline.settings.get()).aiReadOnly)
  expect(await readOnly()).toBe(true)
  await openTop(page, 'Session')
  const item = cmd(page, 'ai.readOnly')
  await expect(item).toHaveAttribute('role', 'menuitemcheckbox')
  await expect(item).toHaveAttribute('aria-checked', 'true')
  await item.click()
  await expect.poll(readOnly).toBe(false)
  await openTop(page, 'Session')
  await expect(cmd(page, 'ai.readOnly')).toHaveAttribute('aria-checked', 'false')
  await cmd(page, 'ai.readOnly').click()
  await expect.poll(readOnly).toBe(true)
  // The same gate as keys: behind a modal dialog a menu command (from main) does nothing.
  await page.evaluate(() => (window as unknown as { hopline: { app: { info: () => Promise<unknown> } } }).hopline.app.info())
  await openTop(page, 'Help')
  await cmd(page, 'app.about').click()
  const about = page.getByRole('dialog', { name: 'About Hopline Terminal' })
  await expect(about).toBeVisible()
  await expect(about.locator('[data-about]')).toContainText(/Electron\s*\d+/)
  await about.getByRole('button', { name: 'Copy version info' }).click()
  expect(await page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get: () => string } } }).__hoplineTest.clipboard.get())).toMatch(/^Version: .+\nElectron: /)
  const ran = await page.evaluate(() => {
    // What a native menu click sends: refused while a dialog is up.
    return (window as unknown as { __hoplineMenu?: (c: unknown) => boolean }).__hoplineMenu?.({ id: 'ai.readOnly' })
  })
  expect(ran).toBe(false)
  expect(await readOnly()).toBe(true)
  await page.keyboard.press('Escape')
  await expect(about).toHaveCount(0)
  // Unknown ids and missing arguments are refused outright.
  expect(await page.evaluate(() => (window as unknown as { __hoplineMenu: (c: unknown) => boolean }).__hoplineMenu({ id: 'settings.update' }))).toBe(false)
  expect(await page.evaluate(() => (window as unknown as { __hoplineMenu: (c: unknown) => boolean }).__hoplineMenu({ id: 'session.openRecent' }))).toBe(false)
})

test('menu bar: Edit acts on the element that had the keyboard (copy from the terminal, paste into a field)', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.evaluate(() => {
    const t = (window as unknown as { __hoplineTest: { raw: () => { selectAll: () => void } | null } }).__hoplineTest.raw()
    t?.selectAll()
  })
  await openTop(page, 'Edit')
  await cmd(page, 'edit.copy').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get: () => string } } }).__hoplineTest.clipboard.get())).toContain('core-sw1#')
  // Paste into the session search field.
  await showSessions(page)
  await page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { set: (t: string) => void } } }).__hoplineTest.clipboard.set('dist'))
  await page.locator('#session-search').focus()
  await openTop(page, 'Edit')
  // A field has the keyboard: Undo is for it.
  await expect(cmd(page, 'edit.undo')).not.toHaveAttribute('data-disabled', '')
  await cmd(page, 'edit.paste').click()
  await expect(page.locator('#session-search')).toHaveValue('dist')
  await expect(page.locator('#session-search')).toBeFocused()
})

test('menus pass axe (menubar, menu, menuitem roles), in both themes', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await openTop(page, 'View')
  await openMenu(page, 'view').getByRole('menuitem', { name: 'Theme' }).hover()
  await expect(page.locator('[data-command="view.theme.system"]')).toBeVisible()
  await axeCheck(page, 'menu bar (View › Theme)')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.locator('[data-terminal-area] .xterm').first().click({ button: 'right', position: { x: 200, y: 60 } })
  await expect(page.getByRole('menu')).toBeVisible()
  await axeCheck(page, 'terminal context menu')
  await page.keyboard.press('Escape')
})

test('context menus: terminal (copy, paste, clear), tab (close others, close below), session tree', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const term = page.locator('[data-terminal-area] .xterm').first()
  await term.click({ button: 'right', position: { x: 200, y: 60 } })
  const menu = page.getByRole('menu')
  for (const name of ['Copy', 'Paste', 'Paste to device…', 'Select all', 'Find…', 'Clear scrollback', 'Explain selection', 'Split right', 'Split down', 'Close pane']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible()
  // No selection: Copy and Explain are disabled.
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveAttribute('data-disabled', '')
  await menu.getByRole('menuitem', { name: 'Select all', exact: true }).click()
  await term.click({ button: 'right', position: { x: 200, y: 60 } })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Copy', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get: () => string } } }).__hoplineTest.clipboard.get())).toContain('core-sw1#')
  // Paste to device… always asks first, with what is about to be sent.
  await page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { set: (t: string) => void } } }).__hoplineTest.clipboard.set('show clock'))
  await term.click({ button: 'right', position: { x: 200, y: 60 } })
  await page.getByRole('menu').getByRole('menuitem', { name: /^Paste to device/ }).click()
  const confirm = page.getByRole('dialog', { name: 'Paste a line into core-sw1?' })
  await expect(confirm).toContainText('show clock')
  await confirm.getByRole('button', { name: 'Cancel' }).click()

  // Tabs: two more, then Close others from the first one's menu.
  await showSessions(page)
  await hop.connect('dist-eos1')
  await showSessions(page)
  await openTop(page, 'Session')
  await cmd(page, 'session.duplicate').click()
  await expect(page.locator('[data-menu-content]')).toHaveCount(0)
  await expect.poll(hop.termText).toMatch(/dist-eos1#\s*$/)
  const tabs = page.locator('[role=tab][data-ws-id]')
  await expect(tabs).toHaveCount(3)
  await tabs.nth(0).click({ button: 'right' })
  for (const name of ['Rename…', 'Duplicate', 'Reconnect', 'Close others', 'Close tabs below', 'Close tab']) await expect(page.getByRole('menu').getByRole('menuitem', { name, exact: true })).toBeVisible()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Close tabs below', exact: true }).click()
  // One question for both live sessions, not one per tab.
  const ask = page.getByRole('dialog', { name: 'Close 2 tabs?' })
  await ask.getByRole('button', { name: 'Close tabs' }).click()
  await expect(tabs).toHaveCount(1)
  // Rename: the tab shows the new name.
  await tabs.nth(0).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('core uplink check')
  await page.keyboard.press('Enter')
  await expect(tabs.nth(0)).toHaveAccessibleName('core uplink check')

  // Session tree: the same look, no icon per row, shortcuts right-aligned.
  await showSessions(page)
  await page.getByRole('treeitem', { name: /dist-eos1/ }).first().click({ button: 'right' })
  const tree = page.getByRole('menu')
  for (const name of ['Connect', 'Connect in split', 'Edit…', 'Duplicate', 'Overrides…', 'Back up config', 'Delete…']) await expect(tree.getByRole('menuitem', { name, exact: true })).toBeVisible()
  expect(await tree.locator('[role=menuitem] svg:not(.lucide-chevron-right)').count()).toBe(0)
  await page.keyboard.press('Escape')
})

test('double-click on empty title bar space maximises the window (Linux; Windows and macOS do it natively)', async ({ hop }) => {
  test.skip(process.platform !== 'linux', 'the OS handles it on Windows and macOS')
  const { app, page } = hop
  // Recorded, not done: a maximised test window would leave its off-screen spot and cover the desktop.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    const calls: string[] = []
    ;(globalThis as { __maxCalls?: string[] }).__maxCalls = calls
    w.maximize = () => void calls.push('maximize')
    w.unmaximize = () => void calls.push('unmaximize')
  })
  const calls = () => app.evaluate(() => (globalThis as { __maxCalls?: string[] }).__maxCalls ?? [])
  const box = await page.locator('[data-titlebar-drag]').boundingBox()
  await page.mouse.dblclick(box!.x + box!.width - 20, box!.y + 10)
  await expect.poll(calls).toEqual(['maximize'])
  // A double-click on a control is that control's, not the bar's.
  await page.getByRole('button', { name: 'Toggle assistant' }).dblclick()
  await expect.poll(calls).toEqual(['maximize'])
})
