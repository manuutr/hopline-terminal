import { createServer, type AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { makeDevice, startSim, type SimPlatform } from '../../../packages/simulator/src/index.ts'
import type { AuditRow } from '../src/shared/types'
import { MOD, expect, test, type Hopline } from './fixtures'

const SHOTS = process.env['HOPLINE_SHOTS']
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const audit = (page: Page) => page.evaluate(() => (window as unknown as { hopline: { audit: { list: (n: number) => Promise<AuditRow[]> } } }).hopline.audit.list(50))

/** Quick connect (Auto-detect by default) to a local port and answer the password prompt. */
async function quick(hop: Hopline, port: number, ready: RegExp) {
  const { page } = hop
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press(`${MOD}+O`)
  const input = page.getByRole('textbox', { name: 'Quick connect' })
  await input.fill(`admin@127.0.0.1:${port}`)
  await expect(page.getByText(/Connect: SSH · admin@127\.0\.0\.1.*Auto-detect/)).toBeVisible()
  await input.press('Enter')
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect(pw).toBeVisible()
  await pw.fill('admin')
  await pw.press('Enter')
  await expect.poll(hop.termText).toMatch(ready)
}

async function withSim<T>(p: SimPlatform, fn: (port: number) => Promise<T>): Promise<T> {
  const sim = await startSim({ device: makeDevice(p), port: 0 })
  try {
    return await fn(sim.port)
  } finally {
    await sim.close()
  }
}

test('auto-detect: a quick connect to IOS-XE is identified with one audited probe, and can be changed', async ({ hop }) => {
  const { page } = hop
  await quick(hop, hop.sims.ios.port, /core-sw1#/)
  // The toast names what was found; the status bar keeps showing it.
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: /Detected Cisco IOS-XE/ })
  await expect(toast).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /Cisco IOS-XE/ })).toBeVisible()
  await shot(page, 'detect-toast')
  // The probe ran in the terminal, through the guard, as the app's own read.
  await expect.poll(hop.termText).toMatch(/show version[\s\S]*Cisco IOS XE Software/)
  const rows = (await audit(page)).filter((r) => r.source === 'app')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ command: 'show version', kind: 'read', decision: 'executed', reason: expect.stringMatching(/^auto-detect/) })

  // "Change" opens the platform picker.
  await toast.getByRole('button', { name: 'Change' }).click()
  const dlg = page.getByRole('dialog', { name: 'Set platform' })
  await expect(dlg).toBeVisible()
  await dlg.getByRole('combobox', { name: 'Platform' }).click()
  await page.getByRole('option', { name: /Cisco IOS\b(?!-)/ }).first().click()
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dlg).toBeHidden()
  await expect(page.getByRole('button', { name: /^· Cisco IOS$/ })).toBeVisible()
})

test('auto-detect: Junos over its own SSH identification and version command', async ({ hop }) => {
  await withSim('junos', async (port) => {
    await quick(hop, port, />\s*$/)
    await expect(hop.page.locator('[data-sonner-toast]').filter({ hasText: /Detected Juniper Junos/ })).toBeVisible({ timeout: 15_000 })
  })
})

test('auto-detect: an unmodelled device stays unknown and the AI is blocked on it', async ({ hop }) => {
  const { page } = hop
  await withSim('routeros', async (port) => {
    await quick(hop, port, /\] >\s*$/)
    const notice = page.getByRole('button', { name: /Platform unknown — AI commands blocked · Set platform/ })
    await expect(notice).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-glyph="unknown"]').first()).toBeVisible()
    // No autocomplete on an unknown platform.
    await page.keyboard.type('sh')
    await expect.poll(hop.termText).toMatch(/\] >\s*sh$/)
    expect(await page.evaluate(() => (window as unknown as { __hoplineTest: { ghost: () => { text: string } } }).__hoplineTest.ghost().text)).toBe('')
    await page.keyboard.press('Control+U')
    await shot(page, 'detect-unknown')
    await notice.click()
    await expect(page.getByRole('dialog', { name: 'Set platform' })).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test('auto-detect: a new saved session defaults to Auto-detect and keeps what was detected', async ({ hop }) => {
  const { page } = hop
  await page.getByRole('button', { name: 'New session' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'New session' })
  await expect(dlg.getByRole('combobox', { name: 'Platform' })).toHaveText(/Auto-detect/)
  await dlg.getByPlaceholder('core-sw1').fill('edge-eos-auto')
  await dlg.getByPlaceholder('10.0.0.1 or hostname').fill('127.0.0.1')
  await dlg.locator('input[type=number]').first().fill(String(hop.sims.eos.port))
  await dlg.getByPlaceholder('admin').fill('admin')
  await dlg.getByRole('button', { name: 'Add session' }).click()
  await expect(dlg).toBeHidden()
  const row = () => page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem', { name: 'edge-eos-auto' }).first()
  await expect(row()).toContainText('AUTO')
  await row().dblclick()
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect(pw).toBeVisible()
  await pw.fill('admin')
  await pw.press('Enter')
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Detected Arista EOS/ })).toBeVisible({ timeout: 15_000 })
  await expect(row()).toContainText('EOS')
  // Stored in the database: a reload reads it back.
  await page.reload()
  await expect(row()).toContainText('EOS')
  const s = await page.evaluate(async () => (await window.hopline.sessions.list()).sessions.find((x) => x.name === 'edge-eos-auto'))
  expect(s).toMatchObject({ platform: 'eos', detected: { confidence: expect.any(Number) } })
})

test('auto-detect sends nothing to a raw server at a password prompt or an unrecognised prompt', async ({ hop }) => {
  const { page } = hop
  for (const greeting of ['User Access Verification\r\n\r\nPassword: ', 'Welcome\r\nmystery-box $$ ']) {
    let received = 0
    const srv = createServer((c) => {
      c.write(greeting)
      c.on('data', (b) => (received += b.length))
      c.on('error', () => {})
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press(`${MOD}+O`)
    await page.getByRole('textbox', { name: 'Quick connect' }).fill(`raw://127.0.0.1:${port}`)
    await page.getByRole('textbox', { name: 'Quick connect' }).press('Enter')
    await expect.poll(hop.termText).toContain(greeting.split('\r\n').at(-1)!.trim())
    // Past the settle time: detection has looked and given up (or keeps waiting at Password:).
    await page.waitForTimeout(4500)
    expect(received).toBe(0)
    expect((await audit(page)).filter((r) => r.source === 'app')).toEqual([])
    srv.close()
  }
})
