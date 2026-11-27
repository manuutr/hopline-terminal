import type { Page } from '@playwright/test'
import type { AuditRow } from '../src/shared/types'
import type { SnippetInput } from '../src/shared/productivity'
import { MOD, expect, test } from './fixtures'

type W = { hopline: { audit: { list: (n: number) => Promise<AuditRow[]> }; snippets: { save: (s: SnippetInput) => Promise<{ id: string }> } } }
const audit = (page: Page) => page.evaluate(() => (window as unknown as W).hopline.audit.list(100))
const save = (page: Page, s: Partial<SnippetInput> & { name: string; body: string }) =>
  page.evaluate((x) => (window as unknown as W).hopline.snippets.save({ mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: true, ...x }), s)
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Button bar' })

test('snippets: made in the manager, run from the button bar through the guard, audited as snippet', async ({ hop }) => {
  const { page } = hop
  // Optional: no bar until there is a button.
  await expect(bar(page)).toHaveCount(0)
  await page.keyboard.press(`${MOD}+K`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('>snippets')
  await page.getByRole('option', { name: /^Snippets…/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Snippets' })
  await dlg.getByLabel('Snippet name').fill('IP brief')
  await dlg.getByLabel('Snippet commands').fill('show ip interface brief')
  await dlg.getByRole('button', { name: 'Add snippet' }).click()
  await expect(dlg.getByRole('option', { name: /IP brief/ })).toBeVisible()
  // Round 2: unsaved edits are never dropped silently. Esc asks; "Cancel" keeps the editor and the edit.
  await dlg.getByLabel('Snippet name').fill('IP brief (edited)')
  await page.keyboard.press('Escape')
  const discard = page.getByRole('alertdialog', { name: /Discard changes/ }).or(page.getByRole('dialog', { name: /Discard changes/ }))
  await expect(discard).toBeVisible()
  await page.waitForTimeout(150) // let the question's layer take over Esc (a person is never 8 ms fast)
  await page.keyboard.press('Escape')
  await expect(discard).toBeHidden()
  await expect(dlg.getByLabel('Snippet name')).toHaveValue('IP brief (edited)')
  await page.waitForTimeout(300) // a new Esc, not the one that cancelled
  await page.keyboard.press('Escape')
  await discard.getByRole('button', { name: 'Discard' }).click()
  await expect(dlg).toBeHidden()

  await hop.connect('core-sw1')
  await bar(page).getByRole('button', { name: 'IP brief' }).click()
  await expect.poll(hop.termText).toMatch(/show ip interface brief[\s\S]*GigabitEthernet1\/0\/1[\s\S]*core-sw1#\s*$/)
  await expect.poll(async () => (await audit(page)).find((r) => r.source === 'snippet')).toMatchObject({ command: 'show ip interface brief', kind: 'read', decision: 'executed' })
})

test('snippet variables autocomplete from what the device listed; config asks first; insert types without Enter', async ({ hop }) => {
  // These run changes and uploads: read-only mode (on by default) covers them (fix-round Low 5).
  await hop.page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  const { page } = hop
  await save(page, { name: 'Describe', body: 'interface {{interface}}\n description {{text}}' })
  await save(page, { name: 'Clock', body: 'show clock', mode: 'insert' })
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await hop.connect('core-sw1')
  // The terminal learns interface names from a listing the user ran.
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Vlan1[\s\S]*core-sw1#\s*$/)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hoplineTest: { ghost: () => { live: Record<string, string[]> } } }).__hoplineTest.ghost().live['interfaces']?.length ?? 0)).toBeGreaterThan(2)

  await bar(page).getByRole('button', { name: 'Describe' }).click()
  const vars = page.getByRole('dialog', { name: 'Describe' })
  const intf = vars.getByRole('combobox', { name: 'interface' })
  await expect(intf).toBeFocused()
  await intf.fill('1/0/2')
  await expect(vars.getByRole('option', { name: 'GigabitEthernet1/0/2' })).toBeVisible()
  await intf.press('Enter')
  await expect(intf).toHaveValue('GigabitEthernet1/0/2')
  await vars.getByRole('combobox', { name: 'text' }).fill('set-by-snippet')
  await vars.getByRole('button', { name: 'Continue' }).click()

  const confirm = page.getByRole('dialog', { name: /Run “Describe” on core-sw1/ })
  await expect(confirm.getByTestId('snippet-confirm')).toHaveAttribute('data-kind', 'config')
  await expect(confirm).toContainText('configure terminal')
  await expect(confirm).toContainText('+ interface GigabitEthernet1/0/2')
  await expect(confirm).toContainText('+ description set-by-snippet')
  await confirm.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(async () => (await audit(page)).filter((r) => r.source === 'snippet' && r.decision === 'executed').map((r) => r.command).reverse()).toEqual([
    'configure terminal',
    'interface GigabitEthernet1/0/2',
    'description set-by-snippet',
    'end'
  ])
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)

  // Insert: typed at the prompt, no Enter.
  await bar(page).getByRole('button', { name: 'Clock' }).click()
  await expect.poll(hop.termText).toMatch(/core-sw1#show clock\s*$/)
  await page.keyboard.press('Enter')
  await expect.poll(hop.termText).toMatch(/show clock\n.*\d{2}:\d{2}:\d{2}[\s\S]*core-sw1#\s*$/)
})

test('disruptive snippets need the hostname typed; blocked ones never run; the bar reorders by drag', async ({ hop }) => {
  // These run changes and uploads: read-only mode (on by default) covers them (fix-round Low 5).
  await hop.page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  const { page } = hop
  await save(page, { name: 'BGP reset', body: 'clear ip bgp *' })
  await save(page, { name: 'Wipe', body: 'write erase' })
  await save(page, { name: 'Version', body: 'show version' })
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await hop.connect('core-sw1')

  await bar(page).getByRole('button', { name: 'BGP reset' }).click()
  const confirm = page.getByRole('dialog', { name: /Run “BGP reset”/ })
  await expect(confirm.getByTestId('snippet-confirm')).toHaveAttribute('data-kind', 'disruptive')
  const run = confirm.getByRole('button', { name: 'Run disruptive' })
  await expect(run).toBeDisabled()
  await confirm.getByLabel('Type core-sw1 to confirm').fill('core-sw2')
  await expect(run).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await audit(page)).find((r) => r.command === 'clear ip bgp *')).toMatchObject({ source: 'snippet', decision: 'rejected' })
  // Declining needs no toast (it used to cover the next dialog's primary button).
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Not run' })).toHaveCount(0)

  await bar(page).getByRole('button', { name: 'Wipe' }).click()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Blocked: Wipe' })).toBeVisible()
  await expect.poll(async () => (await audit(page)).find((r) => r.command === 'write erase')).toMatchObject({ source: 'snippet', decision: 'blocked' })
  expect(await hop.termText()).not.toMatch(/write erase/)

  // Drag "Version" before "BGP reset": the order sticks after a reload.
  const names = () => bar(page).locator('[data-snippet]').allInnerTexts()
  expect(await names()).toEqual(['BGP reset', 'Wipe', 'Version'])
  // The guard-class dot: red for disruptive, none for a show command.
  await expect(bar(page).locator('[data-snippet]').filter({ hasText: 'BGP reset' })).toHaveAttribute('data-guard', 'disruptive')
  await expect(bar(page).locator('[data-snippet]').filter({ hasText: 'Version' })).toHaveAttribute('data-guard', 'read')
  await bar(page).getByRole('button', { name: 'Version' }).dragTo(bar(page).getByRole('button', { name: 'BGP reset' }))
  await expect.poll(names).toEqual(['Version', 'BGP reset', 'Wipe'])
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await expect.poll(names).toEqual(['Version', 'BGP reset', 'Wipe'])
  // Dropped on the empty end of the bar, a button goes last.
  await bar(page).getByRole('button', { name: 'Version' }).dragTo(bar(page).getByTestId('bar-end'))
  await expect.poll(names).toEqual(['BGP reset', 'Wipe', 'Version'])

  // ! in the palette lists the snippets for the focused session.
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+K`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('!vers')
  await page.getByRole('option', { name: /Version/ }).click()
  await expect.poll(hop.termText).toMatch(/show version[\s\S]*Cisco IOS XE Software/)
})

test('read-only mode (the default) refuses a configuration snippet, says why, and audits it (fix-round Low 5)', async ({ hop }) => {
  const { page } = hop
  await save(page, { name: 'NTP', body: 'ntp server 10.9.9.9' })
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await hop.connect('core-sw1')
  await bar(page).getByRole('button', { name: 'NTP' }).click()
  await expect(page.getByText('Not run: NTP')).toBeVisible()
  await expect(page.getByText(/read-only mode is on/i).first()).toBeVisible()
  await expect.poll(async () => (await audit(page)).find((r) => r.source === 'snippet')).toMatchObject({ command: 'ntp server 10.9.9.9', decision: 'refused', reason: expect.stringMatching(/read-only mode is on/) })
  expect(await hop.termText()).not.toMatch(/ntp server/)
})
