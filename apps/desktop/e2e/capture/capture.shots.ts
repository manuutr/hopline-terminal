/**
 * Design-audit screenshot capture (throwaway, not part of the e2e suite).
 * Named *.shots.ts so the main e2e config (testDir ./e2e) never picks it up.
 *
 *   cd apps/desktop && npx electron-vite build
 *   npx playwright test -c e2e/capture/playwright.capture.config.ts
 *
 * Reuses e2e/fixtures.ts: Electron runs off-screen (HOPLINE_HIDDEN) against the multi-vendor
 * simulator. Every shot is taken in dark and light at a 1440x900 content size and written to
 * docs/design/screens/<name>-<theme>.png. A failing step is logged and skipped, never fatal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { makeEosDevice, makeIosDevice, startSim } from '../../../../packages/simulator/src/index.ts'
import { expect, showSessions, sizeWindow, stubDialogs, test, treeRow, type Hopline } from '../fixtures'

const OUT = process.env['HOPLINE_SHOTS_OUT'] ?? join(__dirname, '../../../../docs/design/screens')
mkdirSync(OUT, { recursive: true })

type H = {
  hopline: {
    sessions: {
      list: () => Promise<{ sessions: { id: string; name: string; credentialId: string | null }[]; folders: { id: string; name: string }[] }>
      save: (s: unknown) => Promise<{ id: string }>
      remove: (id: string) => Promise<unknown>
      saveFolder: (f: unknown) => Promise<{ id: string }>
      removeFolder: (id: string) => Promise<unknown>
      bulkUpdate: (ids: string[], p: unknown) => Promise<unknown>
    }
  }
}

async function size(app: ElectronApplication, page: Page): Promise<void> {
  await sizeWindow(app, page, 1440, 900)
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('hopline.theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
    document.documentElement.style.colorScheme = t
    window.dispatchEvent(new CustomEvent('hopline:theme', { detail: t }))
  }, theme)
}

/** Screenshot in both themes; leave the app in dark. */
async function snap(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350)
  for (const t of ['dark', 'light'] as const) {
    await setTheme(page, t)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, `${name}-${t}.png`) })
  }
  await setTheme(page, 'dark')
  await page.waitForTimeout(100)
}

