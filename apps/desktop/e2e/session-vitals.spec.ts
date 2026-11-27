import { runtime } from '../../../packages/simulator/src/core/runtime'
import { expect, showSessions, test } from './fixtures'

test('a measured echo, severe syslog and connection outcome reach the workspace', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await expect(page.locator('[data-connection-strip]')).toContainText('Authenticated as admin')
  await page.keyboard.type('show interfaces status\r', { delay: 25 })
  await expect(page.getByLabel('Device echo round trip')).toHaveText(/\d+ ms RTT/)
  await showSessions(page)
  runtime(hop.sims.ios.device).broadcast('%BGP-3-NOTIFICATION: neighbor 10.0.0.2 Down')
  await expect.poll(hop.termText).toContain('BGP-3-NOTIFICATION')
  await page.getByRole('button', { name: '%BGP-3-NOTIFICATION · Jump to line' }).first().click()
  await page.locator('.xterm:visible').click()
  await page.keyboard.type('exit\r')
  await expect(page.locator('[data-connection-strip]')).toContainText('Disconnected')
  await page.keyboard.press('r')
  await expect(page.locator('[data-connection-strip]')).toContainText('Authenticated as admin')
})
