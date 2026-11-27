/**
 * Commands the menu bar needs that had no action yet (Edit, window, zoom, help, recent sessions,
 * tabs), and the menu labels of every command in the tree (shared/menu.ts). They are ordinary
 * registry actions: the palette lists the useful ones, Settings › Keyboard rebinds them, and a
 * menu runs them through `runAction`, the same gate as a key press.
 */
import { startTour } from '../onboarding/tour'
import type { MainCommand } from '@shared/menu'
import { isMac, inTerminal } from '../../lib/keys'
import { registerActions, setMenuMeta, type Action, type MenuMeta } from '../../lib/actions'
import { readClipboard, writeClipboard } from '../../lib/clipboard'
import { requestCloseWorkspace } from '../../lib/confirm'
import { openSession } from '../../lib/connect'
import { panes } from '../../lib/layout'
import { askText } from '../../lib/prompt'
import { openSettings } from '../../lib/settings-nav'
import { showPackets } from '../packets/store'
import { showOverview, showScratchpad, appendTerminalSelection } from '../workspace/store'
import { bufferText } from '../../lib/buffer-text'
import { scrubTerminalText } from '../../lib/command-evidence'
import { terminals } from '../../lib/terminals'
import { toast } from '../../lib/notify'
import { selectionWholeLines } from '../../lib/selection-lines'
import { applyTheme, getThemePref, type ThemePref } from '../../design/theme'
import { activeTab, activeWorkspace, useUi } from '../../store'
import { openImport } from '../import/store'
import { explainSelection } from '../terminal/TerminalView'
import { useFiles } from '../files/store'
import { useSnippets } from '../snippets/store'
import { useTrust } from '../trust/store'
import { usePrivacy } from '../privacy/store'
import { useAbout } from './AboutDialog'
import { clearRecent } from './recent'
import type { SessionImportSource } from '@shared/types'

const ui = () => useUi.getState()

/** Full screen: F11 on Windows and Linux, ⌃⌘F on macOS. */
export const fullScreenKeys = (mac = isMac): string[] => [mac ? 'Ctrl+Meta+F' : 'F11']
/** Mod+- would be Ctrl+Shift+- (Ctrl+_, the device's undo) off macOS, so zoom out adds Alt there. */
export const zoomOutKeys = (mac = isMac): string[] => [mac ? 'Mod+-' : 'Mod+Alt+-']
/** ⌘G / ⇧⌘G on macOS. Elsewhere Enter and Shift+Enter in the find bar (F3 stays the device's). */
export const findNextKeys = (mac = isMac): string[] => (mac ? ['Mod+G'] : [])
export const findPrevKeys = (mac = isMac): string[] => (mac ? ['Mod+Shift+G'] : [])
const main = (id: MainCommand) => () => void window.hopline.app.command(id)
const activeHandle = () => {
  const id = ui().activeTabId
  return id ? terminals.get(id) : undefined
}

/**
 * The element an Edit command acts on. A menu has taken focus by the time an item is chosen, so the
 * menu bar puts focus back first (MenuBar › restore); this reads where it landed.
 */
let heldTarget: Element | null = null
/** While a menu is open, the element that had the keyboard before it (MenuBar, context menus). */
export function holdEditTarget(el: Element | null): void {
  heldTarget = el
}

const editTarget = (): { kind: 'terminal' } | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement } | null => {
  const el = heldTarget?.isConnected ? heldTarget : document.activeElement
  if (el && inTerminal({ target: el } as unknown as Event)) return { kind: 'terminal' }
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|password|number|)$/.test(el.type))) return { kind: 'field', el }
  return activeHandle() ? { kind: 'terminal' } : null
}

const selectedText = (el: HTMLInputElement | HTMLTextAreaElement) => (el.type === 'password' ? '' : el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0))

async function editCopy(cut: boolean): Promise<void> {
  const t = editTarget()
  if (t?.kind === 'terminal') {
    const sel = activeHandle()?.term.getSelection()
    if (sel) await writeClipboard(sel)
    return
  }
  if (t?.kind === 'field') {
    const text = selectedText(t.el)
    if (!text) return
    // Through lib/clipboard (e2e keeps it in memory), never document.execCommand('copy').
    await writeClipboard(text)
    if (cut && !t.el.readOnly) document.execCommand('insertText', false, '')
  }
}

async function editPaste(confirm: boolean): Promise<void> {
  const t = editTarget()
  const text = await readClipboard()
  if (!text) return
  if (t?.kind === 'field' && !confirm) {
    if (!t.el.readOnly) document.execCommand('insertText', false, text)
    return
  }
  // The terminal's own paste path: several lines ask first, and Paste to device… always does.
  activeHandle()?.paste?.(text, { confirm })
}

