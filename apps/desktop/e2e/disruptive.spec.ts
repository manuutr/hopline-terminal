import type { Page } from '@playwright/test'
import type { AuditRow } from '../src/shared/types'
import { MOD, expect, test, type Hopline } from './fixtures'

const SHOTS = process.env['HOPLINE_SHOTS']
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** Connect a local model (the Ollama fake), with change proposals on or off. */
async function connectModel(hop: Hopline, readOnly: boolean) {
  const { page } = hop
  await page.evaluate((ro) => window.hopline.settings.update({ aiReadOnly: ro }), readOnly)
  await page.reload()
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+I`)
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await setup.getByRole('radio', { name: 'Ollama' }).click()
  await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
  await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
  await setup.getByRole('button', { name: 'Connect' }).click()
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  await expect(composer).toBeVisible()
  return composer
}

const audit = (page: Page) => page.evaluate(() => (window as unknown as { hopline: { audit: { list: (n: number) => Promise<AuditRow[]> } } }).hopline.audit.list(50))

test('disruptive: a red card that runs only after the device hostname is typed', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push({ tools: [{ name: 'run_show_command', arguments: { command: 'clear ip bgp *', reason: 'reset the BGP sessions' } }] }, { text: 'BGP sessions were reset.' })
  const composer = await connectModel(hop, false)
  await composer.fill('reset bgp')
  await composer.press('Enter')

  const card = page.locator('[data-proposal="disruptive"]')
  await expect(card).toBeVisible()
  await expect(card.getByText(/^disruptive$/i)).toBeVisible()
  await expect(card.getByRole('list', { name: 'Why it is disruptive' })).toContainText('clear ip bgp *')
  const run = card.getByRole('button', { name: 'Run disruptive' })
  await expect(run).toBeDisabled()
  const confirm = card.getByRole('textbox', { name: 'Type core-sw1 to confirm' })
  await confirm.fill('core-sw2')
  await expect(run).toBeDisabled()
  await shot(page, 'disruptive-card')
  // Nothing was sent while the card waits.
  expect(await hop.termText()).not.toMatch(/clear ip bgp/)
  await confirm.fill('core-sw1')
  await expect(run).toBeEnabled()
  await run.click()
  await expect(page.getByText('BGP sessions were reset.')).toBeVisible()
  await expect.poll(hop.termText).toMatch(/core-sw1#clear ip bgp \*/)
  const row = (await audit(page)).find((r) => r.command === 'clear ip bgp *')!
  expect(row).toMatchObject({ kind: 'disruptive', decision: 'executed' })
  expect(row.approver).toBeTruthy()
})

test('disruptive: read-only mode refuses it without a card', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push({ tools: [{ name: 'run_show_command', arguments: { command: 'clear ip bgp *', reason: 'reset' } }] }, { text: 'Refused, as expected.' })
  const composer = await connectModel(hop, true)
  await composer.fill('reset bgp')
  await composer.press('Enter')
  await expect(page.getByText('Refused, as expected.')).toBeVisible()
  await expect(page.locator('[data-proposal]')).toHaveCount(0)
  expect(await hop.termText()).not.toMatch(/clear ip bgp/)
  expect((await audit(page)).find((r) => r.command === 'clear ip bgp *')).toMatchObject({ kind: 'disruptive', decision: 'refused' })
})
