import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import ssh2 from 'ssh2'
import { generateEd25519, makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { MOD, expect, launchHopline, stubDialogs, termTextOf, test, waitForWorkspace } from './fixtures'

/** A device whose password appears nowhere else: if it shows up in the renderer, it leaked. */
const SECRET = 'Sim-Canary-Pw-4242'
let sim: RunningSim
test.beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0, password: SECRET })
})
test.afterAll(() => sim.close())

async function openSettingsTab(page: Page, tab: string) {
  await waitForWorkspace(page)
  await page.keyboard.press(`${MOD}+Comma`)
  await page.getByRole('tab', { name: tab }).click()
}

/** Everything the renderer can see or has stored: page text, inputs, storage and IPC results. */
async function rendererState(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const h = (window as unknown as { hopline: { credentials: { list(): Promise<unknown> }; sessions: { list(): Promise<unknown> }; settings: { get(): Promise<unknown> } } }).hopline
    const inputs = [...document.querySelectorAll('input')].map((i) => i.value)
    return JSON.stringify([document.body.innerText, inputs, { ...localStorage }, await h.credentials.list(), await h.sessions.list(), await h.settings.get()])
  })
}

async function addPasswordProfile(page: Page, name: string) {
  await openSettingsTab(page, 'Credentials')
  await page.getByRole('button', { name: 'Add profile' }).click()
  const dlg = page.getByRole('dialog', { name: 'New credential profile' })
  await dlg.getByLabel('Profile name').fill(name)
  await dlg.getByLabel('Username').fill('admin')
  await dlg.getByLabel('Password', { exact: true }).fill(SECRET)
  await dlg.getByRole('button', { name: 'Add profile' }).click()
  await expect(dlg).toBeHidden()
  const row = page.locator(`[data-credential="${name}"]`)
  await expect(row).toContainText('password saved')
  await expect(row).toContainText('unused')
  await page.getByRole('button', { name: 'Close', exact: true }).last().click()
}

async function addSession(page: Page, name: string, profile: string, kind = 'password', port = sim.port) {
  await page.getByRole('button', { name: 'New session' }).click()
  const dlg = page.getByRole('dialog', { name: 'New session' })
  await dlg.getByPlaceholder('core-sw1').fill(name)
  await dlg.getByPlaceholder('10.0.0.1 or hostname').fill('127.0.0.1')
  await dlg.locator('input[type=number]').first().fill(String(port))
  const picker = dlg.locator('select').filter({ hasText: 'Ask for password on connect' })
  await picker.selectOption({ label: `${profile} (admin · ${kind})` })
  await dlg.getByRole('button', { name: 'Add session' }).click()
  await expect(dlg).toBeHidden()
}

test('a password profile made in Settings → Credentials signs a session in; the secret never reaches the renderer', async ({ hop }) => {
  const { page } = hop
  await addPasswordProfile(page, 'Canary admin')
  await addSession(page, 'canary-sw', 'Canary admin')
  await page.getByText('canary-sw', { exact: true }).first().dblclick()
  await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
  expect(await hop.termText()).toContain('authenticated with password')
  // Signed in from the profile: no password prompt was needed.
  await expect(page.locator('[role=dialog] input[type=password]')).toHaveCount(0)
  // The profile now shows its session.
  await openSettingsTab(page, 'Credentials')
  await expect(page.locator('[data-credential="Canary admin"]')).toContainText('1 session')
  expect(await rendererState(page)).not.toContain(SECRET)
})

