import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect as netConnect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceFs, makeEosDevice, makeIosDevice, resolvePath, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { expect, showSessions, stubDialogs, test, type Hopline } from './fixtures'

// Own simulators on port 0 (never the user's 2201/2202/2301/2302): EOS with SFTP, direct-tcpip and
// remote forwarding; IOS with SCP only (no SFTP subsystem), like a real `ip scp server enable` box.
const eosDev = makeEosDevice()
const iosDev = makeIosDevice()
let eos: RunningSim
let ios: RunningSim
let echo: Server
let local: string
test.beforeAll(async () => {
  eos = await startSim({ device: eosDev, port: 0, files: { sftp: true }, forwarding: true, remoteForwarding: true })
  ios = await startSim({ device: iosDev, port: 0, files: { scp: true } })
  echo = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
  local = mkdtempSync(join(tmpdir(), 'hopline-files-'))
})
test.afterAll(async () => {
  await eos.close()
  await ios.close()
  echo.close()
  rmSync(local, { recursive: true, force: true })
})

async function open(hop: Hopline, name: string, port: number, platform: string, ready: RegExp): Promise<void> {
  await hop.page.evaluate(
    async (p) => {
      const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<{ id: string }> } } }).hopline
      await h.sessions.save({ folderId: null, name: p.name, host: '127.0.0.1', port: p.port, protocol: 'ssh', platform: p.platform, username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} })
    },
    { name, port, platform }
  )
  await hop.page.reload()
  await hop.page.getByText(name, { exact: true }).first().dblclick()
  const pw = hop.page.locator('[role=dialog] input[type=password]')
  await expect(pw).toBeVisible()
  await pw.fill('admin')
  await pw.press('Enter')
  await expect.poll(hop.termText).toMatch(ready)
}

async function tabMenu(hop: Hopline, item: RegExp): Promise<void> {
  await hop.page.getByRole('tab').first().click({ button: 'right' })
  await hop.page.getByRole('menuitem', { name: item }).click()
}

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')

