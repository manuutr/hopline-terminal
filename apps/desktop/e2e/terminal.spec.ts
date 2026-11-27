import { MOD, expect, test } from './fixtures'

test('connects to the simulator and runs a command', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/GigabitEthernet1\/0\/2\s+10\.0\.0\.1\s+YES manual administratively down/)
})

test('@ai in the terminal asks the assistant (no provider → connect card, question kept)', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('@ai why is bgp down?\r')
  await expect(hop.page.getByText('why is bgp down?')).toBeVisible()
  await expect(hop.page.getByTestId('ai-waiting')).toHaveText(/Waiting for a model/)
  // P1-7 / F2: one place to connect, in place of the composer; nothing that can only fail stays active.
  await expect(hop.page.getByRole('form', { name: 'Connect a model' })).toBeVisible()
  await expect(hop.page.getByPlaceholder(/Ask about/)).toHaveCount(0)
  await expect(hop.page.getByText(/No AI provider is connected/)).toHaveCount(0)
  // The device line was cleared, so the prompt is clean.
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
})

test('@ai works after Ctrl+Z leaves config mode, after Up-arrow, and with a leading space', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('conf t\r')
  await expect.poll(hop.termText).toMatch(/core-sw1\(config\)#\s*$/)
  // Ctrl+Z: the device prints a fresh prompt with no Enter from the user.
  await page.keyboard.press('Control+z')
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  await page.keyboard.type('@ai why did config mode end?\r')
  await expect(page.getByText('why did config mode end?')).toBeVisible()
  expect(await hop.termText()).not.toMatch(/Invalid input/)

  // History recall, then clear the line: still detected.
  await page.keyboard.press('ArrowUp')
  await expect.poll(hop.termText).toMatch(/core-sw1#conf t\s*$/)
  await page.keyboard.press('Control+u')
  await page.keyboard.type(' @ai and with a leading space?\r')
  await expect(page.getByText('and with a leading space?')).toBeVisible()
  expect(await hop.termText()).not.toMatch(/Invalid input/)
})

test('audit log and settings open from the palette', async ({ hop }) => {
  await hop.page.keyboard.press(`${MOD}+K`)
  await hop.page.keyboard.type('audit')
  await hop.page.keyboard.press('Enter')
  await expect(hop.page.getByRole('dialog', { name: 'AI audit log' })).toBeVisible()
})

test('telnet session: in-band login and a command', async ({ hop }) => {
  await hop.page.getByText('core-sw1 (telnet)', { exact: true }).first().dblclick()
  await expect.poll(hop.termText).toMatch(/Username:\s*$/)
  await hop.page.locator('.xterm').first().click()
  await hop.page.keyboard.type('admin\r')
  await expect.poll(hop.termText).toMatch(/Password:\s*$/)
  await hop.page.keyboard.type('admin\r')
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  // The password is never echoed back.
  expect(await hop.termText()).not.toMatch(/Password:\s*admin/)
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
})

test('known hosts: first connection is trusted and listed', async ({ hop }) => {
  await hop.connect('core-sw1')
  // Plain Ctrl+K belongs to the device while a terminal has focus; the palette is Ctrl+Shift+K.
  await hop.page.keyboard.press(`${MOD}+K`)
  await hop.page.keyboard.type('known hosts')
  await hop.page.keyboard.press('Enter')
  const dialog = hop.page.getByRole('dialog', { name: 'Known hosts' })
  await expect(dialog.getByText('127.0.0.1')).toBeVisible()
  await expect(dialog.getByText('first use')).toBeVisible()
})

test('host key changed: the user is warned and can refuse', async ({ hop }) => {
  await hop.connect('core-sw1')
  // Pretend the stored key is a different one, then reconnect.
  await hop.app.evaluate(() => {
    const host = (globalThis as unknown as { __hoplineHost: { repo: { replaceHostKeys(h: string, p: number, f: string): void } } }).__hoplineHost
    const sessions = (host as unknown as { tabs: Map<string, { session: { host: string; port: number } }> }).tabs
    const s = [...sessions.values()][0]!.session
    host.repo.replaceHostKeys(s.host, s.port, 'SHA256:somebody-else')
  })
  await hop.page.keyboard.type('exit\r')
  await expect.poll(hop.termText).toMatch(/Press Enter to reconnect\.\s*$/)
  await hop.page.keyboard.type('\r')
  const dialog = hop.page.getByRole('dialog', { name: 'Host key changed' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('SHA256:somebody-else')).toBeVisible()
  // The safe choice has focus, so Enter does not replace the key.
  await expect(dialog.getByRole('button', { name: "Don't connect" })).toBeFocused()
  await dialog.getByRole('button', { name: "Don't connect" }).click()
  await expect.poll(hop.termText).toMatch(/changed|Connection failed/)
})

test('scrollback: history comes back (encrypted) when the session is reopened', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
  await hop.page.keyboard.press(`${MOD}+W`)
  await expect(hop.page.getByRole('dialog', { name: 'Close core-sw1?' })).toBeVisible()
  await hop.page.keyboard.press('Enter') // confirm closing the connected session
  await expect.poll(hop.termText).toBe('')
  await hop.connect('core-sw1')
  const text = await hop.termText()
  expect(text).toMatch(/Cisco IOS[\s\S]*restored history from[\s\S]*core-sw1#\s*$/)
})

test('find in all tabs jumps to the matching line', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
  await hop.connect('dist-eos1')
  await hop.page.keyboard.press(`${MOD}+Alt+F`)
  const dialog = hop.page.getByRole('dialog', { name: 'Find in all tabs' })
  await dialog.getByRole('textbox').fill('cisco ios')
  await expect(dialog.getByRole('option').first()).toContainText('Cisco IOS')
  await hop.page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  // The core-sw1 tab is active again, with the match selected.
  await expect(hop.page.getByRole('tab', { selected: true })).toContainText('core-sw1')
  await expect
    .poll(() => hop.page.evaluate(() => (window as unknown as { __hoplineTest: { selection: () => string } }).__hoplineTest.selection()))
    .toMatch(/^cisco ios$/i)
})

test('exit ends the session without logging back in', async ({ hop }) => {
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('exit\r')
  await expect.poll(hop.termText).toMatch(/Session closed: session ended by the device\. Press Enter to reconnect\./)
  await hop.page.waitForTimeout(3000)
  expect(await hop.termText()).not.toMatch(/Reconnecting in/)
  // P1-12: a pane-level strip says so, and its Reconnect button logs back in.
  const strip = hop.page.getByRole('status').filter({ hasText: 'Disconnected' })
  await expect(strip).toContainText('session ended by the device')
  await strip.getByRole('button', { name: /Reconnect/ }).click()
  await expect(strip).toBeHidden()
  await expect.poll(hop.termText, { timeout: 15_000 }).toMatch(/core-sw1[#>]\s*$/)
})
