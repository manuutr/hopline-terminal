import type { Page } from '@playwright/test'
import type { Session } from '../src/shared/types'
import { treeRow, MOD, expect, test, type Hopline } from './fixtures'

const SHOTS = process.env['HOPLINE_SHOTS']
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

type Api = { hopline: { sessions: { list: () => Promise<{ sessions: Session[]; folders: { id: string; name: string }[] }>; saveFolder: (f: unknown) => Promise<{ id: string }>; bulkUpdate: (ids: string[], p: unknown) => Promise<unknown> } } }
const list = (page: Page) => page.evaluate(() => (window as unknown as Api).hopline.sessions.list())
const byName = async (page: Page, name: string) => (await list(page)).sessions.find((s) => s.name === name)!

const tree = (page: Page) => page.getByRole('tree', { name: 'Sessions' })
/** The row in the folder tree (a session can also show in Favorites and Recent). */
const item = (page: Page, name: string) => treeRow(page, name).and(page.locator('[data-row-key^="tree:"], [data-row-key^="sec:"]'))

/** Answer the password prompt (or not, when the seeded credential works) until the prompt is ready. */
async function login(hop: Hopline, ready = /core-sw1#\s*$/) {
  const pw = hop.page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || ready.test(await hop.termText())).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(hop.termText).toMatch(ready)
}

/** Drag with real pointer events: down, a few moves past the threshold, up. */
async function dragTo(page: Page, from: string, to: string, where: 'center' | 'below' = 'center') {
  const a = (await item(page, from).boundingBox())!
  const b = (await item(page, to).boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 })
  const y = where === 'center' ? b.y + b.height / 2 : b.y + b.height - 2
  await page.mouse.move(b.x + b.width / 2, y, { steps: 6 })
  await page.mouse.up()
}

test('quick connect from the palette reaches the simulator, then "Save as session" keeps it', async ({ hop }) => {
  const { page } = hop
  const target = `admin@127.0.0.1:${hop.sims.ios.port}`
  await page.keyboard.press(`${MOD}+K`)
  await page.getByPlaceholder(/Connect to a session/).fill(target)
  await expect(page.getByRole('option', { name: new RegExp(`Connect to.*${target.replace(/\./g, '\\.')}`) })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await login(hop)
  const tab = page.getByRole('tab', { name: target })
  await expect(tab).toHaveAttribute('data-quick', 'true')
  // Not in the tree, not in the database.
  await expect(item(page, target)).toHaveCount(0)
  expect((await list(page)).sessions.some((s) => s.host === '127.0.0.1' && s.name === target)).toBe(false)
  await shot(page, 'quick-connected')

  await tab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Save as session…' }).click()
  const name = page.getByRole('dialog', { name: 'Save as session' }).getByRole('textbox')
  await name.fill('quick-r1')
  await name.press('Enter')
  await expect(item(page, 'quick-r1')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'quick-r1' })).not.toHaveAttribute('data-quick', 'true')
  const saved = await byName(page, 'quick-r1')
  expect(saved).toMatchObject({ host: '127.0.0.1', port: hop.sims.ios.port, username: 'admin', protocol: 'ssh' })
  expect(saved.id.startsWith('quick-')).toBe(true)
  // The tab kept its connection and now points at the saved session (it shows up in Recent once connected).
  await page.locator('.xterm').first().click()
  await page.keyboard.type('show clock\r')
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
})

test('Mod+O quick connect dialog: errors inline, Enter connects', async ({ hop }) => {
  const { page } = hop
  // Shortcuts work from anywhere; a click at the window's centre would land on whatever is there
  // at the CI's window size (on Windows, a launcher row that opens a dialog), so just drop focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press(`${MOD}+O`)
  const input = page.getByRole('textbox', { name: 'Quick connect' })
  await expect(input).toBeFocused()
  await input.fill('admin:secret@10.0.0.1')
  await expect(page.getByText(/Passwords are not accepted/)).toBeVisible()
  await input.fill(`ssh://admin@127.0.0.1:${hop.sims.ios.port}`)
  await expect(page.getByText(/Connect: SSH · admin@127\.0\.0\.1/)).toBeVisible()
  await shot(page, 'quick-dialog')
  await input.press('Enter')
  await login(hop)
})