test('a key file picked through main shows its fingerprint; an encrypted key asks for its passphrase at connect', async ({ hop }) => {
  const { page, app } = hop
  const keyDir = mkdtempSync(join(tmpdir(), 'hopline-key-'))
  const key = generateEd25519({ passphrase: 'key-pass-77' }) // retries around an ssh2 keygen bug
  writeFileSync(join(keyDir, 'id_ed25519'), key.private, { mode: 0o600 })
  const parsed = ssh2.utils.parseKey(key.public)
  if (parsed instanceof Error) throw parsed
  const fingerprint = 'SHA256:' + createHash('sha256').update((Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH()).digest('base64').replace(/=+$/, '')
  const keySim = await startSim({ device: makeIosDevice(), port: 0, authorizedKeys: [key.public], methods: ['publickey'] })
  try {
    await stubDialogs(app, { open: join(keyDir, 'id_ed25519') })
    await openSettingsTab(page, 'Credentials')
    await page.getByRole('button', { name: 'Add profile' }).click()
    const dlg = page.getByRole('dialog', { name: 'New credential profile' })
    await dlg.getByLabel('Username').fill('admin')
    await dlg.getByLabel('Authentication').selectOption('key')
    await dlg.getByRole('button', { name: 'Choose key file…' }).click()
    await expect(dlg.getByTestId('key-fingerprint')).toHaveText(fingerprint)
    await expect(dlg.getByLabel('Key details')).toContainText('passphrase-protected')
    await dlg.getByLabel('Profile name').fill('Ops key')
    // No passphrase stored: it is asked for at connect time.
    await dlg.getByRole('button', { name: 'Add profile' }).click()
    await expect(dlg).toBeHidden()
    await expect(page.locator('[data-credential="Ops key"]')).toContainText('passphrase asked')
    await page.getByRole('button', { name: 'Close', exact: true }).last().click()

    await addSession(page, 'key-sw', 'Ops key', 'private key', keySim.port)
    await page.getByText('key-sw', { exact: true }).first().dblclick()
    const ask = page.getByRole('dialog', { name: 'Key passphrase' })
    await ask.locator('input[type=password]').fill('key-pass-77')
    await ask.locator('input[type=password]').press('Enter')
    await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
    const state = await rendererState(page)
    expect(state).not.toContain(key.private.split('\n')[2])
    expect(state).not.toContain('PRIVATE KEY')
  } finally {
    await keySim.close()
    rmSync(keyDir, { recursive: true, force: true })
  }
})

test('export with secrets, then import into a fresh profile and connect with the imported credential', async ({ hop }) => {
  const { page, app } = hop
  const out = mkdtempSync(join(tmpdir(), 'hopline-export-'))
  const file = join(out, 'backup.hopline')
  try {
    await addPasswordProfile(page, 'Canary admin')
    await addSession(page, 'canary-sw', 'Canary admin')
    await stubDialogs(app, { save: file })
    await openSettingsTab(page, 'Sync & export')
    await page.getByLabel('Export passphrase', { exact: true }).fill('export-passphrase-1')
    await page.getByLabel('Repeat export passphrase').fill('export-passphrase-1')
    await page.getByRole('switch', { name: 'Include secrets' }).click()
    await page.getByRole('button', { name: 'Export…' }).click()
    await expect(page.getByText('Exported', { exact: true })).toBeVisible()

    // A second, fresh profile imports it.
    const other = await launchHopline()
    try {
      await stubDialogs(other.app, { open: file })
      await openSettingsTab(other.page, 'Sync & export')
      await other.page.getByRole('button', { name: 'Import…' }).click()
      const ask = other.page.getByRole('dialog', { name: 'Import Hopline Terminal data' })
      await ask.getByLabel('Passphrase').fill('wrong-passphrase')
      await ask.getByRole('button', { name: 'Continue' }).click()
      await expect(ask.getByRole('alert')).toContainText('Wrong passphrase')
      await ask.getByLabel('Passphrase').fill('export-passphrase-1')
      await ask.getByRole('button', { name: 'Continue' }).click()
      const review = other.page.getByRole('dialog', { name: 'Review import' })
      const summary = review.getByLabel('Import summary')
      await expect(summary).toContainText('Sessions4')
      await expect(summary).toContainText('with secrets')
      await review.getByRole('button', { name: 'Merge' }).click()
      await expect(review).toBeHidden()
      await other.page.getByRole('button', { name: 'Close', exact: true }).last().click()

      await other.page.getByText('canary-sw', { exact: true }).first().dblclick()
      const text = termTextOf(other.page)
      await expect.poll(text).toMatch(/core-sw1#\s*$/)
      expect(await text()).toContain('authenticated with password')
      await expect(other.page.locator('[role=dialog] input[type=password]')).toHaveCount(0)
      expect(await rendererState(other.page)).not.toContain(SECRET)
    } finally {
      await other.app.close()
      rmSync(other.dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('replace two saved password profiles together and leave the third independent', async ({ hop }) => {
  const { page } = hop
  await page.evaluate(async () => {
    for (const name of ['Branch east', 'Branch west', 'Datacenter']) {
      await window.hopline.credentials.save({ name, username: 'operator', kind: 'password', secret: 'fixture-original' })
    }
  })
  await page.reload()
  await openSettingsTab(page, 'Credentials')
  await page.getByRole('button', { name: 'Update saved passwords…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Update saved passwords' })
  for (const name of ['Branch east','Branch west']) await dlg.getByRole('checkbox', { name: new RegExp(name) }).check()
  await expect(dlg.getByText(/2 profiles selected/)).toBeVisible()
  if (process.env['HOPLINE_SHOTS']) await page.screenshot({ animations: 'disabled', path: join(process.env['HOPLINE_SHOTS'], 'saved-passwords.png') })
  await dlg.getByLabel('New password', { exact: true }).fill('fixture-replacement')
  const apply = dlg.getByRole('button', { name: 'Update 2 profiles' })
  await expect(apply).toBeDisabled()
  await dlg.getByLabel('Confirm new password').fill('fixture-replacement')
  await apply.click()
  await expect(dlg).toBeHidden()
  await expect(page.getByText('Updated 2 saved password profiles')).toBeVisible()
  expect(await rendererState(page)).not.toContain('fixture-replacement')
})
