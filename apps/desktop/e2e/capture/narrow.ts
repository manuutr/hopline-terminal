/**
 * Narrow-window helpers for the permanent round-2 captures (`narrow-*.capture.shots.ts`).
 * Each surface is shot at 1100×700 and 900×640 with the AI panel open and a split, in both themes,
 * and must pass `assertFits`: no horizontal overflow inside the surface and no zero-width text.
 */
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, sizeWindow } from '../fixtures'

export const OUT = process.env['HOPLINE_SHOTS_OUT'] ?? join(__dirname, '../../../../docs/design/screens')
export const NARROW = [
  { w: 1100, h: 700 },
  { w: 900, h: 640 }
] as const

export async function sizeTo(app: ElectronApplication, page: Page, w: number, h: number): Promise<void> {
  await sizeWindow(app, page, w, h)
  await page.waitForTimeout(250)
}

export async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('hopline.theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
    document.documentElement.style.colorScheme = t
    window.dispatchEvent(new CustomEvent('hopline:theme', { detail: t }))
  }, theme)
}

/** Screenshot in both themes as `<name>-<w>-<theme>.png`; leaves the app in dark. */
export async function snapNarrow(page: Page, name: string, w: number): Promise<void> {
  await page.waitForTimeout(300)
  for (const t of ['dark', 'light'] as const) {
    await setTheme(page, t)
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(OUT, `${name}-${w}-${t}.png`) })
  }
  await setTheme(page, 'dark')
}

/**
 * The layout contract for a narrow surface. Returns the offenders so a failure names them.
 * - The surface is inside the window (both axes) and nothing between it and <body> is scrolled sideways
 *   (an auto-focused input must not drag its pane).
 * - No descendant that is not a deliberate scroller (overflow-x auto/scroll) or clip spills out of its box.
 * - Text never collapses: an element with its own text keeps ≥ 2 px, and ≥ 16 px if its text is longer
 *   than two characters and clipped (ellipsis on a readable stub is fine; "…" alone is not).
 * - Flex/grid children never overlap each other (the Transfers header over Download).
 */
export async function fitProblems(surface: Locator): Promise<string[]> {
  return surface.evaluate((root) => {
    const out: string[] = []
    const label = (el: Element) => {
      const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
      return `<${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? ` aria-label="${el.getAttribute('aria-label')}"` : ''}> "${t}"`
    }
    const shown = (el: Element) => {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
      const r = el.getBoundingClientRect()
      return r.width > 0 || r.height > 0
    }
    const r0 = root.getBoundingClientRect()
    if (r0.right > innerWidth + 1 || r0.left < -1 || r0.bottom > innerHeight + 1 || r0.top < -1)
      out.push(`surface is outside the window: x ${Math.round(r0.left)}..${Math.round(r0.right)} of ${innerWidth}, y ${Math.round(r0.top)}..${Math.round(r0.bottom)} of ${innerHeight}`)
    if (root.scrollWidth > root.clientWidth + 1 && !/auto|scroll/.test(getComputedStyle(root).overflowX)) out.push(`surface overflows: ${root.scrollWidth} > ${root.clientWidth}`)
    for (let p: Element | null = root; p; p = p.parentElement) if (p.scrollLeft > 0) out.push(`scrolled sideways by ${p.scrollLeft}px: ${label(p)}`)
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (!shown(el)) continue
      // Monaco and xterm draw their own canvases and manage their own scroll.
      if (el.closest('.monaco-editor, .xterm, [data-allow-overflow]')) continue
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const ox = cs.overflowX
      if (!/auto|scroll|hidden|clip/.test(ox) && cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2)
        out.push(`overflows (${el.scrollWidth} > ${el.clientWidth}): ${label(el)}`)
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent ?? '').trim())
        .join('')
      if (own.length > 0 && r.height > 0) {
        if (r.width < 2) out.push(`zero-width text (${r.width.toFixed(1)} px): ${label(el)}`)
        else if (own.length > 2 && r.width < 16 && el.scrollWidth > el.clientWidth + 1) out.push(`text truncated to nothing (${r.width.toFixed(1)} px): ${label(el)}`)
      }
      if (cs.display.includes('flex') || cs.display.includes('grid')) {
        const kids = Array.from(el.children).filter((k) => shown(k) && !/absolute|fixed/.test(getComputedStyle(k).position))
        for (let i = 0; i < kids.length; i++)
          for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i]!.getBoundingClientRect()
            const b = kids[j]!.getBoundingClientRect()
            const ox2 = Math.min(a.right, b.right) - Math.max(a.left, b.left)
            const oy2 = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
            if (ox2 > 2 && oy2 > 2) out.push(`overlap ${Math.round(ox2)}×${Math.round(oy2)}: ${label(kids[i]!)} / ${label(kids[j]!)}`)
          }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls horizontally: ${document.documentElement.scrollWidth} > ${innerWidth}`)
    return Array.from(new Set(out)).slice(0, 25)
  })
}

export async function assertFits(surface: Locator): Promise<void> {
  expect(await fitProblems(surface)).toEqual([])
}
