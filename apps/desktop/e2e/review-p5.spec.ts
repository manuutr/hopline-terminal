import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { OllamaChatBody, OllamaTurn } from '../test/fake-llm'
import { makeIosDevice, startSim } from '../../../packages/simulator/src/index.ts'
import type { CredentialInfo, Folder, Session, SessionInput } from '../src/shared/types'
import { MOD, expect, test, type Hopline, sizeWindow } from './fixtures'

/**
 * Regression tests for the Phase 5 trust/UX review, Part B (P1 1–9 and the P2s that need the real
 * window): keyboard and focus paths, and geometry at the review's narrow widths. With
 * HOPLINE_P5_SHOTS=<dir> each surface is also captured in both themes (the review's screenshots).
 */

const SHOTS = process.env['HOPLINE_P5_SHOTS']

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('hopline.theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
    document.documentElement.style.colorScheme = t
    window.dispatchEvent(new CustomEvent('hopline:theme', { detail: t }))
  }, theme)
}

/** `<name>-<w>x<h>-<theme>.png` in both themes, when HOPLINE_P5_SHOTS is set; leaves the app dark. */
async function snap(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  const size = await page.evaluate(() => `${innerWidth}x${innerHeight}`)
  for (const t of ['dark', 'light'] as const) {
    await setTheme(page, t)
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(SHOTS, `${name}-${size}-${t}.png`) })
  }
  await setTheme(page, 'dark')
}

/** The element's own text is not cut (no ellipsis): it is as wide as its content. */
const notTruncated = async (l: Locator) => expect.poll(() => l.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
/** One line of text: no taller than its line height (plus padding). */
const oneLine = async (l: Locator, max: number) => expect.poll(async () => (await l.boundingBox())!.height).toBeLessThanOrEqual(max)
/** Every child box lies inside the parent box (horizontally). */
async function childrenInside(parent: Locator): Promise<string[]> {
  return parent.evaluate((p) => {
    const r = p.getBoundingClientRect()
    return Array.from(p.querySelectorAll('*'))
      .filter((c) => {
        const b = c.getBoundingClientRect()
        return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1)
      })
      .map((c) => `${c.tagName} "${(c.textContent ?? '').trim().slice(0, 30)}"`)
  })
}

/** The trust bar's destination and the header's model chip are shown whole (review P1-7: "Olla…", "qwen3…"). */
async function headerWhole(page: Page): Promise<void> {
  const dest = page.getByTestId('ai-destination').locator('span.font-mono:visible')
  await expect(dest).toHaveCount(1)
  await notTruncated(dest)
  expect((await dest.textContent())!.length).toBeGreaterThan(3)
  await notTruncated(page.getByTestId('ai-provider').locator('span'))
  await notTruncated(page.locator('[data-panel-title]').filter({ hasText: 'Assistant' }))
}

