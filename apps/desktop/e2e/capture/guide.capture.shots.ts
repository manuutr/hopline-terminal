/**
 * User-guide screenshots (docs/guide/img/). Not part of the e2e suite: the name ends in
 * `capture.shots.ts`, so only e2e/capture/playwright.capture.config.ts picks it up.
 *
 *   cd apps/desktop && npx electron-vite build
 *   npx playwright test -c e2e/capture/playwright.capture.config.ts guide.capture
 *   node ../../scripts/docs/optimize-png.mjs
 *
 * Raw PNGs go to HOPLINE_GUIDE_RAW (default: <tmp>/hopline-guide-raw); the optimiser quantises
 * them into docs/guide/img/. Electron runs hidden (HOPLINE_HIDDEN via e2e/fixtures.ts) against the
 * simulator and the fake LLM servers; dialogs and the clipboard are stubbed. Most shots are dark
 * only; `light: true` also writes `<name>-light.png`. A failing step is logged and skipped.
 *
 * The audit log shows the approver as the OS user: main's os.userInfo() is replaced with a
 * neutral "netops" user so no real account name ends up in a published image.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { makeEosDevice, startSim } from '../../../../packages/simulator/src/index.ts'
import type { OllamaChatBody, OllamaTurn } from '../../test/fake-llm'
import { MOD, expect, launchHopline, showSessions, stubDialogs, test, type Hopline } from '../fixtures'
import { sizeTo } from './narrow'
import { neutralUser } from './operator'

const RAW = process.env['HOPLINE_GUIDE_RAW'] ?? join(tmpdir(), 'hopline-guide-raw')
mkdirSync(RAW, { recursive: true })
const FIX = join(__dirname, '../fixtures')

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('hopline.theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
    document.documentElement.style.colorScheme = t
    window.dispatchEvent(new CustomEvent('hopline:theme', { detail: t }))
  }, theme)
}

/** Dark shot, plus a light one when asked. Leaves the app dark. */
async function shot(page: Page, name: string, opts: { light?: boolean } = {}): Promise<void> {
  await page.waitForTimeout(350)
  await setTheme(page, 'dark')
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(RAW, `${name}.png`) })
  if (opts.light) {
    await setTheme(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(RAW, `${name}-light.png`) })
    await setTheme(page, 'dark')
    await page.waitForTimeout(150)
  }
}

