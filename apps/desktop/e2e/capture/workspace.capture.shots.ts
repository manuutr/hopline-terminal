/** Capture the release preview and sample the actual tab indicator for motion review. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, MOD, showSessions, sizeWindow, test } from '../fixtures'

const output = process.env.HOPLINE_MOTION_CAPTURE ?? mkdtempSync(join(tmpdir(), 'hopline-workspace-capture-'))

for (const reduced of [false, true]) {
  test('workspace feedback ' + (reduced ? 'reduced' : 'normal'), async ({ hop }) => {
    const { page } = hop
    await sizeWindow(hop.app, page, 1120, 700)
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    await hop.connect('core-sw1')
    await page.keyboard.type('show interfaces status\r')
    await expect.poll(hop.termText).toContain('Gi1/0/2')
    await hop.connect('dist-eos1')
    await page.keyboard.type('show ip interface brief\r')
    await expect.poll(hop.termText).toContain('Ethernet')
    await showSessions(page)
    const core = page.getByRole('tab', { name: 'core-sw1', exact: true })
    const dist = page.getByRole('tab', { name: 'dist-eos1', exact: true })
    await core.click()
    await page.mouse.move(12, 45)
    await page.waitForTimeout(280)

    const dir = join(output, reduced ? 'reduced' : 'normal')
    mkdirSync(dir, { recursive: true })
    const indicator = page.locator('[data-selection-face=tab]')
    const strip = page.getByRole('tablist', { name: 'Open connections' })
    for (const [step, tab] of [['forward', dist], ['back', core]] as const) {
      const region = await strip.boundingBox()
      if (!region) throw new Error('Missing connection list')
      const clip = { x: region.x, y: region.y, width: region.width, height: region.height }
      await page.screenshot({ path: join(dir, step + '-0.png'), clip })
      // Sample the compositor's real keyframes at known positions, including its settled state.
      const duration = await tab.evaluate(async (el) => {
        (el as HTMLElement).click()
        await new Promise(requestAnimationFrame)
        const a = document.querySelector('[data-selection-face=tab]')?.getAnimations().find((a) => a.id === 'hopline-layout')
        if (!a) return 0
        a.pause()
        return Number(a.effect!.getTiming().duration)
      })
      expect(duration).toBe(reduced ? 0 : 200)
      for (const [index, fraction] of [.05, .25, .55, 1].entries()) {
        await indicator.evaluate((el, time) => { for (const a of el.getAnimations()) a.currentTime = time }, duration * fraction)
        await page.screenshot({ path: join(dir, step + '-' + (index + 1) + '.png'), clip })
      }
      await indicator.evaluate((el) => { for (const a of el.getAnimations()) a.finish() })
      const end = (await indicator.boundingBox())!, target = (await tab.boundingBox())!
      expect(Math.abs(end.y - target.y - 6)).toBeLessThanOrEqual(1)
    }
    if (reduced) return

    await page.screenshot({ path: join(output, 'workspace-preview.png') })
    const frames = join(output, 'frames')
    mkdirSync(frames, { recursive: true })
    const cdp = await page.context().newCDPSession(page)
    let seq = 0
    cdp.on('Page.screencastFrame', (f) => {
      writeFileSync(join(frames, String(seq++).padStart(6, '0') + '_' + f.metadata.timestamp!.toFixed(4) + '.jpg'), Buffer.from(f.data, 'base64'))
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1120, maxHeight: 700 })
    await page.waitForTimeout(950)
    await dist.click()
    await page.waitForTimeout(800)
    await core.click()
    await page.waitForTimeout(650)
    await page.getByRole('button', { name: /^Copy connection address/ }).click()
    const toast = page.locator('[data-sonner-toast]').first()
    await expect(toast).toBeVisible()
    await page.waitForTimeout(750)
    const toastBox = (await toast.boundingBox())!
    const start = toastBox.x + toastBox.width / 2, middle = toastBox.y + toastBox.height / 2
    await page.mouse.move(start, middle)
    await page.mouse.down()
    await page.mouse.move(start - 145, middle, { steps: 12 })
    await page.mouse.up()
    await expect(toast).toBeHidden()
    await page.keyboard.press(MOD + '+K')
    const query = page.getByRole('combobox', { name: 'Command palette' })
    await query.pressSequentially('show interfaces', { delay: 90 })
    await page.waitForTimeout(1100)
    await page.keyboard.press('Escape')
    await page.keyboard.press(MOD + '+Comma')
    const theme = page.getByRole('radiogroup', { name: 'Theme', exact: true })
    await theme.getByRole('radio', { name: 'High contrast', exact: true }).click()
    await page.waitForTimeout(650)
    await theme.getByRole('radio', { name: 'Dark', exact: true }).click()
    await page.waitForTimeout(600)
    const switchControl = page.getByRole('switch', { name: 'Reduce motion', exact: true })
    const switchBox = (await switchControl.boundingBox())!
    await page.mouse.move(switchBox.x + switchBox.width / 2, switchBox.y + switchBox.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(180)
    await page.mouse.up()
    await expect(switchControl).toBeChecked()
    await page.waitForTimeout(400)
    await switchControl.click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(900)
    await cdp.send('Page.stopScreencast')
    await cdp.detach()
    expect(seq).toBeGreaterThan(35)
  })
}
