import { useTrust } from '../trust/store'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Cable,
  FlaskConical,
  ListChecks,
  SlidersHorizontal,
  Columns2,
  Command as CommandIcon,
  Highlighter,
  Import,
  Keyboard,
  KeyRound,
  Maximize2,
  Moon,
  Network,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Rows2,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  X,
  Zap
} from 'lucide-react'
import { toast } from '../../lib/notify'
import { toggleTheme } from '../../design/theme'
import { registerActions, type Action } from '../../lib/actions'
import { requestCloseFocusedPane, requestClosePane } from '../../lib/confirm'
import { inTerminal } from '../../lib/keys'
import { findPane, type FocusDir, type SplitDir } from '../../lib/layout'
import { terminals } from '../../lib/terminals'
import { activeSerial, toggleLine } from '../terminal/serial-lines'
import { activeTab, activeWorkspace, useUi } from '../../store'
import { openImport, resyncNetBox, useImport } from '../import/store'
import { openKnownHosts } from '../knownhosts/KnownHostsDialog'
import { openFindAll } from '../terminal/FindAll'
import { PANE_MIN } from '../terminal/TerminalArea'
import { openSettings } from '../../lib/settings-nav'
import { useOnboarding } from '../onboarding/store'
import { openLab } from '../onboarding/FirstRun'
import { openOverrides } from '../overrides/OverridesDialog'

const ui = () => useUi.getState()

/** Split the focused pane, refusing when a half would drop below 20 columns × 5 rows. */
export function trySplit(dir: SplitDir): void {
  const s = ui()
  const ws = activeWorkspace(s)
  if (!ws) return
  const tabId = findPane(ws.root, ws.focusedPaneId)?.tabId
  const term = tabId ? terminals.get(tabId)?.term : undefined
  const rect = document.querySelector(`[data-pane-id="${ws.focusedPaneId}"]`)?.getBoundingClientRect()
  const tooSmall =
    dir === 'row'
      ? term ? term.cols / 2 < 20 : !!rect && rect.width / 2 < PANE_MIN.w
      : term ? term.rows / 2 < 5 : !!rect && rect.height / 2 < PANE_MIN.h
  if (tooSmall) {
    toast(`Not enough room to split ${dir === 'row' ? 'right' : 'down'}`, { description: 'Each pane needs at least 20 columns × 5 rows. Close a pane or widen the window first.' })
    return
  }
  s.split(dir)
}

const hasTabs = () => ui().tabs.length > 0
const wsIndex = () => {
  const s = ui()
  return { list: s.workspaces, idx: s.workspaces.findIndex((w) => w.id === s.activeWsId) }
}

const focus = (dir: FocusDir, icon: Action['icon'], key: string): Action => ({
  id: `pane.focus.${dir}`,
  title: `Focus pane ${dir}`,
  category: 'Tabs and panes',
  icon,
  // Ctrl+Alt+Arrow (Warp), and Mod+Alt+Arrow for desktops that take Ctrl+Alt+Arrow (GNOME workspaces).
  keys: [`Ctrl+Alt+${key}`, `Mod+Alt+${key}`],
  palette: false,
  when: () => !!activeWorkspace(ui()),
  run: () => void ui().focusDir(dir)
})

const gotoTab = (n: number): Action => ({
  id: `tab.goto.${n}`,
  title: n === 9 ? 'Go to the last tab' : `Go to tab ${n}`,
  category: 'Tabs and panes',
  // Alt+digit (Cmd+digit on macOS). Never Ctrl+Shift+digit: Ctrl+Shift+6 is the device's.
  keys: [`Alt+${n}`, `Meta+${n}`],
  fixed: true,
  palette: false,
  when: () => !!(n === 9 ? ui().workspaces.at(-1) : ui().workspaces[n - 1]),
  run: () => {
    const list = ui().workspaces
    const t = n === 9 ? list.at(-1) : list[n - 1]
    if (t) ui().activateWs(t.id)
  }
})