async function step(page: Page, name: string, fn: () => Promise<void>, cleanup = true): Promise<void> {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}: ${(e as Error).message.split('\n')[0]}`)
    await page.screenshot({ path: join(RAW, `_fail-${name}.png`) }).catch(() => {})
  }
  if (!cleanup) return
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(140)
  }
  await page.waitForTimeout(150)
}


async function prep(hop: Hopline): Promise<void> {
  await neutralUser(hop.app)
  await sizeTo(hop.app, hop.page, 1440, 900)
}

async function login(hop: Hopline, re: RegExp): Promise<void> {
  const pw = hop.page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || re.test(await hop.termText())).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(hop.termText).toMatch(re)
}

const reload = async (hop: Hopline) => {
  await hop.page.reload()
  await hop.page.waitForSelector('text=Lab (simulator)')
  await sizeTo(hop.app, hop.page, 1440, 900)
}

const openPanel = async (page: Page, placeholder: RegExp) => {
  const composer = page.getByPlaceholder(placeholder)
  if (((await composer.boundingBox())?.width ?? 0) < 50) await page.keyboard.press(`${MOD}+I`)
  await expect.poll(async () => (await composer.boundingBox())?.width ?? 0).toBeGreaterThan(50)
  return composer
}

const useOllama = (hop: Hopline, model = 'qwen3:8b') =>
  hop.page.evaluate((a) => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: a.url, ollamaModel: a.model } as never), { url: hop.llm.ollama.url, model })

const call = (name: string, args: unknown): OllamaTurn => ({ tools: [{ name, arguments: args }] })
const roleOf = (b: OllamaChatBody) => {
  const sys = b.messages?.[0]?.content ?? ''
  if (/fleet coordinator/.test(sys)) return 'coordinator'
  if (!sys.includes('Your device:')) return 'single'
  return sys.includes('(Arista EOS)') ? 'dist-eos1' : 'core-sw1'
}
const turnOf = (b: OllamaChatBody) => (b.messages ?? []).filter((m) => m.role === 'assistant').length
const toolText = (b: OllamaChatBody) => (b.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
const lineOf = (text: string, re: RegExp) => text.split('\n').find((l) => re.test(l))?.trim() ?? ''

/** A realistic tree: nested folders, tags, colours, favourites, a jump host. Dead hosts use port 1. */
async function seedTree(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const h = window.hopline
    const { sessions } = await h.sessions.list()
    const cred = sessions.find((s) => s.name === 'core-sw1')?.credentialId ?? null
    const dc1 = await h.sessions.saveFolder({ name: 'DC1 Frankfurt', parentId: null } as never)
    const core = await h.sessions.saveFolder({ name: 'Core', parentId: dc1.id } as never)
    const edge = await h.sessions.saveFolder({ name: 'Edge', parentId: dc1.id } as never)
    const br = await h.sessions.saveFolder({ name: 'Branch offices', parentId: null } as never)
    const mk = (name: string, folderId: string, platform: string, extra: Record<string, unknown> = {}) =>
      h.sessions.save({ folderId, name, host: '10.20.0.1', port: 22, protocol: 'ssh', platform, username: 'admin', credentialId: cred, logToFile: false, notes: '', options: {}, ...extra } as never)
    const ids: Record<string, string> = {}
    for (const n of ['br-muc-sw1', 'br-ham-sw1', 'br-ber-sw1', 'br-cgn-sw1']) await mk(n, br.id, 'ios')
    const bastion = await mk('fra-bastion', edge.id, 'auto', { host: 'bastion.fra.example.net' })
    for (const [n, f, pl, host] of [
      ['fra-core-01', core.id, 'iosxe', '10.20.0.11'],
      ['fra-core-02', core.id, 'nxos', '10.20.0.12'],
      ['fra-spine-01', core.id, 'eos', '10.20.0.21'],
      ['fra-edge-r1', edge.id, 'junos', '10.20.1.1'],
      ['fra-fw-01', edge.id, 'asa', '10.20.1.11']
    ] as const)
      ids[n] = (await mk(n, f, pl, { host, options: { ssh: { jump: [bastion.id] } } })).id
    await h.sessions.bulkUpdate([ids['fra-core-01']!, ids['fra-core-02']!], { addTags: ['core', 'prod'], color: 'blue' } as never)
    await h.sessions.bulkUpdate([ids['fra-fw-01']!], { addTags: ['firewall', 'prod'], color: 'red' } as never)
    await h.sessions.bulkUpdate([ids['fra-edge-r1']!], { addTags: ['wan'], color: 'orange' } as never)
    await h.sessions.bulkUpdate([ids['fra-core-01']!], { favorite: true } as never)
    const core1 = sessions.find((s) => s.name === 'core-sw1')!
    await h.sessions.bulkUpdate([core1.id], { favorite: true, addTags: ['lab'] } as never)
  })
}

// ------------------------------------------------------------------------------------------------

test('guide: first run and the privacy step', async () => {
  const { app, page, dir } = await launchHopline({ env: { HOPLINE_E2E_FIRST_RUN: '1' } })
  try {
    await neutralUser(app)
    await sizeTo(app, page, 1440, 900)
    await step(page, 'first-run-privacy', async () => {
      await expect(page.locator('[data-first-run] [data-step="privacy"]')).toBeVisible()
      await shot(page, 'first-run-privacy')
    }, false)
    await step(page, 'onboarding-steps', async () => {
      await page.getByTestId('privacy-continue').click()
      await expect(page.locator('[data-first-run]')).toContainText('Step 1 of 3')
      await shot(page, 'onboarding-steps')
    }, false)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('guide: sessions, terminal, palette, splits, find', async ({ hop }) => {
  const { app, page } = hop
  await prep(hop)
  await seedTree(page)
  await reload(hop)

  await step(page, 'lab-connected', async () => {
    await hop.connect('core-sw1')
    await page.keyboard.type('show ip interface brief\r')
    await expect.poll(hop.termText).toMatch(/administratively down[\s\S]*core-sw1#\s*$/)
    await page.waitForTimeout(400)
    await page.keyboard.type('show ip bgp summary\r')
    await expect.poll(hop.termText).toMatch(/Neighbor[\s\S]*core-sw1#\s*$/)
    await shot(page, 'lab-connected')
  })

  await step(page, 'session-tree', async () => {
    await showSessions(page)
    for (const f of ['DC1 Frankfurt', 'Core', 'Edge']) {
      const row = page.getByRole('treeitem', { name: new RegExp(`^${f}`) }).first()
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.click()
    }
    await page.getByRole('treeitem', { name: 'fra-spine-01', exact: true }).first().hover()
    await shot(page, 'session-tree', { light: true })
  }, false)

  await step(page, 'session-dialog-ssh', async () => {
    await showSessions(page)
    await page.getByRole('treeitem', { name: 'fra-core-01', exact: true }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Edit/ }).first().click()
    const dlg = page.getByRole('dialog', { name: /Edit fra-core-01/ })
    await expect(dlg).toBeVisible()
    await dlg.getByText(/bastion/i).first().scrollIntoViewIfNeeded().catch(() => {})
    await shot(page, 'session-dialog-ssh')
  })

  await step(page, 'quick-connect', async () => {
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press(`${MOD}+O`)
    await page.waitForTimeout(200)
    await page.keyboard.type('admin@10.20.0.1:2222')
    await shot(page, 'quick-connect')
  })

  await step(page, 'palette', async () => {
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press(`${MOD}+K`)
    await page.waitForTimeout(250)
    await shot(page, 'palette', { light: true })
  })

  await step(page, 'find-bar', async () => {
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press(`${MOD}+F`)
    await page.waitForTimeout(200)
    await page.keyboard.type('GigabitEthernet')
    await page.waitForTimeout(300)
    await shot(page, 'find-bar')
  })

  await step(page, 'splits', async () => {
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press(`${MOD}+D`)
    await expect(page.locator('[data-launcher] input')).toBeFocused()
    await page.locator('[data-launcher] input').fill('dist-eos1')
    await page.keyboard.press('Enter')
    await login(hop, /dist-eos1[#>]\s*$/)
    await page.keyboard.type('show ip bgp summary\r')
    await page.waitForTimeout(800)
    await shot(page, 'splits')
  })

})

test('guide: host key changed', async ({ hop }) => {
  const { app, page } = hop
  await prep(hop)
  await hop.connect('core-sw1')
  await step(page, 'host-key-prompt', async () => {
    await app.evaluate((_e, port) => {
      const host = (globalThis as unknown as { __hoplineHost: { repo: { replaceHostKeys(h: string, p: number, f: string): void } } }).__hoplineHost
      host.repo.replaceHostKeys('127.0.0.1', port, 'SHA256:Zx9mQ2u0bPr7kHfV1yLw3sT8cN4dJ6aE5gR0iO2pUqY')
    }, hop.sims.ios.port)
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.type('exit\r')
    await expect.poll(hop.termText).toMatch(/Press Enter to reconnect\.\s*$/)
    await page.keyboard.type('\r')
    await expect(page.getByRole('dialog', { name: 'Host key changed' })).toBeVisible()
    await shot(page, 'host-key-prompt')
  })
})

test('guide: blocks, autocomplete, buffer view, backups', async ({ hop }) => {
  const { page } = hop
  await prep(hop)
  await hop.connect('core-sw1')

  await step(page, 'autocomplete', async () => {
    await page.keyboard.type('show ip interface brief\r')
    await expect.poll(hop.termText).toMatch(/Loopback0[\s\S]*core-sw1#\s*$/)
    await page.waitForTimeout(400)
    await page.keyboard.type('sh')
    await page.waitForTimeout(150)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type(' ip bgp ')
    await page.waitForTimeout(150)
    await page.keyboard.type('su')
    await expect(page.locator('.hop-hints')).toBeVisible()
    await shot(page, 'autocomplete')
    await page.keyboard.press('Control+U')
  }, false)

  await step(page, 'command-block', async () => {
    await page.keyboard.press('Control+U')
    await page.keyboard.type('show ip bgp summary\r')
    await expect.poll(hop.termText).toMatch(/Neighbor[\s\S]*core-sw1#\s*$/)
    await page.waitForTimeout(400)
    await page.keyboard.type('show interfaces status\r')
    await expect.poll(hop.termText).toMatch(/Port[\s\S]*core-sw1#\s*$/)
    await page.waitForTimeout(400)
    await page.keyboard.press(`${MOD}+ArrowUp`)
    await expect(page.getByTestId('block-toolbar')).toBeVisible()
    await shot(page, 'command-block')
  }, false)

  await step(page, 'block-table', async () => {
    await page.getByTestId('block-toolbar').getByRole('button', { name: 'Show as table' }).click()
    await expect(page.getByTestId('block-table')).toBeVisible()
    await shot(page, 'block-table')
  })

  await step(page, 'buffer-view', async () => {
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await page.keyboard.press(`${MOD}+Alt+B`)
    const dlg = page.getByRole('dialog', { name: 'Terminal text: core-sw1' })
    await expect(dlg).toBeVisible()
    await page.keyboard.press('Alt+ArrowUp')
    await page.keyboard.press('Alt+ArrowUp')
    await shot(page, 'buffer-view')
  })

  await step(page, 'backups-diff', async () => {
    const row = page.locator('[role=treeitem][data-row-key^="tree:"][aria-label="core-sw1"]')
    const backUp = async () => {
      await showSessions(page)
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Back up config' }).click()
      await page.waitForTimeout(1500)
    }
    await backUp()
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.type('\r')
    await page.waitForTimeout(200)
    for (const l of ['configure terminal', 'interface GigabitEthernet1/0/2', 'description uplink to isp-r2 (AS65002) circuit FRA-4711', 'end']) await page.keyboard.type(`${l}\r`)
    await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
    await backUp()
    await showSessions(page)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Config history…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Config backups' })
    await dialog.getByRole('option').first().click()
    await expect(dialog.locator('.monaco-diff-editor')).toBeVisible()
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 })
    await page.waitForTimeout(500)
    await shot(page, 'backups-diff')
  })
})

test('guide: settings, keyboard, themes, overrides, import', async ({ hop }) => {
  const { app, page } = hop
  await prep(hop)
  const settings = page.getByRole('dialog', { name: 'Settings' })

  await step(page, 'settings', async () => {
    await page.keyboard.press(`${MOD}+Comma`)
    await expect(settings).toBeVisible()
    await settings.screenshot({ path: join(RAW, 'settings.png'), animations: 'disabled' })
    await settings.getByRole('radio', { name: 'Light', exact: true }).click()
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings).toBeHidden()
    await page.keyboard.press(`${MOD}+Comma`)
    await expect(settings.getByRole('radio', { name: 'Light', exact: true })).toBeChecked()
    await settings.screenshot({ path: join(RAW, 'settings-light.png'), animations: 'disabled' })
    await settings.getByRole('radio', { name: 'Dark', exact: true }).click()
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings).toBeHidden()
  })
  await step(page, 'keyboard-settings', async () => {
    await page.keyboard.press(`${MOD}+Comma`)
    await settings.getByRole('tab', { name: 'Keyboard' }).click()
    await page.waitForTimeout(200)
    await shot(page, 'keyboard-settings')
  })
  await step(page, 'theme-generator', async () => {
    await page.keyboard.press(`${MOD}+Comma`)
    await settings.getByRole('tab', { name: 'Themes and fonts' }).click()
    await settings.getByText('Create a theme', { exact: true }).click()
    await settings.getByLabel('Base hex').fill('#1e3a5f')
    await settings.getByLabel('Accent hex').fill('#ff9933')
    await expect(settings.locator('[data-contrast-report]').first()).toContainText(/pairs pass AA|pass/)
    await shot(page, 'theme-generator', { light: true })
  })
  await step(page, 'overrides-dialog', async () => {
    await showSessions(page)
    await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Overrides for this folder…' }).click()
    const fdlg = page.getByRole('dialog', { name: 'Overrides for Lab (simulator)' })
    await fdlg.locator('[data-override="termFontSize"]').getByRole('switch').click()
    await fdlg.getByLabel('Font size override').fill('15')
    await fdlg.getByRole('button', { name: 'Save' }).click()
    await showSessions(page)
    await page.getByRole('treeitem', { name: 'core-sw1', exact: true }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Overrides…' }).click()
    const d = page.getByRole('dialog', { name: 'Overrides for core-sw1' })
    await d.locator('[data-override="termCursorStyle"]').getByRole('switch').click()
    await shot(page, 'overrides-dialog')
  })
  await step(page, 'import-review', async () => {
    // The review names the file; show it as ~/.ssh/config under a throwaway home, not this checkout.
    const home = mkdtempSync(join(tmpdir(), 'hopline-guide-home-'))
    mkdirSync(join(home, '.ssh'))
    copyFileSync(join(FIX, 'ssh_config'), join(home, '.ssh', 'config'))
    await app.evaluate((_e, h) => {
      const os = (process as unknown as { mainModule: { require: (m: string) => { homedir: () => string } } }).mainModule.require('node:os')
      os.homedir = () => h
    }, home)
    await stubDialogs(app, { open: join(home, '.ssh', 'config') })
    await page.keyboard.press(`${MOD}+K`)
    await page.keyboard.type('Import sessions')
    await page.keyboard.press('Enter')
    const wizard = page.getByRole('dialog', { name: 'Import sessions' })
    await wizard.getByRole('radio', { name: /OpenSSH/ }).click()
    await wizard.getByRole('button', { name: 'Choose another file…' }).click()
    const dlg = page.getByRole('dialog', { name: /Review import/ })
    await expect(dlg.getByRole('button', { name: /Import \d+ sessions/ })).toBeEnabled()
    await dlg.getByLabel('Platform for all').selectOption('iosxe')
    await shot(page, 'import-review')
  })
})

test('guide: button bar and multi-device runs', async ({ hop }) => {
  const { page } = hop
  await prep(hop)
  const save = (s: Record<string, unknown>) =>
    page.evaluate((x) => (window as unknown as { hopline: { snippets: { save: (s: unknown) => Promise<unknown> } } }).hopline.snippets.save({ mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: true, ...x }), s)
  await save({ name: 'IP brief', body: 'show ip interface brief' })
  await save({ name: 'BGP summary', body: 'show ip bgp summary' })
  await save({ name: 'Describe port', body: 'interface {{interface}}\n description {{text}}' })
  await save({ name: 'Access VLAN', body: 'interface {{interface}}\n switchport access vlan {{vlan}}' })
  await save({ name: 'Show int', body: 'show interfaces {{interface}}', mode: 'insert' })
  await reload(hop)
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Vlan1[\s\S]*core-sw1#\s*$/)
  const bar = page.getByRole('toolbar', { name: 'Button bar' })
  await step(page, 'button-bar', async () => {
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Describe port' }).hover()
    await shot(page, 'button-bar')
  })
  await step(page, 'multi-run-compare', async () => {
    await page.locator('.xterm').first().click()
    await page.keyboard.press('Enter')
    await page.keyboard.press(`${MOD}+K`)
    await page.getByRole('combobox', { name: 'Command palette' }).fill('#Lab')
    await page.getByRole('option', { name: /^Lab \(simulator\)/ }).click()
    await page.getByRole('option', { name: /Run a show command on these/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
    await dlg.getByLabel('Show command').fill('show version')
    await dlg.getByRole('button', { name: /^Preview/ }).click()
    await expect(dlg.getByTestId('multi-counts')).toBeVisible()
    await dlg.getByRole('button', { name: /^Run on/ }).click()
    await expect(dlg.getByTestId('multi-progress')).toHaveText(/^(\d+) of \1 done$/, { timeout: 30_000 })
    await dlg.getByRole('listbox', { name: 'Devices' }).getByRole('option', { name: /dist-eos1/ }).click()
    await dlg.getByRole('tab', { name: 'Compare' }).click()
    await page.waitForTimeout(300)
    await shot(page, 'multi-run-compare')
  })
})

test('guide: files and port forwards', async ({ hop }) => {
  const { page, app } = hop
  await prep(hop)
  const eos = await startSim({ device: makeEosDevice(), port: 0, files: { sftp: true }, forwarding: true, remoteForwarding: true })
  const echo = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
  const local = mkdtempSync(join(tmpdir(), 'hopline-guide-files-'))
  const img = join(local, 'EOS-4.32.2F.swi')
  writeFileSync(img, Buffer.alloc(3_000_000, 9))
  try {
    await page.evaluate(
      async (p) => {
        const base = { folderId: null, host: '127.0.0.1', protocol: 'ssh', username: 'admin', credentialId: null, logToFile: false, notes: '' }
        await window.hopline.sessions.save({ ...base, name: 'leaf-files', port: p.eos, platform: 'eos', options: { ssh: { forwards: [{ id: 'f1', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: p.echo, label: 'mgmt web' }, { id: 'f2', kind: 'D', bindHost: '127.0.0.1', bindPort: 0 }] } } } as never)
      },
      { eos: eos.port, echo: (echo.address() as { port: number }).port }
    )
    await reload(hop)
    await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
    await showSessions(page)
    await page.getByText('leaf-files', { exact: true }).first().dblclick()
    await login(hop, /dist-eos1[#>]\s*$/)
    const menu = async (item: RegExp) => {
      await page.getByRole('tab', { selected: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: item }).click()
    }
    await step(page, 'files-panel', async () => {
      await menu(/Files/)
      const panel = page.getByRole('region', { name: 'Files' })
      await expect(panel.getByRole('option', { name: /startup-config/ })).toBeVisible()
      await stubDialogs(app, { open: img, dir: local })
      await panel.getByRole('button', { name: 'Upload…' }).click()
      await expect(panel.getByRole('listitem', { name: /Upload EOS.*Done/ })).toBeVisible()
      await panel.getByRole('option', { name: /startup-config/ }).click()
      await shot(page, 'files-panel')
    })
    await step(page, 'port-forwards', async () => {
      await menu(/Port forwarding/)
      const dlg = page.getByRole('dialog', { name: 'Port forwarding' })
      await expect(dlg.getByText('Listening').first()).toBeVisible()
      await shot(page, 'port-forwards')
    })
  } finally {
    await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: true })).catch(() => {})
    await eos.close()
    echo.close()
    rmSync(local, { recursive: true, force: true })
  }
})

test('guide: assistant, proposal, safety net, audit and egress logs', async ({ hop }) => {
  const { page } = hop
  await prep(hop)
  await hop.connect('core-sw1')

  await step(page, 'ai-setup', async () => {
    await page.keyboard.press(`${MOD}+I`)
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await expect(setup).toBeVisible()
    await shot(page, 'ai-setup')
  }, false)

  // Read-only investigation: two show commands (one with a local filter), then the answer.
  hop.llm.ollama.script.push(
    call('run_show_command', { command: 'show ip bgp summary', reason: 'BGP neighbour states' }),
    call('run_show_command', { command: 'show ip interface brief', reason: 'is the uplink to 10.0.0.2 up?', filter: { grep: 'GigabitEthernet1/0/2|Vlan' } }),
    {
      text:
        'BGP to **10.0.0.2** is **Idle** because its uplink is down.\n\n- `show ip bgp summary`: neighbor 10.0.0.2 (AS 65002) is Idle, never established.\n- `show ip interface brief`: GigabitEthernet1/0/2 is **administratively down**.\n\nThe interface was shut. `no shutdown` on Gi1/0/2 should bring the session back.'
    }
  )
  await step(page, 'ai-panel', async () => {
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await setup.getByRole('radio', { name: 'Ollama' }).click()
    await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
    await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
    await setup.getByRole('button', { name: 'Connect' }).click()
    const composer = await openPanel(page, /Ask about core-sw1/)
    await composer.fill('why is bgp to 10.0.0.2 down?')
    await composer.press('Enter')
    await expect(page.getByText(/should bring the session back/)).toBeVisible({ timeout: 20_000 })
    await shot(page, 'ai-panel')
  }, false)

  // Changes allowed, then a config proposal with rollback, verify and the IOS-XE archive net.
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  await reload(hop)
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Loopback0[\s\S]*core-sw1#\s*$/)
  hop.llm.ollama.script.push(
    call('propose_config_change', {
      commands: ['interface GigabitEthernet1/0/2', 'no shutdown'],
      rationale: 'Gi1/0/2 carries the BGP session to 10.0.0.2 and is administratively down.',
      rollback: ['interface GigabitEthernet1/0/2', 'shutdown'],
      verify: [
        { command: 'show ip interface brief', expect: 'GigabitEthernet1/0/2 up up' },
        { command: 'show ip bgp summary', expect: '10.0.0.2 leaves Idle' }
      ]
    }),
    call('report_verification', { verified: true, summary: 'Gi1/0/2 is up/up; the session to 10.0.0.2 is no longer administratively blocked.' }),
    { text: 'The change is applied and verified. Confirm it to keep it, or roll back.' }
  )
  const card = page.locator('[data-proposal]').first()
  await step(page, 'approval-card', async () => {
    const composer = await openPanel(page, /Ask about core-sw1/)
    await composer.fill('bring Gi1/0/2 back up')
    await composer.press('Enter')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.getByRole('button', { name: /^Approve|^Run/ }).first()).toBeEnabled({ timeout: 6000 })
    const host = card.getByRole('textbox', { name: /Type core-sw1 to confirm/ })
    if (await host.count()) await host.fill('core-sw1')
    await card.scrollIntoViewIfNeeded()
    await shot(page, 'approval-card', { light: true })
  }, false)

  await step(page, 'safety-net', async () => {
    await card.getByRole('button', { name: /^Approve|^Run/ }).first().click()
    const panel = card.getByTestId('change-panel')
    await expect(panel).toHaveAttribute('data-phase', 'awaiting', { timeout: 30_000 })
    await expect(panel.getByTestId('judgement')).toBeVisible()
    await panel.scrollIntoViewIfNeeded()
    await page.waitForTimeout(1500)
    await shot(page, 'safety-net')
    await panel.getByRole('button', { name: 'Confirm' }).click()
    await expect(panel).toHaveAttribute('data-phase', 'confirmed', { timeout: 20_000 })
  }, false)

  await step(page, 'audit-log', async () => {
    await page.keyboard.press(`${MOD}+K`)
    await page.keyboard.type('audit')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'AI audit log' })).toBeVisible()
    await page.waitForTimeout(400)
    await shot(page, 'audit-log', { light: true })
  })

  await step(page, 'egress-log', async () => {
    await page.getByTestId('ai-egress').click()
    const dlg = page.getByRole('dialog', { name: 'What left this machine' })
    await expect(dlg.getByTestId('egress-row').first()).toBeVisible()
    await dlg.getByTestId('egress-row').first().click()
    await expect(dlg.getByTestId('egress-payload')).not.toHaveText('Decrypting…')
    await shot(page, 'egress-log')
  })
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: true }))
})

test('guide: suggest mode (local model without tools)', async ({ hop }) => {
  const { page } = hop
  await prep(hop)
  hop.llm.ollama.route.fn = (b) => {
    if (/the user ran your suggested/.test(JSON.stringify(b.messages))) return { text: 'Gi1/0/2 is down.' }
    return { text: 'Check the uplink first, then bring it up if it was shut:\n```\nshow ip interface brief\nshow logging | include Gi1/0/2\ninterface GigabitEthernet1/0/2\n no shutdown\n```' }
  }
  await hop.connect('core-sw1')
  await step(page, 'suggest-mode', async () => {
    await page.keyboard.press(`${MOD}+I`)
    const setup = page.getByRole('form', { name: 'Connect a model' })
    await setup.getByRole('radio', { name: 'Ollama' }).click()
    await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
    await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
    await setup.getByRole('combobox', { name: 'Ollama model' }).click()
    await page.getByRole('option', { name: /llama2:7b/ }).click()
    await setup.getByRole('button', { name: 'Connect' }).click()
    const composer = await openPanel(page, /Ask about core-sw1/)
    await composer.fill('is the uplink on Gi1/0/2 up?')
    await composer.press('Enter')
    await expect(page.getByTestId('ai-suggestions').getByTestId('ai-suggestion').first()).toBeVisible({ timeout: 20_000 })
    await shot(page, 'suggest-mode')
  }, false)
})

test('guide: fleet preview from @ai and a finished run', async ({ hop }) => {
  const { page } = hop
  await prep(hop)
  hop.llm.ollama.route.fn = (b) => {
    const role = roleOf(b)
    const n = turnOf(b)
    if (role === 'coordinator') {
      if (n === 0)
        return call('dispatch_tasks', {
          tasks: [
            { device: 'core-sw1', task: 'Check the BGP session to 10.0.0.2 and the uplink interface' },
            { device: 'dist-eos1', task: 'Check its BGP neighbours' }
          ]
        })
      return {
        text:
          'Two separate BGP problems.\n\n- **core-sw1**: neighbor 10.0.0.2 (AS 65002) is **Idle** because its uplink GigabitEthernet1/0/2 is administratively down.\n- **dist-eos1**: neighbor spine2 (10.0.1.2) is **Active**, so the TCP session never comes up; spine1 is Established.\n\nRecommendations: `no shutdown` on core-sw1 Gi1/0/2; check reachability of 10.0.1.2 from dist-eos1. Both are changes you make yourself: the fleet run is read-only.'
      }
    }
    if (role === 'core-sw1') {
      if (n === 0) return call('run_show_command', { command: 'show ip bgp summary', reason: 'neighbour state' })
      if (n === 1) return call('run_show_command', { command: 'show ip interface brief', reason: 'uplink state' })
      const t = toolText(b)
      return call('submit_report', {
        status: 'found',
        findings: ['neighbor 10.0.0.2 is Idle', 'GigabitEthernet1/0/2 is administratively down'],
        evidence: [
          { command: 'show ip bgp summary', lines: [lineOf(t, /^10\.0\.0\.2\s/)].filter(Boolean) },
          { command: 'show ip interface brief', lines: [lineOf(t, /GigabitEthernet1\/0\/2/)].filter(Boolean) }
        ],
        confidence: 'high'
      })
    }
    if (role === 'dist-eos1') {
      if (n === 0) return call('run_show_command', { command: 'show ip bgp summary', reason: 'neighbour state' })
      const t = toolText(b)
      const l = lineOf(t, /spine2/)
      return call('submit_report', { status: 'found', findings: ['neighbor spine2 (10.0.1.2) is Active, not Established'], evidence: l ? [{ command: 'show ip bgp summary', lines: [l] }] : [], confidence: 'medium' })
    }
    return undefined
  }
  await useOllama(hop)
  await reload(hop)
  await hop.connect('core-sw1')
  const view = page.getByRole('dialog', { name: 'Investigate across devices' })
  await step(page, 'fleet-preview', async () => {
    await page.keyboard.type('@ai why is bgp down here and on @dist')
    await expect(page.getByTestId('mention-list')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('mention-list')).toBeHidden()
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    await expect(view.getByTestId('fleet-scope')).toBeVisible()
    await expect(view.getByRole('button', { name: /Investigate 2 devices/ })).toBeVisible()
    await shot(page, 'fleet-preview')
  }, false)
  await step(page, 'fleet-run', async () => {
    await view.getByRole('button', { name: /Investigate 2 devices/ }).click()
    await expect(view.getByTestId('fleet-status')).toHaveAttribute('data-status', 'done', { timeout: 90_000 })
    await page.waitForTimeout(500)
    await shot(page, 'fleet-run')
  }, false)
})


