import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { expect, test } from './fixtures'

let bastion: RunningSim
test.beforeAll(async () => {
  bastion = await startSim({ device: makeIosDevice(), port: 0, forwarding: true })
})
test.afterAll(() => bastion.close())

/** Answer every password prompt the dialog shows until the terminal reaches `ready`. */
async function loginThroughPrompts(hop: Parameters<Parameters<typeof test>[1]>[0]['hop'], ready: RegExp, seen: string[]) {
  const pw = hop.page.locator('[role=dialog] input[type=password]')
  for (let i = 0; i < 40 && !ready.test(await hop.termText()); i++) {
    if (await pw.first().isVisible()) {
      seen.push((await hop.page.locator('[role=dialog]').innerText()).split('\n').slice(0, 3).join(' '))
      await pw.first().fill('admin')
      await pw.first().press('Enter')
    }
    await hop.page.waitForTimeout(150)
  }
  await expect.poll(hop.termText).toMatch(ready)
}

test('SSH through a jump host, with a prompt per hop', async ({ hop }) => {
  const ports = { bastion: bastion.port, target: hop.sims.ios.port }
  await hop.page.evaluate(async (p) => {
    const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<{ id: string }> } } }).hopline
    const base = { folderId: null, host: '127.0.0.1', protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '' }
    const b = await h.sessions.save({ ...base, name: 'bastion', port: p.bastion, options: {} })
    await h.sessions.save({ ...base, name: 'behind-bastion', port: p.target, options: { ssh: { jump: [b.id] } } })
  }, ports)
  await hop.page.reload()
  await hop.page.getByText('behind-bastion', { exact: true }).first().dblclick()
  const seen: string[] = []
  await loginThroughPrompts(hop, /core-sw1#\s*$/, seen)
  // One password prompt for the bastion hop, one for the target.
  expect(seen.length).toBe(2)
  expect(seen[0]).toContain('Sign in to bastion')
  expect(seen[1]).toContain('Sign in to behind-bastion')
  expect(await hop.termText()).toMatch(/via bastion/)
  await hop.page.locator('.xterm').first().click()
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)
})

test('a wrong password says so in the prompt, with the attempt count, then the right one connects', async ({ hop }) => {
  await hop.page.evaluate(async (port) => {
    const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<{ id: string }> } } }).hopline
    await h.sessions.save({ folderId: null, name: 'ask-pw', host: '127.0.0.1', port, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} })
  }, hop.sims.ios.port)
  await hop.page.reload()
  await hop.page.getByText('ask-pw', { exact: true }).first().dblclick()
  const dlg = hop.page.getByRole('dialog')
  const pw = dlg.locator('input[type=password]')
  await expect(pw).toBeVisible()
  // First ask: no error yet.
  await expect(dlg.getByRole('alert')).toHaveCount(0)
  await pw.fill('wrong')
  await pw.press('Enter')
  // Asked again: the reason and the attempt count, the field focused and marked invalid.
  await expect(dlg.getByRole('alert')).toHaveText(/Wrong password\. Try again \(attempt 2 of 3\)/)
  await expect(pw).toBeFocused()
  await expect(pw).toHaveAttribute('aria-invalid', 'true')
  await pw.fill('admin')
  // Open the tab menu immediately after sign-in, then advance past focus restoration.
  const now = new Date()
  await hop.page.clock.install({ time: now })
  await hop.page.clock.pauseAt(new Date(now.getTime() + 1000))
  await pw.press('Enter')
  const tab = hop.page.getByRole('tab', { name: 'ask-pw' })
  await tab.dispatchEvent('contextmenu', { button: 2, clientX: 300, clientY: 20 })
  const files = hop.page.getByRole('menuitem', { name: /Files/ })
  await expect(files).toBeVisible()
  await hop.page.clock.runFor(180)
  await expect(files).toBeVisible()
  await files.click()
  await hop.page.clock.resume()
  await expect(hop.page.getByRole('region', { name: 'Files' })).toBeVisible()
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
})
