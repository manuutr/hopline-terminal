import type { Locator, Page } from '@playwright/test'
import { expect, showSessions, test } from './fixtures'

/**
 * Keyboard completeness and visible focus (Phase 6 accessibility pack): Tab walks every main
 * surface with a visible focus indicator on each stop and never lands on <body>; F6 / Shift+F6
 * move between areas (the terminal keeps Tab for the device); dialogs give focus back on close.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'

interface Stop {
  what: string
  ok: boolean
  how: string
}

/** The focused element, and whether it shows that it has focus. */
const stop = (page: Page): Promise<Stop> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return { what: 'body', ok: false, how: 'focus lost' }
    const what = `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`
    // The terminal: xterm draws its own focused cursor (the helper textarea is invisible by design).
    if (el.classList.contains('xterm-helper-textarea')) return { what, ok: !!el.closest('.xterm.focus'), how: 'xterm focus cursor' }
    const look = (e: Element) => {
      // Fields fade their border in (transition-colors): read the settled look, not the first
      // frame of the transition, which still has the unfocused colour.
      for (const a of e.getAnimations()) {
        try {
          a.finish()
        } catch {
          // An infinite animation (a spinner) cannot finish; it is not a focus style.
        }
      }
      const c = getComputedStyle(e)
      return { outline: c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0 ? `${c.outlineWidth} ${c.outlineColor}` : '', shadow: c.boxShadow !== 'none' ? c.boxShadow : '', bg: c.backgroundColor, border: c.borderColor, color: c.color }
    }
    const f = look(el)
    if (f.outline) return { what, ok: true, how: `outline ${f.outline}` }
    if (f.shadow) return { what, ok: true, how: `ring ${f.shadow.slice(0, 40)}` }
    // A ring drawn by a sibling (the 24 px checkbox draws its box next to the native input).
    const sib = el.nextElementSibling
    if (sib && look(sib).outline) return { what, ok: true, how: 'peer outline' }
    // Otherwise the focused look must differ from the unfocused one: its border or fill, or its
    // field row's (focus-within: the launcher's and palette's underline).
    const p = el.parentElement
    const fp = p ? look(p) : null
    el.blur()
    const b = look(el)
    const bp = p ? look(p) : null
    el.focus({ preventScroll: true })
    const diff = (['bg', 'border', 'color'] as const).filter((k) => f[k] !== b[k])
    const pdiff = fp && bp ? (['bg', 'border', 'shadow', 'outline'] as const).filter((k) => fp[k] !== bp[k]).map((k) => `row ${k}`) : []
    const all = [...diff, ...pdiff]
    return { what, ok: all.length > 0, how: all.length ? `changes ${all.join(', ')}` : 'no visible change' }
  })

/** Press Tab n times; every stop must show focus and stay inside `within` (if given). */
async function walk(page: Page, n: number, within?: Locator): Promise<Stop[]> {
  const stops: Stop[] = []
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab')
    const s = await stop(page)
    stops.push(s)
    if (within) expect(await within.evaluate((w) => w.contains(document.activeElement)), `Tab ${i + 1} left the dialog: ${s.what}`).toBe(true)
  }
  const bad = stops.filter((s) => !s.ok).map((s) => `${s.what}: ${s.how}`)
  expect(bad, 'focus stops without a visible indicator').toEqual([])
  return stops
}

test('focus walk: the empty window, the sidebar and the palette show focus on every stop', async ({ hop }) => {
  const { page } = hop
  await page.locator('#session-search').focus()
  const stops = await walk(page, 30)
  // The walk reaches the tree, the dividers and the launcher.
  expect(stops.some((s) => s.what.includes('role=tree'))).toBe(true)
  expect(stops.some((s) => s.what.includes('role=separator'))).toBe(true)

  await page.keyboard.press(`${mod}+K`)
  const palette = page.getByRole('dialog', { name: /palette/i }).or(page.locator('[role=dialog]:has([cmdk-input])'))
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeFocused()
  await walk(page, 3, palette.first())
  await page.keyboard.press('Escape')
  // Focus came back (never <body>).
  expect((await stop(page)).what).not.toBe('body')
})

test('focus walk in dialogs: settings, session dialog; focus is kept inside and given back on close', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const term = page.locator('.xterm-helper-textarea').first()
  await expect(term).toBeFocused()

  await page.keyboard.press(`${mod}+Comma`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await walk(page, 45, settings)
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(term).toBeFocused()

  // Opened from the palette (whose input is gone by the time it closes): back to the terminal.
  await page.keyboard.press(`${mod}+K`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('>New session')
  await page.keyboard.press('Enter')
  const dlg = page.getByRole('dialog', { name: 'New session' })
  await expect(dlg).toBeVisible()
  await walk(page, 25, dlg)
  await page.keyboard.press('Escape')
  await expect(dlg).toBeHidden()
  await expect(term).toBeFocused()

  // Every action is reachable from the keyboard: the palette lists the ones without a key.
  await page.keyboard.press(`${mod}+K`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('>Open audit log')
  await page.keyboard.press('Enter')
  const audit = page.getByRole('dialog', { name: 'AI audit log' })
  await expect(audit).toBeVisible()
  await walk(page, 8, audit)
  await page.keyboard.press('Escape')
  await expect(term).toBeFocused()
})

test('F6 leaves the terminal (Tab belongs to the device) and Shift+F6 comes back; the toolbar, open connections and assistant are reachable', async ({ hop }) => {
  const { page } = hop
  await hop.connect('core-sw1')
  const term = page.locator('.xterm-helper-textarea').first()
  await expect(term).toBeFocused()
  // Tab goes to the device: focus stays in the terminal.
  await page.keyboard.press('Tab')
  await expect(term).toBeFocused()

  await page.keyboard.press(`${mod}+I`)
  await expect(page.locator('aside[aria-label=Assistant]')).toBeVisible()
  await term.focus()
  await page.keyboard.press('F6')
  // Next after the terminal: the assistant panel.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside[aria-label=Assistant]'))).toBe(true)
  await walk(page, 6)
  await page.keyboard.press('F6')
  // Wrap to the toolbar, then reach the active connection in the sidebar.
  await expect(page.getByRole('button', { name: 'Toggle session sidebar' })).toBeFocused()
  await page.keyboard.press('F6')
  await expect(page.getByRole('tab', { selected: true })).toBeFocused()
  expect((await stop(page)).ok).toBe(true)
  await page.keyboard.press('Shift+F6')
  await expect(page.getByRole('button', { name: 'Toggle session sidebar' })).toBeFocused()
  await page.keyboard.press('Shift+F6')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside[aria-label=Assistant]'))).toBe(true)
  await page.keyboard.press('Shift+F6')
  await expect(term).toBeFocused()

  // The sessions sidebar joins the cycle when it is open.
  await showSessions(page)
  await term.focus()
  await page.keyboard.press('Shift+F6')
  await expect(page.locator('#session-search')).toBeFocused()

  // The focused tab closes with Delete (its x is pointer-only), through the usual confirm.
  await page.getByRole('tab', { selected: true }).focus()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog', { name: 'Close core-sw1?' })).toBeVisible()
  await page.keyboard.press('Escape')
})
