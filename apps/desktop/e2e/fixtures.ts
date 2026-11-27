import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEosDevice, makeIosDevice, startSim, startTelnetSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import { fakeAnthropic, fakeOllama, type FakeServer, type OllamaChatBody, type OllamaTurn } from '../test/fake-llm'

export interface Hopline {
  app: ElectronApplication
  page: Page
  sims: { ios: RunningSim; eos: RunningSim }
  /** Local fake LLM servers. The app's Anthropic client points at `anthropic` (dev + e2e builds only). */
  llm: { anthropic: FakeServer; ollama: FakeServer & { script: OllamaTurn[]; route: { fn?: (body: OllamaChatBody) => OllamaTurn | undefined } } }
  /** The profile directory of this instance. */
  dir: string
  /** Plain text of the active terminal buffer. */
  termText: () => Promise<string>
  /** Open a seeded session and log in through the password prompt. */
  connect: (name: string) => Promise<void>
}

/**
 * Launch Hopline on a profile directory (a fresh temp one by default). Tests that restart the app
 * or open a second profile (export → import elsewhere) call this directly; close the app yourself.
 */
export async function launchHopline(opts: { production?: boolean; dir?: string; seedPorts?: string; waitFor?: string; anthropicUrl?: string; env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'hopline-e2e-'))
  const app = await electron.launch({
    args: [opts.production ? '.' : process.env.HOPLINE_TEST_APP ?? 'out-test'],
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      HOPLINE_USER_DATA: dir,
      HOPLINE_SEED_PORTS: opts.seedPorts ?? '1,1,1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      // A key pasted in a test can never reach api.anthropic.com: the client talks to a local fake
      // (or to a closed port when a test brings none).
      HOPLINE_E2E_ANTHROPIC_URL: opts.anthropicUrl ?? 'http://127.0.0.1:9',
      HOPLINE_E2E: '1',
      // Never pop windows over the user's desktop. HOPLINE_SHOW=1 to watch a run.
      HOPLINE_HIDDEN: process.env['HOPLINE_SHOW'] === '1' ? '' : '1',
      // A team policy only when a test sets one (docs/POLICY.md).
      HOPLINE_POLICY: '',
      ...opts.env
    }
  })
  // Nothing a test does may open a real OS window or touch the user's clipboard: native dialogs
  // answer "cancel" unless a test stubs them otherwise (stubDialogs), and the renderer keeps its
  // clipboard in memory in this mode (lib/clipboard.ts).
  await app.evaluate(({ dialog, shell }) => {
    // No browser tab or Explorer/Finder window either: links and "show in folder" are recorded.
    const opened: string[] = []
    ;(globalThis as { __hoplineOpened?: string[] }).__hoplineOpened = opened
    shell.openExternal = (async (url: string) => void opened.push(url)) as typeof shell.openExternal
    shell.openPath = (async (p: string) => (opened.push(p), '')) as typeof shell.openPath
    shell.showItemInFolder = ((p: string) => void opened.push(p)) as typeof shell.showItemInFolder
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as unknown as typeof dialog.showOpenDialog
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as unknown as typeof dialog.showSaveDialog
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as { cancelId?: number; message?: string } | undefined
      // Specs save sessions on the simulators' random ports with the seeded credential: main asks
      // before a credential meets a new address (P8 C-L1), and here that question is answered yes.
      // p8-security.spec covers the Cancel path.
      if (o?.message?.startsWith('Use the saved credential')) return { response: 0, checkboxChecked: false }
      return { response: o?.cancelId ?? 0, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox
    dialog.showMessageBoxSync = (() => 0) as unknown as typeof dialog.showMessageBoxSync
    dialog.showErrorBox = () => {}
  })
  const page = await app.firstWindow()
  // P8 M4: the renderer runs under a strict CSP. Anything it refuses is a bug (a blocked worker,
  // style or image): the `hop` fixture fails the test if any appears.
  const violations: string[] = []
  cspViolations.set(page, violations)
  page.on('console', (m) => void (/Content Security Policy/i.test(m.text()) && violations.push(m.text())))
  if (opts.waitFor !== '') await page.waitForSelector(`text=${opts.waitFor ?? 'Lab (simulator)'}`)
  // Hosted displays can clamp even a hidden Electron window to their native resolution.
  if (process.env['HOPLINE_SHOW'] !== '1') await sizeWindow(app, page, 1440, 900)
  return { app, page, dir }
}

/** CSP violations the renderer logged, per window (launchHopline records them). */
export const cspViolations = new WeakMap<Page, string[]>()

/** Answer native dialogs from the main process: file pickers return `paths`, message boxes press button 0. */
export async function stubDialogs(app: ElectronApplication, paths: { open?: string; save?: string; dir?: string }): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const o = args.find((a) => a && typeof a === 'object' && 'properties' in (a as object)) as { properties?: string[] } | undefined
      const isDir = o?.properties?.includes('openDirectory')
      const path = isDir ? p.dir : p.open
      return { canceled: !path, filePaths: path ? [path] : [] }
    }) as typeof dialog.showOpenDialog
    dialog.showSaveDialog = (async () => ({ canceled: !p.save, filePath: p.save ?? '' })) as unknown as typeof dialog.showSaveDialog
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
  }, paths)
}

