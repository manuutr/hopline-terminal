import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOD, expect, sizeWindow, stubDialogs, test } from './fixtures'

const FIXTURE = join(__dirname, 'fixtures', 'Harbor Night.itermcolors')
type Theme = { id: string; label: string; term: Record<string, string> }
const themesOf = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { hopline: { ux: { themes: { get: () => Promise<Theme[]> } } } }).hopline.ux.themes.get())
const termPaint = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--term-paint').trim())

test('theme generator: AA report, save, use for the terminal; import an iTerm2 file; export it back', async ({ hop }) => {
  const { page, app, dir } = hop
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()

  await dlg.getByText('Create a theme', { exact: true }).click()

  // Generate: the contrast report says every pair passes, and lists them on request.
  await dlg.getByLabel('Base hex').fill('#1e3a5f')
  await dlg.getByLabel('Accent hex').fill('#ff9933')
  const report = dlg.locator('[data-contrast-report]').first()
  await expect(report).toContainText(/All \d+ pairs pass AA/)
  await report.getByRole('button', { name: 'Show every check' }).click()
  await expect(report.locator('[data-contrast-row="fg on canvas"]')).toContainText('pass')
  await expect(report.locator('[data-contrast-row="red on background"]')).toContainText(/\d\.\d\d \/ 4\.5/)
  await expect(dlg.locator('[data-ui-swatches]')).toContainText('accent')
  // Long preview lines scroll sideways instead of being cut off.
  const preview = dlg.getByLabel('Preview of My theme').locator('[data-term-preview]')
  expect(await preview.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto')
  await expect(preview).toContainText('changed state to down')

  // Save, use it for the terminal, then Save the settings.
  await dlg.getByLabel('Theme name').fill('Harbor Dusk')
  await dlg.getByRole('button', { name: 'Save theme' }).click()
  await expect(dlg.locator('[data-custom-theme="custom-harbor-dusk"]')).toBeVisible()
  await dlg.getByRole('button', { name: 'Use for the terminal' }).click()
  await expect(dlg.locator('[data-custom-theme="custom-harbor-dusk"]')).toContainText('in use')
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dlg).toBeHidden()

  const saved = (await themesOf(page)).find((t) => t.id === 'custom-harbor-dusk')!
  expect(saved.term.background).toMatch(/^#[0-9a-f]{6}$/)
  // The connected terminal paints the generated background.
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
  await expect.poll(() => termPaint(page)).toBe(saved.term.background)
  await expect.poll(() => page.locator('.xterm').first().evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor)).toBe(rgb(saved.term.background))

  // Import an iTerm2 file: a draft with its notes and contrast, kept only on Keep.
  const out = join(dir, 'exported.hopline-theme.json')
  await stubDialogs(app, { open: FIXTURE, save: out })
  await page.keyboard.press(`${MOD}+Comma`)
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()
  await dlg.getByRole('button', { name: 'Import…' }).click()
  const draft = dlg.locator('[data-import-draft]')
  await expect(draft).toBeVisible()
  await expect(draft).toContainText(/taken from Hopline Terminal dark: cursorAccent, selectionBackground, brightWhite/)
  await expect(draft.locator('[data-contrast-report]')).toContainText(/pairs/)
  await draft.getByRole('button', { name: 'Keep' }).click()
  await expect(draft).toBeHidden()
  await expect(dlg.locator('[data-custom-theme="custom-harbor-night"]')).toBeVisible()
  expect((await themesOf(page)).find((t) => t.id === 'custom-harbor-night')?.term.background).toBe('#12171f')

  // Export writes JSON that parses back to the same colours.
  await dlg.getByRole('button', { name: 'Export Harbor Night' }).click()
  await expect.poll(() => existsSync(out)).toBe(true)
  const file = JSON.parse(readFileSync(out, 'utf8')) as Theme & { hoplineTheme: number }
  expect(file.hoplineTheme).toBe(1)
  expect(file.label).toBe('Harbor Night')
  expect(file.term.background).toBe('#12171f')

  // The font preview checks by drawing. The bundled JetBrains Mono joins -> and friends but has
  // no Nerd glyphs; the preview says the terminal draws ligatures apart.
  const fonts = dlg.locator('[data-font-preview]')
  await expect(fonts.locator('[data-check="ligatures"]')).toHaveText('Ligatures: yes')
  await expect(fonts.locator('[data-check="nerd"]')).toHaveText('Nerd Font glyphs: no')
  await expect(fonts).toContainText('the terminal draws them as separate characters')
  // A font without ligatures says no (the generic monospace on this machine).
  await dlg.getByRole('tab', { name: 'Terminal' }).click()
  await dlg.getByLabel('Terminal font').fill('monospace')
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()
  await expect(fonts.locator('[data-check="ligatures"]')).toHaveText('Ligatures: no')
  await expect(fonts.locator('[data-check="nerd"]')).toHaveText('Nerd Font glyphs: no')
})

