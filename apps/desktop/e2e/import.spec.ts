import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Session } from '../src/shared/types'
import { MOD, expect, launchHopline, stubDialogs, test } from './fixtures'

const FIX = join(__dirname, 'fixtures')
const SHOTS = process.env['HOPLINE_SHOTS']
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  // Let open/close transitions finish, so a shot shows what a user settles on.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

type Api = { hopline: { sessions: { list: () => Promise<{ sessions: Session[]; folders: { id: string; name: string; parentId: string | null }[] }> } } }
const list = (page: Page) => page.evaluate(() => (window as unknown as Api).hopline.sessions.list())
const tree = (page: Page) => page.getByRole('tree', { name: 'Sessions' })
const item = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true }).and(page.locator('[data-row-key^="tree:"]'))
const review = (page: Page) => page.getByRole('dialog', { name: /Review import|Re-sync from NetBox/ })
const count = (page: Page, group: string) => review(page).locator(`[data-summary="${group}"]`)

/** One fresh profile per test; closed and deleted afterwards. */
let hop: { app: ElectronApplication; page: Page; dir: string }
test.beforeEach(async () => {
  hop = await launchHopline()
})
test.afterEach(async () => {
  await hop.app.close()
  rmSync(hop.dir, { recursive: true, force: true })
})

async function openFromPalette(page: Page, command: string, search = command.replace('…', '')) {
  await page.keyboard.press(`${MOD}+K`)
  await page.keyboard.type(search)
  await expect(page.getByRole('dialog').locator('[cmdk-item][data-selected=true]')).toContainText(command)
  await page.keyboard.press('Enter')
}

test('ssh_config: preview counts, platforms, apply, and the sessions (with their jump hosts) are in the tree', async () => {
  const { app, page } = hop
  await stubDialogs(app, { open: join(FIX, 'ssh_config') })
  await openFromPalette(page, 'Import sessions…')
  const wizard = page.getByRole('dialog', { name: 'Import sessions' })
  await wizard.getByRole('radio', { name: /OpenSSH/ }).click()
  await shot(page, 'import-source')
  await wizard.getByRole('button', { name: 'Choose another file…' }).click()

  const dlg = review(page)
  await expect(count(page, 'new')).toHaveText('10')
  await expect(count(page, 'changed')).toHaveCount(0)
  // Hosts without a platform import as Auto-detect (identified on first connect): nothing blocks.
  await expect(dlg.getByText('6 sessions without a platform (auto-detected on first connect)')).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Import 10 sessions' })).toBeEnabled()
  await expect(dlg.locator('[data-import-row="core-nxos-01"]')).toContainText('via bastion')
  // Warnings are listed (collapsed by default).
  await dlg.locator('[data-import-warnings] button').click()
  await expect(dlg.getByRole('list', { name: 'Import warnings' })).toContainText('Include is not followed')
  // One by hand, the rest in bulk.
  await expect(dlg.getByLabel('Platform for bastion')).toHaveValue('auto')
  await dlg.getByLabel('Platform for bastion').selectOption('ios')
  await dlg.getByLabel('Platform for all').selectOption('iosxe')
  // Leave one out.
  await dlg.getByLabel('Import socks-only').uncheck()
  await shot(page, 'import-review-ssh')
  await dlg.getByRole('button', { name: 'Import 9 sessions' }).click()
  await expect(dlg).toBeHidden()
  await expect(page.getByText('Imported 9 sessions', { exact: true })).toBeVisible()

  for (const name of ['bastion', 'core-nxos-01', 'edge-eos', 'Ümlaut-rtr']) await expect(item(page, name)).toBeVisible()
  await expect(item(page, 'socks-only')).toHaveCount(0)
  const { sessions } = await list(page)
  const by = (n: string) => sessions.find((s) => s.name === n)!
  // The bulk choice replaced the guess too; ProxyJump points at the imported bastion by id.
  expect(by('core-nxos-01')).toMatchObject({ platform: 'iosxe', host: 'core-nxos-01.dc1.example.net', username: 'netops' })
  expect(by('core-nxos-01').options.ssh?.jump).toEqual([by('bastion').id])
  expect(by('edge-eos').options.ssh?.jump).toEqual([by('admin@10.9.9.9:2200').id, by('bastion').id])
})

