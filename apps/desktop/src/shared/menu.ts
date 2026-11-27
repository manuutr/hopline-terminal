/**
 * The application menu as data (docs/guide/menus.md). One tree, two renderers:
 *
 * - macOS: main builds the native menu bar from it (`buildTemplate`, main/menu.ts).
 * - Windows and Linux: the renderer draws the compact in-app menu bar from it (features/menu).
 *
 * The tree holds only command ids, roles and structure. Everything else about a command (its menu
 * label, whether it is available, checked, and its keys) comes from the renderer's action registry
 * (lib/actions.ts), the same registry the command palette and the keymap use, so the three can
 * never drift. `test/menu.test.ts` fails when an id here is not a registered action.
 *
 * Pure: no DOM, no Electron. Main and the renderer both import it.
 */

/** Native roles, used only by the macOS menu bar (they keep text fields' undo, copy and paste working). */
export type MenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'services' | 'hide' | 'hideOthers' | 'unhide' | 'quit' | 'minimize' | 'zoom' | 'front'

/** Where an entry appears. */
export type MenuOnly = 'mac' | 'other'

export type MenuNode =
  | { type: 'separator'; only?: MenuOnly }
  /** A command from the registry. On macOS `role` replaces it with the native item. */
  | { type: 'command'; id: string; role?: MenuRole; only?: MenuOnly; dev?: true }
  /** A native item with no command (macOS only: Services, Hide, Quit). */
  | { type: 'role'; role: MenuRole; label: string }
  | { type: 'submenu'; label: string; items: MenuNode[]; only?: MenuOnly }
  /** Filled at build time: recent sessions (File) or the open tabs (Window). */
  | { type: 'dynamic'; list: 'recent' | 'tabs' }

export interface MenuTop {
  /** Stable id (e2e, the in-app bar's data attributes). */
  id: string
  /** Label with an `&` before the mnemonic letter. */
  label: string
  items: MenuNode[]
  only?: MenuOnly
}

const cmd = (id: string, extra: Partial<Extract<MenuNode, { type: 'command' }>> = {}): MenuNode => ({ type: 'command', id, ...extra })
const sep = (only?: MenuOnly): MenuNode => (only ? { type: 'separator', only } : { type: 'separator' })

export const MENU: readonly MenuTop[] = [
  {
    id: 'app',
    label: 'Hopline Terminal',
    only: 'mac',
    items: [
      cmd('app.about'),
      sep(),
      cmd('app.settings'),
      cmd('app.checkUpdates'),
      sep(),
      { type: 'role', role: 'services', label: 'Services' },
      sep(),
      { type: 'role', role: 'hide', label: 'Hide Hopline Terminal' },
      { type: 'role', role: 'hideOthers', label: 'Hide others' },
      { type: 'role', role: 'unhide', label: 'Show all' },
      sep(),
      { type: 'role', role: 'quit', label: 'Quit Hopline Terminal' }
    ]
  },
  {
    id: 'file',
    label: '&File',
    items: [
      cmd('session.quickConnect'),
      cmd('session.switcher'),
      cmd('session.new'),
      cmd('session.newFolder'),
      sep(),
      { type: 'submenu', label: 'Open &recent', items: [{ type: 'dynamic', list: 'recent' }, sep(), cmd('session.clearRecent')] },
      {
        type: 'submenu',
        label: '&Import sessions',
        items: [cmd('import.securecrt'), cmd('import.mobaxterm'), cmd('import.putty'), cmd('import.sshConfig'), cmd('import.csv'), cmd('import.netbox')]
      },
      cmd('session.export'),
      sep(),
      cmd('terminal.saveOutput'),
      sep(),
      cmd('pane.close'),
      cmd('tab.close'),
      cmd('tab.reopen'),
      cmd('window.close'),
      sep('other'),
      cmd('app.settings', { only: 'other' }),
      sep('other'),
      cmd('app.quit', { only: 'other' })
    ]
  },
  {
    id: 'edit',
    label: '&Edit',
    items: [
      cmd('edit.undo', { role: 'undo' }),
      cmd('edit.redo', { role: 'redo' }),
      sep(),
      cmd('edit.cut', { role: 'cut' }),
      cmd('edit.copy', { role: 'copy' }),
      cmd('edit.paste', { role: 'paste' }),
      cmd('edit.pasteToDevice'),
      cmd('edit.selectAll'),
      cmd('terminal.copyAll'),
      cmd('workspace.noteSelection'),
      sep(),
      cmd('terminal.find'),
      cmd('edit.findNext'),
      cmd('edit.findPrev'),
      cmd('terminal.findAll'),
      sep(),
      cmd('terminal.clear')
    ]
  },
  {
    id: 'view',
    label: '&View',
    items: [
      cmd('palette.open'),
      cmd('workspace.overview'),
      cmd('workspace.scratchpad'),
      sep(),
      cmd('view.sidebar'),
      cmd('ai.toggle'),
      cmd('view.buttonBar'),
      sep(),
      cmd('pane.splitRight'),
      cmd('pane.splitDown'),
      cmd('pane.zoom'),
      cmd('pane.focusNext'),
      cmd('pane.focusPrev'),
      sep(),
      cmd('view.zoomIn'),
      cmd('view.zoomOut'),
      cmd('view.zoomReset'),
      cmd('view.fullScreen'),
      sep(),
      { type: 'submenu', label: '&Theme', items: [cmd('view.theme.dark'), cmd('view.theme.light'), cmd('view.theme.contrast'), cmd('view.theme.system')] },
      cmd('terminal.highlight'),
      sep(),
      cmd('a11y.screenReader'),
      cmd('a11y.bufferView')
    ]
  },
  {
    id: 'session',
    label: '&Session',
    items: [
      cmd('session.reconnect'),
      cmd('session.duplicate'),
      cmd('session.overrides'),
      sep(),
      cmd('terminal.sendBreak'),
      sep(),
      cmd('files.toggle'),
      cmd('packets.open'),
      cmd('forwards.open'),
      sep(),
      cmd('multi.send'),
      cmd('multi.run'),
      cmd('multi.lastResults'),
      cmd('snippets.run'),
      sep(),
      cmd('backups.takeActive'),
      cmd('backups.open'),
      sep(),
      cmd('ai.readOnly')
    ]
  },
  {
    id: 'ai',
    label: '&AI',
    items: [cmd('ai.focus'), cmd('ai.explainSelection'), cmd('fleet.investigate'), sep(), cmd('egress.open'), cmd('ai.settings')]
  },
  {
    id: 'window',
    label: '&Window',
    items: [
      cmd('window.minimize', { role: 'minimize' }),
      cmd('window.zoom', { role: 'zoom' }),
      sep(),
      cmd('tab.next'),
      cmd('tab.prev'),
      sep(),
      { type: 'dynamic', list: 'tabs' },
      sep('mac'),
      { type: 'role', role: 'front', label: 'Bring all to front' }
    ]
  },
  {
    id: 'help',
    label: '&Help',
    items: [
      cmd('help.tour'),
      cmd('help.guide'),
      cmd('app.shortcuts'),
      cmd('help.releaseNotes'),
      cmd('help.reportIssue'),
      sep(),
      cmd('audit.open'),
      cmd('help.logsFolder'),
      cmd('help.devTools', { dev: true }),
      sep('other'),
      cmd('app.about', { only: 'other' })
    ]
  }
]

