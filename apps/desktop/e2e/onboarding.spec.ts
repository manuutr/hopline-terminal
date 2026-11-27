import { MOD, expect, launchHopline, showSessions, termTextOf, test } from './fixtures'
import { rmSync } from 'node:fs'

const prompt = /core-sw1#\s*$/

test('first run: skip to the lab, connect without a host-key prompt, then the checklist ticks and can be dismissed and reopened', async ({ hop }) => {
  const { page } = hop
  const steps = page.locator('[data-first-run]')
  await expect(steps).toBeVisible()
  await expect(steps).toContainText('Step 1 of 3')
  // Non-modal: the launcher's search keeps focus, the tree stays usable.
  await expect(page.locator('[data-launcher] input')).toBeFocused()
  await steps.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(steps).toContainText('Step 2 of 3')
  await steps.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(steps).toContainText('Step 3 of 3')
  await steps.getByRole('button', { name: 'Open the simulator lab' }).click()

  // The bundled lab: a new port, a key main already trusts (no host-key dialog), the seeded password.
  const termText = termTextOf(page)
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || prompt.test(await termText()), { timeout: 20_000 }).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(termText).toMatch(prompt)
  await expect(page.getByText(/host key/i)).toHaveCount(0)
  const lab = await page.evaluate(() => window.hopline.lab!.info())
  expect(lab.running).toBe(true)
  const { sessions } = await page.evaluate(() => window.hopline.sessions.list())
  const core = sessions.find((s) => s.id === lab.sessionIds[0])!
  expect(core.name).toBe('core-sw1')
  expect(core.host).toBe('127.0.0.1')
  expect(core.port).not.toBe(hop.sims.ios.port)

  // Connected: the steps are done for good, the checklist shows in the sidebar with "connect" ticked.
  await showSessions(page)
  const list = page.locator('[data-checklist]')
  await expect(list).toContainText('Getting started')
  await expect(list).toContainText('1/4')
  await list.getByRole('button', { name: /Getting started/ }).click()
  await expect(list.locator('[data-item=connect][data-done]')).toHaveCount(1)
  // The palette ticks its item.
  await page.keyboard.press(`${MOD}+K`)
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toContainText('2/4')

  // Dismissed, it stays gone across a reload; the palette brings it back.
  await list.getByRole('button', { name: 'Close getting started' }).click()
  await expect(list).toHaveCount(0)
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await expect(page.locator('[data-checklist]')).toHaveCount(0)
  await expect(page.locator('[data-first-run]')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+K`)
  await page.keyboard.type('Show getting started')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-checklist]')).toContainText('2/4')
  await expect(page.locator('[data-checklist] [data-item=palette][data-done]')).toHaveCount(1)
})

test('first run: Skip setup hides the steps for good; adding a host moves to Connect with that host', async () => {
  const { app, page, dir } = await launchHopline()
  try {
    const steps = page.locator('[data-first-run]')
    await expect(steps).toBeVisible()
    await steps.getByRole('button', { name: 'Skip', exact: true }).click()
    await steps.getByRole('button', { name: 'Add host…' }).click()
    const dlg = page.getByRole('dialog', { name: 'New session' })
    await dlg.getByPlaceholder('core-sw1').fill('edge-lab')
    await dlg.getByPlaceholder('10.0.0.1 or hostname').fill('192.0.2.10')
    await dlg.getByRole('button', { name: 'Add session' }).click()
    await expect(steps).toContainText('Step 3 of 3')
    await expect(steps.getByRole('button', { name: 'Connect to edge-lab' })).toBeVisible()
    await steps.getByRole('button', { name: 'Skip setup' }).click()
    await expect(steps).toHaveCount(0)
    await page.reload()
    await page.waitForSelector('text=Lab (simulator)')
    await expect(page.locator('[data-first-run]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.describe('without an OS keychain (Linux without a keyring)', () => {
  test.use({ hopEnv: { HOPLINE_E2E_NO_KEYCHAIN: '1' } })

  test('every checklist step can be done in a session-only vault: 1/4 after the first connect is the same as with a keychain', async ({ hop }) => {
    const { page } = hop
    // The vault asks first: session only keeps secrets in memory until Hopline quits.
    await page.getByRole('button', { name: 'Session only' }).click()
    const steps = page.locator('[data-first-run]')
    await steps.getByRole('button', { name: 'Skip', exact: true }).click()
    await steps.getByRole('button', { name: 'Skip', exact: true }).click()
    await steps.getByRole('button', { name: 'Open the simulator lab' }).click()
    const termText = termTextOf(page)
    await expect.poll(termText, { timeout: 20_000 }).toMatch(prompt)
    await showSessions(page)
    const list = page.locator('[data-checklist]')
    await expect(list).toContainText('1/4')

    // The palette, then a run on the lab folder (the open tab is reused, dist-eos1 connects in the background).
    await page.keyboard.press(`${MOD}+K`)
    await page.getByRole('combobox', { name: 'Command palette' }).fill('#Lab')
    await page.getByRole('option', { name: /^Lab \(simulator\)/ }).click()
    await page.getByRole('option', { name: /Run a show command on these 5/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
    await dlg.getByLabel('Show command').fill('show version')
    await dlg.getByRole('button', { name: /^Preview/ }).click()
    await dlg.getByRole('button', { name: /^Run on/ }).click()
    await expect(dlg.getByTestId('multi-progress')).toHaveText('5 of 5 done', { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(list).toContainText('3/4')

    // The assistant: a local model, one question.
    await page.keyboard.press(`${MOD}+I`)
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await setup.getByRole('radio', { name: 'Ollama' }).click()
    await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
    await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
    await setup.getByRole('button', { name: 'Connect' }).click()
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await composer.fill('is bgp up?')
    await composer.press('Enter')
    await expect(list).toContainText('4/4')
  })

  test('after a restart the session-only vault has a new key: the lab writes its login again, so background runs still log in', async () => {
    const env = { HOPLINE_E2E_NO_KEYCHAIN: '1' }
    const first = await launchHopline({ env })
    try {
      await first.page.getByRole('button', { name: 'Session only' }).click()
      const steps = first.page.locator('[data-first-run]')
      await steps.getByRole('button', { name: 'Skip setup' }).click()
      await first.page.evaluate(() => window.hopline.lab!.start())
    } finally {
      await first.app.close()
    }
    const { app, page } = await launchHopline({ env, dir: first.dir })
    try {
      // Session only was chosen last time: no question now, just a new key.
      // No tab is open: every device connects in the background with the stored login.
      await page.evaluate(() => window.hopline.lab!.start())
      await page.keyboard.press(`${MOD}+K`)
      await page.getByRole('combobox', { name: 'Command palette' }).fill('#Lab')
      await page.getByRole('option', { name: /^Lab \(simulator\)/ }).click()
      await page.getByRole('option', { name: /Run a show command on these 5/ }).click()
      const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
      await dlg.getByLabel('Show command').fill('show version')
      await dlg.getByRole('button', { name: /^Preview/ }).click()
      await dlg.getByRole('button', { name: /^Run on/ }).click()
      for (const n of ['core-sw1', 'dist-eos1']) await expect(dlg.locator(`[role=option][data-target="${n}"]`)).toHaveAttribute('data-status', 'ok', { timeout: 30_000 })
    } finally {
      await app.close()
      rmSync(first.dir, { recursive: true, force: true })
    }
  })
})
