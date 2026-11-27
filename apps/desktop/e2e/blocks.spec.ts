import type { Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'
import { expect, test } from './fixtures'

type B = { id: number; command: string; output: string; prompt: string }
const blocks = (page: Page) => page.evaluate(() => (window as unknown as { __hoplineTest: { blocks: () => B[] } }).__hoplineTest.blocks())
const clip = (page: Page) => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get: () => string } } }).__hoplineTest.clipboard.get())
const atPrompt = /core-sw1#\s*$/
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'

test('a pointer-opened command toolbar stays available while reading its tooltip and clicking Copy', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show clock\r')
  await expect.poll(async () => (await blocks(page)).map((b) => b.command)).toContain('show clock')
  const point = await page.evaluate(() => {
    const term = (window as unknown as { __hoplineTest: { raw: () => Terminal } }).__hoplineTest.raw()
    const buffer = term.buffer.active
    const rect = term.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
    for (let y = 0; y < term.rows; y++) {
      if (buffer.getLine(buffer.viewportY + y)?.translateToString(true).endsWith('#show clock')) {
        return { x: rect.left + 20, y: rect.top + (y + 0.5) * rect.height / term.rows }
      }
    }
    throw new Error('show clock is outside the viewport')
  })
  await page.mouse.move(point.x, point.y)
  const bar = page.getByRole('toolbar', { name: 'Command block: show clock' })
  const copy = bar.getByRole('button', { name: 'Copy command', exact: true })
  await copy.hover()
  const tip = page.getByRole('tooltip').filter({ hasText: 'Copy command' })
  await expect(tip).toBeVisible()
  const bounds = (await tip.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 })
  await page.waitForTimeout(500)
  await expect(tip).toBeVisible()
  await copy.click()
  await expect.poll(() => clip(page)).toBe('show clock')
  await page.mouse.move(2, 2)
  await expect(bar).toBeHidden()
})