/** Commands that take an argument, filled in by the dynamic lists. */
export const ARG_COMMANDS = ['session.openRecent', 'tab.activate'] as const

/** Every command id in the tree (and the dynamic lists): the only ids a menu may send. */
export const MENU_COMMANDS: ReadonlySet<string> = (() => {
  const out = new Set<string>(ARG_COMMANDS)
  const walk = (items: readonly MenuNode[]) => {
    for (const n of items) {
      if (n.type === 'command') out.add(n.id)
      else if (n.type === 'submenu') walk(n.items)
    }
  }
  for (const t of MENU) walk(t.items)
  return out
})()

/**
 * Commands main carries out itself (the window, the app, the help links). The renderer's actions
 * for them call `app:command` with the id; nothing else ever reaches main from a menu, and the
 * help links are fixed here, never a URL from the renderer.
 */
export const MAIN_COMMANDS = [
  'app.quit',
  'window.minimize',
  'window.zoom',
  'window.close',
  'view.fullScreen',
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomReset',
  'help.guide',
  'help.releaseNotes',
  'help.reportIssue',
  'help.logsFolder',
  'help.devTools'
] as const
export type MainCommand = (typeof MAIN_COMMANDS)[number]

const REPO = 'https://github.com/manuutr/hopline-terminal'
export const HELP_URLS: Record<'help.guide' | 'help.releaseNotes' | 'help.reportIssue', string> = {
  'help.guide': `${REPO}/tree/main/docs/guide`,
  'help.releaseNotes': `${REPO}/blob/main/CHANGELOG.md`,
  'help.reportIssue': `${REPO}/issues/new/choose`
}

/** What the renderer knows about one command right now (display only: running it re-checks). */
export interface MenuItemState {
  /** Menu label, `&` before the mnemonic. */
  label: string
  enabled: boolean
  /** Set for checkbox and radio items. */
  checked?: boolean
  kind?: 'checkbox' | 'radio'
  /** The user's first key for it ("Mod+K"), if any. */
  keys?: string
}

/** The renderer's view of the menu, sent to main for the native menu, the dock and the jump list. */
export interface MenuSnapshot {
  items: Record<string, MenuItemState>
  /** Recent sessions, most recent first (at most 10). */
  recent: { id: string; label: string }[]
  /** Open tabs in order (at most 50). */
  tabs: { id: string; label: string; active: boolean }[]
}

export const MAX_RECENT = 10
export const MAX_TABS = 50

/** A plain menu item, ready for Electron's `Menu.buildFromTemplate` once main adds the click handlers. */
export interface TemplateItem {
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  label?: string
  role?: MenuRole
  accelerator?: string
  enabled?: boolean
  checked?: boolean
  submenu?: TemplateItem[]
  /** What a click sends to the renderer. */
  command?: { id: string; arg?: string }
}

