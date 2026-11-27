/**
 * The menu tree (shared/menu.ts) resolved against the action registry: what the in-app menu bar
 * draws and what main gets for the native macOS menu, the dock and the jump list. Both come from
 * here, so the two can't differ.
 */
import { ARG_COMMANDS, MAX_TABS, MENU, MENU_COMMANDS, type MenuNode, type MenuSnapshot, type MenuItemState, tidy } from '@shared/menu'
import { available, getAction, keysOf, menuLabelOf, menuOf, runAction, subscribeActions, useKeymap } from '../../lib/actions'
import { findPane } from '../../lib/layout'
import { useUi } from '../../store'
import { useMulti } from '../multi/store'
import { useFiles } from '../files/store'
import { useSnippets } from '../snippets/store'
import { useTrust } from '../trust/store'
import { recentSessions, useRecent } from './recent'

export type UiNode =
  | { type: 'separator' }
  | { type: 'item'; id: string; arg?: string; label: string; enabled: boolean; checked?: boolean; kind?: 'checkbox' | 'radio'; keys?: string }
  | { type: 'submenu'; label: string; items: UiNode[] }

export interface UiMenu {
  id: string
  label: string
  items: UiNode[]
}

/** One command's state now, or undefined when it is not registered (a feature not loaded). */
export function itemState(id: string): MenuItemState | undefined {
  const a = getAction(id)
  if (!a) return undefined
  const meta = menuOf(a)
  const s: MenuItemState = { label: menuLabelOf(a), enabled: available(a) }
  if (meta?.kind) (s.kind = meta.kind), (s.checked = !!meta.checked?.())
  const k = keysOf(a)[0]
  if (k) s.keys = k
  return s
}

/** "&" in a session or tab name is literal, not a mnemonic. */
const literal = (s: string) => s.replace(/&/g, '&&')

function tabList(): { id: string; label: string; active: boolean }[] {
  const s = useUi.getState()
  return s.workspaces.slice(0, MAX_TABS).map((ws) => {
    const tabId = findPane(ws.root, ws.focusedPaneId)?.tabId
    const title = s.tabs.find((t) => t.tabId === tabId)?.title ?? 'Connect to…'
    return { id: ws.id, label: title.slice(0, 120), active: ws.id === s.activeWsId }
  })
}

/** The menu bar's menus for this platform (the in-app bar passes mac = false). */
export function resolveMenu(mac: boolean, dev: boolean): UiMenu[] {
  const visible = (only?: 'mac' | 'other') => !only || (only === 'mac') === mac
  const node = (n: MenuNode): UiNode[] => {
    switch (n.type) {
      case 'separator':
        return visible(n.only) ? [{ type: 'separator' }] : []
      case 'role':
        return []
      case 'command': {
        if (!visible(n.only) || (n.dev && !dev)) return []
        const s = itemState(n.id)
        if (!s) return []
        const a = getAction(n.id)!
        const hint = s.keys ?? menuOf(a)?.hint
        return [{ type: 'item', id: n.id, ...s, ...(hint ? { keys: hint } : {}) }]
      }
      case 'submenu': {
        if (!visible(n.only)) return []
        const items = tidy(n.items.flatMap(node))
        return items.some((x) => x.type !== 'separator') ? [{ type: 'submenu', label: n.label, items }] : []
      }
      case 'dynamic': {
        if (n.list === 'recent') {
          const list = recentSessions(useUi.getState().sessions)
          if (!list.length) return [{ type: 'item', id: 'session.openRecent', label: 'No recent sessions', enabled: false }]
          return list.map((s) => ({ type: 'item', id: 'session.openRecent', arg: s.id, label: literal(s.name), enabled: true }))
        }
        return tabList().map((t) => ({ type: 'item', id: 'tab.activate', arg: t.id, label: literal(t.label), enabled: true, kind: 'radio', checked: t.active }))
      }
    }
  }
  return MENU.filter((t) => visible(t.only))
    .map((t) => ({ id: t.id, label: t.label, items: tidy(t.items.flatMap(node)) }))
    .filter((t) => t.items.length > 0)
}

/** What main needs for the native menu, the dock and the jump list. */
export function snapshot(): MenuSnapshot {
  const items: MenuSnapshot['items'] = {}
  for (const id of MENU_COMMANDS) {
    if ((ARG_COMMANDS as readonly string[]).includes(id)) continue
    const s = itemState(id)
    if (s) items[id] = s
  }
  return {
    items,
    recent: recentSessions(useUi.getState().sessions).map((s) => ({ id: s.id, label: s.name.slice(0, 120) })),
    tabs: tabList()
  }
}

/** A command a native menu, the dock or the jump list sent: only ids the menu has, through the same gate. */
export function runMenuCommand(c: { id?: unknown; arg?: unknown }): boolean {
  if (typeof c?.id !== 'string' || !MENU_COMMANDS.has(c.id)) return false
  const arg = typeof c.arg === 'string' && c.arg.length <= 64 ? c.arg : undefined
  if ((ARG_COMMANDS as readonly string[]).includes(c.id) && !arg) return false
  return runAction(c.id, arg)
}

let wired = false
/** Keep main's copy of the menu current and run what it sends back. */
export function wireMenu(): () => void {
  if (wired || !window.hopline?.menu) return () => {}
  wired = true
  let timer = 0
  let sent = ''
  const push = () => {
    timer = 0
    if (!useUi.getState().settings) return
    const snap = snapshot()
    const json = JSON.stringify(snap)
    if (json === sent) return
    sent = json
    void window.hopline.menu.setState(snap).catch(() => {})
  }
  const schedule = () => {
    if (!timer) timer = window.setTimeout(push, 150)
  }
  const offs = [
    useUi.subscribe(schedule),
    useKeymap.subscribe(schedule),
    useRecent.subscribe(schedule),
    useSnippets.subscribe(schedule),
    useFiles.subscribe(schedule),
    useMulti.subscribe((s, prev) => { if (s.open !== prev.open || s.step !== prev.step) schedule() }),
    useTrust.subscribe(schedule),
    subscribeActions(schedule),
    window.hopline.menu.onCommand((c) => void runMenuCommand(c))
  ]
  // e2e only: deliver a command the way a native menu click does.
  if (window.hopline.testMode) (window as unknown as { __hoplineMenu?: typeof runMenuCommand }).__hoplineMenu = runMenuCommand
  const onTheme = () => schedule()
  window.addEventListener('hopline:theme', onTheme)
  schedule()
  return () => {
    window.clearTimeout(timer)
    for (const off of offs) off()
    window.removeEventListener('hopline:theme', onTheme)
    wired = false
  }
}
