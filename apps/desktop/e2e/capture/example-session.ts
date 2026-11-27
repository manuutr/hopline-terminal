import { expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startSim, type Device, type RunningSim } from '../../../../packages/simulator/src/index.ts'
import type { Platform } from '../../src/shared/types'
import { neutralUser } from './operator'
import { treeRow, launchHopline, showSessions, sizeWindow, termTextOf } from '../fixtures'

interface Endpoint {
  name: string
  platform: Platform
  device: Device
}

export async function withDevices(folder: string, endpoints: Endpoint[], run: (page: Page) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-example-'))
  const servers: RunningSim[] = []
  let app: Awaited<ReturnType<typeof launchHopline>>['app'] | undefined
  try {
    for (const { device } of endpoints) {
      servers.push(await startSim({ device, host: '127.0.0.1', port: 0 }))
    }
    const launched = await launchHopline({ dir, production: true, waitFor: '' })
    app = launched.app
    await neutralUser(app)
    const { page } = launched
    await page.waitForFunction(() => performance.getEntriesByName('hopline:ready').length > 0)
    expect(await page.evaluate(async () => ({
      lab: 'lab' in window.hopline, inventory: await window.hopline.sessions.list()
    }))).toMatchObject({ lab: false, inventory: { sessions: [], folders: [] } })
    await sizeWindow(app, page, 1360, 850)
    await page.evaluate(async ({folder, sessions}) => {
      const api = window.hopline
      await api.settings.update({ updateAutoCheck: false, privacyReviewed: true, termFontSize: 16 })
      await api.ux.onboarding.set({ ...await api.ux.onboarding.get(), stepsDone: true, checklistDismissed: true })
      const group = await api.sessions.saveFolder({ name: folder, parentId: null })
      const credential = await api.credentials.save({ name: 'Network operations', kind: 'password', username: 'admin', secret: 'admin' })
      for (const endpoint of sessions) {
        await api.sessions.save({ ...endpoint, folderId: group.id, host: '127.0.0.1', protocol: 'ssh', username: 'admin',
          credentialId: credential.id, logToFile: false, notes: '', options: {}, tags: [] })
      }
    }, { folder, sessions: endpoints.map(({ name, platform }, i) => ({ name, platform, port: servers[i]!.port })) })
    await page.reload()
    await expect(treeRow(page, endpoints[0]!.name)).toBeVisible()
    await run(page)
  } finally {
    if (app) await app.close()
    await Promise.all(servers.map(server => server.close()))
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function connect(page: Page, name: string, prompt: RegExp) {
  await showSessions(page)
  await treeRow(page, name).first().dblclick()
  await expect.poll(termTextOf(page)).toMatch(prompt)
}

export async function command(page: Page, line: string, expected: RegExp) {
  await page.locator('.xterm:visible .xterm-helper-textarea').last().focus()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
  const readTerminal = termTextOf(page)
  await expect.poll(async () => {
    const buffer = await readTerminal()
    const echo = buffer.lastIndexOf(line)
    return echo < 0 ? '' : buffer.slice(echo + line.length)
  }).toMatch(expected)
}

export async function picture(page: Page, incident: string, name: string, height?: number, surface?: Locator) {
  const dir = resolve(__dirname, '../../../../docs/examples', incident)
  mkdirSync(dir, { recursive: true })
  await page.mouse.move(4, 4)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  const bounds = await (surface ?? page.locator('body')).boundingBox()
  if (!bounds) throw new Error('Screenshot surface is hidden')
  const clip = { ...bounds, height: Math.min(bounds.height, height ?? bounds.height) }
  await page.screenshot({ path: join(dir, name + '.png'), clip, animations: 'disabled', caret: 'hide' })
}
