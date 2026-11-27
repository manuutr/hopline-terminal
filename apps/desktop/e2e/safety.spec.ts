import { createServer, type AddressInfo } from 'node:net'
import { MOD, expect, test } from './fixtures'

test('closing a connected session asks first; Esc keeps it, Enter closes; a down session closes at once', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const confirm = page.getByRole('dialog', { name: 'Close core-sw1?' })

  // Mod+W: asks. Esc cancels, the session survives and keeps the keyboard.
  await page.keyboard.press(`${MOD}+W`)
  await expect(confirm).toBeVisible()
  await expect(confirm.getByRole('button', { name: 'Close tab' })).toBeFocused()
  // App shortcuts are ignored behind the dialog: a second Mod+W does not close the tab.
  await page.keyboard.press(`${MOD}+W`)
  // (The modal hides the rest of the page from the accessibility tree, hence includeHidden.)
  await expect(page.getByRole('tab', { includeHidden: true })).toHaveCount(1)
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(page.getByRole('tab')).toHaveCount(1)
  // Radix hands focus back a few ms after the dialog leaves the DOM: wait for it before typing.
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused()
  await page.keyboard.type('show clock\r')
  await expect.poll(hop.termText).toMatch(/show clock[\s\S]*core-sw1#\s*$/)

  // Middle-click on the tab asks too; Enter confirms.
  await page.getByRole('tab', { name: 'core-sw1' }).click({ button: 'middle' })
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(confirm).toBeHidden()
  await expect(page.getByRole('tab')).toHaveCount(0)

  // A session that is down closes without a question.
  await hop.connect('core-sw1')
  await page.keyboard.type('exit\r')
  // A deliberate logout doesn't auto-reconnect: the session is down.
  await expect.poll(hop.termText).toMatch(/Press Enter to reconnect\.\s*$/)
  await page.keyboard.press(`${MOD}+W`)
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Enter in the password dialog logs in (the password field has focus)', async ({ hop }) => {
  const { page } = hop
  // A session without a saved credential always asks for the password.
  await page.evaluate(async (port) => {
    const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<unknown> } } }).hopline
    await h.sessions.save({
      folderId: null, name: 'ask-pw', host: '127.0.0.1', port, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {}
    })
  }, hop.sims.ios.port)
  await page.reload()
  await page.getByText('ask-pw', { exact: true }).first().dblclick()
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect(pw).toBeVisible()
  await expect(pw).toBeFocused()
  // Real keystrokes, not fill(): they go wherever focus is.
  await page.keyboard.type('admin')
  await page.keyboard.press('Enter')
  await expect(pw).toBeHidden()
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
})

test('Ctrl+Shift+6 sends Ctrl+^ (0x1E) to the device, and @ai still works after it', async ({ hop }) => {
  const { page } = hop
  // A raw TCP "device" the test owns, so the bytes that arrive can be checked.
  let received = ''
  const server = createServer((sock) => {
    sock.write('raw-dev> ')
    sock.on('data', (d) => (received += d.toString('latin1')))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as AddressInfo).port
    await page.evaluate(async (p) => {
      const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<unknown> } } }).hopline
      await h.sessions.save({
        folderId: null, name: 'raw-dev', host: '127.0.0.1', port: p, protocol: 'raw', platform: 'iosxe', username: '', credentialId: null, logToFile: false, notes: '', options: {}
      })
    }, port)
    await page.reload()
    await page.getByText('raw-dev', { exact: true }).first().dblclick()
    await expect.poll(hop.termText).toMatch(/raw-dev>$/) // (text() trims the trailing space)
    await page.locator('.xterm').first().click()

    await page.keyboard.type('ping')
    await page.keyboard.press('Control+Shift+Digit6')
    await expect.poll(() => received).toBe('ping\x1e')
    // No app shortcut fired.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(1)

    // The escape does not disturb the "@ai" line tracking: a fresh line still goes to the assistant.
    await page.keyboard.press('Enter')
    await page.keyboard.type('@ai why did ping stop?\r')
    await expect(page.getByText('why did ping stop?')).toBeVisible()
    expect(received).not.toContain('why did ping stop')
  } finally {
    server.close()
  }
})

