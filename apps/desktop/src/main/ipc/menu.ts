import { z } from 'zod'
import { MAIN_COMMANDS, MAX_RECENT, MAX_TABS, MENU_COMMANDS, type MainCommand, type MenuSnapshot } from '@shared/menu'
import type { AppInfo } from '@shared/types'
import { handler as h, registerAll, type Handler } from '.'

/**
 * The application menu's channels (docs/guide/menus.md).
 *
 * - `menu:state`: the renderer's view of the menu, for the native macOS menu, the dock and the
 *   jump list. Display only (labels, enabled, checked, keys): a click sends the command id back to
 *   the renderer, which checks it again and runs it through the same gate as a key press.
 * - `app:command`: the few things only main can do (window, zoom, help links, quit), by id from a
 *   fixed list. No string from the renderer is ever run, opened or used as a path.
 * - `app:info`: versions for Help › About.
 * - `app:saveOutput`: File › Save output as… The path comes from main's own save dialog.
 */
const noControl = /^[^\u0000-\u001f\u007f]*$/
const label = z.string().min(1).max(120).regex(noControl)
const id = z.string().min(1).max(64).regex(/^[\w.-]+$/)
/** A key as the keymap stores it ("Mod+Shift+K", "Ctrl+PageDown", "F6", "Mod+,"). */
const keys = z.string().min(1).max(40).regex(/^[\w+,./;'[\]\\`=-]+$/)

const ItemState = z
  .object({
    label,
    enabled: z.boolean(),
    checked: z.boolean().optional(),
    kind: z.enum(['checkbox', 'radio']).optional(),
    keys: keys.optional()
  })
  .strict()

export const MenuSnapshotSchema = z
  .object({
    items: z.partialRecord(z.enum([...MENU_COMMANDS] as [string, ...string[]]), ItemState),
    recent: z.array(z.object({ id, label }).strict()).max(MAX_RECENT),
    tabs: z.array(z.object({ id, label, active: z.boolean() }).strict()).max(MAX_TABS)
  })
  .strict()

export const MainCommandSchema = z.enum(MAIN_COMMANDS)

/** A file name only (no folder): the save dialog's suggestion. */
export const SaveOutput = z
  .object({
    name: z.string().min(1).max(120).regex(/^[^/\\:*?"<>|\u0000-\u001f]+$/),
    // A full scrollback with long lines; far beyond what a terminal holds.
    text: z.string().max(32 * 1024 * 1024)
  })
  .strict()

export interface MenuDeps {
  /** A window sent a new snapshot. */
  snapshot(s: MenuSnapshot, sender: Electron.WebContents): void
  command(id: MainCommand, sender: Electron.WebContents): void | Promise<void>
  info(): AppInfo
  /** Main's save dialog; null when cancelled. */
  savePath(name: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
}

export function menuHandlers(deps: MenuDeps): Record<string, Handler> {
  return {
    'menu:state': h(MenuSnapshotSchema, (s, e) => void deps.snapshot(s as MenuSnapshot, e.sender)),
    'app:command': h(MainCommandSchema, (cmd, e) => deps.command(cmd, e.sender)),
    'app:info': h({ parse: (): undefined => undefined }, () => deps.info()),
    'app:saveOutput': h(SaveOutput, async ({ name, text }) => {
      const path = await deps.savePath(name)
      if (!path) return null
      await deps.write(path, text)
      return path
    })
  }
}

export function registerMenuIpc(deps: MenuDeps): void {
  registerAll(menuHandlers(deps))
}
