import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MOD, expect, test } from './fixtures'

// A PTY stands in for a USB console cable. POSIX only (Windows has no PTYs).
test.skip(process.platform === 'win32', 'needs a POSIX pty')

let device: ChildProcess
let path = ''
test.beforeEach(async () => {
  device = spawn('python3', [join(__dirname, 'support/serial-device.py')], { stdio: ['pipe', 'pipe', 'inherit'] })
  path = await new Promise<string>((resolve, reject) => {
    createInterface({ input: device.stdout! }).once('line', resolve)
    device.once('error', reject)
  })
})
test.afterEach(() => {
  device.stdin?.end()
  device.kill()
})

test('serial console session: open the port, log in, run a command', async ({ hop }) => {
  // Create the session through the same API the session dialog uses.
  await hop.page.evaluate(async (p) => {
    const h = (window as unknown as { hopline: { sessions: { save: (s: unknown) => Promise<unknown> } } }).hopline
    await h.sessions.save({
      name: 'console-1',
      folderId: null,
      host: p,
      port: 0,
      protocol: 'serial',
      platform: 'ios',
      username: '',
      credentialId: null,
      logToFile: false,
      notes: '',
      options: { serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', breakMs: 300 } }
    })
  }, path)
  await hop.page.reload()
  await hop.page.getByText('console-1', { exact: true }).first().dblclick()
  await expect.poll(hop.termText).toMatch(/Opening .* at 9600 8N1/)
  await hop.page.locator('.xterm').first().click()
  await hop.page.keyboard.type('\r')
  await expect.poll(hop.termText).toMatch(/Router>\s*$/)
  await hop.page.keyboard.type('show version\r')
  await expect.poll(hop.termText).toMatch(/serial console\)[\s\S]*Router>\s*$/)

  // The status bar shows the modem lines as the port has them.
  const { page } = hop
  const dtr = page.locator('[data-serial-line=dtr]')
  const rts = page.locator('[data-serial-line=rts]')
  await expect(dtr).toHaveAttribute('aria-pressed', 'true')
  await expect(rts).toHaveAttribute('aria-pressed', 'true')
  // Every line report from the session host, in order.
  await page.evaluate(() => {
    const w = window as unknown as { __lines: unknown[]; hopline: { term: { onSignals: (cb: (tabId: string, l: unknown) => void) => void } } }
    w.__lines = []
    w.hopline.term.onSignals((_t, l) => w.__lines.push(l))
  })
  const reports = () => page.evaluate(() => (window as unknown as { __lines: { dtr: boolean; rts: boolean; brk: boolean; error?: string }[] }).__lines)
  const palette = async (title: string) => {
    await page.keyboard.press(`${MOD}+K`)
    await page.getByRole('combobox', { name: 'Command palette' }).fill(title)
    await page.getByRole('option', { name: new RegExp(`^${title}`) }).click()
  }

  // A PTY has no modem lines, so the port refuses DTR/RTS (a USB adapter accepts them): the change
  // is reported, and the status bar keeps showing what the port really has.
  await palette('Toggle DTR')
  await expect.poll(async () => (await reports()).at(-1)).toMatchObject({ dtr: true, rts: true, error: expect.stringMatching(/The port refused the change/) })
  await expect(page.getByText(/The port refused the change/)).toBeVisible()
  await expect(dtr).toHaveAttribute('aria-pressed', 'true')
  await rts.click()
  await expect.poll(async () => (await reports()).length).toBe(2)
  await expect(rts).toHaveAttribute('aria-pressed', 'true')

  // Send break: BREAK is shown while it is sent, and cleared after (sent or refused).
  await palette('Send break')
  await expect.poll(async () => (await reports()).slice(2).map((l) => l.brk)).toEqual([true, false])
})
