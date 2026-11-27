import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { MOD, expect, stubDialogs, test } from './fixtures'

/**
 * Phase 5: Ollama v2 (suggest mode), Trust UX (provider indicator, budget meter, what left this
 * machine) and the team policy file. Fake LLM servers only; the policy comes from HOPLINE_POLICY.
 */

const POLICY_DIR = mkdtempSync(join(tmpdir(), 'hopline-e2e-policy-'))
test.afterAll(() => rmSync(POLICY_DIR, { recursive: true, force: true }))
const policyFile = (name: string, body: string) => {
  const p = join(POLICY_DIR, name)
  writeFileSync(p, body)
  return p
}

async function connectOllama(page: Page, url: string, model: string) {
  await page.keyboard.press(`${MOD}+I`)
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await setup.getByRole('radio', { name: 'Ollama' }).click()
  await setup.getByLabel('Ollama server').fill(url)
  await setup.getByRole('combobox', { name: 'Ollama model' }).click()
  await page.getByRole('option', { name: new RegExp(model.replace(/[.:]/g, '\\$&')) }).click()
  await setup.getByRole('button', { name: 'Connect' }).click()
}

test.describe('suggest mode and what left this machine', () => {
  test('a model without tool calling suggests; a click runs through the guard; every request is in the log', async ({ hop }) => {
    const { page } = hop
    hop.llm.ollama.route.fn = (b) => {
      const last = b.messages?.at(-1)?.content ?? ''
      if (/the user ran your suggested/.test(JSON.stringify(b.messages))) return { text: 'Gi1/0/2 is administratively down.' }
      if (/interfaces/.test(last)) return { text: 'Check the interfaces:\n```\nshow ip interface brief\nwrite erase\n```' }
      return undefined
    }
    await hop.connect('core-sw1')
    await connectOllama(page, hop.llm.ollama.url, 'llama2:7b')
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await expect(composer).toBeVisible()

    // Where prompts go, and that this model only suggests.
    await expect(page.getByTestId('ai-destination-label')).toHaveText(new RegExp(`Ollama · 127\\.0\\.0\\.1:${new URL(hop.llm.ollama.url).port}`))
    await expect(page.getByTestId('ai-destination')).toHaveAttribute('data-local', 'true')
    await expect(page.getByTestId('ai-suggest-mode')).toBeVisible()

    await composer.fill('any interfaces down?')
    await composer.press('Enter')
    const list = page.getByTestId('ai-suggestions')
    await expect(list.getByTestId('ai-suggestion')).toHaveCount(2)
    await expect(list.locator('[data-kind=blocked]')).toContainText('write erase')
    await expect(list.locator('[data-kind=blocked]').getByRole('button')).toBeDisabled()
    // Nothing ran yet.
    expect(await hop.termText()).not.toMatch(/show ip interface brief/)
    await expect(page.getByTestId('ai-budget')).toBeVisible()

    await list.getByRole('button', { name: 'Run show ip interface brief' }).click()
    await expect.poll(hop.termText).toMatch(/core-sw1#show ip interface brief/)
    await expect(list.getByText('sent')).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.hopline.audit.list(10))).length).toBeGreaterThan(0)
    const audit = await page.evaluate(() => window.hopline.audit.list(10))
    expect(audit[0]).toMatchObject({ command: 'show ip interface brief', decision: 'executed', reason: 'approved by user' })
    expect(audit[0]!.approver).toBeTruthy()

    await list.getByRole('button', { name: 'Continue with the output' }).click()
    await expect(page.getByText('Gi1/0/2 is administratively down.')).toBeVisible()

    // What left this machine: the two connect-check requests (the tool one refused, then the plain
    // one) and the two questions, searchable; the payload is what the fake server got.
    await stubDialogs(hop.app, { save: join(hop.dir, 'egress.jsonl') })
    await page.getByTestId('ai-egress').click()
    const dlg = page.getByRole('dialog', { name: 'What left this machine' })
    await expect(dlg.getByTestId('egress-row')).toHaveCount(4)
    await expect(dlg.getByTestId('egress-payload')).toContainText('the user ran your suggested')
    await dlg.getByLabel('Search requests').fill('any interfaces down')
    await expect(dlg.getByTestId('egress-row')).toHaveCount(2)
    await dlg.getByLabel('Search requests').fill('no-such-text-anywhere')
    await expect(dlg.getByTestId('egress-row')).toHaveCount(0)
    await dlg.getByLabel('Search requests').fill('')
    await expect(dlg.getByTestId('egress-row')).toHaveCount(4)
    await dlg.getByRole('button', { name: /^Export/ }).click()
    await expect.poll(() => {
      try {
        return readFileSync(join(hop.dir, 'egress.jsonl'), 'utf8').trim().split('\n').length
      } catch {
        return 0
      }
    }).toBe(4)
    const exported = readFileSync(join(hop.dir, 'egress.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { payload: { body?: unknown }; provider: string; source: string })
    const chats = hop.llm.ollama.requests.filter((r) => r.path === '/api/chat' && (r.body as { stream?: boolean }).stream !== false).map((r) => r.body)
    expect(exported.filter((e) => e.source !== 'check').map((e) => e.payload)).toEqual(chats)
    const checks = hop.llm.ollama.requests.filter((r) => r.path === '/api/chat' && (r.body as { stream?: boolean }).stream === false).map((r) => r.body)
    expect(exported.filter((e) => e.source === 'check').map((e) => e.payload.body)).toEqual(checks)
  })

  test('Anthropic: the indicator says cloud, and the API key is never in the log', async ({ hop }) => {
    const { page } = hop
    const KEY = 'sk-ant-e2e-good-egress-key-0000-qrst'
    await hop.connect('core-sw1')
    await page.keyboard.press(`${MOD}+I`)
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await setup.getByLabel('API key').fill(KEY)
    await setup.getByRole('button', { name: 'Connect' }).click()
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await expect(composer).toBeVisible()
    await expect(page.getByTestId('ai-destination')).toHaveText(/Anthropic cloud/)
    await expect(page.getByTestId('ai-destination')).toHaveAttribute('data-local', 'false')
    await composer.fill('why is bgp down?')
    await composer.press('Enter')
    await expect(page.getByText(/Gi1\/0\/2, the uplink to isp-r2, is administratively down/)).toBeVisible()
    const rows = await page.evaluate(() => window.hopline.egress.list())
    // The question, and the connect check's two requests (models lookup, one-line message).
    expect(rows.map((r) => r.source)).toEqual(['agent', 'check', 'check'])
    expect(rows[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', sessionName: 'core-sw1', status: 'ok', attempts: 1 })
    const detail = await page.evaluate((id) => window.hopline.egress.get(id), rows[0]!.id)
    expect(detail!.payload).toContain('why is bgp down?')
    for (const r of rows) {
      const d = await page.evaluate((id) => window.hopline.egress.get(id), r.id)
      expect(JSON.stringify(d)).not.toContain(KEY)
      expect(JSON.stringify(d)).not.toMatch(/x-api-key|authorization/i)
    }
  })
})

test.describe('team policy: Ollama only, read-only, extra blocked commands', () => {
  test.use({
    hopEnv: {
      HOPLINE_POLICY: policyFile(
        'ollama-only.json',
        JSON.stringify({ version: 1, name: 'E2E NetOps', readOnly: true, allowedProviders: ['ollama'], blockedCommands: { iosxe: ['show running-config'], ios: ['show running-config'] }, requireEgressLog: true })
      )
    }
  })

  test('locked settings say so, Anthropic cannot be picked, and a policy-blocked command never reaches the device', async ({ hop }) => {
    const { page } = hop
    hop.llm.ollama.script.push({ tools: [{ name: 'run_show_command', arguments: { command: 'sh run', reason: 'config' } }] }, { text: 'Blocked by policy.' })
    await hop.connect('core-sw1')
    await page.keyboard.press(`${MOD}+I`)
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await expect(setup.getByRole('radio', { name: 'Anthropic' })).toBeDisabled()
    await expect(setup.getByTestId('managed-by-policy')).toBeVisible()
    await expect(page.getByTestId('ai-readonly')).toHaveAttribute('aria-disabled', 'true')
    await page.getByTestId('ai-readonly').click({ force: true })
    expect((await page.evaluate(() => window.hopline.settings.get())).aiReadOnly).toBe(true)
    // main refuses too, whatever the window sends.
    await expect(page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))).rejects.toThrow(/managed by the team policy/)
    await expect(page.evaluate(() => window.hopline.ai.test({ provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-x' }))).resolves.toMatchObject({ ok: false, code: 'policy' })
    expect(hop.llm.anthropic.requests).toEqual([])

    await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
    await setup.getByRole('combobox', { name: 'Ollama model' }).click()
    await page.getByRole('option', { name: /qwen3:8b/ }).click()
    await setup.getByRole('button', { name: 'Connect' }).click()
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await composer.fill('show me the config')
    await composer.press('Enter')
    await expect(page.getByText('Blocked by policy.')).toBeVisible()
    await expect(page.getByText('sh run', { exact: true })).toBeVisible()
    expect(await hop.termText()).not.toMatch(/sh run|show running-config/)
    await expect.poll(async () => (await page.evaluate(() => window.hopline.audit.list(5))).some((r) => r.command === 'sh run')).toBe(true)
    const audit = await page.evaluate(() => window.hopline.audit.list(5))
    expect(audit.find((r) => r.command === 'sh run')).toMatchObject({ decision: 'blocked', reason: 'blocked by team policy ("show running-config")' })

    // The palette action says it is managed and changes nothing (no raw IPC error).
    await page.keyboard.press(`${MOD}+K`)
    await page.getByRole('combobox', { name: 'Command palette' }).fill('>read-only mode')
    await page.getByRole('option', { name: /Read-only mode: managed by policy/ }).click()
    await expect(page.getByText('Read-only mode is managed by policy')).toBeVisible()
    await expect(page.getByText(/Error invoking remote method/)).toHaveCount(0)
    await expect(page.getByTestId('read-only-status')).toHaveAttribute('data-managed', 'true')

    // Settings: Managed by policy on read-only and the egress log.
    await page.keyboard.press(`${MOD}+Comma`)
    const dlg = page.getByRole('dialog', { name: 'Settings' })
    await dlg.getByRole('tab', { name: 'Assistant', exact: true }).click()
    await expect(dlg.getByTestId('policy-info')).toContainText('E2E NetOps')
    await expect(dlg.getByRole('switch', { name: 'Read-only mode' })).toBeDisabled()
    await expect(dlg.getByRole('switch', { name: 'Log what leaves this machine' })).toBeDisabled()
    expect(await dlg.getByTestId('managed-by-policy').count()).toBeGreaterThanOrEqual(3)
  })
})

test.describe('team policy: no provider allowed', () => {
  test.use({ hopEnv: { HOPLINE_POLICY: policyFile('no-ai.json', JSON.stringify({ version: 1, name: 'Jump host', allowedProviders: [] })) } })

  test('the assistant says it is off by policy instead of a dead form', async ({ hop }) => {
    const { page } = hop
    await hop.connect('core-sw1')
    await page.keyboard.press(`${MOD}+I`)
    await expect(page.getByTestId('ai-off-by-policy')).toContainText('turned off by Jump host')
    await expect(page.getByRole('form', { name: 'Connect a model' })).toHaveCount(0)
  })
})

test.describe('team policy: an invalid file fails closed', () => {
  test.use({ hopEnv: { HOPLINE_POLICY: policyFile('broken.json', '{ "version": 1, "readonly": true }') } })

  test('banner, read-only on, AI off', async ({ hop }) => {
    const { page } = hop
    await expect(page.getByTestId('policy-banner')).toContainText('Team policy is invalid')
    await expect(page.getByTestId('policy-banner')).toContainText('readonly')
    const s = await page.evaluate(() => window.hopline.settings.get())
    expect(s).toMatchObject({ aiReadOnly: true, aiConfigured: false })
    await hop.connect('core-sw1')
    await page.keyboard.press(`${MOD}+I`)
    await expect(page.getByTestId('ai-off-by-policy')).toBeVisible()
    await expect(page.evaluate(() => window.hopline.ai.ollamaModels('http://127.0.0.1:11434'))).resolves.toMatchObject({ ok: false, code: 'policy' })
    expect(hop.llm.ollama.requests).toEqual([])
  })
})