const hasTerm = () => !!activeHandle()

function cyclePane(dir: 1 | -1): void {
  const ws = activeWorkspace(ui())
  if (!ws) return
  const list = panes(ws.root)
  const i = list.findIndex((p) => p.id === ws.focusedPaneId)
  const next = list[(i + dir + list.length) % list.length]
  if (next && next.id !== ws.focusedPaneId) ui().focusPane(next.id)
}

const setTheme = (pref: ThemePref) => async () => {
  applyTheme(pref)
  ui().setSettings(await window.hopline.settings.update({ theme: pref }))
}

const importFrom = (source: SessionImportSource, id: string, title: string): Action => ({
  id,
  title,
  category: 'Sessions',
  palette: false,
  run: () => openImport({ source })
})

/** Edit-menu items that only show a hint: the key itself is the text field's own (Ctrl+Z, Ctrl+X). */
const fieldOnly = () => {
  const t = editTarget()
  return t?.kind === 'field'
}

export const MENU_ACTIONS: Action[] = [
  // ------------------------------------------------------------ app and window (main does these)
  { id: 'app.about', title: 'About Hopline', category: 'App', keywords: 'version license electron', run: () => useAbout.setState({ open: true }) },
  {
    id: 'app.checkUpdates',
    title: 'Check for updates…',
    category: 'App',
    keywords: 'update upgrade version',
    run: () => {
      openSettings('updates')
      void window.hopline.updates.check().then((update) => usePrivacy.setState({ update }))
    }
  },
  { id: 'app.quit', title: 'Quit Hopline', category: 'App', keywords: 'quit exit close', run: main('app.quit') },
  { id: 'window.minimize', title: 'Minimize window', category: 'View', palette: false, run: main('window.minimize') },
  { id: 'window.zoom', title: 'Maximize or restore the window', category: 'View', keywords: 'maximize restore', run: main('window.zoom') },
  { id: 'window.close', title: 'Close window', category: 'App', palette: false, run: main('window.close') },
  { id: 'view.fullScreen', title: 'Toggle full screen', category: 'View', keywords: 'fullscreen', keys: fullScreenKeys(), run: main('view.fullScreen') },
  { id: 'view.zoomIn', title: 'Zoom in', category: 'View', keywords: 'bigger larger font ui scale', keys: ['Mod+='], run: main('view.zoomIn') },
  { id: 'view.zoomOut', title: 'Zoom out', category: 'View', keywords: 'smaller font ui scale', keys: zoomOutKeys(), run: main('view.zoomOut') },
  { id: 'view.zoomReset', title: 'Reset zoom', category: 'View', keywords: 'actual size 100%', keys: ['Mod+0'], run: main('view.zoomReset') },
  { id: 'help.tour', title: 'Take a workspace tour', category: 'App', keywords: 'onboarding help walkthrough learn', run: startTour },
  { id: 'help.guide', title: 'User guide', category: 'App', keywords: 'help docs documentation manual', run: main('help.guide') },
  { id: 'help.releaseNotes', title: 'Release notes', category: 'App', keywords: 'changelog what is new', run: main('help.releaseNotes') },
  { id: 'help.reportIssue', title: 'Report an issue…', category: 'App', keywords: 'bug github feedback', run: main('help.reportIssue') },
  { id: 'help.logsFolder', title: 'Open logs folder', category: 'App', keywords: 'session logs files', run: main('help.logsFolder') },
  { id: 'help.devTools', title: 'Toggle developer tools', category: 'App', palette: false, when: () => !!window.hopline.testMode || import.meta.env.DEV, run: main('help.devTools') },
  // ------------------------------------------------------------ file
  {
    id: 'session.newFolder',
    title: 'New folder…',
    category: 'Sessions',
    keywords: 'folder group',
    run: async () => {
      const name = await askText('New folder')
      if (!name?.trim()) return
      await window.hopline.sessions.saveFolder({ name: name.trim(), parentId: null })
      await ui().load()
    }
  },
  {
    id: 'session.openRecent',
    title: 'Open a recent session',
    category: 'Sessions',
    palette: false,
    run: (_e, arg) => {
      const s = ui().sessions.find((x) => x.id === arg)
      if (s) openSession(s)
    }
  },
  { id: 'session.clearRecent', title: 'Clear recent sessions', category: 'Sessions', palette: false, run: () => clearRecent() },
  importFrom('securecrt', 'import.securecrt', 'Import from SecureCRT…'),
  importFrom('mobaxterm', 'import.mobaxterm', 'Import from MobaXterm…'),
  importFrom('putty', 'import.putty', 'Import from PuTTY…'),
  importFrom('ssh-config', 'import.sshConfig', 'Import from ssh_config…'),
  importFrom('csv', 'import.csv', 'Import from CSV…'),
  importFrom('netbox', 'import.netbox', 'Import from NetBox or Nautobot…'),
  { id: 'session.export', title: 'Export sessions…', category: 'Sessions', keywords: 'export backup encrypted file', run: () => openSettings('data') },
  {
    id: 'terminal.saveOutput',
    title: 'Save output as…',
    category: 'Terminal',
    keywords: 'export scrollback text file log',
    when: hasTerm,
    run: async () => {
      const h = activeHandle()
      const t = activeTab(ui())
      if (!h || !t) return
      const text = bufferText(h.term.buffer.active).text
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      const name = `${t.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'session'}-${stamp}.txt`
      const path = await window.hopline.app.saveOutput(name, text.trimEnd() + '\n')
      if (path) toast.success('Output saved', { description: path })
    }
  },
  {
    id: 'tab.close',
    title: 'Close tab',
    category: 'Tabs and panes',
    when: () => !!activeWorkspace(ui()),
    run: () => {
      const ws = activeWorkspace(ui())
      if (ws) void requestCloseWorkspace(ws.id)
    }
  },
  {
    id: 'tab.activate',
    title: 'Go to tab',
    category: 'Tabs and panes',
    palette: false,
    run: (_e, arg) => {
      if (arg && ui().workspaces.some((w) => w.id === arg)) ui().activateWs(arg)
    }
  },
  // ------------------------------------------------------------ edit
  { id: 'edit.undo', title: 'Undo', category: 'Terminal', palette: false, when: fieldOnly, run: () => void document.execCommand('undo') },
  { id: 'edit.redo', title: 'Redo', category: 'Terminal', palette: false, when: fieldOnly, run: () => void document.execCommand('redo') },
  { id: 'edit.cut', title: 'Cut', category: 'Terminal', palette: false, when: fieldOnly, run: () => void editCopy(true) },
  { id: 'edit.copy', title: 'Copy', category: 'Terminal', palette: false, run: () => void editCopy(false) },
  { id: 'edit.paste', title: 'Paste', category: 'Terminal', palette: false, run: () => void editPaste(false) },
  { id: 'edit.pasteToDevice', title: 'Paste to device…', category: 'Terminal', keywords: 'paste preview confirm lines', when: hasTerm, run: () => void editPaste(true) },
  {
    id: 'edit.selectAll',
    title: 'Select all',
    category: 'Terminal',
    palette: false,
    run: () => {
      const t = editTarget()
      if (t?.kind === 'field') t.el.select()
      else activeHandle()?.term.selectAll()
    }
  },
  { id: 'edit.findNext', title: 'Find next', category: 'Terminal', palette: false, keys: findNextKeys(), when: hasTerm, run: () => activeHandle()?.findStep?.('next') },
  { id: 'edit.findPrev', title: 'Find previous', category: 'Terminal', palette: false, keys: findPrevKeys(), when: hasTerm, run: () => activeHandle()?.findStep?.('prev') },
  { id: 'packets.open', title: 'Packet capture…', category: 'Sessions', keywords: 'wireshark tshark pcap traffic troubleshoot transfer analyze', run: showPackets },
  { id: 'workspace.overview', title: 'Session overview…', category: 'Sessions', keywords: 'dashboard open closed status connections activity', run: showOverview },
  { id: 'workspace.scratchpad', title: 'Open scratchpad…', category: 'Terminal', keywords: 'notes local text notebook', run: showScratchpad },
  { id: 'workspace.noteSelection', title: 'Add selection to scratchpad', category: 'Terminal', keywords: 'notes selected lines', when: () => !!activeHandle()?.term.hasSelection(), run: () => appendTerminalSelection() },
  { id: 'terminal.copyAll', title: 'Copy all terminal output', category: 'Terminal', keywords: 'screen buffer scrollback clipboard redacted', when: hasTerm, run: async () => {
    const handle = activeHandle()
    if (!handle) return
    await writeClipboard(scrubTerminalText(bufferText(handle.term.buffer.active).text))
    toast.success('Terminal output copied')
  } },
  { id: 'terminal.clear', title: 'Clear scrollback', category: 'Terminal', keywords: 'clear reset buffer history', when: hasTerm, run: () => activeHandle()?.clear?.() },
  // ------------------------------------------------------------ view
  { id: 'pane.focusNext', title: 'Focus next pane', category: 'Tabs and panes', keywords: 'pane split cycle', when: () => (activeWorkspace(ui()) ? panes(activeWorkspace(ui())!.root).length > 1 : false), run: () => cyclePane(1) },
  { id: 'pane.focusPrev', title: 'Focus previous pane', category: 'Tabs and panes', keywords: 'pane split cycle', when: () => (activeWorkspace(ui()) ? panes(activeWorkspace(ui())!.root).length > 1 : false), run: () => cyclePane(-1) },
  { id: 'view.theme.dark', title: 'Theme: dark', category: 'View', palette: false, run: setTheme('dark') },
  { id: 'view.theme.light', title: 'Theme: light', category: 'View', palette: false, run: setTheme('light') },
  { id: 'view.theme.contrast', title: 'Theme: high contrast', category: 'View', keywords: 'accessibility contrast', run: setTheme('contrast') },
  { id: 'view.theme.system', title: 'Theme: follow the system', category: 'View', keywords: 'os auto dark light', run: setTheme('system') },
  // ------------------------------------------------------------ session
  {
    id: 'session.reconnect',
    title: 'Reconnect',
    category: 'Sessions',
    keywords: 'reconnect retry login',
    when: () => {
      const t = activeTab(ui())
      return !!t && t.state !== 'connecting' && t.state !== 'reconnecting'
    },
    run: () => {
      const id = ui().activeTabId
      if (id) void window.hopline.term.reconnect(id).catch((e: unknown) => toast.error('Could not reconnect', { description: String((e as Error)?.message ?? e) }))
    }
  },
  {
    id: 'session.duplicate',
    title: 'Duplicate tab',
    category: 'Tabs and panes',
    keywords: 'clone same session again new tab',
    when: () => {
      const t = activeTab(ui())
      return !!t && ui().sessions.some((s) => s.id === t.sessionId)
    },
    run: () => {
      const t = activeTab(ui())
      const s = t && ui().sessions.find((x) => x.id === t.sessionId)
      if (s) openSession(s)
    }
  },
  // ------------------------------------------------------------ assistant
  {
    id: 'ai.focus',
    title: 'Ask the assistant',
    category: 'Assistant',
    keywords: 'ai question chat composer',
    run: () => {
      ui().set({ aiOpen: true })
      // The panel expands on the next frame; then its composer takes the keyboard.
      requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('aside[aria-label=Assistant] textarea')?.focus()))
    }
  },
  {
    id: 'ai.explainSelection',
    title: 'Explain selection',
    category: 'Assistant',
    keywords: 'ai explain output selected',
    when: () => !!activeHandle()?.term.hasSelection(),
    run: () => {
      const h = activeHandle()
      const id = ui().activeTabId
      if (h && id) explainSelection(id, selectionWholeLines(h.term))
    }
  },
  { id: 'ai.settings', title: 'AI settings…', category: 'Assistant', keywords: 'provider model api key ollama anthropic openai gemini', run: () => openSettings('assistant') }
]

