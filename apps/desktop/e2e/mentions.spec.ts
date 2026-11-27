import type { OllamaChatBody, OllamaTurn } from '../test/fake-llm'
import { MOD, expect, test } from './fixtures'

/**
 * F11: "@ai … @device" from the terminal line and the panel composer opens the fleet view with
 * the question and the scope filled in (this tab's session first). Nothing starts until Enter on
 * the preview; nothing typed after "@ai" reaches the device; an unknown mention blocks the start.
 */

type W = { hopline: { settings: { update: (p: Record<string, unknown>) => Promise<unknown> } } }

const roleOf = (b: OllamaChatBody) => {
  const sys = b.messages?.[0]?.content ?? ''
  if (/fleet coordinator/.test(sys)) return 'coordinator'
  return /Your device: (.+?) \(/.exec(sys)?.[1] ?? 'other'
}
const turnOf = (b: OllamaChatBody) => (b.messages ?? []).filter((m) => m.role === 'assistant').length
const call = (name: string, args: unknown): OllamaTurn => ({ tools: [{ name, arguments: args }] })

function route(b: OllamaChatBody): OllamaTurn | undefined {
  const role = roleOf(b)
  const n = turnOf(b)
  if (role === 'coordinator') {
    if (n === 0)
      return call('dispatch_tasks', {
        tasks: [
          { device: 'core-sw1', task: 'Check BGP' },
          { device: 'dist-eos1', task: 'Check BGP' }
        ]
      })
    return { text: 'BGP checked on **core-sw1** and **dist-eos1**.' }
  }
  if (role.startsWith('device-')) return n === 0 ? call('run_show_command', { command: 'show version', reason: 'check' }) : call('submit_report', { status: 'not_found', findings: ['nothing wrong'], evidence: [], confidence: 'low' })
  return undefined
}

async function useOllama(hop: Parameters<Parameters<typeof test>[2]>[0]['hop']) {
  hop.llm.ollama.route.fn = route
  await hop.page.evaluate((url) => (window as unknown as W).hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' }), hop.llm.ollama.url)
  await hop.page.reload()
  await hop.page.waitForSelector('text=Lab (simulator)')
}

test('terminal: "@ai … here and on @dist-eos1" opens the fleet view pre-filled; Enter runs it; nothing reaches the device line', async ({ hop }) => {
  const { page } = hop
  await useOllama(hop)
  await hop.connect('core-sw1')
  await page.keyboard.type('@ai why is bgp down here and on @dist')
  // The autocomplete lists saved sessions; Tab inserts the full name.
  const list = page.getByTestId('mention-list')
  await expect(list).toBeVisible()
  await expect(list.getByRole('option').first()).toHaveAttribute('data-name', 'dist-eos1')
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ path: `${process.env['HOPLINE_SHOTS']}/mentions-terminal.png` })
  await page.keyboard.press('Tab')
  await expect(list).toBeHidden()
  await page.keyboard.press('Enter')

  const view = page.getByRole('dialog', { name: 'Investigate across devices' })
  await expect(view).toBeVisible()
  await expect(view.getByTestId('fleet-mentions')).toContainText('this device: core-sw1')
  await expect(view.getByLabel('Question')).toHaveValue('why is bgp down here and on dist-eos1 (this device: core-sw1)')
  const rows = view.getByTestId('fleet-scope').locator('tr[data-device]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-device', 'core-sw1')
  await expect(rows.nth(0)).toHaveAttribute('data-selected', 'true')
  await expect(rows.nth(1)).toHaveAttribute('data-device', 'dist-eos1')
  await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true')
  // Never auto-started: the preview waits, with the start button focused.
  const start = view.getByRole('button', { name: /Investigate 2 devices/ })
  await expect(start).toBeFocused()
  await expect(view.getByTestId('fleet-status')).toHaveCount(0)
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ path: `${process.env['HOPLINE_SHOTS']}/mentions-preview.png` })

  await page.keyboard.press('Enter')
  await expect(view.getByTestId('fleet-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  await expect(view.locator('section[data-lane="core-sw1"]')).toHaveAttribute('data-status', 'not_found')
  await expect(view.locator('section[data-lane="dist-eos1"]')).toHaveAttribute('data-status', 'not_found')
  await expect(view.getByTestId('fleet-answer')).toContainText('BGP checked')
  const asked = hop.llm.ollama.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as OllamaChatBody).find((b) => roleOf(b) === 'coordinator')!
  expect(JSON.stringify(asked.messages)).toMatch(/why is bgp down here and on device-[\w-]+ \(this device: device-[\w-]+\)/)

  // The user's tab line: still a clean prompt; nothing of the question reached the device.
  await page.keyboard.press('Escape')
  await expect(view).toBeHidden()
  const text = await hop.termText()
  expect(text).not.toMatch(/Invalid input|why is bgp|@dist/)
  expect(text.trimEnd()).toMatch(/core-sw1#$/)
})

