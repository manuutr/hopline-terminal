import type { Page } from '@playwright/test'
import { makeDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AuditRow, CredentialInfo, Folder, Session, SessionInput } from '../src/shared/types'
import { MOD, expect, test } from './fixtures'

type W = {
  hopline: {
    audit: { list: (n: number) => Promise<AuditRow[]> }
    credentials: { list: () => Promise<CredentialInfo[]> }
    sessions: { list: () => Promise<{ folders: Folder[]; sessions: Session[] }>; save: (s: SessionInput) => Promise<Session>; saveFolder: (f: { name: string; parentId: string | null }) => Promise<Folder> }
  }
}
const audit = (page: Page) => page.evaluate(() => (window as unknown as W).hopline.audit.list(200))

/** A "Fleet" folder with the seeded IOS-XE and EOS simulators plus Junos and NX-OS ones, all on the seeded credential. */
async function fleet(page: Page, ports: { ios: number; eos: number; junos: number; nxos: number }) {
  await page.evaluate(async (p) => {
    const h = (window as unknown as W).hopline
    const cred = (await h.credentials.list()).find((c) => c.name === 'Simulator admin')!
    const folder = await h.sessions.saveFolder({ name: 'Fleet', parentId: null })
    const base = { folderId: folder.id, host: '127.0.0.1', protocol: 'ssh' as const, username: 'admin', credentialId: cred.id, logToFile: false, notes: '', options: {}, tags: ['fleet'] }
    await h.sessions.save({ ...base, name: 'fleet-ios', port: p.ios, platform: 'iosxe' } as SessionInput)
    await h.sessions.save({ ...base, name: 'fleet-eos', port: p.eos, platform: 'eos' } as SessionInput)
    await h.sessions.save({ ...base, name: 'fleet-junos', port: p.junos, platform: 'junos' } as SessionInput)
    await h.sessions.save({ ...base, name: 'fleet-nxos', port: p.nxos, platform: 'nxos' } as SessionInput)
  }, ports)
  await page.reload()
  await page.waitForSelector('text=Fleet')
}

let junos: RunningSim
let nxos: RunningSim
test.beforeEach(async () => {
  junos = await startSim({ device: makeDevice('junos'), port: 0 })
  nxos = await startSim({ device: makeDevice('nxos'), port: 0 })
})
test.afterEach(async () => {
  await junos.close()
  await nxos.close()
})