test('SFTP: browse, upload with hashes, download, a conflict keeps both, drop refuses page-made files', async ({ hop }) => {
  // These run changes and uploads: read-only mode (on by default) covers them (fix-round Low 5).
  await hop.page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  const { page } = hop
  await open(hop, 'eos-files', eos.port, 'eos', /dist-eos1[#>]\s*$/)
  await tabMenu(hop, /Files/)
  const panel = page.getByRole('region', { name: 'Files' })
  await expect(panel.getByText('SFTP', { exact: true })).toBeVisible()
  const list = panel.getByRole('listbox', { name: /Files in/ })
  const report = (uri: string) => page.evaluate((path) => {
    const api = (window as unknown as { __hoplineTest: { raw(): import('@xterm/xterm').Terminal } }).__hoplineTest
    return new Promise<void>((done) => api.raw().write('\x1b]7;' + path + '\x07', done))
  }, uri)
  await report('file://127.0.0.1/mnt/flash/logs')
  const follow = panel.getByRole('button', { name: 'Follow terminal folder' })
  await expect(follow).toHaveAttribute('aria-pressed', 'false')
  await follow.click()
  await expect(list.getByRole('option', { name: /messages/ })).toBeVisible()
  await report('file://127.0.0.1/mnt/flash')
  await expect(list.getByRole('option', { name: /startup-config/ })).toBeVisible()
  await follow.click()

  await expect(list.getByRole('option', { name: /startup-config/ })).toBeVisible()
  await list.getByRole('option', { name: /startup-config/ }).click()
  await list.press('F3')
  const preview = page.getByRole('dialog', { name: 'Preview startup-config' })
  await expect(preview.getByLabel('File contents')).toContainText('hostname dist-eos1')
  await preview.getByRole('button', { name: 'Close', exact: true }).last().click()

  // Hidden files are off by default.
  await expect(list.getByRole('option', { name: /\.persist/ })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Show hidden files' }).click()
  await expect(list.getByRole('option', { name: /\.persist/ })).toBeVisible()

  // Upload through the (stubbed) OS picker: the hash is computed locally while streaming.
  const body = Buffer.alloc(600_000, 7)
  const src = join(local, 'image.bin')
  writeFileSync(src, body)
  await stubDialogs(hop.app, { open: src, dir: local })
  await panel.getByRole('button', { name: 'Upload…' }).click()
  const queue = panel.getByRole('region', { name: 'Transfers' })
  await expect(queue.getByRole('listitem', { name: 'Upload image.bin: Done' })).toBeVisible()
  await expect(queue.getByText(md5(body))).toBeVisible()
  await expect(queue.getByText('verify /md5 flash:image.bin')).toBeVisible()
  const fs = deviceFs(eosDev)
  expect(fs.files.get(resolvePath(fs, 'image.bin'))?.data.length).toBe(body.length)
  await expect(list.getByRole('option', { name: /image\.bin/ })).toBeVisible()

  // The verify command copies to the (in-memory, test-mode) clipboard.
  await queue.getByRole('button', { name: 'Copy the verify command' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hoplineTest: { clipboard: { get: () => string } } }).__hoplineTest.clipboard.get())).toBe("verify /md5 flash:image.bin")

  // Download: Enter on the focused row. The first download asks for the folder.
  await list.getByRole('option', { name: /startup-config/ }).click()
  await list.press('Enter')
  await expect(queue.getByRole('listitem', { name: 'Download startup-config: Done' })).toBeVisible()
  const got = readFileSync(join(local, 'startup-config'), 'utf8')
  expect(got).toContain('hostname')

  // Again with "ask": the conflict dialog, Keep both is the default.
  await list.press('Enter')
  const dlg = page.getByRole('dialog', { name: 'startup-config already exists' })
  await expect(dlg).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Keep both' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(queue.getByRole('listitem', { name: 'Download startup-config (2): Done' })).toBeVisible()
  expect(existsSync(join(local, 'startup-config (2)'))).toBe(true)

  // A drop path the page made up never reaches main: the preload only takes real dropped files.
  const r = await page.evaluate(() =>
    (window as unknown as { hopline: { transfer: { uploadDropped: (q: unknown, f: unknown[]) => Promise<{ queued: number; skipped: unknown[] }> } } }).hopline.transfer.uploadDropped(
      { tabId: 'x', remoteDir: '/', policy: 'ask' },
      [new File(['x'], '/etc/passwd'), '/etc/shadow']
    )
  )
  expect(r.queued).toBe(0)
  expect(r.skipped.length).toBe(1)

  // mkdir and delete with the in-app confirm.
  await panel.getByRole('button', { name: 'New folder' }).click()
  await page.getByRole('dialog', { name: 'New folder' }).locator('input').fill('backups')
  await page.keyboard.press('Enter')
  await expect(list.getByRole('option', { name: /backups/ })).toBeVisible()
  await list.getByRole('option', { name: /backups/ }).click()
  await list.press('Delete')
  await page.getByRole('dialog', { name: /Delete backups/ }).getByRole('button', { name: 'Delete' }).click()
  await expect(list.getByRole('option', { name: /backups/ })).toHaveCount(0)

  // Every transfer is audited with source transfer.
  const audit = await page.evaluate(() => (window as unknown as { hopline: { audit: { list: (q: number) => Promise<{ source: string; command: string }[]> } } }).hopline.audit.list(50))
  const rows = audit.filter((a) => a.source === 'transfer').map((a) => a.command)
  expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^sftp put .*image\.bin$/), expect.stringMatching(/^sftp get .*startup-config$/)]))
})

