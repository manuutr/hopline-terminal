import { MOD, expect, test } from './fixtures'

/**
 * F2 onboarding against local fake LLM servers (no real Anthropic or Ollama). The Anthropic client
 * in main points at the fixture's fake API; the key below never leaves the machine.
 */

const GOOD_KEY = 'sk-ant-e2e-good-key-0000-wxyz'

test('@ai with no provider: connect in the panel (bad key → specific error), then the kept question runs', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('@ai why is bgp to 10.0.0.2 down?\r')
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await expect(setup).toBeVisible()
  await expect(page.getByTestId('ai-waiting')).toBeVisible()
  await expect(setup.getByText('Your question is sent once connected')).toBeVisible()
  // Typing kept going to the device: the panel does not steal focus from the terminal.
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused()

  // A wrong key: a specific error, nothing saved.
  await setup.getByLabel('API key').fill('sk-ant-e2e-bad-key-0000')
  await setup.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('ai-connect-status')).toHaveAttribute('data-code', 'invalid_key')
  await expect(page.getByTestId('ai-connect-status')).toHaveText(/Invalid API key/)
  expect((await page.evaluate(() => window.hopline.settings.get())).hasApiKey).toBe(false)

  // No credits: also specific.
  await setup.getByLabel('API key').fill('sk-ant-e2e-nocredit-0000')
  await setup.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('ai-connect-status')).toHaveAttribute('data-code', 'no_credits')

  // The right key: connected, the composer is back, and the waiting question is answered.
  await setup.getByLabel('API key').fill(GOOD_KEY)
  await setup.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByPlaceholder(/Ask about core-sw1/)).toBeVisible()
  await expect(page.getByText(/Gi1\/0\/2, the uplink to isp-r2, is administratively down/)).toBeVisible()
  await expect(page.getByTestId('ai-waiting')).toHaveCount(0)
  await expect(page.getByTestId('ai-provider')).toHaveText('Opus 5.5')

  // The window only ever learns "configured" and the last 4 characters.
  const s = await page.evaluate(() => window.hopline.settings.get())
  expect(s).toMatchObject({ hasApiKey: true, aiConfigured: true, apiKeyLast4: 'wxyz', aiProvider: 'anthropic', aiModel: 'claude-opus-5-5' })
  expect(JSON.stringify(s)).not.toContain(GOOD_KEY)
  // The key was used by main against the fake API (and the question went with it).
  const posts = hop.llm.anthropic.requests.filter((r) => r.method === 'POST')
  expect(posts.some((r) => JSON.stringify(r.body).includes('why is bgp to 10.0.0.2 down?'))).toBe(true)
  expect(posts.every((r) => r.headers['authorization'] === `Bearer ${GOOD_KEY}` || r.headers['x-api-key'] === GOOD_KEY || /bad|nocredit/.test(String(r.headers['authorization'])))).toBe(true)

  // First-run card: dismissible, and stays dismissed.
  await page.getByRole('button', { name: 'New conversation' }).click()
  await expect(page.getByTestId('ai-intro')).toBeVisible()
  await page.getByTestId('ai-intro').getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByTestId('ai-intro')).toHaveCount(0)
  expect((await page.evaluate(() => window.hopline.settings.get())).aiIntroDismissed).toBe(true)

  // Settings → Assistant shows the saved key by its last 4 and tests the stored key.
  await page.getByTestId('ai-provider').click() // the provider chip opens Settings
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await expect(dlg.getByTestId('api-key-saved')).toHaveText('Saved · ••••wxyz')
  await dlg.getByRole('button', { name: 'Test connection' }).click()
  await expect(dlg.getByTestId('ai-connect-status')).toHaveText('Connected to Claude Opus 5.5')
})

