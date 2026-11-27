/**
 * Session shapes used by the importers.
 *
 * They mirror `apps/desktop/src/shared/types.ts` structurally (a type test in
 * `test/types.test.ts` keeps them in sync) so this package stays free of any
 * dependency on the desktop app. `Platform` comes from the guard, which owns it.
 */
import type { Platform, SessionPlatform } from '@hopline/guard'

export type { Platform, SessionPlatform }
export type Protocol = 'ssh' | 'telnet' | 'raw' | 'serial'

export interface SerialSettings {
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits: 1 | 1.5 | 2
  flow: 'none' | 'rtscts' | 'xonxoff'
  breakMs: number
}

export interface SessionOptions {
  serial?: SerialSettings
  ssh?: {
    /** Jump hosts, first hop first: ids of other SSH sessions. */
    jump?: string[]
    useAgent?: boolean
    agentForward?: boolean
    legacyAlgorithms?: boolean
  }
}

/** Same values as the desktop app's SERIAL_DEFAULTS. */
export const SERIAL_DEFAULTS: SerialSettings = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', breakMs: 300 }

export const DEFAULT_PORTS: Record<Protocol, number> = { ssh: 22, telnet: 23, raw: 23, serial: 0 }

export interface Folder {
  id: string
  name: string
  parentId: string | null
  sort: number
}

export interface Session {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  protocol: Protocol
  platform: SessionPlatform
  username: string
  credentialId: string | null
  logToFile: boolean
  notes: string
  options: SessionOptions
}

export type SessionInput = Omit<Session, 'id'> & { id?: string }

export type ImportFormat = 'securecrt' | 'securecrt-xml' | 'mobaxterm' | 'putty' | 'ssh-config' | 'csv' | 'netbox' | 'synthesized'

export interface ImportSource {
  format: ImportFormat
  /** Where the record came from: file path, registry key, ini section, CSV row or API URL. */
  ref: string
  /** Stable id in the source system (NetBox device id), used by re-sync. */
  id?: string
}

/**
 * A session as an importer produced it. Like `SessionInput` but with a folder
 * path instead of a folder id, tags, and jump references by session path.
 *
 * - `platform` is absent when the importer could not tell. There is no
 *   "unknown" Platform, and guessing wrong would make the guard classify
 *   commands with the wrong vocabulary, so the UI must ask.
 * - `host` is the device path (COM3, /dev/ttyUSB0) for serial sessions, port 0.
 * - Never carries a password.
 */
export interface ImportedSession {
  name: string
  folderPath: string[]
  host: string
  port: number
  protocol: Protocol
  platform?: Platform
  /** `platform` was guessed from the session name, not stated by the source: confirm it in the preview. */
  platformGuessed?: boolean
  username: string
  notes: string
  options: SessionOptions
  logToFile?: boolean
  tags: string[]
  /**
   * The jump host: the `sessionRef()` of another session in the same result
   * ("/"-joined folder path and name, which is just the name at the root).
   * For a multi-hop chain this is the first hop and `jumpChain` has them all.
   */
  jumpRef?: string
  jumpChain?: string[]
  source: ImportSource
}

export interface ImportWarning {
  /** The record the warning is about: a session name, file, row or device. */
  item: string
  message: string
}

export interface ImportResult {
  folders: { path: string[] }[]
  sessions: ImportedSession[]
  warnings: ImportWarning[]
}
