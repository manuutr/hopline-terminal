/** Config backups: shapes shared by main, preload and the renderer. Config text here is always redacted. */

export type BackupTrigger = 'manual' | 'scheduled'

/** One stored version (metadata only). */
export interface BackupVersion {
  id: string
  sessionId: string
  sessionName: string
  ts: number
  /** Bytes of the stored (unredacted) text. */
  size: number
  lines: number
  trigger: BackupTrigger
  command: string
  platform: string
}

/** A version's text as the renderer sees it: secrets replaced with <redacted>. */
export interface BackupText {
  id: string | null
  ts: number
  sessionName: string
  platform: string
  text: string
  /** How many secrets were replaced. */
  redactions: number
}

export type BackupOutcome = 'saved' | 'unchanged' | 'failed' | 'skipped'

export interface BackupResult {
  sessionId: string
  sessionName: string
  outcome: BackupOutcome
  versionId?: string
  /** Failed or skipped: why, in words for the user. */
  reason?: string
  /**
   * Skipped because the device shows another name than earlier versions: the old and the new name.
   * The user may accept the new one (`backups:acceptRename`) if the device was renamed.
   */
  renamed?: { from: string; to: string }
}

export interface BackupSchedule {
  id: string
  kind: 'folder' | 'tag'
  /** Folder id or tag name. */
  target: string
  cadence: 'daily' | 'weekly'
  /** 0 = Sunday … 6 = Saturday (weekly only). */
  weekday: number
  /** Local time, `HH:MM`. */
  time: string
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  /** "3 saved, 1 unchanged, 2 failed" after the last run. */
  lastSummary: string | null
}

export type BackupScheduleInput = Omit<BackupSchedule, 'id' | 'createdAt' | 'lastRunAt' | 'lastSummary'> & { id?: string }

export interface BackupRetention {
  /** Versions kept per session (the newest is always kept). */
  keepLast: number
  /** Versions older than this are pruned; 0 keeps them forever. */
  maxAgeDays: number
}

export const DEFAULT_RETENTION: BackupRetention = { keepLast: 50, maxAgeDays: 365 }
