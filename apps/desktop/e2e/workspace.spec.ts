import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@xterm/xterm'
import { expect, MOD, stubDialogs, test } from './fixtures'
import { axeCheck } from './support/axe'

test('session overview filters open and closed sessions, switches panes and opens a saved host', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.getByRole('button', { name: 'Open session overview', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Session overview' })
  await dialog.getByRole('radio', { name: 'Open', exact: true }).click()
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await expect(dialog.getByRole('listitem')).toContainText('core-sw1')
  await dialog.getByRole('radio', { name: 'Closed', exact: true }).click()
  await dialog.getByLabel('Search sessions in overview').fill('unknown fixture')
  await expect(dialog.getByRole('status')).toContainText('No sessions match')
  await dialog.getByRole('button', { name: 'Clear overview search' }).click()
  await expect(dialog.getByLabel('Search sessions in overview')).toBeFocused()
  await dialog.getByLabel('Search sessions in overview').fill('dist-eos1')
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await dialog.getByRole('listitem').getByRole('button').click()
  await expect.poll(hop.termText).toMatch(/dist-eos1#\s*$/)
  await page.getByRole('button', { name: 'Open session overview', exact: true }).click()
  await dialog.getByRole('radio', { name: 'Open', exact: true }).click()
  await expect(dialog.getByRole('listitem')).toHaveCount(2)
  await expect(dialog.getByRole('button', { name: /dist-eos1/ })).toHaveAttribute('aria-current', 'true')
  await axeCheck(page, 'session overview')
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: join(process.env['HOPLINE_SHOTS'], 'session-overview.png') })
  await dialog.getByRole('button', { name: /core-sw1/ }).click()
  await expect(page.getByRole('tab', { name: 'core-sw1', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('copy all output and capture a selection in the scratchpad, keep the draft and save it locally', async ({ hop }) => {
  const { page, app, dir } = hop
  await hop.connect('core-sw1')
  await page.evaluate(async () => {
    const raw = (window as unknown as { __hoplineTest: { raw(): Terminal } }).__hoplineTest.raw()
    await new Promise<void>((done) => raw.write('\r\nbranch uplink healthy\r\nsnmp-server community NOTE_CANARY RO\r\n', done))
    raw.selectAll()
  })
  const action = async (name: string) => {
    await page.keyboard.press(`${MOD}+K`)
    const input = page.getByRole('combobox', { name: 'Command palette' })
    await input.fill('>' + name)
    await page.getByRole('option', { name: new RegExp(name) }).first().click()
  }
  await action('Copy all terminal output')
  const clip = await page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get(): string } } }).__hoplineTest.clipboard.get())
  expect(clip).toContain('branch uplink healthy')
  expect(clip).not.toContain('NOTE_CANARY')
  await page.evaluate(() => (window as unknown as { __hoplineTest: { raw(): Terminal } }).__hoplineTest.raw().selectAll())
  await action('Add selection to scratchpad')
  const scratch = page.getByRole('dialog', { name: 'Scratchpad' })
  const notes = scratch.getByLabel('Scratchpad notes')
  await expect(notes).toHaveValue(/branch uplink healthy/)
  expect(await notes.inputValue()).not.toContain('NOTE_CANARY')
  await notes.fill('Investigate the return route in the branch VRF.')
  await scratch.getByRole('button', { name: 'Close', exact: true }).last().click()
  await action('Open scratchpad')
  await expect(notes).toHaveValue('Investigate the return route in the branch VRF.')
  await axeCheck(page, 'scratchpad')
  const path = join(dir, 'local-note.txt')
  await stubDialogs(app, { save: path })
  await scratch.getByRole('button', { name: 'Save as text…' }).click()
  await expect(page.getByText('Scratchpad saved', { exact: true })).toBeVisible()
  expect(readFileSync(path, 'utf8')).toBe(await notes.inputValue())
})
