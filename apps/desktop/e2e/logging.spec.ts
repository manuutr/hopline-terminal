import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('session log: SecureCRT tokens name the file, subfolders, timestamps, no escapes', async ({ hop }) => {
  const logDir = mkdtempSync(join(tmpdir(), 'hopline-logs-'))
  await hop.page.evaluate(async (dir) => {
    const h = (window as unknown as { hopline: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> }).hopline
    await h.settings!.update!({ logDir: dir, logTemplate: '%Y-%M/%S_%H_%P.txt', logTimestamps: true })
    const list = ((await h.sessions!.list!()) as { sessions: { id: string; name: string }[] }).sessions
    const s = list.find((x) => x.name === 'core-sw1')!
    await h.sessions!.save!({ ...s, logToFile: true })
  }, logDir)
  await hop.page.reload()
  await hop.connect('core-sw1')
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/Cisco IOS[\s\S]*core-sw1#\s*$/)

  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const port = hop.sims.ios.port
  // ".txt" templates still produce a .log file (never a script or config name).
  const file = join(logDir, month, `core-sw1_127.0.0.1_${port}.txt.log`)
  await expect.poll(() => readdirSync(join(logDir, month)).join(',')).toContain(`core-sw1_127.0.0.1_${port}.txt.log`)
  await expect.poll(() => readFileSync(file, 'utf8')).toMatch(/Cisco IOS/)
  const log = readFileSync(file, 'utf8')
  expect(log.split('\n')[0]).toMatch(/^=== Hopline session log: core-sw1 \(admin@127\.0\.0\.1:\d+\)/)
  expect(log).toMatch(/^\[\d\d:\d\d:\d\d\.\d{3}\] .*Cisco IOS/m)
  expect(log).not.toMatch(/\x1b\[/)
})