async function connectModel(hop: Hopline, model = 'qwen3:8b', readOnly = false): Promise<Locator> {
  const { page } = hop
  await page.evaluate((ro) => window.hopline.settings.update({ aiReadOnly: ro }), readOnly)
  await page.reload()
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+I`)
  const setup = page.getByRole('form', { name: 'Connect a model' })
  await setup.getByRole('radio', { name: 'Ollama' }).click()
  await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
  await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
  if (model !== 'qwen3:8b') {
    await setup.getByRole('combobox', { name: 'Ollama model' }).click()
    await page.getByRole('option', { name: new RegExp(model.replace(/[.:]/g, '\\$&')) }).click()
  }
  await setup.getByRole('button', { name: 'Connect' }).click()
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  await expect(composer).toBeVisible()
  return composer
}

const change = (token: string) => ({
  commands: ['interface Gi1/0/2', `description ${token}`],
  rationale: 'label the port',
  rollback: ['interface Gi1/0/2', 'no description'],
  verify: [{ command: 'show running-config interface GigabitEthernet1/0/2 | include description', expect: `description ${token} on GigabitEthernet1/0/2, exactly as proposed` }]
})

test('P1-1: the settings nav moves focus with the arrows, Home and End', async ({ hop }) => {
  const { page } = hop
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  const tab = (name: string) => dlg.getByRole('tab', { name })
  await tab('Workspace').focus()
  await page.keyboard.press('ArrowDown')
  await expect(tab('Assistant')).toBeFocused()
  await expect(tab('Assistant')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  const last = dlg.getByRole('tab').last()
  await expect(last).toBeFocused()
  await page.keyboard.press('ArrowDown') // wraps
  await expect(tab('Workspace')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(last).toBeFocused()
  await page.keyboard.press('Home')
  await expect(tab('Workspace')).toBeFocused()
  // P2: settings rows are one control line plus at most two hint lines (Phase 6–8 review P1: hints
  // clamp at two lines and open in full on hover or focus, instead of being cut to one).
  for (const [w, h] of [
    [1100, 700],
    [900, 640]
  ] as const) {
    await sizeWindow(hop.app, page, w, h)
    const heights = await dlg.locator('[data-settings-row]').evaluateAll((rows) => rows.filter((r) => !/^Preview/.test(r.textContent ?? '')).map((r) => r.getBoundingClientRect().height))
    // (The terminal preview row is a sample terminal, tall on purpose.)
    expect(heights.length).toBeGreaterThan(5)
    expect(Math.max(...heights)).toBeLessThanOrEqual(72)
    await snap(page, 'settings-general')
  }
})

test('P1-2..6: the proposal card at 900 px, keyboard to Confirm, and the arming gate', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push(
    { tools: [{ name: 'propose_config_change', arguments: change('P5-KEYS') }] },
    { tools: [{ name: 'report_verification', arguments: { verified: true, summary: 'The description is on Gi1/0/2.' } }] },
    { text: 'Confirmed.' }
  )
  const composer = await connectModel(hop)
  await sizeWindow(hop.app, page, 900, 640)
  await headerWhole(page)
  await composer.fill('label Gi1/0/2')
  await composer.press('Enter')
  const card = page.locator('[data-proposal="config"]')
  await expect(card).toBeVisible()
  // The new card takes focus; Enter before it is armed does nothing.
  await expect(card).toBeFocused()
  await expect(card.getByTestId('arm-progress')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(card).toHaveAttribute('data-state', 'pending')
  // P1-4: the host name is shown whole at 900 px.
  await notTruncated(card.getByTestId('proposal-host'))
  await expect(card.getByTestId('proposal-host')).toHaveText('core-sw1')
  // P1-3: the focus ring is drawn outside the frame, in the risk colour.
  expect(await card.getAttribute('class')).toMatch(/focus-visible:ring-offset-2.*focus-visible:ring-warn|focus-visible:ring-warn.*focus-visible:ring-offset-2/)
  // P1-5: the hint has its own full-width line.
  const actions = card.getByTestId('proposal-actions')
  const hint = actions.getByTestId('decision-hint')
  expect((await hint.boundingBox())!.width).toBeGreaterThan((await actions.boundingBox())!.width * 0.8)
  await oneLine(hint, 34)
  // P1-6: the verify line stays inside the card.
  expect(await childrenInside(card.getByTestId('verify-plan'))).toEqual([])
  await snap(page, 'proposal-card')

  const approve = card.getByRole('button', { name: /^Approve/ })
  await expect(approve).toBeEnabled({ timeout: 5000 })
  await expect(card.getByTestId('arm-progress')).toHaveCount(0)
  await approve.click()
  // P1-2: focus stays in the card, then Confirm takes it once armed.
  const panel = card.getByTestId('change-panel')
  await expect(panel).toHaveAttribute('data-phase', 'awaiting', { timeout: 20_000 })
  const confirm = panel.getByRole('button', { name: 'Confirm' })
  await expect(confirm).toBeFocused({ timeout: 5000 })
  await expect(confirm).toBeEnabled()
  expect(await childrenInside(card.getByTestId('change-actions'))).toEqual([])
  await oneLine(panel.getByTestId('decision-hint'), 34)
  // P2: the applied lines are not repeated as rows under the card; no "Thinking…" while it waits.
  await expect(page.locator('[data-step]').filter({ hasText: 'description P5-KEYS' })).toHaveCount(0)
  await expect(page.getByText('Thinking…')).toHaveCount(0)
  await snap(page, 'proposal-awaiting')
  await page.keyboard.press('Enter')
  await expect(panel).toHaveAttribute('data-phase', 'confirmed')
  await expect(panel.getByText('confirmed', { exact: true })).toBeVisible()
})

test('P1-2: Confirm never takes focus from the composer, and is not armed early', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push(
    { tools: [{ name: 'propose_config_change', arguments: change('P5-STAY') }] },
    { tools: [{ name: 'report_verification', arguments: { verified: true, summary: 'ok' } }] },
    { text: 'Rolled back.' }
  )
  const composer = await connectModel(hop)
  await composer.fill('label Gi1/0/2')
  await composer.press('Enter')
  const card = page.locator('[data-proposal="config"]')
  const approve = card.getByRole('button', { name: /^Approve/ })
  await expect(approve).toBeEnabled({ timeout: 5000 })
  await approve.click()
  await composer.focus()
  const panel = card.getByTestId('change-panel')
  await expect(panel).toHaveAttribute('data-phase', 'awaiting', { timeout: 20_000 })
  const confirm = panel.getByRole('button', { name: 'Confirm' })
  // Not armed when it appears; armed after ARM_MS; the composer keeps focus throughout.
  await expect(confirm).toBeEnabled({ timeout: 5000 })
  await page.waitForTimeout(300)
  await expect(composer).toBeFocused()
  await expect(confirm).not.toBeFocused()
  // Roll back stays an explicit click.
  await panel.getByRole('button', { name: 'Roll back' }).click()
  await expect(panel).toHaveAttribute('data-phase', 'rolled-back', { timeout: 20_000 })
  await expect(panel.getByText('rolled back', { exact: true })).toBeVisible()
  await expect(panel.getByText('rolled-back', { exact: true })).toHaveCount(0)
  await snap(page, 'proposal-rolledback')
})

test('P1-7 and P1-9: the assistant header, the trust bar and the egress dialog at narrow widths', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.route.fn = (b) => {
    if (/the user ran your suggested/.test(JSON.stringify(b.messages))) return { text: 'Gi1/0/2 is down.' }
    return { text: 'Check:\n```\nshow ip interface brief\nwrite erase\ninterface GigabitEthernet1/0/2\n shutdown\n```' }
  }
  const composer = await connectModel(hop, 'llama2:7b', true)
  await composer.fill('any interfaces down?')
  await composer.press('Enter')
  const list = page.getByTestId('ai-suggestions')
  await expect(list.getByTestId('ai-suggestion')).toHaveCount(3)
  // P2: the group with "shutdown" is labelled disruptive; Review is disabled in read-only mode.
  const group = list.locator('[data-kind=config]')
  await expect(group).toContainText('disruptive')
  await expect(group.getByRole('button', { name: /^Review/ })).toBeDisabled()
  await expect(page.getByTestId('ai-budget')).toBeVisible()
  for (const [w, h] of [
    [1440, 900],
    [1100, 700],
    [900, 640]
  ] as const) {
    await sizeWindow(hop.app, page, w, h)
    const header = page.locator('[data-panel-title]').filter({ hasText: 'Assistant' })
    await notTruncated(header)
    await headerWhole(page)
    await oneLine(page.getByTestId('ai-readonly'), 24)
    await oneLine(page.getByTestId('ai-budget'), 18)
    await expect(page.getByTestId('ai-budget')).toHaveText(/^\d+(\.\d)?k? \/ 20k$|^\d+(\.\d)?k? \/ 200k$/)
    expect(await childrenInside(page.getByTestId('ai-trust'))).toEqual([])
    // The destination is shown once: the header shows the model.
    await expect(page.getByTestId('ai-provider')).toHaveText('llama2:7b')
    await expect(page.getByText(/^Ollama · 127\.0\.0\.1:\d+/)).toHaveCount(1)
    // P2: the interface name is not split.
    // Rendered as exactly its two lines: the interface name is never split across lines.
    expect(await group.locator('code').evaluate((el) => Math.floor(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)))).toBe(2)
    // ...and shown whole, not scrolled away behind the label and button.
    expect(await group.locator('code').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await snap(page, 'suggest-mode')
  }

  // P1-9 / P2: the egress dialog is a one-Tab-stop listbox; arrows move; the payload wraps.
  await sizeWindow(hop.app, page, 1100, 700)
  await page.getByTestId('ai-egress').click()
  const dlg = page.getByRole('dialog', { name: 'What left this machine' })
  const rows = dlg.getByTestId('egress-row')
  await expect(rows).toHaveCount(3)
  await expect(dlg.getByTestId('egress-loading')).toHaveCount(0)
  await expect(dlg.locator('[data-testid=egress-row][tabindex="0"]')).toHaveCount(1)
  await rows.first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(rows.last()).toBeFocused()
  const pre = dlg.getByTestId('egress-payload')
  await expect(pre).not.toHaveText('Decrypting…')
  expect(await pre.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
  expect(await pre.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  // Only the payload scrolls: the dialog body does not.
  expect(await dlg.evaluate((d) => Array.from(d.querySelectorAll('*')).filter((e) => e !== d.querySelector('[data-testid=egress-payload]') && !e.closest('[role=listbox]') && e.scrollHeight > e.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(e).overflowY)).length)).toBe(0)
  await snap(page, 'egress')
})

const roleOf = (b: OllamaChatBody) => {
  const sys = b.messages?.[0]?.content ?? ''
  if (/fleet coordinator/.test(sys)) return 'coordinator'
  return /Your device: (.+?) \(/.exec(sys)?.[1] ?? 'other'
}
const turnOf = (b: OllamaChatBody) => (b.messages ?? []).filter((m) => m.role === 'assistant').length

const extraSims: { close: () => Promise<void> }[] = []
test.afterEach(async () => {
  for (const s of extraSims.splice(0)) await s.close()
})

type W = { hopline: { credentials: { list: () => Promise<CredentialInfo[]> }; sessions: { list: () => Promise<{ folders: Folder[]; sessions: Session[] }>; save: (s: SessionInput) => Promise<Session> } } }

test('P1-8 and fleet P2s: Esc keeps the run going with a status-bar item; Stop run asks with Cancel focused; lanes at 1100 and 900 px', async ({ hop }) => {
  const { page } = hop
  // A third device, so the lanes overflow at 1100 px (the review's case).
  const d = makeIosDevice()
  d.hostname = 'edge-r1'
  const edge = await startSim({ device: d, port: 0 })
  extraSims.push(edge)
  await page.evaluate(async (port) => {
    const h = (window as unknown as W).hopline
    const cred = (await h.credentials.list()).find((c) => c.name === 'Simulator admin')!
    const lab = (await h.sessions.list()).folders.find((f) => f.name === 'Lab (simulator)')!
    await h.sessions.save({ folderId: lab.id, host: '127.0.0.1', protocol: 'ssh', username: 'admin', credentialId: cred.id, logToFile: false, notes: '', options: {}, tags: [], name: 'edge-r1', port, platform: 'iosxe' } as unknown as SessionInput)
  }, edge.port)
  hop.llm.ollama.route.fn = (b): OllamaTurn | undefined => {
    const role = roleOf(b)
    if (role === 'coordinator') {
      if (turnOf(b) === 0) return { tools: [{ name: 'dispatch_tasks', arguments: { tasks: ['core-sw1', 'dist-eos1', 'edge-r1'].map((device) => ({ device, task: 'Check the clock' })) } }] }
      return { text: 'Merged.' }
    }
    // Every lane stays busy until it is stopped.
    return { text: 'still thinking', delayMs: 60_000 }
  }
  await page.evaluate((url) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' }), hop.llm.ollama.url)
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await sizeWindow(hop.app, page, 1100, 700)
  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Investigate across devices…' }).click()
  const view = page.getByRole('dialog', { name: 'Investigate across devices' })
  await expect(view).toBeVisible()
  // P2: the right pane says what to do before the scope is resolved; Hops is off without a seed.
  await expect(view.getByTestId('fleet-scope-empty')).toBeVisible()
  await expect(view.getByRole('radio', { name: '1 hop' })).toBeDisabled()
  // P2: the ticked folder's sessions show as included ("via Lab (simulator)"), not unticked.
  const implied = view.locator('[role=checkbox][data-via]')
  await expect(implied.first()).toBeVisible()
  await expect(implied.first()).toHaveAttribute('aria-checked', 'true')
  await expect(implied.first()).toContainText('via Lab (simulator)')
  await snap(page, 'fleet-scope')
  await view.getByRole('button', { name: 'Resolve scope' }).click()
  await expect(view.getByTestId('fleet-scope')).toBeVisible()
  await view.getByLabel('Parallel devices').selectOption('3')
  await view.getByLabel('Question').fill('What time is it?')
  await view.getByRole('button', { name: /^Investigate \d+ device/ }).click()
  const lane = (n: string) => view.locator(`section[data-lane="${n}"]`)
  await expect(lane('core-sw1')).toHaveAttribute('data-status', 'running', { timeout: 30_000 })

  // P2: the answer column is clamp(280px, 32%, 380px) of the row.
  const answer = view.getByTestId('fleet-answer-col')
  const aw = (await answer.boundingBox())!.width
  const row = (await view.getByTestId('fleet-lanes').boundingBox())!.width + aw
  expect(aw).toBeGreaterThanOrEqual(279)
  expect(aw).toBeLessThanOrEqual(Math.max(280, row * 0.32) + 1)
  // P2: a lane past the right edge is announced, and the button scrolls to it.
  const more = view.getByTestId('fleet-more-lanes')
  await expect(lane('edge-r1')).toBeAttached()
  await expect(more).toHaveText(/^1 more/)
  await snap(page, 'fleet-running')
  await more.click()
  await expect(more).toHaveCount(0)
  await expect.poll(() => view.getByTestId('fleet-lanes').evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await sizeWindow(hop.app, page, 900, 640)
  await view.getByTestId('fleet-lanes').evaluate((el) => (el.scrollLeft = 0))
  await expect(more).toHaveText(/^\d+ more/)
  expect((await answer.boundingBox())!.width).toBeGreaterThanOrEqual(279)
  await snap(page, 'fleet-running')
  await sizeWindow(hop.app, page, 1100, 700)

  // P1-8: Esc closes the view, the run goes on, the status bar says so and reopens it.
  await view.getByTestId('fleet-answer').click()
  await page.keyboard.press('Escape')
  await expect(view).toBeHidden()
  const item = page.getByTestId('fleet-status-item')
  await expect(item).toHaveText(/Fleet · running/)
  await item.click()
  await expect(view).toBeVisible()
  await expect(item).toHaveCount(0)
  await expect(view.getByTestId('fleet-status')).toHaveAttribute('data-status', 'running')

  // P2: Stop run asks; Cancel has focus, so Enter keeps the run.
  await view.getByRole('button', { name: /^Stop run/ }).click()
  const ask = page.getByRole('dialog', { name: 'Stop the run?' })
  await expect(ask).toBeVisible()
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await snap(page, 'fleet-stop-confirm')
  await page.keyboard.press('Enter')
  await expect(ask).toBeHidden()
  await expect(view.getByTestId('fleet-status')).toHaveAttribute('data-status', 'running')
  // The lane stop also defaults to Cancel.
  await lane('core-sw1').getByRole('button', { name: 'Stop core-sw1' }).click()
  const askLane = page.getByRole('dialog', { name: 'Stop core-sw1?' })
  await expect(askLane.getByRole('button', { name: 'Cancel' })).toBeFocused()
  // Esc closes the confirm, not the view under it (Radix handed it to the view first).
  await page.keyboard.press('Escape')
  await expect(askLane).toBeHidden()
  await expect(view).toBeVisible()
  await expect(lane('core-sw1')).toHaveAttribute('data-status', 'running')
  // Mod+. is the shortcut, through the same confirm.
  await view.getByTestId('fleet-answer').click()
  await page.keyboard.press(`${MOD}+Period`)
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Stop run' }).click()
  await expect(view.getByTestId('fleet-status')).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 })
})

test('P2 health dot: a failed run marks the provider down, and the error row is in view', async ({ hop }) => {
  const { page } = hop
  hop.llm.ollama.script.push({ text: 'Gi1/0/2 is up.' })
  const composer = await connectModel(hop, 'qwen3:8b', true)
  // The empty panel (flat intro, header and trust bar on one line each) at the review's widths.
  for (const [w, h] of [
    [1100, 700],
    [900, 640]
  ] as const) {
    await sizeWindow(hop.app, page, w, h)
    await oneLine(page.getByTestId('ai-readonly'), 24)
    expect(await childrenInside(page.getByTestId('ai-trust'))).toEqual([])
    await headerWhole(page)
    await snap(page, 'ai-panel-empty')
  }
  const dot = page.getByTestId('ai-destination').getByRole('img')
  await expect(dot).toHaveAttribute('aria-label', 'connected')
  await composer.fill('is Gi1/0/2 up?')
  await composer.press('Enter')
  await expect(page.getByText('Gi1/0/2 is up.')).toBeVisible()
  // Ollama stops; the next question fails.
  await hop.llm.ollama.close()
  await composer.fill('again?')
  await composer.press('Enter')
  const log = page.getByRole('log', { name: 'Assistant conversation' })
  const err = log.getByRole('alert')
  await expect(err).toBeVisible({ timeout: 20_000 })
  await expect(dot).toHaveAttribute('aria-label', 'down', { timeout: 10_000 })
  // The whole error row is inside the transcript's visible area, not under the composer.
  await expect
    .poll(async () => {
      const l = (await log.boundingBox())!
      const r = (await err.boundingBox())!
      return r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1
    })
    .toBe(true)
  await snap(page, 'ollama-down-error')
})
