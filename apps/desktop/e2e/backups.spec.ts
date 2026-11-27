import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeRow, expect, showSessions, stubDialogs, test } from './fixtures'

test('config backups: back up, change, back up again, diff in Monaco, export redacted', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await showSessions(page)
  const row = treeRow(page, 'core-sw1').and(page.locator('[data-row-key^="tree:"]'))

  // First backup from the session menu.
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Back up config' }).click()
  await expect(page.getByText('Backed up core-sw1')).toBeVisible()

  // Nothing changed: no new version.
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Back up config' }).click()
  await expect(page.getByText('core-sw1: no changes')).toBeVisible()

  // Change the device, then back up again. (Not the hostname: a tab whose prompt shows another
  // hostname than earlier versions is refused as a possible hop to another device, Phase 4 M3.)
  await page.locator('.xterm').first().click()
  await page.keyboard.type('configure terminal\r')
  await page.keyboard.type('interface GigabitEthernet1/0/2\r')
  await page.keyboard.type('description e2e-uplink-9\r')
  await page.keyboard.type('end\r')
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Back up config' }).click()
  await expect(page.getByText('Backed up core-sw1').last()).toBeVisible()

  // History with the diff viewer.
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Config history…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Config backups' })
  await expect(dialog.getByRole('option')).toHaveCount(2)
  // The newest version against the one before it.
  await dialog.getByRole('option').first().click()
  await expect(dialog.locator('.monaco-diff-editor')).toBeVisible()
  await expect.poll(() => dialog.getByTestId('change-count').textContent()).not.toBe('0')
  await expect(dialog.getByText('description e2e-uplink-9').first()).toBeVisible()
  // Secrets never reach the renderer: the simulator's tacacs key is redacted in the view.
  const all = await dialog.locator('.monaco-diff-editor').textContent()
  expect(all).not.toMatch(/key 7 104D000A0618/)
  // Round 2: each side is labelled, and the newest is marked latest.
  await expect(dialog.getByTestId('diff-sides')).toContainText(/Base.*Selected.*\(latest\)/)
  await expect(dialog.getByTestId('diff-sides')).not.toContainText(/AM|PM/)
  await dialog.getByRole('radio', { name: 'Inline' }).click()
  await expect(dialog.locator('.monaco-diff-editor.side-by-side')).toHaveCount(0)
  // The layout radiogroup moves with the arrow keys.
  await page.keyboard.press('ArrowLeft')
  await expect(dialog.getByRole('radio', { name: 'Side by side' })).toHaveAttribute('aria-checked', 'true')
  await dialog.getByRole('radio', { name: 'Inline' }).click()

  // The version list is one roving listbox: ↓ selects the older version (only one tab stop).
  const versions = dialog.getByRole('listbox', { name: 'Versions' })
  await versions.getByRole('option').first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(versions.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(versions.getByRole('option').nth(1)).toBeFocused()
  await expect(versions.locator('[tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('Home')
  await expect(versions.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')

  // Export (redacted) goes through main's save dialog.
  const out = join(mkdtempSync(join(tmpdir(), 'hopline-bk-')), 'core.txt')
  await stubDialogs(hop.app, { save: out })
  await dialog.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'Export (secrets redacted)' }).click()
  await expect(page.getByText('Exported')).toBeVisible()
  const file = readFileSync(out, 'utf8')
  expect(file).toContain('description e2e-uplink-9')
  expect(file).not.toContain('104D000A0618')

  // Every capture is in the audit log as a backup.
  const audit = await page.evaluate(() => (window as unknown as { hopline: { audit: { list: (n: number) => Promise<{ source: string; command: string }[]> } } }).hopline.audit.list(50))
  expect(audit.filter((a) => a.source === 'backup' && a.command === 'show running-config').length).toBeGreaterThanOrEqual(3)
})

test('R2: a session without a tab is backed up over a background connection; folder and tab menus reach backups', async ({ hop }) => {
  const { page } = hop
  const row = treeRow(page, 'dist-eos1').and(page.locator('[data-row-key^="tree:"]'))
  await expect(row).toBeVisible()
  const tabs = page.getByRole('tab')
  const before = await tabs.count()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Back up config' }).click()
  await expect(page.getByText('Backed up dist-eos1')).toBeVisible({ timeout: 30_000 })
  // No tab was opened for it: the background connection is invisible and closed.
  expect(await tabs.count()).toBe(before)
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Config history…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Config backups' })
  await expect(dialog.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Folder menu: "Schedule backups…" adds a schedule for the folder, switched off until you turn it on.
  await treeRow(page, 'Lab (simulator)').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Schedule backups…' }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Folder or tag' })).toContainText('Lab (simulator)')
  await expect(dialog.getByRole('switch').first()).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Tab menu: run/send and backups for the tab's session.
  await hop.connect('core-sw1')
  await page.getByRole('tab', { selected: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Run on…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Send to…' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Back up config' }).click()
  await expect(page.getByText('Backed up core-sw1')).toBeVisible({ timeout: 30_000 })
  // Focus moving around never scrolls the window sideways.
  expect(await page.evaluate(() => [scrollX, document.documentElement.scrollLeft, document.body.scrollLeft, document.getElementById('root')!.scrollLeft])).toEqual([0, 0, 0, 0])
})