test('drag a session into a folder, then two at once, with a drop indicator', async ({ hop }) => {
  const { page } = hop
  await page.evaluate(() => (window as unknown as Api).hopline.sessions.saveFolder({ name: 'Core', parentId: null }))
  await page.reload()
  await expect(item(page, 'Core')).toBeVisible()

  // Indicator while hovering a folder.
  const a = (await item(page, 'dist-eos1').boundingBox())!
  const b = (await item(page, 'Core').boundingBox())!
  await page.mouse.move(a.x + 20, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + 30, a.y + a.height / 2 + 8, { steps: 3 })
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 5 })
  await expect(item(page, 'Core')).toHaveClass(/ring-accent/)
  await expect(page.getByText('Move to Core')).toBeVisible()
  await shot(page, 'drag-indicator')
  await page.mouse.up()

  await expect.poll(async () => (await byName(page, 'dist-eos1')).folderId).toBe((await list(page)).folders.find((f) => f.name === 'Core')!.id)
  await expect(item(page, 'dist-eos1')).toHaveAttribute('aria-level', '2')

  // Multi: select two sessions with the platform modifier and drag them together.
  await item(page, 'core-sw1').click()
  await item(page, 'core-sw1 (telnet)').click({ modifiers: ['ControlOrMeta'] })
  await expect(tree(page).locator('[aria-selected=true]')).toHaveCount(2)
  await dragTo(page, 'core-sw1', 'Core')
  const core = (await list(page)).folders.find((f) => f.name === 'Core')!.id
  await expect.poll(async () => [(await byName(page, 'core-sw1')).folderId, (await byName(page, 'core-sw1 (telnet)')).folderId]).toEqual([core, core])

  // A folder never drops into itself.
  await page.evaluate((parentId) => (window as unknown as Api).hopline.sessions.saveFolder({ name: 'Sub', parentId }), core)
  await page.reload()
  await dragTo(page, 'Core', 'Sub')
  await expect(page.getByText('A folder cannot move into itself')).toBeVisible()
})

test('tags: set from the context menu, colored chips, filter by tag', async ({ hop }) => {
  const { page } = hop
  await item(page, 'core-sw1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Tags…' }).click()
  const box = page.getByRole('dialog', { name: /Tags for core-sw1/ }).getByRole('textbox')
  await box.fill('core, prod')
  await box.press('Enter')
  const eos = await byName(page, 'dist-eos1')
  await page.evaluate((id) => (window as unknown as Api).hopline.sessions.bulkUpdate([id], { addTags: ['prod'] }), eos.id)
  await page.reload()

  await expect(item(page, 'core-sw1')).toHaveAccessibleName(/^core-sw1 .*XE$/)
  const filter = page.getByRole('group', { name: 'Filter by tag' })
  await expect(filter.getByRole('button', { name: 'prod' })).toBeVisible()
  await filter.getByRole('button', { name: 'core' }).click()
  await expect(filter.getByRole('button', { name: 'core' })).toHaveAttribute('aria-pressed', 'true')
  await expect(item(page, 'core-sw1')).toBeVisible()
  await expect(item(page, 'dist-eos1')).toHaveCount(0)
  await expect(item(page, 'core-sw1 (telnet)')).toHaveCount(0)
  await shot(page, 'tag-filter')
  await filter.getByRole('button', { name: 'core' }).click()
  await filter.getByRole('button', { name: 'prod' }).click()
  await expect(tree(page).locator('[role=treeitem]:not([aria-expanded])')).toHaveCount(2)

  // Search matches tags and platform too, with highlighted matches.
  await filter.getByRole('button', { name: 'prod' }).click()
  await page.locator('#session-search').fill('eos')
  await expect(item(page, 'dist-eos1')).toBeVisible()
  await expect(item(page, 'dist-eos1').locator('mark').first()).toHaveText('eos')
  await expect(item(page, 'core-sw1')).toHaveCount(0)
  // A platform id that is not in the row text still shows why the row matched.
  await page.locator('#session-search').fill('iosxe')
  await expect(item(page, 'core-sw1').locator('mark')).toHaveText(['Cisco IOS-XE'])
  await expect(item(page, 'dist-eos1')).toHaveCount(0)
})