test('SecureCRT Sessions folder into a target folder; importing it again shows everything unchanged', async () => {
  const { app, page } = hop
  await stubDialogs(app, { dir: join(FIX, 'securecrt/Config/Sessions') })
  await page.getByRole('button', { name: 'Import sessions' }).click()
  const wizard = page.getByRole('dialog', { name: 'Import sessions' })
  await expect(wizard.getByRole('radio', { name: /SecureCRT/ })).toHaveAttribute('aria-checked', 'true')
  await wizard.getByRole('button', { name: 'Choose Sessions folder…' }).click()

  const dlg = review(page)
  await expect(count(page, 'new')).toHaveText('8')
  await dlg.getByLabel('Target folder').selectOption({ label: 'Lab (simulator)' })
  await expect(dlg.locator('[data-import-row="core-nxos-01"]')).toContainText('Lab (simulator) / Prod / Core')
  await expect(dlg.locator('[data-import-row="core-nxos-01"]')).toContainText('via Lab (simulator)/jump/bastion')
  await dlg.getByLabel('Platform for all').selectOption('ios')
  await shot(page, 'import-review-securecrt')
  await dlg.getByRole('button', { name: 'Import 8 sessions' }).click()
  await expect(dlg).toBeHidden()
  await expect(page.getByText(/^Imported 8 sessions into \d folders$/)).toBeVisible()

  await expect(item(page, 'Prod')).toBeVisible()
  await expect(item(page, 'Core')).toBeVisible()
  await expect(item(page, 'core-nxos-01')).toBeVisible()
  await expect(item(page, '路由器-東京')).toBeVisible()
  const { sessions, folders } = await list(page)
  const core = sessions.find((s) => s.name === 'core-nxos-01')!
  const bastion = sessions.find((s) => s.name === 'bastion')!
  expect(core.options.ssh?.jump).toEqual([bastion.id])
  const lab = folders.find((f) => f.name === 'Lab (simulator)')!
  const prod = folders.find((f) => f.name === 'Prod')!
  expect(prod.parentId).toBe(lab.id)

  // Same folder again: nothing to do.
  await page.getByRole('button', { name: 'Import sessions' }).click()
  await page.getByRole('dialog', { name: 'Import sessions' }).getByRole('button', { name: 'Choose Sessions folder…' }).click()
  await dlg.getByLabel('Target folder').selectOption({ label: 'Lab (simulator)' })
  await expect(count(page, 'unchanged')).toHaveText('8')
  await expect(count(page, 'new')).toHaveCount(0)
  await expect(dlg.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
  await dlg.getByRole('button', { name: 'Close' }).click()
  await expect(dlg).toBeHidden()
})

// ------------------------------------------------------------------ NetBox against a local mock server

const TOKEN = 'nb-e2e-token-3f9a1c'
const dev = (id: number, name: string, site: string, ip: string, slug?: string) => ({
  id,
  name,
  site: { id: 1, name: site },
  primary_ip: { address: `${ip}/24` },
  platform: slug ? { slug, name: slug } : null,
  role: { name: 'Access' },
  tags: [{ name: 'Data Center' }]
})

function mockNetBox(devices: () => unknown[]) {
  const seen: { path: string; auth: string | undefined }[] = []
  const server: Server = createServer((req: IncomingMessage, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization })
    if (req.headers.authorization !== `Token ${TOKEN}`) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"detail":"Invalid token."}')
      return
    }
    if (!req.url?.startsWith('/api/dcim/devices/')) return void res.writeHead(404).end()
    const all = devices()
    // Two pages, to exercise pagination through the real fetch.
    const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset') ?? 0)
    const page = all.slice(offset, offset + 2)
    const port = (server.address() as AddressInfo).port
    const next = offset + 2 < all.length ? `http://127.0.0.1:${port}/api/dcim/devices/?limit=2&offset=${offset + 2}` : null
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count: all.length, next, previous: null, results: page }))
  })
  return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(() => r())) })
    )
  )
}

