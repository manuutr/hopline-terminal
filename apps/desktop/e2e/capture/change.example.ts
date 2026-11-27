import { test, expect } from '@playwright/test'
import { makeDevice } from '../../../../packages/simulator/src/index.ts'
import { fakeOllama } from '../../test/fake-llm'
import { MOD } from '../fixtures'
import { command, connect, picture, withDevices } from './example-session'

test('review a proposed circuit turn-up and roll it back when the carrier stays down', async () => {
  const router = makeDevice('ios')
  const uplink = router.interfaces.find(i => i.name === 'GigabitEthernet1/0/2')!
  uplink.linkUp = false
  const model = await fakeOllama({ models: ['qwen3:8b'], script: [
    { tools: [{ name: 'run_show_command', arguments: { command: 'show ip interface brief', reason: 'Check the local circuit state' } }] },
    { tools: [{ name: 'run_show_command', arguments: { command: 'show ip bgp summary', reason: 'Identify the affected peer and a working control' } }] },
    { text: 'Peer 10.0.0.2 is Idle. The local circuit on GigabitEthernet1/0/2 is administratively down. The other peer, 10.0.0.6, still receives prefixes. Carrier on the disabled link is unknown.' },
    { tools: [{ name: 'propose_config_change', arguments: {
      commands: ['interface GigabitEthernet1/0/2', 'no shutdown'],
      rationale: 'Enable the approved standby circuit. Keep the change only if the interface gains carrier and the BGP session establishes.',
      rollback: ['interface GigabitEthernet1/0/2', 'shutdown'],
      verify: [
        { command: 'show ip interface brief | include GigabitEthernet1/0/2', expect: 'GigabitEthernet1/0/2 is up/up' },
        { command: 'show ip bgp summary | include 10.0.0.2', expect: '10.0.0.2 has an established session' }
      ]
    } }] },
    { tools: [{ name: 'report_verification', arguments: { verified: false, summary: 'GigabitEthernet1/0/2 still has no carrier. The peer is Active and has received no prefixes. The acceptance checks failed.' } }] },
    { text: 'The local port is back in its previous state. Check the far-end handoff with the carrier before the next turn-up.' }
  ] })
  try {
    await withDevices('Change window', [{ name: 'Border switch', platform: 'iosxe', device: router }], async page => {
      const snap = (name: string) => picture(page, 'circuit-rollback', name)
      await page.evaluate(url => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b', aiReadOnly: false }), model.url)
      await page.reload()
      await connect(page, 'Border switch', /core-sw1#\s*$/)
      await command(page, 'show ip bgp summary', /10\.0\.0\.2[^\n]*Idle[\s\S]*core-sw1#\s*$/)
      await page.keyboard.press(MOD + '+I')
      const divider = page.getByRole('separator', { name: 'Resize assistant panel' })
      const bounds = await divider.boundingBox()
      if (!bounds) throw new Error('Assistant divider is hidden')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds.x - 185, bounds.y + bounds.height / 2, { steps: 8 })
      await page.mouse.up()
      const composer = page.getByPlaceholder(/Ask about Border switch/)
      await composer.fill('Why is the standby transit peer idle? Compare the two sessions and check the local uplink.')
      await composer.press('Enter')
      await expect(page.getByText(/Carrier on the disabled link is unknown/)).toBeVisible()
      await snap('01-investigation')
      await composer.fill('The turn-up is authorized for this window. Show the exact change, the rollback and the acceptance checks.')
      await composer.press('Enter')
      const card = page.locator('[data-proposal="config"]')
      await expect(card.getByTestId('rollback-plan')).toContainText('shutdown')
      await expect(card.getByTestId('verify-plan')).toContainText('show ip bgp summary')
      const approve = card.getByRole('button', { name: /^Approve/ })
      await expect(approve).toBeEnabled()
      await snap('02-change-review')
      await approve.click()
      const panel = card.getByTestId('change-panel')
      await expect(panel.getByTestId('judgement')).toHaveAttribute('data-verified', 'false', { timeout: 25_000 })
      await expect(panel.getByTestId('verify-results')).toContainText(/GigabitEthernet1\/0\/2[^\n]*down\s+down/i)
      await expect(panel.getByTestId('verify-results')).toContainText(/10\.0\.0\.2[^\n]*Active/i)
      await panel.getByRole('button', { name: 'Roll back' }).scrollIntoViewIfNeeded()
      await snap('03-failed-verification')
      await panel.getByRole('button', { name: 'Roll back' }).click()
      await expect(panel).toHaveAttribute('data-phase', 'rolled-back', { timeout: 25_000 })
      await expect(panel).toContainText(/rolled back by netops/i)
      await expect(page.getByText(/back in its previous state/)).toBeVisible()
      await snap('04-operator-rollback')
      await page.keyboard.press(MOD + '+I')
      await command(page, 'show ip interface brief | include GigabitEthernet1/0/2', /GigabitEthernet1\/0\/2[^\n]*administratively down\s+down[\s\S]*core-sw1#\s*$/i)
      await snap('05-restored-state')
    })
  } finally {
    await model.close()
  }
})
