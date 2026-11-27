import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { OllamaChatBody, OllamaTurn } from '../test/fake-llm'
import { axeCheck } from './support/axe'
import { MOD, expect, launchHopline, showSessions, test, type Hopline } from './fixtures'

/**
 * axe-core on the main surfaces in dark, light and high contrast (docs/ACCESSIBILITY.md).
 * Serious and critical violations fail; e2e/support/axe.ts holds the short, scoped allow-list.
 */

/** Run an action from the command palette, the way a keyboard user would. */
async function run(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${MOD}+K`)
  const input = page.getByRole('combobox', { name: 'Command palette' })
  await input.fill(`>${title}`)
  await expect(page.getByRole('option', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(input).toBeHidden()
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('axe: empty state, palette, settings, session dialog, known hosts, audit log', async ({ hop }) => {
  const { page } = hop
  await axeCheck(page, 'empty state')

  await page.keyboard.press(`${MOD}+K`)
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeFocused()
  await axeCheck(page, 'palette')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeHidden()

  await page.keyboard.press(`${MOD}+Comma`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  // The shortcut opens the dialog on a later frame: read the tab names only once they are there.
  // (Reading them at once could return [], skip every tab, and press Esc before the dialog was up.)
  await expect(settings.getByRole('tab', { name: 'Workspace' })).toBeVisible()
  const tabs = await settings.getByRole('tab').allTextContents()
  expect(tabs.length).toBeGreaterThan(3)
  for (const tab of tabs) {
    await settings.getByRole('tab', { name: tab }).click()
    await expect(settings.getByRole('tabpanel', { name: tab })).toBeVisible()
    await page.waitForTimeout(200)
    await axeCheck(page, `settings: ${tab}`)
  }
  await closeDialog(page)

  await run(page, 'New session…')
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible()
  await axeCheck(page, 'session dialog')
  await closeDialog(page)

  await run(page, 'Known hosts…')
  await expect(page.getByRole('dialog', { name: 'Known hosts' })).toBeVisible()
  await axeCheck(page, 'known hosts')
  await closeDialog(page)

  await run(page, 'Open audit log')
  await expect(page.getByRole('dialog', { name: 'AI audit log' })).toBeVisible()
  await axeCheck(page, 'audit log')
  await closeDialog(page)
})

test('axe: connected tab, splits, files, backups, multi-run', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/GigabitEthernet1\/0\/2/)
  await axeCheck(page, 'connected tab')

  await showSessions(page)
  await axeCheck(page, 'connected tab with sidebar')
  await page.locator('.xterm').first().click()

  await page.keyboard.press(`${MOD}+D`)
  const launcher = page.locator('[data-launcher] input')
  await expect(launcher).toBeFocused()
  await axeCheck(page, 'split with launcher')
  await launcher.fill('dist-eos1')
  await page.keyboard.press('Enter')
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || /dist-eos1[#>]\s*$/.test(await hop.termText())).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(hop.termText).toMatch(/dist-eos1[#>]\s*$/)
  await axeCheck(page, 'splits')

  await page.keyboard.press(`${MOD}+J`)
  const files = page.getByRole('region', { name: 'Files' })
  await expect(files).toBeVisible()
  await page.waitForTimeout(500)
  await axeCheck(page, 'files')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(files).toHaveCount(0)

  await run(page, 'Config backups and diff…')
  await expect(page.getByRole('dialog', { name: /backups/i })).toBeVisible()
  await axeCheck(page, 'backups')
  await closeDialog(page)

  await run(page, 'Run on many devices…')
  const multi = page.getByRole('dialog', { name: 'Run on many devices' })
  await expect(multi).toBeVisible()
  await axeCheck(page, 'multi-run')
  await closeDialog(page)
})

async function connectModel(hop: Hopline): Promise<Page> {
  const { page } = hop
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  await page.reload()
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+I`)
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await axeCheck(page, 'AI panel: setup')
  await setup.getByRole('radio', { name: 'Ollama' }).click()
  await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
  await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
  await setup.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByPlaceholder(/Ask about core-sw1/)).toBeVisible()
  return page
}

test('axe: AI panel with a proposal, the egress dialog', async ({ hop }) => {
  hop.llm.ollama.script.push({
    tools: [
      {
        name: 'propose_config_change',
        arguments: {
          commands: ['interface Gi1/0/2', 'description AXE'],
          rationale: 'label the port',
          rollback: ['interface Gi1/0/2', 'no description'],
          verify: [{ command: 'show running-config interface GigabitEthernet1/0/2', expect: 'description AXE' }]
        }
      }
    ]
  })
  const page = await connectModel(hop)
  await axeCheck(page, 'AI panel: empty')
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  await composer.fill('label Gi1/0/2')
  await composer.press('Enter')
  const card = page.locator('[data-proposal="config"]')
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: /^Approve/ })).toBeEnabled({ timeout: 5000 })
  await axeCheck(page, 'AI panel with a proposal')

  await page.getByTestId('ai-egress').click()
  const dlg = page.getByRole('dialog', { name: 'What left this machine' })
  await expect(dlg.getByTestId('egress-row').first()).toBeVisible()
  await expect(dlg.getByTestId('egress-loading')).toHaveCount(0)
  await axeCheck(page, 'egress dialog')
  await closeDialog(page)
})