test('NetBox: fetch with a token (kept in the vault), import, then re-sync shows renames and gone devices', async () => {
  const { page } = hop
  let devices = [dev(1, 'ams1-sw1', 'AMS1', '10.0.0.1', 'cisco-ios-xe'), dev(2, 'ams1-sw2', 'AMS1', '10.0.0.2', 'arista-eos'), dev(3, 'fra1-fw1', 'FRA1', '10.1.0.1', 'vyos')]
  const nb = await mockNetBox(() => devices)
  try {
    // Settings → Sync & export → NetBox.
    await page.keyboard.press(`${MOD}+Comma`)
    await page.getByRole('tab', { name: 'Sync & export' }).click()
    await page.getByRole('button', { name: 'Connect…' }).click()
    const wizard = page.getByRole('dialog', { name: 'Import sessions' })
    await expect(wizard.getByRole('radio', { name: /NetBox \/ Nautobot/ })).toHaveAttribute('aria-checked', 'true')
    await wizard.getByLabel('Server URL').fill(nb.url)
    await wizard.getByLabel('API token').fill('wrong-token')
    await wizard.getByRole('button', { name: 'Fetch devices' }).click()
    await expect(wizard.getByRole('alert')).toContainText('Authentication failed')
    await wizard.getByLabel('API token').fill(TOKEN)
    await wizard.getByLabel('Filter').fill('status=active')
    await shot(page, 'import-netbox-form')
    await wizard.getByRole('button', { name: 'Fetch devices' }).click()

    const dlg = review(page)
    await expect(count(page, 'new')).toHaveText('3')
    // The filter went to NetBox, and both pages were fetched.
    expect(nb.seen.filter((r) => r.auth === `Token ${TOKEN}`).map((r) => r.path)).toEqual(['/api/dcim/devices/?limit=250&status=active', '/api/dcim/devices/?limit=2&offset=2'])
    // VyOS has no Hopline platform: Auto-detect (the guard blocks it until identified), never a lookalike.
    await expect(dlg.getByText('1 session without a platform (auto-detected on first connect)')).toBeVisible()
    await expect(dlg.getByLabel('Platform for fra1-fw1')).toHaveValue('auto')
    await dlg.getByLabel('Platform for fra1-fw1').selectOption('junos')
    await dlg.getByRole('button', { name: 'Import 3 sessions' }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByText('Imported 3 sessions into 2 folders', { exact: true })).toBeVisible()
    await expect(item(page, 'AMS1')).toBeVisible()
    await expect(item(page, 'ams1-sw1')).toBeVisible()

    // The token never reached the renderer.
    const state = await page.evaluate(async () => {
      const h = (window as unknown as { hopline: { importer: { netBoxSource(): Promise<unknown> }; settings: { get(): Promise<unknown> } } }).hopline
      return JSON.stringify([document.body.innerText, [...document.querySelectorAll('input')].map((i) => i.value), { ...localStorage }, await h.importer.netBoxSource(), await h.settings.get()])
    })
    expect(state).not.toContain(TOKEN)

    // NetBox changes: device 1 renamed, device 2 deleted.
    devices = [dev(1, 'ams1-core1', 'AMS1', '10.0.0.1', 'cisco-ios-xe'), dev(3, 'fra1-fw1', 'FRA1', '10.1.0.1', 'vyos')]
    const before = nb.seen.length
    await openFromPalette(page, 'Re-sync from NetBox')
    await expect(count(page, 'changed')).toHaveText('1')
    await expect(count(page, 'gone')).toHaveText('1')
    await expect(count(page, 'unchanged')).toHaveText('1')
    // The saved token was sent: it came from the vault.
    expect(nb.seen.slice(before).every((r) => r.auth === `Token ${TOKEN}`)).toBe(true)
    const renamed = dlg.locator('[data-import-row="ams1-core1"]')
    await expect(renamed).toContainText('ams1-sw1')
    // Gone devices are listed but not ticked.
    const gone = dlg.getByLabel('Remove ams1-sw2')
    await expect(gone).not.toBeChecked()
    await shot(page, 'import-resync-netbox')
    await gone.check()
    await dlg.getByRole('button', { name: 'Apply 2 changes' }).click()
    await expect(dlg).toBeHidden()
    await expect(page.getByText('Updated 1 session', { exact: true })).toBeVisible()
    await expect(item(page, 'ams1-core1')).toBeVisible()
    await expect(item(page, 'ams1-sw2')).toHaveCount(0)
    await expect(item(page, 'ams1-sw1')).toHaveCount(0)

    // Settings shows the saved source.
    await page.keyboard.press(`${MOD}+Comma`)
    await page.getByRole('tab', { name: 'Sync & export' }).click()
    await expect(page.locator('[data-netbox-source]')).toHaveText(`${nb.url}?status=active`)
    await page.getByRole('button', { name: 'Re-sync from NetBox' }).scrollIntoViewIfNeeded()
    await shot(page, 'import-settings')
  } finally {
    await nb.close()
  }
})

