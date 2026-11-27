import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { fakeOllama } from '../test/fake-llm'
import { expect, launchHopline, MOD, sizeWindow, test } from './fixtures'

test('fresh production workspace answers a queued question with an empty inventory', async () => {
  const { app, page, dir } = await launchHopline({ production: true, waitFor: '' })
  const model = await fakeOllama({ script: [{ text: 'Check whether the client received a lease from its DHCP server.' }] })
  try {
    await page.waitForFunction(() => performance.getEntriesByName('hopline:ready').length > 0)
    expect(await page.evaluate(async () => ({
      lab: 'lab' in window.hopline, inventory: await window.hopline.sessions.list()
    }))).toMatchObject({ lab: false, inventory: { sessions: [], folders: [] } })
    await page.evaluate(() => window.hopline.settings.update({ privacyReviewed: true, updateAutoCheck: false }))
    await page.reload()
    await page.getByRole('button', { name: 'Ask assistant', exact: true }).click()
    const question = page.getByRole('textbox', { name: 'Workspace question' })
    await question.fill('My laptop has no IP address. Where do I start?')
    await question.press('Enter')
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await setup.getByRole('radio', { name: 'Ollama' }).click()
    await setup.getByLabel('Ollama server').fill(model.url)
    await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toContainText('qwen3:8b')
    await setup.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByRole('log', { name: 'Workspace messages' })).toContainText('received a lease')
    await expect(page.locator('.xterm')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Connect and ask/ })).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspace chat takes a question to the chosen device and brings its findings back', async ({ hop }) => {
  const { page, llm } = hop
  await page.evaluate((endpoint) => window.hopline.settings.update({
    aiProvider: 'ollama', ollamaEndpoint: endpoint, ollamaModel: 'qwen3:8b', aiReadOnly: true
  }), llm.ollama.url)
  await page.reload()
  await page.keyboard.press(MOD + '+I')
  const input = page.getByRole('textbox', { name: 'Workspace question' })
  llm.ollama.script.push({ text: 'An interface can lose carrier even while it is administratively enabled.' })
  await input.fill('What does loss of carrier mean?')
  await input.press('Enter')
  await expect(page.getByText('An interface can lose carrier even while it is administratively enabled.')).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)

  llm.ollama.script.push({ text: 'Choose the saved core connection and check its interface state.' })
  await input.fill('Log into core and check interfaces')
  await input.press('Enter')
  const connect = page.getByRole('button', { name: 'Connect and ask core-sw1', exact: true })
  await expect(connect).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)
  if (process.env.HOPLINE_SHOTS) await page.screenshot({ path: join(process.env.HOPLINE_SHOTS, 'workspace-device-choice.png') })
  // Keep a draft while taking a detour into the device.
  await input.fill('What should I check at the far end?')
  llm.ollama.script.push(
    { tools: [{ name: 'run_show_command', arguments: { command: 'show interfaces status', reason: 'Inspect operational state' } }] },
    { text: 'Gi1/0/2 is disabled in the interface status table.' }
  )
  await connect.click()
  const password = page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await password.isVisible()) || (await hop.termText()).includes('core-sw1#')).toBe(true)
  if (await password.isVisible()) {
    await password.fill('admin')
    await password.press('Enter')
  }
  await expect(page.getByRole('log', { name: 'Assistant conversation' })).toContainText('Gi1/0/2 is disabled')
  await expect.poll(hop.termText).toContain('show interfaces status')
  await expect(page.locator('#session-search')).toBeVisible()
  await expect(page.getByRole('banner').getByRole('tab')).toHaveCount(0)
  if (process.env.HOPLINE_SHOTS) {
    await page.screenshot({ path: join(process.env.HOPLINE_SHOTS, 'workspace-device-answer.png') })
    await sizeWindow(hop.app, page, 900, 620)
    await page.screenshot({ path: join(process.env.HOPLINE_SHOTS, 'workspace-device-narrow.png') })
  }
  const requestCount = () => llm.ollama.requests.filter(r => r.path === '/api/chat').length
  const beforeDraft = requestCount()
  await page.getByRole('button', { name: 'Continue in workspace' }).click()
  await expect(input).toHaveValue(/^What should I check at the far end\?[\s\S]*Completed commands: show interfaces status[\s\S]*Gi1\/0\/2 is disabled/)
  expect(requestCount()).toBe(beforeDraft)
  llm.ollama.script.push({ text: 'Verify the peer interface before changing administrative state.' })
  await input.press('Enter')
  await expect(page.getByText('Verify the peer interface before changing administrative state.')).toBeVisible()
  const sent = JSON.stringify(llm.ollama.requests.filter(r => r.path === '/api/chat').at(-1)?.body)
  expect(sent).toContain('Gi1/0/2 is disabled')
  expect(sent).toContain('loss of carrier')
  expect(sent).not.toContain('core-sw1')
  await page.getByRole('button', { name: 'Open device conversation for core-sw1', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Assistant conversation' })).toContainText('Gi1/0/2 is disabled')
  expect(requestCount()).toBe(beforeDraft + 1)
})