/**
 * Show the session sidebar before using the tree, including after a manual collapse.
 * Clicks the title bar's toggle, like a user would; a no-op when the tree is already visible.
 */
export async function showSessions(page: Page): Promise<void> {
  // The toggle's pressed state is the store's, so this never closes a sidebar that is opening.
  const toggle = page.getByRole('button', { name: 'Toggle session sidebar' })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#session-search')).toBeVisible()
}

/**
 * The app's "Mod" chord for page.keyboard.press: ⌘ on macOS, Ctrl+Shift on Windows and Linux
 * (lib/keymap.ts). Write `${MOD}+K` for the palette, never a hard-coded 'Control+Shift+K'.
 */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'

/**
 * A binding as the app prints it (design/Kbd.tsx kbdLabel): "Mod+D" reads "Ctrl+Shift+D" on
 * Windows/Linux and "⌘D" on macOS; "Ctrl+Alt+K" reads "⌃⌥K" there.
 */
export function keyLabel(combo: string): string {
  const mac = process.platform === 'darwin'
  const parts = combo.split('+').flatMap((k) => (k === 'Mod' && !mac ? ['Ctrl', 'Shift'] : [k])).filter((k, i, all) => all.indexOf(k) === i)
  const sym: Record<string, string> = { Mod: '⌘', Meta: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↩' }
  return mac ? parts.map((k) => sym[k] ?? k).join('') : parts.join('+')
}

/** Size the native window and give Chromium the requested layout viewport on smaller displays. */
export async function sizeWindow(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  const nativeWindow = await app.browserWindow(page)
  try {
    await nativeWindow.evaluate((win, { width, height }) => {
      const [minWidth, minHeight] = win.getMinimumSize()
      win.setMinimumSize(Math.min(minWidth, width), Math.min(minHeight, height))
      win.setContentSize(width, height)
    }, { width, height })
  } finally {
    await nativeWindow.dispose()
  }
  await page.setViewportSize({ width, height })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

/**
 * The fake model's default answer: the lab's planted fault (docs/guide/getting-started.md): Gi1/0/2,
 * core-sw1's uplink to isp-r2, is shut down, so BGP to 10.0.0.2 is Idle.
 */
export const LAB_FAULT_ANSWER = 'BGP to 10.0.0.2 is **Idle** because Gi1/0/2, the uplink to isp-r2, is administratively down. `no shutdown` on Gi1/0/2 should bring it back.'

export const termTextOf = (page: Page) => () => page.evaluate(() => {
  const w = window as unknown as { __hoplineActiveTab: () => string | null; __hoplineTest: { text: (tabId: string) => string } }
  const id = w.__hoplineActiveTab()
  return id ? w.__hoplineTest.text(id) : ''
})

export const test = base.extend<{ hop: Hopline; hopEnv: Record<string, string> }>({
  /** Extra environment for the app (`test.use({ hopEnv: { HOPLINE_POLICY: … } })`). */
  hopEnv: [{}, { option: true }],
  hop: async ({ hopEnv }, use) => {
    const ios = await startSim({ device: makeIosDevice(), port: 0 })
    const eos = await startSim({ device: makeEosDevice(), port: 0 })
    const telnet = await startTelnetSim({ device: makeIosDevice(), port: 0 })
    const anthropic = await fakeAnthropic({ answer: LAB_FAULT_ANSWER })
    const ollama = await fakeOllama()
    const { app, page, dir } = await launchHopline({ seedPorts: `${ios.port},${eos.port},${telnet.port}`, anthropicUrl: anthropic.url, env: hopEnv })
    const termText = termTextOf(page)
    const connect = async (name: string) => {
      await showSessions(page)
      await page.getByRole('treeitem', { name, exact: true }).first().dblclick()
      const ready = new RegExp(`${name}[#>]\\s*$`)
      const pw = page.locator('[role=dialog] input[type=password]')
      // Either the seeded credential works (keychain available) or we are asked for the password.
      await expect.poll(async () => (await pw.isVisible()) || ready.test(await termText())).toBe(true)
      if (await pw.isVisible()) {
        await pw.fill('admin')
        await pw.press('Enter')
      }
      await expect.poll(termText).toMatch(ready)
      await page.locator('.xterm').first().click()
    }
    await use({ app, page, sims: { ios, eos }, llm: { anthropic, ollama }, dir, termText, connect })
    const csp = cspViolations.get(page) ?? []
    await app.close()
    await anthropic.close()
    await ollama.close()
    await ios.close()
    await eos.close()
    await telnet.close()
    rmSync(dir, { recursive: true, force: true })
    expect(csp, 'the renderer logged Content Security Policy violations').toEqual([])
  }
})

export { expect }
