/**
 * Remembered sizes of the app's side panels (session sidebar, assistant, files, the fleet answer
 * column), per machine. A view preference like the theme, so it lives in localStorage; a missing
 * or unreadable value falls back to the default.
 */
const KEY = 'hopline.panelSizes'

type Sizes = Record<string, number>

function read(): Sizes {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Sizes) : {}
  } catch {
    return {}
  }
}

/** The saved pixel size of a panel, clamped to its limits; `fallback` when none was saved. */
export function panelSize(id: string, fallback: number, min: number, max: number): number {
  const v = read()[id]
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
}

/** Remember an open panel's size (a collapsed panel keeps the size it had). */
export function savePanelSize(id: string, px: number, min: number): void {
  if (!(px >= min)) return
  try {
    const all = read()
    if (all[id] === Math.round(px)) return
    all[id] = Math.round(px)
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // Storage full or blocked: sizes are a convenience.
  }
}

const RESET_EVENT = 'hopline:panel-sizes-reset'

/** Forget every remembered size; open panels go back to their default size at once. */
export function resetPanelSizes(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Blocked storage: nothing was saved either.
  }
  window.dispatchEvent(new Event(RESET_EVENT))
}

/** Run `fn` when the sizes are reset; returns the unsubscribe. */
export function onPanelSizesReset(fn: () => void): () => void {
  window.addEventListener(RESET_EVENT, fn)
  return () => window.removeEventListener(RESET_EVENT, fn)
}
