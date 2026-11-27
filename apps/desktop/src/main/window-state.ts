import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * Window size, position, maximised state and zoom, remembered per display setup: a laptop on its
 * own and the same laptop docked to two monitors each get their own placement back. Never read or
 * written under HOPLINE_HIDDEN (tests place the window off-screen on purpose).
 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: Rect
  maximized: boolean
  /** Chromium zoom level (0 is 100 %). */
  zoom: number
}

const RectSchema = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).strict()
const StateSchema = z.object({ bounds: RectSchema, maximized: z.boolean(), zoom: z.number().min(-8).max(9) }).strict()
const FileSchema = z.object({ v: z.literal(1), setups: z.record(z.string().max(512), StateSchema) }).strict()
type StateFile = z.infer<typeof FileSchema>

/** At most this many display setups are kept (the most recently used win). */
const MAX_SETUPS = 8

/** A stable key for the connected displays (their positions and sizes, in any order). */
export function displayKey(displays: readonly { bounds: Rect }[]): string {
  return displays
    .map((d) => `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`)
    .sort()
    .join('|')
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/**
 * Where to put the window, from what was saved: on the display it overlaps most, shrunk to that
 * display's work area and moved inside it. Null (the default size, centred) when nothing was saved
 * or less than 100×60 px of it would be on any display now.
 */
export function restoreBounds(saved: WindowState | undefined, workAreas: readonly Rect[], min: { width: number; height: number }): WindowState | null {
  if (!saved || !workAreas.length) return null
  const best = workAreas.map((wa) => ({ wa, area: overlap(saved.bounds, wa) })).sort((a, b) => b.area - a.area)[0]!
  const b = saved.bounds
  const visible = Math.min(b.width, best.wa.width) >= 100 && Math.min(b.height, best.wa.height) >= 60 && best.area >= 100 * 60
  if (!visible) return null
  const wa = best.wa
  const width = Math.max(Math.min(b.width, wa.width), Math.min(min.width, wa.width))
  const height = Math.max(Math.min(b.height, wa.height), Math.min(min.height, wa.height))
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)
  return { bounds: { x, y, width, height }, maximized: saved.maximized, zoom: saved.zoom }
}

export function readStateFile(path: string): StateFile {
  try {
    const r = FileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (r.success) return r.data
  } catch {
    // Missing or unreadable: start fresh.
  }
  return { v: 1, setups: {} }
}

/** The file with this setup's state put first (most recent), trimmed to MAX_SETUPS. */
export function withState(file: StateFile, key: string, state: WindowState): StateFile {
  const rest = Object.entries(file.setups).filter(([k]) => k !== key)
  return { v: 1, setups: Object.fromEntries([[key, state], ...rest].slice(0, MAX_SETUPS)) }
}

export async function writeStateFile(path: string, file: StateFile): Promise<void> {
  await writeFile(path, JSON.stringify(file), 'utf8')
}