test('Files keyboard: Mod+J opens on the list, Esc gives the terminal back, a second Esc closes (not sent); queue per tab', async ({ hop }) => {
  // These run changes and uploads: read-only mode (on by default) covers them (fix-round Low 5).
  await hop.page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  const { page } = hop
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'
  await open(hop, 'eos-keys', eos.port, 'eos', /dist-eos1[#>]\s*$/)
  await page.locator('.xterm').first().click()
  await page.keyboard.press(`${mod}+J`)
  const panel = page.getByRole('region', { name: 'Files' })
  const list = panel.getByRole('listbox', { name: /Files in/ })
  await expect(list.getByRole('option', { name: /startup-config/ })).toBeVisible()
  await expect(list).toBeFocused()

  // First Esc: focus goes back to the terminal, the panel stays.
  await page.keyboard.press('Escape')
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused()
  await expect(panel).toBeVisible()
  // Second Esc right after: the panel closes and the device never sees an ESC byte.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused()
  await page.keyboard.type('show clock\r')
  // Nothing (no ^[) between the prompt and the command: the Esc never reached the line.
  await expect.poll(hop.termText).toMatch(/dist-eos1[#>]show clock[\s\S]*dist-eos1[#>]\s*$/)

  // Mod+J again opens it; Mod+J with focus in the panel closes it and the terminal gets focus.
  await page.keyboard.press(`${mod}+J`)
  await expect(list).toBeFocused()
  await page.keyboard.press(`${mod}+J`)
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused()

  // The queue shows the active tab's transfers; another tab's show with "All tabs".
  await page.keyboard.press(`${mod}+J`)
  const src = join(local, 'per-tab.bin')
  writeFileSync(src, Buffer.alloc(1000, 1))
  await stubDialogs(hop.app, { open: src, dir: local })
  await panel.getByRole('button', { name: 'Upload…' }).click()
  const queue = panel.getByRole('region', { name: 'Transfers' })
  await expect(queue.getByRole('listitem', { name: 'Upload per-tab.bin: Done' })).toBeVisible()
  await showSessions(page)
  await page.getByText('core-sw1', { exact: true }).first().dblclick()
  await expect.poll(async () => (await page.getByRole('tab').count()) >= 2).toBe(true)
  await expect(queue.getByRole('listitem', { name: 'Upload per-tab.bin: Done' })).toHaveCount(0)
  await queue.getByRole('switch', { name: 'All tabs' }).click()
  await expect(queue.getByRole('listitem', { name: 'Upload per-tab.bin: Done' })).toBeVisible()
})

test('SCP device: copy a file to flash: by path, then the verify command', async ({ hop }) => {
  // These run changes and uploads: read-only mode (on by default) covers them (fix-round Low 5).
  await hop.page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))
  const { page } = hop
  await open(hop, 'ios-scp', ios.port, 'ios', /core-sw1[#>]\s*$/)
  await page.getByRole('button', { name: 'Browse remote files' }).click()
  const panel = page.getByRole('region', { name: 'Files' })
  await expect(panel.getByText('SCP', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Browse device directory' }).click()
  await panel.getByRole('list', { name: 'Device directory' }).getByRole('button', { name: /tech-support.txt/ }).click()
  const preview = page.getByRole('dialog', { name: 'Preview tech-support.txt' })
  await expect(preview.getByLabel('File contents')).toContainText('show tech-support for core-sw1')
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: join(process.env['HOPLINE_SHOTS'], 'device-file-preview.png') })
  await preview.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(panel.getByLabel('Source path')).toHaveValue('flash:tech-support.txt')
  await panel.getByRole('button', { name: 'Close directory' }).click()
  const body = Buffer.alloc(200_000, 3)
  const src = join(local, 'c2900.bin')
  writeFileSync(src, body)
  await stubDialogs(hop.app, { open: src, dir: local })
  await panel.getByLabel('Destination path').fill('flash:c2900.bin')
  await panel.getByRole('button', { name: 'Choose file and copy…' }).click()
  // SCP can't check whether the file exists: an explicit confirm. The safe Skip has focus, never Replace.
  const ask = page.getByRole('dialog', { name: 'Copy to flash:c2900.bin?' })
  await expect(ask.getByRole('button', { name: 'Skip' })).toBeFocused()
  await ask.getByRole('button', { name: 'Replace' }).click()
  const queue = panel.getByRole('region', { name: 'Transfers' })
  await expect(queue.getByRole('listitem', { name: 'Upload c2900.bin: Done' })).toBeVisible()
  await expect(queue.getByText(`verify /md5 flash:c2900.bin ${md5(body)}`)).toBeVisible()
  const fs = deviceFs(iosDev)
  expect(fs.files.get(resolvePath(fs, 'flash:c2900.bin'))?.data.equals(body)).toBe(true)

  // A missing file says so in the device's words.
  await panel.getByLabel('Source path').fill('flash:nope.txt')
  await panel.getByRole('button', { name: 'Download' }).click()
  await expect(queue.getByRole('listitem', { name: /Download nope\.txt: Failed/ })).toContainText(/No such file/i)
})

test('port forwarding: add a local forward live, traffic flows, stop it', async ({ hop }) => {
  const { page } = hop
  await open(hop, 'eos-fwd', eos.port, 'eos', /dist-eos1[#>]\s*$/)
  await tabMenu(hop, /Port forwarding/)
  const dlg = page.getByRole('dialog', { name: 'Port forwarding' })
  await dlg.getByLabel('Port', { exact: true }).first().fill('0')
  await dlg.getByLabel(/To host/).fill('127.0.0.1')
  const echoPort = (echo.address() as { port: number }).port
  await dlg.locator('#fwd-dport').fill(String(echoPort))
  // 0.0.0.0 warns; back to loopback.
  await dlg.getByLabel('Listen on').fill('0.0.0.0')
  await expect(dlg.getByRole('alert')).toContainText('Anyone on your network')
  await dlg.getByLabel('Listen on').fill('127.0.0.1')
  await expect(dlg.getByRole('alert')).toHaveCount(0)
  await dlg.getByRole('button', { name: 'Add and start' }).click()
  const row = dlg.getByRole('list', { name: 'Forwards' }).getByRole('listitem').first()
  await expect(row).toContainText('Listening')
  const text = await row.innerText()
  const port = Number(/L 127\.0\.0\.1:(\d+)/.exec(text)?.[1])
  expect(port).toBeGreaterThan(0)

  const reply = await new Promise<string>((resolve, reject) => {
    const s = netConnect(port, '127.0.0.1', () => s.write('ping through the device'))
    s.once('data', (d) => (resolve(d.toString()), s.end()))
    s.once('error', reject)
  })
  expect(reply).toBe('ping through the device')
  await expect(row).toContainText('1 total')

  await row.getByRole('button', { name: /^Stop/ }).click()
  await expect(row).toContainText('Stopped')
  const refused = await new Promise<boolean>((resolve) => {
    const s = netConnect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), resolve(false)))
    s.once('error', () => resolve(true))
  })
  expect(refused).toBe(true)
})

test('saved forwards start on connect and come back after a reconnect (L stays bound, R is asked again)', async ({ hop }) => {
  const { page } = hop
  const echoPort = (echo.address() as { port: number }).port
  let remoteAsks = 0
  const onAsk = () => remoteAsks++
  eos.events.on('tcpip-forward', onAsk)
  await page.evaluate(
    async (p) => {
      const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<{ id: string }> } } }).hopline
      await h.sessions.save({
        folderId: null, name: 'eos-saved-fwd', host: '127.0.0.1', port: p.port, protocol: 'ssh', platform: 'eos', username: 'admin', credentialId: null, logToFile: false, notes: '',
        options: {
          ssh: {
            forwards: [
              { id: 'l1', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: p.echo },
              { id: 'r1', kind: 'R', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: p.echo },
              // A wildcard bind is saved but never starts on its own.
              { id: 'w1', kind: 'D', bindHost: '0.0.0.0', bindPort: 0 }
            ]
          }
        }
      })
    },
    { port: eos.port, echo: echoPort }
  )
  await page.reload()
  await page.getByText('eos-saved-fwd', { exact: true }).first().dblclick()
  const pw = page.locator('[role=dialog] input[type=password]')
  await expect(pw).toBeVisible()
  await pw.fill('admin')
  await pw.press('Enter')
  await expect.poll(hop.termText).toMatch(/dist-eos1[#>]\s*$/)
  await expect.poll(() => remoteAsks).toBe(1)

  await tabMenu(hop, /Port forwarding/)
  const dlg = page.getByRole('dialog', { name: 'Port forwarding' })
  const rows = dlg.getByRole('list', { name: 'Forwards' }).getByRole('listitem')
  await expect(rows).toHaveCount(3)
  const localRow = rows.filter({ hasText: /L 127\.0\.0\.1/ })
  await expect(localRow).toContainText('Listening')
  await expect(rows.filter({ hasText: '0.0.0.0' })).toContainText('Stopped')
  const port = Number(/L 127\.0\.0\.1:(\d+)/.exec(await localRow.innerText())?.[1])
  const ping = () =>
    new Promise<string>((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1', () => s.write('hello'))
      s.once('data', (d) => (resolve(d.toString()), s.end()))
      s.once('error', reject)
    })
  expect(await ping()).toBe('hello')
  await page.keyboard.press('Escape')

  // End the session on the device, then reconnect: the same local port works again and the
  // remote forward is requested on the new connection.
  await page.locator('.xterm').first().click()
  await page.keyboard.type('exit\r')
  const strip = page.getByRole('status').filter({ hasText: 'Disconnected' })
  await expect(strip).toBeVisible()
  await strip.getByRole('button', { name: /Reconnect/ }).click()
  await expect.poll(async () => (await pw.isVisible()) || /dist-eos1[#>]\s*$/.test(await hop.termText())).toBe(true)
  if (await pw.isVisible()) {
    await pw.fill('admin')
    await pw.press('Enter')
  }
  await expect.poll(hop.termText, { timeout: 15_000 }).toMatch(/dist-eos1[#>]\s*$/)
  await expect.poll(() => remoteAsks).toBe(2)
  expect(await ping()).toBe('hello')
  eos.events.off('tcpip-forward', onAsk)
})

test('Files can open automatically on an SSH connection while the terminal keeps focus', async ({ hop }) => {
  await hop.page.evaluate(() => window.hopline.settings.update({ filesOnConnect: true }))
  await open(hop, 'eos-files', eos.port, 'eos', /dist-eos1[#>]\s*$/)
  await expect(hop.page.getByRole('listbox', { name: /Files in/ })).toBeVisible()
  await expect(hop.page.locator('.xterm-helper-textarea').first()).toBeFocused()
  await hop.page.getByRole('button', { name: 'Browse remote files' }).click()
  await expect(hop.page.getByRole('region', { name: 'Files' })).toBeHidden()
})
