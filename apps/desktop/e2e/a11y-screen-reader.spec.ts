import type { Page } from '@playwright/test'
import { axeCheck } from './support/axe'
import { expect, test } from './fixtures'

/**
 * Screen reader mode and the accessible buffer view (Phase 6, docs/ACCESSIBILITY.md). A screen
 * reader is faked with HOPLINE_E2E_SCREEN_READER=1 (dev e2e builds only): no desktop reports one.
 */

const clip = (page: Page) => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get: () => string } } }).__hoplineTest.clipboard.get())
const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'

/** Record every announcement of the polite region with its time. */
async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __said: { t: number; text: string }[] }
    w.__said = []
    const el = document.querySelector('[data-testid=sr-announcer]')!
    new MutationObserver(() => w.__said.push({ t: performance.now(), text: el.textContent ?? '' })).observe(el, { childList: true, characterData: true, subtree: true })
  })
}
const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: { t: number; text: string }[] }).__said)

test.describe('with a screen reader running', () => {
  test.use({ hopEnv: { HOPLINE_E2E_SCREEN_READER: '1' } })

  test('the mode is offered, never forced; output is announced politely, throttled, and a flood is summarised', async ({ hop }) => {
    const { page } = hop
    const offer = page.getByText('Screen reader detected')
    await expect(offer).toBeVisible()
    // Not on until the user says so.
    expect((await page.evaluate(() => window.hopline.settings.get())).termScreenReader).toBe(false)
    await page.getByRole('button', { name: 'Turn on' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.hopline.settings.get())).termScreenReader).toBe(true)
    await expect(page.getByTestId('sr-announcer')).toHaveAttribute('aria-live', 'polite')

    await hop.connect('core-sw1')
    // xterm's accessibility tree is there; its own (assertive) live region is muted.
    await expect(page.locator('.xterm-accessibility').first()).toBeAttached()
    await expect.poll(() => page.locator('.xterm-accessibility .live-region').first().getAttribute('aria-live')).toBe('off')
    await recordAnnouncements(page)
    await page.keyboard.type('show clock\r')
    await expect.poll(async () => (await said(page)).map((s) => s.text).join('\n')).toMatch(/UTC[\s\S]*core-sw1#/)

    // A flood: one summary, not a thousand lines; and never more than one announcement a second.
    await page.keyboard.type('show running-config\r')
    await expect.poll(async () => (await said(page)).some((s) => /lines of output\. Last: /.test(s.text)), { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(1500)
    const all = (await said(page)).filter((s) => s.text)
    for (const s of all) expect(s.text.length).toBeLessThan(600)
    for (let i = 1; i < all.length; i++) expect(all[i]!.t - all[i - 1]!.t).toBeGreaterThan(900)

    // Off again from the palette: nothing more is announced.
    await page.keyboard.press(`${mod}+K`)
    await page.getByRole('combobox', { name: 'Command palette' }).fill('>Turn off screen reader')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.hopline.settings.get())).termScreenReader).toBe(false)
    await page.locator('.xterm').first().click()
    const n = (await said(page)).length
    await page.keyboard.type('show clock\r')
    await expect.poll(hop.termText).toMatch(/UTC[\s\S]*UTC[\s\S]*core-sw1#\s*$/)
    await page.waitForTimeout(1300)
    expect((await said(page)).slice(n).map((s) => s.text).join('')).not.toMatch(/UTC/)
  })
})

test('no screen reader: no offer; the setting is in Settings > Terminal', async ({ hop }) => {
  const { page } = hop
  await page.waitForTimeout(800)
  await expect(page.getByText('Screen reader detected')).toHaveCount(0)
  await page.keyboard.press(`${mod}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Terminal', exact: true }).click()
  await expect(dlg.getByRole('switch', { name: 'Screen reader mode' }).or(dlg.getByLabel('Screen reader mode'))).toBeVisible()
})

test('accessible buffer view: plain text, jump by command, find, copy a range and a block, focus returns', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/GigabitEthernet1\/0\/2[\s\S]*core-sw1#\s*$/)
  const blocks = () =>
    page.evaluate(() => (window as unknown as { __hoplineTest: { blocks: () => { command: string }[] } }).__hoplineTest.blocks().map((b) => b.command))
  // The tracker sees a prompt once output has been quiet for a moment; a person types the next
  // command after that, so the test does too (under a loaded run it would otherwise type first).
  await expect.poll(blocks).toEqual(expect.arrayContaining(['show ip interface brief']))
  await page.keyboard.type('show clock\r')
  await expect.poll(hop.termText).toMatch(/UTC[\s\S]*core-sw1#\s*$/)
  // Both command blocks are detected before the snapshot is taken.
  await expect.poll(blocks).toEqual(expect.arrayContaining(['show ip interface brief', 'show clock']))

  await page.keyboard.press(`${mod}+Alt+B`)
  const dlg = page.getByRole('dialog', { name: 'Terminal text: core-sw1' })
  await expect(dlg).toBeVisible()
  const text = dlg.getByTestId('buffer-text')
  await expect(text).toBeFocused()
  await expect(text).toHaveValue(/show ip interface brief[\s\S]*GigabitEthernet1\/0\/2[\s\S]*show clock/)
  await axeCheck(page, 'accessible buffer view')

  // Alt+Up from the end: the last command's prompt line is selected and announced.
  await page.keyboard.press('Alt+ArrowUp')
  await expect(dlg.getByTestId('buffer-status')).toHaveText(/^Command \d+ of \d+: show clock$/)
  await page.keyboard.press('Alt+ArrowUp')
  await expect(dlg.getByTestId('buffer-status')).toHaveText(/: show ip interface brief$/)
  expect(await text.evaluate((a: HTMLTextAreaElement) => a.value.slice(a.selectionStart, a.selectionEnd))).toMatch(/core-sw1#\s*show ip interface brief/)

  // Copy a range: extend the selection with the keyboard, Ctrl+C (the in-memory test clipboard).
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('ControlOrMeta+C') // Playwright sends the copy command for ⌘C on macOS
  await expect.poll(() => clip(page)).toMatch(/show ip interface brief\n.*Interface/)

  // The block at the cursor: its output, without the prompt line.
  await dlg.getByRole('button', { name: 'Copy command output' }).click()
  await expect.poll(() => clip(page)).toMatch(/^Interface[\s\S]*GigabitEthernet1\/0\/2/)
  expect(await clip(page)).not.toMatch(/core-sw1#/)

  // Find: Enter goes to the next match and says where it is.
  const find = dlg.getByLabel('Find in terminal text')
  await find.fill('gigabitethernet')
  await find.press('Enter')
  await expect(dlg.getByTestId('buffer-status')).toHaveText(/^1 of \d+$/)
  await find.press('Enter')
  await expect(dlg.getByTestId('buffer-status')).toHaveText(/^2 of \d+$/)

  // Esc closes; the keyboard is back in the terminal.
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused()
})