const t = (label: string, extra: Omit<MenuMeta, 'label'> = {}): MenuMeta => ({ label, ...extra })
const settingOn = (k: 'aiReadOnly' | 'termScreenReader' | 'termHighlight') => () => !!ui().settings?.[k]

/** Menu labels (`&` before the mnemonic) and checkbox state of every command in the tree. */
export const MENU_META: Record<string, MenuMeta> = {
  'app.about': t(isMac ? 'About Hopline' : '&About Hopline'),
  'app.settings': t(isMac ? 'Settings…' : 'Se&ttings…'),
  'app.checkUpdates': t('Check for updates…'),
  'app.quit': t('E&xit'),
  'session.quickConnect': t('&Quick connect…'),
  'session.switcher': t('&Go to session…'),
  'session.new': t('New &session…'),
  'session.newFolder': t('New &folder…'),
  'session.clearRecent': t('&Clear recent'),
  'import.securecrt': t('&SecureCRT…'),
  'import.mobaxterm': t('&MobaXterm…'),
  'import.putty': t('&PuTTY…'),
  'import.sshConfig': t('ss&h_config…'),
  'import.csv': t('&CSV…'),
  'import.netbox': t('&NetBox or Nautobot…'),
  'session.export': t('&Export sessions…'),
  'terminal.saveOutput': t('Save output &as…'),
  'pane.close': t('Close &pane'),
  'tab.close': t('&Close tab'),
  'tab.reopen': t('Re&open closed tab'),
  'window.close': t('Close &window'),
  'edit.undo': t('&Undo', { hint: 'Ctrl+Z' }),
  'edit.redo': t('&Redo', { hint: 'Ctrl+Y' }),
  'edit.cut': t('Cu&t', { hint: 'Ctrl+X' }),
  'edit.copy': t('&Copy', { hint: 'Mod+C' }),
  'edit.paste': t('&Paste', { hint: 'Mod+V' }),
  'edit.pasteToDevice': t('Paste to &device…'),
  'edit.selectAll': t('Select &all'),
  'terminal.find': t('&Find…'),
  'edit.findNext': t('Find &next', { hint: isMac ? undefined : 'Enter' }),
  'edit.findPrev': t('Find pre&vious', { hint: isMac ? undefined : 'Shift+Enter' }),
  'terminal.findAll': t('Find in all ta&bs…'),
  'workspace.overview': t('Session &overview…'),
  'workspace.scratchpad': t('Open &scratchpad…'),
  'workspace.noteSelection': t('Add selection to scratchpad'),
  'terminal.copyAll': t('Copy all terminal output'),
  'terminal.clear': t('C&lear scrollback'),
  'palette.open': t('&Command palette…'),
  'view.sidebar': t('&Sidebar', { kind: 'checkbox', checked: () => ui().sidebarOpen }),
  'ai.toggle': t('&Assistant', { kind: 'checkbox', checked: () => ui().aiOpen }),
  'view.buttonBar': t('&Button bar', {
    kind: 'checkbox',
    checked: () => {
      const s = useSnippets.getState()
      return s.barVisible ?? s.list.some((x) => x.onBar)
    }
  }),
  'pane.splitRight': t('Split &right'),
  'pane.splitDown': t('Split &down'),
  'pane.zoom': t('&Zoom pane', { kind: 'checkbox', checked: () => !!activeWorkspace(ui())?.zoomedPaneId }),
  'pane.focusNext': t('Focus &next pane'),
  'pane.focusPrev': t('Focus pre&vious pane'),
  'view.zoomIn': t('Zoom &in'),
  'view.zoomOut': t('Zoom &out'),
  'view.zoomReset': t('Reset zoo&m'),
  'view.fullScreen': t('&Full screen'),
  'view.theme.dark': t('&Dark', { kind: 'radio', checked: () => getThemePref() === 'dark' }),
  'view.theme.light': t('&Light', { kind: 'radio', checked: () => getThemePref() === 'light' }),
  'view.theme.contrast': t('&High contrast', { kind: 'radio', checked: () => getThemePref() === 'contrast' }),
  'view.theme.system': t('&System', { kind: 'radio', checked: () => getThemePref() === 'system' }),
  'terminal.highlight': t('Output &highlighting', { kind: 'checkbox', checked: settingOn('termHighlight') }),
  'a11y.screenReader': t('Screen r&eader mode', { kind: 'checkbox', checked: settingOn('termScreenReader') }),
  'a11y.bufferView': t('Accessible b&uffer view'),
  'session.reconnect': t('&Reconnect'),
  'session.duplicate': t('&Duplicate tab'),
  'session.overrides': t('&Overrides…'),
  'terminal.sendBreak': t('Send &break'),
  'packets.open': t('Packet &capture…'),
  'files.toggle': t('&SFTP browser', { kind: 'checkbox', checked: () => useFiles.getState().open }),
  'forwards.open': t('&Port forwards…'),
  'multi.send': t('Send to &many…'),
  'multi.run': t('Run on many de&vices…'),
  'snippets.run': t('Run a s&nippet…'),
  'backups.takeActive': t('Back up &config now'),
  'backups.open': t('Compare bac&kups…'),
  'ai.readOnly': t('Read-on&ly mode', { kind: 'checkbox', checked: () => useTrust.getState().policy.locks.readOnly || settingOn('aiReadOnly')() }),
  'ai.focus': t('&Ask the assistant'),
  'ai.explainSelection': t('&Explain selection'),
  'fleet.investigate': t('&Investigate across devices…'),
  'egress.open': t('&What left this machine'),
  'ai.settings': t('AI &settings…'),
  'window.minimize': t('Mi&nimize'),
  'window.zoom': t('&Maximize'),
  'tab.next': t('&Next tab'),
  'tab.prev': t('&Previous tab'),
  'help.tour': t('Workspace &tour'),
  'help.guide': t('&User guide'),
  'app.shortcuts': t('&Keyboard shortcuts'),
  'help.releaseNotes': t('&Release notes'),
  'help.reportIssue': t('Report an &issue…'),
  'audit.open': t('View &audit log'),
  'help.logsFolder': t('Open &logs folder'),
  'help.devTools': t('Toggle &developer tools')
}

let installed = false
export function installMenuActions(): void {
  if (installed) return
  installed = true
  registerActions(MENU_ACTIONS)
  setMenuMeta(MENU_META)
}
