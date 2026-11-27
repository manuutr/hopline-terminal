import { expect, MOD, test } from './fixtures'

test('assistant suggests a question about the disabled interface on screen', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('show interfaces status')
  await hop.page.keyboard.press('Enter')
  await expect.poll(hop.termText).toContain('Duplex')
  await hop.page.keyboard.press(MOD + '+I')
  const questions = hop.page.getByRole('region', { name: 'Suggested questions' })
  await expect(questions.getByRole('button')).toHaveCount(3)
  await questions.getByRole('button', { name: /Why is Gi1\/0\/2/ }).click()
  await expect(hop.page.getByTestId('ai-waiting')).toBeVisible()
})

test('CLI excerpts honor read-only and stage only the reviewed line', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push({ text: 'Try this observation.\n\n```cli\nshow clock\nshow version\n```' })
  await page.evaluate((url) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b', aiReadOnly: true }), hop.llm.ollama.url)
  await page.reload()
  await hop.connect('core-sw1')
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  if (await page.getByRole('button', { name: 'Toggle assistant', exact: true }).getAttribute('aria-pressed') !== 'true') await page.keyboard.press(MOD + '+I')
  await composer.fill('Give me a CLI example')
  await composer.press('Enter')
  const send = page.getByRole('button', { name: /^Send to terminal/ })
  await expect(send).toBeDisabled()
  await page.getByRole('button', { name: 'Copy code' }).click()
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  await page.getByTestId('ai-readonly').click()
  await page.getByRole('combobox', { name: 'CLI line to insert' }).selectOption('1')
  await send.click()
  const confirm = page.getByRole('dialog', { name: 'Insert into core-sw1?' })
  await expect(confirm).toContainText('show version')
  await confirm.getByRole('button', { name: 'Insert line' }).click()
  await expect.poll(hop.termText).toMatch(/core-sw1#show version\s*$/)
  expect(await hop.termText()).not.toContain('core-sw1#show clock')
})

test('selected terminal lines attach to a collapsible composer excerpt', async ({ hop }) => {
  const { page } = hop
  await page.evaluate((url) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' }), hop.llm.ollama.url)
  await page.reload()
  await hop.connect('core-sw1')
  await page.keyboard.type('show interfaces status\r')
  await expect.poll(hop.termText).toContain('Duplex')
  await page.evaluate(() => {
    const t = (window as unknown as { __hoplineTest: { raw(): import('@xterm/xterm').Terminal } }).__hoplineTest.raw()
    const buf = t.buffer.active
    for (let i = buf.viewportY; i < buf.length; i++) {
      if (buf.getLine(i)?.translateToString(true).includes('Gi1/0/2')) { t.select(0, i, 7); return }
    }
    throw new Error('Interface row missing')
  })
  await page.getByRole('button', { name: 'Attach', exact: true }).click()
  await page.getByText('Selected terminal output', { exact: true }).click()
  await expect(page.getByLabel('Attached output')).toContainText('disabled')
})
