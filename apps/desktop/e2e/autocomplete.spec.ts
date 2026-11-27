import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const SHOTS = process.env['HOPLINE_SHOTS']
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

type Ghost = { text: string; latencies: number[]; work: number[]; live: Record<string, string[] | undefined> }
const ghost = (page: Page) => page.evaluate(() => (window as unknown as { __hoplineTest: { ghost: () => Ghost } }).__hoplineTest.ghost())
const ghostText = (page: Page) => async () => (await ghost(page)).text
/** Wait until the device has echoed what we typed (the screen is current). */
const echoed = async (termText: () => Promise<string>, re: RegExp) => expect.poll(termText).toMatch(re)

test('ghost text at the IOS-XE prompt: Tab, → and End accept, Tab without a ghost goes to the device, hints show help', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('sh')
  await expect.poll(ghostText(page)).toBe('ow')
  await page.keyboard.press('ArrowRight')
  await echoed(hop.termText, /core-sw1#show$/)
  await page.keyboard.type(' ip int')
  await expect.poll(ghostText(page)).toBe('erface')
  // The hint list names what the word can be, with its help.
  await expect(page.locator('.hop-hints')).toBeVisible()
  await expect(page.locator('.hop-hints')).toContainText('interface')
  await shot(page, 'autocomplete-ghost')
  await page.keyboard.press('End')
  await echoed(hop.termText, /core-sw1#show ip interface$/)
  // Ghost text is drawn over the canvas: never in the buffer (copy, logs, find).
  expect(await hop.termText()).not.toMatch(/show ip interfaceerface/)
  await page.keyboard.type(' br')
  await expect.poll(ghostText(page)).toBe('ief')
  // Tab accepts a visible ghost, like → and End.
  await page.keyboard.press('Tab')
  await echoed(hop.termText, /core-sw1#show ip interface brief$/)
  expect(await ghostText(page)()).toBe('')
  await page.keyboard.press('Enter')
  await echoed(hop.termText, /Vlan10[\s\S]*core-sw1#\s*$/)

  // The listing the user just ran taught the interfaces (passively): they complete now.
  await expect.poll(async () => (await ghost(page)).live['interfaces']?.length ?? 0).toBeGreaterThan(3)
  expect((await ghost(page)).live['interfaces']).toEqual(expect.arrayContaining(['Vlan10', 'Loopback0']))
  // Several learned values: no ghost, the hints list them.
  await page.keyboard.press('Control+U')
  await page.keyboard.type('show interfaces Vlan')
  await expect(page.locator('.hop-hints')).toContainText('Vlan20')
  await page.keyboard.press('Control+U')
  await page.keyboard.type('show interfaces Lo')
  await expect.poll(ghostText(page)).toBe('opback0')
  await page.keyboard.press('ArrowRight')
  await echoed(hop.termText, /core-sw1#show interfaces Loopback0$/)
  await page.keyboard.press('Control+U')
  await echoed(hop.termText, /core-sw1#\s*$/)

  // Nothing was sent that the user did not type or accept: every command line on screen is ours.
  const commands = (await hop.termText()).split('\n').filter((l) => /^core-sw1#\S/.test(l)).map((l) => l.replace(/^core-sw1#/, '').trim())
  expect(commands).toEqual(['show ip interface brief'])
})

test('no ghost where it must not be: config mode follows the prompt; off in Settings', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  await page.keyboard.type('conf t\r')
  await echoed(hop.termText, /core-sw1\(config\)#\s*$/)
  await page.keyboard.type('interf')
  await expect.poll(ghostText(page)).toBe('ace')
  await page.keyboard.press('Control+U')
  await page.keyboard.type('end\r')
  await echoed(hop.termText, /core-sw1#\s*$/)

  // Cursor moved back into the line: nothing is suggested, and → moves the cursor on the device.
  await page.keyboard.type('show ip int')
  await expect.poll(ghostText(page)).toBe('erface')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await expect.poll(ghostText(page)).toBe('')
  await page.keyboard.press('Control+E')
  await page.keyboard.press('Control+U')
  await echoed(hop.termText, /core-sw1#\s*$/)

  // A ghost left on screen is not accepted once the view is scrolled back: → goes to the device.
  // (Enough lines that there is scrollback to scroll into.)
  for (let i = 0; i < 60; i++) await page.keyboard.type('\r')
  await echoed(hop.termText, /(core-sw1#\s*\n){20}/)
  await page.keyboard.type('sh')
  await expect.poll(ghostText(page)).toBe('ow')
  await page.evaluate(() => (window as unknown as { __hoplineTest: { scroll: (n: number) => void } }).__hoplineTest.scroll(-3))
  // xterm scrolls over several frames when smooth scrolling is on.
  await expect(page.getByRole('button', { name: /^Jump to bottom/ })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.evaluate(() => (window as unknown as { __hoplineTest: { scroll: (n: number) => void } }).__hoplineTest.scroll(0))
  await page.keyboard.type('x')
  await echoed(hop.termText, /core-sw1#shx$/)
  await page.keyboard.press('Control+U')
  await echoed(hop.termText, /core-sw1#\s*$/)

  // At a pager prompt: no ghost.
  await page.keyboard.type('show running-config\r')
  await echoed(hop.termText, /--More--\s*$/)
  expect(await ghostText(page)()).toBe('')
  await expect(page.locator('.hop-hints')).toBeHidden()
  await page.keyboard.type('q')
  await echoed(hop.termText, /core-sw1#\s*$/)
  // → with no ghost goes to the device (cursor movement), and hides nothing.
  await page.evaluate(() => window.hopline.settings.update({ termAutocomplete: false }))
  await page.reload()
  await hop.connect('core-sw1')
  await page.keyboard.type('sh')
  await echoed(hop.termText, /core-sw1#sh$/)
  expect(await ghostText(page)()).toBe('')
  await expect(page.locator('.hop-hints')).toBeHidden()
})

test('Arista EOS: its own command tree and modes', async ({ hop }) => {
  const { page } = hop
  await hop.connect('dist-eos1')
  await page.keyboard.type('show ver')
  await expect.poll(ghostText(page)).toBe('sion')
  await page.keyboard.press('ArrowRight')
  await echoed(hop.termText, /dist-eos1#show version$/)
  await page.keyboard.press('Control+U')
  await page.keyboard.type('configure\r')
  await echoed(hop.termText, /dist-eos1\(config\)#\s*$/)
  await page.keyboard.type('router bg')
  await expect.poll(ghostText(page)).toBe('p')
})

test('keystroke to ghost stays under one frame (work p95 and latency p50 < 16 ms)', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  for (const word of ['show ip interface brief', 'show running-config interface Vlan10', 'show ip bgp summary']) {
    // One key at a time, each echoed before the next: the ghost waits for the echo, so a key typed
    // before the previous echo would fold two keystrokes into one sample.
    for (let i = 1; i <= word.length; i++) {
      await page.keyboard.type(word[i - 1]!)
      await echoed(hop.termText, new RegExp(`core-sw1#${word.slice(0, i).trimEnd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    }
    await page.keyboard.press('Control+U')
    await echoed(hop.termText, /core-sw1#\s*$/)
  }
  const g = await ghost(page)
  const lat = [...g.latencies].sort((a, b) => a - b)
  const work = [...g.work].sort((a, b) => a - b)
  expect(lat.length).toBeGreaterThan(40)
  const at = (xs: number[], q: number) => xs[Math.floor(xs.length * q)]!
  console.log(`autocomplete keydown→ghost: n=${lat.length} p50=${at(lat, 0.5).toFixed(2)}ms p95=${at(lat, 0.95).toFixed(2)}ms; work p95=${at(work, 0.95).toFixed(2)}ms`)
  // The suggestion work is the app's own budget: under a frame for nearly every key. The full
  // keydown→ghost time also waits for the echo and for the CPU, so its tail grows on a busy machine
  // (p95 38 ms with the CPU saturated, 1-8 ms idle): its median is the stable check.
  expect(at(work, 0.95)).toBeLessThan(16)
  expect(at(lat, 0.5)).toBeLessThan(16)
})

test('ghost text waits for the echo: it is never drawn ahead of characters the device has not echoed', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  // Each time the ghost is drawn, note where it is and where the terminal cursor is at that moment.
  await page.evaluate(() => {
    type Raw = { cols: number; buffer: { active: { cursorX: number } }; element?: HTMLElement }
    const w = window as unknown as { __ghostSeen: { left: number; cursor: number }[]; __hoplineTest: { raw: () => Raw | null } }
    w.__ghostSeen = []
    const term = w.__hoplineTest.raw()!
    const el = term.element!.querySelector<HTMLElement>('.hop-ghost')!
    new MutationObserver(() => {
      if (el.style.display !== 'block') return
      const screen = term.element!.querySelector<HTMLElement>('.xterm-screen')!
      const cell = screen.clientWidth / term.cols
      w.__ghostSeen.push({ left: parseFloat(el.style.left), cursor: screen.offsetLeft + term.buffer.active.cursorX * cell })
    }).observe(el, { attributes: true, attributeFilter: ['style'] })
  })
  for (const ch of 'show ip int') await page.keyboard.type(ch)
  await echoed(hop.termText, /core-sw1#show ip int$/)
  await expect.poll(ghostText(page)).toBe('erface')
  const seen = await page.evaluate(() => (window as unknown as { __ghostSeen: { left: number; cursor: number }[] }).__ghostSeen)
  expect(seen.length).toBeGreaterThan(0)
  for (const s of seen) expect(Math.abs(s.left - s.cursor)).toBeLessThan(1.5)
})