test('local model (Ollama): discover models, connect, and a run with a local output filter', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push(
    { tools: [{ name: 'run_show_command', arguments: { command: 'show logging', reason: 'recent events', filter: { tail: 3 } } }] },
    { text: 'The last events show Gi1/0/2 going down.' }
  )
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+I`)
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await setup.getByRole('radio', { name: 'Ollama' }).click()
  await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
  // Discovery picks the first tool-capable model; the picker shows tool support and context size.
  await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
  await expect(setup.getByText(/runs in suggest mode/)).toBeVisible()
  await setup.getByRole('combobox', { name: 'Ollama model' }).click()
  await expect(page.getByRole('option', { name: /llama2:7b/ })).toContainText('suggest mode')
  await expect(page.getByRole('option', { name: /llama2:7b/ })).toContainText('ctx 4k')
  await expect(page.getByRole('option', { name: /qwen3:8b/ })).toContainText('tools')
  await expect(page.getByRole('option', { name: /qwen3:8b/ })).toContainText('ctx 40k (uses 32k)')
  await page.getByRole('option', { name: /qwen3:8b/ }).click()
  await setup.getByRole('button', { name: 'Connect' }).click()
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('ai-provider')).toHaveText('qwen3:8b')
  // The server is shown once, in the trust bar under the header (review P1-7).
  await expect(page.getByTestId('ai-destination-label')).toHaveText(/^Ollama · 127\.0\.0\.1:\d+$/)

  await composer.fill('anything in the logs?')
  await composer.press('Enter')
  await expect(page.getByText('The last events show Gi1/0/2 going down.')).toBeVisible()
  // The command card shows the plain command and the local filter.
  await expect(page.getByText('show logging', { exact: true })).toBeVisible()
  await expect(page.getByTestId('step-filter')).toHaveText('· last 3 lines')
  // The device got only the plain command.
  await expect.poll(hop.termText).toMatch(/core-sw1#show logging\s*\r?\n/)
  expect(await hop.termText()).not.toMatch(/\| tail|tail 3/)
  // What the model saw: filtered, labelled.
  const chats = hop.llm.ollama.requests.filter((r) => r.path === '/api/chat' && (r.body as { stream?: boolean }).stream !== false)
  expect(JSON.stringify(chats.at(-1)!.body)).toMatch(/\[Hopline filter last 3 lines: showing last 3 of \d+ lines\]/)
})

test('the grep time budget holds inside Electron main (ReDoS bound is real in the shipped runtime)', async ({ hop }) => {
  const code = await hop.app.evaluate(() => {
    const vm = process.getBuiltinModule('node:vm') as typeof import('node:vm')
    const sandbox = vm.createContext({ re: /(a+)+$/, s: 'a'.repeat(5000) + '!' })
    try {
      vm.runInContext('re.test(s)', sandbox, { timeout: 250 })
      return 'finished'
    } catch (e) {
      return (e as { code?: string }).code ?? String(e)
    }
  })
  expect(code).toBe('ERR_SCRIPT_EXECUTION_TIMEOUT')
})

for (const vendor of ['OpenAI', 'Gemini'] as const) {
  test(`connects ${vendor} and shows its destination without carrying a key across providers`, async ({ hop }) => {
    const { page } = hop
    const host = vendor === 'OpenAI' ? 'api.openai.com' : 'generativelanguage.googleapis.com'
    await hop.app.evaluate((_electron, expectedHost) => {
      const original = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        const target = new URL(String(url))
        if (target.hostname !== expectedHost) {
          if (target.hostname === '127.0.0.1') return original(url, init)
          throw new Error('Unexpected external host in test')
        }
        if (init?.method === 'GET') return Response.json({ id: 'lab-model' })
        const body = JSON.parse(String(init?.body))
        if (body.model !== 'lab-model' || new Headers(init?.headers).get('Authorization') !== 'Bearer demo-key-for-this-vendor') throw new Error('Wrong account or model')
        const check = body.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'connection_check')
        const message = check
          ? { tool_calls: [{ id: 'id1', type: 'function', function: { name: 'connection_check', arguments: '{}' } }] }
          : { content: 'The interface is administratively down.' }
        return Response.json({ choices: [{ message, finish_reason: check ? 'tool_calls' : 'stop' }] })
      }
    }, host)
    await hop.connect('core-sw1')
    await page.keyboard.press(`${MOD}+I`)
    const form = page.getByRole('form', { name: 'Connect a model' })
    await form.getByLabel('API key').fill('demo-key-for-another-vendor')
    await form.getByRole('radio', { name: vendor }).click()
    await expect(form.getByLabel('API key')).toHaveValue('')
    await form.getByLabel('API key').fill('demo-key-for-this-vendor')
    await form.getByLabel(vendor + ' model ID').fill('lab-model')
    await form.getByRole('button', { name: 'Connect' }).click()
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await expect(composer).toBeVisible()
    await expect(page.getByTestId('ai-destination-label')).toHaveText(vendor + ' cloud')
    await composer.fill('Explain the interface status')
    await composer.press('Enter')
    await expect(page.getByText('The interface is administratively down.', { exact: true })).toBeVisible()

    await page.getByTestId('ai-provider').click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings.getByTestId('api-key-saved')).toContainText('ndor')
    await settings.getByRole('button', { name: 'Test connection' }).click()
    await expect(settings.getByTestId('ai-connect-status')).toHaveText('Connected to lab-model')
    const other = vendor === 'OpenAI' ? 'Gemini' : 'OpenAI'
    await settings.getByRole('combobox', { name: 'Provider', exact: true }).click()
    await page.getByRole('option', { name: new RegExp(other) }).click()
    await expect(settings.getByLabel(other + ' API key')).toHaveValue('')
    await expect(settings.getByTestId('api-key-saved')).toHaveCount(0)
    await settings.getByLabel(other + ' model ID').fill('second-model')
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings).toHaveCount(0)
    const saved = await page.evaluate(() => window.hopline.settings.get())
    expect(saved.aiProvider).toBe(other.toLowerCase())
    expect(saved.aiConfigured).toBe(false)
    expect([saved.openaiModel, saved.geminiModel].sort()).toEqual(['lab-model', 'second-model'])
  })
}
