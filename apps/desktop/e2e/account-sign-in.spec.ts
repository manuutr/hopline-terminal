import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { MOD, expect, test } from './fixtures'

for (const [id, label, bin] of [['chatgpt','ChatGPT','codex'], ['copilot','GitHub Copilot','copilot']] as const) {
  test(`${label} supports device authorization, a masked question and disconnect`, async ({ hop }) => {
    const dir = mkdtempSync(join(tmpdir(), 'hopline-e2e-login-'))
    const client = join(dir, bin + (process.platform === 'win32' ? '.exe' : ''))
    const shim = join(dir, 'provider.cjs')
    const consent = join(dir, 'approved')
    const url = id === 'chatgpt' ? 'https://auth.openai.com/codex/device' : 'https://github.com/login/device'
    writeFileSync(client, '', { mode: 0o700 })
    writeFileSync(shim, `
      const fs = require('node:fs'), path = require('node:path')
      const dir = process.env.CODEX_HOME || process.env.COPILOT_HOME
      const auth = path.join(dir, process.env.CODEX_HOME ? 'auth.json' : 'config.json')
      if (process.argv.includes('login')) {
        console.log(${JSON.stringify(url)} + ' ABCD-1234')
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(consent)})) return
          clearInterval(poll)
          fs.writeFileSync(auth, '{"account":"synthetic-secret-credential"}')
        }, 40)
      } else {
        if (!fs.existsSync(auth)) process.exit(1)
        let input = ''
        process.stdin.on('data', chunk => { input += chunk })
        process.stdin.on('end', () => {
          if (input.includes('core-sw1') || !input.includes('interface status')) process.exit(2)
          const text = 'The fixture link is up.'
          if (process.env.CODEX_HOME) {
            console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
            console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 71, output_tokens: 6 } }))
          } else console.log(text)
        })
      }
    `)
    try {
      // Launch a real child process on every OS. Only this test instance redirects the
      // synthetic executable to Node; shipping builds expose no provider override.
      await hop.app.evaluate((_electron, { dir, delimiter, client, shim, node }) => {
        process.env.PATH = dir + delimiter + process.env.PATH
        const cp = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
        const original = cp.spawn
        cp.spawn = ((command: string, args: string[], opts: object) => command === client
          ? original(node, [shim, ...args], opts)
          : original(command, args, opts)) as typeof original
        const mod = process.getBuiltinModule('node:module') as typeof import('node:module')
        mod.syncBuiltinESMExports()
      }, { dir, delimiter, client, shim, node: process.execPath })
      await hop.connect('core-sw1')
      const { page } = hop
      await page.keyboard.press(`${MOD}+I`)
      const setup = page.getByRole('form', { name: 'Connect a model' })
      await setup.getByRole('radio', { name: label, exact: true }).click()
      await setup.getByRole('button', { name: 'Sign in with ' + label }).click()
      await expect(setup.getByText('ABCD-1234')).toBeVisible()
      await setup.getByRole('button', { name: 'Cancel sign-in' }).click()
      await expect(setup.getByRole('button', { name: 'Open verification page' })).toHaveCount(0)
      await setup.getByRole('button', { name: 'Sign in with ' + label }).click()
      await expect(setup.getByText('ABCD-1234')).toBeVisible()
      writeFileSync(consent, 'approved in fixture')
      await setup.getByRole('button', { name: 'Use ' + label }).click()
      const composer = page.getByPlaceholder(/Ask about core-sw1/)
      await composer.fill('Explain the interface status of core-sw1')
      await composer.press('Enter')
      await expect(page.getByText('The fixture link is up.', { exact: true })).toBeVisible()
      await page.getByTestId('ai-provider').click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('button', { name: 'Disconnect account' }).click()
      await expect(dialog.getByRole('button', { name: 'Sign in with ' + label })).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(setup.getByRole('button', { name: 'Sign in with ' + label })).toBeVisible()
      const settings = await page.evaluate(() => window.hopline.settings.get())
      expect(settings.connectedAccounts?.[id]).toBe(false)
      expect(JSON.stringify(settings)).not.toContain('synthetic-secret-credential')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