test('command blocks: detect, navigate, copy, table, changed since last run', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Vlan10[\s\S]*core-sw1#\s*$/)
  await expect.poll(async () => (await blocks(page)).map((b) => b.command)).toEqual(['show ip interface brief'])
  const [first] = await blocks(page)
  expect(first!.output).toMatch(/^Interface\s+IP-Address/)
  expect(first!.output).not.toMatch(/core-sw1#/)

  // Mod+↑ picks the block: the rail and the toolbar show; the device got nothing.
  await page.keyboard.press(`${MOD}+ArrowUp`)
  const bar = page.getByTestId('block-toolbar')
  await expect(bar).toBeVisible()
  await expect(page.getByTestId('block-rail')).toBeVisible()
  expect(await hop.termText()).toMatch(atPrompt)

  await bar.getByRole('button', { name: 'Copy output' }).click()
  await expect.poll(() => clip(page)).toBe(first!.output)
  await bar.getByRole('button', { name: 'Copy command' }).click()
  await expect.poll(() => clip(page)).toBe('show ip interface brief')

  await bar.getByRole('button', { name: 'Copy for ticket' }).click()
  await expect.poll(() => clip(page)).toContain('Device: core-sw1')
  expect(await clip(page)).toContain('    show ip interface brief')
  expect(await clip(page)).toContain('Vlan10')

  // The output parses (TextFSM): the Table button shows the row count and opens the table.
  const tableBtn = bar.getByRole('button', { name: 'Show as table' })
  await expect(tableBtn).toBeVisible()
  await tableBtn.click()
  const table = page.getByTestId('block-table')
  await expect(table).toBeVisible()
  await expect(table.getByText('First run')).toBeVisible()
  const grip = page.getByRole('separator', { name: 'Resize table viewer' })
  await page.locator('[data-table-drawer]').evaluate(async (drawer) => {
    await Promise.all(drawer.getAnimations().map((animation) => animation.finished))
  })
  const original = (await table.boundingBox())!.height
  const handle = (await grip.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 85, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await table.boundingBox())!.height).toBeGreaterThan(original + 60)
  await grip.focus()
  await page.keyboard.press('Home')
  await expect.poll(async () => Math.abs((await table.boundingBox())!.height - original)).toBeLessThan(2)
  await page.keyboard.press('Shift+ArrowUp')
  await expect.poll(async () => (await table.boundingBox())!.height).toBeGreaterThan(original + 55)
  const rows = await table.locator('tbody tr').count()
  expect(rows).toBeGreaterThan(2)
  await table.getByRole('textbox', { name: 'Filter rows' }).fill('Vlan')
  await expect.poll(() => table.locator('tbody tr').count()).toBeLessThan(rows)
  await table.getByRole('button', { name: 'CSV' }).click()
  await expect.poll(() => clip(page)).toMatch(/^INTERFACE,IP_ADDRESS/)
  // Sort by a column header.
  await table.getByRole('button', { name: /^Interface/ }).click()
  await expect(table.locator('th[aria-sort=ascending]')).toHaveCount(1)
  // Esc in the filter clears it; Esc elsewhere in the table closes it (and nothing reaches the device).
  await table.getByRole('textbox', { name: 'Filter rows' }).focus()
  await page.keyboard.press('Escape')
  await expect(table.getByRole('textbox', { name: 'Filter rows' })).toHaveValue('')
  await table.getByRole('button', { name: /^Interface/ }).focus()
  await page.keyboard.press('Escape')
  await expect(table).toBeHidden()

  // Round 2: block actions have keys (Mod+Alt+T table, Mod+Alt+C copy output), shown in the tooltips.
  await page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { set: (t: string) => void } } }).__hoplineTest.clipboard?.set?.(''))
  await page.keyboard.press(`${MOD}+ArrowUp`)
  await page.keyboard.press(`${MOD}+Alt+KeyC`)
  await expect.poll(() => clip(page)).toBe(first!.output)
  await page.keyboard.press(`${MOD}+Alt+KeyT`)
  await expect(table).toBeVisible()
  await expect(table.getByRole('textbox', { name: 'Filter rows' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(table).toBeHidden()
  expect(await hop.termText()).toMatch(atPrompt)

  // The terminal context menu offers the block under the pointer.
  await page.keyboard.press(`${MOD}+ArrowUp`)
  const rail = (await page.getByTestId('block-rail').boundingBox())!
  const screen = (await page.locator('.xterm-screen').first().boundingBox())!
  await page.mouse.click(screen.x + 40, rail.y + Math.min(rail.height / 2, 30), { button: 'right' })
  await expect(page.getByRole('menuitem', { name: /Show as table/ })).toBeVisible()
  await page.getByRole('menuitem', { name: /Copy command/ }).click()
  await expect.poll(() => clip(page)).toBe('show ip interface brief')

  // Re-run (a read): runs through main's guard and the executor; a second block appears and its
  // table compares against the first run.
  await page.keyboard.press(`${MOD}+ArrowUp`)
  await bar.getByRole('button', { name: 'Re-run' }).click()
  await expect.poll(async () => (await blocks(page)).length).toBe(2)
  await expect.poll(hop.termText).toMatch(atPrompt)
  // The executor holds user input until the device has been quiet at the prompt for a moment.
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused()
  await page.keyboard.press(`${MOD}+ArrowUp`)
  const latest = (await blocks(page)).at(-1)!
  await expect(bar).toHaveAttribute('data-block-id', String(latest.id))
  await expect(bar.getByRole('button', { name: 'Show as table' })).toBeVisible()
  await bar.getByRole('button', { name: 'Show as table' }).click()
  await expect(page.getByTestId('block-table').getByText(/No changes since|changes? since/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('block-table')).toBeHidden()

  // A config command is never re-run: it is only typed at the prompt, without Enter.
  await page.locator('.xterm').first().click()
  await page.keyboard.type('configure terminal\r')
  await expect.poll(hop.termText).toMatch(/core-sw1\(config\)#\s*$/)
  // Sync point: the tracker has seen the (config)# prompt (it closes the configure block there).
  // Typing within its quiet window reads as a redraw of the line, a known tracker race (0.6 report).
  await expect.poll(async () => (await blocks(page)).map((b) => b.command).at(-1)).toBe('configure terminal')
  await page.keyboard.type('end\r')
  await expect.poll(hop.termText).toMatch(atPrompt)
  await expect.poll(async () => (await blocks(page)).map((b) => b.command).slice(-2)).toEqual(['configure terminal', 'end'])
  await page.keyboard.press(`${MOD}+ArrowUp`)
  await page.keyboard.press(`${MOD}+ArrowUp`)
  await bar.getByRole('button', { name: 'Re-run' }).click()
  await expect(page.getByText('Inserted at the prompt, not run')).toBeVisible()
  await expect.poll(hop.termText).toMatch(/core-sw1#configure terminal$/)
  await page.waitForTimeout(400)
  expect(await hop.termText()).not.toMatch(/\(config\)#\s*$/)

  // Every attempt is in the audit log.
  const audit = await page.evaluate(() => (window as unknown as { hopline: { audit: { list: () => Promise<{ command: string; decision: string; source: string }[]> } } }).hopline.audit.list())
  expect(audit.find((r) => r.command === 'configure terminal')).toMatchObject({ decision: 'inserted', source: 'user' })
  expect(audit.find((r) => r.command === 'show ip interface brief')).toMatchObject({ decision: 'executed', source: 'user' })
})

test('command blocks: Ask AI sends the block to the assistant panel', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  // `?` help redraws the typed line under a new prompt: that is not a block.
  await page.keyboard.type('show ip ?')
  await expect.poll(hop.termText).toMatch(/access-lists[\s\S]*core-sw1#show ip\s*$/)
  await page.keyboard.press('Control+U')
  await page.waitForTimeout(300)
  expect(await blocks(page)).toEqual([])
  await page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
  await expect.poll(async () => (await blocks(page)).length).toBe(1)
  await page.keyboard.press(`${MOD}+ArrowUp`)
  await page.getByTestId('block-toolbar').getByRole('button', { name: 'Ask AI about this block' }).click()
  await expect(page.getByText('Explain this output', { exact: false }).first()).toBeVisible()
})

test('a key typed right after a prompt keeps the block that just closed (block detector race)', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  // The next command's first key goes out with the Enter, so its echo lands inside the detector's
  // quiet window right after the new prompt (or in the same chunk as it).
  await page.keyboard.type('show clock\rs')
  // The new prompt with the key after it (not the device's echo of the first `s` of `show clock`).
  await expect.poll(hop.termText).toMatch(/UTC[^\n]*\n[\s\S]*core-sw1#s\s*$/)
  await page.keyboard.type('how version\r')
  await expect.poll(hop.termText).toMatch(/uptime is[\s\S]*core-sw1#\s*$/)
  await expect.poll(async () => (await blocks(page)).map((b) => b.command)).toEqual(['show clock', 'show version'])

  // A key pressed the moment a prompt is parsed, typed from the page itself (no test-runner lag).
  await page.evaluate(() => {
    type Line = { translateToString: (trim: boolean) => string }
    type Term = { onWriteParsed: (cb: () => void) => { dispose: () => void }; input: (d: string, user: boolean) => void; buffer: { active: { baseY: number; cursorY: number; getLine: (y: number) => Line | undefined } } }
    const term = (window as unknown as { __hoplineTest: { raw: () => Term } }).__hoplineTest.raw()
    const d = term.onWriteParsed(() => {
      const b = term.buffer.active
      if (!/uptime is|UTC/.test(b.getLine(b.baseY + b.cursorY - 1)?.translateToString(true) ?? '')) return
      if (!/core-sw1#$/.test(b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '')) return
      d.dispose()
      term.input('show users\r', true)
    })
    term.input('show clock\r', true)
  })
  await expect.poll(async () => (await blocks(page)).map((b) => b.command)).toEqual(['show clock', 'show version', 'show clock', 'show users'])
})
