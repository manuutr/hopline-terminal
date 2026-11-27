import { useUi } from '../../store'
import { backupNow, openBackups } from './store'

/** The session of the active tab, if any. */
const activeSession = (): { sessionId: string; connected: boolean } | null => {
  const s = useUi.getState()
  const tab = s.tabs.find((t) => t.tabId === s.activeTabId)
  return tab ? { sessionId: tab.sessionId, connected: tab.state === 'connected' } : null
}

/**
 * Config-backup actions for the palette. Self-contained (id, title, keywords, when, run) so they
 * move into the action registry as they are.
 */
export const BACKUP_ACTIONS: { id: string; title: string; keywords: string; when: () => boolean; run: () => void }[] = [
  {
    id: 'backups.takeActive',
    title: 'Back up this session’s running config',
    keywords: 'backup config running-config save snapshot',
    when: () => !!activeSession()?.connected,
    run: () => void backupNow([activeSession()!.sessionId])
  },
  {
    id: 'backups.open',
    title: 'Config backups and diff…',
    keywords: 'backup config history diff compare versions',
    when: () => true,
    run: () => openBackups(activeSession()?.sessionId ?? undefined)
  },
  {
    id: 'backups.schedules',
    title: 'Backup schedules and retention…',
    keywords: 'backup schedule daily weekly retention',
    when: () => true,
    run: () => openBackups(undefined, 'schedules')
  }
]