test('Mod+, opens settings on Linux (Shift+, is "<")', async ({ hop }) => {
  await hop.page.keyboard.press(`${MOD}+Comma`)
  await expect(hop.page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
})

test('turning off restore history offers to delete what is saved', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
  // Closing saves the history.
  await page.keyboard.press(`${MOD}+W`)
  await expect(page.getByRole('dialog', { name: 'Close core-sw1?' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab')).toHaveCount(0)

  await page.keyboard.press(`${MOD}+Comma`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('tab', { name: 'Terminal', exact: true }).click()
  await settings.getByRole('switch', { name: 'Restore history' }).click()
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  const offer = page.getByRole('dialog', { name: 'Delete saved terminal history?' })
  await expect(offer).toBeVisible()
  await offer.getByRole('button', { name: 'Delete history' }).click()
  await expect(page.getByText('Saved terminal history deleted')).toBeVisible()

  // Turn restoring back on: the reopened session starts clean.
  await page.keyboard.press(`${MOD}+Comma`)
  await settings.getByRole('tab', { name: 'Terminal', exact: true }).click()
  await settings.getByRole('switch', { name: 'Restore history' }).click()
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await hop.connect('core-sw1')
  expect(await hop.termText()).not.toMatch(/restored history/)
})

test('@ai never reaches the device: fast typing and paste over a slow-echo (WAN-like) link', async ({ hop }) => {
  const { page } = hop
  // A raw TCP "device" that echoes like a router 150 ms away, and records every byte it receives.
  let received = ''
  const server = createServer((sock) => {
    sock.write('wan-dev> ')
    sock.on('data', (d) => {
      const s = d.toString('latin1')
      received += s
      const echo = s.replace(/\r/g, '\r\nwan-dev> ').replace(/\x7f/g, '\b \b')
      setTimeout(() => !sock.destroyed && sock.write(echo), 150)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as AddressInfo).port
    await page.evaluate(async (p) => {
      const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<unknown> } } }).hopline
      await h.sessions.save({
        folderId: null, name: 'wan-dev', host: '127.0.0.1', port: p, protocol: 'raw', platform: 'iosxe', username: '', credentialId: null, logToFile: false, notes: '', options: {}
      })
    }, port)
    await page.reload()
    await page.getByText('wan-dev', { exact: true }).first().dblclick()
    await expect.poll(hop.termText).toMatch(/wan-dev>$/)
    await page.locator('.xterm').first().click()

    // 1. Typed as fast as the keyboard goes: no byte of "@ai …" reaches the device.
    await page.keyboard.type('@ai why is bgp to 10.0.0.2 down?\r')
    await expect(page.getByText('why is bgp to 10.0.0.2 down?')).toBeVisible()
    await page.waitForTimeout(400) // any late echo would have landed
    expect(received).toBe('')
    expect((await hop.termText()).trimEnd()).toMatch(/wan-dev>$/) // the line is clean, nothing garbled

    // 2. Pasted in one chunk, with a device command after it: the question goes to the
    //    assistant, the command (only) to the device.
    // The app's in-memory test clipboard: e2e never touches the real one.
    await page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { set: (t: string) => void } } }).__hoplineTest.clipboard.set('@ai which port is aabb.cc00.0110 on?\nshow version\n'))
    await page.keyboard.press('Control+Shift+V') // the in-memory test clipboard (TerminalView), on every OS: ⌘V reads the real one
    // Two lines: the in-app confirmation previews them; Enter pastes.
    const ask = page.getByRole('dialog', { name: 'Paste 2 lines into wan-dev?' })
    await expect(ask).toBeVisible()
    await expect(ask.locator('pre')).toHaveText('@ai which port is aabb.cc00.0110 on?\nshow version')
    await expect(ask.getByRole('button', { name: 'Paste' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByText('which port is aabb.cc00.0110 on?')).toBeVisible()
    await expect.poll(() => received).toBe('show version\r')

    // 3. Not "@ai": the held "@a" goes to the device after all, shown once (not "@a@as").
    received = ''
    await page.keyboard.type('@as\r')
    await expect.poll(() => received).toBe('@as\r')
    await expect.poll(hop.termText).toMatch(/wan-dev> @as\r?\n/)
    expect(await hop.termText()).not.toMatch(/@a@a/)
  } finally {
    server.close()
  }
})
