import { MOD, expect, test, keyLabel } from './fixtures'

const panes = (page: import('@playwright/test').Page) => page.locator('[data-pane-id]')

test('keymap editor: reserved keys and conflicts are refused, a new key works and survives a reload', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Keyboard' }).click()
  await dlg.getByLabel('Filter actions').fill('Split right')
  await dlg.getByRole('button', { name: 'Change shortcut for Split right' }).click()
  const rec = dlg.getByTestId('key-recorder')
  await expect(rec).toBeFocused()
  // Ctrl+C is the device's interrupt: never a shortcut.
  await page.keyboard.press('Control+C')
  await expect(dlg.getByRole('alert')).toContainText(/Ctrl\+C belongs to the device CLI/)
  // Tab is the device's completion; Ctrl+Shift+6 its break.
  await page.keyboard.press('Tab')
  await expect(dlg.getByRole('alert')).toContainText(/Tab is the device's command completion/)
  await page.keyboard.press('Control+Shift+6')
  await expect(dlg.getByRole('alert')).toContainText(/Cisco break/)
  // Mod+K is the palette's.
  await page.keyboard.press(`${MOD}+K`)
  await expect(dlg.getByRole('alert')).toContainText(/Already used by “Command palette”/)
  // Esc cancels the recording, not the dialog.
  await page.keyboard.press('Escape')
  await expect(dlg).toBeVisible()
  await expect(rec).toBeHidden()

  await dlg.getByRole('button', { name: 'Change shortcut for Split right' }).click()
  await page.keyboard.press('Control+Alt+K')
  const row = dlg.locator('[data-action="pane.splitRight"]')
  await expect(row).toContainText('changed')
  await expect(row).toContainText(keyLabel('Ctrl+Alt+K'))
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()

  // The old key no longer splits; the new one does.
  await page.locator('.xterm').first().click()
  await expect(panes(page)).toHaveCount(1)
  await page.keyboard.press(`${MOD}+D`)
  await expect(panes(page)).toHaveCount(1)
  await page.keyboard.press('Control+Alt+K')
  await expect(panes(page)).toHaveCount(2)

  // The tooltip, the shortcut sheet and the palette show the new key.
  await page.keyboard.press(`${MOD}+Slash`)
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Filter shortcuts').fill('split right')
  await expect(sheet.getByTestId('shortcut-sheet')).toContainText(keyLabel('Ctrl+Alt+K'))
  await page.keyboard.press('Escape')

  // Kept in main: a reload brings it back.
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await page.keyboard.press(`${MOD}+Comma`)
  await dlg.getByRole('tab', { name: 'Keyboard' }).click()
  await expect(row).toContainText(keyLabel('Ctrl+Alt+K'))
  // Restore default puts Mod+D back.
  await row.getByRole('button', { name: 'Restore default for Split right' }).click()
  await expect(row).toContainText(keyLabel('Mod+D'))
  await expect(row).not.toContainText('changed')
})

test('palette prefixes: > commands, @ sessions, # groups drill down, ? help', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+K`)
  const input = page.getByRole('combobox', { name: 'Command palette' })
  // > commands only: no sessions.
  await input.fill('>')
  await expect(page.getByRole('option', { name: /Settings…/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /dist-eos1/ })).toHaveCount(0)
  // @ sessions only: no actions.
  await input.fill('@dist')
  await expect(page.getByRole('option', { name: /dist-eos1/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Settings…/ })).toHaveCount(0)
  // ? help lists the prefixes; picking one switches to it.
  await input.fill('?')
  await expect(page.getByRole('option', { name: /Tags and folders/ })).toBeVisible()
  await page.getByRole('option', { name: /Tags and folders/ }).click()
  await expect(input).toHaveValue('#')
  // # lists folders; picking one shows its sessions.
  await page.getByRole('option', { name: /Lab \(simulator\)/ }).click()
  await expect(page.getByRole('button', { name: 'Leave Lab (simulator)' })).toBeVisible()
  await expect(page.getByRole('option', { name: /core-sw1 \(telnet\)/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /dist-eos1/ })).toBeVisible()
  // Backspace on the empty input leaves the group.
  await input.press('Backspace')
  await expect(page.getByRole('button', { name: 'Leave Lab (simulator)' })).toHaveCount(0)
  // No prefix: everything, as before.
  await input.fill('dist')
  await expect(page.getByRole('option', { name: /dist-eos1/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('palette # mode: Esc leaves the picked group first, a second Esc closes; groups offer Back up these N', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+K`)
  const input = page.getByRole('combobox', { name: 'Command palette' })
  await input.fill('#Lab')
  await page.getByRole('option', { name: /^Lab \(simulator\)/ }).click()
  await expect(page.getByRole('option', { name: /Back up these \d+/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('#')
  await expect(page.getByRole('button', { name: /^Leave / })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
})