/** Run one capture step; log and recover (Escape) instead of failing the run. */
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}: ${(e as Error).message.split('\n')[0]}`)
    await page.screenshot({ path: join(OUT, `_fail-${name}.png`) }).catch(() => {})
  }
  // One Esc per layer; wait out each 100 ms exit animation, during which the closing layer still owns Esc.
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(140)
  }
  await page.waitForTimeout(150)
}


const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(name) }).first()

/** Answer the password prompt if it shows (no keychain), then wait for the device prompt. */
async function login(hop: Hopline, re: RegExp): Promise<void> {
  const pw = hop.page.locator('[role=dialog] input[type=password]')
  await expect.poll(async () => (await pw.isVisible()) || re.test(await hop.termText())).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(hop.termText).toMatch(re)
}

/** A realistic tree: nested folders, tags, colors, favorites. Dead hosts point at port 1. */
async function seedTree(page: Page, ports: { ios: number; eos: number }): Promise<void> {
  await page.evaluate(
    async (p: { ios: number; eos: number }) => {
      const h = (window as unknown as H).hopline
      const { sessions, folders } = await h.sessions.list()
      const lab = folders.find((f) => f.name === 'Lab (simulator)')!
      const cred = sessions.find((s) => s.name === 'core-sw1')?.credentialId ?? null
      const dc1 = await h.sessions.saveFolder({ name: 'DC1 Frankfurt', parentId: null })
      const core = await h.sessions.saveFolder({ name: 'Core', parentId: dc1.id })
      const edge = await h.sessions.saveFolder({ name: 'Edge', parentId: dc1.id })
      const br = await h.sessions.saveFolder({ name: 'Branch offices', parentId: null })
      const mk = (name: string, folderId: string, platform: string, port = 1, protocol = 'ssh') =>
        h.sessions.save({ folderId, name, host: '127.0.0.1', port, protocol, platform, username: 'admin', credentialId: cred, logToFile: false, notes: '', options: {} })
      const ids: Record<string, string> = {}
      for (const n of ['br-muc-sw1', 'br-ham-sw1', 'br-ber-sw1', 'br-cgn-sw1', 'br-stu-sw1']) await mk(n, br.id, 'ios', 1)
      await h.sessions.save({ folderId: br.id, name: 'br-ask-pw', host: '127.0.0.1', port: p.ios, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} })
      for (const [n, f, pl, port] of [
        ['fra-core-01', core.id, 'iosxe', p.ios],
        ['fra-core-02', core.id, 'nxos', 1],
        ['fra-spine-01', core.id, 'eos', p.eos],
        ['fra-edge-r1', edge.id, 'junos', 1],
        ['fra-fw-01', edge.id, 'ios', 1],
        ['fra-fw-02', edge.id, 'ios', 1]
      ] as const)
        ids[n] = (await mk(n, f, pl, port)).id
      void lab
      await h.sessions.bulkUpdate([ids['fra-core-01']!, ids['fra-core-02']!], { addTags: ['core', 'prod'], color: 'blue' })
      await h.sessions.bulkUpdate([ids['fra-fw-01']!, ids['fra-fw-02']!], { addTags: ['firewall', 'prod'], color: 'red' })
      await h.sessions.bulkUpdate([ids['fra-edge-r1']!], { addTags: ['wan'], color: 'orange' })
      await h.sessions.bulkUpdate([ids['fra-core-01']!, ids['fra-fw-01']!], { favorite: true })
      const core1 = sessions.find((s) => s.name === 'core-sw1')!
      await h.sessions.bulkUpdate([core1.id], { favorite: true, addTags: ['lab'] })
    },
    ports
  )
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
}

test('capture: workspace, terminal, palette, splits, tabs, AI, prompts', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)

  await step(page, 'first-launch', async () => {
    await snap(page, '01-first-launch')
  })

  await step(page, 'design-system', async () => {
    await page.evaluate(() => (location.hash = '#/design'))
    await page.waitForTimeout(300)
    await snap(page, '00-design-system-preview')
    await page.evaluate(() => (location.hash = ''))
    await page.waitForSelector('text=Lab (simulator)')
  })

  await seedTree(page, { ios: hop.sims.ios.port, eos: hop.sims.eos.port })

  await step(page, 'terminal', async () => {
    await hop.connect('core-sw1')
    await page.keyboard.type('show ip interface brief\r')
    await expect.poll(hop.termText).toMatch(/administratively down[\s\S]*core-sw1#\s*$/)
    await page.keyboard.type('show ip bgp summary\r')
    await page.waitForTimeout(600)
    await snap(page, '03-terminal-connected')
  })

  await step(page, 'tree', async () => {
    await showSessions(page)
    await treeRow(page, 'dist-eos1').first().dblclick()
    await login(hop, /dist-eos1[#>]\s*$/)
    await page.keyboard.type('show version\r')
    await page.waitForTimeout(500)
    // Hover a row so the hover state is visible.
    await showSessions(page)
    await treeRow(page, 'fra-spine-01').first().hover()
    await snap(page, '02-session-tree')
  })

  await step(page, 'find-in-tab', async () => {
    await page.locator('.xterm').first().click()
    await page.keyboard.press('Control+Shift+F')
    await page.waitForTimeout(200)
    await page.keyboard.type('Ethernet')
    await snap(page, '15b-find-in-tab')
  })

  await step(page, 'find-all', async () => {
    await page.keyboard.press('Control+Shift+Alt+F')
    const dlg = page.getByRole('dialog', { name: 'Find in all tabs' })
    await dlg.getByRole('textbox').fill('ethernet')
    await expect(dlg.getByRole('option').first()).toBeVisible()
    await snap(page, '15-find-all-tabs')
  })

  await step(page, 'palette', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.waitForTimeout(200)
    await snap(page, '06-command-palette')
    await page.keyboard.type('spl')
    await snap(page, '06b-command-palette-query')
  })

  await step(page, 'quick-connect', async () => {
    await page.keyboard.press('Control+Shift+O')
    await page.waitForTimeout(200)
    await snap(page, '07-quick-connect')
    await page.keyboard.type('admin@10.20.0.1:2222')
    await snap(page, '07b-quick-connect-typed')
  })

  await step(page, 'switcher', async () => {
    await page.keyboard.press('Control+Shift+P')
    await page.waitForTimeout(200)
    await snap(page, '06c-session-switcher')
  })

  await step(page, 'ai-hidden', async () => {
    // P1-8: with no API key the panel starts closed; Mod+I opens it on the key field (P1-7).
    await snap(page, '12-ai-panel-hidden')
    await page.keyboard.press('Control+Shift+I')
    await page.waitForTimeout(400)
    await snap(page, '12b-ai-panel-no-key')
  })

  await step(page, 'ai-inline', async () => {
    await tab(page, 'core-sw1').click()
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press('Enter') // a stray Esc (from closing overlays) resets @ai line tracking
    await page.waitForTimeout(300)
    // Human-ish typing speed (40 ms/key): the @ai capture must hold up at real speed.
    await page.keyboard.type('@ai why is bgp to 10.0.0.2 down?', { delay: 40 })
    await page.waitForTimeout(300)
    await snap(page, '13-ai-inline-typing')
    await page.keyboard.type('\r')
    await expect(page.getByTestId('ai-waiting')).toBeVisible()
    await page.waitForTimeout(400)
    await snap(page, '13b-ai-inline-no-key')
  })

  await step(page, 'splits', async () => {
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press('Control+Shift+D')
    await expect(page.locator('[data-launcher] input')).toBeFocused()
    await snap(page, '04-split-launcher')
    await page.locator('[data-launcher] input').fill('fra-spine-01')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    const pw = page.locator('[role=dialog] input[type=password]')
    if (await pw.isVisible()) {
      await pw.fill('admin')
      await pw.press('Enter')
    }
    await page.waitForTimeout(1200)
    await page.keyboard.type('show interfaces status\r')
    await page.waitForTimeout(400)
    await page.keyboard.press('Control+Shift+E')
    await page.waitForTimeout(300)
    await page.locator('[data-launcher] input').fill('dist-eos1')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    if (await pw.isVisible()) {
      await pw.fill('admin')
      await pw.press('Enter')
    }
    await page.waitForTimeout(1200)
    await page.keyboard.type('show ip bgp summary\r')
    await page.waitForTimeout(500)
    await snap(page, '04b-splits-three-panes')
  })

  await step(page, 'many-tabs', async () => {
    // Config mode on the focused split pane (dist-eos1).
    await page.keyboard.type('configure terminal\r')
    await page.waitForTimeout(400)
    for (const n of ['fra-core-02', 'fra-edge-r1', 'fra-fw-01', 'fra-fw-02', 'core-sw1 (telnet)', 'fra-core-01']) {
      await showSessions(page)
      await treeRow(page, n).first().dblclick()
      await page.waitForTimeout(700)
      const pw = page.locator('[role=dialog] input[type=password]')
      if (await pw.isVisible()) {
        await pw.fill('admin')
        await pw.press('Enter')
        await page.waitForTimeout(600)
      }
    }
    // Background output on a non-active tab gives it the "new output" glyph.
    await tab(page, 'fra-core-01').click()
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.type('show running-config\r')
    await page.keyboard.press('Alt+1')
    await page.waitForTimeout(1500)
    await page.getByRole('tab').nth(2).hover()
    await page.waitForTimeout(700)
    await snap(page, '05-tabs-many-glyphs')
  })

  await step(page, 'tabs-overflow', async () => {
    // Cancel the password prompt: the tab shows the "auth failed" glyph.
    await showSessions(page)
    await treeRow(page, 'br-ask-pw').first().dblclick()
    const pw = page.locator('[role=dialog] input[type=password]')
    await expect(pw).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.waitForTimeout(500)
    for (const n of ['br-muc-sw1', 'br-ham-sw1', 'br-ber-sw1', 'br-cgn-sw1', 'br-stu-sw1']) {
      await showSessions(page)
      await treeRow(page, n).first().dblclick()
      await page.waitForTimeout(500)
    }
    await page.keyboard.press('Alt+2')
    await page.waitForTimeout(800)
    await snap(page, '05b-tabs-overflow-icons')
  })

  await step(page, 'close-confirm', async () => {
    await page.keyboard.press('Alt+1')
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press('Control+Shift+W')
    await expect(page.getByRole('dialog', { name: /^Close / })).toBeVisible()
    await snap(page, '16-close-confirm')
  })

  await step(page, 'known-hosts', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.keyboard.type('known hosts')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Known hosts' })).toBeVisible()
    await snap(page, '18-known-hosts')
  })

  await step(page, 'audit', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.keyboard.type('audit')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await snap(page, '19-audit-log')
  })

})

test('capture: settings, session and credential dialogs, password prompt, vault', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)

  await step(page, 'settings', async () => {
    await page.keyboard.press('Control+Shift+Comma')
    const dlg = page.getByRole('dialog', { name: 'Settings' })
    await expect(dlg).toBeVisible()
    await snap(page, '08a-settings-general')
    await dlg.locator('.overflow-auto').first().evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
    await snap(page, '08b-settings-general-terminal')
    await dlg.locator('.overflow-auto').first().evaluate((el) => (el.scrollTop = el.scrollHeight))
    await snap(page, '08c-settings-general-bottom')
    for (const [t, n] of [['Credentials', '08d-settings-credentials'], ['Security', '08e-settings-security'], ['Sync & export', '08f-settings-backup-sync']] as const) {
      await page.getByRole('tab', { name: t }).click()
      await snap(page, n)
    }
  })

  await step(page, 'credential-dialog', async () => {
    await page.keyboard.press('Control+Shift+Comma')
    await page.getByRole('tab', { name: 'Credentials' }).click()
    await page.getByRole('button', { name: 'Add profile' }).click()
    await expect(page.getByRole('dialog', { name: 'New credential profile' })).toBeVisible()
    await snap(page, '10-credential-dialog')
  })

  await step(page, 'session-dialog', async () => {
    await page.getByRole('button', { name: 'New session' }).first().click()
    const dlg = page.getByRole('dialog', { name: 'New session' })
    await expect(dlg).toBeVisible()
    await snap(page, '09a-session-dialog-ssh')
    await dlg.locator('.overflow-auto').first().evaluate((el) => (el.scrollTop = el.scrollHeight))
    await snap(page, '09d-session-dialog-ssh-bottom')
    await dlg.locator('.overflow-auto').first().evaluate((el) => (el.scrollTop = 0))
    await dlg.getByRole('combobox', { name: 'Platform' }).click()
    await snap(page, '09e-session-dialog-platform-menu')
    await page.keyboard.press('Escape')
    await dlg.getByRole('combobox', { name: 'Protocol' }).click()
    await page.getByRole('option', { name: 'Telnet' }).click()
    await snap(page, '09b-session-dialog-telnet')
    await dlg.getByRole('combobox', { name: 'Protocol' }).click()
    await page.getByRole('option', { name: 'Serial console' }).click()
    await snap(page, '09c-session-dialog-serial')
  })

  await step(page, 'edit-session', async () => {
    await showSessions(page)
    await treeRow(page, 'core-sw1').first().click({ button: 'right' })
    await page.waitForTimeout(200)
    await snap(page, '02b-tree-context-menu')
  })

  await step(page, 'password-prompt', async () => {
    await page.evaluate(
      async (port: number) => {
        const h = (window as unknown as H).hopline
        await h.sessions.save({ folderId: null, name: 'lab-ask-pw', host: '127.0.0.1', port, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} })
      },
      hop.sims.ios.port
    )
    await page.reload()
    await page.waitForSelector('text=Lab (simulator)')
    await size(app, page)
    await showSessions(page)
    await page.getByText('lab-ask-pw', { exact: true }).first().dblclick()
    await expect(page.locator('[role=dialog] input[type=password]')).toBeVisible()
    await snap(page, '11-password-prompt')
    await page.keyboard.type('wrong')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    await snap(page, '11b-password-wrong')
  })

  await step(page, 'vault', async () => {
    await page.keyboard.press('Control+Shift+Comma')
    await page.getByRole('tab', { name: 'Security' }).click()
    await page.getByRole('radio', { name: 'Master password' }).click()
    const set = page.getByRole('dialog', { name: 'Set a master password' })
    await expect(set).toBeVisible()
    await snap(page, '17a-vault-set-master')
    await set.getByLabel('Master password', { exact: true }).fill('correct-horse-battery')
    await set.getByLabel('Repeat it').fill('correct-horse-battery')
    await set.getByRole('button', { name: 'Set master password' }).click()
    await expect(set).toBeHidden()
    await snap(page, '08g-settings-security-master')
    await page.getByRole('button', { name: 'Lock now' }).click()
    await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    await page.waitForTimeout(5000) // let the "Master password set" toast leave
    await showSessions(page)
    await page.getByText('core-sw1', { exact: true }).first().dblclick()
    const dlg = page.getByRole('dialog', { name: 'Unlock Hopline Terminal' })
    await expect(dlg).toBeVisible()
    await snap(page, '17-vault-unlock')
    await dlg.getByLabel('Master password').fill('nope')
    await dlg.getByLabel('Master password').press('Enter')
    await expect(dlg.getByRole('alert')).toBeVisible()
    await snap(page, '17b-vault-unlock-wrong')
  })


})

test('capture: empty tree (no sessions)', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)
  await step(page, 'empty-tree', async () => {
    await page.keyboard.press('Escape')
    await page.evaluate(
      async () => {
        const h = (window as unknown as H).hopline
        const { sessions, folders } = await h.sessions.list()
        for (const s of sessions) await h.sessions.remove(s.id)
        for (const f of folders) await h.sessions.removeFolder(f.id).catch(() => {})
      }
    )
    await page.reload()
    await page.waitForTimeout(1200)
    await size(app, page)
    for (let i = 0; i < 2; i++) await page.keyboard.press('Escape')
    await snap(page, '01b-empty-no-sessions')
  })
})

test('capture: host key changed, session ended, @ai at 120 ms/key', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)
  await step(page, 'ai-inline-120ms', async () => {
    await hop.connect('core-sw1')
    await page.keyboard.type('show ip bgp summary\r')
    await page.waitForTimeout(600)
    await page.keyboard.type('@ai why is bgp to 10.0.0.2 down?', { delay: 120 })
    await page.waitForTimeout(300)
    await snap(page, '13c-ai-inline-typing-120ms')
    await page.keyboard.press('Escape') // cancels the capture
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
  })
  await step(page, 'host-key-changed', async () => {
    await app.evaluate((_e, port) => {
      const host = (globalThis as unknown as { __hoplineHost: { repo: { replaceHostKeys(h: string, p: number, f: string): void } } }).__hoplineHost
      host.repo.replaceHostKeys('127.0.0.1', port, 'SHA256:Zx9mQ2u0bPr7kHfV1yLw3sT8cN4dJ6aE5gR0iO2pUqY')
    }, hop.sims.ios.port)
    await page.locator('.xterm:visible').first().click()
    await page.keyboard.type('exit\r')
    await expect.poll(hop.termText).toMatch(/Press Enter to reconnect\.\s*$/)
    await snap(page, '20-session-ended')
    await page.keyboard.type('\r')
    await expect(page.getByRole('dialog', { name: 'Host key changed' })).toBeVisible()
    await snap(page, '14-host-key-changed')
  })
})

test('capture: AI onboarding (F2) and local output filters (F5b)', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)
  await hop.connect('core-sw1')
  const setup = page.getByRole('form', { name: 'Connect a model' })

  await step(page, 'ai-setup-error', async () => {
    await page.keyboard.type('@ai why is bgp to 10.0.0.2 down?\r')
    await expect(setup).toBeVisible()
    await setup.getByLabel('API key').fill('sk-ant-e2e-bad-key-0000')
    await setup.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByTestId('ai-connect-status')).toHaveAttribute('data-code', 'invalid_key')
    await snap(page, '30-ai-setup-invalid-key')
  })

  await step(page, 'ai-setup-ollama', async () => {
    await setup.getByRole('radio', { name: 'Ollama' }).click()
    await setup.getByLabel('Ollama server').fill(hop.llm.ollama.url)
    await expect(setup.getByRole('combobox', { name: 'Ollama model' })).toHaveText(/qwen3:8b/)
    await snap(page, '31-ai-setup-ollama')
    await setup.getByRole('combobox', { name: 'Ollama model' }).click()
    await snap(page, '31b-ai-setup-ollama-models')
  })

  await step(page, 'ai-connected', async () => {
    await setup.getByRole('radio', { name: 'Anthropic' }).click()
    await setup.getByLabel('API key').fill('sk-ant-e2e-good-key-0000-wxyz')
    await setup.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByText(/Gi1\/0\/2, the uplink to isp-r2, is administratively down/)).toBeVisible()
    await snap(page, '32-ai-connected-question-answered')
    await page.getByRole('button', { name: 'New conversation' }).click()
    await expect(page.getByTestId('ai-intro')).toBeVisible()
    await snap(page, '32b-ai-first-run-card')
  })

  await step(page, 'settings-assistant', async () => {
    await page.getByTestId('ai-provider').click()
    await expect(page.getByTestId('api-key-saved')).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByTestId('ai-connect-status')).toBeVisible()
    await page.getByRole('dialog', { name: 'Settings' }).locator('section').first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await snap(page, '34-settings-assistant')
  })

  await step(page, 'ai-filter-step', async () => {
    hop.llm.ollama.script.push(
      { tools: [{ name: 'run_show_command', arguments: { command: 'show logging', reason: 'recent events', filter: { tail: 3 } } }] },
      { tools: [{ name: 'run_show_command', arguments: { command: 'show interfaces', reason: 'errors', filter: { grep: 'line protocol|input errors', ignoreCase: true } } }] },
      { text: 'Gi1/0/2 went **down** at the last log entries; no input errors elsewhere.' }
    )
    await page.evaluate((url) => window.hopline.ai.connect({ provider: 'ollama', model: 'qwen3:8b', endpoint: url }), hop.llm.ollama.url)
    await page.reload()
    await page.waitForSelector('text=Lab (simulator)')
    await size(app, page)
    await hop.connect('core-sw1')
    // After a reload the panel may start collapsed (still in the DOM, zero width): open it.
    if (((await page.getByPlaceholder(/Ask about core-sw1/).boundingBox())?.width ?? 0) < 50) await page.keyboard.press('Control+Shift+I')
    await page.waitForTimeout(400)
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await composer.fill('anything in the logs?')
    await composer.press('Enter')
    await expect(page.getByText(/no input errors elsewhere/)).toBeVisible()
    await page.getByTestId('step-filter').first().click()
    await snap(page, '33-ai-local-filter-steps')
  })
})

test('capture: disruptive card, auto-detect toast, Set-platform dialog', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)

  await step(page, 'detect-toast', async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+Shift+O')
    const input = page.getByRole('textbox', { name: 'Quick connect' })
    await input.fill(`admin@127.0.0.1:${hop.sims.ios.port}`)
    await input.press('Enter')
    const pw = page.locator('[role=dialog] input[type=password]')
    await expect(pw).toBeVisible()
    await pw.fill('admin')
    await pw.press('Enter')
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: /Detected Cisco IOS-XE/ })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await snap(page, '40-auto-detect-toast')
    await toast.getByRole('button', { name: 'Change' }).click()
    await expect(page.getByRole('dialog', { name: 'Set platform' })).toBeVisible()
    await snap(page, '41-set-platform-dialog')
  })

  await step(page, 'disruptive-card', async () => {
    hop.llm.ollama.script.push({ tools: [{ name: 'run_show_command', arguments: { command: 'clear ip bgp *', reason: 'reset the BGP sessions' } }] }, { text: 'BGP sessions were reset.' })
    await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
    await page.evaluate((url) => window.hopline.ai.connect({ provider: 'ollama', model: 'qwen3:8b', endpoint: url }), hop.llm.ollama.url)
    await page.reload()
    await page.waitForSelector('text=Lab (simulator)')
    await size(app, page)
    await hop.connect('core-sw1')
    if (((await page.getByPlaceholder(/Ask about core-sw1/).boundingBox())?.width ?? 0) < 50) await page.keyboard.press('Control+Shift+I')
    await page.waitForTimeout(400)
    const composer = page.getByPlaceholder(/Ask about core-sw1/)
    await composer.fill('reset bgp')
    await composer.press('Enter')
    const card = page.locator('[data-proposal="disruptive"]')
    await expect(card).toBeVisible()
    await card.getByRole('textbox', { name: 'Type core-sw1 to confirm' }).fill('core-sw')
    await snap(page, '42-ai-disruptive-card')
  })
})

test('capture: keyboard, palette help, snippets, button bar, multi-device', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)
  const save = (s: Record<string, unknown>) =>
    page.evaluate((x) => (window as unknown as { hopline: { snippets: { save: (s: unknown) => Promise<unknown> } } }).hopline.snippets.save({ mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: true, ...x }), s)

  await step(page, 'keyboard-settings', async () => {
    await page.keyboard.press('Control+Shift+Comma')
    await page.getByRole('tab', { name: 'Keyboard' }).click()
    await page.getByLabel('Filter actions').fill('Split right')
    await page.getByRole('button', { name: 'Change shortcut for Split right' }).click()
    await page.keyboard.press('Control+C')
    await expect(page.getByRole('alert').filter({ hasText: 'Ctrl+C' })).toBeVisible()
    await snap(page, '80-settings-keyboard-refused')
  })
  await step(page, 'shortcut-sheet', async () => {
    await page.keyboard.press('Control+Shift+Slash')
    await expect(page.getByTestId('shortcut-sheet')).toBeVisible()
    await snap(page, '81-shortcut-sheet')
  })
  await step(page, 'palette-help', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.getByRole('combobox', { name: 'Command palette' }).fill('?')
    await snap(page, '82-palette-prefixes')
  })

  await save({ name: 'IP brief', body: 'show ip interface brief' })
  await save({ name: 'Describe port', body: 'interface {{interface}}\n description {{text}}' })
  await save({ name: 'Access VLAN', body: 'interface {{interface}}\n switchport access vlan {{vlan}}' })
  await save({ name: 'Show int', body: 'show interfaces {{interface}}', mode: 'insert' })
  await save({ name: 'BGP reset', body: 'clear ip bgp *' })
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  await size(app, page)
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Vlan1[\s\S]*core-sw1#\s*$/)
  const bar = page.getByRole('toolbar', { name: 'Button bar' })

  await step(page, 'button-bar', async () => {
    await expect(bar).toBeVisible()
    await snap(page, '83-button-bar')
  })
  await step(page, 'snippet-editor', async () => {
    await bar.getByRole('button', { name: 'Manage snippets' }).click()
    await page.getByRole('dialog', { name: 'Snippets' }).getByRole('option', { name: /Access VLAN/ }).click()
    await snap(page, '84-snippet-editor')
  })
  await step(page, 'snippet-vars', async () => {
    await bar.getByRole('button', { name: 'Describe port' }).click()
    await page.getByRole('combobox', { name: 'interface' }).fill('Gi')
    await snap(page, '85-snippet-variables')
  })
  // Changes and uploads need read-only mode off since 0.5.1 (it covers every automated send).
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  await step(page, 'snippet-confirm', async () => {
    await bar.getByRole('button', { name: 'Describe port' }).click()
    await page.getByRole('combobox', { name: 'interface' }).fill('GigabitEthernet1/0/2')
    await page.getByRole('combobox', { name: 'text' }).fill('uplink to dist-eos1')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByTestId('snippet-confirm')).toBeVisible()
    await snap(page, '86-snippet-confirm-config')
  })
  await step(page, 'snippet-disruptive', async () => {
    await bar.getByRole('button', { name: 'BGP reset' }).click()
    await page.getByLabel('Type core-sw1 to confirm').fill('core-sw')
    await snap(page, '87-snippet-confirm-disruptive')
  })

  await step(page, 'multi', async () => {
    // The step helper's extra Esc reached the device; a fresh prompt line for the reused tab.
    await page.locator('.xterm').first().click()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+Shift+K')
    await page.getByRole('combobox', { name: 'Command palette' }).fill('#Lab')
    await page.getByRole('option', { name: /^Lab \(simulator\)/ }).click()
    await snap(page, '88-palette-group-actions')
    await page.getByRole('option', { name: /Run a show command on these/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
    await dlg.getByLabel('Show command').fill('show version')
    await expect(dlg.getByTestId('multi-count')).toContainText('device')
    await snap(page, '89-multi-compose')
    await dlg.getByRole('button', { name: /^Preview/ }).click()
    await expect(dlg.getByTestId('multi-counts')).toBeVisible()
    await snap(page, '90-multi-preview')
    await dlg.getByRole('button', { name: /^Run on/ }).click()
    await expect(dlg.getByTestId('multi-progress')).toHaveText(/^(\d+) of \1 done$/, { timeout: 30_000 })
    await dlg.getByRole('listbox', { name: 'Devices' }).getByRole('option', { name: /dist-eos1/ }).click()
    await snap(page, '91-multi-results')
    await dlg.getByRole('tab', { name: 'Compare' }).click()
    await snap(page, '92-multi-compare')
    await dlg.getByRole('tab', { name: 'Table' }).click()
    await dlg.getByRole('listbox', { name: 'Devices' }).locator('[data-target="core-sw1"]').click()
    await expect(dlg.getByRole('table', { name: 'Parsed table' })).toBeVisible()
    await snap(page, '94-multi-table')
  })
  await step(page, 'send-preview', async () => {
    await page.keyboard.press('Control+Shift+K')
    await page.getByRole('combobox', { name: 'Command palette' }).fill('>send to many')
    await page.getByRole('option', { name: /Send to many devices/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Send to many devices' })
    await dlg.getByRole('listbox', { name: 'Targets' }).getByRole('option', { name: /Lab \(simulator\)/ }).click()
    await dlg.getByLabel('Commands to send').fill('ntp server 10.9.9.9\nlogging host 10.9.9.5')
    await dlg.getByRole('button', { name: /^Preview/ }).click()
    await expect(dlg.getByLabel('Confirm the configuration change')).toBeVisible()
    await snap(page, '93-send-preview-confirm')
  })
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: true }))
})

test('capture: files panel (SFTP, SCP), transfer conflict, port forwarding', async ({ hop }) => {
  const { page, app } = hop
  await size(app, page)
  const eos = await startSim({ device: makeEosDevice(), port: 0, files: { sftp: true }, forwarding: true, remoteForwarding: true })
  const ios = await startSim({ device: makeIosDevice(), port: 0, files: { scp: true } })
  const echo = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
  const local = mkdtempSync(join(tmpdir(), 'hopline-capture-files-'))
  const img = join(local, 'EOS-4.32.2F.swi')
  writeFileSync(img, Buffer.alloc(3_000_000, 9))
  await page.evaluate(
    async (p) => {
      const h = (window as unknown as H).hopline
      const base = { folderId: null, host: '127.0.0.1', protocol: 'ssh', username: 'admin', credentialId: null, logToFile: false, notes: '' }
      await h.sessions.save({ ...base, name: 'leaf-files', port: p.eos, platform: 'eos', options: { ssh: { forwards: [{ id: 'f1', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: p.echo, label: 'mgmt web' }, { id: 'f2', kind: 'D', bindHost: '127.0.0.1', bindPort: 0 }, { id: 'f3', kind: 'L', bindHost: '0.0.0.0', bindPort: 0, destHost: '10.0.0.5', destPort: 22 }] } } })
      await h.sessions.save({ ...base, name: 'edge-scp', port: p.ios, platform: 'ios', options: {} })
    },
    { eos: eos.port, ios: ios.port, echo: (echo.address() as { port: number }).port }
  )
  await page.reload()
  await page.waitForSelector('text=Lab (simulator)')
  const openTab = async (name: string, re: RegExp) => {
    await showSessions(page)
    await page.getByText(name, { exact: true }).first().dblclick()
    await login(hop, re)
  }
  const menu = async (item: RegExp) => {
    await page.getByRole('tab', { selected: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: item }).click()
  }

  // Changes and uploads need read-only mode off since 0.5.1 (it covers every automated send).
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  await step(page, 'files-sftp', async () => {
    await openTab('leaf-files', /dist-eos1[#>]\s*$/)
    await menu(/Files/)
    const panel = page.getByRole('region', { name: 'Files' })
    await expect(panel.getByRole('option', { name: /startup-config/ })).toBeVisible()
    await stubDialogs(app, { open: img, dir: local })
    await panel.getByRole('button', { name: 'Upload…' }).click()
    await expect(panel.getByRole('listitem', { name: /Upload EOS.*Done/ })).toBeVisible()
    await panel.getByRole('option', { name: /tech-support/ }).click()
    await panel.getByRole('listbox').press('Enter')
    await expect(panel.getByRole('listitem', { name: /Download tech-support.*Done/ })).toBeVisible()
    await panel.getByRole('option', { name: /startup-config/ }).click()
    await snap(page, '70-files-sftp')
  })

  await step(page, 'files-conflict', async () => {
    // The previous step's cleanup Esc returned to the terminal and closed the panel (R2 Esc model).
    const panel = page.getByRole('region', { name: 'Files' })
    if (!(await panel.isVisible())) await menu(/Files/)
    await panel.getByRole('option', { name: /tech-support/ }).click()
    await panel.getByRole('listbox').press('Enter')
    await expect(page.getByRole('dialog', { name: /already exists/ })).toBeVisible()
    await snap(page, '71-files-conflict')
  })

  await step(page, 'forwards', async () => {
    await menu(/Port forwarding/)
    const dlg = page.getByRole('dialog', { name: 'Port forwarding' })
    await expect(dlg.getByText('Listening').first()).toBeVisible()
    await dlg.getByLabel('Listen on').fill('0.0.0.0')
    await snap(page, '72-port-forwarding')
  })

  await step(page, 'session-forwards', async () => {
    await showSessions(page)
    await treeRow(page, 'leaf-files').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Edit/ }).first().click()
    const dlg = page.getByRole('dialog', { name: /Edit leaf-files/ })
    await dlg.locator('.overflow-auto').first().evaluate((el) => (el.scrollTop = el.scrollHeight))
    await snap(page, '73-session-forwards-editor')
  })

  await step(page, 'files-scp', async () => {
    await openTab('edge-scp', /core-sw1[#>]\s*$/)
    await menu(/Files/)
    const panel = page.getByRole('region', { name: 'Files' })
    await expect(panel.getByText('SCP', { exact: true })).toBeVisible()
    await panel.getByLabel('Destination path').fill('flash:c2900-universalk9-mz.SPA.157-3.M8.bin')
    await stubDialogs(app, { open: img, dir: local })
    await panel.getByRole('button', { name: 'Choose file and copy…' }).click()
    await page.getByRole('dialog', { name: /Copy to/ }).getByRole('button', { name: 'Replace' }).click()
    await expect(panel.getByRole('listitem', { name: /Upload EOS.*Done/ }).first()).toBeVisible()
    await snap(page, '74-files-scp')
  })

  await eos.close()
  await ios.close()
  echo.close()
  rmSync(local, { recursive: true, force: true })
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: true }))
})

test('capture: command blocks and the TextFSM table view', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'
  await hop.connect('core-sw1')
  await page.keyboard.type('show ip interface brief\r')
  await expect.poll(hop.termText).toMatch(/Loopback0[\s\S]*core-sw1#\s*$/)
  await page.waitForTimeout(300) // the block closes once the output has been quiet briefly
  await step(page, 'command-block', async () => {
    await page.keyboard.press(`${mod}+ArrowUp`)
    await expect(page.getByTestId('block-toolbar')).toBeVisible()
    await snap(page, '50-command-block-toolbar')
  })
  await step(page, 'block-table', async () => {
    await page.keyboard.press(`${mod}+ArrowUp`)
    await page.getByTestId('block-toolbar').getByRole('button', { name: 'Show as table' }).click()
    await expect(page.getByTestId('block-table')).toBeVisible()
    await snap(page, '51-block-table')
  })
  await step(page, 'block-table-changes', async () => {
    await page.locator('.xterm').first().click()
    // The previous step's cleanup Esc reached the device (ESC is a meta prefix on IOS): flush it.
    await page.keyboard.type('\r')
    await page.waitForTimeout(200)
    for (const l of ['configure terminal', 'interface GigabitEthernet1/0/3', 'shutdown', 'end']) {
      await page.keyboard.type(`${l}\r`)
      await page.waitForTimeout(150)
    }
    await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
    await page.keyboard.type('show ip interface brief\r')
    await expect.poll(hop.termText).toMatch(/Loopback0[\s\S]*core-sw1#\s*$/)
    await page.waitForTimeout(300) // the block closes once the output has been quiet briefly
    await page.keyboard.press(`${mod}+ArrowUp`)
    await page.getByTestId('block-toolbar').getByRole('button', { name: 'Show as table' }).click()
    await expect(page.getByTestId('block-table').getByText(/since/)).toBeVisible()
    await snap(page, '52-block-table-changed-since-last-run')
  })
})

test('capture: config backups (history, diff, schedules)', async ({ hop }) => {
  const { app, page } = hop
  await size(app, page)
  await showSessions(page)
  const row = treeRow(page, 'core-sw1').and(page.locator('[data-row-key^="tree:"]'))
  const backUp = async () => {
    await showSessions(page)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Back up config' }).click()
    await page.waitForTimeout(1500)
  }
  await step(page, 'backups-diff', async () => {
    await hop.connect('core-sw1')
    await backUp()
    await page.locator('.xterm').first().click()
    // The previous step's cleanup Esc reached the device (ESC is a meta prefix on IOS): flush it.
    await page.keyboard.type('\r')
    await page.waitForTimeout(200)
    for (const l of ['configure terminal', 'interface GigabitEthernet1/0/2', 'description uplink to dist-eos1', 'end']) await page.keyboard.type(`${l}\r`)
    await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
    await backUp()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Config history…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Config backups' })
    await dialog.getByRole('option').first().click()
    await expect(dialog.locator('.monaco-diff-editor')).toBeVisible()
    await page.waitForTimeout(800)
    await snap(page, '60-backups-diff')
    await dialog.getByRole('radio', { name: 'Inline' }).click()
    await page.waitForTimeout(500)
    await snap(page, '61-backups-diff-inline')
  })
  await step(page, 'backups-schedules', async () => {
    await page.evaluate(async () => {
      const h = window.hopline
      const { folders } = await h.sessions.list()
      const lab = folders.find((f) => f.name === 'Lab (simulator)')!
      await h.backups.saveSchedule({ kind: 'folder', target: lab.id, cadence: 'daily', weekday: 1, time: '02:30', enabled: true })
    })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Config history…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Config backups' })
    await dialog.getByRole('tab', { name: /Schedules/ }).click()
    await page.waitForTimeout(400)
    await snap(page, '62-backups-schedules')
  })
})