test('multi-device run: a folder from the palette, translated per platform, background connections, compare view', async ({ hop }) => {
  const { page } = hop
  await fleet(page, { ios: hop.sims.ios.port, eos: hop.sims.eos.port, junos: junos.port, nxos: nxos.port })

  // # picks the folder; its actions offer a run on its devices.
  await page.keyboard.press(`${MOD}+K`)
  const input = page.getByRole('combobox', { name: 'Command palette' })
  await input.fill('#Fleet')
  await page.getByRole('option', { name: /^Fleet/ }).click()
  await page.getByRole('option', { name: /Run a show command on these 4/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
  await expect(dlg.getByTestId('multi-count')).toHaveText('4 devices')

  // Not read-only on Junos as typed: translated, it is.
  await dlg.getByLabel('Show command').fill('show interfaces status')
  // The Preview button's chord (Mod+Enter: Ctrl+Shift+Enter here, ⌘↩ on macOS).
  await dlg.getByLabel('Show command').press(`${MOD}+Enter`)
  const row = (name: string) => dlg.locator(`tr[data-target="${name}"]`)
  await expect(row('fleet-junos')).toHaveAttribute('data-kind', 'read')
  await expect(row('fleet-junos')).toContainText('show interfaces terse')
  await expect(row('fleet-junos')).toContainText('translated')
  await expect(row('fleet-nxos')).toContainText('show interface status')
  await expect(row('fleet-ios')).toContainText('show interfaces status')
  await dlg.getByRole('button', { name: 'Back' }).click()

  // One command, everywhere: show version.
  await dlg.getByLabel('Show command').fill('show version')
  await dlg.getByRole('button', { name: /^Preview/ }).click()
  await expect(dlg.getByTestId('multi-counts')).toContainText('4 read-only')
  await dlg.getByRole('button', { name: 'Run on 4' }).click()
  const target = (name: string) => dlg.getByRole('option', { name: new RegExp(name) })
  for (const n of ['fleet-ios', 'fleet-eos', 'fleet-junos', 'fleet-nxos']) await expect(target(n)).toHaveAttribute('data-status', 'ok', { timeout: 30_000 })
  await expect(dlg.getByTestId('multi-progress')).toHaveText('4 of 4 done')
  await target('fleet-junos').click()
  await expect(dlg.getByTestId('multi-output')).toContainText(/Junos/i)
  await target('fleet-eos').click()
  await expect(dlg.getByTestId('multi-output')).toContainText('Arista')

  // Compare: every device differs from the IOS baseline.
  await dlg.getByRole('tab', { name: 'Compare' }).click()
  await dlg.getByRole('combobox', { name: 'Baseline device' }).click()
  await page.getByRole('option', { name: 'fleet-ios', exact: true }).click()
  await expect(target('fleet-ios')).toContainText('baseline')
  await expect(target('fleet-eos')).toContainText(/\d+ lines/)
  // Table: the bundled TextFSM templates parse each device's output.
  await dlg.getByRole('tab', { name: 'Table' }).click()
  await target('fleet-ios').click()
  await expect(dlg.getByRole('table', { name: 'Parsed table' })).toContainText('core-sw1')
  await expect(dlg.getByRole('columnheader').first()).not.toHaveText(/_/)
  // All devices: one inventory table with a Device column, from every device the same template parsed.
  const scope = dlg.getByRole('radiogroup', { name: 'Table scope' })
  if (await scope.isVisible()) {
    await scope.getByRole('radio', { name: /^All/ }).click()
    const all = dlg.getByRole('table', { name: 'Parsed table, all devices' })
    await expect(all.getByRole('columnheader').first()).toHaveText(/Device/)
    await expect(all).toContainText('fleet-ios')
  }
  await dlg.getByRole('button', { name: 'Done' }).click()

  const rows = (await audit(page)).filter((r) => r.source === 'multi')
  expect(rows.map((r) => `${r.sessionName}:${r.command}:${r.decision}`).sort()).toEqual([
    'fleet-eos:show version:executed',
    'fleet-ios:show version:executed',
    'fleet-junos:show version:executed',
    'fleet-nxos:show version:executed'
  ])
  // Background connections are gone: no tab was opened for them.
  await expect(page.getByRole('tab')).toHaveCount(0)
})

test('send to many: open tabs as targets, disruptive refused with the reason, config only after confirmation', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await hop.connect('dist-eos1')
  await page.keyboard.press(`${MOD}+K`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('>send to many')
  await page.getByRole('option', { name: /Send to many devices/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Send to many devices' })
  // The active tab is picked; add the other one from the keyboard: Down from the filter enters the
  // list, Space toggles, and focus stays on the row (round 2: rows no longer re-mount).
  const targets = dlg.getByRole('listbox', { name: 'Targets' })
  await expect(targets.getByRole('option', { selected: true })).toHaveText(/dist-eos1/)
  await dlg.getByLabel('Filter targets').press('ArrowDown')
  const first = targets.getByRole('option').first()
  await expect(first).toBeFocused()
  const firstName = (await first.textContent()) ?? ''
  const core = targets.getByRole('option', { name: /core-sw1$/ }).first()
  if (!/core-sw1$/.test(firstName)) {
    // Walk down to the core-sw1 tab row.
    for (let i = 0; i < 5 && !(await core.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown')
  }
  await expect(core).toBeFocused()
  await page.keyboard.press('Space')
  await expect(core).toBeFocused()
  await expect(core).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Space')
  await expect(core).toBeFocused()
  await expect(core).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('Space')
  const checked = targets.getByRole('option', { selected: true })
  await expect(checked).toHaveCount(2)
  await expect(dlg.getByTestId('multi-count')).toHaveText('2 devices')

  // Read-only mode (on by default) covers send-to-many (fix-round Low 5): the preview says so.
  await dlg.getByLabel('Commands to send').fill('ntp server 10.9.9.9')
  await dlg.getByRole('button', { name: /^Preview/ }).click()
  await expect(dlg.locator('tr[data-target="core-sw1"]')).toHaveAttribute('data-kind', 'refused')
  await expect(dlg.locator('tr[data-target="core-sw1"]')).toContainText('read-only mode is on')
  await expect(dlg.getByRole('button', { name: /Send to 0/ })).toBeDisabled()
  await dlg.getByRole('button', { name: 'Back' }).click()
  await page.evaluate(() => window.hopline.settings.update({ aiReadOnly: false }))

  await dlg.getByLabel('Commands to send').fill('clear ip bgp *')
  await dlg.getByRole('button', { name: /^Preview/ }).click()
  const row = (name: string) => dlg.locator(`tr[data-target="${name}"]`)
  await expect(row('core-sw1')).toHaveAttribute('data-kind', 'refused')
  await expect(row('core-sw1')).toContainText('not sent to several devices')
  await expect(dlg.getByRole('button', { name: /Send to 0/ })).toBeDisabled()
  await dlg.getByRole('button', { name: 'Back' }).click()

  await dlg.getByLabel('Commands to send').fill('ntp server 10.9.9.9')
  await dlg.getByRole('button', { name: /^Preview/ }).click()
  await expect(row('core-sw1')).toHaveAttribute('data-kind', 'config')
  await expect(row('core-sw1')).toContainText('configure terminal')
  await expect(row('dist-eos1')).toHaveAttribute('data-kind', 'config')
  const send = dlg.getByRole('button', { name: 'Send to 2' })
  await expect(send).toBeDisabled()
  await dlg.getByLabel('Confirm the configuration change').check()
  await send.click()
  const target = (name: string) => dlg.getByRole('option', { name: new RegExp(name) })
  await expect(target('core-sw1')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 })
  await expect(target('dist-eos1')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 })
  await dlg.getByRole('button', { name: 'Done' }).click()

  const rows = (await audit(page)).filter((r) => r.source === 'multi')
  // Only previewed, never started: nothing was sent, but a preview where nothing can run is audited
  // at once as refused (Phase 4 review Low 3), once per device.
  expect(rows.filter((r) => r.command === 'clear ip bgp *').map((r) => `${r.sessionName}:${r.decision}`).sort()).toEqual(['core-sw1:refused', 'dist-eos1:refused'])
  expect(rows.filter((r) => r.command === 'ntp server 10.9.9.9' && r.decision === 'executed').map((r) => r.sessionName).sort()).toEqual(['core-sw1', 'dist-eos1'])
  // The open tabs were used, and still work.
  await page.keyboard.type('show running-config | include ntp\r')
  await expect.poll(hop.termText).toMatch(/ntp server 10\.9\.9\.9[\s\S]*dist-eos1#\s*$/)
})

test('the session tree context menu runs on a folder or the selected sessions', async ({ hop }) => {
  const { page } = hop
  await page.getByRole('treeitem', { name: /Lab \(simulator\)/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Run on this folder…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Run on many devices' })
  // The telnet session is listed but excluded, with the reason.
  await expect(dlg.getByTestId('multi-count')).toHaveText('2 devices')
  await expect(dlg).toContainText('telnet sign-in is typed at the device')
})
