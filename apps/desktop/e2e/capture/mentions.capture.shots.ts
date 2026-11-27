/**
 * Device @-mentions (F11): the terminal and composer autocomplete, the pre-filled fleet preview and
 * an unknown mention, at 1440×900 and 1100×700 in both themes. Writes `mentions-*-<w>-<theme>.png`
 * to HOPLINE_SHOTS_OUT (default docs/design/screens).
 */
import { expect, test } from '../fixtures'
import { sizeTo, snapNarrow } from './narrow'

test('mentions: autocomplete and the pre-filled fleet preview', async ({ hop }) => {
  const { app, page } = hop
  await page.evaluate((url) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' } as never), hop.llm.ollama.url)
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await hop.connect('core-sw1')
  const view = page.getByRole('dialog', { name: 'Investigate across devices' })
  const composer = page.getByPlaceholder(/Ask about core-sw1/)
  for (const [w, h] of [
    [1440, 900],
    [1100, 700]
  ] as const) {
    await sizeTo(app, page, w, h)
    await page.locator('.xterm').first().click()
    await page.keyboard.type('@ai why is bgp down here and on @di')
    await expect(page.getByTestId('mention-list')).toBeVisible()
    await snapNarrow(page, 'mentions-terminal', w)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(view.getByTestId('fleet-scope')).toBeVisible()
    await snapNarrow(page, 'mentions-preview', w)
    await page.keyboard.press('Escape')
    await expect(view).toBeHidden()

    if (((await composer.boundingBox())?.width ?? 0) < 50) await page.keyboard.press('Control+Shift+I')
    await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThan(50)
    await composer.click()
    await composer.pressSequentially('compare the uplinks with @co')
    await expect(page.getByTestId('mention-list')).toBeVisible()
    await snapNarrow(page, 'mentions-composer', w)
    await composer.fill('compare the uplinks with @dist-eos1 and @core')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter')
    await expect(view.getByTestId('mention-errors')).toBeVisible()
    await snapNarrow(page, 'mentions-errors', w)
    await page.keyboard.press('Escape')
    await expect(view).toBeHidden()
  }
})