const roleOf = (b: OllamaChatBody) => {
  const sys = b.messages?.[0]?.content ?? ''
  if (/fleet coordinator/.test(sys)) return 'coordinator'
  return /Your device: (.+?) \(/.exec(sys)?.[1] ?? 'other'
}
const turnOf = (b: OllamaChatBody) => (b.messages ?? []).filter((m) => m.role === 'assistant').length

test('axe: fleet scope and run', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.route.fn = (b): OllamaTurn | undefined => {
    if (roleOf(b) === 'coordinator') {
      if (turnOf(b) === 0) return { tools: [{ name: 'dispatch_tasks', arguments: { tasks: ['core-sw1', 'dist-eos1'].map((device) => ({ device, task: 'Check the clock' })) } }] }
      return { text: 'Merged.' }
    }
    return { text: 'still thinking', delayMs: 60_000 }
  }
  await page.evaluate((url) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' }), hop.llm.ollama.url)
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Investigate across devices…' }).click()
  const view = page.getByRole('dialog', { name: 'Investigate across devices' })
  await expect(view).toBeVisible()
  await axeCheck(page, 'fleet scope')
  await view.getByRole('button', { name: 'Resolve scope' }).click()
  await expect(view.getByTestId('fleet-scope')).toBeVisible()
  await axeCheck(page, 'fleet scope resolved')
  await view.getByLabel('Question').fill('What time is it?')
  await view.getByRole('button', { name: /^Investigate \d+ device/ }).click()
  await expect(view.locator('section[data-lane="core-sw1"]')).toHaveAttribute('data-status', 'running', { timeout: 30_000 })
  await axeCheck(page, 'fleet run')
  await view.getByRole('button', { name: /^Stop run/ }).click()
  await page.getByRole('dialog', { name: 'Stop the run?' }).getByRole('button', { name: 'Stop run' }).click()
  await expect(view.getByTestId('fleet-status')).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 })
})

test('axe: first-run steps (privacy, import, add host, connect)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  const { app, page } = await launchHopline({ dir, env: { HOPLINE_E2E_FIRST_RUN: '1' } })
  try {
    const steps = page.locator('[data-first-run]')
    await expect(steps).toContainText('Before you start')
    await axeCheck(page, 'first run: privacy')
    await steps.getByTestId('privacy-continue').click()
    await expect(steps).toContainText('Step 1 of 3')
    await axeCheck(page, 'first run: import')
    await steps.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(steps).toContainText('Step 2 of 3')
    await axeCheck(page, 'first run: add host')
    await steps.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(steps).toContainText('Step 3 of 3')
    await axeCheck(page, 'first run: connect')
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('axe: settings search, getting started checklist, per-host overrides', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const search = settings.getByTestId('settings-search')
  // The accessibility settings are in the registry, so search finds them.
  await search.fill('screen reader')
  const results = settings.getByRole('listbox', { name: 'Matching settings' })
  await expect(results.getByRole('option').first()).toContainText('Screen reader mode')
  await axeCheck(page, 'settings search')
  await search.fill('divider')
  await expect(results.getByRole('option').first()).toContainText('Panel sizes')
  await search.press('Enter')
  await expect(settings.getByRole('button', { name: 'Reset panel sizes' })).toBeFocused()
  await search.fill('qqqqzz')
  await axeCheck(page, 'settings search: no match')
  // Esc clears the search first, then closes.
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await closeDialog(page)

  await hop.connect('core-sw1')
  await showSessions(page)
  const list = page.locator('[data-checklist]')
  await expect(list).toContainText('Getting started')
  await list.getByRole('button', { name: /Getting started/ }).click()
  await expect(list.locator('[data-item=connect]')).toBeVisible()
  await axeCheck(page, 'getting started checklist')

  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Overrides for this folder…' }).click()
  const folder = page.getByRole('dialog', { name: 'Overrides for Lab (simulator)' })
  await expect(folder).toBeVisible()
  await folder.locator('[data-override="termFontSize"]').getByRole('switch', { name: 'Override font size' }).click()
  await axeCheck(page, 'overrides: folder')
  await closeDialog(page)
  await page.getByRole('treeitem', { name: 'core-sw1', exact: true }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Overrides…' }).click()
  await expect(page.getByRole('dialog', { name: 'Overrides for core-sw1' })).toBeVisible()
  await axeCheck(page, 'overrides: session')
  await closeDialog(page)
})

test('axe: connection details, endpoint history and completed assistant code', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push({ text: 'Read the clock.\n\n```cli\nshow clock\nshow version\n```' })
  await page.evaluate((url) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' }), hop.llm.ollama.url)
  await page.reload()
  await hop.connect('core-sw1')
  await page.getByRole('button', { name: 'Connection details for core-sw1' }).click()
  await axeCheck(page, 'connection details')
  await page.keyboard.press('Escape')
  await page.evaluate(() => localStorage.setItem('hopline.quickEndpoints', JSON.stringify(['ssh://admin@core-sw1:22'])))
  await page.keyboard.press(MOD + '+O')
  await expect(page.getByRole('textbox', { name: 'Quick connect' })).toBeFocused()
  await axeCheck(page, 'quick connect with history')
  await page.keyboard.press('Escape')
  if (await page.getByRole('button', { name: 'Toggle assistant', exact: true }).getAttribute('aria-pressed') !== 'true') await page.keyboard.press(MOD + '+I')
  const input = page.getByPlaceholder(/Ask about core-sw1/)
  await input.fill('Give me a CLI example')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible()
  await axeCheck(page, 'assistant code excerpt')
})