export const BUILTIN_ACTIONS: Action[] = [
  // ------------------------------------------------------------ app surfaces
  {
    id: 'palette.open',
    title: 'Command palette',
    category: 'App',
    icon: CommandIcon,
    keys: ['Mod+K'],
    extraKeys: [{ combo: 'Ctrl+K', outsideTerminal: true }],
    noRepeat: true,
    palette: false,
    whileModal: () => ui().paletteOpen || ui().switcherOpen,
    run: () => ui().set({ paletteOpen: !ui().paletteOpen, switcherOpen: false })
  },
  {
    id: 'session.switcher',
    title: 'Go to session or host…',
    category: 'Sessions',
    icon: Search,
    keywords: 'switch',
    keys: ['Mod+P'],
    noRepeat: true,
    whileModal: () => ui().paletteOpen || ui().switcherOpen,
    run: () => ui().set({ switcherOpen: !ui().switcherOpen, paletteOpen: false })
  },
  { id: 'session.new', title: 'New session…', category: 'Sessions', icon: Plus, keys: ['Mod+N'], run: () => ui().set({ editing: { open: true } }) },
  {
    id: 'session.quickConnect',
    title: 'Quick connect…',
    category: 'Sessions',
    icon: Zap,
    keywords: 'ssh telnet serial host',
    keys: ['Mod+O'],
    noRepeat: true,
    whileModal: () => ui().quickOpen,
    run: () => ui().set({ quickOpen: !ui().quickOpen, paletteOpen: false, switcherOpen: false })
  },
  { id: 'session.import', title: 'Import sessions…', category: 'Sessions', icon: Import, keywords: 'securecrt mobaxterm putty ssh_config ssh config csv netbox nautobot', run: () => openImport() },
  {
    id: 'session.resyncNetbox',
    title: () => `Re-sync from ${useImport.getState().netbox?.flavor === 'nautobot' ? 'Nautobot' : 'NetBox'}`,
    category: 'Sessions',
    icon: Network,
    keywords: 'netbox nautobot resync refresh devices',
    when: () => !!useImport.getState().netbox,
    run: () => void resyncNetBox()
  },
  // ------------------------------------------------------------ tabs and panes
  { id: 'pane.splitRight', title: 'Split right', category: 'Tabs and panes', icon: Columns2, keywords: 'split pane vertical', keys: ['Mod+D'], when: hasTabs, run: () => trySplit('row') },
  { id: 'pane.splitDown', title: 'Split down', category: 'Tabs and panes', icon: Rows2, keywords: 'split pane horizontal', keys: ['Mod+E'], when: hasTabs, run: () => trySplit('column') },
  { id: 'pane.zoom', title: 'Zoom / unzoom pane', category: 'Tabs and panes', icon: Maximize2, keywords: 'maximize', keys: ['Mod+Enter'], when: hasTabs, run: () => ui().toggleZoom() },
  {
    id: 'pane.close',
    title: 'Close pane',
    category: 'Tabs and panes',
    icon: X,
    keys: ['Mod+W'],
    when: () => ui().workspaces.length > 0,
    run: (e) => {
      const ws = activeWorkspace(ui())
      if (!ws) return
      if (e) void requestClosePane(ws.focusedPaneId)
      else requestCloseFocusedPane()
    }
  },
  {
    id: 'tab.reopen',
    title: () => `Reopen ${ui().closed.at(-1)?.title ?? 'closed tab'}`,
    category: 'Tabs and panes',
    icon: RotateCcw,
    keywords: 'undo closed tab',
    keys: ['Mod+T'],
    // The key works even with nothing to reopen; the palette lists it only when there is something.
    paletteWhen: () => ui().closed.length > 0,
    run: () => ui().reopenClosed()
  },
  { id: 'tab.cycle', title: 'Recent tabs (hold Ctrl)', category: 'Tabs and panes', keys: ['Ctrl+Tab'], fixed: true, external: true, palette: false, run: () => {} },
  {
    id: 'tab.next',
    title: 'Next tab',
    category: 'Tabs and panes',
    keys: ['Ctrl+PageDown'],
    palette: false,
    when: () => ui().workspaces.length > 0,
    run: () => {
      const { list, idx } = wsIndex()
      ui().activateWs(list[(idx + 1) % list.length]!.id)
    }
  },
  {
    id: 'tab.prev',
    title: 'Previous tab',
    category: 'Tabs and panes',
    keys: ['Ctrl+PageUp'],
    palette: false,
    when: () => ui().workspaces.length > 0,
    run: () => {
      const { list, idx } = wsIndex()
      ui().activateWs(list[(idx - 1 + list.length) % list.length]!.id)
    }
  },
  {
    id: 'tab.moveLeft',
    title: 'Move tab up',
    category: 'Tabs and panes',
    keys: ['Mod+PageUp'],
    palette: false,
    when: () => !!activeWorkspace(ui()),
    run: () => {
      const { list, idx } = wsIndex()
      ui().moveWs(list[idx]!.id, idx - 1)
    }
  },
  {
    id: 'tab.moveRight',
    title: 'Move tab down',
    category: 'Tabs and panes',
    keys: ['Mod+PageDown'],
    palette: false,
    when: () => !!activeWorkspace(ui()),
    run: () => {
      const { list, idx } = wsIndex()
      ui().moveWs(list[idx]!.id, idx + 1)
    }
  },
  focus('left', ArrowLeft, 'ArrowLeft'),
  focus('right', ArrowRight, 'ArrowRight'),
  focus('up', ArrowUp, 'ArrowUp'),
  focus('down', ArrowDown, 'ArrowDown'),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(gotoTab),
  // ------------------------------------------------------------ terminal
  {
    id: 'terminal.find',
    title: 'Find in this terminal',
    category: 'Terminal',
    icon: Search,
    keys: ['Mod+F'],
    palette: false,
    run: (e) => {
      const s = ui()
      const t = s.activeTabId ? terminals.get(s.activeTabId) : undefined
      // From a menu (no key event): the terminal counts as focused when the keyboard is in its xterm.
      const el = document.activeElement
      const inTerm = e ? inTerminal(e) : !!el?.closest('.xterm')
      if (t && (inTerm || !el?.closest('input,textarea'))) t.openFind()
      else document.getElementById('session-search')?.focus()
    }
  },
  { id: 'terminal.findAll', title: 'Find in all tabs…', category: 'Terminal', icon: Search, keywords: 'search terminals scrollback', keys: ['Mod+Alt+F'], run: openFindAll },
  { id: 'terminal.copy', title: 'Copy selection', category: 'Terminal', keys: ['Mod+C'], fixed: true, external: true, palette: false, run: () => {} },
  { id: 'terminal.paste', title: 'Paste', category: 'Terminal', keys: ['Mod+V'], fixed: true, external: true, palette: false, run: () => {} },
  {
    id: 'terminal.sendBreak',
    title: 'Send break',
    category: 'Terminal',
    icon: Zap,
    keywords: 'serial console rommon password recovery telnet ssh',
    when: () => !!ui().activeTabId,
    run: () => {
      const id = ui().activeTabId
      if (id) window.hopline.term.sendBreak(id)
    }
  },
  // Serial consoles: the modem-control lines, also shown (and clickable) in the status bar.
  {
    id: 'terminal.toggleDtr',
    title: 'Toggle DTR',
    category: 'Terminal',
    icon: Cable,
    keywords: 'serial console modem data terminal ready signal',
    when: () => !!activeSerial(),
    run: () => {
      const s = activeSerial()
      if (s) toggleLine(s.tabId, 'dtr')
    }
  },
  {
    id: 'terminal.toggleRts',
    title: 'Toggle RTS',
    category: 'Terminal',
    icon: Cable,
    keywords: 'serial console modem request to send signal',
    when: () => !!activeSerial(),
    run: () => {
      const s = activeSerial()
      if (s) toggleLine(s.tabId, 'rts')
    }
  },
  {
    id: 'terminal.highlight',
    title: () => (ui().settings?.termHighlight ? 'Turn off output highlighting' : 'Turn on output highlighting'),
    category: 'Terminal',
    icon: Highlighter,
    keywords: 'colors syntax',
    run: async () => ui().setSettings(await window.hopline.settings.update({ termHighlight: !ui().settings?.termHighlight }))
  },
  { id: 'app.knownHosts', title: 'Known hosts…', category: 'Sessions', icon: KeyRound, keywords: 'ssh host keys fingerprints import', run: openKnownHosts },
  // ------------------------------------------------------------ assistant
  {
    id: 'ai.toggle',
    title: 'Toggle AI panel',
    category: 'Assistant',
    icon: PanelRight,
    keywords: 'assistant',
    keys: ['Mod+I'],
    noRepeat: true,
    run: () => ui().set({ aiOpen: !ui().aiOpen })
  },
  {
    id: 'ai.readOnly',
    title: () => (useTrust.getState().policy.locks.readOnly ? 'Read-only mode: managed by policy' : ui().settings?.aiReadOnly ? 'Turn read-only mode off (allow changes with approval)' : 'Turn read-only mode on'),
    category: 'App',
    icon: ShieldCheck,
    keywords: 'read-only readonly safety ai assistant snippets send-to-many uploads changes',
    run: async () => {
      // Locked by the team policy: say so instead of sending a change main would refuse.
      if (useTrust.getState().policy.locks.readOnly) return void toast.info('Read-only mode is managed by policy', { description: 'Your administrator turned it on. Ask them to change it.' })
      ui().setSettings(await window.hopline.settings.update({ aiReadOnly: !ui().settings?.aiReadOnly }))
    }
  },
  { id: 'egress.open', title: 'What left this machine', category: 'App', icon: ScrollText, keywords: 'egress sent requests prompts provider log trust privacy', run: () => useTrust.getState().openEgress(true) },
  { id: 'audit.open', title: 'Open audit log', category: 'App', icon: ScrollText, keywords: 'ai audit log commands history', run: () => ui().set({ auditOpen: true }) },
  // ------------------------------------------------------------ view and app
  {
    id: 'view.sidebar',
    title: 'Toggle session sidebar',
    category: 'View',
    icon: PanelLeft,
    keywords: 'sessions tree',
    keys: ['Mod+B'],
    noRepeat: true,
    run: () => ui().set({ sidebarOpen: !ui().sidebarOpen })
  },
  {
    id: 'view.theme',
    title: 'Toggle dark / light theme',
    category: 'View',
    icon: Moon,
    run: () => {
      const t = toggleTheme()
      void window.hopline.settings.update({ theme: t }).then((next) => ui().setSettings(next))
    }
  },
  { id: 'app.settings', title: 'Settings…', category: 'App', icon: Settings2, keywords: 'preferences api key', keys: ['Mod+,'], run: () => openSettings() },
  {
    id: 'app.shortcuts',
    title: 'Keyboard shortcuts',
    category: 'App',
    icon: Keyboard,
    keywords: 'cheat sheet keys help keymap',
    keys: ['Mod+/'],
    noRepeat: true,
    whileModal: () => ui().shortcutsOpen,
    run: () => ui().set({ shortcutsOpen: !ui().shortcutsOpen, paletteOpen: false })
  },
  {
    id: 'app.keymap',
    title: 'Edit keyboard shortcuts…',
    category: 'App',
    icon: Keyboard,
    keywords: 'keymap keybindings rebind',
    run: () => openSettings('keymap')
  },
  {
    id: 'session.overrides',
    title: 'Overrides for this session…',
    category: 'Sessions',
    icon: SlidersHorizontal,
    keywords: 'per host font theme keep-alive logging override',
    when: () => {
      const t = activeTab(ui())
      return !!t && ui().sessions.some((s) => s.id === t.sessionId)
    },
    run: () => {
      const t = activeTab(ui())
      if (t) openOverrides('session', t.sessionId)
    }
  },
  {
    id: 'app.gettingStarted',
    title: 'Show getting started',
    category: 'App',
    icon: ListChecks,
    keywords: 'onboarding checklist tour help first run',
    run: () => useOnboarding.getState().reopen()
  },
  ...(__HOPLINE_DEV_LAB__ ? [{
    id: 'app.lab',
    title: 'Open the simulator lab',
    category: 'Sessions',
    icon: FlaskConical,
    keywords: 'demo simulator lab practice try sandbox',
    run: () => void openLab()
  } satisfies Action] : []),
  { id: 'app.designSystem', title: 'Open design system', category: 'App', icon: Settings2, keywords: 'style guide', run: () => void (location.hash = '#/design') }
]

let installed = false
/** Register the built-in actions once. */
export function installBuiltinActions(): void {
  if (installed) return
  installed = true
  registerActions(BUILTIN_ACTIONS)
}