test('CSV without a recognisable header: map the columns, then import (light theme)', async () => {
  const { app, page } = hop
  const tmp = mkdtempSync(join(tmpdir(), 'hopline-csv-'))
  const file = join(tmp, 'inventory.csv')
  writeFileSync(file, 'edge-1;10.9.0.1;2222;s3cret-pw\nedge-2;10.9.0.2;;\n')
  try {
    await stubDialogs(app, { open: file })
    await openFromPalette(page, 'Toggle dark / light theme', 'toggle theme')
    await openFromPalette(page, 'Import sessions…')
    const wizard = page.getByRole('dialog', { name: 'Import sessions' })
    await wizard.getByRole('radio', { name: /CSV/ }).click()
    await wizard.getByRole('button', { name: 'Choose file…' }).click()

    const dlg = review(page)
    await expect(dlg.getByText('No host or IP column was recognised')).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    // Cell values never reach the renderer: only column positions.
    await expect(dlg.getByLabel('Host or IP').locator('option')).toHaveText(['—', 'Column 1', 'Column 2', 'Column 3', 'Column 4'])
    await dlg.getByRole('switch', { name: 'First row is a header' }).click()
    await dlg.getByLabel('Host or IP').selectOption({ label: 'Column 2' })
    await dlg.getByLabel('Name', { exact: true }).selectOption({ label: 'Column 1' })
    await dlg.getByLabel('Port', { exact: true }).selectOption({ label: 'Column 3' })
    await dlg.getByRole('button', { name: 'Apply columns' }).click()
    await expect(count(page, 'new')).toHaveText('2')
    await expect(dlg.locator('[data-import-row="edge-1"]')).toContainText('10.9.0.1:2222')
    await dlg.getByLabel('Platform for all').selectOption('eos')
    await shot(page, 'import-review-csv-light')
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('s3cret-pw')
    await dlg.getByRole('button', { name: 'Import 2 sessions' }).click()
    await expect(page.getByText('Imported 2 sessions', { exact: true })).toBeVisible()
    await expect(item(page, 'edge-1')).toBeVisible()
    const { sessions } = await list(page)
    expect(sessions.find((s) => s.name === 'edge-1')).toMatchObject({ host: '10.9.0.1', port: 2222, platform: 'eos' })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