test('favorites pin to the top and survive a reload; color shows on the tab', async ({ hop }) => {
  const { page } = hop
  await item(page, 'dist-eos1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click()
  const fav = tree(page).getByRole('treeitem', { name: 'Favorites' })
  await expect(fav).toBeVisible()
  await expect(fav).toHaveAttribute('aria-level', '1')
  // The first session row in the tree is the pinned one.
  await expect(tree(page).getByRole('treeitem').nth(1)).toHaveAccessibleName(/^dist-eos1\b/)
  await expect(tree(page).getByRole('treeitem').nth(1)).toHaveAttribute('data-row-key', /^fav:/)
  await item(page, 'dist-eos1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Color' }).hover()
  await page.getByRole('menuitem', { name: 'Purple' }).click()
  await page.reload()
  await expect(tree(page).getByRole('treeitem', { name: 'Favorites' })).toBeVisible()
  expect(await byName(page, 'dist-eos1')).toMatchObject({ favorite: true, color: 'purple' })
  await hop.connect('dist-eos1')
  await expect(page.getByRole('tab', { name: 'dist-eos1' })).toHaveAttribute('data-color', 'purple')
  // Connecting records it in Recent (stamped by main).
  await expect(tree(page).getByRole('treeitem', { name: 'Recent' })).toBeVisible()
  await expect.poll(async () => (await byName(page, 'dist-eos1')).lastConnectedAt).toBeGreaterThan(0)
  await shot(page, 'favorites-recent')
})

test('bulk edit sets username, platform and folder on several sessions', async ({ hop }) => {
  const { page } = hop
  await page.evaluate(() => (window as unknown as Api).hopline.sessions.saveFolder({ name: 'Ops', parentId: null }))
  await page.reload()
  await item(page, 'core-sw1').click()
  await item(page, 'dist-eos1').click({ modifiers: ['Shift'] })
  await expect(tree(page).locator('[aria-selected=true]')).toHaveCount(3)
  await item(page, 'dist-eos1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit 3 sessions…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Edit 3 sessions' })
  await dlg.getByLabel('Change username').check()
  await dlg.getByRole('textbox', { name: 'Username' }).fill('netops')
  await dlg.getByLabel('Change platform').check()
  await dlg.getByRole('combobox', { name: 'Platform' }).selectOption('nxos')
  await dlg.getByLabel('Change folder').check()
  await dlg.getByRole('combobox', { name: 'Folder' }).selectOption({ label: 'Ops' })
  await dlg.getByRole('textbox', { name: 'Add tags' }).fill('lab')
  await shot(page, 'bulk-edit')
  await dlg.getByRole('button', { name: 'Apply to 3 sessions' }).click()
  await expect(dlg).toBeHidden()
  const ops = (await list(page)).folders.find((f) => f.name === 'Ops')!.id
  for (const n of ['core-sw1', 'dist-eos1', 'core-sw1 (telnet)']) {
    expect(await byName(page, n)).toMatchObject({ username: 'netops', platform: 'nxos', folderId: ops, tags: ['lab'] })
  }
  // Untouched fields stay: the telnet one keeps its port and protocol.
  expect(await byName(page, 'core-sw1 (telnet)')).toMatchObject({ protocol: 'telnet' })
})

test('keyboard: arrows, Shift+arrow, Space, collapse/expand, F2 rename, Enter connects', async ({ hop }) => {
  const { page } = hop
  await page.locator('#session-search').focus()
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'core-sw1')).toBeFocused()
  await expect(item(page, 'core-sw1')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'core-sw1 (telnet)')).toBeFocused()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(item(page, 'dist-eos1')).toBeFocused()
  await expect(tree(page).locator('[aria-selected=true]')).toHaveCount(2)
  await page.keyboard.press('Space')
  await expect(item(page, 'dist-eos1')).toHaveAttribute('aria-selected', 'false')

  // Home → folder; Left collapses, Right expands, Right again enters the first child.
  await page.keyboard.press('Home')
  const lab = item(page, 'Lab (simulator)')
  await expect(lab).toBeFocused()
  await expect(lab).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(lab).toHaveAttribute('aria-expanded', 'false')
  await expect(item(page, 'core-sw1')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(lab).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(item(page, 'core-sw1')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(lab).toBeFocused()

  // F2 then Esc keeps the name.
  await page.keyboard.press('End')
  await page.keyboard.press('F2')
  await page.keyboard.type('-nope')
  await page.keyboard.press('Escape')
  await expect(item(page, 'dist-eos1')).toBeFocused()
  await page.waitForTimeout(200)
  await expect(item(page, 'dist-eos1-nope')).toHaveCount(0)
  expect(await byName(page, 'dist-eos1')).toBeDefined()

  // F2 renames inline.
  await page.keyboard.press('End')
  await expect(item(page, 'dist-eos1')).toBeFocused()
  await page.keyboard.press('F2')
  const rename = page.getByRole('textbox', { name: 'Rename dist-eos1' })
  await expect(rename).toBeFocused()
  await rename.fill('dist-eos1-renamed')
  await rename.press('Enter')
  await expect(item(page, 'dist-eos1-renamed')).toBeVisible()
  await expect(item(page, 'dist-eos1-renamed')).toBeFocused()

  // Enter connects the focused session.
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'core-sw1')).toBeFocused()
  await shot(page, 'keyboard')
  await page.keyboard.press('Enter')
  await login(hop)
  await expect(page.getByRole('tab', { name: 'core-sw1' })).toBeVisible()
})