test('MobaXterm and Royal TS palettes preview, save and apply to a live terminal', async ({ hop }) => {
  const { page, app, dir } = hop
  await hop.connect('core-sw1')
  await page.keyboard.press(`${MOD}+Comma`)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()
  for (const [file, data, name, color] of [
    ['Branch.ini', '[Colors]\nBackgroundColour=18,35,52\nRed=205,55,55\n', 'Branch', '#122334'],
    ['HQ.rtcp', JSON.stringify({ terminal: true, colors: [{ terminalMapping: 'background', color: '#211239' }] }), 'HQ', '#211239']
  ]) {
    const path = join(dir, file!)
    writeFileSync(path, data!)
    await stubDialogs(app, { open: path })
    await dlg.getByRole('button', { name: 'Import…' }).click()
    const draft = dlg.locator('[data-import-draft]')
    await expect(dlg.getByText(`Import: ${name}`, { exact: true })).toBeVisible()
    await draft.getByRole('button', { name: 'Keep' }).click()
    await expect.poll(async () => (await themesOf(page)).find((t) => t.label === name)?.term.background).toBe(color)
  }
  await dlg.getByRole('tab', { name: 'Terminal' }).click()
  const themes = dlg.getByLabel('Terminal theme', { exact: true })
  for (const [id, label] of [['moba-classic', 'MobaXterm style'], ['royal-putty', 'Royal TS style (PuTTY)']]) {
    await expect(themes.locator(`option[value="${id}"]`)).toHaveText(label!)
  }
  await themes.selectOption('custom-hq')
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => termPaint(page)).toBe('#211239')
})


test('terminal palettes: compare twenty presets, navigate by keyboard, cancel or apply to a live terminal', async ({ hop }) => {
  const { page, app } = hop
  await hop.connect('core-sw1')
  const initial = await termPaint(page)
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  const library = dlg.locator('[data-setting-key="themeLibrary"]')
  const filter = library.getByRole('radiogroup', { name: 'Filter terminal palettes' })
  const choices = library.getByRole('radiogroup', { name: 'Terminal palettes', exact: true })
  await page.keyboard.press(`${MOD}+Comma`)
  await dlg.getByRole('tab', { name: 'Terminal', exact: true }).click()
  await dlg.getByRole('button', { name: 'Browse palettes…' }).click()
  await expect(choices.getByRole('radio')).toHaveCount(20)
  await filter.getByRole('radio', { name: 'Light', exact: true }).click()
  await expect(choices.getByRole('radio')).toHaveCount(6)
  const glacier = choices.getByRole('radio', { name: 'Glacier', exact: true })
  await glacier.check()
  await expect(library.getByLabel('Preview of Glacier').locator('[data-term-preview]')).toHaveCSS('background-color', 'rgb(234, 244, 248)')
  await glacier.press('ArrowDown')
  await expect(choices.getByRole('radio', { name: 'Lavender' })).toBeChecked()
  await expect.poll(() => termPaint(page)).toBe(initial)
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dlg).toBeHidden()
  await expect.poll(() => termPaint(page)).toBe(initial)

  await page.keyboard.press(`${MOD}+Comma`)
  await dlg.getByRole('tab', { name: 'Themes and fonts' }).click()
  await expect(choices.getByRole('radio', { name: 'Hopline Terminal', exact: true })).toBeChecked()
  await choices.getByRole('radio', { name: 'Cobalt', exact: true }).check()
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: join(process.env['HOPLINE_SHOTS'], 'terminal-palettes.png') })
  await sizeWindow(app, page, 900, 640)
  await filter.getByRole('radio', { name: 'Light', exact: true }).click()
  await glacier.check()
  expect(await library.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: join(process.env['HOPLINE_SHOTS'], 'terminal-palettes-compact.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(library.locator('.animate-workspace-in')).toHaveCSS('animation-name', 'none')
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => termPaint(page)).toBe('#eaf4f8')
  await page.keyboard.press(`${MOD}+Comma`)
  await dlg.getByRole('tab', { name: 'Terminal', exact: true }).click()
  const select = dlg.getByLabel('Terminal theme', { exact: true })
  await expect(select).toHaveValue('glacier')
  await expect(select.locator('optgroup[label="Light palettes"] option')).toHaveCount(6)
  const search = dlg.getByTestId('settings-search')
  await search.fill('theme generator')
  await search.press('Enter')
  await expect(dlg.getByLabel('Base hex')).toBeVisible()
})