/** "&File" → "File" (macOS shows no mnemonics). `&&` is a literal ampersand. */
export const stripMnemonic = (label: string): string => label.replace(/&(&?)/g, (_, amp: string) => amp)

/** The mnemonic letter of a label ("Open &recent" → "r"), lower case, or undefined. */
export function mnemonicOf(label: string): string | undefined {
  const m = /&([^&])/.exec(label.replace(/&&/g, ''))
  return m?.[1]?.toLowerCase()
}

const ELECTRON_KEY: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Esc',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
  '+': 'Plus'
}

/** "Mod+Shift+K" → an Electron accelerator ("Cmd+Shift+K" on macOS, "Ctrl+Shift+K" elsewhere). */
export function toAccelerator(combo: string, mac: boolean): string {
  const raw = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  const key = raw.at(-1)!
  const mods = new Set(raw.slice(0, -1))
  const out: string[] = []
  if (mods.has('Ctrl') || (mods.has('Mod') && !mac)) out.push('Ctrl')
  if (mods.has('Alt')) out.push('Alt')
  if (mods.has('Shift') || (mods.has('Mod') && !mac)) out.push('Shift')
  if (mods.has('Meta') || (mods.has('Mod') && mac)) out.push(mac ? 'Cmd' : 'Super')
  out.push(ELECTRON_KEY[key] ?? (key.length === 1 ? key.toUpperCase() : key))
  return out.join('+')
}

const visible = (only: MenuOnly | undefined, mac: boolean) => !only || (only === 'mac') === mac

/** Drop leading, trailing and doubled separators (a hidden item can leave two in a row). */
export function tidy<T extends { type?: string }>(items: T[]): T[] {
  const out: T[] = []
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out.at(-1)!.type === 'separator')) continue
    out.push(it)
  }
  while (out.at(-1)?.type === 'separator') out.pop()
  return out
}

/**
 * The native menu template for a platform. Pure: given the tree and the renderer's snapshot, the
 * same template every time. Before the renderer has sent a snapshot, only the native roles show
 * (app menu, Edit's undo/copy/paste, Window), so ⌘Q and ⌘C work from the first frame.
 *
 * Keys are shown as the accelerator. On macOS the renderer handles the key first and stops it
 * (lib/actions › dispatchKey), so the menu's own shortcut only fires when the page did not take the
 * key, and then goes through the same gate (`runAction`): one owner either way.
 */
export function buildTemplate(snapshot: MenuSnapshot | null, opts: { mac: boolean; dev: boolean; tree?: readonly MenuTop[] }): TemplateItem[] {
  const { mac, dev } = opts
  const label = (l: string) => (mac ? stripMnemonic(l) : l)
  const node = (n: MenuNode): TemplateItem[] => {
    switch (n.type) {
      case 'separator':
        return visible(n.only, mac) ? [{ type: 'separator' }] : []
      case 'role':
        return mac ? [{ role: n.role, label: n.label }] : []
      case 'command': {
        if (!visible(n.only, mac) || (n.dev && !dev)) return []
        if (mac && n.role) return [{ role: n.role }]
        const s = snapshot?.items[n.id]
        if (!s) return []
        const item: TemplateItem = { label: label(s.label), enabled: s.enabled, command: { id: n.id } }
        if (s.kind) (item.type = s.kind), (item.checked = !!s.checked)
        if (s.keys) item.accelerator = toAccelerator(s.keys, mac)
        return [item]
      }
      case 'submenu': {
        if (!visible(n.only, mac)) return []
        const sub = tidy(n.items.flatMap(node))
        return sub.some((x) => x.type !== 'separator') ? [{ type: 'submenu', label: label(n.label), submenu: sub }] : []
      }
      case 'dynamic': {
        if (!snapshot) return []
        if (n.list === 'recent') {
          if (!snapshot.recent.length) return [{ label: 'No recent sessions', enabled: false }]
          return snapshot.recent.slice(0, MAX_RECENT).map((r) => ({ label: r.label, command: { id: 'session.openRecent', arg: r.id } }))
        }
        return snapshot.tabs.slice(0, MAX_TABS).map((t) => ({ type: 'checkbox', label: t.label, checked: t.active, command: { id: 'tab.activate', arg: t.id } }))
      }
    }
  }
  return (opts.tree ?? MENU)
    .filter((t) => visible(t.only, mac))
    .map((t): TemplateItem => ({ type: 'submenu', label: label(t.label), submenu: tidy(t.items.flatMap(node)) }))
    .filter((t) => t.submenu!.length > 0)
}

/** The macOS dock menu: a new window and the recent sessions. */
export function buildDockTemplate(snapshot: MenuSnapshot | null): TemplateItem[] {
  const recent = (snapshot?.recent ?? []).slice(0, MAX_RECENT).map((r): TemplateItem => ({ label: r.label, command: { id: 'session.openRecent', arg: r.id } }))
  return tidy([{ label: 'New window', command: { id: 'window.new' } }, { type: 'separator' }, ...recent])
}