test('duplicate opens an inline rename; delete asks first', async ({ hop }) => {
  const { page } = hop
  await item(page, 'dist-eos1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  const rename = page.getByRole('textbox', { name: 'Rename dist-eos1 copy' })
  await expect(rename).toBeFocused()
  await rename.fill('dist-eos2')
  await rename.press('Enter')
  await expect(item(page, 'dist-eos2')).toBeVisible()
  expect(await byName(page, 'dist-eos2')).toMatchObject({ host: '127.0.0.1', port: hop.sims.eos.port, platform: 'eos' })

  await item(page, 'dist-eos2').click()
  await page.keyboard.press('Delete')
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /Delete session "dist-eos2"/ }))
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(item(page, 'dist-eos2')).toBeVisible()
  await item(page, 'dist-eos2').click()
  await page.keyboard.press('Delete')
  await page.getByRole('dialog', { name: /Delete session "dist-eos2"/ }).getByRole('button', { name: 'Delete' }).click()
  await expect(item(page, 'dist-eos2')).toHaveCount(0)
})

test('keys in a context menu stay in the menu: Enter picks the item, nothing connects', async ({ hop }) => {
  const { page } = hop
  await item(page, 'dist-eos1').click()
  await item(page, 'dist-eos1').click({ button: 'right' })
  const fav = page.getByRole('menuitem', { name: 'Add to favorites' })
  await fav.focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await byName(page, 'dist-eos1')).favorite).toBe(true)
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(tree(page).locator('[aria-selected=true]')).toHaveCount(2) // the tree row and its Favorites row
  await expect(tree(page).locator('[aria-selected=true][data-row-key^="tree:"]')).toHaveAccessibleName(/^dist-eos1\b/)

  // Arrow keys move within the menu, not the tree.
  await item(page, 'core-sw1').click({ button: 'right' })
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu')).toBeVisible()
  // (The open menu hides the tree from the accessibility tree: query it by CSS.)
  await expect(page.locator('#session-tree [aria-selected=true][data-row-key^="tree:"]')).toHaveAccessibleName(/^core-sw1 .*XE$/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tab')).toHaveCount(0)
})

test('session dialog selects are themed menus: keyboard picks a platform, Esc closes only the menu', async ({ hop }) => {
  const { page } = hop
  await page.getByRole('button', { name: 'New session' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'New session' })
  await dlg.getByPlaceholder('core-sw1').fill('edge-eos9')
  await dlg.getByPlaceholder('10.0.0.1 or hostname').fill('127.0.0.1')
  const platform = dlg.getByRole('combobox', { name: 'Platform' })
  await platform.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('listbox')
  await expect(menu).toBeVisible()
  // Grouped by vendor, never a native OS popup.
  await expect(menu.getByRole('group', { name: 'Arista' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(dlg).toBeVisible()
  await platform.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('option', { name: 'Arista EOS' }).press('Enter')
  await expect(platform).toHaveText(/Arista EOS/)
  await dlg.getByRole('combobox', { name: 'Protocol' }).click()
  await page.getByRole('option', { name: 'Serial console' }).click()
  await expect(dlg.getByRole('combobox', { name: 'Baud rate' })).toHaveText(/9.600/)
  await dlg.getByRole('combobox', { name: 'Protocol' }).click()
  await page.getByRole('option', { name: 'SSH' }).click()
  // Switching to or from serial clears the host on purpose (a COM port is not a hostname).
  await dlg.getByPlaceholder('10.0.0.1 or hostname').fill('127.0.0.1')
  await dlg.getByRole('button', { name: 'Add session' }).click()
  await expect(dlg).toBeHidden()
  expect((await byName(page, 'edge-eos9')).platform).toBe('eos')
})
