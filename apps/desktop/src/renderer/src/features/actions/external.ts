import { ArrowLeftRight, FileClock, FolderOpen, SquareTerminal } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { BACKUP_ACTIONS } from '../backups/actions'
import { activeBlocks, BLOCK_ACTIONS } from '../blocks/actions'
import { closeFiles, openFiles, useFiles } from '../files/store'
import { openForwards } from '../forwards/ForwardsDialog'
import { sessionById, useUi } from '../../store'

/** The active tab, when it is an SSH session (files and forwarding need SSH). */
const sshTab = (): string | null => {
  const ui = useUi.getState()
  const t = ui.tabs.find((x) => x.tabId === ui.activeTabId)
  const s = t && sessionById(ui, t.sessionId)
  return t && s?.protocol === 'ssh' ? t.tabId : null
}

/**
 * Actions other features declare in their own lists (config backups, command blocks, files and
 * port forwarding), moved into
 * the registry as they are: the palette lists them, the shortcut sheet and Settings → Keyboard show
 * them, and their keys (prompt navigation) are dispatched with every other shortcut, so they can
 * be rebound and never collide with device keys.
 */
let installed = false
export function installExternalActions(): void {
  if (installed) return
  installed = true
  registerActions([
    {
      id: 'files.toggle',
      title: () => (useFiles.getState().open ? 'Hide the files panel' : 'Files (SFTP/SCP)…'),
      category: 'Sessions',
      icon: FolderOpen,
      keywords: 'sftp scp files upload download transfer browse',
      // Mod+J: the bottom panel, as in VS Code and Zed (Ctrl+Shift+J / ⌘J); free of device keys.
      keys: ['Mod+J'],
      when: () => useFiles.getState().open || !!sshTab(),
      run: () => (useFiles.getState().open ? closeFiles() : openFiles(sshTab() ?? undefined))
    },
    {
      id: 'forwards.open',
      title: 'Port forwarding…',
      category: 'Sessions',
      icon: ArrowLeftRight,
      keywords: 'port forward tunnel local remote dynamic socks',
      when: () => !!sshTab(),
      run: () => {
        const t = sshTab()
        if (t) openForwards(t)
      }
    },
    ...BACKUP_ACTIONS.map((a) => ({ id: a.id, title: a.title, category: 'Automation' as const, icon: FileClock, keywords: a.keywords, when: a.when, run: a.run })),
    ...BLOCK_ACTIONS.map((a) => ({
      id: a.id,
      title: a.title,
      category: 'Terminal' as const,
      icon: SquareTerminal,
      keywords: a.keywords,
      ...(a.keys ? { keys: [a.keys] } : {}),
      when: () => {
        const c = activeBlocks()
        return !!c && (!a.needsBlock || !!c.current())
      },
      run: () => {
        const c = activeBlocks()
        if (c) a.run(c)
      }
    }))
  ])
}