test('composer: "@" autocomplete picks a device by keyboard; an unknown mention is shown inline and blocks the start', async ({ hop }) => {
  const { page } = hop
  await useOllama(hop)
  await hop.connect('core-sw1')
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  // The panel opens collapsed until there is a key or the user asks: open it like a user would.
  if (((await composer.boundingBox())?.width ?? 0) < 50) await page.keyboard.press(`${MOD}+I`)
  await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThan(50)
  await composer.click()
  await composer.pressSequentially('compare with @eo')
  const list = page.getByTestId('mention-list')
  await expect(list).toBeVisible()
  await expect(list.getByRole('option', { selected: true })).toHaveAttribute('data-name', 'dist-eos1')
  // ↓ then ↑ comes back to the first; Enter inserts it (the typed text was not a whole name yet).
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(composer).toHaveValue('compare with @dist-eos1 ')
  await expect(list).toBeHidden()
  // Esc closes the list and leaves the text (and the focus) alone.
  await composer.pressSequentially('and @edge-r9')
  await expect(list).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(composer).toBeFocused()
  await page.keyboard.press('Enter')

  const view = page.getByRole('dialog', { name: 'Investigate across devices' })
  await expect(view).toBeVisible()
  const errors = view.getByTestId('mention-errors')
  await expect(errors).toContainText("no saved session 'edge-r9'")
  await expect(view.getByRole('button', { name: /Investigate/ })).toBeDisabled()
  await expect(view.getByTestId('fleet-scope')).toHaveCount(0)
  // Fix it: "Not a device" drops the mention; the scope resolves and Enter starts.
  await errors.getByRole('button', { name: 'Not a device' }).click()
  await expect(errors).toHaveCount(0)
  await expect(view.getByLabel('Question')).toHaveValue('compare with dist-eos1 and edge-r9 (this device: core-sw1)')
  await expect(view.getByTestId('fleet-scope').locator('tr[data-device]')).toHaveCount(2)
  await expect(view.getByRole('button', { name: /Investigate 2 devices/ })).toBeFocused()
})

test('a draft and its attached command follow their terminal until explicitly sent', async ({ hop }) => {
  const { page } = hop
  await useOllama(hop)
  hop.llm.ollama.route.fn = () => ({ text: 'Captured interface table reviewed.' })
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Vlan10[\s\S]*core-sw1#\s*$/)
  const core = page.getByPlaceholder(/Ask about core-sw1/)
  if (((await core.boundingBox())?.width ?? 0) < 50) await page.keyboard.press(`${MOD}+I`)
  await core.fill('Which interfaces are up?')
  const attach = page.getByRole('button', { name: 'Attach command output' })
  const remove = page.getByRole('button', { name: 'Remove attachment' })
  await attach.click()
  await expect(remove).toBeVisible()
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: `${process.env['HOPLINE_SHOTS']}/assistant-draft.png` })
  await expect(page.getByRole('region', { name: 'Assistant' }).getByText('show ip interface brief', { exact: true })).toBeVisible()
  await hop.connect('dist-eos1')
  const dist = page.getByPlaceholder(/Ask about dist-eos1/)
  await expect(dist).toHaveValue('')
  await expect(remove).toHaveCount(0)
  await dist.fill('Inspect this uplink')
  await page.getByRole('tab', { name: 'core-sw1', exact: true }).click()
  await expect(core).toHaveValue('Which interfaces are up?')
  await expect(remove).toBeVisible()
  await core.fill('Compare with @dist-eos1')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Remove the attachment to ask across devices')).toBeVisible()
  await remove.click()
  await expect(remove).toHaveCount(0)
  await attach.click()
  expect(hop.llm.ollama.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0)
  await core.fill('Which interfaces are up?')
  await core.press('Enter')
  await expect(page.getByText('Captured interface table reviewed.')).toBeVisible()
  const sent = hop.llm.ollama.requests.filter((r) => r.path === '/api/chat').map((r) => JSON.stringify(r.body))
  expect(sent.some((b) => b.includes('Which interfaces are up?') && b.includes('Selected terminal output') && b.includes('Vlan10'))).toBe(true)
  await expect(remove).toHaveCount(0)
  await page.getByRole('tab', { name: 'dist-eos1', exact: true }).click()
  await expect(dist).toHaveValue('Inspect this uplink')
})
